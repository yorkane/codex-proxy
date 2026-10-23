import { describe, expect, test } from "bun:test";
import {
  CAPACITY_PRE_OUTPUT_MAX_BYTES,
  disposeCapacityPreOutput,
  isCapacityPreOutput,
  isPreOutputErrorProjection,
  projectPreOutputCapacity,
  preOutputProjectionStatus,
  restoreCapacityPreOutput,
} from "../../src/server/responses/capacity-pre-output";
import { markResponseNonReplayable } from "../../src/lib/upstream-retry";
import { hasResponseDisposal } from "../../src/lib/response-disposal";

/**
 * HTTP/SSE 预输出模型错误投影（fork）：上游 200 + SSE 的结构化 4xx/5xx 终态在首字之前被
 * 有界识别并投影成网关状态，交给统一重试阶梯；阶梯耗尽时逐字还原成原本那条流。
 * 操作员的"全部模型 4xx/5xx 至少重试 10 次"合同让配额/限流/策略身份也进入投影。
 */

const ENCODER = new TextEncoder();
const CREATED = { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } };
const IN_PROGRESS = { type: "response.in_progress", response: { id: "resp_1", status: "in_progress", output: [] } };
const HEARTBEAT = { type: "response.heartbeat" };

function frame(payload: unknown, newline = "\n"): string {
  return `data: ${JSON.stringify(payload)}${newline}${newline}`;
}

function comment(text: string, newline = "\n"): string {
  return `: ${text}${newline}${newline}`;
}

/** 按给定偏移切字节流：故意切断 CRLF 与多字节字符，验证分片解码与字节保真。 */
function splitBytes(text: string, offsets: number[]): Uint8Array[] {
  const bytes = ENCODER.encode(text);
  const parts: Uint8Array[] = [];
  let index = 0;
  for (const offset of [...offsets].sort((a, b) => a - b)) {
    if (offset <= index || offset >= bytes.byteLength) continue;
    parts.push(bytes.subarray(index, offset));
    index = offset;
  }
  parts.push(bytes.subarray(index));
  return parts.filter(part => part.byteLength > 0);
}

type Source = { response: Response; cancelled: () => boolean; reads: () => number };

/** 可控上游：脚本化分片 + 可选挂起，并记录 cancel 与物理读取次数。 */
function sseSource(chunks: Uint8Array[], options: { stall?: boolean; contentType?: string | null } = {}): Source {
  let cancelCount = 0;
  let readCount = 0;
  let queued = [...chunks];
  let stalled = options.stall === true;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      readCount += 1;
      if (queued.length > 0) {
        controller.enqueue(queued.shift()!);
        return;
      }
      if (stalled) {
        stalled = false;
        return new Promise<void>(() => {});
      }
      controller.close();
    },
    cancel() {
      cancelCount += 1;
    },
  });
  const headers = new Headers();
  if (options.contentType !== null) headers.set("content-type", options.contentType ?? "text/event-stream; charset=utf-8");
  headers.set("x-upstream-marker", "keep-me");
  return { response: new Response(body, { status: 200, headers }), cancelled: () => cancelCount > 0, reads: () => readCount };
}

async function drain(response: Response): Promise<string> {
  return await response.text();
}

