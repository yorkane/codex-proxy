/**
 * 统一模型请求 lane 的 adapter 路径合同（fork 2026-10-23 用户裁决）。
 *
 * 用户合同：所有真实上游模型 HTTP 4xx/5xx 必须按统一预算重试至少 10 次（11 次发送），
 * env `OCX_MODEL_REQUEST_MAX_RETRIES` 只可上调（上限 100），config 可配到 100。钉四件事：
 * 1. generic（无 transientRetryOn5xx 的 openai-chat key provider）初始发送现在进统一
 *    ladder：400 也重试，恰好 modelRequestMaxAttempts() 次物理发送，全程计入请求 ledger。
 * 2. 一个逻辑请求一个预算：初始 ladder 打满后 recovery leg（rebuildAndRefetch）拿 0 发送，
 *    以 429 request_send_budget_exhausted 收场，绝不放大到 11+。
 * 3. 401 在无轮换池的 key provider 上按合同进同目标 ladder（不轮换身份、不写 cooldown）。
 * 4. 上游 x-should-retry: false / retryable:false 提示不豁免本地重试义务。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { jest } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import {
  DEFAULT_MODEL_REQUEST_MAX_RETRIES,
  MODEL_REQUEST_MAX_RETRIES_ENV,
} from "../../src/lib/model-request-retry";
import { isModelHttpErrorForPreflight } from "../../src/server/responses/model-error-preflight";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
// 统一 ladder 的 11/101 发送合同只钉计数与 ledger 记账；真实指数退避（400ms 起、5s 封顶）
// 会让单条 11 发行花 ~36s、env 100 的行花 ~490s，超单文件预算。用 jest 假计时器 +
// 排空循环驱动阶梯（tests/lib/model-request-http-retry.test.ts 的既有范式）：退避的
// 真实时长由 helper 层测试与 wire 证据钉，本文件只钉发送次数。
async function drain(maxTicks = 400): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  delete process.env[MODEL_REQUEST_MAX_RETRIES_ENV];
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  delete process.env[MODEL_REQUEST_MAX_RETRIES_ENV];
});

function keyChatProvider(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adapter: "openai-chat",
    baseUrl: `https://${name}.example/v1`,
    authMode: "key",
    apiKey: `sk-${name}`,
    models: [`model-${name}`],
    ...extra,
  };
}

function singleTargetConfig(name = "plain"): OcxConfig {
  return {
    defaultProvider: name,
    providers: { [name]: keyChatProvider(name) },
  } as unknown as OcxConfig;
}

function responsesRequest(model: string): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, input: "hello" }),
  });
}

function failingResponses(status: number, headers: Record<string, string> = {}): { sends: number } {
  const state = { sends: 0 };
  globalThis.fetch = (async () => {
    state.sends += 1;
    return new Response(JSON.stringify({ error: { message: "fixture " + status, type: "server_error" } }), {
      status,
      headers: { "content-type": "application/json", "retry-after": "0", ...headers },
    });
  }) as typeof fetch;
  return state;
}

async function deliver(config: OcxConfig, model: string): Promise<{ status: number; logCtx: RequestLogContext }> {
  releaseSpendHome ??= acquireOwnedSpendHome();
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const run = handleResponses(responsesRequest(model), config, logCtx);
  await drain();
  const response = await run;
  // Drain so buffered terminal bodies settle the attempt log fully.
  try { await response.clone().text(); } catch { /* consumed */ }
  return { status: response.status, logCtx };
}

const totalSends = (logCtx: RequestLogContext): number =>
  (logCtx.attempts ?? []).reduce((sum, attempt) => sum + (attempt.sendCount ?? 0), 0);

