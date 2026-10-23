import type { AdapterFetchContext, AdapterRequest } from "./base";
import type { AttemptRecoveryKind } from "../usage/log";
import { classifyKiroHttpError, safeKiroHttpErrorMessage } from "./kiro-errors";
import { normalizeUpstreamHttpErrorResponse } from "./upstream-http-error";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { resolveClientRetryAfter } from "../lib/retry-after";
import { parseRetryAfterMs } from "../combos";
import { ownedModelSendsRemaining, runOwnedModelHttpRetry } from "../lib/owned-model-retry";
import {
  SendBudgetExhaustedError,
  abortError,
  cancelResponseBodyBestEffort,
  fetchWithAttemptDeadline,
  isConnectionResetError,
  markResponseNonReplayable,
  retryBackoffDelayMs,
  sleepWithAbort,
} from "../lib/upstream-retry";
import { releaseProviderRequestSlot, sendTrackingRequestSlot, type ProviderRequestSlot } from "../providers/request-pacing";

const RESET_ATTEMPTS = 3;
const RESET_RETRY_BASE_MS = 150;
const RESET_RETRY_MAX_MS = 1_000;
const THROTTLE_ATTEMPTS = 3;
const CANONICAL_RUNTIME_HOST = /^runtime\.([a-z]{2}(?:-[a-z]+)+-\d)\.kiro\.dev$/i;
const ENDPOINT_ERROR_MARKERS = [
  "unknownoperation",
  "unknown operation",
  "invalidsignature",
  "invalid signature",
  "endpoint not found",
  "unsupported endpoint",
];
const CONNECT_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);
type KiroFetchContext = AdapterFetchContext & {
  allowGatewayRotation?: boolean;
  /** Unified HTTP lane backoff seams for tests; production keeps 400/5000ms. */
  modelRetryBaseDelayMs?: number;
  modelRetryMaxDelayMs?: number;
};

interface KiroThrottleProbe {
  token: symbol;
  promise: Promise<void>;
  release: () => void;
}

let kiroThrottleCooldownUntil = 0;
let kiroThrottleProbe: KiroThrottleProbe | undefined;

function newKiroThrottleProbe(): KiroThrottleProbe {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  const probe = { token: Symbol("kiro-throttle-probe"), promise, release };
  kiroThrottleProbe = probe;
  return probe;
}

function releaseKiroThrottleProbe(token: symbol | undefined): void {
  if (!token || kiroThrottleProbe?.token !== token) return;
  const probe = kiroThrottleProbe;
  kiroThrottleProbe = undefined;
  probe.release();
}

async function waitWithAbort(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function waitForKiroCooldown(signal?: AbortSignal): Promise<void> {
  // Re-check after every sleep because another throttled request can extend the shared deadline.
  while (true) {
    const remaining = kiroThrottleCooldownUntil - Date.now();
    if (remaining <= 0) return;
    await sleepWithAbort(remaining, signal);
  }
}

async function enterKiroThrottleGate(signal?: AbortSignal): Promise<symbol | undefined> {
  while (true) {
    const active = kiroThrottleProbe;
    if (active) {
      await waitWithAbort(active.promise, signal);
      continue;
    }
    if (kiroThrottleCooldownUntil <= Date.now()) return undefined;
    const owned = newKiroThrottleProbe();
    try {
      await waitForKiroCooldown(signal);
      return owned.token;
    } catch (error) {
      releaseKiroThrottleProbe(owned.token);
      throw error;
    }
  }
}

function claimKiroThrottleProbe(
  delayMs: number,
  currentToken?: symbol,
): { token?: symbol; wait?: Promise<void> } {
  kiroThrottleCooldownUntil = Math.max(kiroThrottleCooldownUntil, Date.now() + Math.max(0, delayMs));
  if (currentToken && kiroThrottleProbe?.token === currentToken) return { token: currentToken };
  if (!kiroThrottleProbe) return { token: newKiroThrottleProbe().token };
  return { wait: kiroThrottleProbe.promise };
}

/** Stream-level throttles arrive after HTTP 200, so record their cooldown for the next client retry. */
export function noteKiroTransientThrottle(delayMs = 2_000): void {
  kiroThrottleCooldownUntil = Math.max(kiroThrottleCooldownUntil, Date.now() + Math.max(0, delayMs));
}

export function resetKiroThrottleStateForTests(): void {
  const active = kiroThrottleProbe;
  kiroThrottleProbe = undefined;
  kiroThrottleCooldownUntil = 0;
  active?.release();
}

function errorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return chain;
}

