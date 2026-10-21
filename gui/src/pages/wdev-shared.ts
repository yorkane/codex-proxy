/**
 * Wdev page model + submit-body builder, kept out of the component file so the
 * wire contract is testable without React and the component module exports only
 * components.
 */

export type WdevComponentStatus = "ok" | "degraded" | "down" | "unknown";
export type WdevAction = "restart" | "upgrade" | "configure";

export interface WdevComponent {
  id: string;
  unit: string;
  url: string;
  status: WdevComponentStatus;
  releaseId: string;
  revision?: string;
}

export interface WdevManifest {
  name: string;
  path: string;
  version: string;
  sizeBytes?: number;
}

export interface WdevInventory {
  enabled: boolean;
  brand: string;
  components: WdevComponent[];
  manifests: WdevManifest[];
}

export interface WdevOperationRow {
  operationId: string;
  componentId: string;
  action: string;
  state: string;
  submittedAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface WdevOperationDetail {
  operationId: string;
  componentId: string;
  action: string;
  state: string;
  expectedRevision?: string;
  newRevision?: string;
  updatedAt?: number;
  submittedAt?: number;
  error?: string;
}

/** Draft of the submit dialog; the idempotency key is minted once when it opens. */
export interface WdevDraft {
  componentId: string;
  action: WdevAction;
  idempotencyKey: string;
  manifestPath: string;
  configPatchText: string;
  expectedRevision: string;
  maxWaitText: string;
}

/** The ledger is polled every 2s; after 3 minutes of no progress the row goes stale. */
export const WDEV_POLL_MS = 2_000;
export const WDEV_POLL_DEADLINE_MS = 180_000;
/** The manager CLI bounds its own wait at 10 minutes; the form cannot exceed it. */
export const WDEV_MAX_WAIT_CEILING = 600;

/**
 * The manager ledger's phase machine (wdev_manager/store.py PHASES), kept here as a
 * display whitelist. TERMINAL is a CLOSED set: a phase is terminal only if the ledger
 * says so, never by "not in a running whitelist" - the ledger advances through
 * preflight/wait_idle/stage/quiesce/snapshot/candidate_start/verify/commit, and an
 * allowlist over those is what previously rendered mid-flight rows as "cancelled" and
 * stopped their polls. An unknown phase (a future manager build) is NOT terminal:
 * it keeps polling, shows its raw name, and goes stale on budget like anything live.
 */
const WDEV_TERMINAL_PHASES: readonly string[] = ["succeeded", "rolled_back", "failed", "protected", "cancelled"];
const WDEV_PROGRESS_PHASES: readonly string[] = [
  "queued", "preflight", "wait_idle", "stage", "quiesce", "snapshot",
  "candidate_start", "verify", "commit", "running",
];

export function isTerminalState(state: string): boolean {
  return WDEV_TERMINAL_PHASES.includes(state);
}

/** True for a phase the manager ledger uses mid-flight (the progress whitelist). */
export function isKnownProgressPhase(state: string): boolean {
  return WDEV_PROGRESS_PHASES.includes(state);
}

export type WdevStatusKey =
  | "wdev.status.ok" | "wdev.status.degraded" | "wdev.status.down" | "wdev.status.unknown";

export function statusLabelKey(status: string): WdevStatusKey {
  if (status === "ok") return "wdev.status.ok";
  if (status === "degraded") return "wdev.status.degraded";
  if (status === "down") return "wdev.status.down";
  return "wdev.status.unknown";
}

export type WdevStateKey =
  | "wdev.state.queued" | "wdev.state.running" | "wdev.state.succeeded"
  | "wdev.state.failed" | "wdev.state.cancelled" | "wdev.state.rolledBack"
  | "wdev.state.protected";

/**
 * Label for a ledger state. Every manager phase maps: the progress phases share the
 * "Running" label (their raw name renders beside it), the terminal phases each get an
 * honest label - rolled_back says the old version is back, protected says the data is
 * frozen for inspection (NOT "restored"), cancelled stays muted.
 */
export function stateLabelKey(state: string): WdevStateKey {
  switch (state) {
    case "queued": return "wdev.state.queued";
    case "succeeded": return "wdev.state.succeeded";
    case "failed": return "wdev.state.failed";
    case "cancelled": return "wdev.state.cancelled";
    case "rolled_back": return "wdev.state.rolledBack";
    case "protected": return "wdev.state.protected";
    default: return "wdev.state.running";
  }
}

/**
 * The raw phase text an operator reads beside the shared "Running" label. A safe
 * subset of the ledger's own alphabet only: letters, digits, underscore, dash, 32
 * chars - anything else renders empty. This is display copy from a trusted local
 * manager, but the filter keeps a hostile spoof from injecting prose.
 */
const SAFE_RAW_PHASE = /^[a-z0-9_-]{1,32}$/;

export function rawProgressLabel(state: string): string {
  return SAFE_RAW_PHASE.test(state) ? state : "";
}

export type WdevActionKey =
  | "wdev.action.restart" | "wdev.action.upgrade" | "wdev.action.configure";

export function actionLabelKey(action: string): WdevActionKey {
  if (action === "restart") return "wdev.action.restart";
  if (action === "upgrade") return "wdev.action.upgrade";
  return "wdev.action.configure";
}

export function statusBadgeClass(status: string): string {
  if (status === "ok") return "badge badge-green";
  if (status === "degraded") return "badge badge-amber";
  if (status === "down") return "badge wdev-badge-red";
  return "badge badge-muted";
}

export function statusDotClass(status: string): string {
  if (status === "ok") return "dot dot-green";
  if (status === "degraded") return "dot dot-amber";
  if (status === "down") return "dot dot-red";
  return "dot dot-muted";
}

export function stateBadgeClass(state: string): string {
  if (state === "succeeded") return "badge badge-green";
  if (isTerminalState(state)) {
    if (state === "failed") return "badge wdev-badge-red";
    return "badge badge-amber";
  }
  return "badge badge-accent";
}

/** Validate the dialog draft; returns a message key when it must not be submitted. */
export function draftValidationKey(draft: WdevDraft): "wdev.invalidJson" | null {
  if (draft.action !== "configure") return null;
  try {
    const parsed: unknown = JSON.parse(draft.configPatchText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "wdev.invalidJson";
  } catch {
    return "wdev.invalidJson";
  }
  return null;
}

/**
 * The POST body, restricted to the whitelist the operations route accepts.
 * `restart` carries no expectedRevision by contract; `maxWait` is clamped to
 * the manager's own ceiling so a submitted number can never be rejected for
 * range after the dialog validated it.
 */
export function buildOperationBody(draft: WdevDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    componentId: draft.componentId,
    action: draft.action,
    idempotencyKey: draft.idempotencyKey,
  };
  if (draft.action === "upgrade") {
    body.manifestPath = draft.manifestPath;
    if (draft.expectedRevision) body.expectedRevision = draft.expectedRevision;
  }
  if (draft.action === "configure") {
    body.configPatch = JSON.parse(draft.configPatchText);
    if (draft.expectedRevision) body.expectedRevision = draft.expectedRevision;
  }
  const maxWait = Number(draft.maxWaitText);
  if (draft.maxWaitText.trim() !== "" && Number.isFinite(maxWait) && maxWait > 0) {
    body.maxWait = Math.min(WDEV_MAX_WAIT_CEILING, Math.floor(maxWait));
  }

  return body;
}
