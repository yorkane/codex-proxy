/**
 * Dropped emitted calls must leave evidence.
 *
 * The guard deletes a call the client could not dispatch (a tool NAMESPACE container, an
 * allowlisted phantom) so the turn survives instead of ending on the client's unsupported-call
 * error. That was an invisible improvement: a request log showing no such call could not
 * distinguish "the proxy removed one" from "the model never made one", which is the exact
 * distinction needed when a session stops for no visible reason.
 *
 * Two things are pinned here. The container rule must be falsifiable by the request's own
 * catalog (a declared tool named like a container is a tool), and every silent removal must
 * land on the attempt as a droppedEmits row while a relayed call produces none.
 */
import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import {
  bindAttemptDeliveryRecorder,
  normalizeAttemptDroppedEmits,
  type AttemptDeliveryTarget,
} from "../../src/usage/attempt-delivery";
import { normalizeUsageEntryForTest, type PersistedUsageEntry } from "../../src/usage/log";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import {
  droppedEmitDisposition,
  isDroppedNamespaceContainer,
  resolveEmittedCall,
} from "../../src/responses/emitted-call-guard";
import type { AdapterEvent } from "../../src/types";

/** A call reached the client only when the wire carries an item naming it. */
const QUOTE = String.fromCharCode(34);
const clientSeesCallNamed = (wire: string, name: string) =>
  wire.includes(QUOTE + "name" + QUOTE + ":" + QUOTE + name + QUOTE);

const DECLARED = new Set(["exec", "collaboration__spawn_agent", "collaboration__update_plan"]);
const FREEFORM = new Set(["exec"]);
// web_search is deliberately not reachable by shape repair from this catalog, so a phantom match
// on it is a genuine drop rather than a rename that relays the call under a declared name.
const PHANTOM = new Set(["tools", "web_search"]);

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

interface Cfg {
  declared?: ReadonlySet<string>;
  phantom?: ReadonlySet<string>;
  freeform?: Set<string>;
  enforce?: boolean;
  /** Ask the bridge with NO catalog at all, the shape a passthrough-style caller uses. */
  noCatalog?: boolean;
}

/**
 * The same eight events for both transports, so a streaming/buffered disagreement cannot hide
 * behind a difference in fixtures: one real call, then the bad call, then an ordinary completion.
 */
function events(badName: string): AdapterEvent[] {
  return [
    { type: "tool_call_start", id: "call-real", name: "exec" },
    { type: "tool_call_delta", id: "call-real", arguments: "{}" },
    { type: "tool_call_end", id: "call-real" },
    { type: "tool_call_start", id: "call-bad", name: badName },
    { type: "tool_call_delta", id: "call-bad", arguments: "{}" },
    { type: "tool_call_end", id: "call-bad" },
    { type: "text_delta", text: "finished the task" },
    { type: "done" },
  ] as AdapterEvent[];
}

async function* gen(badName: string): AsyncGenerator<AdapterEvent> {
  for (const event of events(badName)) yield event;
}

function guardOptions(cfg: Cfg, budget: object) {
  return {
    ...(cfg.noCatalog
      ? {}
      : { declaredToolNames: cfg.declared ?? DECLARED }),
    ...(cfg.phantom === undefined ? {} : { undeclaredToolPhantomNames: cfg.phantom }),
    ...(cfg.enforce === undefined ? {} : { enforceDeclaredToolNames: cfg.enforce }),
    freeformToolNames: cfg.freeform ?? FREEFORM,
    // 发射名改写门控：本文件锁的 phantom/改名观测都发生在 shadow（三方）作用域 ——
    // phantom 允许列表本来就只在 gate=true 时被构造出来，缺省官方语义下这些名字会
    // 直接 fail closed 而不是改名/丢弃，整组遥测断言就失去被测对象。
    servingRouteIsThirdParty: true,
    translatorBudget: budget,
  } as never;
}

/**
 * Drive one turn through the real bridge with a recorder bound the way request-transport binds
 * it: the request-scoped budget is the key, and the attempt is read live through a callback so a
 * mid-request rotation cannot leave counts on a sealed row.
 */
