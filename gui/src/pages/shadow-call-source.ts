/**
 * Which models the runtime actually intercepts as shadow calls.
 *
 * Codex 0.154.0+ sends gpt-6-luna for helper calls; 0.145.0-0.153.x sent
 * gpt-5.6-luna, which the runtime still intercepts by default. Clients through
 * 0.144.x used gpt-5.4-mini, which operators can restore through `sourceModels`.
 * The GUI renders whatever the runtime reports rather than a baked-in label;
 * this fallback only covers a runtime too old to send `sourceModels`.
 */
// Fork: the per-source editor renders one row per known helper model, so this list is the full
// ChatGPT-native lineup the fork can map (DEFAULT_SHADOW_SOURCE_MODELS in src/lib/shadow-call.ts).
export const DEFAULT_SOURCE_MODELS = ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4-mini"];
// Display fallback for a runtime too old to report sourceModels: the two helper slugs current
// clients actually send, matching the upstream default list.
const FALLBACK_SOURCE_MODELS = ["gpt-6-luna", "gpt-5.6-luna"];

export function shadowSourceModelList(sourceModels?: string[]): string[] {
  const cleaned = Array.isArray(sourceModels)
    ? sourceModels.filter(v => typeof v === "string" && v.trim() !== "").map(v => v.trim())
    : [];
  return cleaned.length > 0 ? cleaned : FALLBACK_SOURCE_MODELS;
}

/** Comma-joined source models for inline badges and warning text. */
export function shadowSourceModelLabel(sourceModels?: string[]): string {
  return shadowSourceModelList(sourceModels).join(", ");
}

/** Short badge form: drops the shared `gpt-` prefix to keep the row compact. */
export function shadowSourceModelBadge(sourceModels?: string[]): string {
  return shadowSourceModelList(sourceModels)
    .map(id => id.replace(/^gpt-/, ""))
    .join(", ");
}
