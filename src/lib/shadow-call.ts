/**
 * Shadow-call intercept source models.
 *
 * Codex's helper calls span the ChatGPT-native lineup. Codex 0.154.0+ sends
 * `gpt-6-luna`; clients from 0.145.0 through 0.153.x sent `gpt-5.6-luna`, and
 * the same client generation also emits gpt-5.6-sol, gpt-5.6-terra, the
 * frontier gpt-5.5, and — through 0.144.x — the cheap tier gpt-5.4-mini. The
 * GPT-6 slug comes first because surfaces show the list in order. Every surface
 * that names the intercepted model (management API, GUI badges/tooltips, CLI)
 * reads it from here instead of hard-coding a slug that goes stale on the next
 * client bump.
 */
export const DEFAULT_SHADOW_SOURCE_MODELS = [
  "gpt-6-luna",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4-mini",
] as const;

/**
 * Optional blocked model redirects at the shared routing layer.
 * When `blockedModelRedirects` is configured (e.g. `{ "gpt-5.6-terra": "gpt-5.6-luna" }`),
 * requests targeting those models are rewritten to the substitute model with
 * routeReason "blocked-model-redirect".
 * Returns undefined when not configured or the model is not in the redirect map.
 */
export function resolveBlockedModelRedirect(
  config: { blockedModelRedirects?: Record<string, string> } | undefined,
  modelId: string,
): string | undefined {
  if (!config?.blockedModelRedirects || typeof config.blockedModelRedirects !== "object") {
    return undefined;
  }
  return config.blockedModelRedirects[modelId];
}

/** Normalize a persisted `sourceModels` override; falls back to the defaults. */
export function shadowSourceModels(configured?: unknown): string[] {
  const configuredStrings = Array.isArray(configured)
    ? configured
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map(v => v.trim())
    : [];
  return configuredStrings.length > 0 ? configuredStrings : [...DEFAULT_SHADOW_SOURCE_MODELS];
}

/**
 * True when `modelId` is one of Codex's helper/shadow source models.
 * Entries are operator-configured, so slash-form entries (`openai/gpt-5.4`)
 * are honored as explicit opt-ins; a slash-free request id still has to be a
 * plain slug (an explicit routed selection is never hijacked by a bare entry).
 */
export function isShadowSourceModel(modelId: string, configured?: unknown): boolean {
  if (modelId.includes("/")) return !!shadowSourceModelPrefix(modelId, configured);
  return shadowSourceModels(configured).some(prefix => modelId.startsWith(prefix));
}

/**
 * The configured source prefix this model matched, or undefined.
 *
 * Callers that RECORD the intercepted model must record this rather than the caller's raw
 * `modelId`. Matching is by prefix, so `gpt-5.6-luna` plus arbitrary trailing text still
 * intercepts — and the raw string is caller-controlled, reaches `usage.jsonl` and `/api/logs`,
 * and only passes a pattern-based redactor on the way. A credential family that redactor does
 * not recognize survives verbatim. Returning the operator-configured prefix keeps the log
 * field inside a set the operator chose, so no caller string is ever persisted.
 */
export function shadowSourceModelPrefix(modelId: string, configured?: unknown): string | undefined {
  const sources = shadowSourceModels(configured);
  // Longest prefix wins: `gpt-5.4` must not shadow `gpt-5.4-mini` when both
  // are configured (array order is user-editable, so order can't decide).
  let best: string | undefined;
  for (const prefix of sources) {
    if (modelId.startsWith(prefix) && (!best || prefix.length > best.length)) best = prefix;
  }
  return best;
}

/**
 * Resolve the per-source-model replacement id for a shadow source model.
 *
 * Per-source granularity (Plan B): `shadowCallIntercept.modelMap` maps a
 * source prefix to its own replacement, so luna/sol/terra/5.5/5.4-mini can
 * each route to a different third-party model. A source prefix absent from
 * modelMap falls back to the shared `shadowCallIntercept.model`; when that is
 * also unset the source model is NOT intercepted (left native). Returns the
 * replacement id, or undefined when no replacement is configured for it.
 */
