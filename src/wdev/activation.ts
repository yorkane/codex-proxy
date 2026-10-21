/**
 * Wdev manager activation (fork opt-in).
 *
 * The proxy core must not know how to talk to the wdev manager. This module is the seam
 * that decides whether the rest of src/wdev/ is reachable at all, and it is the only
 * place the manager's on-disk coordinates are resolved. Everything here is pure
 * environment reading: no spawn, no timer, no fs mutation, no import of the CLI layer.
 *
 * Trust model. The manager root, the interpreter, and the manifest root are FIXED at
 * deploy time by environment variables written into the service unit. A management
 * request can never supply, override, or widen any of them - the request whitelist has
 * no path-typed field that is not resolved inside manifestRoot, and this module is the
 * single source of truth for where the CLI lives. That is the property the route tests
 * assert (path-injection attempts produce 400, never a spawn).
 *
 * Disabled is the default: an install with no wdevManager block and no WDEV_* env runs
 * no code from src/wdev/manager-cli.ts (the spawner) at all - the route dispatcher
 * dynamic-imports the handler only after wdevManagerEnabled says yes.
 */
import { isAbsolute, join, resolve } from "node:path";
import type { OcxConfig } from "../types";

export const WDEV_MANAGER_ENV = {
  home: "WDEV_MANAGER_HOME",
  deployHome: "WDEV_DEPLOY_HOME",
  python: "WDEV_MANAGER_PYTHON",
  manifestRoot: "WDEV_MANIFEST_ROOT",
  maintenanceFile: "WDEV_MAINTENANCE_FILE",
} as const;

export const WDEV_MANAGER_PYTHON_DEFAULT = "/usr/bin/python3";

/** The CLI entry the installer materializes inside the manager root. Not configurable. */
export const WDEV_MANAGER_CLI_RELATIVE = ["manager", "wdev.py"] as const;

/** Components the manager owns. The request whitelist accepts exactly these ids. */
export const WDEV_MANAGER_COMPONENTS = ["web", "llm-proxy"] as const;

export interface WdevManagerRuntime {
  /** Manager root: "<deploy home>/wdev" (the --home the CLI gets is its parent). */
  managerRoot: string;
  /** Absolute CLI entry: "<manager root>/manager/wdev.py". */
  cliPath: string;
  /** The --home argument: the deploy user's home, never a request value. */
  deployHome: string;
  /** Interpreter: absolute, env-overridable at deploy time only. */
  python: string;
  /** Whitelist root for manifestPath: request values resolve inside this directory. */
  manifestRoot: string;
  /** Supervisor-maintained fence file for the llm-proxy component. */
  maintenanceFile: string;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolve the manager runtime from the deploy-time environment.
 *
 * Returns null (never throws) when the contract is incomplete: a half-configured
 * deployment must behave like a disabled one, and the routes answer 404 with a code that
 * names the missing variable rather than spawning a guessed path.
 */
export function resolveWdevManagerRuntime(
  env: NodeJS.ProcessEnv = process.env,
): WdevManagerRuntime | null {
  const managerRoot = envValue(env, WDEV_MANAGER_ENV.home);
  if (!managerRoot || !isAbsolute(managerRoot)) return null;
  const python = envValue(env, WDEV_MANAGER_ENV.python) ?? WDEV_MANAGER_PYTHON_DEFAULT;
  // Absolute-path-only, and never a PATH lookup: a relative value would let the
  // interpreter be resolved by the environment of whatever unit spawned us.
  if (!isAbsolute(python)) return null;
  const root = resolve(managerRoot);
  const cliPath = join(root, ...WDEV_MANAGER_CLI_RELATIVE);
  // --home is the deploy user's home. WDEV_DEPLOY_HOME pins it explicitly; the
  // fallback is the manager root's parent (<home>/wdev -> <home>).
  const deployHome = envValue(env, WDEV_MANAGER_ENV.deployHome)
    ?? (root.endsWith("/wdev") ? root.slice(0, -"/wdev".length) : undefined);
  if (!deployHome || !isAbsolute(deployHome)) return null;
  return {
    managerRoot: root,
    cliPath,
    deployHome,
    python,
    manifestRoot: resolve(envValue(env, WDEV_MANAGER_ENV.manifestRoot) ?? join(root, "manifests")),
    maintenanceFile: resolve(envValue(env, WDEV_MANAGER_ENV.maintenanceFile)
      ?? join(root, "state", "maintenance-llm-proxy.json")),
  };
}

/** The config gate. Only an explicit true enables; malformed blocks degrade to off. */
export function wdevManagerEnabled(config: Pick<OcxConfig, "wdevManager"> | undefined): boolean {
  return config?.wdevManager?.enabled === true;
}

/** Display brand (thin-shell appearance only). Never a path, never a routing key. */
export function wdevManagerBrand(config: Pick<OcxConfig, "wdevManager"> | undefined): string {
  const brand = config?.wdevManager?.brand;
  return typeof brand === "string" ? brand : "";
}

/**
 * Does `submit` carry the explicit `--dispatch` flag? The frozen manager parser dispatches
 * on submit by default AND accepts the explicit `--dispatch` spelling (with
 * `--no-dispatch` as the queue-only opt-out), so the proxy sends the flag: the intent is
 * legible in argv, and a deployment pinned to a parser build that predates the flag sets
 * WDEV_MANAGER_SUBMIT_DISPATCH=0 to drop it. The request JSON is identical in both modes;
 * this is an argv-shape switch only, not a behavior namespace.
 */
export function wdevSubmitDispatchFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WDEV_MANAGER_SUBMIT_DISPATCH;
  if (typeof raw !== "string") return true;
  const value = raw.trim().toLowerCase();
  if (value === "") return true;
  return !(value === "0" || value === "false");
}
