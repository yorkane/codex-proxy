import type { CursorRunRequest, CursorServerMessage } from "./types";
import type { CursorTransport, CursorTransportFactory, CursorTransportFactoryInput } from "./transport";
import type { RequestExecutionBudget } from "../../lib/request-execution-budget";
import type { AttemptRecoveryKind } from "../../usage/log";
import { SendBudgetExhaustedError, abortError, retryBackoffDelayMs, sleepWithAbort } from "../../lib/upstream-retry";
import { ownedModelSendTotal, ownedModelSendsRemaining, upstreamHttpErrorStatus, upstreamRetryAfterFromError } from "../../lib/owned-model-retry";
import { debugProviderDiagnostic } from "../../lib/debug";
import { isCursorRootEnvelopeError, safeCursorErrorMessage } from "./cursor-errors";

// Compat: historical name for the shared abortable sleep, kept for external callers.
export { sleepWithAbort as abortAwareSleep } from "../../lib/upstream-retry";

export const CURSOR_RETRY_ATTEMPTS = 3;

/**
 * 整轮重放的统一发送权威（fork 2026-10-23 运维裁决）。
 *
 * 旧形态是硬顶 3：Cursor 的一条 runTurn 最多重放 3 次整轮。合同现在要求真实上游
 * 4xx/5xx 默认重试 10 次（每逻辑请求共 11 发），而每一发整轮重放都是这笔预算付账的
 * 物理发送，所以循环上限取统一预算的**精确**值：有 sendBudget 时用
 * `policy.maxTotalModelSends`（0 是硬拒，绝不回退 11），context-free 用统一 leaf
 * （默认 11）。绝不相乘：这里没有「外层 11 × 内层 11」，因为本循环就是那条唯一的
 * ladder，其余 leg 由同一个共享 ledger 记账并收缩本循环的余量。
 */
export function cursorTurnSendCap(execution: CursorTurnExecutionOptions = {}): number {
  return ownedModelSendTotal(cursorTurnBudgetOptions(execution, () => 0));
}
export const CURSOR_RETRY_BASE_MS = 250;
export const CURSOR_RETRY_MAX_MS = 2_000;

/**
 * Fixed identity for the Cursor upstream in the request budget's target ledger. A literal, not
 * anything derived from the turn: the ledger is read back in diagnostics, so it must not become
 * a place where a session or credential identity leaks.
 */
export const CURSOR_BUDGET_TARGET_KEY = "cursor";

/**
 * How one Cursor turn participates in the enclosing logical request (#4546).
 *
 * Both fields are optional and the whole object defaults to empty, which is what keeps a
 * context-free unit call unlimited: this transport is exercised directly by tests that build no
 * request at all, and a mandatory budget would have made every one of them a budget test.
 */
export interface CursorTurnExecutionOptions {
  /** Absent means unlimited; present means every retry is a physical send the request pays for. */
  sendBudget?: RequestExecutionBudget;
  /** Observes each physical run request; `ordinal` counts from 1 within this turn. */
  onPhysicalSend?: (send: { ordinal: number; recovery?: AttemptRecoveryKind }) => void;
  /**
   * provider 行折叠后的配置值（retries）。统一 leaf 只认标量，config 读取由调用方负责。
   */
  configuredRetries?: number;
  /**
   * 预算拒绝了一次「整轮重放已就绪」时的上报（与 `ctx.onRecoveryWithheld` 同一通道）：
   * 被拒的 replay 不是物理发送，不进 sendCount（#5044）。
   */
  onRecoveryWithheld?: (withheld: { reason: "retry-send-budget" }) => void;
}

/** 共享 ledger 视图：一次整轮重放 = 一次物理发送（ordinal 即计数）。 */
function cursorTurnBudgetOptions(
  execution: CursorTurnExecutionOptions,
  attempts: () => number,
): { sendBudget?: RequestExecutionBudget; physicalSends: () => number; configuredRetries?: number } {
  return {
    ...(execution.sendBudget ? { sendBudget: execution.sendBudget } : {}),
    physicalSends: attempts,
    ...(execution.configuredRetries !== undefined ? { configuredRetries: execution.configuredRetries } : {}),
  };
}

/**
 * True only for clearly transient failures that occur BEFORE the run request is committed to the
 * wire (connection refused/reset/timeout, immediate HTTP/2 GOAWAY, gRPC/Connect "unavailable").
 * Conservative by design: auth, invalid-request, and anything ambiguous is non-retryable so we
 * never replay a turn the Cursor server might already have accepted.
 */
