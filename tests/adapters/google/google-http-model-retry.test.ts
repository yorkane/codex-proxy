/**
 * Google 家族 owned ladder 在统一模型请求 lane 上的合同（fork 2026-10-23 用户裁决）。
 *
 * 钉五件事：
 * 1. 无 caller 账本时 ladder 上限是统一预算 modelRequestMaxAttempts()（默认 11），任何
 *    4xx/5xx（含 400/401/403/429 quota 耗尽体）都进重放，旧 quota veto 与非重放白名单取消。
 * 2. 有 caller 账本时 ladder 上限 = 账本自己的 policy.maxTotalModelSends——显式 caller cap
 *    是硬上限，统一 floor 只作用在无账本缺省路径；ladder 与请求 ledger 共享（每发送经
 *    createAdapterPhysicalSend reserveDispatch 准入），外层 dispatch 每 leg 只一送，两层
 *    不相乘。
 * 3. Retry-After 是下限：指令 600s 绝不提前发送（用 caller abort 在等待中打断来证明，
 *    不真等 600s）。
 * 4. 400 repair replay 是物理发送：计入 ladder 上限，attempt-- 只回退退避序号。
 * 5. caller abort 立即停，预算拒绝保留真实上游答案（#5044 归因）。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as retry from "../../../src/lib/upstream-retry";
import { createRequestExecutionBudget } from "../../../src/lib/request-execution-budget";
import { MODEL_REQUEST_MAX_RETRIES_ENV, modelRequestMaxAttempts } from "../../../src/lib/model-request-retry";
import type { AdapterRequest } from "../../../src/adapters/base";
import { fetchAntigravityWithRetry, fetchVertexWithRetry } from "../../../src/adapters/google-http";

const realFetch = globalThis.fetch;
beforeEach(() => { delete process.env[MODEL_REQUEST_MAX_RETRIES_ENV]; });
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[MODEL_REQUEST_MAX_RETRIES_ENV];
});

const request: AdapterRequest = {
  url: "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse",
  method: "POST",
  headers: { authorization: "Bearer tok", "content-type": "application/json" },
  body: "{}",
};

function mockFetch(responses: Array<Response | Error>): { calls: number } {
  const state = { calls: 0 };
  let i = 0;
  globalThis.fetch = (async () => {
    state.calls += 1;
    const next = responses[i++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return state;
}

function vertexError(code: number, status: string, message: string): string {
  return JSON.stringify({ error: { code, status, message } });
}

function ok(): Response { return new Response("ok", { status: 200 }); }

describe("google unified model lane", () => {
  test.each([400, 401, 403, 429, 500, 503])(
    "no budget: a plain %i is retried exactly to the unified cap",
    async status => {
      // 统一 ladder 的 11 次发送只钉计数：真实指数退避（400ms 起、5s 封顶）会让整行
      // 花掉 ~30s，超预算。spy 只吃掉后退计时器，发送次数与响应形状断言原样保留。
      const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
      try {
      const mock = mockFetch([new Response(vertexError(status, "ERR", "x"), { status })]);
      const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
      expect(res.status).toBe(status);
      expect(mock.calls).toBe(modelRequestMaxAttempts());
      } finally { waits.mockRestore(); }
    });

  test("quota-exhausted 429 body no longer vetoes the ladder: the recovery is served", async () => {
    const mock = mockFetch([
      new Response(vertexError(429, "RESOURCE_EXHAUSTED", "Quota exceeded for your current billing plan"), { status: 429, headers: { "Retry-After": "0" } }),
      ok(),
    ]);
    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(mock.calls).toBe(2);
  });

  test("the caller budget policy is the hard ceiling, never widened by the floor", async () => {
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 3, baseSendAllowance: 3, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 1, maxTargetTransitions: 1,
    });
    const mock = mockFetch([new Response(vertexError(503, "UNAVAILABLE", "x"), { status: 503 })]);
    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000, sendBudget: budget });
    expect(res.status).toBe(503);
    expect(mock.calls).toBe(3);
    expect(budget.used).toBe(3);
  });

  test("a budgeted ladder grows with the policy total: 13 sends at cap 13", async () => {
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    try {
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 13, baseSendAllowance: 13, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 1, maxTargetTransitions: 1,
    });
    const mock = mockFetch([new Response(vertexError(429, "RESOURCE_EXHAUSTED", "rate limit, try again"), { status: 429, headers: { "Retry-After": "0" } })]);
    await fetchVertexWithRetry(request, { timeoutMs: 5_000, sendBudget: budget });
    expect(mock.calls).toBe(13);
    expect(budget.used).toBe(13);
    } finally { waits.mockRestore(); }
  });

  test("Retry-After 600 is a lower bound: the caller abort in the wait stops every send", async () => {
    const mock = mockFetch([new Response(vertexError(429, "RESOURCE_EXHAUSTED", "rate limit"), { status: 429, headers: { "Retry-After": "600" } })]);
    const controller = new AbortController();
    let sleptMs = -1;
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async (ms: number) => {
      sleptMs = ms;
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    try {
      await expect(fetchVertexWithRetry(request, {
        timeoutMs: 5_000, abortSignal: controller.signal, returnRawErrors: true,
      })).rejects.toBeDefined();
      // The full instructed delay was honoured (never shortened), and the ladder stopped at
      // the abort: exactly one physical send, no second attempt after the refused wait.
      expect(sleptMs).toBeGreaterThanOrEqual(600_000);
      expect(mock.calls).toBe(1);
    } finally { waits.mockRestore(); }
  });

  test("a repair replay is a physical send against the same cap", async () => {
    const repairable = {
      ...request,
      body: JSON.stringify({ request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ functionDeclarations: [{ name: "f", parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } } } }] }],
      } }),
    };
    const mock = mockFetch([
      new Response(vertexError(400, "INVALID_ARGUMENT", "tools.0.custom.input_schema: JSON schema is invalid"), { status: 400, headers: { "Retry-After": "0" } }),
      new Response(vertexError(503, "UNAVAILABLE", "x"), { status: 503, headers: { "Retry-After": "0" } }),
      ok(),
    ]);
    const res = await fetchAntigravityWithRetry(repairable, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(mock.calls).toBe(3);
  });
});