async function run(badName: string, cfg: Cfg): Promise<{
  wire: string; attempt: AttemptDeliveryTarget;
}> {
  const attempt: AttemptDeliveryTarget = {};
  const budget = createTestTranslatorBudget();
  bindAttemptDeliveryRecorder(budget, () => attempt);
  const wire = await drain(bridgeToResponsesSSE(
    gen(badName), "llm-248/x", undefined, cfg.freeform ?? FREEFORM, undefined,
    undefined, 50_000, guardOptions(cfg, budget),
  ));
  return { wire, attempt };
}

/** The buffered twin, with the same fixture and the same binding. */
function runJson(badName: string, cfg: Cfg): {
  body: Record<string, unknown>; attempt: AttemptDeliveryTarget;
} {
  const attempt: AttemptDeliveryTarget = {};
  const budget = createTestTranslatorBudget();
  bindAttemptDeliveryRecorder(budget, () => attempt);
  const body = buildResponseJSON(events(badName), "llm-248/x", {
    ...guardOptions(cfg, budget),
    // The buffered path re-derives relayed delivery from the finished body; this file is about
    // the drop recorder, so keep the two counters from interfering with each other.
    recordBufferedDelivery: false,
  } as never);
  return { body, attempt };
}

describe("container judgement is falsifiable by the declared catalog", () => {
  test("a declared tool named tools is a tool, not a container", () => {
    // The guard rail the review asked for. tools used to be an unconditional container, so no
    // provider could ever declare a real tool by that name without its calls vanishing.
    const declared = new Set(["tools", "exec"]);
    expect(isDroppedNamespaceContainer("tools", declared)).toBe(false);
    const v = resolveEmittedCall("tools", {
      declaredToolNames: declared,
      freeformToolNames: FREEFORM,
      phantomNames: new Set(["tools"]),
    });
    expect(v).toEqual({ kind: "allow", name: "tools", repaired: false });
  });

  test("an undeclared tools still counts as the sandbox container", () => {
    expect(isDroppedNamespaceContainer("tools", new Set(["exec"]))).toBe(true);
    expect(isDroppedNamespaceContainer("tools")).toBe(true);
  });

  test("the bridge relays a declared tools call and records nothing", async () => {
    const declared = new Set(["tools", "exec"]);
    const { wire, attempt } = await run("tools", { declared, phantom: new Set(["tools"]) });
    expect(clientSeesCallNamed(wire, "tools")).toBe(true);
    expect(attempt.droppedEmits).toBeUndefined();
  });

  test("a declared collaboration is a tool; an undeclared one is the container", () => {
    // Same rule for the non-sandbox branch: catalog membership outranks the prefix scan.
    expect(isDroppedNamespaceContainer("collaboration", new Set(["collaboration"]))).toBe(false);
    expect(isDroppedNamespaceContainer("collaboration", DECLARED)).toBe(true);
  });
});

