/**
 * Namespace-container calls must never reach the client under their own name.
 *
 * A routed model that calls a tool NAMESPACE (`tools`, `collaboration`) instead of a tool inside
 * it emits a name the client cannot dispatch: codex_core::tools::router reports
 * `unsupported call: <ns>` through dispatch_tool_call_with_terminal_outcome, which ENDS the turn.
 * That is the "session silently stops mid-task" failure these tests pin.
 *
 * Three layers have to agree for a container to disappear, and each has its own escape hatch, so
 * each is pinned separately:
 *   - the verdict layer (resolveEmittedCall) may answer with directive exec feedback, with a drop,
 *     or - when it has no catalog at all - with a plain allow, which used to relay the container;
 *   - the shadow phantom allowlist decides drop-vs-fail-closed and is empty for direct routes;
 *   - the bridge #4735 deferred-enforcement opt-out (chat / anthropic inbound wire) skips the 502
 *     and previously fell through to a relay.
 */
import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import {
  isDroppedNamespaceContainer,
  resolveEmittedCall,
} from "../../src/responses/emitted-call-guard";
import type { AdapterEvent } from "../../src/types";

/** A call item reached the client only when its wire payload carries this name. */
const QUOTE = String.fromCharCode(34);
const clientSeesCallNamed = (wire: string, name: string) =>
  wire.includes(QUOTE + "name" + QUOTE + ":" + QUOTE + name + QUOTE);

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** One real call, then the container call, then an ordinary completion. */
async function* containerTurn(container: string): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call-real", name: "exec" } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-real", arguments: "{}" } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-real" } as AdapterEvent;
  yield { type: "tool_call_start", id: "call-bad", name: container } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-bad", arguments: "{}" } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-bad" } as AdapterEvent;
  yield { type: "text_delta", text: "finished the task" } as AdapterEvent;
  yield { type: "done" } as AdapterEvent;
}

const DECLARED = new Set(["exec", "collaboration__spawn_agent", "collaboration__update_plan"]);
const FREEFORM = new Set(["exec"]);
const PHANTOM = new Set(["tools", "update_plan"]);

/** The container call is the ONLY output: no real call before it, no text after it. */
async function* containerOnlyTurn(container: string): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call-bad", name: container } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-bad", arguments: "{}" } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-bad" } as AdapterEvent;
  yield { type: "done" } as AdapterEvent;
}

/** The container call, then one line of narration, then the turn stops. */
async function* containerCommentaryTurn(container: string): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call-bad", name: container } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-bad", arguments: "{}" } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-bad" } as AdapterEvent;
  yield { type: "text_delta", text: "fill in the password, then check the login screenshot" } as AdapterEvent;
  yield { type: "done" } as AdapterEvent;
}

interface Cfg {
  phantom?: ReadonlySet<string>;
  freeform?: Set<string>;
  declared?: ReadonlySet<string>;
  feedback?: { remaining: number };
  enforce?: boolean;
  /** 发射名改写门控：本文件默认 true（三方语义）；官方端点缺省语义显式传 false。 */
  gate?: boolean;
}

function bridgeOptions(cfg: Cfg) {
  return {
    ...(cfg.declared === undefined ? { declaredToolNames: DECLARED } : { declaredToolNames: cfg.declared }),
    ...(cfg.phantom === undefined ? {} : { undeclaredToolPhantomNames: cfg.phantom }),
    ...(cfg.feedback === undefined ? {} : { undeclaredToolFeedback: cfg.feedback }),
    ...(cfg.enforce === undefined ? {} : { enforceDeclaredToolNames: cfg.enforce }),
    freeformToolNames: cfg.freeform ?? FREEFORM,
    // 发射名改写门控：本文件锁的是三方/shadow 流量的救回语义（容器丢弃并继续、前缀名 fail closed
    // 都是 phase-1 干预），显式开启；官方端点缺省语义由 tool-name-repair-official-gate.test.ts 锁。
    servingRouteIsThirdParty: cfg.gate ?? true,
  };
}

