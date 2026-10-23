import { BoundedSseFrameBuffer } from "../sse-frame-buffer";
import { sseDataPayload } from "../sse-payload-rewrite";
import { isSafeResponseHeader } from "../safe-response-headers";
import { isTerminalRefusalCode, recognizedUpstreamError } from "../../lib/errors";
import { parseRetryAfterFromMessage } from "../../lib/retry-delay";
import { isNonReplayableResponse } from "../../lib/upstream-retry";
import { overloadRetryAfterSec } from "../../lib/overload-retry-advice";
import { disposeResponse, registerResponseDisposal, removeResponseDisposal } from "../../lib/response-disposal";

/**
 * 预输出模型错误投影（fork 扩展：HTTP/SSE 侧的 #6969）。
 *
 * 现场形态：上游以 HTTP 200 + SSE 应答，`response.created` 之后立刻用结构化 4xx/5xx 终态
 * （裸 `error` 帧或空 `response.failed`）拒绝回合。passthrough 在 200 处已提交响应头，
 * 外层重试阶梯看不见这次拒绝，于是每一次容量/过载拒绝都以"Selected model is at capacity"
 * 直接终结给客户端。本模块在响应体交给客户端之前做**有界**识别：只允许空生命周期帧 + 注释 +
 * 心跳做前奏；确认是终态拒绝后投影成网关状态 + JSON 体交给重试阶梯（操作员已把全部模型
 * 4xx/5xx 至少重试 10 次定为需求，因此配额/限流/策略身份不再否决投影，投影状态取上游声明），
 * 阶梯耗尽时逐字还原成原本那条 SSE。
 *
 * 边界（与 WS #6969 投影同形，独立登记：不把 HTTP 流伪装成 WS 配额观察）：
 * - 只处理 200 且 `text/event-stream` 且有 body 的响应；HTTP 5xx 的 JSON 分类归上游错误分类器。
 * - 前奏只允许 output 缺席或为空的 `response.created`/`response.in_progress`/`response.queued`/
 *   `response.heartbeat`、注释帧与纯分隔帧。任何输出快照、delta、`output_index`、正 usage、
 *   `response.completed`/`response.incomplete`、未知事件名、带 `stream_id` 的帧都算已交付，
 *   一律直通原流：用户没有授权重复执行已经落进客户端的内容。
 * - 投影状态取上游自己声明的证据：帧的 `status`/`status_code`（矛盾/越界声明即放弃投影），
 *   其次结构码经 `recognizedUpstreamError` 映射，最后才认 `Selected model is at capacity.
 *   Please try a different model.` 等整句文案映射 503 —— 文案只补状态，永不否决上游声明，
 *   显式未知 code 与文案同行时按文案投影（操作员 2026-10-23 扩容决定，旧 code 否决作废）。
 *   三者都给不出 400..599 时直连原流。
 * - 本地歧义拒绝（`isNonReplayableResponse`）与已经发生的 caller abort 保持原样，不投影。
 * - 有界：buffer 字节上限（默认 64 KiB）、帧数上限、总时间窗（默认 2 s，从观察开始固定，
 *   后续帧不续期，连续心跳不能无限拖住首字节）。超限、超时、UTF-8/JSON 解析失败（解码
 *   strict fatal）、read 失败全部保留已读字节直通，不吞、不改任何成功数据。
 * - `Retry-After` 取帧内 headers、原响应头与文案提示中的最大下界（更长的上游指令不被缩短），
 *   全缺失时用 `OCX_OVERLOAD_RETRY_AFTER_SEC`（默认 2 s）。投影只复制安全响应头白名单，投影体
 *   不写 `retryable`，投影头不写 `x-should-retry`：判决权在重试阶梯，不在这里。
 * - 投影是登记在 WeakMap 里的一次性替身。`restorePreOutputError` 交还原始 200 SSE（逐字）；
 *   `disposePreOutputError` 是集中释放缝：重试阶梯决定丢弃投影时必须调用，它取消原 reader ——
 *   投影 body 是已关闭的 JSON，对它 cancel 不会触达上游流，没有这个缝就会漏流。
 */

