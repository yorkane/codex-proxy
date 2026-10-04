import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { RequestLogContext } from "../../src/server/request-log";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// Regression lock for the 2026-10-04 Desktop interruption (thread 01a04e5f / turn 01a10716).
// Codex replays an apply_patch result (custom_tool_call_output) and the model answers THAT
// continuation with reasoning plus a clean terminal only — no message, no tool call. The client
// has no code path for "the model said nothing": it records task_complete with
// last_agent_message=null and the UI stalls on the tool output until a human types the
// equivalent of "please continue".
//
// The recovery already exists upstream — guardEmptyCompletionEventStream holds the pre-content
// events, suppresses the empty terminal, and re-issues the byte-identical turn once. These cases
// pin that machinery to the shape of the field incident on the transport the field models
// actually use: the llm-248 openai-chat adapter has no runTurn, so every Codex Desktop turn is
// served by deliverAdapterResponse, not by the runTurn branch. A guard that only fired on
// runTurn would have been a green suite over a still-broken proxy.

const actualResolver = await import("../../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;

let attemptEvents: AdapterEvent[][] = [];
let httpCalls = 0;
let runTurnCalls = 0;
let builtBodies: string[] = [];
let parsedAttempts: OcxParsedRequest[] = [];
let releaseSpendHome: (() => void) | undefined;

// The Codex client's own request tail at the moment of the incident: the assistant emitted
// apply_patch, the client ran it, and this request exists to ask what happens next.
const TOOL_OUTPUT_TAIL = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "fix the empty completion" }] },
  {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "read the code first" }],
    encrypted_content: "ocxr1.opaque-replay-blob",
  },
  { type: "custom_tool_call", call_id: "call_apply", name: "apply_patch", input: "the patch body" },
  { type: "custom_tool_call_output", call_id: "call_apply", output: "Success. Updated the following files." },
];

const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };

function attemptAt(index: number): AdapterEvent[] {
  return attemptEvents[index] ?? [{ type: "error", message: "missing fixture attempt " + index }];
}

function fixtureAdapter(provider: OcxProviderConfig): ProviderAdapter {
  const runTurn = provider.adapter === "test-run-turn";
  return {
    name: runTurn ? "test-run-turn" : "openai-chat",
    buildRequest(parsed) {
      // Serialise the RAW Responses input: the replay must re-send the tool output verbatim, so
      // this value is also the field that proves the second send is byte-identical.
      const serialized = JSON.stringify({
        model: parsed.modelId,
        input: (parsed._rawBody as { input?: unknown }).input ?? null,
      });
      builtBodies.push(serialized);
      return { url: provider.baseUrl, method: "POST", headers: {}, body: serialized };
    },
    async fetchResponse(request, context) {
      return context!.executor!(request.url, { method: request.method, headers: request.headers, body: request.body });
    },
    async *parseStream(response) {
      yield* attemptAt(Number(response.headers.get("x-fixture-attempt")));
    },
    async parseResponse(response) {
      return attemptAt(Number(response.headers.get("x-fixture-attempt")));
    },
    ...(runTurn ? {
      async runTurn(parsed: OcxParsedRequest, _incoming: unknown, emit: (event: AdapterEvent) => void) {
        await (_incoming as { providerFetch: typeof fetch }).providerFetch(provider.baseUrl, { method: "POST" });
        parsedAttempts.push(parsed);
        for (const event of attemptAt(runTurnCalls)) emit(event);
        runTurnCalls += 1;
      },
    } : {}),
  };
}

mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter === "test-run-turn" || provider.adapter === "test-http") return fixtureAdapter(provider);
    return actualResolveAdapter(provider, cacheRetention);
  },
}));

const { handleResponses } = await import("../../src/server/responses");

function config(adapter: "test-http" | "test-run-turn", extra: Partial<OcxConfig> = {}): OcxConfig {
  const result = {
    port: 0,
    defaultProvider: "fixture",
    emptyCompletionRetry: true,
    providers: {
      fixture: {
        adapter,
        baseUrl: "https://fixture.test/v1",
        apiKey: "fixture-key",
        authMode: "key",
        models: ["model"],
      },
    },
    ...extra,
  } as OcxConfig;
  (result.providers.fixture as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch = async () => {
    const index = adapter === "test-http" ? httpCalls : runTurnCalls;
    if (adapter === "test-http") httpCalls += 1;
    return new Response("", { headers: { "x-fixture-attempt": String(index) } });
  };
  return result;
}

function request(stream: boolean, input: unknown = TOOL_OUTPUT_TAIL): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": "01a04e5f-thread" },
    body: JSON.stringify({
      model: "fixture/model",
      input,
      stream,
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    }),
  });
}

const emptyLogCtx = (): RequestLogContext => ({ model: "", provider: "" });