const streamWith = (container: string, cfg: Cfg) => drain(bridgeToResponsesSSE(
  containerTurn(container), "llm-248/x", undefined, cfg.freeform ?? FREEFORM, undefined,
  undefined, 50_000, bridgeOptions(cfg),
));

async function jsonWith(container: string, cfg: Cfg): Promise<string> {
  const events: AdapterEvent[] = [];
  for await (const e of containerTurn(container)) events.push(e);
  return JSON.stringify(buildResponseJSON(events, "llm-248/x", bridgeOptions(cfg) as never));
}

describe("namespace container never reaches the client", () => {
  test("shadow request with an exec channel gets directive feedback, not a tools call", async () => {
    const sse = await streamWith("tools", { phantom: PHANTOM, feedback: { remaining: 2 } });
    expect(sse).toContain("namespace-leak repair");
    expect(clientSeesCallNamed(sse, "tools")).toBe(false);
    expect(sse).toContain("finished the task");
    expect(sse).toContain("response.completed");
    expect(sse).not.toContain("response.failed");
  });

  test("shadow request without an exec channel drops the call and fails the terminal", async () => {
    // No exec channel = no directive to convert the leak into, so the call is dropped. It must
    // not reach the client (the assertions below), the stream delivers the rest of the turn,
    // and the TERMINAL states the loss: a dropped-and-not-converted container call is not
    // rescued by the surviving exec call and text - the client recorded a done turn whose
    // action the proxy deleted was the premature-stop field shape (see the "filtered
    // container terminal" block below for the contract).
    const sse = await streamWith("tools", { phantom: PHANTOM, freeform: new Set<string>() });
    expect(clientSeesCallNamed(sse, "tools")).toBe(false);
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain("finished the task");
    expect(sse).toContain("filtered_container_no_valid_output");
    expect(sse).toContain("response.failed");
    expect(sse).not.toContain("response.completed");
  });

  test("direct route drops the container mid-stream and terminates failed", async () => {
    // 现场取证：241.t 的 429 条 undeclared 502 里 86 条（20%）的名字就是裸容器名 tools，全部
    // 走 responses 入站的强制模式。容器在任一条线上都不可调用，中继给客户端也只是变成
    // unsupported call 结束回合，所以发射层的中处置仍是「丢弃 + 记遥测」：不 502 打死当条
    // 发射、流照常交付其余内容。原本这段容器判定被放在 enforceDeclared 之后，只有 #4735
    // 延迟强制的入站线才走得到，等于现网主力路径完全拿不到这个豁免。
    //
    // 终态则不再冒充成功：这条路由上没有预算把容器转成 directive（phantom 名单为空、无
    // feedback 对象），被删掉的意图没有被恢复的证据，同轮的真调用与文本不能替它作证。客户端
    // 对「代理删掉了模型唯一意图」的回合记 failed + filtered_container_no_valid_output，
    // 这正是根除「completed 空回合 → 用户点继续 → 又空」链条的那块看板。
    //
    // 真正的幻觉名不受影响：见下面 "an undeclared name with a catalog and no budget still
    // fails closed"，那条继续锁 fail-closed。
    const sse = await streamWith("tools", { phantom: new Set<string>() });
    expect(clientSeesCallNamed(sse, "tools")).toBe(false);
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain("finished the task");
    expect(sse).toContain("filtered_container_no_valid_output");
    expect(sse).toContain("response.failed");
    expect(sse).not.toContain("response.completed");

    const built = JSON.parse(await jsonWith("tools", { phantom: new Set<string>() }));
    expect(built.status).toBe("failed");
    expect(built.error.code).toBe("filtered_container_no_valid_output");
    expect(clientSeesCallNamed(JSON.stringify(built), "tools")).toBe(false);
    // The failure is added, nothing withheld: the surviving call and text stay in the output.
    expect(JSON.stringify(built.output)).toContain("finished the task");
  });

  test("deferred enforcement (chat / anthropic wire) drops the container instead of relaying it", async () => {
    // The #4735 opt-out skips the 502 for provider echoes; before the fix it also handed the
    // container to the client, which is exactly what killed the turn.
    const sse = await streamWith("tools", { phantom: new Set<string>(), enforce: false });
    expect(clientSeesCallNamed(sse, "tools")).toBe(false);
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain("finished the task");

    const json = await jsonWith("tools", { phantom: new Set<string>(), enforce: false });
    expect(clientSeesCallNamed(json, "tools")).toBe(false);
    expect(json).toContain("finished the task");
  });

  test("batch path with no catalog at all still drops the container", async () => {
    const events: AdapterEvent[] = [];
    for await (const e of containerTurn("tools")) events.push(e);
    const json = JSON.stringify(buildResponseJSON(events, "m", { freeformToolNames: FREEFORM } as never));
    expect(clientSeesCallNamed(json, "tools")).toBe(false);
    expect(json).toContain("finished the task");
  });

  test("a declared namespace container such as collaboration is handled the same way", async () => {
    // Allowlisted: the namespace-leak branch answers with the flattened-form directive.
    const sse = await streamWith("collaboration", {
      phantom: new Set(["tools", "update_plan", "collaboration"]), feedback: { remaining: 2 },
    });
    expect(clientSeesCallNamed(sse, "collaboration")).toBe(false);
    expect(sse).toContain("namespace-leak repair");
    expect(sse).toContain("finished the task");

    // Outside the allowlist and without a correction budget it is simply dropped; a
    // deferred-enforcement (chat / anthropic) wire must not relay the container either.
    const direct = await streamWith("collaboration", { phantom: new Set<string>(), enforce: false });
    expect(clientSeesCallNamed(direct, "collaboration")).toBe(false);
    expect(direct).not.toContain("undeclared client tool");
    expect(direct).toContain("finished the task");

    // With a correction budget the same name is answered with the declared-catalog directive.
    const taught = await streamWith("collaboration", {
      phantom: new Set<string>(), enforce: false, feedback: { remaining: 2 },
    });
    expect(clientSeesCallNamed(taught, "collaboration")).toBe(false);
    expect(taught).toContain("undeclared-tool repair");
  });

  test("an ordinary undeclared name still relays on the deferred wire", async () => {
    // Guards against over-dropping: the opt-out must keep tolerating real provider echoes.
    const sse = await streamWith("provider_echo", {
      phantom: new Set<string>(), enforce: false, declared: new Set(["exec"]),
    });
    expect(clientSeesCallNamed(sse, "provider_echo")).toBe(true);
    expect(sse).toContain("response.completed");
  });
});

