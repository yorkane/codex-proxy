import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import {
  codexWsPreOutputRefusalHold,
  codexWsPreOutputRefusalStatus,
  codexWsSocketDeathStage,
  isCodexWsPreOutputRefusal,
  isCodexWsUpstreamResponse,
  readCodexWsStage,
  restoreCodexWsPreOutputRefusal,
} from "../../src/server/responses/codex-ws-wire";
import { isNonReplayableResponse } from "../../src/lib/upstream-retry";
import { BOUNDED_WS_RUNTIME, streamingInit } from "../helpers/ws-upstream-fixtures";

/**
 * #6969: the Codex WebSocket used to commit a 200 at `response.created`, so an upstream that then
 * refused the turn with a structured 5xx and no output reached no retry layer at all. With the
 * opt-in hold, such a refusal settles as a replayable gateway status and can be restored to the
 * original stream; every other outcome must stay exactly what it was.
 *
 * Extended by the 2026-10-23 unified model-request lane: the gate covers every structured
 * 400..599 refusal (401/403/404/429 quota identities/500/502/503/504/507/599 and the bare
 * capacity sentence), an upstream `retryable: false` or `x-should-retry: false` hint exempts
 * nothing, and conflicting/malformed declarations project nothing at all. Native-control exchanges
 * deliberately keep today's in-body terminal for post-preamble refusals: the steering/injection
 * channel owns a multi-response session whose state mutates before the gate is consulted, so a
 * mid-turn refusal there is not replayable as one whole turn (root ruling 2026-10-23); the
 * pre-commit refused-create 4xx projection still runs under native control.
 */

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const HOLD_MS = 10_000;

type Listener = (event: unknown) => void;

