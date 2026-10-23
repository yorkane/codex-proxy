/**
 * 统一模型重试壳（src/adapters/model-http-retry.ts）的发送计数合同测试。
 *
 * 运维合同（2026-10-23）：任何上游 HTTP 4xx/5xx 都按统一预算重试，默认 11 次物理发送
 * （env OCX_MODEL_REQUEST_MAX_RETRIES > 全局配置 > 地板 10）。这里钉住六条边界：
 * context-free 恰好 11（不是 22）、显式 cap 原样（cap 0 直接拒发）、轮内协议恢复
 * （401 刷票 / 400 降 ladder）计入同一账本、协议状态跨轮保留、caller abort 即停。
 * backoff 全走假时钟：每轮真实退避最长 5s，11 连败约睡 36s，测试不真睡。
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { MODEL_REQUEST_MAX_RETRIES_ENV } from "../../src/lib/model-request-retry";
import { fetchModelHttpResponseWithRetry, modelHttpRetryAttempts } from "../../src/adapters/model-http-retry";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { createMimoFreeAdapter, getMimoClientId, MIMO_CHAT_URL, resetMimoClientIdCache, resetMimoJwtCache } from "../../src/adapters/mimo-free";
import { resetCommandCodeReasoningEffortsForTest } from "../../src/providers/command-code-efforts";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { providerConfigSeed } from "../../src/providers/derive";
import type { AdapterFetchContext } from "../../src/adapters/base";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ENV_KEY = MODEL_REQUEST_MAX_RETRIES_ENV;
let previousEnv: string | undefined;

beforeEach(() => { previousEnv = process.env[ENV_KEY]; delete process.env[ENV_KEY]; jest.useFakeTimers(); });
afterEach(() => {
  jest.useRealTimers();
  if (previousEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = previousEnv;
  resetCommandCodeReasoningEffortsForTest();
});

/** 推进假时钟跑完带 backoff 的工作：5s 步进 + 排空微任务，等价于真实世界睡完全部退避。 */
async function settleWithFakeTimers<T>(work: () => Promise<T>, maxTicks = 300): Promise<T> {
  const promise = work();
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < maxTicks && !settled; i++) {
    jest.advanceTimersByTime(5_000);
    for (let j = 0; j < 30; j++) await Promise.resolve();
  }
  return promise;
}

function guardedBudget(maxTotalModelSends: number) {
  return createRequestExecutionBudget({
    maxTotalModelSends, baseSendAllowance: maxTotalModelSends,
    finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0,
  });
}

const CHAT = "https://upstream.test/chat";

describe("model-http-retry send counts", () => {
  test("modelHttpRetryAttempts: context-free default 11; explicit caps verbatim (incl. 0)", () => {
    expect(modelHttpRetryAttempts({})).toBe(11);
    expect(modelHttpRetryAttempts({ sendBudget: guardedBudget(2) })).toBe(2);
    expect(modelHttpRetryAttempts({ sendBudget: guardedBudget(0) })).toBe(0);
    process.env[ENV_KEY] = "25";
    expect(modelHttpRetryAttempts({})).toBe(26);
    // 显式小 cap 是调用方的精确合同：统一地板不得抬升它。
    expect(modelHttpRetryAttempts({ sendBudget: guardedBudget(2) })).toBe(2);
  });

  test("context-free persistent 503 spends exactly 11 physical sends and returns the real answer", async () => {
    let sends = 0;
    const ctx: AdapterFetchContext = { executor: (async () => {
      sends += 1;
      return new Response("capacity draining", { status: 503 });
    }) as typeof globalThis.fetch };
    const response = await settleWithFakeTimers(() => fetchModelHttpResponseWithRetry(
      async (send) => send({ url: CHAT, dispatch: executor => executor(CHAT, {}) }), ctx, { label: "test-contextfree" }));
    expect(sends).toBe(11);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("capacity draining");
  });

  test("explicit cap 2 is verbatim: 2 sends and the real 503 answer; cap 0 refuses with zero sends", async () => {
    let sends = 0;
    const budget = guardedBudget(2);
    const ctx: AdapterFetchContext = { sendBudget: budget, executor: (async () => {
      sends += 1;
      return new Response("busy-" + sends, { status: 503 });
    }) as typeof globalThis.fetch };
    const response = await settleWithFakeTimers(() => fetchModelHttpResponseWithRetry(
      async (send) => send({ url: CHAT, dispatch: executor => executor(CHAT, {}) }), ctx, { label: "test-cap2" }));
    expect(sends).toBe(2);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("busy-2");
    expect(budget.used).toBe(2);

    let refused = 0;
    const zero: AdapterFetchContext = { sendBudget: guardedBudget(0), executor: (async () => {
      refused += 1;
      return new Response("no", { status: 500 });
    }) as typeof globalThis.fetch };
    await expect(fetchModelHttpResponseWithRetry(
      async (send) => send({ url: CHAT, dispatch: executor => executor(CHAT, {}) }), zero, { label: "test-cap0" }))
      .rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(refused).toBe(0);
  });

  test("inner 2-send round (Zed shape) is capped at 11 physical sends, not 22", async () => {
    // run 闭包每轮两次物理发送（首发 401 + 协议重放 503），全部经同一个 send 记账；
    // 共享预算（11）是唯一硬闸：第 6 轮的第二发在发送前被拒，总物理发送恰 11。
    let sends = 0;
    const budget = guardedBudget(11);
    const ctx: AdapterFetchContext = { sendBudget: budget, executor: (async () => {
      sends += 1;
      return sends % 2 === 1 ? new Response("expired", { status: 401 }) : new Response("capacity draining", { status: 503 });
    }) as typeof globalThis.fetch };
    const response = await settleWithFakeTimers(() => fetchModelHttpResponseWithRetry(async (send) => {
      await send({ url: CHAT, dispatch: executor => executor(CHAT, {}) });
      return send({ url: CHAT, sendClass: "auth-recovery", recovery: "oauth-401", dispatch: executor => executor(CHAT, {}) });
    }, ctx, { label: "test-zedshape" }));
    expect(sends).toBe(11);
    expect(response.status).toBe(503);
    expect(budget.used).toBe(11);
  });

  test("caller abort during the first backoff rejects with the abort error after one send", async () => {
    const ac = new AbortController();
    let sends = 0;
    const ctx: AdapterFetchContext = { abortSignal: ac.signal, executor: (async () => {
      sends += 1;
      setTimeout(() => ac.abort(new DOMException("client closed", "AbortError")), 0);
      return new Response("capacity draining", { status: 503 });
    }) as typeof globalThis.fetch };
    await expect(settleWithFakeTimers(() => fetchModelHttpResponseWithRetry(
      async (send) => send({ url: CHAT, dispatch: executor => executor(CHAT, {}) }), ctx, { label: "test-abort" })))
      .rejects.toThrow(/client closed|AbortError/);
    expect(sends).toBe(1);
  });

  test("a pre-aborted caller sends nothing", async () => {
    const ac = new AbortController();
    ac.abort(new DOMException("client closed", "AbortError"));
    let sends = 0;
    const ctx: AdapterFetchContext = { abortSignal: ac.signal, executor: (async () => {
      sends += 1;
      return new Response("no", { status: 500 });
    }) as typeof globalThis.fetch };
    await expect(fetchModelHttpResponseWithRetry(
      async (send) => send({ url: CHAT, dispatch: executor => executor(CHAT, {}) }), ctx, { label: "test-abort0" }))
      .rejects.toThrow(/client closed|AbortError/);
    expect(sends).toBe(0);
  });
});