/** 读满前缀后取消：挂起型上游不能 drain 到底。 */
async function readPrefix(response: Response, expected: string): Promise<void> {
  const reader = response.body!.getReader();
  let text = "";
  while (text.length < expected.length) {
    const next = await reader.read();
    expect(next.done).toBe(false);
    text += new TextDecoder().decode(next.value);
  }
  expect(text).toBe(expected);
  await reader.cancel("test done");
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("预输出终态投影成网关状态（操作员扩容合同：全部模型 4xx/5xx）", () => {
  const cases: Array<{ name: string; frame: unknown; status: number; code?: string }> = [
    { name: "503 过载码", frame: { type: "error", status: 503, error: { type: "server_error", code: "server_is_overloaded", message: "overloaded" } }, status: 503, code: "server_is_overloaded" },
    { name: "503 overloaded_error", frame: { type: "response.failed", response: { id: "resp_1", status: "failed", output: [], error: { code: "overloaded_error", message: "overloaded" } } }, status: 503, code: "overloaded_error" },
    { name: "502 网关态", frame: { type: "error", status: 502, error: { type: "server_error", message: "bad gateway" } }, status: 502 },
    { name: "429 限流（配额身份不再否决）", frame: { type: "error", status: 429, error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "slow down" } }, status: 429, code: "rate_limit_exceeded" },
    { name: "401 凭据", frame: { type: "error", status: 401, error: { type: "authentication_error", code: "authentication_error", message: "expired" } }, status: 401, code: "authentication_error" },
    { name: "403 策略", frame: { type: "error", status: 403, error: { type: "permission_error", code: "permission_error", message: "forbidden" } }, status: 403, code: "permission_error" },
    { name: "404 模型缺失", frame: { type: "error", status: 404, error: { type: "not_found_error", code: "not_found_error", message: "no model" } }, status: 404, code: "not_found_error" },
    { name: "400 请求被拒", frame: { type: "error", status: 400, error: { type: "invalid_request_error", code: "invalid_request_error", message: "bad" } }, status: 400, code: "invalid_request_error" },
    { name: "520 上游代理态", frame: { type: "error", status: 520, error: { type: "server_error", message: "web server returned an unknown response" } }, status: 520 },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const source = sseSource(splitBytes(comment("keep-alive") + frame(CREATED) + frame(IN_PROGRESS), [7, 19, 33])
        .concat(ENCODER.encode(frame(testCase.frame))));
      const projection = await projectPreOutputCapacity(source.response, { maxWaitMs: 500 });
      const prefix = ": keep-alive\n\n" + frame(CREATED) + frame(IN_PROGRESS);
      expect(isCapacityPreOutput(projection)).toBe(true);
      expect(projection.status).toBe(testCase.status);
      expect(preOutputProjectionStatus(projection)).toBe(testCase.status);
      expect(projection.headers.get("content-type")).toContain("application/json");
      expect(projection.headers.get("x-should-retry")).toBeNull();
      expect(projection.headers.get("retry-after")).toBe("2");
      const body = await projection.json() as { error: Record<string, string> };
      expect(body.error.code ?? testCase.code).toBe(testCase.code);
      expect(JSON.stringify(body)).not.toContain("retryable");
      // 已缓冲的字节（前奏 + 终态帧本身）不能消失：还原后逐字交付。
      const restored = restoreCapacityPreOutput(projection);
      expect(restored.status).toBe(200);
      expect(await drain(restored)).toBe(prefix + frame(testCase.frame));
    });
  }

  test("现场原报句无码无状态也映射 503", async () => {
    const message = "Selected model is at capacity. Please try a different model.";
    const source = sseSource([ENCODER.encode(frame(CREATED) + frame({
      type: "response.failed",
      response: { id: "resp_1", status: "failed", output: [], error: { type: "server_error", message } },
    }))]);
    const projection = await projectPreOutputCapacity(source.response, { maxWaitMs: 500 });
    expect(projection.status).toBe(503);
    expect(((await projection.clone().json()) as { error: { message: string } }).error.message).toBe(message);
  });

  test("try-again-later 整句变体无码无状态映射 503（exact alias，不泛 substring）", async () => {
    for (const message of [
      "Selected model is at capacity. Please try again later.",
      "Selected model is at capacity. Please try again later",
    ]) {
      const source = sseSource([ENCODER.encode(frame(CREATED) + frame({
        type: "error", error: { type: "server_error", message },
      }))]);
      expect((await projectPreOutputCapacity(source.response, { maxWaitMs: 500 })).status).toBe(503);
    }
    // 近邻句式不命中：句子中间塞词不做子串匹配。
    const near = sseSource([ENCODER.encode(frame(CREATED) + frame({
      type: "error", error: { type: "server_error", message: "Selected model is at capacity. See status page." },
    }))]);
    expect(isPreOutputErrorProjection(await projectPreOutputCapacity(near.response, { maxWaitMs: 500 }))).toBe(false);
  });

  test("SSE 终态拒绝码无数字 status 明确映射 400（上游请求拒绝进入重试合同）", async () => {
    for (const code of ["invalid_prompt", "bio_policy", "misalignment_policy_violation", "cyber_policy"]) {
      const text = frame(CREATED) + frame({
        type: "response.failed",
        response: { id: "resp_1", status: "failed", output: [], error: { type: "invalid_request_error", code, message: "refused" } },
      });
      const source = sseSource([ENCODER.encode(text)]);
      const projection = await projectPreOutputCapacity(source.response, { maxWaitMs: 500 });
      expect(projection.status).toBe(400);
      expect(((await projection.clone().json()) as { error: { code: string } }).error.code).toBe(code);
      expect(await drain(restoreCapacityPreOutput(projection))).toBe(text);
    }
  });

  test("同码 refusal 携 retryable:false 不额外否决，且上游声明 403 优先于映射", async () => {
    const text = frame(CREATED) + frame({
      type: "response.failed",
      response: { id: "resp_1", status: "failed", output: [],
        error: { type: "invalid_request_error", code: "invalid_prompt", message: "refused", retryable: false } },
    });
    const source = sseSource([ENCODER.encode(text)]);
    expect((await projectPreOutputCapacity(source.response, { maxWaitMs: 500 })).status).toBe(400);
    const stated = sseSource([ENCODER.encode(frame(CREATED) + frame({
      type: "response.failed",
      response: { id: "resp_1", status: "failed", output: [],
        error: { type: "permission_error", code: "invalid_prompt", message: "refused", retryable: false } },
      status: 403,
    }))]);
    expect((await projectPreOutputCapacity(stated.response, { maxWaitMs: 500 })).status).toBe(403);
  });

  test("显式未知码 + 同文案按文案投影（旧 code 否决作废）", async () => {
    const source = sseSource([ENCODER.encode(frame(CREATED) + frame({
      type: "error",
      error: { type: "server_error", code: "totally_unknown_code", message: "Selected model is at capacity. Please try a different model" },
    }))]);
    expect((await projectPreOutputCapacity(source.response, { maxWaitMs: 500 })).status).toBe(503);
  });

  test("Retry-After 取上游较长下界：帧 7s 覆盖响应头 2s", async () => {
    const chunks = splitBytes(frame(CREATED), [5]);
    const source = sseSource(chunks.concat(ENCODER.encode(frame({
      type: "error", status: 503,
      error: { code: "server_is_overloaded", message: "overloaded" },
      headers: { "retry-after": "7" },
    }))));
    source.response.headers.set("retry-after", "2");
    const projection = await projectPreOutputCapacity(source.response, { maxWaitMs: 500 });
    expect(projection.headers.get("retry-after")).toBe("7");
  });

  test("HTTP-date 形式的 Retry-After 归一为 delta-seconds", async () => {
    const at = new Date(Date.now() + 9_000).toUTCString();
    const source = sseSource([ENCODER.encode(frame(CREATED) + frame({
      type: "error", status: 503, error: { code: "server_is_overloaded", message: "overloaded" },
    }))]);
    source.response.headers.set("retry-after", at);
    const projection = await projectPreOutputCapacity(source.response, { maxWaitMs: 500 });
    const seconds = Number(projection.headers.get("retry-after"));
    expect(seconds >= 8 && seconds <= 10).toBe(true);
  });
});

