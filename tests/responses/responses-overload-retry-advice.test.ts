import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OVERLOAD_RETRY_AFTER_SEC,
  OVERLOAD_RETRY_AFTER_SEC_ENV,
  OVERLOAD_RETRY_AFTER_SEC_LIMIT,
  hasFrameRetryAdvice,
  overloadCodeFromJsonBody,
  overloadRetryAdviceForTerminal,
  overloadRetryAfterHeader,
  overloadRetryAfterSec,
} from "../../src/lib/overload-retry-advice";
import { createOverloadRetryAdviceBlockRewrite } from "../../src/server/responses/overload-retry-advice-block-rewrite";
import { upstreamErrorTailFrame } from "../../src/server/relay";
import { formatPassthroughUpstreamError } from "../../src/server/responses/passthrough-error";
import {
  applyReplayRefusalClientHeaders,
  REPLAY_REFUSAL_NO_RETRY_HEADER,
  REPLAY_REFUSAL_NO_RETRY_VALUE,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
} from "../../src/lib/upstream-retry";

type Frame = { response?: { error?: Record<string, unknown>, last_error?: Record<string, unknown> }, headers?: unknown };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function failedFrame(error: Record<string, unknown>, lastError?: Record<string, unknown>): string {
  return "event: response.failed\ndata: " + JSON.stringify({
    type: "response.failed",
    response: { id: "resp_1", status: "failed", output: [], error, ...(lastError ? { last_error: lastError } : {}) },
  }) + "\n\n";
}

function frameData(block: string): Frame {
  const line = block.split("\n").find(l => l.startsWith("data: "));
  if (line === undefined) throw new Error("missing data line");
  return JSON.parse(line.slice(6)) as Frame;
}

/** 现场形态：上游在 HTTP 200 SSE 流里逐字转发的 response.failed 过载终态帧。 */
const OVERLOAD_BLOCK = failedFrame({ type: "server_error", code: "server_is_overloaded", message: "Our servers are currently overloaded" });

describe("overload retry advice: passthrough block rewrite (现场主路径)", () => {
  test("逐字转发的上游过载终态帧被注入 error.headers.retry-after", () => {
    const rewrite = createOverloadRetryAdviceBlockRewrite({});
    const out = rewrite(OVERLOAD_BLOCK);
    expect(out).toHaveLength(1);
    const event = frameData(out[0]!);
    expect(event.response?.error?.headers).toEqual({ "retry-after": String(DEFAULT_OVERLOAD_RETRY_AFTER_SEC) });
    expect(event.response?.error?.code).toBe("server_is_overloaded");
    // 幂等：对已注入的帧再跑一次不再改动（235 与 177 同包双层部署的硬要求）
    expect(rewrite(out[0]!)).toEqual(out);
  });

  test("last_error 与 error 同形时一并注入", () => {
    const block = failedFrame({ code: "server_is_overloaded", message: "busy" }, { code: "server_is_overloaded", message: "busy" });
    const event = frameData(createOverloadRetryAdviceBlockRewrite({})(block)[0]!);
    expect(event.response?.error?.headers).toEqual({ "retry-after": "2" });
    expect(event.response?.last_error?.headers).toEqual({ "retry-after": "2" });
  });

  test("上游帧自带建议时不覆盖、不缩短", () => {
    for (const raw of [{ "retry-after": "30" }, { "Retry-After": "45" }, { "retry-after": "0" }]) {
      const block = failedFrame({ type: "server_error", code: "server_is_overloaded", message: "busy", headers: raw });
      expect(createOverloadRetryAdviceBlockRewrite({})(block)).toEqual([block]);
    }
  });

  test("非过载码不注入：rate_limit_exceeded / invalid_request_error / 文案含过载词", () => {
    const blocks = [
      failedFrame({ type: "rate_limit_exceeded", code: "rate_limit_exceeded", message: "overloaded wording must not count" }),
      failedFrame({ type: "invalid_request_error", code: "invalid_request_error", message: "server_is_overloaded copy" }),
      "event: response.completed\ndata: " + JSON.stringify({ type: "response.completed" }) + "\n\n",
    ];
    const rewrite = createOverloadRetryAdviceBlockRewrite({});
    for (const block of blocks) expect(rewrite(block)).toEqual([block]);
  });

  test("headers 已存在但不是对象时不动", () => {
    const block = failedFrame({ type: "server_error", code: "server_is_overloaded", message: "busy", headers: "retry-after: 9" });
    expect(createOverloadRetryAdviceBlockRewrite({})(block)).toEqual([block]);
  });

  test("env 决定注入秒数：OCX_OVERLOAD_RETRY_AFTER_SEC=7", () => {
    const rewrite = createOverloadRetryAdviceBlockRewrite({ [OVERLOAD_RETRY_AFTER_SEC_ENV]: "7" });
    const event = frameData(rewrite(OVERLOAD_BLOCK)[0]!);
    expect(event.response?.error?.headers).toEqual({ "retry-after": "7" });
  });

  test("裸 error 事件帧不经 block rewrite 注入（由尾帧与 WS 投影覆盖）", () => {
    const block = "event: error\ndata: " + JSON.stringify({ type: "error", status: 503, error: { code: "server_is_overloaded", message: "overloaded" } }) + "\n\n";
    expect(createOverloadRetryAdviceBlockRewrite({})(block)).toEqual([block]);
    // leaf 层支持裸事件形态：建议写在顶层 headers（WS 投影 rejectionHeaders 读取的位置）
    const patched = overloadRetryAdviceForTerminal({ type: "error", status: 503, error: { code: "server_is_overloaded", message: "overloaded" } }, "2");
    expect(patched?.headers).toEqual({ "retry-after": "2" });
  });
});

