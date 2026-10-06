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

interface Cfg {
  phantom?: ReadonlySet<string>;
  freeform?: Set<string>;
  declared?: ReadonlySet<string>;
  feedback?: { remaining: number };
  enforce?: boolean;
}

function bridgeOptions(cfg: Cfg) {
  return {
    ...(cfg.declared === undefined ? { declaredToolNames: DECLARED } : { declaredToolNames: cfg.declared }),
    ...(cfg.phantom === undefined ? {} : { undeclaredToolPhantomNames: cfg.phantom }),
    ...(cfg.feedback === undefined ? {} : { undeclaredToolFeedback: cfg.feedback }),
    ...(cfg.enforce === undefined ? {} : { enforceDeclaredToolNames: cfg.enforce }),
    freeformToolNames: cfg.freeform ?? FREEFORM,
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

  test("shadow request without an exec channel drops the call rather than relaying it", async () => {
    const sse = await streamWith("tools", { phantom: PHANTOM, freeform: new Set<string>() });
    expect(clientSeesCallNamed(sse, "tools")).toBe(false);
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain("finished the task");
    expect(sse).toContain("response.completed");
  });

  test("direct route keeps failing closed and the name still never reaches the client", async () => {
    const sse = await streamWith("tools", { phantom: new Set<string>() });
    expect(sse).toContain("undeclared client tool");
    expect(sse).toContain("response.failed");
    expect(clientSeesCallNamed(sse, "tools")).toBe(false);
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
      expect(resolveEmittedCall(name)).toEqual({ kind: "drop", name });
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
