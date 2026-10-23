import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import {
  DEFAULT_MODEL_REQUEST_MAX_RETRIES,
  MODEL_REQUEST_MAX_RETRIES_LIMIT,
} from "../../src/lib/model-request-retry";
import {
  fetchWithTransientRetry,
  markResponseNonReplayable,
  SendBudgetExhaustedError,
} from "../../src/lib/upstream-retry";

/**
 * 统一模型请求 lane（modelRetryMode）的合同测试。
 *
 * 现场动机：ChatGPT 后端 503 server_is_overloaded 以 SSE 终态终结回合，代理零重放，
 * 客户端读不到帧内建议时直接 "Selected model is at capacity"。2026-10-23 用户合同：
 * 模型请求的真实上游 HTTP 4xx/5xx 一律在统一预算内重试，默认 3 次（4 送，含首发），
 * env `OCX_MODEL_REQUEST_MAX_RETRIES` 可配（0..5：0 = 只首发不重试，越界钳到 5）。
 *
 * 本文件钉 helper 层形状（全状态门、绝对预算、env 边界、RA 下界、abort/non-replayable
 * 一票否决、显式 attempts 精确性）；ledger/派发层形状在
 * `tests/responses/responses-send-budget-counts.test.ts` 与
 * `tests/server/inference-send-budget.test.ts`。计时用 jest fake timers，无真实等待。
 */

const warnSpies: Array<ReturnType<typeof spyOn>> = [];
function silenceWarn(): void {
  warnSpies.push(spyOn(console, "warn").mockImplementation(() => {}));
}

let originalEnv: string | undefined;
beforeEach(() => {
  silenceWarn();
  originalEnv = process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
  delete process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  if (originalEnv === undefined) delete process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
  else process.env.OCX_MODEL_REQUEST_MAX_RETRIES = originalEnv;
  for (const spy of warnSpies.splice(0)) spy.mockRestore();
});