describe("已交付内容一律直通，不重放", () => {
  const committing: Array<{ name: string; events: unknown[] }> = [
    { name: "工具输出 delta", events: [CREATED, { type: "response.output_item.added", response_id: "resp_1", output_index: 0, item: { type: "function_call", name: "shell", arguments: "" } }] },
    { name: "非空 output 快照", events: [{ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [{ type: "message", content: [] }] } }] },
    { name: "正 usage", events: [{ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [], usage: { input_tokens: 5, output_tokens: 0 } } }] },
    { name: "refusal 增量", events: [CREATED, { type: "response.refusal.delta", response_id: "resp_1", output_index: 0, item_id: "msg_1", delta: "no" }] },
    { name: "response.completed", events: [CREATED, { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }] },
    { name: "response.incomplete", events: [CREATED, { type: "response.incomplete", response: { id: "resp_1", status: "incomplete", output: [] } }] },
    { name: "带 stream_id 的帧", events: [CREATED, { type: "error", stream_id: "s1", status: 503, error: { code: "server_is_overloaded" } }] },
    { name: "未知事件名", events: [CREATED, { type: "response.mystery", response: { id: "resp_1", output: [] } }] },
    { name: "terminal 携 output", events: [CREATED, { type: "response.failed", response: { id: "resp_1", status: "failed", output: [{ type: "function_call" }], error: { code: "server_is_overloaded" } } }] },
  ];

  for (const testCase of committing) {
    test(testCase.name, async () => {
      const text = testCase.events.map(event => frame(event)).join("");
      const source = sseSource(splitBytes(text, [3, 11, 24]));
      const result = await projectPreOutputCapacity(source.response, { maxWaitMs: 500 });
      expect(isPreOutputErrorProjection(result)).toBe(false);
      expect(result.status).toBe(200);
      expect(result.headers.get("x-upstream-marker")).toBe("keep-me");
      expect(await drain(result)).toBe(text);
    });
  }

  test("终态与创建帧 id 冲突时直通", async () => {
    const text = frame({ type: "response.created", response: { id: "resp_a", status: "in_progress", output: [] } })
      + frame({ type: "response.failed", response: { id: "resp_b", status: "failed", output: [], error: { code: "server_is_overloaded" } } });
    const source = sseSource([ENCODER.encode(text)]);
    const result = await projectPreOutputCapacity(source.response, { maxWaitMs: 500 });
    expect(isPreOutputErrorProjection(result)).toBe(false);
    expect(await drain(result)).toBe(text);
  });

  test("本地歧义拒绝与 caller abort 保持原样", async () => {
    const text = frame(CREATED) + frame({ type: "error", status: 503, error: { code: "server_is_overloaded" } });
    const marked = sseSource([ENCODER.encode(text)]);
    markResponseNonReplayable(marked.response);
    expect(await projectPreOutputCapacity(marked.response, { maxWaitMs: 500 })).toBe(marked.response);

    const aborted = sseSource([ENCODER.encode(text)]);
    const controller = new AbortController();
    controller.abort("caller gone");
    expect(await projectPreOutputCapacity(aborted.response, { maxWaitMs: 500, signal: controller.signal })).toBe(aborted.response);
  });

  test("非 200 与非 SSE 直接返回", async () => {
    const json = new Response("{\"error\":{\"code\":\"server_is_overloaded\"}}", { status: 503, headers: { "content-type": "application/json" } });
    expect(await projectPreOutputCapacity(json)).toBe(json);
    const plain = new Response(ENCODER.encode("hello"), { status: 200, headers: { "content-type": "text/plain" } });
    expect(await projectPreOutputCapacity(plain)).toBe(plain);
  });
});

