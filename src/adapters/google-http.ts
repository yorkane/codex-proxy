import { inheritAccountAutoPauseResponse } from "../lib/account-auto-pause-response";
import type { AdapterFetchContext, AdapterRequest } from "./base";
import { createAdapterPhysicalSend } from "./physical-send";
import type { SendClass } from "../lib/request-execution-budget";
import type { AttemptRecoveryKind } from "../usage/log";
import { debugProviderDiagnosticLazy } from "../lib/debug";
import { safeGoogleHttpErrorMessage } from "./google-errors";
import { repairGoogleInvalidRequestBodyWithReport } from "./google-wire-compiler";
import type { GoogleToolSchemaPolicy, GoogleToolSchemaProfile } from "./google-tool-schema";
import { normalizeUpstreamHttpErrorResponse, readDisplaySafeErrorPayloadText } from "./upstream-http-error";
import { readBoundedResponseBody } from "../lib/bounded-body";
import {
  abortError,
  cancelResponseBodyBestEffort,
  fetchWithAttemptDeadline,
  retryBackoffDelayMs,
  sleepWithAbort,
  SendBudgetExhaustedError,
  isConnectionResetError,
} from "../lib/upstream-retry";
import { modelRequestMaxAttempts } from "../lib/model-request-retry";

const GOOGLE_RETRY_BASE_MS = 250;
const GOOGLE_RETRY_MAX_MS = 2_000;

export interface GoogleRetryOptions {
  /** Repair-and-replay structurally invalid 400 bodies (Vertex/Antigravity behavior). */
  repairInvalid400?: boolean;
  toolSchemaProfile?: GoogleToolSchemaProfile;
  toolSchemaPolicy?: GoogleToolSchemaPolicy;
}

async function normalizeFinalGoogleError(label: string, res: Response, signal?: AbortSignal): Promise<Response> {
  if (label === "Antigravity" && res.status === 403) {
    const body = await readBoundedResponseBody(res, {
      maxBytes: 4096, totalTimeoutMs: 2000, firstByteTimeoutMs: 2000,
      inactivityTimeoutMs: 2000, signal,
    });
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return inheritAccountAutoPauseResponse(res, new Response(safeGoogleHttpErrorMessage(label, res.status,
      body.displaySafe && !body.truncated ? body.text : ""), {
      status: res.status, statusText: res.statusText, headers,
    }));
  }
  return normalizeUpstreamHttpErrorResponse(res, {
    signal,
    formatMessage: payloadText => safeGoogleHttpErrorMessage(label, res.status, payloadText),
  });
}

/**
 * Fetch a Google-family upstream on the unified model retry lane (fork 2026-10-23):
 * per-attempt timeout, ANY upstream HTTP 4xx/5xx retried (the quota-429
 * veto and the 401/403/404 non-retryable gate are removed per the user's standing order),
 * ladder cap = the request ledger's own `policy.maxTotalModelSends` when a send budget is
 * present (an explicit caller cap is a HARD ceiling and is never widened by the global
 * floor; each send is admitted through createAdapterPhysicalSend, so this inner ladder
 * shares the ledger and multiplies nothing), else the unified leaf default (11).
 * `Retry-After` is a lower bound (never send early; no local ceiling on the model lane —
 * the caller's abort signal is the stop), jittered exponential backoff, and (unless raw
 * mode is used) a classified + redacted final error body. The one-shot 400 repair replay
 * is a physical send and counts against the same cap.
 */