export function isRetryableCursorError(err: unknown): boolean {
  // Local envelope failures are deterministic: the same request produces the same rejection.
  // Checked before the text heuristics below, which would otherwise have to infer this from
  // wording.
  if (isCursorRootEnvelopeError(err)) return false;
  // 统一模型请求 lane（fork 2026-10-23）：真实上游 HTTP 4xx/5xx 一律可重试，状态优先。
  // 这是用户显式裁决对旧「auth/invalid 不重放」启发式的 override——Cursor 的
  // `Cursor HTTP/1.1 RunSSE failed with HTTP 429` 一类状态在旧形态下因文案命中
  // unauthorized/invalid 分支被一票否决，而合同要求 400..599 全重试（quota 429、
  // policy 403、invalid request 400 都在集合内）。协议门不受影响：下面的
  // `requestUncommitted` + `emittedAny` 仍然是硬前置，已提交的整轮永不重放。
  if (isCursorModelHttpError(err)) return true;
  const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const haystack = `${code} ${message}`.toLowerCase();
  if (/auth|unauthor|forbidden|invalid|permission|denied|not found|unsupported/.test(haystack)) return false;
  if (/resource.exhausted|resource_exhausted|rate limit|too many requests|throttl/.test(haystack)) return false;
  if (haystack.includes("nghttp2_cancel") || haystack.includes("stream suspended")) return false;
  return (
    haystack.includes("econnreset") ||
    haystack.includes("econnrefused") ||
    haystack.includes("etimedout") ||
    haystack.includes("enetunreach") ||
    haystack.includes("eai_again") ||
    haystack.includes("goaway") ||
    (haystack.includes("nghttp2") && !haystack.includes("nghttp2_cancel")) ||
    haystack.includes("socket hang up") ||
    haystack.includes("connection reset") ||
    haystack.includes("unavailable") ||
    haystack.includes("timed out")
  );
}

/**
 * 从 Cursor transport 的抛错里识别真实上游 HTTP 4xx/5xx。
 *
 * HTTP/1 bridge 把状态写进 `Cursor HTTP/1.1 <op> failed with HTTP 503`；h2 路径的
 * `Cursor gRPC error <n>` 是 gRPC 状态码，不是 HTTP 状态，因此**不**在此列——它继续
 * 走上面的瞬态文案启发式，歧义 socket 重置继续 non-replayable。
 */
export function isCursorModelHttpError(err: unknown): boolean {
  // Local deterministic refusals veto first: CursorRootEnvelopeLimitError carries its own
  // status = 400, and reading it as an upstream receipt would replay a pre-send local
  // envelope-over-limit failure that reproduces exactly.
  if (isCursorRootEnvelopeError(err)) return false;
  return upstreamHttpErrorStatus(err) !== undefined;
}

export function cursorRetryDelayMs(attempt: number, err?: unknown): number {
  // B (root 2026-10-23): a model HTTP refusal that names a wait must be honored in full -
  // the unified contract says every model retry respects Retry-After as a LOWER bound, and
  // the transport layer loses the response headers on the throw path, so the instruction is
  // read from the structured fields / message the transport carries (upstreamRetryAfterFrom
  // Error). The exponential ladder stays the floor for receipt-less network failures.
  const instructedMs = err === undefined ? undefined : upstreamRetryAfterFromError(err);
  const delay = retryBackoffDelayMs(attempt, {
    baseDelayMs: CURSOR_RETRY_BASE_MS,
    maxDelayMs: CURSOR_RETRY_MAX_MS,
  });
  if (instructedMs === undefined) return delay;
  return Math.max(delay, instructedMs);
}

/**
 * A transport is safe to retry only if it explicitly reports the run request was never committed.
 * A transport without `requestCommitted` is treated as committed (not retryable) — fail safe.
 */
function requestUncommitted(transport: CursorTransport): boolean {
  return typeof transport.requestCommitted === "function" && transport.requestCommitted() === false;
}

/**
 * Run a Cursor turn with bounded retry on pre-commit transient failures.
 *
 * `onEvent` receives every server message. Retry happens only when ALL hold:
 *  - nothing has been emitted yet this turn,
 *  - the failing transport reports the run request was not committed to the wire,
 *  - the error is a transient pre-commit failure.
 * Otherwise the error propagates (the adapter maps it to a user-facing message).
 *
 * `execution` carries the enclosing request's send budget. Each attempt here is a real re-send
 * of the whole turn, so an outer cap that counted one adapter entry counted at most a third of
 * what went upstream; when a budget is present every attempt is admitted against it and an
 * exhausted request stops before opening another transport (#4546).
 */
