import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig } from "../../src/config";
import { configDiagnosticsFromRaw } from "../../src/config/diagnostics";
import { configSchema } from "../../src/config/schema/config-schema";
import {
  isAllowedManagementOrigin,
  isAllowedRequestOrigin,
  managementCorsHeaders,
  requestPolicyView,
  withCors,
  withManagementCors,
} from "../../src/server/auth-cors";
import { isRemoteGuiBrowserOriginAllowed } from "../../src/server/gui-session";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Invariant pinned here:
 *
 *   A malformed (non-array) `corsAllowOrigins` in config.json MUST be degraded to
 *   `undefined` by the load-path schema, and MUST NOT reach the admission/CORS helpers.
 *
 * Why this is load-bearing rather than cosmetic: upstream ships the CONSUMER of this
 * field but no zod entry for it, and the top-level schema is `.passthrough()`, so an
 * undeclared key survives parsing verbatim. `isExtraAllowedOrigin()` then does
 * `if (!cfg.corsAllowOrigins?.length) return false;` — a non-empty STRING has a truthy
 * `.length`, so it walks into `.some()` and throws TypeError. Measured: that TypeError
 * escapes `fetch` and Bun answers the request with 500 "Something went wrong!".
 * One bad hand-edit would therefore take down every cross-origin request, not just the
 * misconfigured allow-list. The fork's explicit `.catch(undefined)` is what prevents it,
 * and the tests below are what stop it from being "cleaned up" as redundant later.
 *
 * Every test here goes through a REAL entry point (loadConfig / configDiagnosticsFromRaw
 * / configSchema), never a hand-built config object, because a hand-built object skips the
 * zod layer and would prove nothing about it.
 */

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-cors-allow-origins-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

/** A config the schema accepts, carrying a sentinel so we can prove nothing else got dropped. */
function baseConfig(): Record<string, unknown> {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    providers: {
      ...(defaults.providers ?? {}),
      probe: {
        adapter: "openai-responses",
        baseUrl: "https://probe.example/v1",
        note: "survivor",
      },
    },
  };
}

function writeConfig(withField: boolean, value?: unknown): void {
  const config = baseConfig();
  if (withField) config.corsAllowOrigins = value;
  writeFileSync(getConfigPath(), JSON.stringify(config), "utf8");
}

/**
 * Requests that actually reach the throwing helper: a foreign Origin on a loopback Host.
 *
 * The explicit Host header is load-bearing. `new Request(url)` does not surface a Host header,
 * and `managementRequestOrigin()` bails to null without one -- which silently hides the whole
 * management-plane exposure from a probe that forgets to set it. A real browser always sends Host.
 */
const LOOPBACK_HOST = "127.0.0.1:10100";
const FOREIGN_ORIGIN = "https://attacker.example";

function foreignOriginRequest(path = "/v1/chat/completions", method = "POST"): Request {
  return new Request("http://" + LOOPBACK_HOST + path, {
    method,
    headers: { Host: LOOPBACK_HOST, Origin: FOREIGN_ORIGIN },
  });
}

// Values that would be fatal if they survived to the guard. "" is NOT one of them: an empty
// string has falsy .length and short-circuits, which is exactly why the guard is value-shaped
// and why pinning the degrading layer matters more than trusting the two call sites.
const MALFORMED: Array<[string, unknown]> = [
  ["non-empty string", "not-an-array"],
  ["single char string", "a"],
  ["stringified array", '["https://ok.example"]'],
  ["array containing a number", ["https://ok.example", 7]],
  ["array containing null", ["https://ok.example", null]],
  ["array containing an object", [["https://ok.example"]]],
  ["plain object", { 0: "https://ok.example" }],
  ["boolean", true],
  ["number", 5],
  ["null", null],
];

test("malformed corsAllowOrigins degrades to undefined through the real load path", () => {
  for (const [label, value] of MALFORMED) {
    writeConfig(true, value);
    const config = loadConfig();
    expect(config.corsAllowOrigins, label).toBeUndefined();
  }
});

test("degrading the allow-list never costs the operator their providers", () => {
  // The whole point of .catch(undefined) over a strict schema: a typo in one optional
  // key must not trip the backup-and-defaults repair path and wipe the rest of the file.
  for (const [label, value] of MALFORMED) {
    writeConfig(true, value);
    const config = loadConfig();
    expect(config.providers?.probe?.note, label).toBe("survivor");
  }
});

test("a valid allow-list survives the load path untouched", () => {
  const allowed = ["https://dashboard.example.com", "chrome-extension://modkelfkcfjpgbfmnbnllalkiogfofh"];
  writeConfig(true, allowed);
  expect(loadConfig().corsAllowOrigins).toEqual(allowed);
});

test("an absent allow-list stays undefined", () => {
  writeConfig(false);
  expect(loadConfig().corsAllowOrigins).toBeUndefined();
});

test("cross-origin admission never throws on a malformed hand edit", () => {
  // This is the 500 the zod entry prevents. Asserted on the LOADED config, so it exercises
  // the same object the listener would build its policy view from.
  for (const [label, value] of MALFORMED) {
    writeConfig(true, value);
    const config = loadConfig();
    const policy = requestPolicyView(config, "127.0.0.1");
    expect(() => isAllowedRequestOrigin(foreignOriginRequest(), policy), label).not.toThrow();
    // Fail-closed: a degraded allow-list admits nothing it previously would have.
    expect(isAllowedRequestOrigin(foreignOriginRequest(), policy), label).toBe(false);
    expect(() => isRemoteGuiBrowserOriginAllowed(FOREIGN_ORIGIN, config), label).not.toThrow();
    // Management plane (/api/*) reaches the same helper via isAllowedManagementOrigin, and the
    // OPTIONS preflight branch reaches it through corsHeaders/managementCorsHeaders before any
    // handler runs -- so without the schema entry the dashboard and the GUI preflight 500 as
    // well, not only the data plane.
    expect(() => isAllowedManagementOrigin(foreignOriginRequest("/api/models", "GET"), config), label).not.toThrow();
    expect(() => managementCorsHeaders(foreignOriginRequest("/api/models", "GET"), config), label).not.toThrow();
    expect(() => withManagementCors(new Response("ok"), foreignOriginRequest("/api/models", "GET"), config), label).not.toThrow();
    expect(() => withCors(new Response("ok"), foreignOriginRequest(), policy), label).not.toThrow();
  }
});