describe("silent removals are recorded on the attempt", () => {
  test("a phantom drop on the streaming path records the name the model emitted", async () => {
    // No exec channel, so no directive feedback is possible: the call simply disappears.
    const { wire, attempt } = await run("web_search", { phantom: PHANTOM, freeform: new Set<string>() });
    expect(wire).not.toContain("undeclared client tool");
    expect(clientSeesCallNamed(wire, "web_search")).toBe(false);
    expect(wire).toContain("response.completed");
    expect(attempt.droppedEmits).toEqual([
      { name: "web_search", effective: "web_search", decision: "phantom", count: 1 },
    ]);
  });

  test("a container dropped on the deferred wire is labelled as the container it is", async () => {
    // enforce:false is the chat/anthropic opt-out. The container rule is what saved this turn and
    // the row must say so, because a container and an allowlist phantom have different fixes.
    const { attempt } = await run("collaboration", {
      phantom: new Set(["collaboration"]), enforce: false, freeform: new Set<string>(),
    });
    expect(attempt.droppedEmits).toEqual([
      { name: "collaboration", effective: "collaboration", decision: "namespace-container", count: 1 },
    ]);
  });

  test("the buffered twin records the same row", () => {
    const { body, attempt } = runJson("web_search", { phantom: PHANTOM, freeform: new Set<string>() });
    expect(JSON.stringify(body)).not.toContain("web_search");
    expect(attempt.droppedEmits).toEqual([
      { name: "web_search", effective: "web_search", decision: "phantom", count: 1 },
    ]);
  });

  test("repeats of one bad name fold into a single counted row", () => {
    const attempt: AttemptDeliveryTarget = {};
    const recorder = bindAttemptDeliveryRecorder({}, () => attempt);
    for (let i = 0; i < 3; i += 1) {
      recorder.noteDroppedEmit({ emitted: "web__run", effective: "web__run", decision: "phantom" });
    }
    expect(attempt.droppedEmits).toEqual([
      { name: "web__run", effective: "web__run", decision: "phantom", count: 3 },
    ]);
  });

  test("a clean turn records nothing", async () => {
    const { wire, attempt } = await run("exec", { phantom: PHANTOM });
    expect(wire).toContain("response.completed");
    expect(attempt.droppedEmits).toBeUndefined();
  });

  test("an ordinary relayed provider echo on the deferred wire is not a drop", async () => {
    // Over-recording would make the field meaningless: this call reaches the client, so it must
    // leave no row at all.
    const { wire, attempt } = await run("provider_echo", {
      phantom: new Set<string>(), enforce: false, declared: new Set(["exec"]),
    });
    expect(clientSeesCallNamed(wire, "provider_echo")).toBe(true);
    expect(attempt.droppedEmits).toBeUndefined();
  });

  test("a fail-closed 502 is not recorded as a silent removal", async () => {
    // The client sees that one, and the distinction is the whole point: logging it as a drop would
    // make the field claim a quiet survival where the turn actually failed.
    const { wire, attempt } = await run("totally_made_up", {
      phantom: new Set<string>(), enforce: true, declared: new Set(["exec", "collaboration__spawn_agent"]),
    });
    expect(wire).toContain("undeclared client tool");
    expect(attempt.droppedEmits).toBeUndefined();
  });

  test("the enforcing wire still drops a container without relaying it", async () => {
    // With no catalog at all the guard's own no-catalog branch removes the container - it is
    // provably not callable whatever the catalog says - and that removal is silent, so it must be
    // recorded. This is the shape a container drop takes without an allowlist.
    const { wire, attempt } = await run("tools", {
      noCatalog: true, phantom: new Set<string>(), freeform: new Set<string>(),
    });
    expect(clientSeesCallNamed(wire, "tools")).toBe(false);
    expect(wire).toContain("response.completed");
    expect(attempt.droppedEmits).toEqual([
      { name: "tools", effective: "tools", decision: "namespace-container", count: 1 },
    ]);
  });

  test("an allowlisted container on an enforcing route reports as the container", async () => {
    // The shadow case: the operator put tools on the phantom allowlist, so the drop happens in the
    // allowlist branch. The label must still say container - the more specific diagnosis wins,
    // otherwise adding the name to the list would erase why the call was really impossible.
    const { wire, attempt } = await run("tools", {
      phantom: new Set(["tools"]), enforce: true, freeform: new Set<string>(),
    });
    expect(clientSeesCallNamed(wire, "tools")).toBe(false);
    expect(wire).toContain("response.completed");
    expect(attempt.droppedEmits).toEqual([
      { name: "tools", effective: "tools", decision: "namespace-container", count: 1 },
    ]);
  });

  test("no recorder bound means no throw and the drop still happens", async () => {
    // Lab/conformance callers pass a budget nobody bound. Observability is optional; the drop is not.
    const budget = createTestTranslatorBudget();
    const wire = await drain(bridgeToResponsesSSE(
      gen("update_plan"), "llm-248/x", undefined, new Set<string>(), undefined,
      undefined, 50_000, guardOptions({ phantom: PHANTOM, freeform: new Set<string>() }, budget),
    ));
    expect(clientSeesCallNamed(wire, "update_plan")).toBe(false);
    expect(wire).toContain("response.completed");
  });
});

