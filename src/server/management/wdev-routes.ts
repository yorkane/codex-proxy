/**
 * Wdev service management routes (fork opt-in): /api/wdev/*.
 *
 * Mounted by the management dispatcher ONLY under the /api/wdev namespace, and this file is
 * dynamic-imported only after the config gate says enabled, so a disabled install loads no
 * wdev code at all (the spawner, manager-cli.ts, is dynamically imported here as well, and
 * only once a request actually needs the CLI). The dispatcher keeps auth exactly as the
 * surrounding routes: requireManagementAuth upstream, no new bypass.
 *
 * Contract with the manager CLI (python3 <root>/manager/wdev.py --home <deploy home>):
 *   components                 -> {components:[{id,unit,url,status,releaseId,configRevision,...}]}
 *                                 (status is the systemd reading "active"|"inactive"|"unknown";
 *                                  the route projects configRevision -> revision and
 *                                  active/inactive -> ok/down for the GUI's stable shape)
 *   submit --component C --action A --request-json J
 *                              -> {operationId, state:"queued"}. The frozen parser accepts
 *                                 the explicit --dispatch spelling (default True,
 *                                 --no-dispatch queue-only), so argv carries --dispatch
 *                                 (WDEV_MANAGER_SUBMIT_DISPATCH=0 drops it for a manager
 *                                 build predating the flag). Submit is fsync-first: it
 *                                 returns only after the operation is durable in the
 *                                 manager ledger, so a 202 here means "durably queued",
 *                                 never "applied".
 *   operation <uuid>           -> the ledger record (keys component/state/phase, updatedAt
 *                                 ISO); state is authoritative only here, projected onto
 *                                 the GUI's componentId/state/updatedAt field names.
 */
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync, readdirSync, statSync } from "node:fs";
import { jsonResponse } from "../auth-cors";
import { isPlainRecord } from "./shared";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import {
  WDEV_MANAGER_COMPONENTS,
  resolveWdevManagerRuntime,
  wdevManagerBrand,
  wdevManagerEnabled,
  wdevSubmitDispatchFlag,
  type WdevManagerRuntime,
} from "../../wdev/activation";
import type { ManagementContext } from "./context";

const WDEV_ACTIONS = ["restart", "upgrade", "configure"] as const;
type WdevAction = (typeof WDEV_ACTIONS)[number];
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WAIT_LIMIT_S = 600;
const LEDGER_CAP = 200;

interface OperationLedgerEntry {
  operationId: string;
  componentId: string;
  action: WdevAction;
  state: string;
  submittedAt: number;
  updatedAt: number;
  lastError?: string;
}

const ledger = new Map<string, OperationLedgerEntry>();
interface IdempotencyBinding {
  operationId: string;
  /** sha256 over the canonical (key-sorted) request; a rebound key is a conflict. */
  requestHash: string;
  seenAt: number;
}
const idempotency = new Map<string, IdempotencyBinding>();
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(record[k])).join(",") + "}";
}

function requestFingerprint(request: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex").slice(0, 40);
}

function recordOperation(entry: OperationLedgerEntry): void {
  ledger.set(entry.operationId, entry);
  if (ledger.size > LEDGER_CAP) {
    const oldest = ledger.keys().next().value;
    if (oldest !== undefined) ledger.delete(oldest);
  }
}

/**
 * Pre-submit gate: a key already bound to a DIFFERENT request is refused before the
 * manager CLI runs, so a conflicted submit has zero enqueue side effect (the manager
 * ledger dedup exists, but the proxy must not lean on it to undo a 202 it already
 * granted). A key re-POSTed with the IDENTICAL request replays the bound operation
 * instead of submitting a second one.
 */
function idempotencyDecision(key: string, hash: string, now: number):
  { conflict: true } | { replay: IdempotencyBinding } | null {
  for (const [k, seen] of idempotency) {
    if (now - seen.seenAt > IDEMPOTENCY_TTL_MS) idempotency.delete(k);
  }
  const prior = idempotency.get(key);
  if (prior === undefined) return null;
  return prior.requestHash === hash ? { replay: prior } : { conflict: true };
}