export const CAPACITY_PRE_OUTPUT_MAX_BYTES = 64 * 1024;
export const CAPACITY_PRE_OUTPUT_MAX_WAIT_MS = 2_000;
export const CAPACITY_PRE_OUTPUT_MAX_FRAMES = 512;

const MIN_PROJECTED_STATUS = 400;
const MAX_PROJECTED_STATUS = 599;

const PRE_OUTPUT_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
  "response.heartbeat",
]);

/** 把可见内容交给客户端的事件名（与 combo 预检同口径，独立实现以免拉进 combos/relay）。 */
const OUTPUT_COMMITTING_EVENT = /^response\.(?:output_item|content_part|output_text|refusal|reasoning_[^.]+|function_call_arguments|custom_tool_call_input|image_generation_call|code_interpreter_call|file_search_call|web_search_call|computer_call|tool_search_call|mcp_call)/;

/**
 * 无码无状态时唯一被承认的整句容量文案（现场原报句，小写、去尾部句点后精确匹配）。
 * 只加状态，绝不否决；不做前缀/子串匹配，避免杂文里蹭到 "at capacity"。
 */
const CAPACITY_SENTENCES: ReadonlySet<string> = new Set([
  "selected model is at capacity",
  "selected model is at capacity. please try a different model",
  "selected model is at capacity. please try again later",
  "the selected model is at capacity",
  "the selected model is at capacity. please try a different model",
  "the selected model is at capacity. please try again later",
]);

const DEFAULT_PROJECTION_MESSAGE = "Provider refused the request before producing any output";

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** 有正 tokens 就是已产出/已计费，不可回放。形态不明的 usage 也按已产出处理（一层嵌套）。 */
function usageCommits(usage: unknown): boolean {
  if (usage === undefined) return false;
  if (!plainRecord(usage)) return true;
  for (const value of Object.values(usage)) {
    if (positiveNumber(value)) return true;
    if (plainRecord(value) && Object.values(value).some(positiveNumber)) return true;
  }
  return false;
}

/** 一个 response 快照是否 output 缺席或为空；非数组的 output 不算空。 */
function emptyOutput(snapshot: Record<string, unknown>): boolean {
  const output = snapshot.output;
  return output === undefined || (Array.isArray(output) && output.length === 0);
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** 文案归一化：小写、去首尾空白、去尾部句点；句中句号保留，整句精确匹配用。 */
function normalizeSentence(message: string): string {
  return message.trim().toLowerCase().replace(/\.+$/, "");
}

/** `Retry-After` 的一个候选下界（毫秒）：delta-seconds 与 HTTP-date 两种形式都认。 */
function retryAfterValueMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.ceil(value * 1000);
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric * 1000);
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, Math.ceil(dateMs - Date.now()));
}

function headerAdviceMs(headers: Headers | undefined, ...sources: unknown[]): number[] {
  const out: number[] = [];
  if (headers) {
    const value = retryAfterValueMs(headers.get("retry-after"));
    if (value !== undefined) out.push(value);
  }
  for (const source of sources) {
    if (!plainRecord(source)) continue;
    for (const [name, value] of Object.entries(source)) {
      if (name.toLowerCase() !== "retry-after") continue;
      const ms = retryAfterValueMs(value);
      if (ms !== undefined) out.push(ms);
    }
  }
  return out;
}

export type PreOutputProjectionSpec = {
  status: number;
  type: string;
  code?: string;
  message: string;
  /** 上游给出的 `Retry-After` 下界候选（毫秒）。 */
  adviceMs: number[];
};

/**
 * 帧自己声明的状态。返回 `undefined` 表示帧没有声明（可以继续用结构码/文案映射）；
 * 返回 `"conflict"` 表示声明了但不是单个 400..599 整数 —— 矛盾证据，放弃投影。
 */
