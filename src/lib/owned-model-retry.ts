/**
 * 自有 ladder 的统一模型重试壳（fork 新增，Kiro / Cursor runTurn 等 adapter-owned 路径）。
 *
 * 运维合同：真实上游返回的任何 HTTP 4xx/5xx 都必须按统一预算重试，默认每个逻辑请求
 * 共 11 次物理发送（10 次重试 + 首发，env `OCX_MODEL_REQUEST_MAX_RETRIES` > config > 地板 10）。
 * 拥有自有 fetchResponse / runTurn ladder 的 adapter 过去各自停在 3 次、只重 401 一次、
 * 或 5xx 根本不重；本壳把这些 ladder 接到同一份预算上，而不是让它们各自数自己的 3。
 *
 * **单一 ledger，不相乘**（#4546 的教训：外层 3 × 内层 3 = 9 就是这条链上已定罪的形态）。
 * 预算权威是 `ctx.sendBudget`（ingress 按配置 fund 的绝对总额）：`policy.maxTotalModelSends`
 * 的**精确值**被完整尊重，**包括 0**——0 是硬拒，绝不回退到 leaf 默认。一个已耗尽的请求
 * 在 adapter 内层白得 11 次发送，正是 #4546 的乘法入口。只有 sendBudget 缺席（adapter 单测、
 * context-free 调用）才落到统一 leaf（默认 11），且此时本壳自带硬轮次上限：循环在任何
 * 模式下都有界，不会因「剩余恒为 11」空转。
 *
 * 物理发送计数：一次 `send()` 闭包**可以包含多个物理发送**（Kiro 的 reset ladder 一轮最多
 * 3 发，Cursor 一轮整回合 dial 也可能多腿）。因此「已用」取三者最大：
 * - `sendBudget.used`（有预算时权威，含本壳之外的 recovery leg）；
 * - 调用方注入的 `physicalSends()`（adapter 自己的物理 ordinal 计数，context-free 权威）；
 * - 本壳自身的闭包调用数（每轮 ≥1 的保守下限，保证 context-free 无注入时循环仍终止）。
 *
 * 与 `fetchWithTransientRetry({modelRetryMode:true})` 的分工：那条 lane 属于共享 dispatch
 * 路径（adapter-dispatch / passthrough），由 implement_capacity_pipeline_budget 拥有；本壳
 * 属于「adapter 自己拥有物理发送与协议恢复」的路径，那些路径每发已经过
 * `createAdapterPhysicalSend` / `reserveDispatch` 记账，外层再包一条发送 helper 会把同一批
 * 发送记两次，所以本壳不重发、只决定「还要不要再调一次发送闭包」，计数全部落在既有 ledger。
 *
 * 门（与 lane 版同一套裁决）：
 * - 状态优先：400..599 全重试，不看 `x-should-retry`（上游拒绝提示不豁免本地义务），
 *   不看响应体文案；quota 429 / policy 403 / invalid request 400 都在集合内。
 * - 本地一票否决保持：`isNonReplayableResponse`（歧义 socket 重置等发出后网关态）不重放；
 *   caller abort 立即停；transport 抛错里没有可解析的 HTTP 4xx/5xx 状态时原样上抛
 *   （连接重置不归 HTTP 错误，保持 non-replayable，不新增盲回放）。
 * - `Retry-After` 是下限且完整等待（无 60s 提前放弃），abort 可打断。
 * - 被丢弃的 recovery leg 只被 dispose：account-auto-pause / permanent-refusal 标记是
 *   exact physical response 的 credential/outcome provenance，**不跨响应继承**——旧 401
 *   的暂停标贴到成功 200 上会让下游恢复/健康逻辑把成功读成轮换证据。结算响应的标记由
 *   调用侧 observer 依其自身凭证标注。
 * - 终态交还最后一次**真实、body 完整**的上游响应：body 已 cancel 的响应永不外交。
 */