export function shadowCallReplacementFor(
  modelId: string,
  sci: { model?: string; modelMap?: Record<string, string>; sourceModels?: unknown } | undefined,
): string | undefined {
  if (!sci) return undefined;
  const prefix = shadowSourceModelPrefix(modelId, sci.sourceModels);
  if (!prefix) return undefined;
  if (sci.modelMap && typeof sci.modelMap === "object") {
    const mapped = sci.modelMap[prefix];
    if (typeof mapped === "string" && mapped.trim() !== "") return mapped;
  }
  const fallback = sci.model;
  if (typeof fallback === "string" && fallback.trim() !== "") return fallback;
  return undefined;
}

export interface ShadowCallModelIdentity {
  providerName: string;
  modelId: string;
}

/** Match a source prefix and replacement as a provider+model pair, never by slug alone. */
export function shadowCallTargetsIntersect(
  source: ShadowCallModelIdentity,
  target: ShadowCallModelIdentity,
): boolean {
  return source.providerName === target.providerName
    && target.modelId.startsWith(source.modelId);
}

/**
 * Decide whether a matching source model should use the opt-in intercept.
 *
 * Before Codex 0.147.0 this checked x-codex-turn-metadata and exempted
 * request_kind "turn". Codex 0.147.0 can label background helper calls as
 * "turn", causing them to bypass the intercept (#1684). The fix is to
 * intercept every configured shadow source model regardless of request kind.
 * A replacement intersecting the same provider+model source set remains a
 * no-op because rewriting it would only create self-interception (#2706).
 *
 * Callers skip this check entirely for spawned sub-agent turns
 * (`isThreadSpawnRequest`): `gpt-6-luna` is both the helper slug and a default
 * sub-agent model, and an explicitly spawned child must keep the model it chose.
 */
export function shouldInterceptShadowCall(
  modelId: string,
  configured: unknown,
  source: ShadowCallModelIdentity,
  target: ShadowCallModelIdentity,
): boolean {
  return isShadowSourceModel(modelId, configured)
    && !shadowCallTargetsIntersect(source, target);
}
/**
 * Global phantom-tool allowlist for shadow-intercepted requests.
 *
 * A replacement model that was trained on the Codex tool surface replays
 * native tool names the request never declared (`update_plan`, the
 * `collaboration__` flattened form, namespace containers like `tools`, and
 * sandbox-prefixed compositions like `tools__web_run`). This is a property of
 * THE MODEL, not of the provider hosting it, so the list lives with the shadow
 * intercept instead of per-provider config: any provider a shadow call is
 * routed to inherits it, and switching the replacement never requires
 * re-copying the list. The emitted-call guard consumes it as the drop/feedback
 * set: a listed name is dropped (or, for namespace leaks, answered with
 * directive feedback) instead of failing the turn closed with a 502.
 *
 * `phantomToolAllowlistEnabled` (default true) is the kill switch; when true
 * and no explicit list is stored, the built-in defaults below apply. An
 * explicit empty array is an operator-chosen empty list — every undeclared
 * call then fails closed. Names are matched after call-shape repair, against
 * both the repaired name and the raw emission.
 */
export const DEFAULT_PHANTOM_TOOL_ALLOWLIST = [
  "update_plan",
  "collaboration__update_plan",
  "web__run",
  "web__search",
  "tools",
  "update_goal",
  "tools__web_run",
  "tools__web_search",
  "tools__apply_patch",
] as const;

export interface ShadowPhantomConfig {
  phantomToolAllowlistEnabled?: boolean;
  phantomToolAllowlist?: unknown;
}

/** Resolve the effective shadow phantom list (defaults applied, malformed entries dropped). */
export function shadowPhantomToolNames(sci: ShadowPhantomConfig | undefined): Set<string> {
  if (sci?.phantomToolAllowlistEnabled === false) return new Set();
  const configured = Array.isArray(sci?.phantomToolAllowlist)
    ? (sci!.phantomToolAllowlist as unknown[])
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map(v => v.trim())
      .sort()
    : null;
  return new Set(configured ?? DEFAULT_PHANTOM_TOOL_ALLOWLIST);
}


/**
 * Stored allowlist for the management API: returns the operator list when one is
 * persisted, else the defaults — matching what shadowPhantomToolNames() applies at
 * runtime — so the UI edits real effective values, never an empty box.
 */
export function shadowPhantomToolList(sci: ShadowPhantomConfig | undefined): string[] {
  return Array.from(shadowPhantomToolNames(sci)).sort();
}