describe("有界窗口的失败模式不改写成功数据", () => {
  test("超时无终态：直通且字节全在（capacity 晚于窗口即透传）", async () => {
    const prefix = comment("ping") + frame(CREATED) + frame(HEARTBEAT);
    const source = sseSource(splitBytes(prefix, [4, 12, 27]), { stall: true });
    const result = await projectPreOutputCapacity(source.response, { maxWaitMs: 60 });
    expect(isPreOutputErrorProjection(result)).toBe(false);
    expect(result.status).toBe(200);
    await readPrefix(result, prefix);
  });

  test("连续心跳不延长窗口：总观察受 maxWaitMs 封顶", async () => {
    let queued = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        queued += 1;
        controller.enqueue(ENCODER.encode(queued % 2 === 0 ? frame(HEARTBEAT) : comment("hb")));
      },
    });
    const started = Date.now();
    const result = await projectPreOutputCapacity(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }), { maxWaitMs: 120 });
    expect(Date.now() - started).toBeLessThan(400);
    expect(isPreOutputErrorProjection(result)).toBe(false);
    expect(result.status).toBe(200);
  });

  test("非法 UTF-8 直通且字节逐字保留", async () => {
    const bytes = new Uint8Array([...ENCODER.encode(frame(CREATED)), 0xef, 0xbf, 0xbd ^ 0x00, 0xff, 0xfe, ...ENCODER.encode(frame({
      type: "error", status: 503, error: { code: "server_is_overloaded", message: "overloaded" },
    }))]);
    const source = sseSource([bytes.subarray(0, 20), bytes.subarray(20)]);
    const result = await projectPreOutputCapacity(source.response, { maxWaitMs: 500 });
    expect(isPreOutputErrorProjection(result)).toBe(false);
    expect(result.status).toBe(200);
    const delivered = new Uint8Array(bytes.byteLength);
    let offset = 0;
    for await (const chunk of result.body!) {
      delivered.set(chunk as Uint8Array, offset);
      offset += (chunk as Uint8Array).byteLength;
    }
    expect(Buffer.from(delivered).equals(Buffer.from(bytes))).toBe(true);
  });

  test("聚合超限直通：helper 上限与调用方上限都保留全部已读字节", async () => {
    const text = frame(CREATED) + "data: " + JSON.stringify({ type: "response.custom", blob: "x".repeat(4096) }) + "\n\n";
    const source = sseSource(splitBytes(text, [8, 16, 64]));
    const result = await projectPreOutputCapacity(source.response, { maxBytes: 256, maxWaitMs: 500 });
    expect(isPreOutputErrorProjection(result)).toBe(false);
    expect(await drain(result)).toBe(text);
    // helper 默认 64 KiB 上限是可用的默认合同。
    expect(CAPACITY_PRE_OUTPUT_MAX_BYTES).toBe(64 * 1024);
  });

  test("read 失败保留前奏并把同一个错误交给下游", async () => {
    const prefix = frame(CREATED) + frame(HEARTBEAT);
    const failure = new Error("upstream body broke");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (controller.desiredSize === null) return;
        controller.enqueue(ENCODER.encode(prefix));
        controller.error(failure);
      },
    });
    const result = await projectPreOutputCapacity(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }), { maxWaitMs: 500 });
    expect(isPreOutputErrorProjection(result)).toBe(false);
    const reader = result.body!.getReader();
    expect((await reader.read()).value).toEqual(ENCODER.encode(prefix));
    await expect(reader.read()).rejects.toBe(failure);
  });
});