describe("disposition labelling", () => {
  test("a phantom that is provably a container reports as the container", () => {
    // An operator who adds tools to the allowlist must not erase the more specific diagnosis:
    // the two names have different fixes.
    expect(droppedEmitDisposition("tools", "tools", DECLARED)).toBe("namespace-container");
    expect(droppedEmitDisposition("update_plan", "update_plan", DECLARED)).toBe("phantom");
  });

  test("the raw emission counts even when repair produced another name", () => {
    expect(droppedEmitDisposition("exec_command", "tools", DECLARED)).toBe("namespace-container");
  });

  test("an ambiguous repaired name falls back to the phantom label", () => {
    expect(droppedEmitDisposition("totally_made_up", "totally_made_up", DECLARED)).toBe("phantom");
  });
});

describe("durable row contract", () => {
  const row = (droppedEmits: unknown): PersistedUsageEntry => ({
    requestId: "r1",
    timestamp: 1,
    provider: "llm-248",
    model: "x",
    status: 200,
    durationMs: 5,
    attempts: [{
      ordinal: 1,
      provider: "llm-248",
      model: "x",
      adapter: "openai-chat",
      status: 200,
      durationMs: 5,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "unreported",
      droppedEmits,
    }],
  } as unknown as PersistedUsageEntry);

  test("a well formed list survives the round trip", () => {
    const good = [{ name: "tools", effective: "tools", decision: "namespace-container", count: 2 }];
    expect(normalizeUsageEntryForTest(row(good)).attempts?.[0]?.droppedEmits).toEqual(good);
  });

  test("an unknown decision drops the whole list rather than trusting part of it", () => {
    expect(normalizeUsageEntryForTest(row([
      { name: "tools", effective: "tools", decision: "namespace-container", count: 1 },
    ])).attempts?.[0]?.droppedEmits).toEqual([
      { name: "tools", effective: "tools", decision: "namespace-container", count: 1 },
    ]);
    expect(normalizeUsageEntryForTest(row([
      { name: "tools", effective: "tools", decision: "namespace-container", count: 1 },
      { name: "web__run", effective: "web__run", decision: "made-up", count: 1 },
    ])).attempts?.[0]?.droppedEmits).toBeUndefined();
  });

  test("a row written before the field existed still loads", () => {
    const legacy = normalizeUsageEntryForTest(row(undefined));
    expect(legacy.attempts?.[0]?.ordinal).toBe(1);
    expect(legacy.attempts?.[0]?.droppedEmits).toBeUndefined();
  });

  test("a non-positive or fractional count is refused", () => {
    for (const count of [0, -1, 1.5, Number.NaN, "2"]) {
      expect(normalizeAttemptDroppedEmits([
        { name: "tools", effective: "tools", decision: "phantom", count },
      ])).toBeUndefined();
    }
  });

  test("model-authored names reach the row sanitised", async () => {
    // The recorded name is text the model chose, so it gets the same reduction every other
    // model-sourced log field gets. A name carrying a secret-shaped run must not reach the ledger
    // intact, and neither may one carrying a record-boundary control character.
    // The sentinel is named to the scanner's own test-fixture convention (scripts/privacy-scan.ts
    // allows `sk-test-<digits><lowercase>`), so a credential-shaped literal in this test does not
    // turn the privacy gate red. redactSecretString still matches it, which is the point of the
    // assertion - verified by running the sanitizer, not assumed.
    const secret = "sk-test-1234567890abcdefghij";
    const attempt: AttemptDeliveryTarget = {};
    const budget = createTestTranslatorBudget();
    bindAttemptDeliveryRecorder(budget, () => attempt);
    await drain(bridgeToResponsesSSE(
      gen(secret), "llm-248/x", undefined, new Set<string>(), undefined,
      undefined, 50_000, guardOptions({ phantom: new Set([secret]), freeform: new Set<string>() }, budget),
    ));
    const rows = attempt.droppedEmits;
    expect(rows).toBeDefined();
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
});