describe("mimo-free unified lane", () => {
  test("intermittent 401 refreshes once, every later round carries the fresh JWT (11 model sends)", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-mimo-lane-"));
    process.env.OPENCODEX_HOME = home;
    resetMimoJwtCache();
    resetMimoClientIdCache();
    const auths: string[] = [];
    let bootstraps = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/bootstrap")) { bootstraps += 1; return Response.json({ jwt: "fresh-token" }); }
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      auths.push(authorization);
      // 首发旧票 401 触发刷新；之后票有效但间歇 429：统一 lane 必须一路重试到 11 发，
      // 全程用刷新后的票，而不是每轮从旧票重新开始。
      return auths.length === 1 ? new Response("expired", { status: 401 }) : new Response("rate limited", { status: 429 });
    }) as typeof fetch;
    try {
      const adapter = createMimoFreeAdapter(providerConfigSeed(PROVIDER_REGISTRY.find(entry => entry.id === "mimo-free")!) as OcxProviderConfig);
      const response = await settleWithFakeTimers(() => adapter.fetchResponse!(
        { url: MIMO_CHAT_URL, method: "POST", headers: { authorization: "Bearer stale" }, body: "{}" }, {}));
      expect(auths).toHaveLength(11);
      expect(auths[0]).toBe("Bearer stale");
      expect(auths.slice(1).every(header => header === "Bearer fresh-token")).toBe(true);
      expect(bootstraps).toBe(1);
      expect(response.status).toBe(429);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
      resetMimoClientIdCache();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });
});

describe("command-code unified lane", () => {
  const provider: OcxProviderConfig = {
    adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode: "oauth",
    apiKey: "synthetic-command-key", defaultMaxOutputTokens: 64_000,
  };
  const parsed = (): OcxParsedRequest => ({
    modelId: "deepseek/deepseek-v4-flash", stream: true,
    context: { systemPrompt: ["system"], messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [{ name: "lookup", description: "lookup", parameters: { type: "object" } }] },
    options: { reasoning: "max", maxOutputTokens: 100 },
  });

  test("400 effort rejection repairs on the NEXT round and the repair send counts in the ledger", async () => {
    const generate: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("commandcode.ai/models/")) {
        return new Response("Reasoning efforts high are supported; no other reasoning settings.");
      }
      generate.push(typeof init?.body === "string" ? init.body : "");
      if (generate.length === 1) return new Response(JSON.stringify({ error: "unsupported reasoning_effort" }), { status: 400 });
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const impl = createCommandCodeAdapter({ ...provider, fetch: fetchImpl } as OcxProviderConfig);
    const request = await impl.buildRequest!(parsed());
    const budget = guardedBudget(4);
    const response = await settleWithFakeTimers(() => impl.fetchResponse!(request, { sendBudget: budget }));
    expect(response.ok).toBe(true);
    expect(generate).toHaveLength(2);
    // repair 是第 2 轮的物理发送：账本记 2；profile 刷新是支持流量，不占模型发送。
    expect(budget.used).toBe(2);
    expect(JSON.parse(generate[0]!).params).toHaveProperty("reasoning_effort");
    expect(JSON.parse(generate[1]!).params).not.toHaveProperty("reasoning_effort");
  });
});
