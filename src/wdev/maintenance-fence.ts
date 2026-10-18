/**
 * Wdev maintenance fence for the llm-proxy component (fork opt-in, env-gated).
 *
 * The supervisor runs OUTSIDE this process. Before it restarts or upgrades the proxy it
 * writes a fence file (WDEV_MAINTENANCE_FILE); while that file is live, the proxy refuses
 * NEW generation work (fresh /v1/* turns) with a retryable 503 so the operation can reach
 * a quiet window, and keeps answering everything an operator or a client in the middle of
 * a turn needs: /healthz (which acknowledges the fence), /readyz, the management API, and
 * GET /v1/models.
 *
 * Drain semantics for tool-loop continuations live in gate.ts, not here: this module
 * owns the document, the (mtime,size) freshness cache, and the admission registry. The
 * registry records the conversation lane ids of requests admitted while unfenced
 * (capped, TTL'd) so the gate can require, on a fenced request, BOTH a tool-continuation
 * body shape AND a registered lane proving the turn is in flight through this process.
 * The strict phases (quiesced/expired) admit nothing generation at all - see gate.ts.
 * Registration happens at admission, before fencing; a caller cannot claim an identity
 * it never ran a turn through.
 *
 * Freshness is per-request by design: the gate stats the file on every data-plane request
 * and re-reads only when mtime/size moved, so a fence takes effect on the next request
 * (no polling window, no leaked requests) and a removed fence releases on the next
 * request. The stat is the same cost class as the existing package-tree probe on this
 * path. When the file is unchanged the cached verdict is reused.
 *
 * Fail-closed: a present-but-malformed, partial-write, unknown-schema, oversized, or
 * lease-expired file means FENCED. A fence is released only by the supervisor removing
 * the file, never by a timeout - an operation that outlived its lease is exactly the
 * moment an unattended release would be worst.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface WdevFenceState {
  active: boolean;
  operationId: string;
  phase: "draining" | "quiesced" | "expired";
  /**
   * True when admission is hard-blocked: phase quiesced/expired (and the fail-closed
   * sentinel). The supervisor's quiesced gate means "idle confirmed, kill imminent",
   * and expired means the lease died mid-transaction with the fence retained; a
   * continuation admitted in those phases would ride into the kill. Only draining
   * admits validated in-flight continuations.
   */
  strict: boolean;
  fenceEpoch: number;
  generation: number;
  /** The raw deadline field, echoed for the supervisor's same-value ack check. */
  deadline: number;
}

const FENCE_MAX_BYTES = 4096;
const RECENT_MAX = 4096;
const RECENT_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  key: string;
  state: WdevFenceState | null;
}

/**
 * Registered continuation identities: lane ids and response ids belonging to turns this
 * process admitted while unfenced. Bounded insertion-ordered set; entries expire.
 */
const recent = new Map<string, number>();

function rememberIdentity(id: string, now: number): void {
  if (id === "") return;
  recent.set(id, now);
  if (recent.size > RECENT_MAX) {
    const oldestKey = recent.keys().next().value;
    if (oldestKey !== undefined) recent.delete(oldestKey);
  }
}

/** Admit-time hook: record the lane a continuation can present while fenced. Anchoring
 * is lane-only (see gate.ts): a continuation leg whose request carries no lane header is
 * refused during draining and retries on the 503. The responses store is not consulted
 * on the admission path, so response ids are never registry entries. */
export function wdevFenceNoteAdmitted(input: {
  laneId?: string | null;
}, now: number = Date.now()): void {
  if (input.laneId) rememberIdentity(input.laneId, now);
}

/** True when this lane id was admitted by this process inside the TTL window. The
 * drain gate pairs this with tool-continuation body evidence: a registered lane
 * proves a turn was in flight through this proxy, and the registry is
 * insertion-capped with a TTL, so a weeks-old header cannot claim in-flight status.
 */
export function wdevFenceRegisteredLane(laneId: string, now: number = Date.now()): boolean {
  const seenAt = recent.get(laneId);
  if (seenAt === undefined) return false;
  if (now - seenAt <= RECENT_TTL_MS) {
    recent.set(laneId, now);
    return true;
  }
  recent.delete(laneId);
  return false;
}

function fenceCacheKey(mtimeMs: number, size: number): string {
  return `${mtimeMs}:${size}`;
}

/**
 * Parse and lease-check one fence document. Any structural problem returns null, which
 * callers treat as fenced (fail-closed) - so this never reports "not fenced" on a file it
 * could not verify.
 */