/** 假定时器驱动：每次 tick 之间冲刷微任务，让 retry 循环走完整个阶梯。 */
async function drain(maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

function scripted(
  make: (send: number) => Response,
): { doFetch: (recovery?: string) => Promise<Response>; sends: () => number } {
  let n = 0;
  return {
    sends: () => n,
    doFetch: async () => {
      n += 1;
      return make(n);
    },
  };
}

describe("fetchWithTransientRetry modelRetryMode", () => {
  test.each([400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504, 507, 599])(
    "a persistent %i is retried to the unified send ceiling and the last answer is returned",
    async status => {
      const s = scripted(() => new Response("busy", { status, headers: { "retry-after": "0" } }));
      const run = fetchWithTransientRetry(s.doFetch, { modelRetryMode: true });
      await drain();
      const response = await run;
      expect(response.status).toBe(status);
        expect(s.sends()).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
    },
  );

  test("the unified default is 4 total sends: 3 retries + first send", async () => {
    const s = scripted(() => new Response("", { status: 503, headers: { "retry-after": "0" } }));
    const run = fetchWithTransientRetry(s.doFetch, { modelRetryMode: true });
    await drain();
    await run;
    expect(s.sends()).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
  });

  test("env above the accepted range clamps to the ceiling: 10 means 5 retries = 6 sends", async () => {
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "10";
    const s = scripted(() => new Response("", { status: 500, headers: { "retry-after": "0" } }));
    const run = fetchWithTransientRetry(s.doFetch, { modelRetryMode: true });
    await drain();
    await run;
    expect(s.sends()).toBe(MODEL_REQUEST_MAX_RETRIES_LIMIT + 1);
  });

  test("env 0 is a valid setting: first send only, no replay", async () => {
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "0";
    const s = scripted(() => new Response("", { status: 503, headers: { "retry-after": "0" } }));
    const run = fetchWithTransientRetry(s.doFetch, { modelRetryMode: true });
    await drain();
    await run;
    expect(s.sends()).toBe(1);
  });

  test("a malformed env value falls back to the default, never to zero sends", async () => {
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "nope";
    const s = scripted(() => new Response("", { status: 503, headers: { "retry-after": "0" } }));
    const run = fetchWithTransientRetry(s.doFetch, { modelRetryMode: true });
    await drain();
    await run;
    expect(s.sends()).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
  });

  test("a recovery inside the ladder wins: 2 failures then 200 is sent 3 times", async () => {
    const s = scripted(n => n >= 3
      ? new Response("ok", { status: 200 })
      : new Response("busy", { status: 503, headers: { "retry-after": "0" } }));
    const run = fetchWithTransientRetry(s.doFetch, { modelRetryMode: true });
    await drain();
    const response = await run;
    expect(response.status).toBe(200);
    expect(s.sends()).toBe(3);
  });

  test("an upstream x-should-retry:false does not veto the model lane", async () => {
    const s = scripted(() => new Response("", {
      status: 503, headers: { "retry-after": "0", "x-should-retry": "false" },
    }));
    const run = fetchWithTransientRetry(s.doFetch, { modelRetryMode: true });
    await drain();
    await run;
    expect(s.sends()).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES + 1);
  });

  test("a non-replayable verdict stops the lane at one send", async () => {
    const s = scripted(() => {
      const response = new Response("", { status: 503, headers: { "retry-after": "0" } });
      markResponseNonReplayable(response);
      return response;
    });
    const run = fetchWithTransientRetry(s.doFetch, { modelRetryMode: true });
    await drain();
    const response = await run;
    expect(response.status).toBe(503);
    expect(s.sends()).toBe(1);
  });

  test("Retry-After is a lower bound with no 60s early give-up: RA=90 waits in full", async () => {
    const s = scripted(n => n === 1
      ? new Response("busy", { status: 503, headers: { "retry-after": "90" } })
      : new Response("ok", { status: 200 }));
    const started = Date.now();
    const run = fetchWithTransientRetry(s.doFetch, { modelRetryMode: true });
    await drain();
    const response = await run;
    expect(response.status).toBe(200);
    expect(s.sends()).toBe(2);
    // Fake clock advanced by at least the 90s the provider asked for: the model lane does
    // not trade the mandated retries for a shorter ceiling.
    expect(Date.now() - started).toBeGreaterThanOrEqual(90_000);
  });

  test("an explicit retryAfterCeilingMs is honored: RA=90 past a 60s deadline returns the answer", async () => {
    const s = scripted(() => new Response("busy", { status: 503, headers: { "retry-after": "90" } }));
    const run = fetchWithTransientRetry(s.doFetch, {
      modelRetryMode: true, retryAfterCeilingMs: 60_000,
    });
    await drain();
    const response = await run;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("90");
    expect(s.sends()).toBe(1);
  });

  test("a caller abort during a model-lane wait stops every later send", async () => {
    const controller = new AbortController();
    let n = 0;
    const doFetch = async () => {
      n += 1;
      return new Response("", { status: 503, headers: { "retry-after": "60" } });
    };
    const run = fetchWithTransientRetry(doFetch, { modelRetryMode: true, abortSignal: controller.signal });
    const rejection = run.catch((error: unknown) => error);
    // 先冲刷微任务让首发 resolve、循环进入 60s backoff 的 sleepWithAbort，再 abort：
    // 首发与 backoff 之间 abort 的合法出口是返回首发原响应（既有合同），那条路径由
    // 窄 lane 的旧测试钉；本行钉的是"backoff 中被 abort -> 后续 0 送、AbortError 出栈"。
    for (let i = 0; i < 12; i++) await Promise.resolve();
    controller.abort();
    const outcome = await rejection;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).name).toBe("AbortError");
    expect(n).toBe(1);
  });

  test("explicit attempts keep exact provider-total semantics over the unified default", async () => {
    const s = scripted(() => new Response("", { status: 503, headers: { "retry-after": "0" } }));
    const run = fetchWithTransientRetry(s.doFetch, { modelRetryMode: true, attempts: 2 });
    await drain();
    await run;
    expect(s.sends()).toBe(2);
  });

  test("a spent physical budget refuses before dispatch as the typed budget error", async () => {
    const s = scripted(() => new Response("", { status: 503 }));
    await expect(fetchWithTransientRetry(s.doFetch, {
      modelRetryMode: true,
      attempts: 3,
      onSendsConsumed: Object.assign(() => {}, { beforeSend: () => false }),
    })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(s.sends()).toBe(0);
  });

  test("the narrow lane keeps the old 5xx-only gate and the 3-send default", async () => {
    const rejected = scripted(() => new Response("", { status: 429, headers: { "retry-after": "0" } }));
    const runA = fetchWithTransientRetry(rejected.doFetch, {});
    await drain();
    await runA;
    expect(rejected.sends()).toBe(1);

    const busy = scripted(() => new Response("", { status: 503, headers: { "retry-after": "0" } }));
    const runB = fetchWithTransientRetry(busy.doFetch, {});
    await drain();
    await runB;
    expect(busy.sends()).toBe(3);
  });
});