import type { RequestExecutionBudget } from "./request-execution-budget";
import { modelRequestMaxAttempts } from "./model-request-retry";
import { runModelRetryScope } from "./model-retry-scope";
import { parseRetryAfterFromMessage } from "./retry-delay";
import {
  SendBudgetExhaustedError,
  abortError,
  cancelResponseBodyBestEffort,
  isModelHttpErrorStatus,
  isNonReplayableResponse,
  retryBackoffDelayMs,
  sleepWithAbort,
} from "./upstream-retry";

export const OWNED_MODEL_RETRY_BASE_DELAY_MS = 400;
export const OWNED_MODEL_RETRY_MAX_DELAY_MS = 5_000;

export interface OwnedModelBudgetOptions {
  /** 逻辑请求的统一预算；absent（context-free）时按统一 leaf 的绝对额自计并硬限轮次。 */
  sendBudget?: RequestExecutionBudget;
  /**
   * adapter 自己的已物理发送计数（Kiro 的 ordinal 计数器）。一次 send 闭包可含多物理
   * 发送，context-free 时以此数为准，绝不按「每闭包 = 1」乐观计。
   */
  physicalSends?: () => number;
  /** provider 行折叠后的配置值（retries）；缺省读全局 config 由调用方负责，leaf 只认标量。 */
  configuredRetries?: number;
  env?: Record<string, string | undefined>;
}

/**
 * 本轮 ladder 的绝对总发送上限（含首发）。
 *
 * 有 `sendBudget` 时它就是权威：`policy.maxTotalModelSends` 的精确值直接采用，**0 是合法
 * 硬拒**，绝不 fallback 到 leaf 默认。非有限 / 负数同样不 fallback，而是按 0 处理（fail
 * closed）：一个读不出总额的预算不是一个允许发送的预算。
 */
export function ownedModelSendTotal(options: OwnedModelBudgetOptions = {}): number {
  const policyTotal = options.sendBudget?.policy?.maxTotalModelSends;
  if (typeof policyTotal === "number") {
    if (!Number.isFinite(policyTotal) || policyTotal < 0) return 0;
    return Math.trunc(policyTotal);
  }
  return modelRequestMaxAttempts(options.configuredRetries, options.env);
}

/**
 * 剩余可发送数。已用取「共享 ledger used / adapter 自报物理数 / 本壳闭包数」的最大值：
 * 预算拒绝必须建立在最悲观的真实计数上，取小就是白送。
 */
export function ownedModelSendsRemaining(
  options: OwnedModelBudgetOptions = {},
  scopeCloses = 0,
): number {
  const total = ownedModelSendTotal(options);
  const reported = options.physicalSends ? Math.max(0, Math.trunc(options.physicalSends())) : 0;
  const used = Math.max(
    // Non-numeric `used` (hand-written stub budgets) counts as zero known spend.
    options.sendBudget && Number.isFinite(options.sendBudget.used) ? Math.max(0, options.sendBudget.used) : 0,
    reported,
    Math.max(0, Math.trunc(scopeCloses)),
  );
  return Math.max(0, total - used);
}

/**
 * 从 transport 抛错里提取上游 HTTP 状态。
 *
 * Cursor HTTP/1 bridge 的 `cursorHttp1Error` 把状态包在 `HTTP ${status}` 文案里，Zed 的
 * `responseJson` 用 `label: HTTP 429`，MiMo bootstrap 用 `MiMo bootstrap failed: 429`。
 * 只认明确落在 400..599 的数字：解析不出就是「不是 HTTP 模型错误」，调用方原样上抛，
 * 连接重置类错误因此在 ladder 外保持 non-replayable。
 */
