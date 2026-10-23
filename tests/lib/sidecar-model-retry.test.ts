import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import {
  fetchSidecarModel,
  sidecarModelRetryAttempts,
} from "../../src/lib/sidecar-model-retry";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import {
  SendBudgetExhaustedError,
  markResponseNonReplayable,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
} from "../../src/lib/upstream-retry";
import {
  DEFAULT_MODEL_REQUEST_MAX_RETRIES,
  MODEL_REQUEST_MAX_RETRIES_LIMIT,
  MODEL_REQUEST_MAX_RETRIES_ENV,
} from "../../src/lib/model-request-retry";

const warnSpies: Array<ReturnType<typeof spyOn>> = [];
afterEach(() => { for (const spy of warnSpies.splice(0)) spy.mockRestore(); jest.useRealTimers(); });

function silenceWarnings() {
  warnSpies.push(spyOn(console, "warn").mockImplementation(() => {}));
}

function statusResponse(status: number, headers?: Record<string, string>): Response {
  return new Response(status === 204 ? null : "error-body", { status, headers });
}

/**
 * 合同测的是发送数与状态，不是墙钟：backoff 睡眠全走 fake timers，整条 ladder 用
 * advanceTimersByTimeAsync 一次冲刷（microtask 间接力），每用例毫秒级。生产真实退避
 * 时序由 tests/providers/upstream-transient-retry.test.ts 与 tests/lib/upstream-retry.test.ts
 * 的既有 wire 覆盖，本文件不重复付费等待。
 */
async function flushLadder(pending: Promise<Response>, ms = 600_000): Promise<Response> {
  // Bun 1.4.3 的 jest 兼容层没有 advanceTimersByTimeAsync；用同步 advance + 微任务冲刷
  // 的分片驱动（tests/lib/model-request-http-retry.test.ts 的 drain 范式）走完阶梯。
  const stepMs = 10_000;
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    jest.advanceTimersByTime(stepMs);
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  }
  return pending;
}

describe("sidecarModelRetryAttempts", () => {
  test("默认 3 次重试 = 4 次总发送；configured 越界回落默认，env 越界钳到上限 5", () => {
    // 2026-10-23 改约：接受范围 0..5。旧默认 config 10 越界 → 回落默认 3 → 4 送；
    // env 10/50 越界钳到上限 5 → 6 送。
    expect(sidecarModelRetryAttempts()).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
    expect(sidecarModelRetryAttempts(12)).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
    expect(sidecarModelRetryAttempts(3)).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
    const previous = process.env[MODEL_REQUEST_MAX_RETRIES_ENV];
    process.env[MODEL_REQUEST_MAX_RETRIES_ENV] = "50";
    try {
      expect(sidecarModelRetryAttempts(12)).toBe(MODEL_REQUEST_MAX_RETRIES_LIMIT + 1);
    } finally {
      if (previous === undefined) delete process.env[MODEL_REQUEST_MAX_RETRIES_ENV];
      else process.env[MODEL_REQUEST_MAX_RETRIES_ENV] = previous;
    }
  });
});

