/**
 * Shadow-call intercept routing (fork addition).
 *
 * Kept out of core.ts so upstream edits to the giant responses handler never
 * re-conflict with the intercept block: core.ts resolves the route through the
 * three-line `resolveShadowRoute` call and reads the phantom scope from
 * `shadowPhantomScope`, both defined here.
 */
import type { OcxConfig, OcxParsedRequest } from "../../types";
import type { RequestLogContext } from "../request-log";
import { routeConcreteModel, routeCompactionModel, routeModel, type RouteResult } from "../../router";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
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
  options: { comboAttempt?: boolean };
  resolveRoute: (modelId: string) => RouteResult;
}): ShadowRouteOutcome {
  const { parsed, config, logCtx, options, resolveRoute } = args;
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
  const target = resolveShadowCallTarget(replacement, resolveRoute);
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
  return { route: targetRoute };
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
