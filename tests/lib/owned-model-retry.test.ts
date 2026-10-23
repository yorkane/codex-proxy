import { afterEach, describe, expect, test } from "bun:test";
import {
  ownedModelSendTotal,
  ownedModelSendsRemaining,
  runOwnedModelHttpRetry,
  upstreamHttpErrorStatus,
  upstreamRetryAfterFromError,
} from "../../src/lib/owned-model-retry";
import { createRequestExecutionBudget, type RequestExecutionBudgetPolicy } from "../../src/lib/request-execution-budget";
import { SendBudgetExhaustedError, markResponseNonReplayable } from "../../src/lib/upstream-retry";
import {
  DEFAULT_MODEL_REQUEST_MAX_RETRIES,
  MODEL_REQUEST_MAX_RETRIES_LIMIT,
} from "../../src/lib/model-request-retry";
import { markAccountAutoPaused, markPermanentAccountRefusal, wasAccountAutoPaused, wasPermanentAccountRefusal } from "../../src/lib/account-auto-pause-response";

function policyOf(sends: number): RequestExecutionBudgetPolicy {
  return {
    maxTotalModelSends: sends,
    baseSendAllowance: sends,
    finalRecoveryAllowance: 0,
    maxAlternateTargetSends: 0,
    maxTargetTransitions: 0,
  };
}

const realEnv = process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
afterEach(() => {
  if (realEnv === undefined) delete process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
  else process.env.OCX_MODEL_REQUEST_MAX_RETRIES = realEnv;
});

describe("ownedModelSendTotal: exact policy authority, no fallback", () => {
  test("policy 0 is a hard refusal, never a fallback to the unified default", () => {
    expect(ownedModelSendTotal({ sendBudget: createRequestExecutionBudget(policyOf(0)) })).toBe(0);
  });
  test("policy 3 is honored exactly (guarded legacy budgets keep their shape)", () => {
    expect(ownedModelSendTotal({ sendBudget: createRequestExecutionBudget(policyOf(3)) })).toBe(3);
  });
  test("context-free falls to the unified leaf default; env above the range clamps to the ceiling", () => {
    delete process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
    expect(ownedModelSendTotal({})).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
    // 2026-10-23 改约：接受范围 0..5，旧默认 env 10 越界钳到 5 → 6 送。
    expect(ownedModelSendTotal({ env: { OCX_MODEL_REQUEST_MAX_RETRIES: "10" } })).toBe(MODEL_REQUEST_MAX_RETRIES_LIMIT + 1);
  });
});