function endpointConnectFailure(error: unknown): boolean {
  return errorChain(error).some(item => {
    if (item.name === "AbortError" || item.name === "TimeoutError") return false;
    const code = (item as Error & { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_ERROR_CODES.has(code)) return true;
    const message = item.message.toLowerCase();
    return message.includes("dns")
      || message.includes("name resolution")
      || message.includes("failed to lookup address")
      || message.includes("connection refused")
      || message.includes("failed to connect")
      || message.includes("connect error");
  });
}

function legacyUrl(requestUrl: string): string | undefined {
  let url: URL;
  try { url = new URL(requestUrl); } catch { return undefined; }
  const match = CANONICAL_RUNTIME_HOST.exec(url.hostname);
  if (!match || url.pathname !== "/" || url.search || url.hash) return undefined;
  url.hostname = `q.${match[1]}.amazonaws.com`;
  return url.toString();
}

async function fetchWithResetRecovery(
  request: AdapterRequest,
  url: string,
  ctx: AdapterFetchContext,
  timeoutMs: number,
  notePhysicalSend: (reset: boolean) => void,
  remaining: () => number,
): Promise<Response> {
  let lastError: unknown;
  let destination = url;
  let destinationRebased = false;
  for (let attempt = 0; attempt < RESET_ATTEMPTS; attempt++) {
    // 统一预算守卫（fork 2026-10-23）：预算已尽时不再尝试下一发，抛与 ledger 拒绝完全
    // 同款的 SendBudgetExhaustedError，保持既有「预算耗尽以类型化错误终结 ladder」的契约；
    // 首发（attempt 0）永不在此拦截——它由共享 ledger 的 reserveDispatch 权威拒绝。
    if (attempt > 0 && remaining() <= 0) throw new SendBudgetExhaustedError(destination);
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    const executor = (ctx.executor ?? globalThis.fetch) as typeof globalThis.fetch & {
      waitForPacing?: (signal?: AbortSignal) => Promise<ProviderRequestSlot | void>;
      unpacedFetch?: typeof globalThis.fetch;
    };
    const slot = (await executor.waitForPacing?.(ctx.abortSignal)) || undefined;
    try {
      if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
      // Every physical send is admitted, not just the adapter entry. Kiro nests a throttle loop
      // over this ladder and can run the ladder twice per throttle round, so counting one entry
      // as one send hid up to eighteen upstream requests from the per-request cap (#4546).
      const decision = ctx.sendBudget?.reserveDispatch({
        sendClass: "transient", targetKey: destination, rebasedTarget: destinationRebased,
      });
      destinationRebased = false;
      if (decision && !decision.allowed) {
        throw new SendBudgetExhaustedError(destination);
      }
      // Reported after admission and before dispatch, so a refused send is never counted and an
      // admitted one is counted exactly once whichever way the fetch below settles.
      const permit = decision?.allowed ? decision.permit : undefined;
      const requestUrl = request.url;
      try {
        const headers = new Headers(request.headers);
        const recovered = attempt > 0;
        if (recovered) headers.set("connection", "close");
        return await sendTrackingRequestSlot(slot, () => fetchWithAttemptDeadline(destination, {
          method: request.method,
          headers,
          body: request.body,
          ...(recovered ? { keepalive: false } : {}),
        }, timeoutMs, ctx.abortSignal, ctx.stream, (async (input, init) => {
          try {
            const run = async (): Promise<Response> => {
              if (permit && !permit.use()) throw new SendBudgetExhaustedError(destination);
              notePhysicalSend(attempt > 0);
              return (executor.unpacedFetch ?? executor)(input, init);
            };
            return await (permit?.execute ? permit.execute(run) : run());
          } catch (error) {
            if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
            const signal = init?.signal;
            if (signal?.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError") {
              throw signal.reason;
            }
            throw error;
          }
        }) as typeof globalThis.fetch));
      } catch (error) {
        if (ctx.abortSignal?.aborted || !isConnectionResetError(error) || attempt === RESET_ATTEMPTS - 1) throw error;
        lastError = error;
        if (request.url !== requestUrl) {
          destination = request.url;
          // The rebuild retargeted this request; that move is authorized work, not a
          // failover transition, so the endpoint fallback still owns the budget's one hop.
          destinationRebased = true;
        }
        await sleepWithAbort(retryBackoffDelayMs(attempt, {
          baseDelayMs: RESET_RETRY_BASE_MS,
          maxDelayMs: RESET_RETRY_MAX_MS,
        }), ctx.abortSignal);
      } finally { permit?.release(); }
    } finally {
      releaseProviderRequestSlot(slot);
    }
  }
  throw lastError ?? new Error("Kiro fetch failed");
}

async function inspectEndpointHttpFailure(
  response: Response,
  signal?: AbortSignal,
): Promise<{ response: Response; fallback: boolean }> {
  if (response.status === 404 || response.status === 405) return { response, fallback: true };
  if (response.status !== 400 && response.status !== 403) return { response, fallback: false };

  const body = await readBoundedResponseBody(response, { signal });
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const rebuilt = new Response(body.displaySafe ? body.text : "", {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  const text = body.displaySafe ? body.text.toLowerCase() : "";
  return { response: rebuilt, fallback: ENDPOINT_ERROR_MARKERS.some(marker => text.includes(marker)) };
}

export async function normalizeFinalKiroHttpError(res: Response, signal?: AbortSignal): Promise<Response> {
  return normalizeUpstreamHttpErrorResponse(res, {
    signal,
    formatMessage: payloadText => safeKiroHttpErrorMessage(res.status, res.headers, payloadText),
  });
}

async function inspectKiroThrottle(
  response: Response,
  signal?: AbortSignal,
): Promise<{ response: Response; transient: boolean; delayMs: number } | undefined> {
  if (response.status !== 429) return undefined;
  const body = await readBoundedResponseBody(response, { signal });
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const payloadText = body.displaySafe ? body.text : "";
  const rebuilt = new Response(payloadText, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  const failure = classifyKiroHttpError(response.status, headers, payloadText);
  const retryAfter = resolveClientRetryAfter({
    status: response.status,
    message: failure.message,
    upstreamRetryAfter: headers.get("retry-after"),
  });
  const delayMs = retryAfter === "0" ? 0 : parseRetryAfterMs(retryAfter) ?? 2_000;
  return {
    response: rebuilt,
    transient: failure.retryable && failure.code === "rate_limit_exceeded",
    delayMs,
  };
}

async function fetchKiroAttempt(
  request: AdapterRequest,
  ctx: KiroFetchContext,
  timeoutMs: number,
  notePhysicalSend: (reset: boolean) => void,
  remaining: () => number,
): Promise<Response> {
  const plannedUrl = request.url;
  let response: Response;
  try {
    response = await fetchWithResetRecovery(request, plannedUrl, ctx, timeoutMs, notePhysicalSend, remaining);
  } catch (error) {
    // The legacy host must mirror the CURRENT destination: a reset rebuild retargets the
    // request, and falling back to the original region would send its new credentials there.
    const currentLegacy = legacyUrl(request.url);
    if (!currentLegacy || !endpointConnectFailure(error)) throw error;
    return fetchWithResetRecovery(request, currentLegacy, ctx, timeoutMs, notePhysicalSend, remaining);
  }

  if (!response.ok && (response.status === 502 || response.status === 503 || response.status === 504)) {
    const baseUrl = response.url || request.url || plannedUrl;
    // The rotation is one MORE physical send on the unified ledger: it is only affordable
    // while the request still has a send left, so the final count never crosses the cap.
    const alternate = ctx.allowGatewayRotation === false || remaining() < 1 ? undefined : legacyUrl(baseUrl);
    if (alternate) {
      cancelResponseBodyBestEffort(response);
      return fetchWithResetRecovery(request, alternate, ctx, timeoutMs, notePhysicalSend, remaining);
    }
  }
  const currentLegacy = legacyUrl(request.url);
  if (currentLegacy && !response.ok) {
    const inspected = await inspectEndpointHttpFailure(response, ctx.abortSignal);
    response = inspected.response;
    if (inspected.fallback && remaining() >= 1) {
      cancelResponseBodyBestEffort(response);
      response = await fetchWithResetRecovery(request, currentLegacy, ctx, timeoutMs, notePhysicalSend, remaining);
    }
  }
  return response;
}

/**
 * Kiro owns replay-safe reset recovery, one endpoint fallback, and bounded process-wide transient
 * throttle recovery. The shared probe starts only after a 429, so healthy parallel traffic remains
 * parallel while a throttled account cannot burn every caller's independent retry budget (#532).
 *
 * 统一模型请求 lane（fork 2026-10-23 运维裁决）：外层再套一层 `runOwnedModelHttpRetry`，让真实
 * 上游返回的任何 HTTP 4xx/5xx（含 quota 429、policy 403、invalid request 400——状态优先，
 * 不看 `x-should-retry`，不看响应体文案）在统一预算内重试，默认每逻辑请求共 11 次物理
 * 发送（env `OCX_MODEL_REQUEST_MAX_RETRIES` > config > 地板 10）。三层——外层统一 ladder、
 * throttle 循环、内层 reset ladder——读**同一个**余量函数：每物理发送都经共享 ledger 的
 * `reserveDispatch` 记账，`ownedModelSendsRemaining` 因此随每一发收缩，任何一层的循环上限都
 * 被同一个绝对值相交封顶。Kiro 旧的 RESET 3 × THROTTLE 3（约 18 发/调用）因此不会被改写成
 * 11 × 11——这是 #4546 明令禁止的相乘形态。
 *
 * 协议恢复保持原样并在同一预算内计价：429 throttle 的共享门与冷却、400/403 端点标记的
 * legacy 回退、502/503/504 的一次 gateway rotation、连接重置的本地 replay-safe ladder。
 * 本地拒绝（`SendBudgetExhaustedError`、caller abort、pacing 拒绝）不算模型错误：立即停，
 * 不重试。最终非 2xx 以原有 safe format 交还（`returnRawErrors` 时原文），不隐藏。
 */
export async function fetchKiroWithRetry(request: AdapterRequest, ctx: KiroFetchContext = {}): Promise<Response> {
  const timeoutMs = ctx.timeoutMs ?? 200_000;
  let probeToken: symbol | undefined;
  // One ordinal sequence for the whole call, across the throttle loop, the endpoint fallback
  // and the reset ladder nested inside it. The caller records ordinal 1 itself, so this is what
  // turns "one adapter call" back into the physical count the request actually made.
  let physicalSends = 0;
  let throttleRound = 0;
  const notePhysicalSend = (reset: boolean): void => {
    physicalSends += 1;
    const recovery: AttemptRecoveryKind | undefined = reset
      ? "connection-reset"
      : throttleRound > 0 ? "rate-limit-429" : undefined;
    ctx.onPhysicalSend?.({ ordinal: physicalSends, ...(recovery ? { recovery } : {}) });
  };
  // 统一余量视图：有 sendBudget 时读共享 ledger（本请求所有 leg 的消耗都算数），
  // context-free 时以本次调用自己的物理发送计数为权威（一次闭包轮可含多物理发送）。
  const budgetOptions = {
    ...(ctx.sendBudget ? { sendBudget: ctx.sendBudget } : {}),
    physicalSends: () => physicalSends,
  };
  const remaining = (): number => ownedModelSendsRemaining(budgetOptions);
  // 抛给统一 scope 的错误终结整条 ladder（合同红线）：TimeoutError 按既有契约沉淀为 504，
  // caller abort 原样上抛，其余原样。
  const runLadder = (): Promise<Response> => fetchKiroLadder(
    request, ctx, timeoutMs, notePhysicalSend, remaining,
    () => probeToken,
    (token: symbol | undefined) => { probeToken = token; },
    (token: symbol | undefined) => { releaseKiroThrottleProbe(token); },
    round => { throttleRound = round; },
  ).catch(error => {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    if (error instanceof Error && error.name === "TimeoutError") {
      // Locally synthesized (the upstream never answered): not an HTTP receipt, and the
      // request may still be in flight upstream. Non-replayable by contract. The marker
      // mutates in place and returns void, so the settlement response is returned on its
      // own line - returning the marker call would type this branch as void.
      const timeoutResponse = new Response("Kiro upstream gateway timeout", { status: 504 });
      markResponseNonReplayable(timeoutResponse);
      return timeoutResponse;
    }
    throw error;
  });
  const raw = await runOwnedModelHttpRetry(runLadder, {
    ...(ctx.sendBudget ? { sendBudget: ctx.sendBudget } : {}),
    physicalSends: () => physicalSends,
    ...(ctx.modelRetryBaseDelayMs !== undefined ? { baseDelayMs: ctx.modelRetryBaseDelayMs } : {}),
    ...(ctx.modelRetryMaxDelayMs !== undefined ? { maxDelayMs: ctx.modelRetryMaxDelayMs } : {}),
    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    ...(ctx.onRecoveryWithheld ? { onRecoveryWithheld: ctx.onRecoveryWithheld } : {}),
    label: "kiro",
  });
  return ctx.returnRawErrors ? raw : normalizeFinalKiroHttpError(raw, ctx.abortSignal);
}

/**
 * 一轮旧契约的执行体：throttle 门 + 一次 attempt（内含 reset ladder、gateway rotation 与
 * 端点回退）。throttle 循环保留为有界恢复形态（共享冷却的语义见 #532），循环上限与 reset
 * 层一样被统一余量相交封顶。非瞬态/瞬态 429 都原样返回，由外层统一 ladder 决定继续与否；
 * 池形态（`kiroPreferAccountFailover`）把 429 直接交还，换账号由外层 ledger 的 alternate
 * 语义约束，不在这里消耗。
 */
async function fetchKiroLadder(
  request: AdapterRequest,
  ctx: KiroFetchContext,
  timeoutMs: number,
  notePhysicalSend: (reset: boolean) => void,
  remaining: () => number,
  currentProbeToken: () => symbol | undefined,
  setProbeToken: (token: symbol | undefined) => void,
  releaseProbe: (token: symbol | undefined) => void,
  noteThrottleRound: (round: number) => void,
): Promise<Response> {
  const loopCap = Math.max(1, Math.min(THROTTLE_ATTEMPTS, remaining()));
  try {
    for (let attempt = 0; attempt < loopCap; attempt++) {
      noteThrottleRound(attempt);
      if (!currentProbeToken()) setProbeToken(await enterKiroThrottleGate(ctx.abortSignal));
      else await waitForKiroCooldown(ctx.abortSignal);

      const response = await fetchKiroAttempt(request, ctx, timeoutMs, notePhysicalSend, remaining);
      const throttle = await inspectKiroThrottle(response, ctx.abortSignal);
      if (throttle && ctx.kiroPreferAccountFailover) return throttle.response;
      if (!throttle) return response;
      if (!throttle.transient) {
        // 配额/永久拒绝：交还外层结算（状态门上它仍是 4xx，统一 lane 继续重试）。
        return throttle.response;
      }
      const claim = claimKiroThrottleProbe(throttle.delayMs, currentProbeToken());
      if (!claim.token) {
        cancelResponseBodyBestEffort(throttle.response);
        await waitWithAbort(claim.wait!, ctx.abortSignal);
        setProbeToken(undefined);
        continue;
      }
      // 本层循环用完或拿到了冷却所有权：交还这轮答案，由外层统一 ladder 继续。
      return throttle.response;
    }
    throw new Error("Kiro throttle retry loop exhausted without a response");
  } finally {
    releaseProbe(currentProbeToken());
  }
}