describe("overload retry advice: synthesized terminal tail (relay.ts)", () => {
  function tail(error: Record<string, unknown>, refusalCode?: string, frameRetryAdvice?: boolean): Record<string, unknown> {
    const text = decoder.decode(upstreamErrorTailFrame(
      encoder, "upstream diagnostic", refusalCode, undefined,
      typeof error.type === "string" ? error.type : undefined,
      typeof error.code === "string" ? error.code : undefined,
      frameRetryAdvice,
    ));
    const payload = text.split("data: ")[1]!.split("\n")[0]!;
    return (JSON.parse(payload) as Frame).response!.error!;
  }

  test("EOF 合成过载终态带帧内建议", () => {
    expect(tail({ type: "server_error", code: "server_is_overloaded" }).headers)
      .toEqual({ "retry-after": String(DEFAULT_OVERLOAD_RETRY_AFTER_SEC) });
  });

  test("refusal 终态不注入（保持 #5176 的不可重试语义）", () => {
    expect(tail({ type: "server_error", code: "server_is_overloaded" }, "invalid_prompt").headers).toBeUndefined();
  });

  test("上游裸事件自带建议时不注入（幂等）", () => {
    expect(tail({ type: "server_error", code: "server_is_overloaded" }, undefined, true).headers).toBeUndefined();
  });

  test("429 类不注入（429-only 默认语义不搬进流内）", () => {
    expect(tail({ type: "rate_limit_error", code: "rate_limit_exceeded" }).headers).toBeUndefined();
  });

  test("generic 502 不注入", () => {
    expect(tail({ type: "server_error", code: "server_error" }).headers).toBeUndefined();
  });
});