describe("runOwnedModelHttpRetry", () => {
  test("budget 0 refuses before any send", async () => {
    let calls = 0;
    await expect(runOwnedModelHttpRetry(async () => {
      calls++;
      return new Response("ok");
    }, { sendBudget: createRequestExecutionBudget(policyOf(0)) })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(calls).toBe(0);
  });

  test("context-free loop is bounded by the leaf default and never spins", async () => {
    delete process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
    let calls = 0;
    const final = await runOwnedModelHttpRetry(async () => {
      calls++;
      return new Response("quota", { status: 429 });
    }, { baseDelayMs: 0, maxDelayMs: 0, env: {} });
    expect(final.status).toBe(429);
    expect(calls).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
  });

  test("shared ledger shrinks the loop across legs (one ledger, no multiplication)", async () => {
    let calls = 0;
    const budget = createRequestExecutionBudget(policyOf(4));
    // A recovery leg outside the scope already spent two sends.
    const first = await runOwnedModelHttpRetry(async () => {
      calls++;
      // The adapter closure charges the shared ledger like reserveDispatch does.
      budget.used = calls;
      return new Response("busy", { status: 503 });
    }, { sendBudget: budget, baseDelayMs: 0, maxDelayMs: 0 });
    expect(first.status).toBe(503);
    expect(calls).toBe(4);
    expect(budget.used).toBe(4);
    calls = 0;
    // A second call on the same exhausted ledger sends nothing.
    await expect(runOwnedModelHttpRetry(async () => {
      calls++;
      return new Response("busy", { status: 503 });
    }, { sendBudget: budget, baseDelayMs: 0, maxDelayMs: 0 })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(calls).toBe(0);
  });

  test("a closure that admits each physical send spends the unified budget exactly, never over", async () => {
    // root 裁决 2026-10-23：入口门语义是「剩余 ≤0 才不发」，轮内多发的准入是**闭包自己**
    // 的契约（生产里 Kiro reset ladder 每 attempt 查 remaining、经 reserveDispatch 准入）。
    // 闭包必须逐发准入而不是黑盒批量：这里用真正逐发准入的闭包钉住共享账本。统一默认
    // 预算（3 重试 + 首发 = 4 送）下：第一轮准入 min(3, 4) = 3 送，第二轮账本只剩 1 只
    // 准入 1 送，第三轮入口剩 0 结算——总发送恰等于权威预算，一次不多，恢复被 withheld 一次。
    delete process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
    let sends = 0;
    let withheld = 0;
    const final = await runOwnedModelHttpRetry(async () => {
      const roundCap = Math.min(3, ownedModelSendsRemaining({ physicalSends: () => sends, env: {} }));
      for (let index = 0; index < roundCap; index++) sends += 1;
      return new Response("busy", { status: 503 });
    }, {
      physicalSends: () => sends,
      baseDelayMs: 0,
      maxDelayMs: 0,
      env: {},
      onRecoveryWithheld: () => { withheld++; },
    });
    expect(final.status).toBe(503);
    expect(sends).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
    expect(withheld).toBe(1);
  });

  test("an explicitly spent ledger (used == cap) buys zero sends", async () => {
    let calls = 0;
    let withheld = 0;
    const budget = createRequestExecutionBudget(policyOf(3));
    budget.used = 3;
    await expect(runOwnedModelHttpRetry(async () => {
      calls++;
      return new Response("busy", { status: 503 });
    }, { sendBudget: budget, baseDelayMs: 0, maxDelayMs: 0, onRecoveryWithheld: () => { withheld++; } }))
      .rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(calls).toBe(0);
    expect(withheld).toBe(1);
  });

  test("400/403/429-quota/5xx all retry; 200 settles; non-HTTP transport errors propagate", async () => {
    for (const status of [400, 403, 429, 500]) {
      let calls = 0;
      const final = await runOwnedModelHttpRetry(async () => {
        calls++;
        return new Response("x", { status });
      }, { baseDelayMs: 0, maxDelayMs: 0, env: {}, sendBudget: createRequestExecutionBudget(policyOf(3)) });
      expect(final.status).toBe(status);
      expect(calls).toBe(3);
    }
    let calls = 0;
    await expect(runOwnedModelHttpRetry(async () => {
      calls++;
      throw Object.assign(new Error("socket connection was closed unexpectedly"), { code: "ECONNRESET" });
    }, { env: {} })).rejects.toThrow(/ECONNRESET|socket/);
    expect(calls).toBe(1);
  });

  test("an ambiguous non-replayable response settles at once", async () => {
    let calls = 0;
    const response = new Response("mid-stream failure", { status: 502 });
    markResponseNonReplayable(response);
    const final = await runOwnedModelHttpRetry(async () => {
      calls++;
      return response;
    }, { env: {} });
    expect(final).toBe(response);
    expect(calls).toBe(1);
  });

  test("a failure marker never rides on a later success", async () => {
    let calls = 0;
    const final = await runOwnedModelHttpRetry(async () => {
      calls++;
      if (calls === 1) {
        const refused = new Response("quota", { status: 402 });
        markAccountAutoPaused(refused);
        markPermanentAccountRefusal(refused);
        return refused;
      }
      return new Response("ok", { status: 200 });
    }, { env: {} });
    expect(final.status).toBe(200);
    expect(calls).toBe(2);
    expect(await final.text()).toBe("ok");
    expect(wasAccountAutoPaused(final)).toBe(false);
    expect(wasPermanentAccountRefusal(final)).toBe(false);
  });

  test("caller abort during backoff rejects with AbortError; the lane stops at one send", async () => {
    // root 裁决（统一 helper 语义）：caller abort 抛出，不假交还 pending 结果。
    const ac = new AbortController();
    let calls = 0;
    const pending = runOwnedModelHttpRetry(async () => {
      calls++;
      return new Response("quota-body", { status: 429, headers: { "Retry-After": "2" } });
    }, { signal: ac.signal, env: {}, baseDelayMs: 50, maxDelayMs: 50 });
    const timer = setTimeout(() => ac.abort(new DOMException("caller", "AbortError")), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    clearTimeout(timer);
    expect(calls).toBe(1);
  });

  test("Retry-After is read from structured fields before message text", () => {
    expect(upstreamRetryAfterFromError(Object.assign(new Error("HTTP 429 too many"), { retryAfterMs: 90_000 }))).toBe(90_000);
    expect(upstreamRetryAfterFromError(
      Object.assign(new Error("HTTP 429 too many"), { headers: new Headers({ "retry-after": "30" }) }),
    )).toBe(30_000);
    expect(upstreamRetryAfterFromError(new Error("Cursor HTTP/1.1 RunSSE failed with HTTP 429: retry in 45 seconds"))).toBe(45_000);
  });

  test("upstreamHttpErrorStatus only reads 400..599 receipts", () => {
    expect(upstreamHttpErrorStatus(new Error("Cursor HTTP/1.1 RunSSE failed with HTTP 503"))).toBe(503);
    expect(upstreamHttpErrorStatus(Object.assign(new Error("zed"), { status: 429 }))).toBe(429);
    expect(upstreamHttpErrorStatus(new Error("connect ECONNREFUSED 1.2.3.4:443"))).toBeUndefined();
    expect(upstreamHttpErrorStatus(Object.assign(new Error("zed"), { status: 302 }))).toBeUndefined();
  });

  test("an inner reserveDispatch exhaustion settles with the last real response", async () => {
    let calls = 0;
    const final = await runOwnedModelHttpRetry(async () => {
      calls++;
      if (calls === 1) return new Response("busy", { status: 503 });
      throw new SendBudgetExhaustedError("inner");
    }, { sendBudget: createRequestExecutionBudget(policyOf(9)), baseDelayMs: 0, maxDelayMs: 0 });
    expect(final.status).toBe(503);
    expect(await final.text()).toBe("busy");
    expect(calls).toBe(2);
  });

  test("onRecoveryWithheld fires once when the unified budget ends the ladder", async () => {
    let withheld = 0;
    const budget = createRequestExecutionBudget(policyOf(2));
    const final = await runOwnedModelHttpRetry(async () => new Response("x", { status: 500 }), {
      sendBudget: budget,
      baseDelayMs: 0,
      maxDelayMs: 0,
      onRecoveryWithheld: () => { withheld++; },
    });
    expect(final.status).toBe(500);
    expect(withheld).toBe(1);
  });

  test("remaining never floors to one", () => {
    const budget = createRequestExecutionBudget(policyOf(2));
    budget.used = 2;
    expect(ownedModelSendsRemaining({ sendBudget: budget })).toBe(0);
  });
});
