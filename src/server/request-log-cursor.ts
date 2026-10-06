import { createHash, randomBytes } from "node:crypto";

const MAX_CURSOR_LENGTH = 512;
const MAX_WINDOW_ROWS = 2000;
// A restart must invalidate even an identical window hydrated from usage.jsonl.
const processEpoch = randomBytes(16).toString("hex");

/** The live process identity baked into every v3 cursor; exported so the route can pass it
 * through the positional epoch parameter while also passing append keys. */
export function requestLogProcessEpoch(): string {
  return processEpoch;
}

/**
 * Append-order position per row object, assigned on first sight. The request log ring only
 * ever appends terminal rows (addFinalRequestLog is the single production writer), so
 * first-sight order equals ring order and a tail-slice window is an ascending sequence of
 * these keys. The /api/logs route passes ring positions through explicitly (appendKeys),
 * read from the query rows the projection was derived from.
 * Clients carry the high-water key plus the row count they hold: appends advance the
 * high-water mark, ring evictions only move the low end. That positional information
 * survives the shift a tail slice takes on every append -- hashing window slice CONTENTS
 * does not, and that was the storm: every append shifted the window by one slot, mismatched
 * the prefix digest, and reset every client to a full multi-megabyte re-send (the /api/logs
 * hot path).
 *
 * Keys pack the sequence in the high bits and an occurrence counter in the low bits, so one
 * Number comparison orders (position, occurrence): a row repeated inside the same window --
 * identical duplicates, not amended rows -- gets distinct keys while its first occurrence
 * keeps a stable one. A duplicate whose earlier twin was evicted renumbers and fails the
 * fold: the safe direction (reset, never a wrong delta).
 */
const OCC_SHIFT = 20;
const OCC_MULT = 1 << OCC_SHIFT;
const OCC_MAX = OCC_MULT - 1;
const seqByObject = new WeakMap<object, number>();
let seqCounter = 0;

/**
 * Append-order position per ring row, assigned on first sight. Stamping is NON-enumerable
 * and hidden behind a module-private symbol: it survives neither JSON.stringify nor
 * Object.keys nor deep-equality checks, so projections, the wire, and every consumer's
 * structuredClone stay byte-identical to before this feature existed. The WeakMap is the
 * authority; the stamp exists so the position survives the requestLogDto spread -- Object
 * spread copies enumerable OWN properties only, so it does NOT copy the stamp, which is
 * exactly right: the route reads positions from the RING rows (below) and passes them to
 * selectRequestLogPoll explicitly, keyed by window index, because the DTO objects are
 * rebuilt on every poll and a WeakMap over them could never stay stable.
 */
const SEQ_HIDDEN = Symbol("opencodex.requestLogSeq");
function seqOf(row: object): number {
  const known = seqByObject.get(row);
  if (known !== undefined) return known;
  const seq = ++seqCounter;
  seqByObject.set(row, seq);
  try {
    Object.defineProperty(row, SEQ_HIDDEN, { value: seq, enumerable: false, configurable: false, writable: false });
  } catch {
    // Non-extensible rows keep only the WeakMap binding; the ring never freezes rows.
  }
  return seq;
}

/** Ring ingress stamping (request-log.ts calls this for every appended row). */
export function assignRequestLogSeq(row: object): number {
  return seqOf(row);
}

/**
 * Positions of the ring rows a projected window was derived from, or null when any row is
 * foreign (not in the ring's stamp map under its own identity -- hydrated clones, fixtures).
 * A null return makes the caller fall back to first-sight positions, which are monotonic but
 * not ring-authoritative; the cursor's fold and anchor checks then simply fail for foreign
 * windows and reset, the safe direction.
 */
export function requestLogWindowSeqs(rows: readonly object[]): number[] | null {
  const out: number[] = new Array(rows.length);
  for (let index = 0; index < rows.length; index++) {
    const known = seqByObject.get(rows[index]);
    if (known === undefined) return null;
    out[index] = known;
  }
  return out;
}

function windowKeys(rows: readonly object[], appendKeys?: readonly number[]): number[] | null {
  const occurrences = new Map<object, number>();
  const keys = new Array<number>(rows.length);
  let previous = -1;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const count = (occurrences.get(row) ?? 0) + 1;
    occurrences.set(row, count);
    if (count > OCC_MAX) return null;
    const seq = appendKeys !== undefined ? appendKeys[index] : seqOf(row);
    if (!Number.isSafeInteger(seq) || seq <= 0) return null;
    const key = seq * OCC_MULT + count;
    if (key <= previous) return null;
    keys[index] = key;
    previous = key;
  }
  return keys;
}