interface Frame { event: string; data: Record<string, unknown> }

async function frames(stream: ReadableStream<Uint8Array>): Promise<Frame[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    raw += decoder.decode(chunk.value, { stream: true });
  }
  return raw.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && !frame.includes("data: [DONE]"))
    .map(frame => {
      const lines = frame.split("\n");
      const eventLine = lines.find(line => line.startsWith("event: "));
      const dataLine = lines.find(line => line.startsWith("data: "));
      return {
        event: eventLine ? eventLine.slice("event: ".length) : "",
        data: dataLine ? JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown> : {},
      };
    });
}

// The reasoning-only terminal the field produced. openai-chat surfaces upstream reasoning as
// reasoning_raw_delta (src/adapters/openai-chat.ts:441) and finish_reason "stop" maps to an
// undefined stopReason (src/adapters/openai-chat/response-events.ts:5), so the turn reaches the
// guard as reasoning deltas plus a done with no content event anywhere — the canonical empty
// shape per isContentEvent (src/server/responses/empty-completion-guard.ts:123).
function reasoningOnlyAttempt(thinking: string): AdapterEvent[] {
  return [
    { type: "reasoning_raw_delta", text: thinking },
    { type: "thinking_delta", thinking: thinking + " (summary)" },
    { type: "thinking_signature", signature: "sig-" + thinking },
    { type: "done", usage: { inputTokens: 4200, outputTokens: 3, totalTokens: 4203 } },
  ];
}

function answeredAttempt(text: string): AdapterEvent[] {
  return [
    { type: "text_delta", text, phase: "final_answer" },
    { type: "done", endTurn: true, usage: { inputTokens: 4300, outputTokens: 12, totalTokens: 4312 } },
  ];
}

beforeEach(() => {
  attemptEvents = [];
  httpCalls = 0;
  runTurnCalls = 0;
  builtBodies = [];
  parsedAttempts = [];
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  delete process.env.OCX_EMPTY_COMPLETION_RETRY;
});