function statedStatus(
  payload: Record<string, unknown>,
  error: Record<string, unknown>,
): number | "conflict" | undefined {
  const stated: number[] = [];
  for (const value of [payload.status, payload.status_code, error.status, error.status_code]) {
    if (typeof value === "number") {
      if (!Number.isInteger(value)) return "conflict";
      stated.push(value);
    } else if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
      stated.push(Number(value.trim()));
    } else if (value !== undefined && value !== null) {
      return "conflict";
    }
  }
  if (stated.length === 0) return undefined;
  if (stated.some(value => value !== stated[0])) return "conflict";
  const status = stated[0]!;
  return status >= MIN_PROJECTED_STATUS && status <= MAX_PROJECTED_STATUS ? status : "conflict";
}

/** 终态拒绝的结构证据；拿不到可投影状态时返回 undefined（直通原流）。 */
export function preOutputTerminalSpec(payload: Record<string, unknown>): PreOutputProjectionSpec | undefined {
  if (payload.stream_id !== undefined) return undefined;
  const type = payload.type;
  let error: Record<string, unknown>;
  if (type === "error") {
    if (payload.error !== undefined && !plainRecord(payload.error)) return undefined;
    error = plainRecord(payload.error) ? payload.error : payload;
  } else if (type === "response.failed") {
    const snapshot = payload.response;
    if (snapshot !== undefined && !plainRecord(snapshot)) return undefined;
    if (snapshot && (!emptyOutput(snapshot) || usageCommits(snapshot.usage))) return undefined;
    if (snapshot?.error !== undefined && !plainRecord(snapshot.error)) return undefined;
    if (snapshot?.last_error !== undefined && !plainRecord(snapshot.last_error)) return undefined;
    const declared = snapshot?.error ?? snapshot?.last_error ?? payload.error;
    error = plainRecord(declared) ? declared : {};
  } else {
    return undefined;
  }

  const code = typeof error.code === "string" ? error.code
    : typeof payload.code === "string" ? payload.code : undefined;
  const rawType = typeof error.type === "string" && error.type !== "error" ? error.type : undefined;
  const message = typeof error.message === "string" ? error.message
    : typeof payload.message === "string" ? payload.message : "";

  const stated = statedStatus(payload, error);
  if (stated === "conflict") return undefined;
  let status: number | undefined = stated;
  if (status === undefined) status = recognizedUpstreamError({ type: rawType, code })?.httpStatus;
  // 上游终态拒绝码（invalid_prompt / cyber_policy / bio_policy / misalignment_policy_violation）
  // 是真实的上游请求拒绝：SSE 里常不带数字 status，操作员合同要求全部 4xx/5xx 可重试，
  // 明确映射 400。`retryable: false` 不额外否决；本地合成的 refusalResponse 带
  // non-replayable 标记，由入口的门挡住，不走这条映射。
  if (status === undefined && code !== undefined && isTerminalRefusalCode(code)) status = 400;
  if (status === undefined && CAPACITY_SENTENCES.has(normalizeSentence(message))) status = 503;
  if (status === undefined) return undefined;
  if (status < MIN_PROJECTED_STATUS || status > MAX_PROJECTED_STATUS) return undefined;

  const adviceMs = headerAdviceMs(undefined, payload.headers, error.headers);
  const hint = parseRetryAfterFromMessage(message);
  if (hint !== undefined) adviceMs.push(hint * 1000);

  const projectionType = rawType ?? (status === 503 ? "server_error" : "upstream_error");
  return {
    status,
    type: projectionType,
    ...(code === undefined ? {} : { code }),
    message: message || DEFAULT_PROJECTION_MESSAGE,
    adviceMs,
  };
}

type FrameVerdict =
  | { kind: "prelude"; ids: string[] | null }
  | { kind: "commit"; ids: null }
  | { kind: "project"; spec: PreOutputProjectionSpec; ids: string[] | null };