function bindIdempotency(key: string, operationId: string, hash: string, now: number): void {
  idempotency.set(key, { operationId, requestHash: hash, seenAt: now });
  if (idempotency.size > 512) {
    const oldest = idempotency.keys().next().value;
    if (oldest !== undefined) idempotency.delete(oldest);
  }
}

function projectComponent(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  if (id === null) return null;
  const out: Record<string, unknown> = { id };
  for (const field of ["unit", "url", "releaseId"] as const) {
    if (typeof value[field] === "string") out[field] = value[field];
  }
  if (typeof value.status === "string") out.status = projectComponentStatus(value.status);
  // The manager's component record carries configRevision (a non-negative int); the
  // GUI contract key is revision (a display string). Accept either spelling.
  const revision = value.revision ?? value.configRevision;
  if (typeof revision === "string" && revision !== "") out.revision = revision;
  else if (typeof revision === "number" && Number.isInteger(revision) && revision >= 0) out.revision = String(revision);
  return out;
}

/** Map the manager/systemd status reading onto the GUI's ok/degraded/down/unknown set. */
function projectComponentStatus(status: string): string {
  if (status === "active") return "ok";
  if (status === "inactive" || status === "failed") return "down";
  return status;
}

/** Read-only projection of the trusted manifest root; never a manager round-trip. */
function listManifests(manifestRoot: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let names: string[];
  try {
    names = readdirSync(manifestRoot);
  } catch {
    return out;
  }
  for (const name of names.slice(0, 100)) {
    try {
      const stat = statSync(resolve(manifestRoot, name));
      if (!stat.isFile()) continue;
      out.push({ name, path: name, version: "", sizeBytes: stat.size });
    } catch { /* entry vanished; the display list is best-effort */ }
  }
  return out;
}

function badRequest(message: string): Response {
  return jsonResponse({ error: message, code: "wdev_request_invalid" }, 400);
}

/**
 * Resolve a request manifestPath strictly inside the trusted manifest root. Returns the
 * realpath on success, null on anything else: absolute values, escaping `..`, symlinked
 * files outside the root, and missing files all land on null (400 to the client). The
 * request never supplies a directory, only a name resolved under the deploy-time root.
 */
