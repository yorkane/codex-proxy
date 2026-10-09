/**
 * Shadow-call intercept routing (fork addition).
 *
 * Kept out of core.ts so upstream edits to the giant responses handler never
 * re-conflict with the intercept block: core.ts resolves the route through the
 * three-line `resolveShadowRoute` call and reads the phantom scope from
 * `shadowPhantomScope`, both defined here.
 */
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { RequestLogContext } from "../request-log";
import { routeConcreteModel, routeCompactionModel, routeModel, type RouteResult } from "../../router";
import { isOpenAiOperatedResponsesDestination, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { sanitizeLogMetadataString } from "../../lib/redact";
import {
  isShadowSourceModel,
  shadowCallReplacementFor,
  shadowPhantomToolNames,
  shadowSourceModelPrefix,
  shouldInterceptShadowCall,
} from "../../lib/shadow-call";
import {
  INTERCEPT_TARGET_UNAVAILABLE_CODE,
  interceptTargetUnavailableResponse,
  resolveShadowCallTarget,
} from "./shadow-target-availability";

/** Outcome of the shadow-intercept resolution: a route to use, a refusal to return, or neither. */
export interface ShadowRouteOutcome {
  /** Set when the intercept fired: the request must use this route. */
  route?: RouteResult;
  /** Set when the operator-chosen target stopped resolving; return it to the client as-is. */
  response?: Response;
}

/**
 * Resolve the shadow intercept for the request's current model id, mutating
 * `parsed` in place when the intercept fires (model rewrite, cursor isolation,
 * `_shadowIntercepted` flag) and reporting the replacement route. An empty outcome
 * means the caller falls through to the ordinary route for the model id.
 *
 * A target that no longer resolves yields `response` instead of falling through
 * (#5618, applied per-source): the replacement is the one destination the operator
 * chose, so a dead target fails the helper call once before any send rather than
 * reaching the native model or the router's default-provider fallback. A combo or
 * routing-profile target keeps its own declared failover.
 */
export function resolveShadowRoute(args: {
  parsed: OcxParsedRequest;
  config: OcxConfig;
  logCtx: RequestLogContext;
  /**
   * Resolve a candidate target WITHOUT claiming it as the request's policy route. Upstream 2.76
   * probes the shadow target before interception is decided, so a declined policy target must not
   * lend its eligibility or "policy" route kind to the request.
   */
  probeRoute: (modelId: string) => RouteResult;
  /** Claim the accepted target as the request's route (request-owned policy capture). */
  acceptRoute: (accepted: RouteResult) => RouteResult;
}): ShadowRouteOutcome {
  const { parsed, config, logCtx, probeRoute, acceptRoute } = args;
  const sci = config.shadowCallIntercept;
  if (!sci?.enabled || !isShadowSourceModel(parsed.modelId, sci.sourceModels)) return {};
  const sourcePrefix = shadowSourceModelPrefix(parsed.modelId, sci.sourceModels)!;
  // Each source model resolves its own replacement; no replacement => left native.
  const replacement = shadowCallReplacementFor(parsed.modelId, sci);
  if (!replacement) return {};
  let sourceIdentity = { providerName: OPENAI_CODEX_PROVIDER_ID, modelId: sourcePrefix };
  try {
    const resolvedSource = routeConcreteModel(config, parsed.modelId);
    sourceIdentity = { providerName: resolvedSource.providerName, modelId: sourcePrefix };
  } catch { /* Native Codex helper calls remain OpenAI-owned without an enabled OpenAI route. */ }
  // A dead target fails this helper call once, before any send (#5618).
  const target = resolveShadowCallTarget(replacement, probeRoute);
  if ("unavailable" in target) {
    logCtx.shadowCallRewrittenFrom = sanitizeLogMetadataString(sourcePrefix);
    logCtx.errorCode = INTERCEPT_TARGET_UNAVAILABLE_CODE;
    return { response: interceptTargetUnavailableResponse(replacement, target.unavailable) };
  }
  const targetRoute = target.route;
  if (!shouldInterceptShadowCall(parsed.modelId, sci.sourceModels, sourceIdentity, targetRoute)) return {};
  const original = parsed.modelId;
  parsed.modelId = replacement;
  if (parsed._rawBody && typeof parsed._rawBody === "object") {
    (parsed._rawBody as { model?: string }).model = replacement;
  }
  // Record the operator-configured prefix that matched, NOT the caller's raw model string.
  // Matching is by prefix, so a caller can append arbitrary text and still intercept; that
  // raw value would then land in usage.jsonl and /api/logs behind a pattern-based redactor
  // that does not recognize every credential family. The prefix is a value the operator
  // configured, so no caller-controlled string is persisted.
  logCtx.shadowCallRewrittenFrom = sanitizeLogMetadataString(shadowSourceModelPrefix(original, sci.sourceModels));
  // Helpers must not resume/append into the parent thread's Cursor conversation.
  parsed._cursorIsolateConversation = true;
  // The phantom-tool tolerance below is scoped to shadow-routed requests:
  // replayed tool names are a property of the replacement model, not of any
  // provider, and direct (non-intercepted) traffic keeps fail-closed.
  parsed._shadowIntercepted = true;
  return { route: acceptRoute(targetRoute) };
}

/**
 * 发射名改写（repair）门控：本次请求是否由三方路由服务。
 *
 * 口径来自用户需求：区分官方模型与三方模型。只要流量走的是三方（含 shadow 替换官方名的
 * 那一族），发射名改写/救回照旧进行；OpenAI 自己运营的官方 Responses 端点、且没有被 shadow
 * 替换过的请求，本代理一律不改写，恢复到 phase-1 之前的上游语义（该 502 就 502、该中继就
 * 中继）。判定只有一条，放在 fork 自有文件里，上游对 guard / core.ts 的改动不会与它冲突。
 *
 * 三条规则：
 *  - `parsed._shadowIntercepted === true` -> true：shadow 拦截把官方名换成了运维指定的替换
 *    模型，行为特征与三方一致（现网那批 tools=exec_command / 裸 tools 畸形发射正是这批流量）；
 *  - providerName 为 openai 且 destination 是 OpenAI 运营的 Responses 端点（canonical
 *    chatgpt.com/backend-api/codex 或官方 api.openai.com）-> false；
 *  - 其余一律 true：任意自定义 provider，以及同名 openai 但 baseUrl 指向内网/自建域的
 *    provider（destination 不是官方端点）。
 *
 * 调用方必须传【当前尝试实际使用的 provider】。run-turn-execution 与 passthrough 两侧的
 * `route` 都是请求级的：oauth 账号轮换（rotatedProvider）只换凭证与 adapter，从不写回
 * route.provider，且轮换后的 provider 仍是同一个 openai provider；combo 的每个尝试是独立子
 * 请求，各自解析自己的 route。因此在 shadowScope 旁算一次即与真实出口一致。
 */
export function thirdPartyEmissionRepair(
  parsed: OcxParsedRequest,
  route: { providerName: string; provider: OcxProviderConfig },
): boolean {
  if (parsed._shadowIntercepted === true) return true;
  if (route.providerName === OPENAI_CODEX_PROVIDER_ID && isOpenAiOperatedResponsesDestination(route.provider)) {
    return false;
  }
  return true;
}

/**
 * Shadow-scoped phantom tool names (shadowCallIntercept.phantomToolAllowlist):
 * a replacement model replaying a native tool name the request never declared is
 * dropped (or answered with namespace-leak feedback by the emitted-call guard)
 * instead of failing the turn. Only requests whose model the shadow intercept
 * actually replaced consult the list — direct routes stay fail-closed. Consumed
 * by the passthrough guard rewrite, the passthrough terminal checks, and both
 * bridge translators; empty (disabled or non-shadow) leaves every path
 * byte-identical. The per-request directive-correction budget
 * (phantomToolFeedbackMax, default 2) is allocated only for shadow-intercepted
 * requests with the kill switch on; the bridge translators consume it, the
 * passthrough guard cannot inject feedback and keeps drop/fail-closed semantics.
 */
export function shadowPhantomScope(parsed: OcxParsedRequest, config: OcxConfig): {
  undeclaredPhantomNames: ReadonlySet<string>;
  undeclaredToolFeedbackBudget: { remaining: number } | undefined;
} {
  const shadowIntercepted = parsed._shadowIntercepted === true;
  const sci = config.shadowCallIntercept;
  return {
    undeclaredPhantomNames: shadowIntercepted ? shadowPhantomToolNames(sci) : new Set<string>(),
    undeclaredToolFeedbackBudget:
      shadowIntercepted && sci !== undefined && sci.phantomToolAllowlistEnabled !== false
        ? { remaining: Math.max(0, Math.min(10, sci.phantomToolFeedbackMax ?? 2)) }
        : undefined,
  };
}
