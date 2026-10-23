import { afterEach, describe, expect, test } from "bun:test";
import {
  cursorRetryDelayMs,
  cursorTurnSendCap,
  isCursorModelHttpError,
  isRetryableCursorError,
  runCursorTurnWithRetry,
} from "../../../src/adapters/cursor/transport-retry";
import type { CursorTransport } from "../../../src/adapters/cursor/transport";
import type { CursorRunRequest, CursorServerMessage } from "../../../src/adapters/cursor/types";
import { createRequestExecutionBudget, type RequestExecutionBudgetPolicy } from "../../../src/lib/request-execution-budget";
import { CursorRootEnvelopeLimitError } from "../../../src/adapters/cursor/cursor-errors";
import { SendBudgetExhaustedError } from "../../../src/lib/upstream-retry";

/**
 * The unified model-request contract on Cursor's whole-turn replay ladder (2026-10-23):
 * a real upstream HTTP 4xx/5xx is an authoritative refusal receipt, so the replay is allowed
 * even when the transport says the request was committed (the RunSSE registration never
 * happened on a non-200), the loop cap is the request budget's EXACT policy total (never a
 * fresh 11 for a spent request), and the emitted-output gate keeps its bite: a turn that has
 * already streamed text is never replayed.
 */
const realEnv = process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
afterEach(() => {
  if (realEnv === undefined) delete process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
  else process.env.OCX_MODEL_REQUEST_MAX_RETRIES = realEnv;
});

const request = {} as CursorRunRequest;

function policyOf(sends: number): RequestExecutionBudgetPolicy {
  return {
    maxTotalModelSends: sends,
    baseSendAllowance: sends,
    finalRecoveryAllowance: 0,
    maxAlternateTargetSends: 0,
    maxTargetTransitions: 0,
  };
}

function httpStatusTransport(status: number, opts: { committed?: boolean; events?: CursorServerMessage[] } = {}): () => CursorTransport {
  let calls = 0;
  const make = () => {
    calls++;
    return {
      async *run() {
        for (const event of opts.events ?? []) yield event;
        throw new Error(`Cursor HTTP/1.1 RunSSE failed with HTTP ${status}`);
      },
      writeClient() {},
      close() {},
      requestCommitted: () => opts.committed ?? true,
    } as CursorTransport;
  };
  (make as { calls(): number }).calls = () => calls;
  return make as typeof make & { calls(): number };
}

describe("cursorTurnSendCap", () => {
  test("a budget with policy 0 is a hard refusal, not a fallback to 11", () => {
    expect(cursorTurnSendCap({ sendBudget: createRequestExecutionBudget(policyOf(0)) })).toBe(0);
  });
  test("a guarded legacy budget of 3 keeps its shape", () => {
    expect(cursorTurnSendCap({ sendBudget: createRequestExecutionBudget(policyOf(3)) })).toBe(3);
  });
  test("context-free falls to the unified leaf (env over default)", () => {
    // 用户真实 env 是 process.env；CursorTurnExecutionOptions 没有 env 字段，旧写法
    // { env: {...} } 会被静默忽略（读成默认 11）。fixture 直接落 process.env。
    delete process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
    expect(cursorTurnSendCap({})).toBe(11);
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "12";
    expect(cursorTurnSendCap({})).toBe(13);
    delete process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
  });
});

