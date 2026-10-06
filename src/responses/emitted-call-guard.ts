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

import { normalizeDeclaredToolName, repairEmittedToolName } from "../types/tools";
import type { DroppedEmitDecision } from "../usage/telemetry-contract";
import {
  buildNamespaceLeakFeedback,
  buildUndeclaredToolFeedback,
  EXEC_REPAIR_TOOL_NAME,
  repairExecEnvelopeLeak,
  isNamespaceContainerName,
} from "./exec-envelope-repair";

export { EXEC_REPAIR_TOOL_NAME };

/** Empty catalog used by callers that must ask "is this a namespace?" without one. */
const EMPTY_DECLARED_TOOL_NAMES: ReadonlySet<string> = new Set();

/**
 * The enforcement predicate shared by the verdict and the caller's fail-closed branch.
 *
 * Both sides must read ONE definition. The bridge used to hand the raw wire opt-out to
 * `resolveEmittedCall` and then re-derive the decision from `!== false` alone, so a request with
 * no catalog at all - where nothing is enforceable - could still be failed closed by a drop the
 * verdict produced for an unrelated reason. Upstream #4735 semantics are unchanged: a catalog
 * that is merely present (even empty) and an explicit `true` both enforce.
 */
export function shouldEnforceDeclaredToolNames(options: {
  enforceDeclaredToolNames?: boolean;
  declaredToolNames?: ReadonlySet<string>;
}): boolean {
  return options.enforceDeclaredToolNames !== false
    && (options.enforceDeclaredToolNames === true || options.declaredToolNames != null);
}

/**
 * Whether a DROPPED emitted name is a tool namespace container (`tools`, `collaboration`).
 *
 * Bridge callers use this to make the drop verdict unconditional for containers: a container is
 * not a callable tool on any wire, so the #4735 "inbound wire defers enforcement" opt-out —
 * which exists to tolerate provider echoes of names the proxy's catalog view missed — must not
 * turn it into a relay. Relaying it only moves the failure to the client, whose tool router
 * reports `unsupported call: <ns>` and ends the turn.
 */
export function isDroppedNamespaceContainer(
  name: string,
  declaredToolNames?: ReadonlySet<string>,
): boolean {
  return isNamespaceContainerName(name, declaredToolNames ?? EMPTY_DECLARED_TOOL_NAMES);
}

/** What the caller should do with one emitted tool call. */
export type EmittedCallVerdict =
  /** Relay the call under the resolved name, which shape repair may have rewritten. */
  | { kind: "allow"; name: string; repaired: boolean }
  /**
   * Drop the call entirely; no output item should ever be opened for it.
   *
   * Deliberately reason-free. The bridge records a drop only at its two SILENT dispositions (the
   * allowlist removal and the deferred-wire container removal); the third, an undeclared call on an
   * enforcing wire, becomes a 502 the client already sees. Those two sites know which rule they
   * are acting on, so a reason field here would be a second statement of a fact the caller holds -
   * and a second statement is a claim that can disagree with the first.
   */
  | { kind: "drop"; name: string }
  /**
   * Replace the call with a directive-error exec body: the client runs it and
   * the thrown message returns to the model as the tool result.
   */
  | { kind: "feedback"; name: string; input: string; reason: "namespace-leak" | "undeclared" };

/** Why a verdict was reached - the axis worth alerting on. */
export type EmittedCallDecision =
  | "declared"
  | "repaired"
  | "namespace-leak"
  | "phantom-drop"
  | "undeclared"
  | "undeclared-feedback";

export interface EmittedCallGuardOptions {
  /** Wire names the request declared. Absent or empty means no catalog, so nothing is enforced. */
  declaredToolNames?: ReadonlySet<string>;
  /**
   * Explicit caller assertion that only request-declared tools may be called. Without a
   * catalog nothing can authorize an emission, so an explicit true fails an undeclared call
   * closed (upstream #4735-era semantics); absent or false keeps the fork's "no catalog
   * means no enforcement" contract for bridge callers that never build one.
   */
  enforceDeclaredToolNames?: boolean;
  /** Declared names that take freeform input (exec-style). Drives leak feedback. */
  freeformToolNames?: ReadonlySet<string>;
  /** Allowlisted hallucinated names to drop on sight (shadow-scoped phantomToolAllowlist). */
  phantomNames?: ReadonlySet<string>;
  /**
   * Names of the custom (function) tools in the request catalog. Passed through to
   * normalizeDeclaredToolName so a direct mcp__<server>__<tool> emission inside a
   * code-mode catalog normalizes to exec (upstream #5925).
   */
  bareCustomToolNames?: ReadonlySet<string>;
  /**
   * Mutable per-request budget for undeclared-tool correction feedback. When
   * present and positive, an undeclared call (allowlisted phantom or fresh
   * hallucination) becomes a directive exec error teaching the model the
   * declared catalog instead of being dropped or failing the turn; each
   * feedback consumes one unit. Exhausted or absent restores the old behavior
   * (allowlisted -> silent drop, everything else -> fail closed).
   */
  undeclaredFeedback?: { remaining: number };
  /** Observability hook. Never affects the verdict. */
  onDecision?: (info: { emitted: string; effective: string; decision: EmittedCallDecision }) => void;
}

