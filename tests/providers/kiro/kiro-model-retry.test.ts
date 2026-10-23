import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterRequest } from "../../../src/adapters/base";
import { fetchKiroWithRetry, resetKiroThrottleStateForTests } from "../../../src/adapters/kiro-retry";
import { createRequestExecutionBudget, type RequestExecutionBudgetPolicy } from "../../../src/lib/request-execution-budget";
import { SendBudgetExhaustedError } from "../../../src/lib/upstream-retry";

/**
 * Kiro's ladder is three nested loops (unified HTTP lane, throttle loop, reset ladder). The
 * unified contract (2026-10-23, amended) says every real upstream 4xx/5xx retries to the
 * configured budget (default 3 retries = 4 sends per logical request, range 0..5), and the
 * #4546 rule says the loops must share ONE ledger rather than multiply. These tests pin the
 * intersection from both sides: a 4-send budget buys four sends (the old 3 cap is gone), and
 * a 4 budget never reaches twelve.
 */
const realEnv = process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetKiroThrottleStateForTests();
  if (realEnv === undefined) delete process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
  else process.env.OCX_MODEL_REQUEST_MAX_RETRIES = realEnv;
});

function policyOf(sends: number): RequestExecutionBudgetPolicy {
  return {
    maxTotalModelSends: sends,
    baseSendAllowance: sends,
    finalRecoveryAllowance: 0,
    maxAlternateTargetSends: 1,
    maxTargetTransitions: 1,
  };
}

const request: AdapterRequest = {
  url: "https://runtime.us-east-1.kiro.dev/",
  method: "POST",
  headers: { authorization: "Bearer fixture" },
  body: "{}",
};

describe("Kiro unified HTTP lane", () => {
  test("a persistent 503 string is retried to the unified budget, not to 3", async () => {
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "3";
    let sends = 0;
    const ordinals: number[] = [];
    const executor = (async () => {
      sends++;
      return new Response("opaque", { status: 503 });
    }) as typeof fetch;
    const result = await fetchKiroWithRetry({ ...request }, {
      executor,
      timeoutMs: 5_000,
      modelRetryBaseDelayMs: 0,
      modelRetryMaxDelayMs: 0,
      allowGatewayRotation: false,
      onPhysicalSend: send => ordinals.push(send.ordinal),
    });
    expect(result.status).toBe(503);
    expect(sends).toBe(4);
    expect(ordinals).toEqual(Array.from({ length: 4 }, (_unused, index) => index + 1));
  });

  test("a 429 quota refusal keeps retrying within the ledger and ends on the real upstream answer", async () => {
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "3";
    let sends = 0;
    const executor = (async () => {
      sends++;
      return new Response(JSON.stringify({ message: "insufficient_quota" }), { status: 429 });
    }) as typeof fetch;
    const result = await fetchKiroWithRetry({ ...request }, {
      executor,
      timeoutMs: 5_000,
      modelRetryBaseDelayMs: 0,
      modelRetryMaxDelayMs: 0,
      allowGatewayRotation: false,
      returnRawErrors: true,
    });
    expect(result.status).toBe(429);
    expect(sends).toBe(4);
  });

  test("a budget of 4 intersects every nested loop: Kiro makes 4 sends, not 12", async () => {
    const budget = createRequestExecutionBudget(policyOf(4), "lr-kiro-intersection");
    let sends = 0;
    const executor = (async () => {
      sends++;
      return new Response("opaque", { status: 503 });
    }) as typeof fetch;
    const result = await fetchKiroWithRetry({ ...request }, {
      executor,
      timeoutMs: 5_000,
      modelRetryBaseDelayMs: 0,
      modelRetryMaxDelayMs: 0,
      allowGatewayRotation: false,
      returnRawErrors: true,
      sendBudget: budget,
    });
    expect(result.status).toBe(503);
    expect(sends).toBe(4);
    expect(budget.used).toBe(4);
  });

  test("a fully spent budget refuses the very first send", async () => {
    const budget = createRequestExecutionBudget(policyOf(1), "lr-kiro-spent");
    budget.used = 1;
    let sends = 0;
    const executor = (async () => {
      sends++;
      return new Response("opaque", { status: 503 });
    }) as typeof fetch;
    await expect(fetchKiroWithRetry({ ...request }, {
      executor,
      timeoutMs: 5_000,
      modelRetryBaseDelayMs: 0,
      modelRetryMaxDelayMs: 0,
      allowGatewayRotation: false,
      sendBudget: budget,
    })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(sends).toBe(0);
  });

  test("a success on the third try settles the ladder and the body arrives intact", async () => {
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "3";
    let sends = 0;
    const executor = (async () => {
      sends++;
      return sends <= 2 ? new Response("opaque", { status: 502 }) : new Response("kiro-ok", { status: 200 });
    }) as typeof fetch;
    const result = await fetchKiroWithRetry({ ...request }, { executor, timeoutMs: 5_000,
      modelRetryBaseDelayMs: 0,
      modelRetryMaxDelayMs: 0, returnRawErrors: true });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("kiro-ok");
    expect(sends).toBe(3);
  });

  test("a caller abort during backoff rejects with AbortError at one send; pre-abort rejects with 0 sends", async () => {
    // root 裁决（统一 helper 语义）：abort 抛出 AbortError，不假交还 pending 结果。
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "3";
    const ac = new AbortController();
    let sends = 0;
    const executor = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      sends++;
      if (sends === 1) ac.abort(new DOMException("caller", "AbortError"));
      return new Response("quota-body", { status: 429 });
    }) as typeof fetch;
    await expect(fetchKiroWithRetry({ ...request }, {
      executor,
      timeoutMs: 5_000,
      modelRetryBaseDelayMs: 0,
      modelRetryMaxDelayMs: 0,
      allowGatewayRotation: false,
      returnRawErrors: true,
      abortSignal: ac.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    // The abort lands before the backoff sleep: the lane stops at one send.
    expect(sends).toBe(1);

    const closed = new AbortController();
    closed.abort(new DOMException("caller closed", "AbortError"));
    let secondSends = 0;
    await expect(fetchKiroWithRetry({ ...request }, {
      executor: (async () => { secondSends++; return new Response("x", { status: 503 }); }) as typeof fetch,
      timeoutMs: 5_000,
      abortSignal: closed.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(secondSends).toBe(0);
  });
});