describe("runCursorTurnWithRetry unified HTTP lane", () => {
  test("a committed transport refusing with HTTP 503 replays to the unified budget", async () => {
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "10";
    const make = httpStatusTransport(503, { committed: true });
    const events: CursorServerMessage[] = [];
    await expect(runCursorTurnWithRetry(
      make, { provider: { adapter: "cursor" } } as never, request, undefined,
      message => events.push(message), { env: {} },
    )).rejects.toThrow("HTTP 503");
    expect(make.calls()).toBe(11);
    expect(events).toEqual([]);
  });

  test("HTTP 429 quota and 403 policy refusals are retried, not one-shotted by the text heuristics", async () => {
    for (const status of [403, 429, 400]) {
      const make = httpStatusTransport(status, { committed: true });
      await expect(runCursorTurnWithRetry(
        make, { provider: { adapter: "cursor" } } as never, request, undefined,
        () => {}, { env: {}, sendBudget: createRequestExecutionBudget(policyOf(5)) },
      )).rejects.toThrow(`HTTP ${status}`);
      expect(make.calls()).toBe(5);
    }
  });

  test("a 9th-attempt success settles the turn with events intact", async () => {
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "10";
    let calls = 0;
    const events: CursorServerMessage[] = [];
    await runCursorTurnWithRetry(
      () => {
        calls++;
        if (calls <= 8) return httpStatusTransport(502, { committed: true })();
        return {
          async *run() { yield { type: "text", text: "late ok" } as CursorServerMessage; },
          writeClient() {}, close() {}, requestCommitted: () => true,
        } as CursorTransport;
      },
      { provider: { adapter: "cursor" } } as never, request, undefined,
      message => events.push(message), { env: {} },
    );
    expect(calls).toBe(9);
    expect(events).toEqual([{ type: "text", text: "late ok" }]);
  });

  test("an emitted text delta stops whole-turn replay on the next failure (no duplicate turn)", async () => {
    const make = httpStatusTransport(503, { committed: true, events: [{ type: "text", text: "partial" }] });
    const events: CursorServerMessage[] = [];
    await expect(runCursorTurnWithRetry(
      make, { provider: { adapter: "cursor" } } as never, request, undefined,
      message => events.push(message), { env: {} },
    )).rejects.toThrow("HTTP 503");
    expect(make.calls()).toBe(1);
    expect(events).toEqual([{ type: "text", text: "partial" }]);
  });

  test("a shared budget refuses the replay it cannot pay for and reports the withheld recovery", async () => {
    const budget = createRequestExecutionBudget(policyOf(2), "lr-cursor-model-retry");
    const make = httpStatusTransport(503, { committed: true });
    let withheld = 0;
    await expect(runCursorTurnWithRetry(
      make, { provider: { adapter: "cursor" } } as never, request, undefined,
      () => {}, { sendBudget: budget, onRecoveryWithheld: () => { withheld++; } },
    )).rejects.toThrow("HTTP 503");
    expect(make.calls()).toBe(2);
    expect(budget.used).toBe(2);
    expect(withheld).toBe(1);
  });

  test("policy 0 refuses the turn before a transport is built", async () => {
    const budget = createRequestExecutionBudget(policyOf(0), "lr-cursor-spent");
    let calls = 0;
    await expect(runCursorTurnWithRetry(
      () => { calls++; return httpStatusTransport(503)(); },
      { provider: { adapter: "cursor" } } as never, request, undefined,
      () => {}, { sendBudget: budget },
    )).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(calls).toBe(0);
  });

  test("a connection reset (no HTTP receipt) stays non-replayable once the transport committed", async () => {
    // The reset shape: transport throws a raw ECONNRESET with no HTTP receipt.
    const resetMake = () => {
      return {
        async *run() {
          throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        },
        writeClient() {}, close() {}, requestCommitted: () => true,
      } as CursorTransport;
    };
    await expect(runCursorTurnWithRetry(
      resetMake, { provider: { adapter: "cursor" } } as never, request, undefined,
      () => {}, { env: {} },
    )).rejects.toThrow("ECONNRESET");
  });

  test("the local root-envelope refusal (status 400) is never treated as an upstream receipt", async () => {
    const envelope = new CursorRootEnvelopeLimitError(10, 20, 5, 10);
    expect(isCursorModelHttpError(envelope)).toBe(false);
    expect(isRetryableCursorError(envelope)).toBe(false);
    let calls = 0;
    await expect(runCursorTurnWithRetry(
      () => {
        calls++;
        return {
          async *run() { throw envelope; },
          writeClient() {}, close() {}, requestCommitted: () => true,
        } as CursorTransport;
      },
      { provider: { adapter: "cursor" } } as never, request, undefined,
      () => {}, { env: {} },
    )).rejects.toBeInstanceOf(CursorRootEnvelopeLimitError);
    expect(calls).toBe(1);
  });
  test("the transient network lane keeps its old three attempts, not the unified eleven", async () => {
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "10";
    let calls = 0;
    await expect(runCursorTurnWithRetry(
      () => {
        calls++;
        return {
          async *run() {
            throw Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" });
          },
          writeClient() {}, close() {}, requestCommitted: () => false,
        } as CursorTransport;
      },
      { provider: { adapter: "cursor" } } as never, request, undefined,
      () => {}, { env: {} },
    )).rejects.toThrow("ECONNREFUSED");
    expect(calls).toBe(3);
  });

  test("a named Retry-After raises the model-lane backoff to its full lower bound", () => {
    const instructed = new Error("Cursor HTTP/1.1 RunSSE failed with HTTP 429: retry in 90 seconds");
    expect(cursorRetryDelayMs(0, instructed)).toBeGreaterThanOrEqual(90_000);
    // A receipt-less failure keeps the plain exponential ladder (capped at 2s + jitter).
    expect(cursorRetryDelayMs(0, new Error("connect ECONNREFUSED"))).toBeLessThanOrEqual(2_400);
  });
});