/**
 * Resolve one emitted tool name to a verdict.
 *
 * The emitted name is the raw name the model sent; the returned name is the wire
 * name the caller should use. Enforcement is opt-in: with no catalog the call is
 * allowed through untouched, unless the caller explicitly asserted enforceDeclaredToolNames:
 * true, which fails an undeclared emission closed even against an empty catalog.
 */
export function resolveEmittedCall(
  emitted: string,
  options: EmittedCallGuardOptions = {},
): EmittedCallVerdict {
  const declared = options.declaredToolNames;
  if (!declared || declared.size === 0) {
    if (options.enforceDeclaredToolNames === true) {
      // Nothing is declared, so nothing is authorized: the caller asked for fail-closed.
      options.onDecision?.({ emitted, effective: emitted, decision: "undeclared" });
      return { kind: "drop", name: emitted };
    }
    // Without a catalog nothing can be recognised as undeclared, so the call is relayed - except
    // for a tool NAMESPACE container, which is not callable on any wire. Relaying it would hand
    // the client an `unsupported call: <ns>` that ends the turn. The question is asked through
    // the one exported entry point rather than the raw predicate, so this branch and the caller's
    // fail-closed branch cannot give one emission two different answers.
    if (isDroppedNamespaceContainer(emitted, declared)) {
      options.onDecision?.({ emitted, effective: emitted, decision: "namespace-leak" });
      return { kind: "drop", name: emitted };
    }
    return { kind: "allow", name: emitted, repaired: false };
  }

  const normalized = normalizeDeclaredToolName(emitted, declared, undefined, options.bareCustomToolNames);
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
    // Fresh hallucination outside the allowlist: with a shadow-scoped correction
    // budget and an exec channel, reject directive-style (listing the declared
    // catalog) instead of failing the whole turn. Budget exhausted keeps the old
    // fail-closed verdict, which the caller surfaces as a 502.
    const freshCorrection = buildUndeclaredToolFeedback(effective, declared, options.freeformToolNames);
    if (freshCorrection !== undefined && options.undeclaredFeedback && options.undeclaredFeedback.remaining > 0) {
      options.undeclaredFeedback.remaining -= 1;
      report("undeclared-feedback");
      return { kind: "feedback", name: effective, input: freshCorrection, reason: "undeclared" };
    }
    report("undeclared");
    return { kind: "drop", name: effective };
  }

  const feedback = buildNamespaceLeakFeedback(effective, declared, options.freeformToolNames);
  if (feedback !== undefined) {
    report("namespace-leak");
    return { kind: "feedback", name: effective, input: feedback, reason: "namespace-leak" };
  }
  // Allowlisted phantom: silent drop keeps the turn alive but teaches nothing.
  // Spend one budget unit on a directive rejection instead, when possible.
  const correction = buildUndeclaredToolFeedback(effective, declared, options.freeformToolNames);
  if (correction !== undefined && options.undeclaredFeedback && options.undeclaredFeedback.remaining > 0) {
    options.undeclaredFeedback.remaining -= 1;
    report("undeclared-feedback");
    return { kind: "feedback", name: effective, input: correction, reason: "undeclared" };
  }
  report("phantom-drop");
  return { kind: "drop", name: effective };
}

/**
 * Which telemetry decision describes a drop the bridge is about to carry out.
 *
 * Exported so the four bridge drop sites (streaming and buffered, phantom branch and container
 * branch) cannot each invent their own label for the same event. The container rule is asked
 * through `isDroppedNamespaceContainer` against both the resolved name and the raw emission -
 * the same test the caller's own unconditional-drop uses - so a name the guard dropped as a
 * phantom but which is provably a namespace container reports as the container it is. That
 * distinction is the entire point of the field: "a known hallucination went away" and "the model
 * called the namespace itself" have different fixes.
 */
export function droppedEmitDisposition(
  effective: string,
  emitted: string,
  declaredToolNames?: ReadonlySet<string>,
): DroppedEmitDecision {
  return isDroppedNamespaceContainer(effective, declaredToolNames)
    || isDroppedNamespaceContainer(emitted, declaredToolNames)
    ? "namespace-container"
    : "phantom";
}

export { repairExecEnvelopeLeak };
