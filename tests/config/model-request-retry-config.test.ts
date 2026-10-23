import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDefaultConfig, loadConfig, validateConfigCandidate } from "../../src/config";
import { handleConfigRoutes } from "../../src/server/management/config-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import {
  DEFAULT_MODEL_REQUEST_MAX_RETRIES,
  MODEL_REQUEST_MAX_RETRIES_LIMIT,
} from "../../src/lib/model-request-retry";

const TRASH_ROOT = "/data/.trash";
let trashSeq = 0;

/** Repository rule: nothing is deleted, it is moved to the local trash bucket. */
function toTrash(path: string): void {
  mkdirSync(TRASH_ROOT, { recursive: true });
  trashSeq += 1;
  renameSync(path, join(TRASH_ROOT, `mrr-config-${Date.now()}-${trashSeq}`));
}

function harness(failSave = false) {
  const config = getDefaultConfig();
  let saves = 0;
  const call = async (body?: unknown, pathname = "/api/settings") => {
    const url = new URL("http://localhost" + pathname);
    return handleConfigRoutes({
      url,
      req: new Request(url, {
        method: body === undefined ? "GET" : "PUT",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      config,
      version: "test",
      deps: { saveConfigPreservingClaudeCode: (_c: OcxConfig) => {
        saves++;
        if (failSave) throw new Error("fixture-save-failed");
      } },
    } as unknown as ManagementContext);
  };
  return { config, call, saves: () => saves };
}

test("model-request retry budget ships the mandated default and round-trips through settings", async () => {
  const h = harness();
  expect(h.config.modelRequestMaxRetries).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES);
  const read = await (await h.call())!.json() as Record<string, unknown>;
  expect(read.modelRequestMaxRetries).toBe(10);
  expect(read.modelRequestMaxRetriesMin).toBe(10);
  expect(read.modelRequestMaxRetriesLimit).toBe(100);

  expect(await (await h.call({ modelRequestMaxRetries: 40 }))!.json()).toMatchObject({
    modelRequestMaxRetries: 40,
    modelRequestMaxRetriesConfigured: 40,
  });
  expect(h.config.modelRequestMaxRetries).toBe(40);
  expect(h.saves()).toBe(1);

  // A settings PUT for another key preserves the persisted budget.
  await h.call({ streamMode: "auto" });
  expect(h.config.modelRequestMaxRetries).toBe(40);

  // null restores the shipped default by deleting the key, so an absent value stays the floor.
  const cleared = await (await h.call({ modelRequestMaxRetries: null }))!.json() as Record<string, unknown>;
  expect(cleared.modelRequestMaxRetries).toBe(10);
  expect(cleared.modelRequestMaxRetriesConfigured).toBeUndefined();
  expect(Object.hasOwn(h.config, "modelRequestMaxRetries")).toBe(false);
});

test("model-request retry budget refuses values outside the accepted range before persisting", async () => {
  const h = harness();
  // NaN/Infinity are not JSON-representable (both serialize to null, the clear form) and are
  // covered on the candidate-write surface below.
  for (const value of [0, 1, 5, 9, 101, 1000, -10, 1.5, "25", {}, []]) {
    expect((await h.call({ modelRequestMaxRetries: value }))!.status).toBe(400);
  }
  expect(h.saves()).toBe(0);
  expect(h.config.modelRequestMaxRetries).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES);
  // `null` is the documented clear (delete the key, floor applies), so the write boundary
  // accepts it rather than refusing it as an out-of-range number.
  expect((await h.call({ modelRequestMaxRetries: null }))!.status).toBe(200);
  expect(Object.hasOwn(h.config, "modelRequestMaxRetries")).toBe(false);
});

test("model-request retry budget rolls back a settings save failure", async () => {
  const h = harness(true);
  await expect(h.call({ modelRequestMaxRetries: 55 })).rejects.toThrow("fixture-save-failed");
  expect(h.config.modelRequestMaxRetries).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES);
});

test("model-request retry budget is reported on the safe config DTO", async () => {
  const h = harness();
  h.config.modelRequestMaxRetries = 70;
  const dto = await (await h.call(undefined, "/api/config"))!.json() as Record<string, unknown>;
  expect(dto.modelRequestMaxRetries).toBe(70);
  expect(dto.modelRequestMaxRetriesConfigured).toBe(70);
  expect(dto.modelRequestMaxRetriesMin).toBe(10);
  expect(dto.modelRequestMaxRetriesLimit).toBe(100);
});

test("model-request retry budget reports the resolved value, not an unparseable env override", async () => {
  const key = "OCX_MODEL_REQUEST_MAX_RETRIES";
  const previous = process.env[key];
  process.env[key] = "not-a-number";
  try {
    const h = harness();
    h.config.modelRequestMaxRetries = 12;
    const read = await (await h.call())!.json() as Record<string, unknown>;
    // A malformed env value changes nothing: the persisted 12 stays effective, and the
    // response says so by reporting 12 as both the effective and the configured number.
    expect(read.modelRequestMaxRetries).toBe(12);
    expect(read.modelRequestMaxRetriesConfigured).toBe(12);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("model-request retry budget env override is the effective number on settings", async () => {
  const key = "OCX_MODEL_REQUEST_MAX_RETRIES";
  const previous = process.env[key];
  process.env[key] = "25";
  try {
    const h = harness();
    const read = await (await h.call())!.json() as Record<string, unknown>;
    expect(read.modelRequestMaxRetries).toBe(25);
    expect(read.modelRequestMaxRetriesConfigured).toBe(10);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("model-request retry budget candidate writes validate the accepted integer range", () => {
  const defaults = getDefaultConfig();
  for (const value of [10, 11, 42, 100]) {
    const validated = validateConfigCandidate({ ...defaults, modelRequestMaxRetries: value });
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.config.modelRequestMaxRetries).toBe(value);
  }
  for (const value of [0, 5, 101, 1.5, -1, "25", null, {}, [], NaN, Infinity]) {
    expect(validateConfigCandidate({ ...defaults, modelRequestMaxRetries: value }).ok).toBe(false);
  }
});

test("model-request retry budget malformed disk value degrades to the floor without losing providers", () => {
  const home = mkdtempSync("/data/tmp/ocx-mrr-config-");
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const config = getDefaultConfig();
    writeFileSync(join(home, "config.json"), JSON.stringify({
      ...config,
      modelRequestMaxRetries: "private-fixture-value",
      defaultProvider: "openai",
    }));
    const loaded = loadConfig();
    // The malformed hand edit is dropped, never honoured as a number, and the rest of the
    // config survives: the pipeline then resolves the absent value to the 10-retry floor.
    expect(loaded.modelRequestMaxRetries).toBeUndefined();
    expect(loaded.defaultProvider).toBe("openai");
    expect(loaded.providers.openai).toBeDefined();
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    toTrash(home);
  }
});