describe("isDroppedNamespaceContainer", () => {
  test("the exec sandbox namespace always counts", () => {
    expect(isDroppedNamespaceContainer("tools", new Set<string>(["exec"]))).toBe(true);
    expect(isDroppedNamespaceContainer("tools")).toBe(true);
  });

  test("any other name counts only when a declared tool lives under it", () => {
    expect(isDroppedNamespaceContainer("collaboration", DECLARED)).toBe(true);
    expect(isDroppedNamespaceContainer("web", DECLARED)).toBe(false);
    expect(isDroppedNamespaceContainer("exec", DECLARED)).toBe(false);
  });
});

describe("existing allowlist behaviour is unchanged", () => {
  test("listed phantoms still drop silently and the turn survives", async () => {
    const sse = await streamWith("update_plan", {
      phantom: new Set(["update_plan"]), feedback: { remaining: 2 },
    });
    expect(clientSeesCallNamed(sse, "update_plan")).toBe(false);
    expect(sse).toContain("finished the task");
    expect(sse).not.toContain("undeclared client tool");
  });

  test("the no-catalog verdict still allows an arbitrary name through", () => {
    expect(resolveEmittedCall("anything")).toEqual({ kind: "allow", name: "anything", repaired: false });
  });

  // The four leaked forms observed in production after the prefix repair shipped: each starts
  // with the exec sandbox namespace, so even with no catalog the form itself is unresolvable and
  // must fail closed instead of relaying into the client's `unsupported call` that ends the turn.
  test("no catalog still drops a sandbox-namespace-qualified name", () => {
    for (const name of ["tools.apply_patch", "tools__apply_patch", "tools/apply_patch", "tools=apply_patch", "tools__view_image", "tools.exec_command"]) {
      expect(resolveEmittedCall(name, { servingRouteIsThirdParty: true })).toEqual({ kind: "drop", name });
    }
    // The tolerance for provider echoes (#4735) is untouched: a bare or wire name still relays.
    expect(resolveEmittedCall("web_search")).toEqual({ kind: "allow", name: "web_search", repaired: false });
    expect(resolveEmittedCall("apply_patch")).toEqual({ kind: "allow", name: "apply_patch", repaired: false });
  });

  test("an undeclared name with a catalog and no budget still fails closed", () => {
    expect(resolveEmittedCall("totally_made_up", {
      declaredToolNames: DECLARED, enforceDeclaredToolNames: true,
    })).toEqual({ kind: "drop", name: "totally_made_up" });
  });
});