/** 帧名的 response id（嵌套 `response.id` 与顶层 `response_id`）；非字符串即冲突信号。 */
function frameResponseIds(
  payload: Record<string, unknown>,
  snapshot: Record<string, unknown> | undefined,
): string[] | null {
  const ids: string[] = [];
  for (const value of [snapshot?.id, payload.response_id]) {
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    if (!ids.includes(value)) ids.push(value);
  }
  return ids;
}

/** 一帧的分类：允许的前奏 / 已交付（直通）/ 可投影终态。 */
function classifyFrame(text: string): FrameVerdict {
  const payloadText = sseDataPayload(text);
  if (payloadText === null) {
    const lines = text.split(/\r\n|\r|\n/).filter(line => line.length > 0);
    // 注释帧与纯分隔帧不承载任何客户端可见内容。
    if (lines.length === 0 || lines.every(line => line.startsWith(":"))) return { kind: "prelude", ids: [] };
    return { kind: "commit", ids: null };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { kind: "commit", ids: null };
  }
  if (!plainRecord(payload)) return { kind: "commit", ids: null };
  const type = payload.type;
  if (typeof type !== "string") return { kind: "commit", ids: null };
  if (payload.stream_id !== undefined) return { kind: "commit", ids: null };
  if (Object.hasOwn(payload, "output_index")) return { kind: "commit", ids: null };
  if (OUTPUT_COMMITTING_EVENT.test(type)) return { kind: "commit", ids: null };
  const snapshot = plainRecord(payload.response) ? payload.response : undefined;
  if (snapshot) {
    if (!emptyOutput(snapshot)) return { kind: "commit", ids: null };
    if (usageCommits(snapshot.usage)) return { kind: "commit", ids: null };
    if (snapshot.status === "completed") return { kind: "commit", ids: null };
  }
  if (usageCommits(payload.usage)) return { kind: "commit", ids: null };
  if (type === "response.failed" || type === "error") {
    const spec = preOutputTerminalSpec(payload);
    if (!spec) return { kind: "commit", ids: null };
    return { kind: "project", spec, ids: frameResponseIds(payload, snapshot) };
  }
  if (type === "response.completed" || type === "response.incomplete") return { kind: "commit", ids: null };
  if (!PRE_OUTPUT_LIFECYCLE_EVENTS.has(type)) return { kind: "commit", ids: null };
  return { kind: "prelude", ids: frameResponseIds(payload, snapshot) };
}

interface PreOutputProjectionRecord {
  restore: (() => Response) | null;
  status: number;
}

const preOutputProjections = new WeakMap<Response, PreOutputProjectionRecord>();

export type PreOutputProjectionOptions = {
  signal?: AbortSignal;
  maxWaitMs?: number;
  maxBytes?: number;
  env?: Record<string, string | undefined>;
};

type ReadStep = { kind: "value"; value: Uint8Array } | { kind: "done" } | { kind: "stop" };

/**
 * 有界识别一段 Responses SSE 的预输出终态。返回投影 503/4xx，或**逐字保真的直通 Response**
 * （已读字节全部回放、同一 reader 续读，绝不二次消费）。
 */