export function parseWdevFenceDocument(text: string, now: number): WdevFenceState | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  if (doc.schemaVersion !== 1) return null;
  if (doc.component !== "llm-proxy") return null;
  if (typeof doc.operationId !== "string" || doc.operationId === "") return null;
  if (typeof doc.fenceEpoch !== "number" || !Number.isInteger(doc.fenceEpoch) || doc.fenceEpoch < 0) return null;
  // "expired" is a real supervisor phase (control.py PHASES): the lease deadline passed
  // and the fence file is deliberately RETAINED so admission stays blocked. It parses as
  // a live fence, exactly like draining/quiesced.
  if (doc.phase !== "draining" && doc.phase !== "quiesced" && doc.phase !== "expired") return null;
  if (typeof doc.generation !== "number" || !Number.isInteger(doc.generation) || doc.generation < 0) return null;
  // The supervisor contract freezes the field name as `deadline` (unix ms). An explicit
  // null is a hard parse failure; only absence takes the legacy alias.
  let deadline: unknown = doc.deadline;
  if (deadline === undefined && doc.deadlineUnixMs !== undefined) deadline = doc.deadlineUnixMs;
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) return null;
  // Lease expiry NEVER self-releases: a fence past its deadline stays fenced, and an
  // unparseable file stays fenced. The only release is the file going away.
  void deadline;
  return {
    active: true,
    operationId: doc.operationId,
    phase: doc.phase,
    strict: doc.phase !== "draining",
    fenceEpoch: doc.fenceEpoch,
    generation: doc.generation,
    deadline,
  };
}

const cache: CacheEntry = { key: "", state: null };

/**
 * Read the live fence for the current request, cheaply: stat, compare against the cached
 * (mtime,size) key, re-read the content only when it moved. A file that cannot be stat-ed
 * is "no fence"; a file that cannot be understood is "fence".
 */
export function wdevFenceRead(maintenanceFile: string, now: number = Date.now()): WdevFenceState | null {
  let stat;
  try {
    stat = statSync(maintenanceFile);
  } catch {
    cache.key = "";
    cache.state = null;
    return null;
  }
  if (!stat.isFile() || stat.size > FENCE_MAX_BYTES) return fenceFailClosed();
  const key = fenceCacheKey(stat.mtimeMs, stat.size);
  if (cache.key === key) return cache.state;
  let text: string | null = null;
  try {
    text = readFileSync(maintenanceFile, "utf8");
  } catch {
    // Vanished between stat and read, or unreadable: re-decide on the next request.
    if (!existsSync(maintenanceFile)) {
      cache.key = "";
      cache.state = null;
      return null;
    }
    return fenceFailClosed();
  }
  // Fail-closed by contract: a PRESENT file that does not parse is a live fence (the
  // sentinel), never a release. Only the file going away releases. A torn mid-write
  // read is re-decided on the next request (the (mtime,size) key does not cache the
  // sentinel), so a supervisor writing atomically (tmp+rename, as control.py does)
  // converges to the parse verdict within one request.
  const state = parseWdevFenceDocument(text, now);
  if (state === null) return fenceFailClosed();
  cache.key = key;
  cache.state = state;
  return state;
}

function fenceFailClosed(): WdevFenceState {
  // The supervisor gate needs *a* fenced verdict; it must never learn to trust the
  // unparsable-file path, so the sentinel values say so loudly.
  return {
    active: true,
    operationId: "fence-unreadable",
    phase: "draining",
    strict: true,
    fenceEpoch: -1,
    generation: -1,
    deadline: 0,
  };
}

/** Test seam: drop the (mtime,size) cache between requests. */
export function wdevFenceResetCacheForTests(): void {
  cache.key = "";
  cache.state = null;
}

/** Test seam: the continuation registry, for drain-behaviour tests. */
export function wdevFenceClearIdentitiesForTests(): void {
  recent.clear();
}

/** Health projection: {active, operationId, phase, fenceEpoch, ack} - ack is always true
 * (this process observed the file on this very request). */
export function wdevFenceHealthField(state: WdevFenceState | null): Record<string, unknown> | null {
  if (!state) return null;
  return {
    active: state.active === true,
    operationId: state.operationId,
    phase: state.phase,
    strict: state.strict === true || state.phase === "quiesced" || state.phase === "expired",
    fenceEpoch: state.fenceEpoch,
    ack: true,
  };
}