export function resolveTrustedManifestPath(manifestRoot: string, manifestPath: string): string | null {
  if (manifestPath === "" || isAbsolute(manifestPath) || manifestPath.includes("\u0000")) return null;
  const candidate = resolve(manifestRoot, manifestPath);
  const rel = relative(resolve(manifestRoot), candidate);
  if (rel === "" || rel === "..") return null;
  if (rel.startsWith("..") || rel.startsWith("/")) return null;
  try {
    const real = realpathSync(candidate);
    const rootReal = realpathSync(manifestRoot);
    const inside = relative(rootReal, real);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

async function runCli<T>(runtime: WdevManagerRuntime, args: string[]): Promise<T | Response> {
  // Dynamic import keeps the spawner out of this module's load graph: the disabled path
  // never executes this line, and the boundary test pins that.
  const { runWdevCli, WdevCliError } = await import("../../wdev/manager-cli");
  try {
    const result = await runWdevCli<T>(runtime, args);
    return result.data;
  } catch (error) {
    if (error instanceof WdevCliError) {
      return jsonResponse({ error: "wdev manager command failed", code: error.code }, error.status);
    }
    throw error;
  }
}

function cliFailure(data: unknown): data is Response {
  return data instanceof Response;
}

export async function handleWdevRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  // The dispatcher gates the /api/wdev namespace before importing this file (see
  // handleWdevRoutesOnDemand in management-api.ts); this handler owns everything under it.
  if (!wdevManagerEnabled(config)) {
    return jsonResponse({ error: "wdev manager disabled", code: "wdev_disabled" }, 404);
  }
  const runtime = resolveWdevManagerRuntime();
  if (runtime === null) {
    return jsonResponse(
      { error: "wdev manager deployment env incomplete", code: "wdev_env_missing" }, 404);
  }

  if (url.pathname === "/api/wdev/components" && req.method === "GET") {
    const data = await runCli<unknown>(runtime, ["components"]);
    if (cliFailure(data)) return data;
    const components = isPlainRecord(data) && Array.isArray(data.components)
      ? data.components.map(projectComponent).filter((c): c is Record<string, unknown> => c !== null)
      : [];
    return jsonResponse({
      enabled: true,
      brand: wdevManagerBrand(config),
      components,
      manifests: listManifests(runtime.manifestRoot),
    });
  }

  if (url.pathname === "/api/wdev/operations" && req.method === "GET") {
    const operations = [...ledger.values()].sort((a, b) => b.submittedAt - a.submittedAt);
    return jsonResponse({ operations });
  }

  if (url.pathname === "/api/wdev/operations" && req.method === "POST") {
    let raw: unknown;
    try { raw = await readManagementJsonBody(req); }
    catch (error) { rethrowManagementBodyTooLarge(error); return badRequest("invalid JSON body"); }
    if (!isPlainRecord(raw)) return badRequest("body must be a JSON object");
    const allowed = new Set(["componentId", "action", "manifestPath", "configPatch",
      "expectedRevision", "idempotencyKey", "maxWait"]);
    const extras = Object.keys(raw).filter(k => !allowed.has(k));
    if (extras.length > 0) return badRequest(`unknown field(s): ${extras.join(",")}`);
    const { componentId, action, manifestPath, configPatch, expectedRevision, idempotencyKey, maxWait } = raw;
    if (typeof componentId !== "string" || !(WDEV_MANAGER_COMPONENTS as readonly string[]).includes(componentId)) {
      return badRequest("componentId must be one of web, llm-proxy");
    }
    if (typeof action !== "string" || !(WDEV_ACTIONS as readonly string[]).includes(action)) {
      return badRequest("action must be one of restart, upgrade, configure");
    }
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      return badRequest("idempotencyKey must match [A-Za-z0-9][A-Za-z0-9._-]{7,63}");
    }
    if (maxWait !== undefined && (typeof maxWait !== "number" || !Number.isInteger(maxWait)
      || maxWait < 0 || maxWait > MAX_WAIT_LIMIT_S)) {
      return badRequest(`maxWait must be an integer 0-${MAX_WAIT_LIMIT_S}`);
    }
    // The manager's sanitize step requires a non-negative integer; a numeric string is
    // accepted at the wire boundary (the GUI displays revisions as strings) and
    // normalised to a number before it is forwarded.
    let normalizedExpectedRevision: number | undefined;
    if (expectedRevision !== undefined) {
      const asNumber = typeof expectedRevision === "number" ? expectedRevision
        : (typeof expectedRevision === "string" && /^[0-9]+$/.test(expectedRevision) ? Number(expectedRevision) : Number.NaN);
      if (!Number.isInteger(asNumber) || asNumber < 0) {
        return badRequest("expectedRevision must be a non-negative integer");
      }
      normalizedExpectedRevision = asNumber;
    }
    let resolvedManifest: string | null = null;
    if (manifestPath !== undefined) {
      if (typeof manifestPath !== "string") return badRequest("manifestPath must be a string");
      resolvedManifest = resolveTrustedManifestPath(runtime.manifestRoot, manifestPath);
      if (resolvedManifest === null) {
        return badRequest("manifestPath must name a file inside the trusted manifest root");
      }
    }
    if (action === "upgrade" && resolvedManifest === null) {
      return badRequest("upgrade requires manifestPath");
    }
    if (action !== "upgrade" && manifestPath !== undefined) {
      return badRequest(`manifestPath is only valid for upgrade (action=${action})`);
    }
    if (configPatch !== undefined && !isPlainRecord(configPatch)) {
      return badRequest("configPatch must be a JSON object");
    }
    if (action === "restart" && (configPatch !== undefined || manifestPath !== undefined)) {
      return badRequest("restart carries no payload fields");
    }
    // The manager requires a configPatch on configure; rejecting it here turns a
    // would-be ledger-fail into an immediate 400.
    if (action === "configure" && configPatch === undefined) {
      return badRequest("configure requires configPatch");
    }
    const request: Record<string, unknown> = { idempotencyKey };
    if (resolvedManifest !== null) request.manifestPath = resolvedManifest;
    if (isPlainRecord(configPatch)) request.configPatch = configPatch;
    if (normalizedExpectedRevision !== undefined) request.expectedRevision = normalizedExpectedRevision;
    if (maxWait !== undefined) request.maxWait = maxWait;
    const now0 = Date.now();
    const hash = requestFingerprint(request);
    const decision = idempotencyDecision(idempotencyKey, hash, now0);
    if (decision !== null && "conflict" in decision) {
      return jsonResponse({
        error: "idempotencyKey already bound to a different operation",
        code: "wdev_idempotency_conflict",
      }, 409);
    }
    if (decision !== null) {
      // Same key, identical request: replay the bound operation. The manager is not
      // called again, so a client retry can never double-enqueue under one key.
      const prior = decision.replay;
      const entry = ledger.get(prior.operationId);
      return jsonResponse({
        operationId: prior.operationId,
        state: entry?.state ?? "queued",
        componentId: entry?.componentId ?? componentId,
        action: entry?.action ?? action,
        submittedAt: entry?.submittedAt ?? prior.seenAt,
        replayed: true,
      }, 202);
    }
    // The manager CLI dispatches on submit by default and its parser accepts the
    // explicit --dispatch spelling (mutually exclusive with --no-dispatch, default
    // True), so argv carries --dispatch; WDEV_MANAGER_SUBMIT_DISPATCH=0 drops it for a
    // manager build whose parser predates the flag. No request value ever reaches argv.
    const dispatchFlag = wdevSubmitDispatchFlag() ? ["--dispatch"] : [];
    const data = await runCli<unknown>(runtime, [
      "submit", "--component", componentId, "--action", action,
      "--request-json", JSON.stringify(request), ...dispatchFlag,
    ]);
    if (cliFailure(data)) return data;
    if (!isPlainRecord(data) || typeof data.operationId !== "string" || !UUID_RE.test(data.operationId)) {
      return jsonResponse({ error: "wdev manager returned an invalid submit result", code: "manager_bad_json" }, 502);
    }
    const now = Date.now();
    bindIdempotency(idempotencyKey, data.operationId, hash, now);
    recordOperation({
      operationId: data.operationId,
      componentId,
      action: action as WdevAction,
      state: typeof data.state === "string" ? data.state : "queued",
      submittedAt: now,
      updatedAt: now,
    });
    // 202 = durably queued in the manager ledger (submit is fsync-first). It is NOT
    // evidence the operation applied; poll GET /api/wdev/operations/:id for state.
    return jsonResponse({
      operationId: data.operationId,
      state: "queued",
      componentId,
      action,
      submittedAt: now,
    }, 202);
  }

  const operationMatch = /^\/api\/wdev\/operations\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
  if (operationMatch !== null && req.method === "GET") {
    const operationId = operationMatch[1]!;
    if (!UUID_RE.test(operationId)) return jsonResponse({ error: "not found", code: "wdev_operation_not_found" }, 404);
    const data = await runCli<unknown>(runtime, ["operation", operationId]);
    if (cliFailure(data)) return data;
    if (!isPlainRecord(data)) {
      return jsonResponse({ error: "wdev manager returned an invalid operation record", code: "manager_bad_json" }, 502);
    }
    const entry = ledger.get(operationId);
    // The real manager's ledger record names the component key "component" and keeps the
    // live status in both state and phase; the GUI contract keys are componentId/state,
    // so project both spellings (record-first for state, componentId from either).
    const stateValue = typeof data.state === "string" ? data.state
      : (typeof data.phase === "string" ? data.phase : undefined);
    if (stateValue !== undefined && entry) {
      entry.state = stateValue;
      entry.updatedAt = Date.now();
      if (typeof data.error === "string") entry.lastError = data.error.slice(0, 300);
    }
    const projected: Record<string, unknown> = { operationId };
    const componentValue = data.componentId ?? data.component;
    if (typeof componentValue === "string") projected.componentId = componentValue;
    if (stateValue !== undefined) projected.state = stateValue;
    for (const field of ["action", "expectedRevision", "newRevision"]) {
      const value = data[field];
      if (typeof value === "string" || typeof value === "number") projected[field] = value;
    }
    // The manager stamps createdAt/updatedAt as ISO strings; numbers pass through too.
    for (const field of ["updatedAt", "submittedAt", "createdAt"]) {
      const value = data[field];
      if (typeof value === "number" || typeof value === "string") projected[field] = value;
    }
    if (typeof data.error === "string") projected.error = data.error.slice(0, 300);
    return jsonResponse(projected);
  }

  return jsonResponse({ error: "not found", code: "wdev_route_not_found" }, 404);
}
