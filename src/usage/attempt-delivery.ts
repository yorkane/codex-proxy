/**
 * Counting what an attempt delivered, without recording what it said.
 *
 * The recorder below is bound to a request-scoped object and reaches the CURRENT attempt through
 * a callback rather than holding one. An attempt can be rotated mid-request -- a key-account
 * change seals the old one and starts a fresh one -- and a recorder holding a reference would
 * keep crediting frames to an attempt that had already been finalized and snapshotted.
 *
 * Nothing here reads a payload's content. `semanticBytes` is a length; the event classification
 * reads only a frame's type name and an item's type name, both of which are protocol constants.
 */
import type {
  AttemptDeliverySummary,
  AttemptDroppedEmit,
  DroppedEmitDecision,
} from "./telemetry-contract";
import { DROPPED_EMIT_DECISION_ROSTER } from "./telemetry-contract";

/** Repeats of one (name, decision) pair fold into a single row, bounded so a runaway model cannot grow the row. */
const MAX_DROPPED_EMIT_ROWS = 16;

export interface AttemptDeliveryTarget {
  deliverySummary?: AttemptDeliverySummary;
  /**
   * Client tool calls this attempt had REMOVED from the relay by the emitted-call guard,
   * as opposed to calls the model never made. Absent on ordinary attempts, so pre-instrumentation
   * rows keep their exact shape.
   */
  droppedEmits?: AttemptDroppedEmit[];
}

export interface RelayedEventObservation {
  semanticBytes?: number;
  sideEffect?: boolean;
  terminal?: boolean;
}

export interface AttemptDeliveryRecorder {
  noteAdapterEvent(): void;
  noteRelayedEvent(observation?: RelayedEventObservation): void;
  noteBufferedDelivery(body: Record<string, unknown>): void;
  /**
   * Record that a call the model emitted was deleted instead of relayed.
   *
   * Called from the bridge's drop sites rather than from the guard, because only the bridge knows
   * which disposition actually fired: a guard verdict of "drop" becomes a 502 on an enforcing wire
   * and a silent removal on a deferred one, and the two must not be reported as the same event.
   */
  noteDroppedEmit(info: { emitted: string; effective: string; decision: DroppedEmitDecision }): void;
}

export function createAttemptDeliverySummary(): AttemptDeliverySummary {
  return { adapterEvents: 0, relayedEvents: 0, semanticBytes: 0, sideEffectEvents: 0, terminalEvents: 0 };
}

/**
 * Saturating addition.
 *
 * A counter that wraps or drifts into a non-integer is worse than one that stops: the row would
 * be dropped by the normalizer and the whole summary lost. A long-lived stream that somehow
 * reaches the safe-integer ceiling keeps a readable, if pinned, number.
 */
function bump(current: number, by: number): number {
  if (!Number.isFinite(by) || by <= 0) return current;
  return Math.min(Number.MAX_SAFE_INTEGER, current + Math.floor(by));
}

const SEMANTIC_DELTA_EVENTS: ReadonlySet<string> = new Set([
  "response.output_text.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
]);

const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

const SIDE_EFFECT_ITEM_TYPES: ReadonlySet<string> = new Set([
  "function_call",
  "custom_tool_call",
  "web_search_call",
]);

/**
 * What one relayed frame contributes, read from its type name alone.
 *
 * A side effect is counted when the item STARTS, not on its argument fragments and not again on
 * the matching done frame, so one tool call is one effect however many deltas carried its
 * arguments.
 */
export function classifyRelayedResponseEvent(
  name: string,
  data: Record<string, unknown>,
): RelayedEventObservation {
  const observation: RelayedEventObservation = {};
  if (SEMANTIC_DELTA_EVENTS.has(name) && typeof data.delta === "string") {
    observation.semanticBytes = Buffer.byteLength(data.delta, "utf8");
  }
  if (name === "response.output_item.added") {
    const item = data.item;
    const type = item !== null && typeof item === "object"
      ? (item as Record<string, unknown>).type
      : undefined;
    if (typeof type === "string" && SIDE_EFFECT_ITEM_TYPES.has(type)) observation.sideEffect = true;
  }
  if (TERMINAL_EVENTS.has(name)) observation.terminal = true;
  return observation;
}

/**
 * What one buffered response body delivered.
 *
 * A non-streaming turn has no frames: the whole answer reaches the client as one JSON body. Read
 * naively that looks like total relay loss -- adapter events counted, nothing relayed -- which is
 * precisely the signal these counters exist to raise, so a buffered response would raise it on
 * every request and make it worthless. Everything the adapter produced DID reach the client here;
 * it arrived in one piece. So the relayed total is set to the adapter total rather than left at
 * zero, and the semantic facts are read from the body that was built.
 *
 * Fields are read defensively and by name. Keying this on the adapter event union would make a
 * member added later a merge-time exhaustiveness failure in a counter that does not need one.
 */
function observeBufferedBody(body: Record<string, unknown>): { semanticBytes: number; sideEffects: number } {
  const output = Array.isArray(body.output) ? body.output : [];
  let semanticBytes = 0;
  let sideEffects = 0;
  for (const entry of output) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.type === "string" && SIDE_EFFECT_ITEM_TYPES.has(item.type)) sideEffects += 1;
    if (typeof item.arguments === "string") semanticBytes += Buffer.byteLength(item.arguments, "utf8");
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") semanticBytes += Buffer.byteLength(text, "utf8");
    }
  }
  return { semanticBytes, sideEffects };
}

const recordersByScope = new WeakMap<object, AttemptDeliveryRecorder>();