describe("unified model retry lane on the generic adapter path", () => {
  test("the default ladder is 11 physical sends for a plain 503", async () => {
    const upstream = failingResponses(503);
    const { logCtx } = await deliver(singleTargetConfig(), "model-plain");
    expect(upstream.sends).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
    expect(totalSends(logCtx)).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
  });

  test("a 400 retries too: the old non-retryable-4xx gate is gone", async () => {
    const upstream = failingResponses(400);
    const { logCtx } = await deliver(singleTargetConfig(), "model-plain");
    expect(upstream.sends).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
    expect(totalSends(logCtx)).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
  });

  test("x-should-retry: false does not exempt the send from the retry duty", async () => {
    const upstream = failingResponses(502, { "x-should-retry": "false" });
    const { logCtx } = await deliver(singleTargetConfig(), "model-plain");
    expect(upstream.sends).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
    expect(totalSends(logCtx)).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
  });

  test("401 on a key provider with no rotation pool enters the same-target ladder", async () => {
    const upstream = failingResponses(401);
    const { logCtx } = await deliver(singleTargetConfig(), "model-plain");
    expect(upstream.sends).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
    expect(totalSends(logCtx)).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
  });

  test("the env raises the ladder: 100 retries = 101 sends", async () => {
    process.env[MODEL_REQUEST_MAX_RETRIES_ENV] = "100";
    const upstream = failingResponses(503);
    const { logCtx } = await deliver(singleTargetConfig(), "model-plain");
    expect(upstream.sends).toBe(101);
    expect(totalSends(logCtx)).toBe(101);
  });
});

describe("recovery legs share the one ladder budget", () => {
  test("a key-429 rotation after the exhausted ladder is refused, sends stay 11", async () => {
    // Two-key pool makes the 429 rotation arm eligible; the initial ladder spends all 11
    // first, so the rotation hop's reserveDispatch hits total-exhausted and the request
    // answers with the real upstream 429 at 11 sends. A recovery leg must not re-arm a
    // fresh 11 on top of the exhausted ladder.
    const config = {
      defaultProvider: "pool",
      providers: { pool: keyChatProvider("pool", {
        apiKeyPool: [{ apiKey: "sk-a" }, { apiKey: "sk-b" }],
      }) },
    } as unknown as OcxConfig;
    const upstream = failingResponses(429);
    const { logCtx } = await deliver(config, "model-pool");
    expect(upstream.sends).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
    expect(totalSends(logCtx)).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
  });
});

describe("preflight local-refusal guard table (final core review P1)", () => {
  // 发出前本地拒绝（spawn/model send 之前、本地 emit 的 400）重放 = 本地风暴：逐码精确
  // 排除。真实上游 4xx（含未知 code、retryable:false、quota/政策 origin 403）保持可重放。
  test("the four pre-send local 400 codes are not replayable", () => {
    for (const code of ["unsupported_input_modality", "tool_catalog_invalid",
      "cursor_root_envelope_limit", "non_canonical_destination"] as const) {
      expect(isModelHttpErrorForPreflight({
        type: "error", message: "local refusal", status: 400, code, retryable: false,
      })).toBe(false);
    }
  });

  test("an upstream 400 with an unknown code and retryable:false is still replayable", () => {
    expect(isModelHttpErrorForPreflight({
      type: "error", message: "upstream invalid", status: 400, code: "some_provider_code", retryable: false,
    })).toBe(true);
  });

  test("real-origin quota/policy 403s stay replayable; the local 499 code and abort exclusion stands", () => {
    expect(isModelHttpErrorForPreflight({ type: "error", message: "quota", status: 403, code: "quota_exceeded" })).toBe(true);
    expect(isModelHttpErrorForPreflight({ type: "error", message: "policy", status: 403, code: "cyber_policy" })).toBe(true);
    // 499 只按显式本地码排除（数字 499 不泛排，用户合同覆盖全部 4xx）。
    expect(isModelHttpErrorForPreflight({ type: "error", message: "closed", status: 499, code: "client_closed_request" })).toBe(false);
    expect(isModelHttpErrorForPreflight({ type: "error", message: "upstream 499", status: 499, code: "server_error" })).toBe(true);
  });
});