export async function runCursorTurnWithRetry(
  makeTransport: (input: CursorTransportFactoryInput) => CursorTransport,
  input: CursorTransportFactoryInput,
  request: CursorRunRequest,
  signal: AbortSignal | undefined,
  onEvent: (message: CursorServerMessage, transport: CursorTransport) => void,
  execution: CursorTurnExecutionOptions = {},
): Promise<void> {
  let attempts = 0;
  // 统一发送权威：有预算时精确取 policy.maxTotalModelSends（含 0 硬拒），context-free
  // 落统一 leaf。0 直接拒：一个已被外层花光的请求不在这里白得一次整轮重放（#4546）。
  const cap = cursorTurnSendCap(execution);
  if (cap <= 0) throw new SendBudgetExhaustedError(CURSOR_BUDGET_TARGET_KEY);
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    attempts = attempt + 1;
    // Admitted before the transport is built: a refused send must not open a connection, and
    // the refusal must reach the adapter as the typed exhaustion rather than as a run failure
    // that the retry predicate below could read as transient.
    const decision = execution.sendBudget?.reserveDispatch({
      sendClass: "transient",
      targetKey: CURSOR_BUDGET_TARGET_KEY,
    });
    if (decision && (!decision.allowed || !decision.permit.use())) {
      throw new SendBudgetExhaustedError(CURSOR_BUDGET_TARGET_KEY);
    }
    execution.onPhysicalSend?.({
      ordinal: attempt + 1,
      // Cursor retries only pre-commit transport failures, so every retry send is the
      // connection-reset class; there is no re-send of a turn the server may have accepted.
      ...(attempt > 0 ? { recovery: "connection-reset" as const } : {}),
    });
    const transport = makeTransport(input);
    let emittedAny = false;
    let closed = false;
    // Best-effort close: a cleanup failure must never replace the run outcome (or kill
    // a viable retry) — the caller needs the run error / success, not the close error.
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await transport.close?.();
      } catch (err) {
        debugProviderDiagnostic("cursor", "close-error", {
          attempt,
          reason: safeCursorErrorMessage(err instanceof Error ? err.message : String(err)),
        });
      }
    };
    try {
      for await (const message of transport.run(request, signal)) {
        emittedAny = true;
        onEvent(message, transport);
      }
      return;
    } catch (err) {
      // root 2026-10-23 裁决：真实上游 HTTP 4xx/5xx 是**权威拒绝回执**——服务端明确
      // 答复且 RunSSE 非 200 时 run 请求从未注册（live-transport 只在 200 头后
      // resolveRunSseReady / markCommitted），因此 committed 标志不得拦它；合同要求
      // 400..599 在统一预算内重试至少 10 次，旧的 committed 门会让 http1 bridge 的
      // 429/5xx 永远 1 发。网络异常路径（歧义重置等）仍要求 uncommitted——那里服务端
      // 可能已接受整轮。本地确定性拒绝（root-envelope 超限）在 isRetryableCursorError
      // 的首个门就被否决，其本地 status 字段不被当作上游回执。
      const modelHttpError = isCursorModelHttpError(err);
      const transientPreCommit = requestUncommitted(transport) && isRetryableCursorError(err);
      const recoveryReady = !emittedAny && !signal?.aborted
        && (modelHttpError || transientPreCommit);
      // C (root 2026-10-23): 用户扩大的范围只是 HTTP 4xx/5xx——网络异常（pre-commit
      // ECONNREFUSED 等）继续旧的 3 发形态，不得被统一预算放大到 11 次 timeout。
      const loopCap = modelHttpError ? cap : Math.min(cap, CURSOR_RETRY_ATTEMPTS);
      const canRetry =
        recoveryReady &&
        attempt < loopCap - 1 &&
        // 统一余量相交封顶：共享 ledger 里本请求的消耗（含其它 leg）已经把余量花完时，
        // 不再整轮重放——本循环是唯一 ladder，绝不相乘。
        ownedModelSendsRemaining(cursorTurnBudgetOptions(execution, () => attempts)) > 0;
      if (recoveryReady && modelHttpError && !canRetry) {
        // 模型 lane 到顶/余量归零 = 统一预算耗尽（合同「至少 10 次」的下限由 ingress
        // fund 的 11 保证），记录这次被拒的 recovery（#5044 通道）。网络 lane 停在 3 是
        // 它自己的旧契约，不算预算拒绝，不上报。
        execution.onRecoveryWithheld?.({ reason: "retry-send-budget" });
      }
      if (!canRetry) {
        debugProviderDiagnostic("cursor", "no-retry", {
          attempt,
          reason: safeCursorErrorMessage(err instanceof Error ? err.message : String(err)),
          emittedAny,
          committed: !requestUncommitted(transport),
          aborted: !!signal?.aborted,
        });
        throw err;
      }
      const backoffMs = cursorRetryDelayMs(attempt, err);
      debugProviderDiagnostic("cursor", "retry", {
        attempt,
        reason: safeCursorErrorMessage(err instanceof Error ? err.message : String(err)),
        backoffMs,
      });
      // End the failed attempt BEFORE the backoff: holding the dead transport open
      // through the sleep wastes its connection, and the next attempt must never
      // start before this one's close settles.
      await closeOnce();
      await sleepWithAbort(backoffMs, signal);
    } finally {
      await closeOnce();
    }
  }
}

export type { CursorTransportFactory };