test("the diagnostics path degrades the same way", () => {
  // Second real entry point: the config reader the dashboard/diagnostics use must agree
  // with loadConfig, or a malformed value resurfaces through the read side.
  const raw = JSON.stringify({ ...baseConfig(), corsAllowOrigins: "not-an-array" });
  const diagnostics = configDiagnosticsFromRaw(raw);
  expect(diagnostics.source).toBe("file");
  expect(diagnostics.config.corsAllowOrigins).toBeUndefined();
});

test("the schema entry is scoped to this key and does not strip other passthrough values", () => {
  const parsed = configSchema.parse({ ...baseConfig(), corsAllowOrigins: "not-an-array", someUnknownKey: { keep: true } });
  expect(parsed.corsAllowOrigins).toBeUndefined();
  expect((parsed as Record<string, unknown>).someUnknownKey).toEqual({ keep: true });
});

test("counterfactual: without the schema entry the malformed value is fatal at the guard", () => {
  // Characterization test, not a production path. It documents what the .catch is buying:
  // hand the SAME value to the consumer the way .passthrough() would deliver it, and the
  // request dies. If someone later adds a runtime guard in auth-cors.ts, this still passes;
  // if someone deletes the zod entry believing it redundant, the tests above go red instead.
  const handBuilt = {
    hostname: "127.0.0.1",
    corsAllowOrigins: "not-an-array",
    apiKeys: [{ id: "k", key: "aaaaaaaaaaaaaaaaaaaa" }],
  } as unknown as Parameters<typeof isAllowedRequestOrigin>[1];
  const handBuiltConfig = {
    hostname: "127.0.0.1",
    corsAllowOrigins: "not-an-array",
    apiKeys: [{ id: "k", key: "aaaaaaaaaaaaaaaaaaaa" }],
  } as never;
  // Data plane, management plane, GUI-session check and both CORS header builders all
  // reach the same `.some()` on a non-array. Measured: each throws TypeError, and an
  // escaping throw in fetch becomes Bun's 500 "Something went wrong!".
  expect(() => isAllowedRequestOrigin(foreignOriginRequest(), handBuilt)).toThrow(TypeError);
  expect(() => isAllowedManagementOrigin(foreignOriginRequest("/api/models", "GET"), handBuiltConfig)).toThrow(TypeError);
  expect(() => managementCorsHeaders(foreignOriginRequest("/api/models", "GET"), handBuiltConfig)).toThrow(TypeError);
  expect(() => withManagementCors(new Response("ok"), foreignOriginRequest("/api/models", "GET"), handBuiltConfig)).toThrow(TypeError);
  expect(() => withCors(new Response("ok"), foreignOriginRequest(), handBuilt)).toThrow(TypeError);
  expect(() => isRemoteGuiBrowserOriginAllowed(FOREIGN_ORIGIN, handBuiltConfig)).toThrow(TypeError);

  // And the falsy-length shape proves the guard is not a substitute for the schema layer:
  // "" slips past the .length check, while "a" (length 1) does not.
  const slips = { hostname: "127.0.0.1", corsAllowOrigins: "" } as unknown as Parameters<typeof isAllowedRequestOrigin>[1];
  expect(isAllowedRequestOrigin(foreignOriginRequest(), slips)).toBe(false);
});

test("an empty-string allow-list is inert but harmless (guard-shape characterization)", () => {
  // Included because it is the near-miss that makes the schema layer non-substitutable: "" is
  // a valid z.string() element, so an array of it survives parsing, yet the guard's
  // !cfg.corsAllowOrigins?.length check treats "" as falsy and short-circuits. A one-char
  // string does NOT short-circuit. Whether the guard survives therefore depends on the
  // *shape* of the malformed value -- which is why the degrading layer, not the guard, is
  // the thing under test everywhere above.
  writeConfig(true, [""]);
  const config = loadConfig();
  expect(config.corsAllowOrigins).toEqual([""]);
  const policy = requestPolicyView(config, "127.0.0.1");
  expect(() => isAllowedRequestOrigin(foreignOriginRequest(), policy)).not.toThrow();
  expect(isAllowedRequestOrigin(foreignOriginRequest(), policy)).toBe(false);
});

test("KNOWN GAP: a degraded allow-list currently announces nothing", () => {
  // Documents an observability hole rather than asserting a fix we are not allowed to make
  // from this workstream: every sibling degrade in src/config/load-degrade.ts warns
  // ("invalid blockedModelRedirects ignored", "streamMode ... falling back"), but
  // corsAllowOrigins has no warnDegraded* entry. The operator therefore loses their external
  // proxy origin to a typo and sees only unexplained 403s. Asserted as FALSE-does-not-exist
  // today so the moment someone adds the warning this test flips red and forces a deliberate
  // update instead of a silent drift.
  writeConfig(true, "not-an-array");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    loadConfig();
  } finally {
    warning.mockRestore();
  }
  const announced = warning.mock.calls.some(call => String(call[0]).includes("corsAllowOrigins"));
  expect(announced, "corsAllowOrigins gained a degrade warning -- update this test to assert the real message").toBe(false);
});