/** Upper bound on one poll delta of new rows; a bigger divergence resets instead. */
const MAX_POLL_APPENDS = 256;
/** 16 hex chars for a 64-bit fold; the empty-window fold is sixteen zeros. */
const FOLD_DIGITS = 16;
const EMPTY_FOLD = "0".repeat(FOLD_DIGITS);
const MOD_64 = (1n << 64n) - 1n;

interface SnapshotCursor {
  v: 3;
  e: string;
  n: number;
  q: string;
  t: number;
  f: string;
  ta: string;
}

interface LegacyCursor {
  v: 1;
  t: number;
  id: string;
}

interface V2Cursor {
  v: 2;
  e: string;
  n: number;
  q: string;
  h: string;
}

export type RequestLogCursor = SnapshotCursor | V2Cursor | LegacyCursor;

/** A cursor is a bounded freshness hint, never an admission credential. */
export function decodeRequestLogCursor(raw: string): RequestLogCursor | null {
  if (!raw || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row).sort().join(",");
    if (row.v === 1 && keys === "id,t,v"
      && typeof row.t === "number" && Number.isFinite(row.t) && row.t >= 0
      && typeof row.id === "string" && row.id.length > 0 && row.id.length <= 256) {
      return { v: 1, t: row.t, id: row.id };
    }
    if (row.v === 2 && keys === "e,h,n,q,v"
      && typeof row.e === "string" && /^[a-f0-9]{32}$/.test(row.e)
      && typeof row.n === "number" && Number.isSafeInteger(row.n) && row.n >= 0 && row.n <= MAX_WINDOW_ROWS
      && typeof row.q === "string" && /^[a-f0-9]{64}$/.test(row.q)
      && typeof row.h === "string" && /^[a-f0-9]{64}$/.test(row.h)) {
      return { v: 2, e: row.e, n: row.n, q: row.q, h: row.h };
    }
    if (row.v === 3 && keys === "e,f,n,q,t,ta,v"
      && typeof row.e === "string" && /^[a-f0-9]{32}$/.test(row.e)
      && typeof row.n === "number" && Number.isSafeInteger(row.n) && row.n >= 0 && row.n <= MAX_WINDOW_ROWS
      && typeof row.q === "string" && /^[a-f0-9]{64}$/.test(row.q)
      && typeof row.t === "number" && Number.isSafeInteger(row.t) && row.t >= 0
      && typeof row.f === "string" && /^[a-f0-9]{16}$/.test(row.f)
      && typeof row.ta === "string" && /^[a-f0-9]{16}$/.test(row.ta)) {
      return { v: 3, e: row.e, n: row.n, q: row.q, t: row.t, f: row.f, ta: row.ta };
    }
    return null;
  } catch {
    return null;
  }
}

const contentHashes = new WeakMap<object, bigint>();

function contentHash(row: object): bigint {
  const known = contentHashes.get(row);
  if (known !== undefined) return known;
  const digest = createHash("sha256").update(JSON.stringify(row)).digest().readBigUInt64BE(0);
  contentHashes.set(row, digest);
  return digest;
}

/**
 * SUM fold (not xor: identical duplicates must not cancel to zero) over the client-held
 * visible occurrences, keyed by (row content, occurrence key) so an amended or renumbered
 * occurrence cannot impersonate another. Rows count EVERYTHING the projection carries --
 * display-time economics included, honoring the /api/logs contract that a cost or decode-rate
 * change resets even when raw entries are untouched. Appends never touch already-held rows,
 * so the fold over the shared prefix is stable across ring shifts. This is a freshness hint,
 * never an admission credential: a (2^-64) collision costs one stale window until the next
 * real change; the delivered-row guarantees come from key contiguity and the anchor checks.
 */
function foldOccurrences(rows: readonly object[], keys: readonly number[], lo: number, hi: number): string {
  let sum = 0n;
  for (let index = lo; index <= hi; index++) {
    sum = (sum + contentHash(rows[index]) + BigInt(keys[index])) & MOD_64;
  }
  return sum.toString(16).padStart(FOLD_DIGITS, "0");
}

function countTrailingBeyond(keys: readonly number[], t: number): number {
  let count = 0;
  for (let index = keys.length - 1; index >= 0 && keys[index] > t; index--) count++;
  return count;
}

