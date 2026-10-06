/**
 * Shadow page types (fork-owned).
 *
 * The GET/PUT /api/shadow-call-settings payload is a superset of the upstream
 * ShadowCallData contract: the fork adds per-source mapping, the phantom-tool
 * allowlist and the empty-completion replay controls, and the diagnostics feed
 * is entirely fork-owned. Those fields are declared here instead of widening the
 * upstream interface in dashboard-shared.ts, so that file stays at zero diff and
 * only this page (and its tests) sees the extended shape. The dashboard polling
 * chain keeps consuming the narrow upstream type, which is accurate for what it
 * reads (enabled/model/sourceModels).
 */
import type { ShadowCallData } from "./dashboard-shared";

/** Shadow-call settings as the fork's management API reports and accepts them. */
export interface ShadowCallSettings extends ShadowCallData {
  /** Per-source-model replacement ids; a source absent from the map falls back to model. */
  modelMap?: Record<string, string>;
  /** Shadow-scoped phantom-tool tolerance kill switch (default on). */
  phantomToolAllowlistEnabled?: boolean;
  /** Effective phantom-tool names tolerated for shadow-replaced requests. */
  phantomToolAllowlist?: string[];
  /** Built-in default list, for the reset-to-defaults action. */
  phantomToolDefaults?: string[];
  /** Directive corrections per shadow request before dropping/failing (default 2). */
  phantomToolFeedbackMax?: number;
  /** Top-level config: replay an empty (reasoning-only) completion once. */
  emptyCompletionRetry?: boolean;
  /** True while OCX_EMPTY_COMPLETION_RETRY=0 forces the guard off regardless of the switch. */
  emptyCompletionRetryEnvOverride?: boolean;
  /**
   * How many times the guard replays, as the SERVER resolved it, so an environment
   * override is visible instead of leaving the input editing a number that has no effect.
   */
  emptyCompletionRetryMax?: number;
  /** Accepted range; the server rejects anything outside it with 400. */
  emptyCompletionRetryMaxMin?: number;
  emptyCompletionRetryMaxLimit?: number;
  /** True while OCX_EMPTY_COMPLETION_RETRY_MAX overrides the persisted budget. */
  emptyCompletionRetryMaxEnvOverride?: boolean;
}

/**
 * Recent tool-call dispositions and empty-completion replays, projected from the in-memory
 * request log by GET /api/shadow-diagnostics. The kinds list comes from the server so the
 * filter cannot offer a category the feed never produces.
 */
export interface ShadowDiagnosticEvent {
  ts: number;
  kind: string;
  requestId: string;
  model: string;
  provider: string;
  status: number;
  detail: string;
  names: string[];
  count: number;
}

export interface ShadowDiagnosticsData {
  generatedAt: number;
  timeZone: string;
  kinds: string[];
  total: number;
  events: ShadowDiagnosticEvent[];
}
