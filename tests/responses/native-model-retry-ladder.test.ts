/**
 * 三条 native 模型 lane 的统一 4xx/5xx 重放阶梯（fork 合同：至少 10 次重试 = 11 物理发送，
 * 一个逻辑请求一个预算）。真实计数：fixture fetch 逐次记账，验证恢复、耗尽、配置抬升
 * (env/config 12 -> 13)、caller abort 立停、本地预算拒绝 0 送、精确 caller cap 不被统一
 * 地板抬升。计时器经 spy 立即触发（只截退避/RA 等待，不截 connect deadline 长定时器），
 * Retry-After 作为下界被安排的事实由捕获的 delay 断言。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { createRequestExecutionBudget, CODEX_TEXT_GUARDED_BUDGET_POLICY } from "../../src/lib/request-execution-budget";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearKeyCooldowns } from "../../src/providers/key-failover";

const ENV_KEY = "OCX_MODEL_REQUEST_MAX_RETRIES";
const originalFetch = globalThis.fetch;
let previousEnv: string | undefined;
let testDir = "";
let releaseSpendHome: (() => void) | undefined;
let sends: Array<{ url: string; status: number }> = [];
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  previousEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  testDir = mkdtempSync("/data/tmp/ocx-native-model-retry-");
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  clearKeyCooldowns();
  sends = [];
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  globalThis.fetch = originalFetch;
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearKeyCooldowns();
  if (previousEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousEnv;
  if (testDir) removeTreeWithRetry(testDir);
});

/**
 * Backoff/Retry-After sleeps scheduled below the connect-deadline band fire on the next
 * microtask (captured for the Retry-After assertions); long timers (header deadline) run
 * on the real scheduler, so a fixture can never turn the connect timeout into a fake fast fail.
 */
function immediateBackoff(delays: number[], abortSignal?: { controller: AbortController; after: number }): void {
  const native = globalThis.setTimeout;
  let slept = 0;
  spies.push(spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const delay = ms ?? 0;
    if (delay < 60_000) {
      delays.push(delay);
      slept += 1;
      if (abortSignal && slept >= abortSignal.after) queueMicrotask(() => abortSignal.controller.abort());
      queueMicrotask(() => { if (typeof handler === "function") handler(...(args as [])); });
      return native(() => {}, 0);
    }
    return native(handler as () => void, delay, ...args);
  }) as typeof setTimeout));
}

function scriptedUpstream(statuses: number[], okBody: (index: number) => Response): void {
  globalThis.fetch = (async (input, init) => {
    const index = sends.length;
    const status = statuses[index] ?? statuses[statuses.length - 1]!;
    sends.push({ url: String(input), status });
    if (status >= 400) {
      return Response.json({ error: { message: "fixture refusal", code: status === 503 ? "server_is_overloaded" : undefined } },
        { status, ...(statuses[index] === 503 && index === 0 && statuses === RETRY_AFTER_PROBE ? { headers: { "retry-after": "45" } } : {}) });
    }
    return okBody(index);
  }) as typeof fetch;
}

const RETRY_AFTER_PROBE: number[] = [503];

function chatConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "https://mock.example.test/v1", authMode: "key", apiKey: "k" } },
  } as unknown as OcxConfig;
}

async function chatRequest(): Promise<Response> {
  return handleChatCompletions(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/m", messages: [{ role: "user", content: "ping" }] }),
    }),
    chatConfig(),
    { model: "", provider: "" },
  );
}

const chatOk = (): Response => Response.json({
  id: "c1", object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
});

describe("native Chat unified ladder", () => {
  for (const status of [401, 503]) {
    test(`every upstream ${status} replays to the shared 11-send ceiling`, async () => {
      const delays: number[] = [];
      scriptedUpstream([status], chatOk);
      immediateBackoff(delays);
      const response = await chatRequest();
      expect(sends).toHaveLength(11);
      expect(response.status).toBe(status);
    });
  }

  test("a recovery at send 5 serves the turn and stops the ladder", async () => {
    scriptedUpstream([503, 503, 503, 503, 200], chatOk);
    immediateBackoff([]);
    const response = await chatRequest();
    expect(sends).toHaveLength(5);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: "answer" } }] });
  });

  test("env 12 raises the whole ladder to 13 sends", async () => {
    process.env[ENV_KEY] = "12";
    scriptedUpstream([503], chatOk);
    immediateBackoff([]);
    await chatRequest();
    expect(sends).toHaveLength(13);
  });

  test("config 12 raises the ladder to 13 sends", async () => {
    const cfg = chatConfig();
    (cfg as { modelRequestMaxRetries?: number }).modelRequestMaxRetries = 12;
    scriptedUpstream([503], chatOk);
    immediateBackoff([]);
    await handleChatCompletions(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock/m", messages: [{ role: "user", content: "ping" }] }),
      }),
      cfg,
      { model: "", provider: "" },
    );
    expect(sends).toHaveLength(13);
  });

  test("caller abort during a backoff stops every later send", async () => {
    const controller = new AbortController();
    scriptedUpstream([503], chatOk);
    immediateBackoff([], { controller, after: 1 });
    const response = await handleChatCompletions(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock/m", messages: [{ role: "user", content: "ping" }] }),
        signal: controller.signal,
      }),
      chatConfig(),
      { model: "", provider: "" },
    );
    expect(response.status).toBe(499);
    expect(sends).toHaveLength(1);
  });

  test("a Retry-After of 45s is scheduled as the lower bound, not clamped by the 60s ceiling", async () => {
    const delays: number[] = [];
    scriptedUpstream(RETRY_AFTER_PROBE, chatOk);
    immediateBackoff(delays);
    await chatRequest();
    // The ladder's own first sleep must be the instructed 45s (lower bound, model lane has
    // no 60s ceiling short-circuit). Other lane timers may schedule alongside it, so the
    // assertion names the retry sleep directly rather than the first timer overall.
    expect(delays.some(delay => delay >= 45_000)).toBe(true);
    expect(sends.length).toBeGreaterThan(1);
  });
});

function messagesConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "anth",
    providers: { anth: { adapter: "anthropic", baseUrl: "https://anth.example.test", authMode: "key", apiKey: "k", models: ["claude-x"] } },
    protocols: { rollout: { managedMessagesNative: true } },
  } as unknown as OcxConfig;
}

const messagesOk = (): Response => Response.json({
  id: "msg_1", type: "message", role: "assistant", model: "claude-x",
  content: [{ type: "text", text: "reply" }], stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 2 },
});

async function messagesRequest(signal?: AbortSignal): Promise<Response> {
  return handleClaudeMessages(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "anth/claude-x", max_tokens: 8, messages: [{ role: "user", content: "ping" }] }),
      ...(signal ? { signal } : {}),
    }),
    messagesConfig(),
    { model: "", provider: "" },
    { requestId: "nmr-" + crypto.randomUUID(), start: Date.now() },
  );
}

describe("native Messages unified ladder", () => {
  test("a steady 503 replays 11 times and answers overloaded", async () => {
    scriptedUpstream([503], messagesOk);
    immediateBackoff([]);
    const response = await messagesRequest();
    expect(sends).toHaveLength(11);
    expect(response.status).toBe(529);
    expect(await response.json()).toMatchObject({ error: { type: "overloaded_error" } });
  });

  test("a steady 401 replays 11 times on a single-key provider", async () => {
    scriptedUpstream([401], messagesOk);
    immediateBackoff([]);
    const response = await messagesRequest();
    expect(sends).toHaveLength(11);
    expect(response.status).toBe(401);
  });

  test("caller abort during a backoff stops the loop at one send", async () => {
    const controller = new AbortController();
    scriptedUpstream([503], messagesOk);
    immediateBackoff([], { controller, after: 1 });
    const response = await messagesRequest(controller.signal);
    expect(response.status).toBe(499);
    expect(sends).toHaveLength(1);
  });
});

function compactConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "gw",
    providers: { gw: { adapter: "openai-responses", baseUrl: "https://gw.example.test/v1", authMode: "key", apiKey: "k", supportsNativeCompactEndpoint: true } },
  } as unknown as OcxConfig;
}

const compactOk = (): Response => Response.json({ id: "cmp_1", object: "response.compaction", output: [] });

async function compactRequest(budget?: ReturnType<typeof createRequestExecutionBudget>, signal?: AbortSignal): Promise<Response> {
  const request = new Request("http://localhost/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gw/m", input: [{ role: "user", content: "compact this" }] }),
    ...(signal ? { signal } : {}),
  });
  return handleResponsesCompact(request, compactConfig(), { model: "", provider: "" }, undefined, undefined,
    { ...(budget ? { sendBudget: budget } : {}) });
}

describe("native compact unified ladder", () => {
  for (const status of [401, 503]) {
    test(`a steady ${status} ladder stops at the shared 11-send ceiling`, async () => {
      scriptedUpstream([status], compactOk);
      immediateBackoff([]);
      const response = await compactRequest();
      expect(sends).toHaveLength(11);
      expect(response.status).toBe(status);
    });
  }

  test("a spent caller budget refuses every send and answers 429 locally", async () => {
    scriptedUpstream([503], compactOk);
    immediateBackoff([]);
    const spent = createRequestExecutionBudget({
      ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 0, baseSendAllowance: 0, finalRecoveryAllowance: 0,
    });
    const response = await compactRequest(spent);
    expect(sends).toHaveLength(0);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "request_send_budget_exhausted" } });
  });

  test("an exact caller cap of 2 sends twice, not widened by the unified floor", async () => {
    scriptedUpstream([503], compactOk);
    immediateBackoff([]);
    const exact = createRequestExecutionBudget({
      ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 2, baseSendAllowance: 2, finalRecoveryAllowance: 0,
    });
    const response = await compactRequest(exact);
    expect(sends).toHaveLength(2);
    expect(response.status).toBe(503);
  });

  test("caller abort during a compact backoff stops after one send", async () => {
    const controller = new AbortController();
    scriptedUpstream([503], compactOk);
    immediateBackoff([], { controller, after: 1 });
    const response = await compactRequest(undefined, controller.signal);
    expect(response.status).toBe(499);
    expect(sends).toHaveLength(1);
  });
});