describe("fetchSidecarModel", () => {
  test("真实 4xx 与 5xx 都重试到统一预算（默认 4），耗尽后返回最后的真实响应", async () => {
    silenceWarnings();
    jest.useFakeTimers();
    let sends = 0;
    const pending = fetchSidecarModel(async () => {
      sends += 1;
      return statusResponse(sends === 4 ? 400 : 503);
    }, { label: "test-sidecar" });
    const res = await flushLadder(pending);
    expect(sends).toBe(4);
    expect(res.status).toBe(400);
  });

  test("env 提高预算时 sidecar 调用跟着提高（无账本路径）", async () => {
    silenceWarnings();
    jest.useFakeTimers();
    const previous = process.env[MODEL_REQUEST_MAX_RETRIES_ENV];
    // 旧 env 12 在新范围外 → 钳上限 5 → 6 送（意图不变：env 抬升生效）。
    process.env[MODEL_REQUEST_MAX_RETRIES_ENV] = "12";
    try {
      let sends = 0;
      const pending = fetchSidecarModel(async () => { sends += 1; return statusResponse(503); }, { label: "test-sidecar" });
      await flushLadder(pending);
      expect(sends).toBe(6);
    } finally {
      if (previous === undefined) delete process.env[MODEL_REQUEST_MAX_RETRIES_ENV];
      else process.env[MODEL_REQUEST_MAX_RETRIES_ENV] = previous;
    }
  });

  test("有共享账本时权威是账本 policy 的绝对总额，且实发数计入账本", async () => {
    silenceWarnings();
    jest.useFakeTimers();
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 13,
      baseSendAllowance: 13,
      finalRecoveryAllowance: 1,
      maxAlternateTargetSends: 1,
      maxTargetTransitions: 1,
    });
    let sends = 0;
    const pending = fetchSidecarModel(async () => {
      sends += 1;
      return statusResponse(500);
    }, { label: "test-ledger", sendBudget: budget, targetKey: () => "https://upstream.test" });
    const res = await flushLadder(pending);
    expect(sends).toBe(13);
    expect(res.status).toBe(500);
    expect(budget.used).toBe(13);
  });

  test("账本剩余额度是硬边界：先到先停，拒绝原样上抛不伪装成上游错误", async () => {
    silenceWarnings();
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 2,
      baseSendAllowance: 2,
      finalRecoveryAllowance: 1,
      maxAlternateTargetSends: 1,
      maxTargetTransitions: 1,
    });
    budget.used = 2;
    let sends = 0;
    let thrown: unknown;
    try {
      await fetchSidecarModel(async () => { sends += 1; return statusResponse(503); }, { label: "test-hardcap", sendBudget: budget });
    } catch (error) {
      thrown = error;
    }
    expect(sends).toBe(0);
    expect(thrown).toBeInstanceOf(SendBudgetExhaustedError);
  });

  test("caller 自带 reporter 时独占记账：本层不再向账本二次上报", async () => {
    silenceWarnings();
    jest.useFakeTimers();
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 13,
      baseSendAllowance: 13,
      finalRecoveryAllowance: 1,
      maxAlternateTargetSends: 1,
      maxTargetTransitions: 1,
    });
    let reported = 0;
    const onSendsConsumed = (sends: number) => { reported += sends; budget.used += sends; };
    let sends = 0;
    const pending = fetchSidecarModel(async () => { sends += 1; return statusResponse(502); },
      { label: "test-caller-reporter", sendBudget: budget, onSendsConsumed });
    await flushLadder(pending);
    expect(sends).toBe(13);
    expect(reported).toBe(13);
    // caller reporter 记一次；本层不双扣。
    expect(budget.used).toBe(13);
  });

  test("模型 POST 不声明 replaySafe：歧义 reset settle 成 non-replayable 拒绝，不盲重放", async () => {
    silenceWarnings();
    let sends = 0;
    const res = await fetchSidecarModel(async () => {
      sends += 1;
      const err = new Error("The socket connection was closed unexpectedly");
      (err as Error & { code: string }).code = "ECONNRESET";
      throw err;
    }, { label: "test-reset" });
    expect(sends).toBe(1);
    expect(res.status).toBe(429);
    expect(await res.clone().json()).toMatchObject({ error: { code: UPSTREAM_RESET_REPLAY_REFUSED_CODE } });
  });

  test("non-replayable 标记一票否决：4xx/5xx 门不覆盖本地标记", async () => {
    silenceWarnings();
    let sends = 0;
    const res = await fetchSidecarModel(async () => {
      sends += 1;
      const response = statusResponse(504);
      markResponseNonReplayable(response);
      return response;
    }, { label: "test-marker" });
    expect(sends).toBe(1);
    expect(res.status).toBe(504);
  });

  test("caller abort 撕碎 backoff：rejection 原样上抛，不再发送", async () => {
    silenceWarnings();
    const caller = new AbortController();
    let sends = 0;
    const pending = fetchSidecarModel(async () => {
      sends += 1;
      if (sends === 1) setTimeout(() => caller.abort(new DOMException("bye", "AbortError")), 5);
      return statusResponse(503, { "retry-after": "5" });
    }, { label: "test-abort", abortSignal: caller.signal, retryAfterCeilingMs: 60_000 });
    let thrown: unknown;
    try { await pending; } catch (error) { thrown = error; }
    expect((thrown as DOMException)?.name).toBe("AbortError");
    expect(sends).toBe(1);
  });

  test("Retry-After 是完整下限：2s 指令排定的 sleep timer ≥2000ms，不被本地 backoff 上限缩短", async () => {
    silenceWarnings();
    // 记录排定睡眠时长后 0ms 放行：断言 helper 排定的 timer 时长，不真等 2s。
    const nativeSetTimeout = globalThis.setTimeout;
    const scheduled: number[] = [];
    warnSpies.push(spyOn(globalThis, "setTimeout").mockImplementation((callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]) => {
      scheduled.push(Number(ms ?? 0));
      return nativeSetTimeout(callback, 0, ...args);
    }) as unknown as typeof setTimeout);
    let sends = 0;
    const pending = fetchSidecarModel(async () => {
      sends += 1;
      return sends === 1
        ? statusResponse(429, { "retry-after": "2" })
        : new Response("data: [DONE]\n\n", { status: 200 });
    }, { label: "test-retry-after", retryAfterCeilingMs: 30_000 });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(sends).toBe(2);
    // retryAfterIsLowerBound:true 时 delay = max(RA=2000, jittered≤480)：RA 完整下发。
    expect(Math.max(...scheduled)).toBeGreaterThanOrEqual(2_000);
  });
});