/**
 * The terminal for a filtered container call.
 *
 * The turn whose ONLY content is a container call used to terminate completed with output [].
 * The client recorded a done turn whose single action the proxy deleted, and the session stopped
 * mid-task with no stated reason (the field shape behind the "interrupted" badge). An unconverted,
 * unrecovered container drop on a third-party route is now a stated failure, on SSE and buffered
 * alike. Commentary after the drop is narration of the deleted action, not recovery of it, so it
 * does not rescue the terminal; a directive-feedback item IS a call the client runs, and a real
 * call is a real call, so both keep the turn completed. Official routes (gate absent) are
 * byte-identical — enforced routes 502 on the drop itself, and the deferred wire is not
 * third-party traffic — and an allowlisted-phantom drop keeps its silent-remove contract.
 */
async function streamOf(gen: AsyncGenerator<AdapterEvent>, cfg: Cfg): Promise<string> {
  return drain(bridgeToResponsesSSE(
    gen, "llm-248/x", undefined, cfg.freeform ?? FREEFORM, undefined,
    undefined, 50_000, bridgeOptions(cfg),
  ));
}

async function jsonOf(gen: AsyncGenerator<AdapterEvent>, cfg: Cfg): Promise<string> {
  const events: AdapterEvent[] = [];
  for await (const e of gen) events.push(e);
  return JSON.stringify(buildResponseJSON(events, "llm-248/x", bridgeOptions(cfg) as never));
}

