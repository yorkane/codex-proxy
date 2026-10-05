/**
 * Malformed tool arguments must not end a turn.
 *
 * The Codex client parses function-call arguments against its Rust structs and a parse
 * failure is a terminal outcome -- the whole turn dies, not just the call. The two
 * spellings this fleet sees (10-day client-log counts: 167x quoted numbers, 70x missing
 * cmd) are repaired here against the request's own declared schema, and only where the
 * schema makes the repair unambiguous. Everything the fail-closed rules below refuse to
 * touch must keep failing exactly as it did before this module existed.
 *
 * The bridge-level tests drive the real transports (SSE + buffered) with a schema map, so
 * a green run proves the client-bound wire carries repaired arguments -- not just that a
 * pure function works. The counter test pins that every repair leaves an attempt-level
 * trace without persisting any model-produced text.
 */
import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { repairToolCallArguments } from "../../src/responses/tool-arg-repair";
import {
  bindAttemptDeliveryRecorder,
  type AttemptDeliveryTarget,
} from "../../src/usage/attempt-delivery";
import { normalizeUsageEntryForTest, type PersistedUsageEntry } from "../../src/usage/log";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import type { AdapterEvent } from "../../src/types";

const num = (t: "integer" | "number") => ({ type: t });
const EXEC_SCHEMA = {
  type: "object",
  properties: {
    cmd: { type: "string" },
    workdir: { type: "string" },
    yield_time_ms: num("integer"),
    session_id: num("integer"),
    login: { type: "boolean" },
  },
  required: ["cmd"],
  additionalProperties: false,
} as const;
const schemas = (s: Record<string, unknown>) => s;
const schemaMap = (name: string, s: Record<string, unknown>) =>
  new Map<string, Record<string, unknown>>([[name, s]]);

