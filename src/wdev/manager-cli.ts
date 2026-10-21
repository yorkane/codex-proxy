/**
 * Wdev manager CLI invoker (fork opt-in; the only spawner in src/wdev/).
 *
 * Reachable only through the /api/wdev routes, which are mounted only when the config
 * block says enabled. This module is deliberately NOT imported by the management-API
 * graph: the dispatcher dynamic-imports wdev-routes.ts, and the core-boundary test keeps
 * the spawn layer out of every install that did not opt in.
 *
 * Every invocation is a fixed argv array - interpreter, CLI entry, verb, --home, and
 * whitelisted flags - resolved from the deploy-time environment (activation.ts). No
 * shell, no PATH lookup, no request-supplied path, and stderr/stdout are bounded and
 * redacted before anything reaches a response body.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import type { WdevManagerRuntime } from "./activation";

export const WDEV_CLI_TIMEOUT_MS = 30_000;
export const WDEV_CLI_OUTPUT_MAX_BYTES = 256 * 1024;

export type WdevCliFailureCode =
  | "manager_trust_rejected"
  | "manager_spawn_failed"
  | "manager_timeout"
  | "manager_output_too_large"
  | "manager_bad_json"
  | "manager_exit";

export class WdevCliError extends Error {
  constructor(readonly code: WdevCliFailureCode, readonly status: number) {
    super(code);
    this.name = "WdevCliError";
  }
}

const SECRETISH_PATTERNS: Array<[RegExp, string]> = [
  [/x-opencodex-api-key[\"':= ]+[^\s\",}]+/gi, "x-opencodex-api-key:[redacted]"],
  [/authorization[\"':= ]+[^\s\",}]+/gi, "authorization:[redacted]"],
  [/\/home\/[A-Za-z0-9._-]+/g, "[home]"],
];

/** Bound + redact manager output before it can enter a response, a log line, or a test. */
export function sanitizeWdevCliOutput(raw: string): string {
  let text = raw;
  for (const [pattern, replacement] of SECRETISH_PATTERNS) text = text.replace(pattern, replacement);
  if (text.length > WDEV_CLI_OUTPUT_MAX_BYTES) text = text.slice(0, WDEV_CLI_OUTPUT_MAX_BYTES);
  return text;
}

/**
 * The manager path must be the deploy-time trusted root: an absolute CLI entry that
 * exists, is a regular file, and resolves (realpath) inside the trusted manager root.
 * A deployment that symlinks the entry (installer copies) passes; a symlink that
 * escapes the root does not. This runs per invocation, so a root swapped under us
 * between requests is caught, not cached.
 */
export function assertTrustedManagerRuntime(runtime: WdevManagerRuntime): void {
  if (!isAbsolute(runtime.cliPath) || !isAbsolute(runtime.managerRoot)) {
    throw new WdevCliError("manager_trust_rejected", 500);
  }
  let rootReal: string;
  let cliReal: string;
  try {
    rootReal = realpathSync(runtime.managerRoot);
    const stat = statSync(runtime.cliPath);
    if (!stat.isFile()) throw new Error("not a file");
    cliReal = realpathSync(runtime.cliPath);
  } catch {
    throw new WdevCliError("manager_trust_rejected", 500);
  }
  if (cliReal !== rootReal && !cliReal.startsWith(rootReal + "/")) {
    throw new WdevCliError("manager_trust_rejected", 500);
  }
  if (!isAbsolute(runtime.python)) throw new WdevCliError("manager_trust_rejected", 500);
}

export interface WdevCliResult<T> {
  data: T;
  exitCode: number;
}

function buildArgv(runtime: WdevManagerRuntime, args: readonly string[]): string[] {
  return [runtime.python, runtime.cliPath, "--home", runtime.deployHome, ...args];
}

/**
 * Run one manager command and parse its stdout as JSON.
 *
 * - argv array, no shell; cwd is the manager root; stdio captured, not inherited.
 * - hard timeout with kill (the CLI's own submit is fsync-first, so 30s is generous).
 * - stdout over the cap, non-zero exit, or unparseable JSON all raise WdevCliError with
 *   a fixed code: the manager's stderr text is NEVER forwarded, only its sanitized,
 *   truncated form goes to the returned detail for the operator message.
 */
export async function runWdevCli<T = unknown>(
  runtime: WdevManagerRuntime,
  args: readonly string[],
  options: { timeoutMs?: number; spawnImpl?: typeof Bun.spawn } = {},
): Promise<WdevCliResult<T>> {
  assertTrustedManagerRuntime(runtime);
  const envTimeout = Number(process.env.WDEV_MANAGER_TIMEOUT_MS ?? "");
  const timeoutMs = options.timeoutMs
    ?? (Number.isFinite(envTimeout) && envTimeout >= 500 && envTimeout <= 120_000 ? envTimeout : WDEV_CLI_TIMEOUT_MS);
  const spawnImpl = options.spawnImpl ?? Bun.spawn;
  let child: ReturnType<typeof spawnImpl>;
  try {
    child = spawnImpl(buildArgv(runtime, args), {
      cwd: runtime.managerRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
  } catch {
    throw new WdevCliError("manager_spawn_failed", 502);
  }
  const timeoutId = setTimeout(() => {
    killedByTimeout = true;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, timeoutMs);
  let killedByTimeout = false;
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout as unknown as BodyInit).text(),
      new Response(child.stderr as unknown as BodyInit).text(),
      child.exited,
    ]);
    stdout = out;
    stderr = err;
    exitCode = code;
  } catch {
    throw new WdevCliError("manager_spawn_failed", 502);
  } finally {
    clearTimeout(timeoutId);
  }
  if (killedByTimeout || exitCode === -1) throw new WdevCliError("manager_timeout", 504);
  if (stdout.length > WDEV_CLI_OUTPUT_MAX_BYTES) {
    throw new WdevCliError("manager_output_too_large", 502);
  }
  if (exitCode !== 0) {
    // Keep the sanitized tail for operator diagnosis, mapped to a 502; the raw line is
    // never logged (privacy:scan) and never echoed to the client verbatim.
    void sanitizeWdevCliOutput(stderr);
    throw new WdevCliError("manager_exit", 502);
  }
  let data: T;
  try {
    data = JSON.parse(stdout) as T;
  } catch {
    throw new WdevCliError("manager_bad_json", 502);
  }
  return { data, exitCode };
}

// UUIDs key every operation lookup; keep the validator next to the spawner it guards.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isWdevOperationId(value: string): boolean {
  return UUID_RE.test(value);
}
export function newWdevIdempotencyKey(): string {
  return randomUUID();
}
export function wdevManagerCliPresent(runtime: WdevManagerRuntime | null): boolean {
  return runtime !== null && existsSync(runtime.cliPath);
}