describe("empty-completion replay after a tool output (adapter-delivery / openai-chat)", () => {
  test("streaming: reasoning-only continuation after a tool output is replayed once and delivers the answer", async () => {
    attemptEvents = [reasoningOnlyAttempt("tool output replayed, continuing"), answeredAttempt("continuing: fix applied")];
    const logCtx = emptyLogCtx();

    takeSpendHome();
    const response = await handleResponses(request(true), config("test-http"), logCtx);
    const collected = await frames(response.body!);

    // One nudge per turn: the empty attempt plus the replay that answered.
    expect(httpCalls).toBe(2);
    // The empty attempt never became a visible completion, and the turn has exactly one terminal.
    expect(collected.filter(frame => frame.event === "response.completed")).toHaveLength(1);
    expect(collected.filter(frame => frame.event === "response.failed")).toHaveLength(0);
    expect(JSON.stringify(collected)).toContain("continuing: fix applied");
    // The replay is the identical turn — the nudge the user would have typed, with the same
    // tool-output bytes. A second buildRequest would mean the history drifted.
    expect(builtBodies).toHaveLength(1);
    expect(logCtx.activeAttempt).toMatchObject({
      sendCount: 2,
      recoveryKinds: ["empty-completion"],
      usage: { inputTokens: 8500, outputTokens: 15, totalTokens: 8515 },
    });
  });

  test("non-streaming: the same shape is replayed once through parseResponse", async () => {
    attemptEvents = [reasoningOnlyAttempt("buffered"), answeredAttempt("buffered answer")];
    const logCtx = emptyLogCtx();

    takeSpendHome();
    const response = await handleResponses(request(false), config("test-http"), logCtx);
    const json = await response.json() as { status?: string; output?: { type?: string }[] };

    expect(httpCalls).toBe(2);
    expect(builtBodies).toHaveLength(1);
    expect(json.status).toBe("completed");
    expect(JSON.stringify(json.output)).toContain("buffered answer");
    expect(logCtx.activeAttempt).toMatchObject({ sendCount: 2, recoveryKinds: ["empty-completion"] });
  });

  test("a replay that is ALSO empty states the failure instead of a second silent success", async () => {
    attemptEvents = [reasoningOnlyAttempt("again nothing"), reasoningOnlyAttempt("still nothing")];

    takeSpendHome();
    const response = await handleResponses(request(true), config("test-http"), emptyLogCtx());
    const collected = await frames(response.body!);

    expect(httpCalls).toBe(2);
    // Bounded: never a third send for the same turn.
    expect(builtBodies).toHaveLength(1);
    const failed = collected.filter(frame => frame.event === "response.failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed)).toContain("empty_completion_retry_failed");
    expect(collected.filter(frame => frame.event === "response.completed")).toHaveLength(0);
  });

  test("a turn that produced a message keeps its normal end_turn and is never replayed", async () => {
    attemptEvents = [answeredAttempt("this is a complete answer")];

    takeSpendHome();
    const response = await handleResponses(request(true), config("test-http"), emptyLogCtx());
    const collected = await frames(response.body!);

    expect(httpCalls).toBe(1);
    expect(builtBodies).toHaveLength(1);
    expect(JSON.stringify(collected)).toContain("this is a complete answer");
    expect(collected.filter(frame => frame.event === "response.completed")).toHaveLength(1);
    expect(collected.filter(frame => frame.event === "response.failed")).toHaveLength(0);
  });

  test("a turn that only emitted a tool call is content and is never replayed", async () => {
    attemptEvents = [[
      { type: "reasoning_raw_delta", text: "I will edit this file" },
      { type: "tool_call_start", id: "call_1", name: "exec_command" },
      { type: "tool_call_delta", arguments: "{\"cmd\":\"ls\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
    ]];

    takeSpendHome();
    const response = await handleResponses(request(true), config("test-http"), emptyLogCtx());
    const collected = await frames(response.body!);

    expect(httpCalls).toBe(1);
    expect(JSON.stringify(collected)).toContain("exec_command");
    expect(collected.filter(frame => frame.event === "response.failed")).toHaveLength(0);
  });

  test("a max_tokens terminal is an already-stated failure and is not replayed", async () => {
    attemptEvents = [[
      { type: "reasoning_raw_delta", text: "cut off mid sentence" },
      { type: "done", stopReason: "max_tokens", usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 } },
    ]];

    takeSpendHome();
    const response = await handleResponses(request(true), config("test-http"), emptyLogCtx());
    await frames(response.body!);

    expect(httpCalls).toBe(1);
    expect(builtBodies).toHaveLength(1);
  });

  test("config emptyCompletionRetry=false bypasses the guard entirely (the current production state)", async () => {
    attemptEvents = [reasoningOnlyAttempt("guard off")];
    const off = config("test-http");
    off.emptyCompletionRetry = false;

    takeSpendHome();
    const response = await handleResponses(request(true), off, emptyLogCtx());
    const collected = await frames(response.body!);

    // Exactly the pre-guard relay: one send, and the client records the empty turn as done.
    expect(httpCalls).toBe(1);
    expect(collected.filter(frame => frame.event === "response.completed")).toHaveLength(1);
    expect(collected.filter(frame => frame.event === "response.failed")).toHaveLength(0);
  });

  test("OCX_EMPTY_COMPLETION_RETRY=0 disables an opted-in config without editing it", async () => {
    attemptEvents = [reasoningOnlyAttempt("env kill switch")];
    process.env.OCX_EMPTY_COMPLETION_RETRY = "0";

    takeSpendHome();
    const response = await handleResponses(request(true), config("test-http"), emptyLogCtx());
    await frames(response.body!);

    expect(httpCalls).toBe(1);
  });

  test("the replay budget is per request: two consecutive turns each get one nudge, never a storm", async () => {
    // Four scripted attempts: turn 1 = original + its one nudge, turn 2 = original + its own
    // nudge. A counter shared across the whole process would leave the second turn with no
    // replay at all, and an unbounded counter would show up here as more than four sends.
    attemptEvents = [
      reasoningOnlyAttempt("first"),
      reasoningOnlyAttempt("first retry"),
      reasoningOnlyAttempt("second"),
      reasoningOnlyAttempt("second retry"),
    ];

    takeSpendHome();
    const first = await handleResponses(request(true), config("test-http"), emptyLogCtx());
    await frames(first.body!);
    const second = await handleResponses(request(true), config("test-http"), emptyLogCtx());
    await frames(second.body!);

    // Two turns, two sends each: the window is one request, so a later turn is not starved by an
    // earlier one and no single turn can exceed its own allowance.
    expect(httpCalls).toBe(4);
    expect(builtBodies).toHaveLength(2);
  });

  test("the runTurn transport keeps the same recovery for the same shape", async () => {
    attemptEvents = [reasoningOnlyAttempt("runTurn path"), answeredAttempt("runTurn answer")];
    const logCtx = emptyLogCtx();

    takeSpendHome();
    const response = await handleResponses(request(true), config("test-run-turn"), logCtx);
    const collected = await frames(response.body!);

    expect(runTurnCalls).toBe(2);
    expect(JSON.stringify(collected)).toContain("runTurn answer");
    // The replayed attempt re-dispatches the same parsed request object, not a mutated copy.
    expect(parsedAttempts[1]).toBe(parsedAttempts[0]);
    expect(collected.filter(frame => frame.event === "response.completed")).toHaveLength(1);
  });
});
