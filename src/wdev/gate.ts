/**
 * Wdev maintenance fence gate for the request path (fork opt-in, env-gated).
 *
 * The supervisor that restarts/upgrades the proxy fences it by writing
 * WDEV_MAINTENANCE_FILE (see maintenance-fence.ts for the document contract). This
 * module is the seam the data-plane entry calls on every request:
 *
 * - fence absent: record the conversation lane ids of admitted generation turns (so a
 *   later fence can distinguish a draining tool loop from fresh work) and return null:
 *   the request proceeds exactly as before, at the cost of one stat.
 * - fence phase "draining": refuse NEW generation work with a retryable 503
 *   wdev_maintenance, and admit ONLY a minimal validated in-flight chain: a lane this
 *   process registered at admission, plus a bounded body prefix that is tool-output
 *   continuation shaped (function_call_output / tool_result / role:tool / call_response).
 *   A plain new user turn on an old lane header is refused.
 * - fence phase "quiesced" or "expired" (and the fail-closed sentinel): refuse ALL
 *   generation work, continuations included, with zero body reads. Quiesced means the
 *   supervisor's idle gate passed and the kill is imminent; expired means the lease died
 *   mid-transaction with the fence retained. Admitting anything there rides into the kill.
 *
 * Everything that is not generation stays answerable while fenced: GET /v1/models,
 * /healthz, /readyz, /api/*, count_tokens.
 *
 * Env-gated: with WDEV_MAINTENANCE_FILE unset the gate short-circuits on a property
 * read and loads nothing beyond this check. A static import of this module is therefore
 * safe on the core path: it spawns nothing, arms no timer, imports no manager code, and
 * reaches no other core subsystem.
 */
import { sessionLaneIdFromRequest } from "../server/request-log-conversation";
import {
  wdevFenceNoteAdmitted,
  wdevFenceRead,
  wdevFenceRegisteredLane,
  wdevFenceHealthField,
} from "./maintenance-fence";
import { WDEV_MANAGER_ENV } from "./activation";

/** Generation endpoints that carry new paid turns (POST). Refused while fenced.
 * count_tokens is absent: it spends no provider quota (same argument as its loopback
 * allowlist entry), and a client mid-turn needs it to finish encoding the drain.
 */
const GENERATION_POST_PATHS = new Set([
  "/v1/responses",
  "/v1/responses/compact",
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/alpha/search",
  "/v1/audio/transcriptions",
  "/v1/images/generations",
  "/v1/images/edits",
]);

/** WebSocket surfaces that open a new realtime/turn session. Refused while fenced:
 * a WS upgrade is a fresh stream, not the continuation of a fenced HTTP turn.
 * /v1/audio/transcriptions/stream is the dictation WebSocket (serve-options serves it
 * as a socket upgrade, index.ts routes it on Upgrade: websocket) - a live mic stream
 * is generation work, not a continuation.
 */
function isGenerationUpgrade(pathname: string): boolean {
  return pathname === "/v1/responses"
    || pathname === "/v1/live"
    || pathname === "/v1/realtime"
    || pathname.startsWith("/v1/realtime/calls")
    || pathname === "/v1/audio/transcriptions/stream";
}

function wdevMaintenanceFilePath(): string | null {
  const raw = process.env[WDEV_MANAGER_ENV.maintenanceFile];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** True when the fence feature is wired for this deployment (env set). */
export function wdevFenceGateActive(): boolean {
  return wdevMaintenanceFilePath() !== null;
}

function maintenanceRefusal(): Response {
  // JSON + Retry-After, the same contract family as server_restarting (#6642): a 503 the
  // client can retry, and a body that never reads as model capacity.
  return new Response(JSON.stringify({
    error: {
      type: "server_error",
      code: "wdev_maintenance",
      message: "Wdev maintenance is draining this proxy; retry this request.",
    },
  }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "5" } });
}

/** Hard-bound phases: every generation surface refuses, no body is read. The
 * fail-closed sentinel carries strict:true as well. */
function fenceIsStrict(fence: { phase: string; strict?: boolean }): boolean {
  return fence.strict === true || fence.phase === "quiesced" || fence.phase === "expired";
}

/**
 * Bounded streaming prefix read for the continuation probe. Reads AT MOST
 * CONTINUATION_PEEK_MAX_BYTES across the stream and cancels the rest: a caller
 * without a Content-Length cannot make this gate buffer an unbounded body (the
 * gate runs on the admission path, before the route-level body limits).
 * complete=false means the prefix was cut off (cap hit, stream cancelled): the
 * request is refused, and its body is consumed - the only honest verdict for a
 * request the gate had to stop reading.
 */
const CONTINUATION_PEEK_MAX_BYTES = 2 * 1024 * 1024;

interface BodyPrefix {
  text: string;
  complete: boolean;
}

async function readBoundedBodyPrefix(req: Request, cap: number): Promise<BodyPrefix> {
  const body = req.body;
  if (!body) return { text: "", complete: true };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); } catch { return { text: "", complete: true }; }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (!value) continue;
      const remaining = cap - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total = cap;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return { text: "", complete: false };
  } finally {
    // On the cap-hit (refusal) path the remainder must be cancelled, not left to
    // buffer in the stream. On the complete path the stream is drained.
    if (!complete) {
      try { await reader.cancel(); } catch { /* already cancelled */ }
    }
    try { reader.releaseLock(); } catch { /* lock already released by cancel */ }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), complete };
}

