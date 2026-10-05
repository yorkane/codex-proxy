/**
 * The empty-completion replay BUDGET (fork addition).
 *
 * `emptyCompletionRetry` is the switch; `emptyCompletionRetryMax` is how many identical-turn replays
 * an opted-in guard may spend. The guard has accepted a maxRetries number since it shipped, so what
 * actually regresses here is the WIRING: a caller point that forgets to forward the resolved budget
 * silently falls back to one replay, and the operator's "2" would then mean "1" on exactly the
 * transport their traffic uses. These cases therefore count physical sends through the real
 * Responses pipeline on the transport the field incident used (adapter delivery, no runTurn), and
 * they also pin the two semantics decisions:
 *
 * - the default stays 1, so an existing opt-in behaves byte-identically to before;
 * - a budget of 0 means "do not replay" and is realised as the pre-guard RELAY (the empty turn
 *   completes, as it did before the guard existed), not as a stated failure — the alternative would
 *   make `0` a louder setting than `emptyCompletionRetry: false`, which no operator asks for.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runTurnWebSearchLoop } from "../../src/web-search/run-turn-loop";
import type { SidecarPlan } from "../../src/web-search";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { RequestLogContext } from "../../src/server/request-log";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import {
  DEFAULT_EMPTY_COMPLETION_RETRY_MAX,
  EMPTY_COMPLETION_RETRY_MAX_ENV,
  EMPTY_COMPLETION_RETRY_MAX_LIMIT,
  emptyCompletionRetryMax,
} from "../../src/lib/empty-completion-budget";

const actualResolver = await import("../../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;

let attemptEvents: AdapterEvent[][] = [];
let httpCalls = 0;
let runTurnCalls = 0;
let builtBodies: string[] = [];
let releaseSpendHome: (() => void) | undefined;

// A reasoning-only turn is the canonical empty shape (see isContentEvent); an answered turn is
// what a replay must eventually produce.
const EMPTY_TURN = (tag: string): AdapterEvent[] => [
  { type: "reasoning_raw_delta", text: tag },
  { type: "done", usage: { inputTokens: 100, outputTokens: 2, totalTokens: 102 } },
];
const ANSWERED_TURN = (tag: string): AdapterEvent[] => [
  { type: "text_delta", text: tag, phase: "final_answer" },
  { type: "done", endTurn: true, usage: { inputTokens: 100, outputTokens: 8, totalTokens: 108 } },
];

function takeSpendHome(): void {
  releaseSpendHome ??= acquireOwnedSpendHome();
}

function attemptAt(index: number): AdapterEvent[] {
  return attemptEvents[index] ?? [{ type: "error", message: "missing fixture attempt " + index }];
}

function fixtureAdapter(provider: OcxProviderConfig): ProviderAdapter {
  const isRunTurn = provider.adapter === "test-run-turn";
  return {
    name: isRunTurn ? "test-run-turn" : "openai-chat",
    buildRequest(parsed) {
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
    ...(isRunTurn ? {
      async runTurn(_parsed: OcxParsedRequest, incoming: unknown, emit: (event: AdapterEvent) => void) {
        await (incoming as { providerFetch: typeof fetch }).providerFetch(provider.baseUrl, { method: "POST" });
        for (const event of attemptAt(runTurnCalls)) emit(event);
        runTurnCalls += 1;
      },
    } : {}),
  };
}

mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter === "test-http" || provider.adapter === "test-run-turn") return fixtureAdapter(provider);
    return actualResolveAdapter(provider, cacheRetention);
  },
}));

const { handleResponses } = await import("../../src/server/responses");

function config(extra: Partial<OcxConfig> = {}, adapter: "test-http" | "test-run-turn" = "test-http"): OcxConfig {
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
    // The physical-send counter is owned by the transport: the http path counts here, the
    // runTurn path counts once per runTurn invocation (below). Counting in both would double the
    // runTurn figure and make the budget assertion meaningless.
    const index = adapter === "test-run-turn" ? runTurnCalls : httpCalls;
    if (adapter !== "test-run-turn") httpCalls += 1;
    return new Response("", { headers: { "x-fixture-attempt": String(index) } });
  };
  return result;
}

function request(stream: boolean): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": "budget-thread" },
    body: JSON.stringify({
      model: "fixture/model",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "keep going" }] }],
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

async function deliver(cfg: OcxConfig, stream = true): Promise<Frame[]> {
  takeSpendHome();
  const response = await handleResponses(request(stream), cfg, emptyLogCtx());
  if (!response.body) throw new Error("fixture returned no body");
  return await frames(response.body);
}

const count = (frames: Frame[], event: string) => frames.filter(frame => frame.event === event).length;

beforeEach(() => {
  attemptEvents = [];
  httpCalls = 0;
  runTurnCalls = 0;
  builtBodies = [];
  delete process.env[EMPTY_COMPLETION_RETRY_MAX_ENV];
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  delete process.env[EMPTY_COMPLETION_RETRY_MAX_ENV];
});

describe("emptyCompletionRetryMax resolver", () => {
  test("absent config keeps the single historical replay", () => {
    expect(DEFAULT_EMPTY_COMPLETION_RETRY_MAX).toBe(1);
    expect(emptyCompletionRetryMax({})).toBe(1);
  });

  test("the environment may raise as well as lower the budget, and clamps to the ceiling", () => {
    expect(emptyCompletionRetryMax({}, { [EMPTY_COMPLETION_RETRY_MAX_ENV]: "2" })).toBe(2);
    expect(emptyCompletionRetryMax({}, { [EMPTY_COMPLETION_RETRY_MAX_ENV]: "0" })).toBe(0);
    expect(emptyCompletionRetryMax({}, { [EMPTY_COMPLETION_RETRY_MAX_ENV]: "99" })).toBe(EMPTY_COMPLETION_RETRY_MAX_LIMIT);
    // A negative or fractional hand value resolves inside the accepted range, never off-by-anything.
    expect(emptyCompletionRetryMax({}, { [EMPTY_COMPLETION_RETRY_MAX_ENV]: "-1" })).toBe(0);
    expect(emptyCompletionRetryMax({}, { [EMPTY_COMPLETION_RETRY_MAX_ENV]: "1.9" })).toBe(1);
    // Unparseable env must not silently disable a guard the operator turned on.
    expect(emptyCompletionRetryMax({ emptyCompletionRetryMax: 2 }, { [EMPTY_COMPLETION_RETRY_MAX_ENV]: "many" })).toBe(1);
    expect(emptyCompletionRetryMax({ emptyCompletionRetryMax: 2 }, { [EMPTY_COMPLETION_RETRY_MAX_ENV]: "" })).toBe(2);
  });

  test("config wins over nothing and the environment wins over config", () => {
    expect(emptyCompletionRetryMax({ emptyCompletionRetryMax: 3 })).toBe(3);
    expect(emptyCompletionRetryMax({ emptyCompletionRetryMax: 3 }, { [EMPTY_COMPLETION_RETRY_MAX_ENV]: "1" })).toBe(1);
    // A hand edit outside the range clamps at read time rather than poisoning the value.
    expect(emptyCompletionRetryMax({ emptyCompletionRetryMax: 50 })).toBe(EMPTY_COMPLETION_RETRY_MAX_LIMIT);
    expect(emptyCompletionRetryMax({ emptyCompletionRetryMax: -4 })).toBe(0);
    expect(emptyCompletionRetryMax({ emptyCompletionRetryMax: "2" as unknown as number })).toBe(1);
  });
});

describe("emptyCompletionRetryMax through the Responses pipeline (adapter delivery)", () => {
  test("the default replays exactly once, byte-identically to the pre-budget guard", async () => {
    attemptEvents = [EMPTY_TURN("first"), EMPTY_TURN("first retry"), ANSWERED_TURN("never reached")];
    const collected = await deliver(config());

    // One send plus exactly one replay; the third scripted answer is never asked for.
    expect(httpCalls).toBe(2);
    expect(builtBodies).toHaveLength(1);
    expect(count(collected, "response.failed")).toBe(1);
    expect(JSON.stringify(collected)).toContain("empty_completion_retry_failed");
  });

  // One fixture, two budgets — the pair is what makes the number observable. Both replays being
  // empty and only the THIRD attempt answering means a request that spends two replays completes
  // while a request allowed one fails. If any caller point dropped the budget back to the default,
  // the "wide" case would regress to the narrow verdict and these two tests could not both pass.
  const NEEDS_TWO_REPLAYS: AdapterEvent[][] = [EMPTY_TURN("attempt 1"), EMPTY_TURN("attempt 2"), ANSWERED_TURN("at last")];

  test("a budget of 2 spends two replays and recovers the turn that budget 1 would have failed", async () => {
    attemptEvents = NEEDS_TWO_REPLAYS;
    const logCtx = emptyLogCtx();
    takeSpendHome();
    const response = await handleResponses(request(true), config({ emptyCompletionRetryMax: 2 }), logCtx);
    const collected = await frames(response.body!);

    // The whole-turn replay count is the assertion: 1 original + 2 replays = 3 physical sends.
    expect(httpCalls).toBe(3);
    // Every replay re-issued the identical bytes, so buildRequest ran once and the history never drifted.
    expect(builtBodies).toHaveLength(1);
    expect(logCtx.activeAttempt?.sendCount).toBe(3);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["empty-completion"]);
    expect(count(collected, "response.failed")).toBe(0);
    expect(count(collected, "response.completed")).toBe(1);
    expect(JSON.stringify(collected)).toContain("at last");
  });

  test("the SAME fixture fails after a single replay at the default budget — proving the budget drives the count", async () => {
    attemptEvents = NEEDS_TWO_REPLAYS;
    const collected = await deliver(config());

    expect(httpCalls).toBe(2);
    expect(count(collected, "response.failed")).toBe(1);
    expect(count(collected, "response.completed")).toBe(0);
    expect(JSON.stringify(collected)).not.toContain("at last");
  });

  test("a budget of 2 is SPENT when every replay is empty: it fails after three sends, never four", async () => {
    attemptEvents = [EMPTY_TURN("a"), EMPTY_TURN("b"), EMPTY_TURN("c")];
    const collected = await deliver(config({ emptyCompletionRetryMax: 2 }));

    expect(httpCalls).toBe(3);
    expect(count(collected, "response.failed")).toBe(1);
    expect(count(collected, "response.completed")).toBe(0);
  });

  test("the ceiling is real: asking for more than the limit cannot buy more billable replays", async () => {
    attemptEvents = Array.from({ length: 8 }, (_, i) => EMPTY_TURN("attempt " + i));
    const cfg = config({ emptyCompletionRetryMax: 99 });
    const collected = await deliver(cfg);

    // 99 clamps to the limit, so the turn costs limit+1 sends and no more.
    expect(httpCalls).toBe(EMPTY_COMPLETION_RETRY_MAX_LIMIT + 1);
    expect(count(collected, "response.failed")).toBe(1);
  });

  test("the environment override reaches the pipeline, not just the resolver", async () => {
    attemptEvents = [EMPTY_TURN("a"), EMPTY_TURN("b"), ANSWERED_TURN("env third time")];
    process.env[EMPTY_COMPLETION_RETRY_MAX_ENV] = "2";
    const collected = await deliver(config());

    expect(httpCalls).toBe(3);
    expect(JSON.stringify(collected)).toContain("env third time");
  });

  test("a budget of 0 relays the empty turn exactly like the switch being off", async () => {
    attemptEvents = [EMPTY_TURN("silent"), ANSWERED_TURN("must not be asked")];
    const collected = await deliver(config({ emptyCompletionRetryMax: 0 }));

    // Same observable outcome as emptyCompletionRetry: false — one send, a completed turn, no failure.
    expect(httpCalls).toBe(1);
    expect(count(collected, "response.completed")).toBe(1);
    expect(count(collected, "response.failed")).toBe(0);
  });

  test("a budget of 0 is not a stated failure, so it cannot be louder than turning the switch off", async () => {
    attemptEvents = [EMPTY_TURN("silent"), EMPTY_TURN("unused")];
    const zero = await deliver(config({ emptyCompletionRetryMax: 0 }));
    const off = await deliver(config({ emptyCompletionRetry: false }));

    expect(httpCalls).toBe(2); // one send each
    expect(zero.map(f => f.event)).toEqual(off.map(f => f.event));
  });

  test("the budget is per request: two turns each spend their own two replays", async () => {
    attemptEvents = [
      EMPTY_TURN("t1a"), EMPTY_TURN("t1b"), ANSWERED_TURN("t1 answer"),
      EMPTY_TURN("t2a"), EMPTY_TURN("t2b"), ANSWERED_TURN("t2 answer"),
    ];
    const cfg = config({ emptyCompletionRetryMax: 2 });

    const first = await deliver(cfg);
    const second = await deliver(cfg);

    expect(httpCalls).toBe(6);
    expect(builtBodies).toHaveLength(2);
    expect(JSON.stringify(first)).toContain("t1 answer");
    expect(JSON.stringify(second)).toContain("t2 answer");
  });

  test("the runTurn transport honours the same budget (its own caller point)", async () => {
    // The run-turn branch wraps the guard at a SEPARATE site from adapter delivery, so a budget
    // forwarded only to the adapter path would leave this transport silently at one replay.
    attemptEvents = [EMPTY_TURN("r1"), EMPTY_TURN("r2"), ANSWERED_TURN("runTurn at last")];
    const cfg = config({ emptyCompletionRetryMax: 2 }, "test-run-turn");
    takeSpendHome();
    const response = await handleResponses(request(true), cfg, emptyLogCtx());
    const collected = await frames(response.body!);

    expect(runTurnCalls).toBe(3);
    expect(JSON.stringify(collected)).toContain("runTurn at last");
    expect(count(collected, "response.failed")).toBe(0);
  });

  test("the web-search loop's inner wrap honours the same budget (its own caller point)", async () => {
    // runTurnWebSearchLoop runs the guard a third time, inside the search iteration, and is
    // reached only when a plan owns the turn. It takes the budget through its deps rather than
    // through the guard call in run-turn-execution, so it needs its own proof.
    const loopParsed: OcxParsedRequest = {
      modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [] },
    };
    const loopPlan: SidecarPlan = {
      backend: "exa", hostedTool: { type: "web_search" }, maxSearches: 3,
      settings: { model: "fixture", reasoning: "low", timeoutMs: 100 },
      routedModelStallTimeoutMs: 100, stallTimeoutSec: 1, streamRoutedModelOutput: false,
    };
    const loopDone: AdapterEvent = { type: "done" };
    async function* loopStream(events: AdapterEvent[]) { yield* events; }
    async function collectLoop(source: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
      const result: AdapterEvent[] = [];
      for await (const e of source) result.push(e);
      return result.filter(e => e.type !== "heartbeat");
    }
    const attempts: OcxParsedRequest[] = [];
    const out = await collectLoop(runTurnWebSearchLoop(loopStream([loopDone]), {
      parsed: loopParsed,
      plan: loopPlan,
      emptyCompletionRetry: true,
      emptyCompletionRetryMax: 2,
      dispatch: request => { attempts.push(request); return loopStream([loopDone]); },
    }));

    // Two replays spent, then the stated failure — one dispatch per replay.
    expect(attempts).toHaveLength(2);
    expect(out.at(-1)).toMatchObject({ type: "error", code: "empty_completion_retry_failed" });
  });

  test("the non-streaming delivery honours the same budget", async () => {
    attemptEvents = [EMPTY_TURN("a"), EMPTY_TURN("b"), ANSWERED_TURN("buffered at last")];
    takeSpendHome();
    const response = await handleResponses(request(false), config({ emptyCompletionRetryMax: 2 }), emptyLogCtx());
    const json = await response.json() as { status?: string; output?: unknown };

    expect(httpCalls).toBe(3);
    expect(json.status).toBe("completed");
    expect(JSON.stringify(json.output)).toContain("buffered at last");
  });
});