export async function fetchGoogleWithRetry(
  label: string,
  request: AdapterRequest,
  ctx: AdapterFetchContext = {},
  opts: GoogleRetryOptions = {},
): Promise<Response> {
  const repairInvalid400 = opts.repairInvalid400 ?? true;
  const toolSchemaProfile = opts.toolSchemaProfile ?? { endpointClass: "vertex" };
  const toolSchemaPolicy = opts.toolSchemaPolicy ?? "compatible";
  const timeoutMs = ctx.timeoutMs ?? 200_000;
  const send = createAdapterPhysicalSend(ctx);
  // 统一 lane 的 ladder 上限：有账本时账本自己的 policy 是权威（外层 dispatch 每 leg 只发
  // 一送，内层 ladder 由 reserveDispatch 封顶，两层不相乘）；无账本（窄调用方/单测）
  // 用统一 leaf（11 起）。显式 caller cap 是硬上限，floor 只作用在缺省路径。
  const ladderCap = ctx.sendBudget?.policy.maxTotalModelSends ?? modelRequestMaxAttempts();
  // 物理发送计数（含 400 repair replay 与 reserve 被拒的尝试）：loop 以它封顶，
  // repair 的 attempt-- 只回退 backoff 序号，不赎回发送额。
  let sendsMade = 0;
  let lastError: unknown;
  let activeRequest = request;
  let compatibilityReplayUsed = false;
  let pendingResponse: Response | undefined;
  let retryDelayMs = 0;
  let sendClass: SendClass = "transient";
  let recovery: AttemptRecoveryKind | undefined;
  for (let attempt = 0; sendsMade < ladderCap; attempt++) {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    try {
      sendsMade += 1;
      const res = await send({ url: activeRequest.url, sendClass, recovery,
        beforeDispatch: async () => {
          if (retryDelayMs > 0) await sleepWithAbort(retryDelayMs, ctx.abortSignal);
          if (pendingResponse) cancelResponseBodyBestEffort(pendingResponse);
          pendingResponse = undefined;
        },
        dispatch: executor => fetchWithAttemptDeadline(activeRequest.url, {
          method: activeRequest.method, headers: activeRequest.headers, body: activeRequest.body,
        }, timeoutMs, ctx.abortSignal, ctx.stream, executor),
      });
      retryDelayMs = 0;
      sendClass = "transient";
      recovery = undefined;
      if (res.status === 400 && repairInvalid400 && !compatibilityReplayUsed) {
        let payloadText = "";
        try {
          payloadText = await readDisplaySafeErrorPayloadText(res.clone(), ctx.abortSignal);
        } catch (error) {
          if (ctx.abortSignal?.aborted) throw error;
        }
        const repair = repairGoogleInvalidRequestBodyWithReport(activeRequest.body, payloadText, toolSchemaProfile);
        if (repair !== undefined) {
          if (repair.toolSchemaLoss) {
            const changedSendAllowed = toolSchemaPolicy !== "reject-lossy";
            debugProviderDiagnosticLazy("google", "google-tool-schema-repair", () => ({
              ...repair.toolSchemaLoss,
              phase: "repair",
              declarationCount: repair.toolSchemaDeclarationCount ?? 0,
              changedSendAllowed,
            }));
            if (!changedSendAllowed) {
              return ctx.returnRawErrors ? res : normalizeFinalGoogleError(label, res, ctx.abortSignal);
            }
          }
          compatibilityReplayUsed = true;
          activeRequest = { ...activeRequest, body: repair.body };
          pendingResponse = res;
          sendClass = "repair";
          attempt--; // The changed-request replay is separate from transient retry accounting.
          continue;
        }
      }
      // 统一 lane：任何 4xx/5xx 都进重放（quota-exhausted 429 veto 按用户 2026-10-23 裁决
      // 删除——「至少重试 10 次」不以响应体分类为门）。终态返回保持既有分类与脱敏形状。
      if (res.status < 400) {
        return ctx.returnRawErrors ? res : normalizeFinalGoogleError(label, res, ctx.abortSignal);
      }
      if (sendsMade >= ladderCap) {
        return ctx.returnRawErrors ? res : normalizeFinalGoogleError(label, res, ctx.abortSignal);
      }
      pendingResponse = res;
      recovery = res.status === 429 ? "rate-limit-429"
        : res.status >= 500 ? "transient-5xx" : "model-error-retry";
      retryDelayMs = retryBackoffDelayMs(attempt, {
        baseDelayMs: GOOGLE_RETRY_BASE_MS,
        maxDelayMs: GOOGLE_RETRY_MAX_MS,
        headers: res.headers,
        // 模型 lane：Retry-After 是下限，绝不提前发送；本地 max 只约束自研指数退避。
        retryAfterIsLowerBound: true,
      });
    } catch (err) {
      if (ctx.abortSignal?.aborted) throw err;
      if (err instanceof SendBudgetExhaustedError) {
        if (pendingResponse) {
          // The ladder had already classified this response as retryable and was about to send
          // again; the budget refused. Returning the original response is right — it is a real
          // upstream answer — but it used to leave the log indistinguishable from a request
          // where no retry was ever eligible (#5044).
          ctx.onRecoveryWithheld?.({ reason: "retry-send-budget" });
          return ctx.returnRawErrors ? pendingResponse : normalizeFinalGoogleError(label, pendingResponse, ctx.abortSignal);
        }
        throw err;
      }
      lastError = err;
      if (sendsMade >= ladderCap) throw err;
      sendClass = "transient";
      recovery = isConnectionResetError(err) ? "connection-reset" : undefined;
      retryDelayMs = retryBackoffDelayMs(attempt, {
        baseDelayMs: GOOGLE_RETRY_BASE_MS,
        maxDelayMs: GOOGLE_RETRY_MAX_MS,
      });
    }
  }
  throw lastError ?? new Error(`${label} fetch failed`);
}

/**
 * AI Studio direct (`generativelanguage.googleapis.com`) retry wrapper.
 *
 * Direct requests keep the default server error surface — the raw `Provider error <status>:
 * <body>` text the shared Responses path formats — and keep single-shot 400 semantics (no
 * request-shape compatibility replay). The wrapper exists for the failure mode observed in
 * production: AI Studio's transient `503 UNAVAILABLE` "model is currently experiencing high
 * demand" spikes, plus plain rate-limit 429s, both of which previously failed immediately
 * because the default server fetch path only retries connection resets.
 */
export function fetchDirectGeminiWithRetry(
  request: AdapterRequest,
  ctx: AdapterFetchContext = {},
  schemaPolicy: Pick<GoogleRetryOptions, "toolSchemaProfile" | "toolSchemaPolicy"> = {},
): Promise<Response> {
  return fetchGoogleWithRetry("Gemini", request, { ...ctx, returnRawErrors: true }, {
    ...schemaPolicy,
    repairInvalid400: false,
  });
}

/** Vertex AI retry wrapper. */
export function fetchVertexWithRetry(
  request: AdapterRequest,
  ctx: AdapterFetchContext = {},
  schemaPolicy: Pick<GoogleRetryOptions, "toolSchemaProfile" | "toolSchemaPolicy"> = {},
): Promise<Response> {
  return fetchGoogleWithRetry("Vertex AI", request, ctx, {
    toolSchemaProfile: { endpointClass: "vertex" },
    ...schemaPolicy,
  });
}

/** Antigravity (Cloud Code Assist) retry wrapper. */
export function fetchAntigravityWithRetry(
  request: AdapterRequest,
  ctx: AdapterFetchContext = {},
  schemaPolicy: Pick<GoogleRetryOptions, "toolSchemaProfile" | "toolSchemaPolicy"> = {},
): Promise<Response> {
  return fetchGoogleWithRetry("Antigravity", request, ctx, {
    toolSchemaProfile: { endpointClass: "cloud-code-assist" },
    ...schemaPolicy,
  });
}