describe("quoted numbers become numbers only when the schema demands a number", () => {
  test("the 167x shape: integer field arriving as a quoted decimal string", () => {
    const out = repairToolCallArguments('{"yield_time_ms":"10000"}', EXEC_SCHEMA, "exec_command");
    expect(out.value).toBe('{"yield_time_ms":10000}');
    expect(out.numericRepairs).toBe(1);
  });

  test("real capture: write_stdin session_id + exec_command u64 fields", () => {
    const out = repairToolCallArguments(
      '{"session_id":"29356","yield_time_ms":"240000"}',
      schemas({ ...EXEC_SCHEMA, required: [] }), "exec_command",
    );
    expect(JSON.parse(out.value)).toEqual({ session_id: 29356, yield_time_ms: 240000 });
    expect(out.numericRepairs).toBe(2);
  });

  test("fail-closed: non-numeric strings are never coerced", () => {
    for (const bad of ["abc", "10000abc", "", " ", "1 0", "0x10", "NaN", "Infinity",
      "+5", "-0.5.5", "1e", "1.2.3"]) {
      const out = repairToolCallArguments(`{"yield_time_ms":${JSON.stringify(bad)}}`, EXEC_SCHEMA, "exec_command");
      expect([bad, out.value]).toEqual([bad, `{"yield_time_ms":${JSON.stringify(bad)}}`]);
      expect(out.numericRepairs).toBe(0);
    }
  });

  test("fail-closed: booleans, objects, arrays and null never convert", () => {
    for (const bad of [true, false, null, { n: 1 }, [1], []] as unknown[]) {
      const out = repairToolCallArguments(`{"yield_time_ms":${JSON.stringify(bad)}}`, EXEC_SCHEMA, "exec_command");
      expect(out.value).toBe(`{"yield_time_ms":${JSON.stringify(bad)}}`);
    }
  });

  test("fail-closed: a string-typed field keeps \"true\" (no boolean guessing)", () => {
    const out = repairToolCallArguments('{"flag":"true"}',
      schemas({ type: "object", properties: { flag: { type: "boolean" } } }), "t");
    expect(out.value).toBe('{"flag":"true"}');
  });

  test("fail-closed: fraction or exponent text under an integer type stays a string", () => {
    for (const bad of ["1.5", "1e3", "10.0"]) {
      const out = repairToolCallArguments(`{"yield_time_ms":${JSON.stringify(bad)}}`, EXEC_SCHEMA, "exec_command");
      expect([bad, out.value]).toEqual([bad, `{"yield_time_ms":${JSON.stringify(bad)}}`]);
    }
  });

  test("a number-typed field accepts fraction text (its schema leg is fractional)", () => {
    const out = repairToolCallArguments('{"temperature":"1.5"}',
      schemas({ type: "object", properties: { temperature: num("number") } }), "t");
    expect(out.value).toBe('{"temperature":1.5}');
  });

  test("fail-closed: integer|number...string unions keep the string legal", () => {
    const out = repairToolCallArguments('{"yield_time_ms":"10000"}',
      schemas({ type: "object", properties: { yield_time_ms: { type: ["integer", "string"] } } }), "t");
    expect(out.value).toBe('{"yield_time_ms":"10000"}');
  });

  test("nested objects and arrays are walked", () => {
    const out = repairToolCallArguments('{"options":{"timeout":"5000"},"ids":["1","2"]}',
      schemas({
        type: "object",
        properties: {
          options: { type: "object", properties: { timeout: num("integer") } },
          ids: { type: "array", items: num("integer") },
        },
      }), "t");
    expect(JSON.parse(out.value)).toEqual({ options: { timeout: 5000 }, ids: [1, 2] });
    expect(out.numericRepairs).toBe(3);
  });

  test("untyped fields (no schema node) are never touched", () => {
    const out = repairToolCallArguments('{"free":"123"}',
      schemas({ type: "object", properties: { known: num("integer") } }), "t");
    expect(out.value).toBe('{"free":"123"}');
  });

  test("no schema at all: byte-identical pass-through", () => {
    const out = repairToolCallArguments('{"yield_time_ms":"10000"}', undefined, "exec_command");
    expect(out.value).toBe('{"yield_time_ms":"10000"}');
    expect(out.numericRepairs).toBe(0);
  });

  test("idempotent: an already-valid payload keeps its exact bytes", () => {
    const clean = '{"cmd":"ls -la","yield_time_ms":10000,"login":true}';
    const out = repairToolCallArguments(clean, EXEC_SCHEMA, "exec_command");
    expect(out.value).toBe(clean);
    expect(out.numericRepairs).toBe(0);
    expect(out.aliasRepaired).toBe(false);
    // Re-running over the repaired output changes nothing further.
    const again = repairToolCallArguments('{"yield_time_ms":10000}', EXEC_SCHEMA, "exec_command");
    expect(again.value).toBe('{"yield_time_ms":10000}');
  });

  test("regression rail: legitimate complex payloads are byte-identical", () => {
    const complex = JSON.stringify({
      cmd: "echo \"hi\" && grep -R 'yield_time_ms' src/",
      workdir: "/tmp/a b",
      login: false,
      list: [{ nested: [1, 2, "x"], flag: true }, null],
      deep: { a: { b: { c: -7 } } },
      unicode: "中文 \u0001",
    });
    const wide = { ...EXEC_SCHEMA, additionalProperties: true } as Record<string, unknown>;
    (wide.properties as Record<string, unknown>).list = { type: "array" };
    (wide.properties as Record<string, unknown>).deep = { type: "object" };
    const out = repairToolCallArguments(complex, wide, "exec_command");
    expect(out.value).toBe(complex);
    expect(out.numericRepairs).toBe(0);
  });

  test("malformed JSON is left for the existing paths", () => {
    const out = repairToolCallArguments('{"yield_time_ms":"10000"', EXEC_SCHEMA, "exec_command");
    expect(out.value).toBe('{"yield_time_ms":"10000"');
  });

  test("beyond safe-integer text keeps the string (no silent re-encode)", () => {
    const out = repairToolCallArguments('{"big":"10000000000000000000001"}',
      schemas({ type: "object", properties: { big: num("integer") } }), "t");
    expect(out.value).toBe('{"big":"10000000000000000000001"}');
  });

  test("local $defs resolve for the quoted-number pass", () => {
    const schema = {
      type: "object",
      properties: { timeout: { $ref: "#/$defs/ms" } },
      $defs: { ms: { type: "integer" } },
    };
    const out = repairToolCallArguments('{"timeout":"5000"}', schema, "t");
    expect(out.value).toBe('{"timeout":5000}');
  });
});