export function upstreamHttpErrorStatus(err: unknown): number | undefined {
  const direct = err && typeof err === "object" ? (err as { status?: unknown }).status : undefined;
  if (typeof direct === "number" && Number.isInteger(direct)) {
    return direct >= 400 && direct <= 599 ? direct : undefined;
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message) return undefined;
  const match = /(?:\bHTTP\b|failed:|with HTTP)\s*\(?\[?(\d{3})\]?/i.exec(message);
  if (!match) return undefined;
  const status = Number(match[1]);
  return status >= 400 && status <= 599 ? status : undefined;
}

/**
 * 从 transport 抛错里读上游点名的 Retry-After（毫秒）。
 *
 * 优先结构化字段（transport 层在构造错误时就附带响应证据的契约）：
 * - `err.retryAfterMs`：number，毫秒；
 * - `err.headers`：`Headers`（HTTP/1 bridge 未来 attach 响应头即生效）。
 * 都没有时回落到消息文案解析（`... in 30 seconds` 一类），HTTP 状态头在 transport
 * 层丢失的场景下这是唯一可用的恢复通道。
 */
export function upstreamRetryAfterFromError(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const direct = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;
    const headers = (err as { headers?: unknown }).headers;
    if (headers instanceof Headers) {
      const raw = headers.get("retry-after")?.trim();
      if (raw) {
        const seconds = Number(raw);
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
        const dateMs = Date.parse(raw);
        if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
      }
    }
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message) return undefined;
  // Narrow transport-receipt shape (root 2026-10-23): Cursor/HTTP bridges say `retry in 45
  // seconds` inside the error text. The shared message parser covers `try again in`,
  // `Retry-After` and `resets in`, not bare `retry in N seconds`, and widening it globally
  // would change every message-parsing caller's semantics. The pattern is deliberately
  // precise - prefix words, explicit time unit, digit-only capture - and runs only on the
  // HTTP-error path (the caller has already classified the receipt), so prose model
  // output numbers cannot masquerade as a wait instruction.
  const precise = /\bretry\s+(?:again\s+)?in\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i.exec(message);
  if (precise) {
    const seconds = Number(precise[1]);
    // The capture is seconds; this function's contract is milliseconds. No double
    // conversion: the structured `retryAfterMs` branch above already returns ms.
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return parseRetryAfterFromMessage(message);
}

export interface OwnedModelRetryOptions extends OwnedModelBudgetOptions {
  /** 短标签，只进 warn 行（与 lane 版同规：不带 query/密钥）。 */
  label?: string;
  /** caller 取消信号：abort 立即停，交还最后一次 body 完整的答案；无答案则抛 abort。 */
  signal?: AbortSignal;
  /** 预算拒绝了一次就绪的 recovery 时上报（与 ctx.onRecoveryWithheld 同一通道）。 */
  onRecoveryWithheld?: (withheld: { reason: "retry-send-budget" }) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * 用统一预算包裹一个 adapter-owned ladder 的 4xx/5xx HTTP 错误重试 runner。
 *
 * 命名说明：这是**HTTP 错误重试 runner**，不是 async-local-storage scope；真正的
 * retry-scope wrapper 在 `lib/model-retry-scope.ts`（`runModelRetryScope`），两者不可混用。
 *
 * `send` 每轮调用一次，闭包内部必须经既有记账边界发出物理发送
 * （`createAdapterPhysicalSend` / `reserveDispatch`）；本壳只数轮次、不碰账本。
 * 每轮开头检查 abort 与剩余预算，并以总发送额为**硬轮次上限**：context-free（无预算无
 * physicalSends）下同样有界。
 *
 * body 生命周期与统一 helper 对齐：可重试答案的 body 一直保留，只有**本轮已决定继续**且
 * 新答案已到手（结算或下一轮候选）时才取消旧的；abort 路径永不交还已取消 body，抛错路径
 * 直接上抛原错误。
 */
export function runOwnedModelHttpRetry(
  send: () => Promise<Response>,
  options: OwnedModelRetryOptions = {},
): Promise<Response> {
  // ALS scope（root 2026-10-23）：包 lib/model-retry-scope 的真 runModelRetryScope，让
  // owned lane 的重试轮次共享自动暂停提交的排队/延迟语义（中途 401 不得自我截断 11 送
  // 额度）。reentrant 幂等：dispatch 层已有外层 scope 时这里直接透传。
  return runModelRetryScope(() => runOwnedModelHttpRetryInner(send, options));
}

async function runOwnedModelHttpRetryInner(
  send: () => Promise<Response>,
  options: OwnedModelRetryOptions,
): Promise<Response> {
  const baseDelayMs = options.baseDelayMs ?? OWNED_MODEL_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? OWNED_MODEL_RETRY_MAX_DELAY_MS;
  const total = ownedModelSendTotal(options);
  // total === 0：外层预算已花光，一次都不发。抛 ladder 一致 exhaustion 信号，由调用方的
  // SendBudgetExhaustedError 分支决定交还什么（Kiro / Cursor 都是交还上一个真实答案）。
  if (total <= 0) throw new SendBudgetExhaustedError(options.label);
  let closes = 0;
  let pending: Response | undefined;
  let lastError: unknown;
  for (let round = 0; round < total; round++) {
    if (options.signal?.aborted) {
      // abort：pending 的 body 从未被动过，直接交还；没有 pending 就把 abort 原样上抛。
      if (pending) return pending;
      throw abortError(options.signal);
    }
    // 每轮**入口**的余量门（root 2026-10-23）：共享 ledger（或 context-free 的物理
    // 计数）已经花到总额时，本轮 send 之前直接结算。只在响应后判定会让内层 ladder 切换
    // endpoint 的轮次白拿一次首发——合同保证物理终数最多 11，多一发都不行。
    if (ownedModelSendsRemaining(options, closes) <= 0) {
      options.onRecoveryWithheld?.({ reason: "retry-send-budget" });
      break;
    }
    closes += 1;
    let response: Response | undefined;
    let thrownStatus: number | undefined;
    try {
      response = await send();
    } catch (error) {
      // The inner ledger refused a send this round (reserveDispatch exhaustion).
      // Contract (responses-send-budget-counts): a refused later reservation returns the
      // PREVIOUS upstream failure, not a laundered 502 - settle with the last real answer.
      if (error instanceof SendBudgetExhaustedError && pending) return pending;
      const status = upstreamHttpErrorStatus(error);
      if (status === undefined) {
        // 非 HTTP 模型错误（连接重置 / 本地拒绝）：原样上抛。pending 已被放弃，best-effort
        // 释放它的 socket；被继承的暂停证据随异常一起失去意义（调用方另有失败路径）。
        if (pending) cancelResponseBodyBestEffort(pending);
        throw error;
      }
      thrownStatus = status;
      lastError = error;
    }
    if (response) {
      const settle = response.ok
        || !isModelHttpErrorStatus(response.status)
        || isNonReplayableResponse(response);
      // 旧答案（无论可重试与否）此刻确定不被交还：dispose 即可。account-auto-pause /
      // permanent-refusal 标记是**该物理响应自己的** credential/outcome provenance，绝不
      // 跨响应继承——把旧 401 的暂停标贴到 200 上会让 recoverAutoPausedAccount/健康记账
      // 把成功读成轮换证据。真正的 final/refused 标记由调用侧的 observer 在结算响应上自标。
      if (pending) cancelResponseBodyBestEffort(pending);
      if (settle) return response;
      pending = response;
    } else {
      lastError = lastError ?? new Error(`owned model retry: upstream HTTP ${thrownStatus}`);
    }
    if (options.signal?.aborted) {
      if (pending) return pending;
      throw abortError(options.signal);
    }
    if (ownedModelSendsRemaining(options, closes) <= 0) {
      options.onRecoveryWithheld?.({ reason: "retry-send-budget" });
      break;
    }
    const observed = response ? response.status : thrownStatus;
    console.warn(
      `[owned-model-retry] upstream ${observed}${options.label ? ` (${options.label})` : ""} — retrying within unified budget (${closes}/${total})`,
    );
    const instructed = response?.headers
      ? undefined
      : upstreamRetryAfterFromError(lastError);
    const delay = retryBackoffDelayMs(round, {
      baseDelayMs,
      maxDelayMs,
      retryAfterIsLowerBound: true,
      ...(response
        ? { headers: response.headers }
        : instructed !== undefined
          ? { headers: new Headers({ "retry-after": String(Math.ceil(instructed / 1000)) }) }
          : {}),
    });
    // Retry-After 是下限：完整等待，abort 可打断。sleepWithAbort 抛 abort 时直接上抛——
    // pending 的 body 在这一刻仍未被取消，调用方拿到完整答案或干净的 abort。
    await sleepWithAbort(delay, options.signal);
  }
  if (pending) return pending;
  throw lastError ?? new SendBudgetExhaustedError(options.label);
}