export async function projectPreOutputError(
  response: Response,
  opts: PreOutputProjectionOptions = {},
): Promise<Response> {
  const body = response.body;
  if (!body || response.status !== 200) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) return response;
  if (isNonReplayableResponse(response)) return response;
  const signal = opts.signal;
  if (signal?.aborted) return response;

  const maxBytes = positiveInt(opts.maxBytes, CAPACITY_PRE_OUTPUT_MAX_BYTES);
  const maxWaitMs = positiveInt(opts.maxWaitMs, CAPACITY_PRE_OUTPUT_MAX_WAIT_MS);
  const env = opts.env ?? process.env;
  const reader = body.getReader();
  const frameBuffer = new BoundedSseFrameBuffer(maxBytes);
  // strict fatal：上游字节必须是合法 UTF-8，否则一切基于文本的判定不可信，直通保留字节。
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let frameTotal = 0;
  let seenId: string | undefined;
  let released = false;
  let pending: Promise<Awaited<ReturnType<typeof reader.read>>> | null = null;
  // 总观察截止在开始时固定：后续帧不续期，连续心跳不能把首字节交付无限期拖住。
  const deadlineAt = Date.now() + maxWaitMs;

  const release = (reason?: unknown): void => {
    if (released) return;
    released = true;
    const inflight = pending;
    pending = null;
    // 在途 read 会被 cancel 拒绝：由这里吞掉，不留 unhandled rejection。
    inflight?.catch(() => undefined);
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch { /* 已关闭 */ }
    frameBuffer.dispose();
  };

  /** 原样交付：buffered 前缀 + 同一 reader 续读；status/headers 全部保持上游响应。 */
  const replay = (): Response => {
    let index = 0;
    let finished = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < buffered.length) {
          controller.enqueue(buffered[index++]);
          return;
        }
        if (finished || released) {
          controller.close();
          return;
        }
        const read = pending ?? reader.read();
        try {
          const next = await read;
          if (pending === read) pending = null;
          if (next.done) {
            finished = true;
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          if (pending === read) pending = null;
          finished = true;
          try {
            controller.error(error);
          } catch { /* 下游已拆 */ }
        }
      },
      cancel(reason) {
        release(reason);
      },
    }, { highWaterMark: 0 });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  const project = (spec: PreOutputProjectionSpec): Response => {
    const headers = new Headers();
    for (const [name, value] of response.headers) {
      if (isSafeResponseHeader(name)) headers.set(name, value);
    }
    const advice = [...spec.adviceMs, ...headerAdviceMs(response.headers)];
    const seconds = advice.length > 0
      ? String(Math.max(1, Math.ceil(Math.max(...advice) / 1000)))
      : String(overloadRetryAfterSec(env));
    headers.set("content-type", "application/json");
    headers.set("cache-control", "no-store");
    headers.set("retry-after", seconds);
    headers.delete("x-should-retry");
    headers.set("x-opencodex-pre-output-projection", "1");
    const payload = JSON.stringify({
      error: {
        type: spec.type,
        ...(spec.code === undefined ? {} : { code: spec.code }),
        message: spec.message,
      },
    });
    const bytes = new TextEncoder().encode(payload);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
      cancel() {
        // 覆盖"未读干就 cancel"的消费者；已关闭的流不会再走到这里，由 dispose 缝兜底。
        release("pre-output projection body cancelled");
      },
    });
    const projection = new Response(stream, { status: spec.status, headers });
    preOutputProjections.set(projection, { restore: () => replay(), status: spec.status });
    // 释放登记走共享 leaf：retry 的 cancelResponseBodyBestEffort 与 disposePreOutputError 都
    // 命中同一个钩子；投影 body 的 cancel() 也调用 release，两条路径都幂等。
    registerResponseDisposal(projection, () => release("pre-output projection disposed"));
    return projection;
  };

  const racedRead = async (): Promise<ReadStep> => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return { kind: "stop" };
    const read = pending ?? reader.read();
    pending = read;
    let consumed = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let onAbort: (() => void) | undefined;
    try {
      const racers: Promise<ReadStep>[] = [
        read.then(next => {
          consumed = true;
          return next.done ? { kind: "done" } as ReadStep : { kind: "value", value: next.value } as ReadStep;
        }),
      ];
      racers.push(new Promise<ReadStep>(resolve => {
        timers.push(setTimeout(() => resolve({ kind: "stop" }), remaining));
      }));
      if (signal) {
        if (signal.aborted) return { kind: "stop" };
        racers.push(new Promise<ReadStep>(resolve => {
          onAbort = () => resolve({ kind: "stop" });
          signal.addEventListener("abort", onAbort, { once: true });
        }));
      }
      return await Promise.race(racers);
    } catch {
      // 上游 read 失败：promise 留在 pending，由 replay 把同一个错误交给下游。
      return { kind: "stop" };
    } finally {
      // 只清掉本次兑现的 read；stop 分支保留在途 promise 交给 replay 收尾。
      if (consumed && pending === read) pending = null;
      for (const timer of timers) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };

  /** 响应 id 锁存：project 之前必须校验（含 EOF tail 帧），冲突即直通。 */
  const idsConflict = (ids: string[]): boolean => {
    for (const id of ids) {
      if (seenId === undefined) seenId = id;
      else if (seenId !== id) return true;
    }
    return false;
  };

  const consumeFrame = (block: Uint8Array): FrameVerdict => {
    let text: string;
    try {
      text = decoder.decode(block);
    } catch {
      // 非法 UTF-8：任何基于文本的判定都不可信，直通保留字节。
      return { kind: "commit", ids: null };
    }
    return classifyFrame(text);
  };

  try {
    for (;;) {
      const step = await racedRead();
      if (step.kind === "stop") return replay();
      if (step.kind === "done") {
        const tail = frameBuffer.finish();
        if (tail.byteLength > 0) {
          const verdict = consumeFrame(tail);
          if (verdict.kind !== "commit" && verdict.ids !== null && !idsConflict(verdict.ids)
            && verdict.kind === "project") {
            return project(verdict.spec);
          }
        }
        return replay();
      }
      const value = step.value;
      buffered.push(value);
      bufferedBytes += value.byteLength;
      if (bufferedBytes > maxBytes) return replay();
      let frames;
      try {
        frames = frameBuffer.feed(value);
      } catch {
        // 单帧过大/单块帧数过多：证据不足，全部字节原样直通。
        return replay();
      }
      for (const frame of frames) {
        frameTotal += 1;
        if (frameTotal > CAPACITY_PRE_OUTPUT_MAX_FRAMES) return replay();
        if (frame.continuation) continue;
        const verdict = consumeFrame(frame.block);
        if (verdict.kind === "commit") return replay();
        if (verdict.ids === null) return replay();
        if (idsConflict(verdict.ids)) return replay();
        if (verdict.kind === "project") return project(verdict.spec);
      }
    }
  } finally {
    frameBuffer.dispose();
  }
}

