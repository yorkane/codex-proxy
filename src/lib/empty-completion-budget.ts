/**
 * The empty-completion replay BUDGET (fork addition).
 *
 * Lives as a pure leaf next to `shadow-call.ts` rather than inside the guard module so that the
 * config schema and the config diagnostics can name the same ceiling as the runtime without
 * importing `src/server/**`. A bound that the validator and the consumer each write down
 * separately is a bound that drifts: the schema would accept what the pipeline clamps away.
 *
 * `emptyCompletionRetry` is the switch and this is the amount behind it: absent config means 1,
 * the single identical-turn replay the guard shipped with. Each replay re-issues the WHOLE turn,
 * so every extra attempt is another billable generation and a slower dead turn — the ceiling is
 * deliberately small.
 *
 * `OCX_EMPTY_COMPLETION_RETRY_MAX` differs from `OCX_EMPTY_COMPLETION_RETRY`, which is
 * disable-only: this is an amount rather than a switch, so the environment may RAISE it as well
 * as lower it. That is what lets an operator stage a wider replay for one service instance
 * without editing the persisted config, and it is why the resolved value is reported back to the
 * dashboard rather than trusting what config.json says.
 */
import type { OcxConfig } from "../types";

export const EMPTY_COMPLETION_RETRY_MAX_ENV = "OCX_EMPTY_COMPLETION_RETRY_MAX";
export const DEFAULT_EMPTY_COMPLETION_RETRY_MAX = 1;
export const EMPTY_COMPLETION_RETRY_MAX_LIMIT = 3;

/**
 * Resolve how many times an empty completion is replayed, switch-independent.
 *
 * The environment wins over the persisted config — same direction of authority as the disable-only
 * `OCX_EMPTY_COMPLETION_RETRY` override — and anything else falls back to the historical single
 * replay. `0` is a legitimate value and means "replay nothing", the same end state as the switch
 * being off, reached from the budget side. Out-of-range hand edits clamp to the ceiling rather
 * than poisoning the config: a runaway replay loop is the failure mode a bound has to survive, and
 * an unparseable environment value must not silently disable a guard the operator turned on.
 */
export function emptyCompletionRetryMax(
  config: Pick<OcxConfig, "emptyCompletionRetryMax">,
  env: Record<string, string | undefined> = process.env,
): number {
  const fromEnv = env[EMPTY_COMPLETION_RETRY_MAX_ENV];
  const candidate = fromEnv === undefined || fromEnv.trim() === ""
    ? config.emptyCompletionRetryMax
    : Number(fromEnv);
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return DEFAULT_EMPTY_COMPLETION_RETRY_MAX;
  }
  const rounded = Math.floor(candidate);
  if (rounded <= 0) return 0;
  return Math.min(EMPTY_COMPLETION_RETRY_MAX_LIMIT, rounded);
}