describe("投影的资源释放与还原合同", () => {
  test("投影被丢弃时取消上游 reader", async () => {
    // 上游在终态帧后挂起（现场形态：拒绝后连接保持），dispose 必须触达 reader.cancel。
    const source = sseSource([ENCODER.encode(frame(CREATED) + frame({
      type: "error", status: 503, error: { code: "server_is_overloaded", message: "overloaded" },
    }))], { stall: true });
    const projection = await projectPreOutputCapacity(source.response, { maxWaitMs: 500 });
    expect(projection.status).toBe(503);
    expect(await projection.text()).toContain("server_is_overloaded");
    // 投影体已关闭，cancel 触不到上游：必须由 dispose 缝释放。
    expect(source.cancelled()).toBe(false);
    disposeCapacityPreOutput(projection);
    await tick();
    expect(source.cancelled()).toBe(true);
    expect(hasResponseDisposal(projection)).toBe(false);
    disposeCapacityPreOutput(projection);
  });

  test("未读干直接 dispose 也释放上游", async () => {
    const source = sseSource([ENCODER.encode(frame(CREATED) + frame({
      type: "error", status: 503, error: { code: "server_is_overloaded", message: "overloaded" },
    }))], { stall: true });
    const projection = await projectPreOutputCapacity(source.response, { maxWaitMs: 500 });
    disposeCapacityPreOutput(projection);
    await tick();
    expect(source.cancelled()).toBe(true);
    expect(isCapacityPreOutput(projection)).toBe(true);
  });

  test("还原后释放责任移交下游：dispose 不再杀已交付的流", async () => {
    const text = frame(CREATED) + frame({ type: "error", status: 503, error: { code: "server_is_overloaded", message: "overloaded" } });
    const source = sseSource(splitBytes(text, [5, 17]));
    const projection = await projectPreOutputCapacity(source.response, { maxWaitMs: 500 });
    const restored = restoreCapacityPreOutput(projection);
    expect(restored.status).toBe(200);
    expect(restored.headers.get("content-type")).toContain("text/event-stream");
    expect(await drain(restored)).toBe(text);
    disposeCapacityPreOutput(projection);
    expect(source.cancelled()).toBe(false);
    // 单次语义：第二次还原返回投影本身。
    expect(restoreCapacityPreOutput(projection)).toBe(projection);
  });

  test("直通流的 cancel 关闭上游且不重复消费", async () => {
    const text = frame(CREATED) + frame(HEARTBEAT);
    const source = sseSource(splitBytes(text, [6, 15]), { stall: true });
    const result = await projectPreOutputCapacity(source.response, { maxWaitMs: 60 });
    const reader = result.body!.getReader();
    let assembled = "";
    while (assembled.length < text.length) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      assembled += new TextDecoder().decode(next.value);
    }
    expect(assembled).toBe(text);
    const readsBefore = source.reads();
    await reader.cancel("client gone");
    expect(source.reads()).toBe(readsBefore);
    expect(source.cancelled()).toBe(true);
  });
});