/** 本代理投影出来的预输出替身（HTTP SSE 侧），与 WS #6969 登记互不相干。 */
export function isPreOutputErrorProjection(response: Response): boolean {
  return preOutputProjections.has(response);
}

/** 投影登记的网关状态（供日志/阶梯使用），非投影返回 undefined。 */
export function preOutputProjectionStatus(response: Response): number | undefined {
  return preOutputProjections.get(response)?.status;
}

/**
 * 交还原始 200 SSE：一次性，之后同一投影再调用返回投影本身。
 * 非投影响应原样返回。
 */
export function restorePreOutputError(response: Response): Response {
  const record = preOutputProjections.get(response);
  const restore = record?.restore;
  if (!record || !restore) return response;
  record.restore = null;
  // 释放责任移交：原流交付后由下游 cancel 自清理，登记必须摘除，否则重试方随后 dispose
  // 会取消已经在交付的 reader。
  removeResponseDisposal(response);
  return restore();
}

/**
 * 集中释放缝：重试阶梯丢弃投影（读干 JSON 后弃用）时必须调用。
 * 取消上游 reader，幂等；非投影响应是 no-op。restore 之后的直通流自带生命周期，无需调用。
 */
export function disposePreOutputError(response: Response): void {
  disposeResponse(response);
}

// 兼容 pipeline 侧已写好的容量命名（同函数对象，不做二次搬迁）。
export const projectPreOutputCapacity: (
  response: Response,
  opts?: PreOutputProjectionOptions,
) => Promise<Response> = projectPreOutputError;
export const isCapacityPreOutput: (response: Response) => boolean = isPreOutputErrorProjection;
export const restoreCapacityPreOutput: (response: Response) => Response = restorePreOutputError;
export const disposeCapacityPreOutput: (response: Response) => void = disposePreOutputError;
export type CapacityPreOutputOptions = PreOutputProjectionOptions;