/**
 * Bind a recorder to a request-scoped object.
 *
 * The scope is the request's translator budget, which every bridge on the delivery path already
 * receives. Reusing it avoids threading a new parameter through six call sites where any one of
 * them silently defaulting would leave a transport uncounted -- the failure mode that made
 * `locallyAnswered` travel on the attempt instead of as an argument.
 */
const DROPPED_EMIT_DECISIONS: ReadonlySet<DroppedEmitDecision> = new Set(DROPPED_EMIT_DECISION_ROSTER);

export function bindAttemptDeliveryRecorder(
  scope: object,
  currentAttempt: () => AttemptDeliveryTarget | undefined,
): AttemptDeliveryRecorder {
  const attemptFor = (): AttemptDeliveryTarget | undefined => currentAttempt();
  const summaryFor = (): AttemptDeliverySummary | undefined => {
    const attempt = currentAttempt();
    if (!attempt) return undefined;
    return attempt.deliverySummary ??= createAttemptDeliverySummary();
  };
  const recorder: AttemptDeliveryRecorder = {
    noteAdapterEvent(): void {
      const summary = summaryFor();
      if (summary) summary.adapterEvents = bump(summary.adapterEvents, 1);
    },
    noteDroppedEmit(info): void {
      // Its own target lookup rather than summaryFor(): a dropped call is a fact about the
      // attempt, and must not conjure an all-zero delivery summary on an attempt whose transport
      // never relayed a frame. The row's shape is decided by the durable normalizer, which
      // whitelists the decision and caps the name; nothing unvalidated is ever persisted.
      const attempt = attemptFor();
      if (!attempt || !DROPPED_EMIT_DECISIONS.has(info.decision)) return;
      const rows = attempt.droppedEmits ??= [];
      const existing = rows.find(row => row.name === info.emitted
        && row.effective === info.effective
        && row.decision === info.decision);
      if (existing) {
        existing.count = bump(existing.count, 1);
        return;
      }
      // Bounded: a model in a loop can emit thousands of distinct bad names, and the row would
      // otherwise grow with them. The first MAX_DROPPED_EMIT_ROWS are the diagnostic sample.
      if (rows.length >= MAX_DROPPED_EMIT_ROWS) return;
      rows.push({ name: info.emitted, effective: info.effective, decision: info.decision, count: 1 });
    },
    noteRelayedEvent(observation): void {
      const summary = summaryFor();
      if (!summary) return;
      summary.relayedEvents = bump(summary.relayedEvents, 1);
      if (observation?.semanticBytes) summary.semanticBytes = bump(summary.semanticBytes, observation.semanticBytes);
      if (observation?.sideEffect) summary.sideEffectEvents = bump(summary.sideEffectEvents, 1);
      if (observation?.terminal) summary.terminalEvents = bump(summary.terminalEvents, 1);
    },
    noteBufferedDelivery(body): void {
      const summary = summaryFor();
      if (!summary) return;
      const observed = observeBufferedBody(body);
      summary.relayedEvents = Math.max(summary.relayedEvents, summary.adapterEvents);
      summary.semanticBytes = bump(summary.semanticBytes, observed.semanticBytes);
      summary.sideEffectEvents = bump(summary.sideEffectEvents, observed.sideEffects);
      summary.terminalEvents = bump(summary.terminalEvents, 1);
    },
  };
  recordersByScope.set(scope, recorder);
  return recorder;
}

export function attemptDeliveryRecorder(scope: object | undefined): AttemptDeliveryRecorder | undefined {
  return scope ? recordersByScope.get(scope) : undefined;
}

/**
 * A persisted summary is trusted only when all five counts are non-negative safe integers.
 *
 * The whole record is dropped rather than repaired: a partially trusted count is a number an
 * operator would compare against another number, and half a summary is how a loss signal turns
 * into a false one.
 */
export function normalizeAttemptDeliverySummary(value: unknown): AttemptDeliverySummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const counts = createAttemptDeliverySummary();
  for (const key of Object.keys(counts) as Array<keyof AttemptDeliverySummary>) {
    const count = raw[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
    counts[key] = count;
  }
  return counts;
}

/** A detached copy, so a snapshotted attempt cannot keep counting after it was finalized. */
export function cloneAttemptDeliverySummary(
  summary: AttemptDeliverySummary | undefined,
): AttemptDeliverySummary | undefined {
  return summary ? { ...summary } : undefined;
}

/** Longest persisted dropped-call name; longer ones are refused rather than truncated. */
const DROPPED_EMIT_NAME_MAX = 96;

/**
 * A persisted dropped-call list is trusted only when EVERY row is well formed.
 *
 * The whole list is dropped rather than repaired, exactly like the delivery counters beside it:
 * a partially trusted list is a claim about what the proxy removed, and an operator reading a
 * truncated one cannot tell "the model emitted two bad calls" from "half the record was corrupt".
 *
 * Names arrive already sanitised and credential-redacted from the bridge. The length ceiling here
 * is defence against a hand-edited or newer-format row, not a substitute for that pass.
 */
export function normalizeAttemptDroppedEmits(value: unknown): AttemptDroppedEmit[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const rows: AttemptDroppedEmit[] = [];
  for (const entry of value.slice(0, MAX_DROPPED_EMIT_ROWS)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== "string" || !row.name || row.name.length > DROPPED_EMIT_NAME_MAX) return undefined;
    if (typeof row.effective !== "string" || !row.effective
      || row.effective.length > DROPPED_EMIT_NAME_MAX) return undefined;
    if (typeof row.decision !== "string"
      || !DROPPED_EMIT_DECISIONS.has(row.decision as DroppedEmitDecision)) return undefined;
    if (typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 1) return undefined;
    rows.push({
      name: row.name,
      effective: row.effective,
      decision: row.decision as DroppedEmitDecision,
      count: row.count,
    });
  }
  return rows.length > 0 ? rows : undefined;
}
