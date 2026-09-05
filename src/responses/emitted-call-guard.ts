/**
 * Emitted-call guard - the single entry point for every "the routed model called
 * a tool by the wrong name" repair.
 *
 * Routed models (Q38-class and friends) get the Codex tool protocol wrong in a
 * handful of recurring ways. Historically each symptom was patched where it was
 * first observed, which spread one decision across three files and made the
 * policy hard to see. This module gathers the whole decision so the caller asks
 * one question - "what should I do with this emitted call?" - and the ordering
 * between the layers is stated exactly once:
 *
 *   1. SHAPE REPAIR   the name is wrong but maps back to exactly one declared
 *                     tool, so rewrite it and let the call through.
 *   2. LEAK FEEDBACK  the name is a namespace container (the model called
 *                     "tools" itself), so replace the call with a directive
 *                     error the model can act on.
 *   3. PHANTOM DROP   the name is a known hallucination for this provider, so
 *                     remove the call entirely and keep the turn alive.
 *   4. FAIL CLOSED    none of the above, so surface a 502 rather than relay an
 *                     unknown call to the client.
 *
 * The invariant that matters: repair only ever fires on a UNIQUE match. A name
 * that matches nothing, or matches more than one declared tool, is left alone so
 * the layers below decide. Guessing between two real tools would be a worse
 * failure than the interruption it avoids.
 *
 * Every layer also reports through the optional onDecision hook. That is what
 * turns the historical "add a name to the allowlist whenever someone notices a
 * new one" loop into something observable: callers can count repairs, leaks and
 * drops per model and see a regression coming instead of meeting it by hand.
 */

import { normalizeDeclaredToolName, repairEmittedToolName } from "../types";
import {
  buildNamespaceLeakFeedback,
  EXEC_REPAIR_TOOL_NAME,
  repairExecEnvelopeLeak,
} from "./exec-envelope-repair";

export { EXEC_REPAIR_TOOL_NAME };

/** What the caller should do with one emitted tool call. */
export type EmittedCallVerdict =
  /** Relay the call under the resolved name, which shape repair may have rewritten. */
  | { kind: "allow"; name: string; repaired: boolean }
  /** Drop the call entirely; no output item should ever be opened for it. */
  | { kind: "drop"; name: string }
  /**
   * Replace the call with a directive-error exec body: the client runs it and
   * the thrown message returns to the model as the tool result.
   */
  | { kind: "feedback"; name: string; input: string };

/** Why a verdict was reached - the axis worth alerting on. */
export type EmittedCallDecision =
  | "declared"
  | "repaired"
  | "namespace-leak"
  | "phantom-drop"
  | "undeclared";

export interface EmittedCallGuardOptions {
  /** Wire names the request declared. Absent or empty means no catalog, so nothing is enforced. */
  declaredToolNames?: ReadonlySet<string>;
  /** Declared names that take freeform input (exec-style). Drives leak feedback. */
  freeformToolNames?: ReadonlySet<string>;
  /** Provider-configured hallucinated names (undeclaredToolAllowlist) to drop on sight. */
  phantomNames?: ReadonlySet<string>;
  /** Observability hook. Never affects the verdict. */
  onDecision?: (info: { emitted: string; effective: string; decision: EmittedCallDecision }) => void;
}

/**
 * Resolve one emitted tool name to a verdict.
 *
 * The emitted name is the raw name the model sent; the returned name is the wire
 * name the caller should use. Enforcement is opt-in: with no catalog the call is
 * allowed through untouched.
 */
export function resolveEmittedCall(
  emitted: string,
  options: EmittedCallGuardOptions = {},
): EmittedCallVerdict {
  const declared = options.declaredToolNames;
  if (!declared || declared.size === 0) return { kind: "allow", name: emitted, repaired: false };

  const normalized = normalizeDeclaredToolName(emitted, declared);
  const effective = repairEmittedToolName(normalized, declared);

  const report = (decision: EmittedCallDecision): void => {
    options.onDecision?.({ emitted, effective, decision });
  };

  if (declared.has(effective)) {
    report(effective === emitted ? "declared" : "repaired");
    return { kind: "allow", name: effective, repaired: effective !== emitted };
  }

  // Undeclared from here: a repair miss, a namespace leak, or a phantom.
  const phantom = options.phantomNames;
  // Match either the repaired name or the raw emission, because a provider may
  // have recorded the name in whichever form the model first produced it.
  const isPhantom = phantom !== undefined && (phantom.has(effective) || phantom.has(emitted));
  if (!isPhantom) {
    report("undeclared");
    return { kind: "drop", name: effective };
  }

  const feedback = buildNamespaceLeakFeedback(effective, declared, options.freeformToolNames);
  if (feedback !== undefined) {
    report("namespace-leak");
    return { kind: "feedback", name: effective, input: feedback };
  }
  report("phantom-drop");
  return { kind: "drop", name: effective };
}

export { repairExecEnvelopeLeak };