describe("direct exec_command calls get the command->cmd alias, schema-gated", () => {
  test("the 70x shape: command-keyed body for a bare exec_command declaration", () => {
    const out = repairToolCallArguments('{"command":"git status","login":true}',
      schemas(EXEC_SCHEMA), "exec_command");
    expect(out.value).toBe('{"login":true,"cmd":"git status"}');
    expect(out.aliasRepaired).toBe(true);
  });

  test("an existing cmd is never overwritten", () => {
    const out = repairToolCallArguments('{"cmd":"keep","command":"drop"}',
      schemas(EXEC_SCHEMA), "exec_command");
    expect(out.value).toBe('{"cmd":"keep","command":"drop"}');
    expect(out.aliasRepaired).toBe(false);
  });

  test("neither key: nothing is invented", () => {
    const out = repairToolCallArguments('{"workdir":"/tmp"}', schemas(EXEC_SCHEMA), "exec_command");
    expect(out.value).toBe('{"workdir":"/tmp"}');
    expect(out.aliasRepaired).toBe(false);
  });

  test("empty command is a disagreement, not a typo shape", () => {
    const out = repairToolCallArguments('{"command":""}', schemas(EXEC_SCHEMA), "exec_command");
    expect(out.value).toBe('{"command":""}');
  });

  test("a third-party tool that merely shares the name keeps its own contract", () => {
    // No required cmd in the declaration -> the faithful-reading gate must refuse.
    const out = repairToolCallArguments('{"command":"ls"}',
      schemas({ type: "object", properties: { command: { type: "string" } } }), "exec_command");
    expect(out.value).toBe('{"command":"ls"}');
    expect(out.aliasRepaired).toBe(false);
  });

  test("cmd not declared as string refuses the alias", () => {
    const out = repairToolCallArguments('{"command":"ls"}',
      schemas({ type: "object", properties: { cmd: num("integer") }, required: ["cmd"] }), "exec_command");
    expect(out.value).toBe('{"command":"ls"}');
  });

  test("namespaced exec_command keeps the namespace as an identity coordinate: no alias", () => {
    const out = repairToolCallArguments('{"command":"ls"}',
      EXEC_SCHEMA as unknown as Record<string, unknown>, "exec_command", "sandbox");
    expect(out.aliasRepaired).toBe(false);
  });

  test("alias and quoted numbers compose in one pass", () => {
    const out = repairToolCallArguments('{"command":"ls","yield_time_ms":"60000"}',
      schemas({ ...EXEC_SCHEMA, properties: { ...EXEC_SCHEMA.properties, command: { type: "string" } },
        additionalProperties: true }), "exec_command");
    expect(JSON.parse(out.value)).toEqual({ command: "ls", yield_time_ms: 60000, cmd: "ls" });
    expect(out.numericRepairs).toBe(1);
    expect(out.aliasRepaired).toBe(true);
  });
});

// ---------- bridge-level: the client wire must carry repaired arguments ----------

async function* turn(name: string, args: string): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call-1", name } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-1", arguments: args } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-1" } as AdapterEvent;
  yield { type: "done" } as AdapterEvent;
}

async function sseItems(events: AdapterEvent[], opts: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const stream = bridgeToResponsesSSE((async function* () { for (const e of events) yield e; })(),
    "llm-248/x", undefined, undefined, undefined, undefined, 50_000, opts as never);
  const raw = await new Response(stream).text();
  const items: Array<Record<string, unknown>> = [];
  for (const block of raw.split("\n\n")) {
    if (!block.includes("response.output_item.done")) continue;
    const idx = block.indexOf("data: ");
    if (idx < 0) continue;
    const parsed = JSON.parse(block.slice(idx + 6)) as { item?: Record<string, unknown> };
    if (parsed.item) items.push(parsed.item);
  }
  return items;
}

const DECLARED = new Set(["exec_command"]);
function bridgeOpts(budget: object, map: Map<string, Record<string, unknown>>) {
  return { declaredToolNames: DECLARED, toolParameterSchemas: map, translatorBudget: budget };
}

describe("the relayed wire carries repaired arguments on both transports", () => {
  const quoted = '{"cmd":"ls","yield_time_ms":"10000"}';
  const aliased = '{"command":"git status"}';

  test("SSE: function_call arguments.done + item carry numbers, not numeric strings", async () => {
    const items = await sseItems([...[] as AdapterEvent[],
      { type: "tool_call_start", id: "c1", name: "exec_command" },
      { type: "tool_call_delta", id: "c1", arguments: quoted },
      { type: "tool_call_end", id: "c1" },
      { type: "done" }] as AdapterEvent[], bridgeOpts(createTestTranslatorBudget(), schemaMap('exec_command', EXEC_SCHEMA)));
    const call = items.find(i => i.type === "function_call");
    expect(call).toBeDefined();
    const args = JSON.parse((call as { arguments: string }).arguments) as Record<string, unknown>;
    expect(args.yield_time_ms).toBe(10000);
    expect(typeof args.yield_time_ms).toBe("number");
  });

  test("SSE: the missing-cmd shape reaches the client with cmd present", async () => {
    const items = await sseItems([
      { type: "tool_call_start", id: "c1", name: "exec_command" },
      { type: "tool_call_delta", id: "c1", arguments: aliased },
      { type: "tool_call_end", id: "c1" },
      { type: "done" }] as AdapterEvent[], bridgeOpts(createTestTranslatorBudget(), schemaMap('exec_command', EXEC_SCHEMA)));
    const call = items.find(i => i.type === "function_call") as { arguments: string };
    expect(JSON.parse(call.arguments)).toEqual({ cmd: "git status" });
  });

  test("buffered: same fixtures, same wire", () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "c1", name: "exec_command" },
      { type: "tool_call_delta", id: "c1", arguments: quoted },
      { type: "tool_call_end", id: "c1" },
      { type: "tool_call_start", id: "c2", name: "exec_command" },
      { type: "tool_call_delta", id: "c2", arguments: aliased },
      { type: "tool_call_end", id: "c2" },
      { type: "done" },
    ] as AdapterEvent[];
    const body = buildResponseJSON(events, "llm-248/x", bridgeOpts(createTestTranslatorBudget(), schemaMap('exec_command', EXEC_SCHEMA)) as never);
    const calls = (body.output as Array<Record<string, unknown>>).filter(i => i.type === "function_call");
    expect(calls.length).toBe(2);
    expect(JSON.parse(calls[0]!.arguments as string)).toEqual({ cmd: "ls", yield_time_ms: 10000 });
    expect(JSON.parse(calls[1]!.arguments as string)).toEqual({ cmd: "git status" });
  });

  test("without a schema map the bridge is byte-identical to the old behavior", async () => {
    const items = await sseItems([
      { type: "tool_call_start", id: "c1", name: "exec_command" },
      { type: "tool_call_delta", id: "c1", arguments: aliased },
      { type: "tool_call_end", id: "c1" },
      { type: "done" }] as AdapterEvent[], { declaredToolNames: DECLARED, translatorBudget: createTestTranslatorBudget() });
    const call = items.find(i => i.type === "function_call") as { arguments: string };
    expect(call.arguments).toBe(aliased);
  });
});