describe("overload retry advice: HTTP 503 (formatPassthroughUpstreamError)", () => {
  test("合成 503 + 过载码带 Retry-After", () => {
    const body = JSON.stringify({ error: { type: "server_error", code: "server_is_overloaded", message: "overloaded" } });
    const response = formatPassthroughUpstreamError(503, body);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe(String(DEFAULT_OVERLOAD_RETRY_AFTER_SEC));
  });

  test("上游合法 Retry-After 保留且不被缩短", () => {
    const body = JSON.stringify({ error: { code: "server_is_overloaded", message: "overloaded" } });
    const response = formatPassthroughUpstreamError(503, body, { headers: new Headers({ "retry-after": "30" }) });
    expect(response.headers.get("retry-after")).toBe("30");
  });

  test("503 非过载体不带建议", () => {
    const response = formatPassthroughUpstreamError(503, JSON.stringify({ error: { message: "no healthy upstream" } }));
    expect(response.headers.get("retry-after")).toBeNull();
  });

  test("replay refusal 永远不带 Retry-After（x-should-retry:false 语义不变）", () => {
    const body = JSON.stringify({ error: { type: "server_error", code: UPSTREAM_RESET_REPLAY_REFUSED_CODE, message: "refused" } });
    const headers = new Headers({ "content-type": "application/json" });
    applyReplayRefusalClientHeaders(headers);
    const response = formatPassthroughUpstreamError(503, body, { headers, suppressRetryAfter: true, replayRefusal: true });
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get(REPLAY_REFUSAL_NO_RETRY_HEADER)).toBe(REPLAY_REFUSAL_NO_RETRY_VALUE);
  });

  test("429 insufficient_quota 不被过载路径加建议（429-only 规则不变）", () => {
    const body = JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota", message: "quota exhausted" } });
    const response = formatPassthroughUpstreamError(429, body);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  test("429 可重试路径不受影响", () => {
    const body = JSON.stringify({ error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "slow down" } });
    const response = formatPassthroughUpstreamError(429, body);
    expect(response.headers.get("retry-after")).toBe("2");
  });
});

describe("overload retry advice: env parsing", () => {
  const env = (value: string | undefined): Record<string, string | undefined> => ({ [OVERLOAD_RETRY_AFTER_SEC_ENV]: value });
  test("默认 2", () => {
    expect(overloadRetryAfterSec({})).toBe(2);
    expect(overloadRetryAfterSec(env(""))).toBe(2);
  });
  test("非法值回落默认", () => {
    for (const bad of ["nope", "-3", "0", "NaN", "  "]) expect(overloadRetryAfterSec(env(bad))).toBe(DEFAULT_OVERLOAD_RETRY_AFTER_SEC);
  });
  test("上限钳制 60", () => {
    expect(overloadRetryAfterSec(env("600"))).toBe(OVERLOAD_RETRY_AFTER_SEC_LIMIT);
    expect(overloadRetryAfterSec(env("60"))).toBe(60);
  });
  test("小数向下取整", () => {
    expect(overloadRetryAfterSec(env("3.9"))).toBe(3);
  });
  test("env 覆盖", () => {
    expect(overloadRetryAfterSec(env("5"))).toBe(5);
    expect(overloadRetryAfterHeader(env("5"))).toBe("5");
  });
});

describe("overload retry advice: leaf helpers", () => {
  test("hasFrameRetryAdvice 大小写不敏感、认字符串与数字", () => {
    expect(hasFrameRetryAdvice({ "Retry-After": "4" })).toBe(true);
    expect(hasFrameRetryAdvice({ "retry-after": 4 })).toBe(true);
    expect(hasFrameRetryAdvice({ "retry-after": null })).toBe(false);
    expect(hasFrameRetryAdvice("retry-after: 4")).toBe(false);
    expect(hasFrameRetryAdvice(undefined)).toBe(false);
  });
  test("overloadCodeFromJsonBody 只认结构化码", () => {
    expect(overloadCodeFromJsonBody(JSON.stringify({ error: { code: "server_is_overloaded" } }))).toBe("server_is_overloaded");
    expect(overloadCodeFromJsonBody(JSON.stringify({ response: { error: { code: "overloaded_error" } } }))).toBe("overloaded_error");
    expect(overloadCodeFromJsonBody(JSON.stringify({ error: { message: "server_is_overloaded in copy" } }))).toBeUndefined();
    expect(overloadCodeFromJsonBody("not json")).toBeUndefined();
    expect(overloadCodeFromJsonBody("")).toBeUndefined();
  });
  test("overloadRetryAdviceForTerminal 对非终态返回 undefined", () => {
    expect(overloadRetryAdviceForTerminal({ type: "response.completed" }, "2")).toBeUndefined();
    expect(overloadRetryAdviceForTerminal({ type: "response.failed" }, "2")).toBeUndefined();
  });
});
