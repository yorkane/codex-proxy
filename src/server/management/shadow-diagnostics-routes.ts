/**
 * Shadow diagnostics feed (fork addition).
 *
 * Every disposition that removes or rewrites a tool call, plus the empty-completion replay,
 * already lands on the durable request log. None of it was reachable from the dashboard, so a
 * session that stopped for no visible reason could not be told apart from one where the model
 * simply never made the call. This projects the in-memory ring buffer into a small event list the
 * Shadow page can render: the full /api/logs payload is far too large to pull and filter in the
 * browser, and these events are rare by construction.
 *
 * Fork-owned so upstream merges never touch this block.
 */
import type { DroppedEmitDecision } from "../../usage/telemetry-contract";
import { jsonResponse } from "../auth-cors";
import { getRequestLogEntries, type RequestLogEntry } from "../request-log";
import type { ManagementContext } from "./context";

export type ShadowDiagnosticKind =
  | "phantom-drop"
  | "namespace-container"
  | "directive-feedback"
  | "empty-completion"
  | "undeclared-tool-rejected";

export interface ShadowDiagnosticEvent {
  ts: number;
  kind: ShadowDiagnosticKind;
  requestId: string;
  model: string;
  provider: string;
  status: number;
  /** One sentence naming what happened, safe to show verbatim. */
  detail: string;
  /** The emitted tool names involved, when the disposition had any. */
  names: string[];
  count: number;
}

// Keyed by the roster type, not by `string`: adding a member to
// DROPPED_EMIT_DECISION_ROSTER without giving it a display kind is then a COMPILE error, so the
// feed can never silently stop describing a disposition the durable row already records.
const DECISION_KINDS: Readonly<Record<DroppedEmitDecision, ShadowDiagnosticKind>> = {
  "phantom": "phantom-drop",
  "namespace-container": "namespace-container",
  "directive-feedback": "directive-feedback",
};

const DETAIL: Readonly<Record<ShadowDiagnosticKind, string>> = {
  "phantom-drop": "Model emitted a hallucinated tool name; removed from the relay.",
  "namespace-container": "Model emitted a tool namespace as a tool; removed from the relay.",
  "directive-feedback": "Undeclared tool call replaced with a directive correction; the model was taught the right spelling.",
  "empty-completion": "Upstream finished with no content; the turn was replayed before the client saw it.",
  "undeclared-tool-rejected": "Undeclared tool call failed closed (matched on the upstream error text; there is no dedicated telemetry field for it).",
};

const UNDECLARED_TOOL_TEXT = "emitted undeclared client tool";
const EMPTY_COMPLETION_TEXT = "empty_completion_retry_failed";

interface AttemptLike {
  status?: number;
  recoveryKinds?: readonly string[];
  droppedEmits?: readonly { name?: string; decision?: string; count?: number }[];
  upstreamError?: string;
}

function attemptsOf(entry: RequestLogEntry): AttemptLike[] {
  return (entry.attempts ?? []) as unknown as AttemptLike[];
}

function pushEvent(
  out: ShadowDiagnosticEvent[],
  kind: ShadowDiagnosticKind,
  entry: RequestLogEntry,
  names: string[],
  count: number,
): void {
  out.push({
    ts: entry.timestamp,
    kind,
    requestId: entry.requestId,
    model: entry.model,
    provider: entry.provider,
    status: entry.status,
    detail: DETAIL[kind],
    names,
    count,
  });
}

function eventsForEntry(entry: RequestLogEntry): ShadowDiagnosticEvent[] {
  const out: ShadowDiagnosticEvent[] = [];
  // One event per (kind, name) row rather than per attempt: a looped model repeats the same bad
  // name, and the row already carries the count that matters.
  const seen = new Set<string>();
  for (const attempt of attemptsOf(entry)) {
    for (const row of attempt.droppedEmits ?? []) {
      const kind = DECISION_KINDS[row.decision as DroppedEmitDecision];
      const name = row.name ?? "(unnamed)";
      if (kind === undefined) continue;
      const key = `${kind}\u0000${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pushEvent(out, kind, entry, [name], row.count ?? 1);
    }
    if ((attempt.recoveryKinds ?? []).includes("empty-completion")) {
      pushEvent(out, "empty-completion", entry, [], 1);
    }
  }
  const terminalText = `${entry.terminalStatus ?? ""} ${entry.upstreamError ?? ""}`;
  if (terminalText.includes(EMPTY_COMPLETION_TEXT)) {
    pushEvent(out, "empty-completion", entry, [], 1);
  }
  if (entry.status === 502 && (entry.upstreamError ?? "").includes(UNDECLARED_TOOL_TEXT)) {
    const name = /emitted undeclared client tool "([^"]+)"/.exec(entry.upstreamError ?? "")?.[1];
    pushEvent(out, "undeclared-tool-rejected", entry, name ? [name] : [], 1);
  }
  return out;
}

const KINDS: ShadowDiagnosticKind[] = [
  ...Object.values(DECISION_KINDS),
  "empty-completion",
  "undeclared-tool-rejected",
];

function parseLimit(raw: string | null): number {
  const n = raw === null ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function parseKinds(raw: string | null): Set<ShadowDiagnosticKind> {
  if (raw === null || raw.trim() === "") return new Set(KINDS);
  const wanted = raw.split(",").map((v) => v.trim()).filter((v) => (KINDS as string[]).includes(v));
  return wanted.length === 0 ? new Set(KINDS) : new Set(wanted as ShadowDiagnosticKind[]);
}

export function collectShadowDiagnosticEvents(entries: readonly RequestLogEntry[]): ShadowDiagnosticEvent[] {
  const events: ShadowDiagnosticEvent[] = [];
  for (const entry of entries) events.push(...eventsForEntry(entry));
  return events.sort((a, b) => b.ts - a.ts);
}

export async function handleShadowDiagnosticsRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname !== "/api/shadow-diagnostics" || req.method !== "GET") return null;

  const limit = parseLimit(url.searchParams.get("limit"));
  const wanted = parseKinds(url.searchParams.get("kind"));
  const all = collectShadowDiagnosticEvents(getRequestLogEntries()).filter((e) => wanted.has(e.kind));
  return jsonResponse({
    generatedAt: Date.now(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    kinds: KINDS,
    total: all.length,
    events: all.slice(0, limit),
  });
}