describe("argument repairs leave an attempt-level trace", () => {
  test("repaired calls count; clean calls record nothing", () => {
    const attempt: AttemptDeliveryTarget = {};
    const budget = createTestTranslatorBudget();
    bindAttemptDeliveryRecorder(budget, () => attempt);
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "c1", name: "exec_command" },
      { type: "tool_call_delta", id: "c1", arguments: '{"cmd":"ls","yield_time_ms":"10000","session_id":"7"}' },
      { type: "tool_call_end", id: "c1" },
      { type: "tool_call_start", id: "c2", name: "exec_command" },
      { type: "tool_call_delta", id: "c2", arguments: '{"cmd":"ps"}' },
      { type: "tool_call_end", id: "c2" },
      { type: "done" },
    ] as AdapterEvent[];
    buildResponseJSON(events, "llm-248/x", {
      ...bridgeOpts(budget, schemaMap('exec_command', EXEC_SCHEMA)),
      recordBufferedDelivery: false,
    } as never);
    // call 1: two quoted numbers repaired; call 2: nothing to repair.
    expect(attempt.argRepairs).toBe(2);

    const clean: AttemptDeliveryTarget = {};
    const cleanBudget = createTestTranslatorBudget();
    bindAttemptDeliveryRecorder(cleanBudget, () => clean);
    buildResponseJSON([
      { type: "tool_call_start", id: "c1", name: "exec_command" },
      { type: "tool_call_delta", id: "c1", arguments: '{"cmd":"ps","yield_time_ms":5}' },
      { type: "tool_call_end", id: "c1" },
      { type: "done" },
    ] as AdapterEvent[], { ...bridgeOpts(cleanBudget, schemaMap('exec_command', EXEC_SCHEMA)), recordBufferedDelivery: false } as never);
    expect(clean.argRepairs).toBeUndefined();
  });

  test("the durable ledger normalizer keeps argRepairs, and refuses a non-count", () => {
    const entry = {
      timestamp: 1, model: "llm-248/x", provider: "llm-248", adapter: "openai-chat",
      requestedModel: "llm-248/x", status: 200, durationMs: 5,
      attempts: [{
        ordinal: 1, provider: "llm-248", model: "llm-248/x", adapter: "openai-chat",
        status: 200, durationMs: 5, sendCount: 1, recoveryKinds: [], usageStatus: "reported",
        argRepairs: 3,
      }, {
        ordinal: 2, provider: "llm-248", model: "llm-248/x", adapter: "openai-chat",
        status: 200, durationMs: 5, sendCount: 1, recoveryKinds: [], usageStatus: "reported",
        argRepairs: -5,
      }, {
        ordinal: 3, provider: "llm-248", model: "llm-248/x", adapter: "openai-chat",
        status: 200, durationMs: 5, sendCount: 1, recoveryKinds: [], usageStatus: "reported",
      }],
    } as unknown as PersistedUsageEntry;
    const attempts = normalizeUsageEntryForTest(entry).attempts ?? [];
    // A repaired count must reach the ledger, or the Shadow page cannot tell "the proxy fixed a
    // quoted number" from "the model never sent one" - the same distinction droppedEmits carries
    // for removals. A negative value is not a count and is dropped rather than stored.
    expect(attempts[0]?.argRepairs).toBe(3);
    expect(attempts[1]?.argRepairs).toBeUndefined();
    // Absent unless something was repaired, so ordinary rows keep their exact prior shape.
    expect(attempts[2]?.argRepairs).toBeUndefined();
    expect(attempts.map(a => a.ordinal)).toEqual([1, 2, 3]);
  });
});