describe("filtered container terminal", () => {
  test("a container as the only output fails the turn on both transports", async () => {
    const sse = await streamOf(containerOnlyTurn("tools"), { phantom: new Set<string>() });
    expect(clientSeesCallNamed(sse, "tools")).toBe(false);
    expect(sse).toContain("response.failed");
    expect(sse).not.toContain("response.completed");
    expect(sse).toContain("filtered_container_no_valid_output");

    const json = JSON.parse(await jsonOf(containerOnlyTurn("tools"), { phantom: new Set<string>() }));
    expect(json.status).toBe("failed");
    expect(json.output).toEqual([]);
    expect(json.error.code).toBe("filtered_container_no_valid_output");
  });

  test("commentary after the dropped container does not rescue the terminal", async () => {
    // The observed premature-stop shape: the model narrates the action the proxy just deleted
    // ("...check the login screenshot") and stops. The task was not done; the terminal says so.
    const sse = await streamOf(containerCommentaryTurn("tools"), { phantom: new Set<string>() });
    expect(sse).toContain("check the login screenshot");
    expect(sse).toContain("response.failed");
    expect(sse).not.toContain("response.completed");

    const json = JSON.parse(await jsonOf(containerCommentaryTurn("tools"), { phantom: new Set<string>() }));
    expect(json.status).toBe("failed");
    expect(json.error.code).toBe("filtered_container_no_valid_output");
    // The commentary is still delivered: the failure is added, nothing is withheld.
    expect(JSON.stringify(json.output)).toContain("check the login screenshot");
  });

  test("a container converted into directive feedback completes", async () => {
    // The exec channel turns the container into a synthetic exec call the client runs; that is a
    // valid emitted call, so the turn ends the way it did before this rule existed.
    const sse = await streamOf(containerOnlyTurn("tools"), {
      phantom: PHANTOM, feedback: { remaining: 2 },
    });
    expect(sse).toContain("namespace-leak repair");
    expect(sse).toContain("response.completed");
    expect(sse).not.toContain("response.failed");

    const json = JSON.parse(await jsonOf(containerOnlyTurn("tools"), {
      phantom: PHANTOM, feedback: { remaining: 2 },
    }));
    expect(json.status).toBe("completed");
    expect(json.output.length).toBe(1);
    expect(json.output[0].type).toBe("custom_tool_call");
  });

  test("a real exec call completes; the container rule only fires when no call survives", async () => {
    const sse = await streamOf(containerOnlyTurn("exec"), { phantom: new Set<string>() });
    expect(clientSeesCallNamed(sse, "exec")).toBe(true);
    expect(sse).toContain("response.completed");
    expect(sse).not.toContain("response.failed");
  });

  test("plain text completes with no drops at all", async () => {
    const sse = await streamOf((async function* () {
      yield { type: "text_delta", text: "the answer is 42" } as AdapterEvent;
      yield { type: "done" } as AdapterEvent;
    })(), { phantom: new Set<string>() });
    expect(sse).toContain("the answer is 42");
    expect(sse).toContain("response.completed");
    expect(sse).not.toContain("response.failed");
  });

  test("the official route is untouched at the terminal", async () => {
    // gate absent = official semantics: enforce mode 502s on the drop itself (the existing
    // fail-closed contract, not this code path), and the deferred wire keeps dropping-and-
    // continuing without the new terminal — it is not third-party traffic.
    const enforced = await streamOf(containerOnlyTurn("tools"), {
      phantom: new Set<string>(), enforce: true, gate: false,
    });
    expect(enforced).toContain("undeclared client tool");
    expect(enforced).not.toContain("filtered_container_no_valid_output");

    const deferred = await streamOf(containerOnlyTurn("tools"), {
      phantom: new Set<string>(), enforce: false, gate: false,
    });
    expect(deferred).toContain("response.completed");
    expect(deferred).not.toContain("response.failed");

    const deferredJson = JSON.parse(await jsonOf(containerOnlyTurn("tools"), {
      phantom: new Set<string>(), enforce: false, gate: false,
    }));
    expect(deferredJson.status).toBe("completed");
  });

  test("an allowlisted phantom drop keeps its silent-remove contract", async () => {
    // The phantom allowlist's whole deal is "remove it, the turn finishes normally" — the fixture
    // turn (a real call, a phantom, then text) completes exactly as it always did.
    const sse = await streamOf(containerTurn("update_plan"), {
      phantom: new Set(["update_plan"]),
    });
    expect(sse).toContain("finished the task");
    expect(sse).toContain("response.completed");
    expect(sse).not.toContain("response.failed");
    expect(sse).not.toContain("filtered_container_no_valid_output");
  });

  test("a container dropped through the allowlist branch counts too", async () => {
    // The shadow field shape: tools on the allowlist with the feedback budget spent (an earlier
    // directive in the same request consumed it) drops through the phantom branch, and the
    // durable row already reports namespace-container. The terminal has to agree with the row.
    const sse = await streamOf(containerOnlyTurn("tools"), {
      phantom: PHANTOM, feedback: { remaining: 0 },
    });
    expect(clientSeesCallNamed(sse, "tools")).toBe(false);
    expect(sse).toContain("response.failed");
    expect(sse).not.toContain("response.completed");
    expect(sse).toContain("filtered_container_no_valid_output");
  });
});
