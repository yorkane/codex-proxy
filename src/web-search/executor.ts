import type { OcxProviderConfig } from "../types";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { redactSecretString } from "../lib/redact";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { applyUpstreamRecoveryInit } from "../lib/upstream-retry";
import { fetchSidecarModel } from "../lib/sidecar-model-retry";
import { withUpstreamHttpVersion } from "../lib/upstream-http-version";
import { parseSidecarSSE, type WebSearchResult } from "./parse";
import type { CodexUpstreamOutcome } from "../codex/routing";
import { NATIVE_RESERVE_MODEL } from "../codex/catalog/native-models";
import { openAiSidecarCreditRefusal } from "../providers/openai-sidecar-credit";

export interface SidecarSettings {
  model: string;
  reasoning: string;
  timeoutMs: number;
  /**
   * 统一模型重试预算的全局配置值（`config.modelRequestMaxRetries`）。调用方从自己的配置
   * 带入，env `OCX_MODEL_REQUEST_MAX_RETRIES` 在 leaf 内压过它，地板 10、上限 100。缺省
   * （plan 未带）解析为默认 10 次重试 + 首发 = 11。sidecar 的 `timeoutMs` 是显式用户预算：
   * 统一预算超它会以真实错误（最后一个上游响应）收尾，不伪装成功。
   */
  modelRequestMaxRetries?: number;
  /** Effective Desktop authless compatibility does not grant auxiliary model use. */
  reserveCompatibility?: boolean;
  /**
   * True when the routed (downstream) model is text-only. The search model CAN see images, so it's
   * told to verbalize any relevant image results and include their URLs — otherwise a non-vision model
   * would receive bare image links it cannot interpret (the image-web-search gap).
   */
  describeImages?: boolean;
}

// Shared with the anthropic-backed executor (single source; audit F3). The instruction is
// backend-agnostic — both the gpt-mini sidecar and a Claude sidecar answer the same way.
export const BASE_INSTRUCTION =
  "You are a web-search assistant. Use the web_search tool to find current information for the " +
  "user's query, then reply with a concise, factual answer. End your reply with a `Sources:` " +
  "section listing each source you used on its own line as `- Title: URL` (one per line).";
export const IMAGE_INSTRUCTION =
  " The model that will read your answer is TEXT-ONLY and cannot see images: if the results include " +
  "relevant images, describe what they show in words and include their source URLs in your answer.";

/** A search result, or an `error` string when the search couldn't run (surfaced as a tool result). */
export type SidecarOutcome = WebSearchResult & { error?: string };

export type SidecarOutcomeRecorder = (outcome: CodexUpstreamOutcome) => void;

/**
 * Execute ONE web search via the gpt-mini sidecar through the ChatGPT forward backend — the only path
 * with a real server-side web_search. Reuses selected forwarded OAuth headers (the forward adapter
 * has no key of its own), replays the hosted web_search tool config verbatim, and runs the mini at
 * minimal reasoning. Never throws — returns `{error}` so the caller injects a graceful tool result.
 */
export async function runWebSearch(
  query: string,
  hostedTool: Record<string, unknown>,
  forwardProvider: OcxProviderConfig,
  selectedForwardHeaders: Headers,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
  recordOutcome?: SidecarOutcomeRecorder,
  beforeDispatch?: () => void,
): Promise<SidecarOutcome> {
  if (settings.reserveCompatibility && settings.model === NATIVE_RESERVE_MODEL) {
    return { text: "", sources: [], error: "Luna Reserve compatibility is only available as a conversation model, not a search helper. Choose another search helper model." };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (forwardProvider.headers) Object.assign(headers, forwardProvider.headers);
  for (const h of FORWARD_HEADERS) {
    const v = selectedForwardHeaders.get(h);
    if (v) headers[h] = v;
  }
  const body = {
    model: settings.model,
    instructions: settings.describeImages ? BASE_INSTRUCTION + IMAGE_INSTRUCTION : BASE_INSTRUCTION,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [hostedTool],
    tool_choice: "auto",
    reasoning: { effort: settings.reasoning },
    // NOTE: the ChatGPT (codex) backend rejects `max_output_tokens` ("Unsupported parameter") and
    // requires `store: false` — keep this body minimal. The shared SSE parser bounds raw response
    // bytes before format-result applies its smaller display clamp.
    store: false,
    stream: true,
  };
  const url = `${forwardProvider.baseUrl}/responses`;
  // t0 precedes the deadline timer's start so the remaining-time check stays conservative.
  const t0 = Date.now();
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  try {
      // 统一模型合同（2026-10-23）：一次 sidecar 模型调用 = 一份请求 body，全部真实上游 HTTP
      // 4xx/5xx 走 model lane 的单一共享发送预算（env > settings 配置 > 地板 10 次重试），
      // transient 与 connection-reset 两层共享同一总额、不相乘。旧的「reset 3 + 429 独立 3」
      // 双层预算由 helper 的单一 attempts 取代。Retry-After 作为完整下限受显式 sidecar
      // timeoutMs 约束（retryAfterCeilingMs = 剩余预算：超预算的指令以真实的 429/5xx 收尾，
      // 不伪 429/200）；caller abort 全程停止。旧的预重试 429 body 释放由 helper 的
      // cancel-before-retry 承担。
      const res = await fetchSidecarModel(
      // Recovery nests INSIDE the version helper: applyUpstreamRecoveryInit then always receives a
      // defined init, and withUpstreamHttpVersion spreads the result, so `protocol` and the
      // recovery fields (`connection: close` + Bun's transport-level `keepalive: false`) survive
      // together. The reverse order needs a `?? init` fallback to type-check at all.
      recovery => {
        beforeDispatch?.();
        return fetch(url, withUpstreamHttpVersion(url, applyUpstreamRecoveryInit({
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: linkedSignal.signal,
          // Credential-bearing: do not follow a cross-origin 3xx. Bun strips `Authorization`
          // across origins but forwards nonstandard headers such as `chatgpt-account-id`,
          // `session_id`, and `x-codex-turn-metadata` to the redirect target.
          redirect: "manual",
        }, recovery), forwardProvider));
      },
        {
          abortSignal: linkedSignal.signal,
          label: "web-search-sidecar",
          configuredRetries: settings.modelRequestMaxRetries,
          targetKey: () => url,
          retryAfterCeilingMs: settings.timeoutMs - (Date.now() - t0),
        },
    );
    // Attach the body guard before ANY branch reads it. The success path guarded itself below,
    // but the failure branch's `res.text()` runs first, so a cancel landing between fetch
    // resolution and reader attach orphaned the internal rejection (found investigating #1419).
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    if (!res.ok) {
      recordOutcome?.(res.status);
      const t = await res.text().catch(() => "");
      detachBodyGuard();
      console.warn(`[web-search] sidecar HTTP ${res.status} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
      return { text: "", sources: [], error: `sidecar HTTP ${res.status}: ${redactSecretString(t.slice(0, 200))}` };
    }
    try {
      const parsed = await parseSidecarSSE(res);
      if (linkedSignal.signal.aborted) throw linkedSignal.signal.reason;
      recordOutcome?.(res.status);
      return parsed;
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const policyRefusal = openAiSidecarCreditRefusal(e);
    if (policyRefusal) return { text: "", sources: [], error: policyRefusal.message };
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    const callerAborted = abortSignal?.aborted === true
      && linkedSignal.signal.aborted
      && linkedSignal.signal.reason === abortSignal.reason
      && e === linkedSignal.signal.reason;
    recordOutcome?.(callerAborted ? "connect_neutral" : kind);
    console.warn(`[web-search] sidecar ${kind} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