/** Minimal scriptable stand-in for Bun's WebSocket, mirroring `ws-ambiguous-resend.test.ts`. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static script: (ws: FakeWebSocket) => void = () => {};
  url: string;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => FakeWebSocket.script(this));
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  frame(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() { this.closed = true; }
}

const RealWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.script = () => {};
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.WebSocket = RealWebSocket;
  codexWsPool.dispose();
});

function installFake(script: (ws: FakeWebSocket) => void) {
  FakeWebSocket.script = script;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
}

const noFallback = (async () => {
  throw new Error("fallback must not run after open");
}) as unknown as typeof fetch;

function exchange(
  script: (ws: FakeWebSocket) => void,
  holdMs = HOLD_MS,
  until = Number.MAX_SAFE_INTEGER,
): Promise<Response> {
  installFake(script);
  return codexWsUpstreamFetch(
    CODEX_URL, streamingInit(), noFallback, BOUNDED_WS_RUNTIME,
    undefined, undefined, undefined, undefined, undefined, { maxMs: holdMs, until },
  );
}

const CREATED = { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } };
const IN_PROGRESS = { type: "response.in_progress", response: { id: "resp_1", status: "in_progress", output: [] } };
const OVERLOADED = {
  type: "error",
  status: 503,
  error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." },
};
const SERVER_ERROR = {
  type: "error",
  status: 502,
  error: { type: "server_error", message: "An error occurred while processing your request." },
};
const FAILED_OVERLOADED = {
  type: "response.failed",
  response: { id: "resp_1", status: "failed", output: [], error: { code: "server_is_overloaded", message: "overloaded" } },
};
const OUTPUT_ITEM = {
  type: "response.output_item.added",
  response_id: "resp_1",
  output_index: 0,
  item: { id: "msg_1", type: "message", role: "assistant", content: [] },
};
const QUOTA = (percent: number) => ({
  type: "codex.rate_limits",
  rate_limits: { primary: { used_percent: percent, window_minutes: 10080 } },
});

function opened(...frames: unknown[]): (ws: FakeWebSocket) => void {
  return ws => {
    ws.emit("open", {});
    for (const frame of frames) ws.frame(frame);
  };
}

describe("an authoritative refusal before any output becomes a replayable gateway status (#6969)", () => {
  test("after an empty created/in_progress preamble", async () => {
    const projection = await exchange(opened(CREATED, IN_PROGRESS, OVERLOADED));
    expect(projection.status).toBe(503);
    expect(isNonReplayableResponse(projection)).toBe(false);
    expect(isCodexWsPreOutputRefusal(projection)).toBe(true);
    expect(await projection.clone().json()).toMatchObject({ error: { code: "server_is_overloaded" } });
    const stage = readCodexWsStage(projection);
    expect(stage).toMatchObject({ sent: true, relayedEvents: 3, terminalEvent: "error", terminalErrorStatus: 503 });

    const restored = restoreCodexWsPreOutputRefusal(projection);
    expect(restored.status).toBe(200);
    expect(restored.headers.get("content-type")).toContain("text/event-stream");
    expect(isCodexWsUpstreamResponse(restored)).toBe(true);
    // The same record object: the attempt that adopted it keeps one stage.
    expect(readCodexWsStage(restored)).toBe(stage);
    const body = await restored.text();
    const order = ["event: response.created", "event: response.in_progress", "event: error"].map(marker => body.indexOf(marker));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain("server_is_overloaded");
    // Single use.
    expect(restoreCodexWsPreOutputRefusal(projection)).toBe(projection);
  });

  test("as the first Responses event, with the wrapper's own 5xx", async () => {
    const projection = await exchange(opened(SERVER_ERROR));
    expect(projection.status).toBe(502);
    expect(isNonReplayableResponse(projection)).toBe(false);
    const body = await restoreCodexWsPreOutputRefusal(projection).text();
    expect(body.startsWith("event: error")).toBe(true);
  });

  test("as an empty response.failed carrying the overload class", async () => {
    const projection = await exchange(opened(CREATED, FAILED_OVERLOADED));
    expect(projection.status).toBe(503);
    expect(isCodexWsPreOutputRefusal(projection)).toBe(true);
  });

  test("restored headers keep the prelude frozen at the first Responses event", async () => {
    const projection = await exchange(opened(QUOTA(10), CREATED, QUOTA(20), OVERLOADED));
    expect(projection.status).toBe(503);
    const restored = restoreCodexWsPreOutputRefusal(projection);
    expect(restored.headers.get("x-codex-primary-used-percent")).toBe("10");
  });

  test("过载投影在缺失建议时补 Retry-After，帧体自带值不被覆盖（幂等）", async () => {
    const projection = await exchange(opened(CREATED, OVERLOADED));
    expect(projection.status).toBe(503);
    expect(projection.headers.get("retry-after")).toBe("2");
    const withAdvice = { ...OVERLOADED, headers: { "retry-after": "30" } };
    const carried = await exchange(opened(CREATED, withAdvice));
    expect(carried.status).toBe(503);
    expect(carried.headers.get("retry-after")).toBe("30");
    // 统一 lane：所有投影都带可执行等待指令；无建议时用默认 2s（与 SSE helper 同口径）
    const gateway = await exchange(opened(CREATED, SERVER_ERROR));
    expect(gateway.status).toBe(502);
    expect(gateway.headers.get("retry-after")).toBe("2");
    // 完整下界不被缩短：文案提示与帧头并存时取最大
    const both = { ...OVERLOADED, headers: { "retry-after": "120" },
      error: { ...OVERLOADED.error, message: "Our servers are currently overloaded. Try again in 30s." } };
    const honoured = await exchange(opened(CREATED, both));
    expect(honoured.headers.get("retry-after")).toBe("120");
    // 只有文案提示时，提示就是下界
    const hinted = { type: "error", status: 503, error: { code: "server_is_overloaded", message: "Try again in 45s." } };
    const fromHint = await exchange(opened(CREATED, hinted));
    expect(fromHint.headers.get("retry-after")).toBe("45");
  });
});

describe("everything else keeps today's settle", () => {
  async function committed(response: Response): Promise<string> {
    expect(response.status).toBe(200);
    expect(isCodexWsPreOutputRefusal(response)).toBe(false);
    return response.text();
  }

  test("without the opt-in the refusal is relayed in a committed 200", async () => {
    const body = await committed(await exchange(opened(CREATED, IN_PROGRESS, OVERLOADED), 0));
    expect(body).toContain("server_is_overloaded");
  });

  test("once output started the refusal stays in the body", async () => {
    const body = await committed(await exchange(opened(CREATED, OUTPUT_ITEM, OVERLOADED)));
    expect(body).toContain("response.output_item.added");
    expect(body).toContain("server_is_overloaded");
  });

  test("a created snapshot that already carries output commits", async () => {
    const resumed = { type: "response.created", response: { id: "resp_1", output: [{ id: "msg_0", type: "message" }] } };
    expect(await committed(await exchange(opened(resumed, OVERLOADED)))).toContain("server_is_overloaded");
  });

  test.each([
    ["a foreign stream id", { ...OVERLOADED, stream_id: "other" }],
    ["doubled wrapper aliases", { ...OVERLOADED, status_code: 503 }],
    ["conflicting declarations inside the error", { type: "error", status: 400, error: { status: 400, status_code: 500, message: "x" } }],
    ["an out-of-range wrapper status", { type: "error", status: 200, error: { message: "x" } }],
    ["an unrecognized code without a wrapper status", { type: "error", error: { code: "mystery", message: "x" } }],
    ["a near-capacity sentence (substring, not the whole line)", { type: "error", error: { message: "the upstream is at capacity today" } }],
  ])("after the preamble, %s is relayed in the body", async (_name, frame) => {
    await committed(await exchange(opened(CREATED, frame)));
  });

  test.each([
    ["first", [] as unknown[]],
    ["after the held preamble", [CREATED]],
  ])("a refusal whose metadata cannot be projected is delivered in the body when it arrives %s", async (_name, before) => {
    const oversized = { ...OVERLOADED, headers: { "x-request-id": "a".repeat(5_000) } };
    expect(await committed(await exchange(opened(...before, oversized)))).toContain("server_is_overloaded");
  });

  test("a queue overflow while holding fails the committed body, as it did before the hold", async () => {
    const padded = (index: number) => ({
      type: "response.in_progress",
      response: { id: "resp_1", status: "in_progress", output: [], metadata: { pad: `${index}${"x".repeat(1_500_000)}` } },
    });
    const response = await exchange(opened(CREATED, ...Array.from({ length: 7 }, (_, index) => padded(index))));
    expect(response.status).toBe(200);
    expect(isCodexWsPreOutputRefusal(response)).toBe(false);
    await expect(response.text()).rejects.toThrow("buffered queue limit");
  });

  test("lifecycle frames do not extend the hold deadline", async () => {
    jest.useFakeTimers();
    let socket: FakeWebSocket | undefined;
    let settled: Response | undefined;
    const pending = exchange(ws => {
      socket = ws;
      ws.emit("open", {});
      ws.frame(CREATED);
    });
    void pending.then(response => { settled = response; });
    for (let i = 0; i < 5 && !socket; i += 1) await Promise.resolve();
    jest.advanceTimersByTime(HOLD_MS - 4_000);
    socket!.frame(IN_PROGRESS);
    jest.advanceTimersByTime(4_000);
    for (let i = 0; i < 5 && !settled; i += 1) await Promise.resolve();
    expect(settled?.status).toBe(200);
  });

  test("a first-frame 4xx keeps the existing refused-create projection", async () => {
    const response = await exchange(opened({ type: "error", status: 429, error: { code: "rate_limit_exceeded", message: "slow" } }));
    expect(response.status).toBe(429);
    expect(isCodexWsPreOutputRefusal(response)).toBe(false);
  });

  test("a terminal naming another response than the held one commits", async () => {
    const foreign = { ...FAILED_OVERLOADED, response_id: "resp_other" };
    await committed(await exchange(opened(CREATED, foreign)));
  });

  test("a socket death after the held preamble is still a failed body, not a socket-death settle", async () => {
    const response = await exchange(ws => {
      ws.emit("open", {});
      ws.frame(CREATED);
      ws.emit("close", { code: 1006 });
    });
    expect(response.status).toBe(200);
    expect(codexWsSocketDeathStage(response)).toBeUndefined();
    await expect(response.text()).rejects.toThrow("closed before a Responses terminal event");
  });

  test("a socket death before any Responses event keeps the non-replayable 502", async () => {
    const response = await exchange(ws => {
      ws.emit("open", {});
      ws.emit("close", { code: 1006 });
    });
    expect(response.status).toBe(502);
    expect(isNonReplayableResponse(response)).toBe(true);
  });

  test("the hold is bounded: the preamble commits when it expires and the turn continues", async () => {
    jest.useFakeTimers();
    let socket: FakeWebSocket | undefined;
    const pending = exchange(ws => {
      socket = ws;
      ws.emit("open", {});
      ws.frame(CREATED);
    });
    for (let i = 0; i < 5 && !socket; i += 1) await Promise.resolve();
    jest.advanceTimersByTime(HOLD_MS);
    const response = await pending;
    expect(response.status).toBe(200);
    socket!.frame({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } });
    const body = await response.text();
    expect(body.indexOf("event: response.created")).toBeLessThan(body.indexOf("event: response.completed"));
  });

  test("a native-control exchange relays a post-preamble 429 in the body", async () => {
    // 裁决（root 2026-10-23）：steering/injection 通道的所有权跨多 response，attach/continuation
    // 状态在门判定前已变更，中途拒绝不能整轮重放；预commit 4xx 投影不受影响。
    installFake(opened(CREATED, { type: "error", status: 429, error: { code: "rate_limit_exceeded", message: "slow" } }));
    const init = streamingInit();
    const prepared = prepareCodexWsRequest(CODEX_URL, init)!;
    const session = new CodexWsSession("wss://chatgpt.com/backend-api/codex/responses", prepared.headers, true);
    const nativeControl = {
      kind: "steering" as const,
      relayActive: false,
      attached: false,
      ended: false,
      attach() { return () => {}; },
      observe() { return false; },
      steer() {},
      continue() { return false; },
    };
    try {
      expect(session.reserve()).toBe(true);
      const response = await codexWsExchange({
        session, url: CODEX_URL, init, prepared, nativeControl, sseFallback: noFallback, preOutputRefusalHold: { maxMs: HOLD_MS, until: Number.MAX_SAFE_INTEGER },
      });
      expect(response.status).toBe(200);
      expect(isCodexWsPreOutputRefusal(response)).toBe(false);
    } finally { session.dispose(); }
  });
});

describe("refusal identity and hold bound", () => {
  test("structured 4xx/5xx evidence counts, malformed declarations do not", () => {
    expect(codexWsPreOutputRefusalStatus(OVERLOADED)).toBe(503);
    expect(codexWsPreOutputRefusalStatus({ type: "error", error: { code: "server_is_overloaded" } })).toBe(503);
    expect(codexWsPreOutputRefusalStatus({ type: "error", status: 500, error: { message: "boom" } })).toBe(500);
    expect(codexWsPreOutputRefusalStatus({ type: "error", status: 400, error: { message: "bad" } })).toBe(400);
    expect(codexWsPreOutputRefusalStatus({ type: "error", status: "503" })).toBeUndefined();
    expect(codexWsPreOutputRefusalStatus({ type: "error", status: 503, error: { code: "rate_limit_requests" } })).toBe(503);
    expect(codexWsPreOutputRefusalStatus({ ...FAILED_OVERLOADED, response: { ...FAILED_OVERLOADED.response, output: [{}] } }))
      .toBeUndefined();
  });

  test("the hold never exceeds 10 s, and every hold ends by half the header deadline from the send", () => {
    expect(codexWsPreOutputRefusalHold(200_000, 1_000)).toEqual({ maxMs: 10_000, until: 101_000 });
    expect(codexWsPreOutputRefusalHold(8_000, 1_000)).toEqual({ maxMs: 4_000, until: 5_000 });
  });

  test("a lifecycle frame after the hold's end commits at once", async () => {
    const response = await exchange(opened(CREATED, OVERLOADED), HOLD_MS, Date.now() - 1);
    // Nothing was held, so the refusal after it is relayed in the committed body as before.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("server_is_overloaded");
  });

  test("the hold ends at its absolute end even when the maximum is longer", async () => {
    const started = Date.now();
    const response = await exchange(ws => {
      ws.emit("open", {});
      ws.frame(CREATED);
    }, HOLD_MS, Date.now() + 50);
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(HOLD_MS);
    void response.body?.cancel();
  });
});

describe("the unified model-request lane projects every structured 4xx/5xx refusal (2026-10-23)", () => {
  test("a 429 with a rate-limit code projects with its frame's own Retry-After", async () => {
    const frame = { type: "error", status: 429, error: { code: "rate_limit_exceeded", message: "slow down" }, headers: { "retry-after": "30" } };
    const projection = await exchange(opened(CREATED, frame));
    expect(projection.status).toBe(429);
    expect(isCodexWsPreOutputRefusal(projection)).toBe(true);
    expect(isNonReplayableResponse(projection)).toBe(false);
    expect(projection.headers.get("retry-after")).toBe("30");
    expect(await projection.clone().json()).toMatchObject({ error: { code: "rate_limit_exceeded" } });
    // The projection strips upstream retry hints it does not own.
    expect(projection.headers.get("x-should-retry")).toBeNull();
    const body = await restoreCodexWsPreOutputRefusal(projection).text();
    expect(body).toContain("rate_limit_exceeded");
  });

  test.each([
    ["usage_limit_reached 503", { type: "error", status: 503, error: { code: "usage_limit_reached", message: "limit" } }, 503],
    ["quota-worded 502", { type: "error", status: 502, error: { message: "You exceeded your current quota" } }, 502],
    ["a 401", { type: "error", status: 401, error: { code: "authentication_error", message: "expired" } }, 401],
    ["a 403", { type: "error", status: 403, error: { code: "permission_error", message: "no access" } }, 403],
    ["a 404", { type: "error", status: 404, error: { code: "not_found_error", message: "gone" } }, 404],
    ["a 500", { type: "error", status: 500, error: { message: "boom" } }, 500],
    ["a 507", { type: "error", status: 507, error: { message: "storage" } }, 507],
    ["a 599", { type: "error", status: 599, error: { message: "weird edge" } }, 599],
    ["a statusless policy code", { type: "error", error: { code: "cyber_policy", message: "blocked" } }, 400],
    ["an invalid_prompt failed terminal", { type: "response.failed", response: { id: "resp_1", status: "failed", output: [], error: { code: "invalid_prompt", message: "prompt flagged" } } }, 400],
    ["a declared status over a policy code", { type: "error", status: 403, error: { code: "invalid_prompt", message: "flagged" } }, 403],
    ["the bare capacity sentence", { type: "error", error: { message: "Selected model is at capacity" } }, 503],
    ["the capacity sentence with a trailing period", { type: "error", error: { message: "Selected model is at capacity." } }, 503],
    ["the try-a-different-model variant", { type: "error", error: { message: "selected model is at capacity. please try a different model" } }, 503],
    ["the try-again-later variant", { type: "error", error: { message: "Selected model is at capacity. Please try again later." } }, 503],
    ["the comma try-again-later variant", { type: "response.failed", response: { id: "resp_1", status: "failed", output: [], error: { message: "selected model is at capacity, please try again later" } } }, 503],
  ])("%s settles as a replayable gateway %i", async (_name, frame, expected) => {
    const projection = await exchange(opened(CREATED, frame));
    expect(projection.status).toBe(expected);
    expect(isCodexWsPreOutputRefusal(projection)).toBe(true);
    expect(isNonReplayableResponse(projection)).toBe(false);
    void restoreCodexWsPreOutputRefusal(projection).body?.cancel();
  });

  test("an upstream retryable:false hint does not exempt the projection", async () => {
    const frame = { type: "error", status: 429, error: { code: "rate_limit_exceeded", message: "slow", retryable: false }, headers: { "x-should-retry": false } };
    const projection = await exchange(opened(CREATED, frame));
    expect(projection.status).toBe(429);
    const json = await projection.clone().json() as { error: Record<string, unknown> };
    expect(json.error.retryable).toBeUndefined();
    expect(projection.headers.get("x-should-retry")).toBeNull();
    void restoreCodexWsPreOutputRefusal(projection).body?.cancel();
  });

  test("the whole 4xx family relays in the body when the hold is off", async () => {
    const frame = { type: "error", status: 429, error: { code: "rate_limit_exceeded", message: "slow" } };
    const body = await (await exchange(opened(CREATED, frame), 0)).text();
    expect(body).toContain("rate_limit_exceeded");
  });

  test("status declared once inside the error projects without a wrapper alias", () => {
    expect(codexWsPreOutputRefusalStatus({ type: "error", error: { status: 429, message: "busy" } })).toBe(429);
    expect(codexWsPreOutputRefusalStatus({ type: "response.failed", response: { status: "failed", output: [], error: { status_code: "503", message: "overloaded" } } })).toBe(503);
    // Conflicting declarations project nothing (never a fallback-invented status).
    expect(codexWsPreOutputRefusalStatus({ type: "error", status: 400, error: { status: 400, status_code: 500, message: "x" } })).toBeUndefined();
    expect(codexWsPreOutputRefusalStatus({ type: "error", status: 200, error: { message: "x" } })).toBeUndefined();
    expect(codexWsPreOutputRefusalStatus({ type: "error", status: 503, error: { code: "rate_limit_requests", status: 400 } })).toBeUndefined();
  });
});

describe("the projection keeps the full Retry-After lower bound across every candidate (root review 2026-10-23)", () => {
  // 元数据通道的 prelude 头与安全白名单同源：`codex.response.metadata` 帧可以把上游
  // retry-after 放进 prelude，帧顶层 headers 的投影则会覆盖它——max 必须把两个都收进候选。
  const RA60 = { type: "codex.response.metadata", headers: { "retry-after": "60" } };

  test("prelude 60 with a top-level frame header of 2 projects 60, not the covering 2", async () => {
    const frame = { ...OVERLOADED, headers: { "retry-after": "2" } };
    const projection = await exchange(opened(RA60, CREATED, frame));
    expect(projection.status).toBe(503);
    expect(projection.headers.get("retry-after")).toBe("60");
    void restoreCodexWsPreOutputRefusal(projection).body?.cancel();
  });

  test("a nested response.failed error.headers Retry-After of 30 is read despite rejectionHeaders dropping it", async () => {
    const failed = { type: "response.failed", response: { id: "resp_1", status: "failed", output: [], error: { code: "server_is_overloaded", message: "overloaded", headers: { "Retry-After": "30" } } } };
    const projection = await exchange(opened(CREATED, failed));
    expect(projection.status).toBe(503);
    expect(projection.headers.get("retry-after")).toBe("30");
    void restoreCodexWsPreOutputRefusal(projection).body?.cancel();
  });

  test("a fractional delta-seconds value is never parsed as a past HTTP-date", async () => {
    // '1.5' 进 Date.parse 会变成一个过去的日期，下界被截成 0 再抬成 1s，缩短上游指令。
    const frame = { ...OVERLOADED, headers: { "retry-after": "1.5" } };
    const projection = await exchange(opened(CREATED, frame));
    expect(projection.status).toBe(503);
    const seconds = Number(projection.headers.get("retry-after"));
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(1.5);
    expect(projection.headers.get("retry-after")).toBe("2");
    void restoreCodexWsPreOutputRefusal(projection).body?.cancel();
  });
});