function encodeCursor(value: SnapshotCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Compare the projected window by append-order occurrence keys and full-content folds, not by
 * window slice contents. The window is a tail slice of an append-only ring, so appends and
 * evictions shift every row by one slot; slice-content hashing (v2) read that positional shift
 * as changed content and reset every client -- the /api/logs full-resend storm this function
 * exists to end.
 *
 * Incremental delivery stays correct: a poll may omit only rows the client already holds,
 * and the key contract proves the delivered suffix covers every append since the client view:
 *   - identical full digest (same epoch and query) ships an empty delta;
 *   - ascending occurrence keys, the high-water anchor at the claimed position, and a
 *     re-verified held-range fold prove nothing the client holds changed underneath it
 *     (display-time economics included);
 *   - eviction-with-append is only folded at the ring capacity (n === m === MAX_WINDOW_ROWS,
 *     appends === evictions), because that is the sole geometry where every known client
 *     (GUI limit=2000, CLI follow --limit cap 2000) merges the delta under the same cap and
 *     thereby trims exactly the evicted head itself -- the client's newest-row anchor ties
 *     the claim to this window. Any other geometry resets, because clients cannot express
 *     removals.
 * Filter changes reset via the query digest; restarts reset via the epoch. No per-client rows
 * or history are retained server-side; the route calls this synchronously after projecting the
 * full filtered/paginated window.
 */
export function selectRequestLogPoll<T extends object>(
  rows: readonly T[],
  params: URLSearchParams,
  cursor: RequestLogCursor | null,
  epoch = processEpoch,
  appendKeys?: readonly number[],
): { logs: T[]; cursor: string; reset: boolean } {
  const query = new URLSearchParams(params);
  query.delete("cursor");
  query.sort();
  const queryDigest = createHash("sha256").update(query.toString()).digest("hex");
  const m = rows.length;
  const keys = windowKeys(rows, appendKeys !== undefined && appendKeys.length === m ? appendKeys : undefined);
  const candidate = keys !== null && cursor?.v === 3 && cursor.e === epoch
    && cursor.q === queryDigest && cursor.n <= MAX_WINDOW_ROWS ? cursor : null;
  const next: SnapshotCursor = {
    v: 3,
    e: epoch,
    n: m,
    q: queryDigest,
    t: m > 0 && keys !== null ? keys[m - 1] : (m === 0 ? (candidate?.t ?? 0) : 0),
    f: m > 0 && keys !== null ? foldOccurrences(rows, keys, 0, m - 1) : EMPTY_FOLD,
    ta: m > 0 && keys !== null ? foldOccurrences(rows, keys, m - 1, m - 1) : EMPTY_FOLD,
  };
  const wire = encodeCursor(next);
  if (candidate !== null && keys !== null) {
    const { n, t } = candidate;
    if (m === 0) {
      // A client holding nothing agrees with an empty window; holding anything must resync.
      if (n === 0) return { logs: [], cursor: wire, reset: false };
    }
    const appends = countTrailingBeyond(keys, t);
    const evictions = n + appends - m;
    const heldHi = m - appends - 1; // window index of the client high-water row
    if (n === 0) {
      // The client holds no rows, so the full window is the delta and nothing can be lost.
      if (appends === m && m <= MAX_POLL_APPENDS) return { logs: rows.slice(0), cursor: wire, reset: false };
    } else if (appends <= MAX_POLL_APPENDS && heldHi >= 0 && keys[heldHi] === t) {
      // appends === 0 with the same geometry is the STABLE window: the fold match proves the
      // client already holds exactly this window and the delta is legitimately empty. A
      // display-time economics flip changes the row JSON, so the fold mismatches and the
      // poll resets -- honoring the contract that cost/decode-rate changes must be visible
      // even when the raw entry is untouched.
      const anchorHolds = foldOccurrences(rows, keys, heldHi, heldHi) === candidate.ta;
      if (anchorHolds && evictions === 0 && foldOccurrences(rows, keys, 0, heldHi) === candidate.f) {
        return { logs: rows.slice(heldHi + 1), cursor: wire, reset: false };
      }
      if (anchorHolds && appends > 0 && evictions === appends
        && n === MAX_WINDOW_ROWS && m === MAX_WINDOW_ROWS) {
        return { logs: rows.slice(heldHi + 1), cursor: wire, reset: false };
      }
    }
  }
  return { logs: rows.slice(0), cursor: wire, reset: cursor !== null };
}
