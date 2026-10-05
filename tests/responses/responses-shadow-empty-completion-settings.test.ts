/**
 * Empty-completion replay on the Shadow management surface (fork addition).
 *
 * The emptyCompletionRetry field is TOP-LEVEL config and the Shadow page owns its only
 * edit surface. These rows lock the three things that silently regress: GET reports the
 * field, a PUT both mutates the live config object (hot effect, no restart) and persists
 * it, and a non-boolean is rejected with 400 rather than being coerced to false by the
 * config schema's .catch(false).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { emptyCompletionRetryEnabled, EMPTY_COMPLETION_RETRY_ENV } from "../../src/server/responses/empty-completion-guard";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// An isolated OPENCODEX_HOME is mandatory, not cosmetic: the route calls the real
// saveConfigPreservingClaudeCode, so an unisolated fixture would write over the
// developer's own config.json (the incident the ManagementApiDeps save seam exists for).
const previousHome = process.env.OPENCODEX_HOME;
const previousEnv = process.env[EMPTY_COMPLETION_RETRY_ENV];
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-shadow-ecr-"));
  process.env.OPENCODEX_HOME = home;
  delete process.env[EMPTY_COMPLETION_RETRY_ENV];
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousEnv === undefined) delete process.env[EMPTY_COMPLETION_RETRY_ENV];
  else process.env[EMPTY_COMPLETION_RETRY_ENV] = previousEnv;
  if (home) removeTreeWithRetry(home);
  home = "";
});

function fixtureConfig(): OcxConfig {
  return { port: 0, defaultProvider: "xai", providers: {} } as OcxConfig;
}

async function shadowApi(config: OcxConfig, method: "GET" | "PUT", body?: unknown): Promise<Response> {
  // Management API enforces a same-origin gate; a browserless caller must look local.
  const headers: Record<string, string> = { origin: "http://127.0.0.1:10100", host: "127.0.0.1:10100" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request("http://localhost/api/shadow-call-settings", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  expect(res).not.toBeNull();
  return res!;
}

async function settingsBody(config: OcxConfig): Promise<Record<string, unknown>> {
  const res = await shadowApi(config, "GET");
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

function persistedConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
}

describe("shadow-call settings API emptyCompletionRetry", () => {
  test("GET reports false by default and true once enabled", async () => {
    const config = fixtureConfig();
    expect(await settingsBody(config)).toMatchObject({ emptyCompletionRetry: false });
    expect((await shadowApi(config, "PUT", { emptyCompletionRetry: true })).status).toBe(200);
    expect(await settingsBody(config)).toMatchObject({ emptyCompletionRetry: true });
  });

  test("PUT flips the live guard and persists it in one call", async () => {
    const config = fixtureConfig();
    // The guard reads the config object the running server holds, so mutating that very
    // reference is what makes the switch take effect on the next request: no restart.
    expect(emptyCompletionRetryEnabled(config)).toBe(false);
    const put = await shadowApi(config, "PUT", { emptyCompletionRetry: true });
    expect(put.status).toBe(200);
    expect((await put.json()).emptyCompletionRetry).toBe(true);
    expect(config.emptyCompletionRetry).toBe(true);
    expect(emptyCompletionRetryEnabled(config)).toBe(true);
    expect(persistedConfig().emptyCompletionRetry).toBe(true);

    const off = await shadowApi(config, "PUT", { emptyCompletionRetry: false });
    expect((await off.json()).emptyCompletionRetry).toBe(false);
    expect(emptyCompletionRetryEnabled(config)).toBe(false);
    expect(persistedConfig().emptyCompletionRetry).toBe(false);
  });

  test("PUT rejects a non-boolean instead of coercing it", async () => {
    const config = fixtureConfig();
    await shadowApi(config, "PUT", { emptyCompletionRetry: true });
    for (const bad of ["true", 1, 0, null, {}, []]) {
      const res = await shadowApi(config, "PUT", { emptyCompletionRetry: bad });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("emptyCompletionRetry must be a boolean");
    }
    // A rejected write never reaches the live value nor the persisted file.
    expect(config.emptyCompletionRetry).toBe(true);
    expect(persistedConfig().emptyCompletionRetry).toBe(true);
  });

  test("an absent field leaves the stored switch alone", async () => {
    const config = fixtureConfig();
    await shadowApi(config, "PUT", { emptyCompletionRetry: true });
    const res = await shadowApi(config, "PUT", { phantomToolAllowlistEnabled: false });
    expect(res.status).toBe(200);
    expect((await res.json()).emptyCompletionRetry).toBe(true);
    expect(persistedConfig().emptyCompletionRetry).toBe(true);
  });

  test("GET flags the disable-only environment override", async () => {
    const config = fixtureConfig();
    await shadowApi(config, "PUT", { emptyCompletionRetry: true });
    expect(await settingsBody(config)).toMatchObject({
      emptyCompletionRetry: true,
      emptyCompletionRetryEnvOverride: false,
    });
    process.env[EMPTY_COMPLETION_RETRY_ENV] = "0";
    // The persisted switch still reads true; the flag tells the UI the env override wins.
    expect(await settingsBody(config)).toMatchObject({
      emptyCompletionRetry: true,
      emptyCompletionRetryEnvOverride: true,
    });
    expect(emptyCompletionRetryEnabled(config)).toBe(false);
  });

  test("the replay switch works with interception off", async () => {
    const config = fixtureConfig();
    expect(config.shadowCallIntercept?.enabled ?? false).toBe(false);
    const res = await shadowApi(config, "PUT", { emptyCompletionRetry: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, emptyCompletionRetry: true });
  });
});