/**
 * Tool-continuation shape evidence, scanned from the bounded prefix. The first input
 * item of a tool round's second leg names the pending call, and the serialization
 * writes the item's "type" (or "role":"tool") near its head, so a 2 MiB prefix that
 * starts mid-array-item can miss a shape the array opens with - which fails closed
 * (503, retryable) on a drain window measured in minutes.
 */
function looksLikeToolContinuation(text: string): boolean {
  return text.includes("function_call_output")
    || text.includes("tool_result")
    || text.includes('"role":"tool"')
    || text.includes('\"role\":\"tool\"')
    || text.includes('"role": "tool"')
    || text.includes("call_response")
    || text.includes("tool_call_response");
}

/* Continuation anchoring is lane-only, by design.
 *
 * The alternative - asking src/responses/state.ts whether a previous_response_id was
 * minted here - is a memory amplifier on this path: the replay entry points call
 * ensureLoaded() (one read of the whole durable snapshot on first use) and
 * materializeEntry() (a spilled payload moves into RAM, cap 256 MiB), so validating
 * continuations through the store would load and materialize state on the admission
 * path, exactly when the process is being drained. The lane registry is bounded
 * (4096 ids, TTL) and header-only; that is the whole cost.
 *
 * Consequence, stated plainly: a client whose second leg carries NO lane header (no
 * thread/session id) is refused during draining and retries on the 503. That is the
 * safe side of the trade - the supervisor drain window is minutes, and a false
 * release is an in-flight turn killed mid-transaction.
 */

/**
 * The fence gate. Returns a refusal Response, a replacement Request (the body was
 * consumed by a bounded prefix read that completed, and the request is admitted -
 * the caller must route the replacement), or null to let the request proceed
 * untouched. The caller applies CORS (same shape as drainingResponse).
 */
export async function wdevFenceGateResponse(
  req: Request,
  pathname: string,
): Promise<Response | Request | null> {
  const fenceFile = wdevMaintenanceFilePath();
  if (fenceFile === null) return null;
  const fence = wdevFenceRead(fenceFile);
  const laneId = sessionLaneIdFromRequest(req.headers);
  if (fence === null) {
    // Unfenced: remember the identities of admitted generation turns so the next fence
    // can distinguish a draining tool loop from fresh work. Headers only: no body read.
    if (GENERATION_POST_PATHS.has(pathname) && req.method === "POST") {
      wdevFenceNoteAdmitted({ laneId });
    }
    return null;
  }
  const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  const isGenerationPost = GENERATION_POST_PATHS.has(pathname) && req.method === "POST";
  if (!isGenerationPost && !(upgrade && isGenerationUpgrade(pathname))) return null;
  // Strict phases hard-block everything generation, with zero body reads: the kill
  // window has no room for a continuation gamble.
  if (fenceIsStrict(fence)) return maintenanceRefusal();
  if (upgrade) return maintenanceRefusal();
  // Draining: the second leg of a tool round (request -> tool output -> request) must
  // survive, or the drain the fence waits for deadlocks.
  if (isGenerationPost) {
    // Minimal validated in-flight chain: the lane was registered at admission (this
    // process ran the first leg) AND the bounded prefix is a tool-output continuation,
    // not a fresh user turn wearing an old header. Both are required.
    const laneKnown = laneId !== undefined && laneId !== "" && wdevFenceRegisteredLane(laneId);
    const prefix = await readBoundedBodyPrefix(req, CONTINUATION_PEEK_MAX_BYTES);
    if (!laneKnown || !prefix.complete || !looksLikeToolContinuation(prefix.text)) {
      return maintenanceRefusal();
    }
    return rebuildWithPrefix(req, prefix);
  }
  return maintenanceRefusal();
}

/** Rebuild the admitted request with the consumed prefix as its body (bounded at
 * 2 MiB, exactly what the downstream JSON reader may see). Refusal paths never get
 * here, so a cancelled/overflowed body is never routed onward. */
function rebuildWithPrefix(req: Request, prefix: BodyPrefix): Request {
  const bytes = new TextEncoder().encode(prefix.text);
  const headers = new Headers(req.headers);
  headers.set("content-length", String(bytes.byteLength));
  return new Request(req, { body: bytes, headers });
}

/**
 * Health projection for /healthz: {} when unfenced (field absent, response unchanged);
 * {maintenance:{active,operationId,phase,strict,fenceEpoch,ack:true}} when fenced.
 * ack=true means THIS process observed the fence on THIS request; the supervisor's
 * quiesce gate requires an ack seen after the fence write, and the per-request stat
 * refresh means an acked healthz and a gated POST cannot disagree by more than one
 * request.
 */
export function wdevFenceHealthPair(): Record<string, unknown> {
  const fenceFile = wdevMaintenanceFilePath();
  if (fenceFile === null) return {};
  const maintenance = wdevFenceHealthField(wdevFenceRead(fenceFile));
  return maintenance === null ? {} : { maintenance };
}
