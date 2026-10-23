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
  MODEL_REQUEST_MAX_RETRIES_MIN,
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
  expect(read.modelRequestMaxRetries).toBe(3);
  expect(read.modelRequestMaxRetriesMin).toBe(0);
  expect(read.modelRequestMaxRetriesLimit).toBe(5);
  expect(read.modelRequestMaxRetriesDefault).toBe(3);
  expect(read.modelRequestMaxRetriesEnvOverride).toBe(false);

  expect(await (await h.call({ modelRequestMaxRetries: 5 }))!.json()).toMatchObject({
    modelRequestMaxRetries: 5,
    modelRequestMaxRetriesConfigured: 5,
  });
  expect(h.config.modelRequestMaxRetries).toBe(5);
  expect(h.saves()).toBe(1);

  // 0 is a configured value, not the clear: it disables proxy-side model HTTP retries.
  const zero = await (await h.call({ modelRequestMaxRetries: 0 }))!.json() as Record<string, unknown>;
  expect(zero.modelRequestMaxRetries).toBe(0);
  expect(zero.modelRequestMaxRetriesConfigured).toBe(0);
  expect(h.config.modelRequestMaxRetries).toBe(0);

  // A settings PUT for another key preserves the persisted budget.
  await h.call({ streamMode: "auto" });
  expect(h.config.modelRequestMaxRetries).toBe(0);

  // null restores the shipped default by deleting the key, so an absent value stays the default 3.
  const cleared = await (await h.call({ modelRequestMaxRetries: null }))!.json() as Record<string, unknown>;
  expect(cleared.modelRequestMaxRetries).toBe(3);
  expect(cleared.modelRequestMaxRetriesConfigured).toBeUndefined();
  expect(Object.hasOwn(h.config, "modelRequestMaxRetries")).toBe(false);
});

test("model-request retry budget refuses values outside the accepted range before persisting", async () => {
  const h = harness();
  // NaN/Infinity are not JSON-representable (both serialize to null, the clear form) and are
  // covered on the candidate-write surface below. A legacy 10 is refused, never migrated to 5.
  for (const value of [6, 10, 101, 1000, -1, -10, 1.5, "25", {}, []]) {
    expect((await h.call({ modelRequestMaxRetries: value }))!.status).toBe(400);
  }
  expect(h.saves()).toBe(0);
  expect(h.config.modelRequestMaxRetries).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES);
  // `null` is the documented clear (delete the key, default applies), so the write boundary
  // accepts it rather than refusing it as an out-of-range number.
  expect((await h.call({ modelRequestMaxRetries: null }))!.status).toBe(200);
  expect(Object.hasOwn(h.config, "modelRequestMaxRetries")).toBe(false);
});

test("model-request retry budget rolls back a settings save failure", async () => {
  const h = harness(true);
  await expect(h.call({ modelRequestMaxRetries: 4 })).rejects.toThrow("fixture-save-failed");
  expect(h.config.modelRequestMaxRetries).toBe(DEFAULT_MODEL_REQUEST_MAX_RETRIES);
  // A clear (null) that fails to save restores the key's presence and value verbatim.
  const h2 = harness(true);
  h2.config.modelRequestMaxRetries = 2;
  await expect(h2.call({ modelRequestMaxRetries: null })).rejects.toThrow("fixture-save-failed");
  expect(h2.config.modelRequestMaxRetries).toBe(2);
});

test("model-request retry budget is reported on the safe config DTO", async () => {
  const h = harness();
  h.config.modelRequestMaxRetries = 1;
  const dto = await (await h.call(undefined, "/api/config"))!.json() as Record<string, unknown>;
  expect(dto.modelRequestMaxRetries).toBe(1);
  expect(dto.modelRequestMaxRetriesConfigured).toBe(1);
  expect(dto.modelRequestMaxRetriesMin).toBe(0);
  expect(dto.modelRequestMaxRetriesLimit).toBe(5);
  expect(dto.modelRequestMaxRetriesDefault).toBe(3);
});

test("model-request retry budget reports the resolved value, not an unparseable env override", async () => {
  const key = "OCX_MODEL_REQUEST_MAX_RETRIES";
  const previous = process.env[key];
  process.env[key] = "not-a-number";
  try {
    const h = harness();
    h.config.modelRequestMaxRetries = 1;
    const read = await (await h.call())!.json() as Record<string, unknown>;
    // A malformed env value changes nothing: the persisted 1 stays effective, and the
    // response says so by reporting 1 as both the effective and the configured number.
    expect(read.modelRequestMaxRetries).toBe(1);
    expect(read.modelRequestMaxRetriesConfigured).toBe(1);
    expect(read.modelRequestMaxRetriesEnvOverride).toBe(false);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("model-request retry budget env override is the effective number on settings", async () => {
  const key = "OCX_MODEL_REQUEST_MAX_RETRIES";
  const previous = process.env[key];
  process.env[key] = "4";
  try {
    const h = harness();
    const read = await (await h.call())!.json() as Record<string, unknown>;
    expect(read.modelRequestMaxRetries).toBe(4);
    expect(read.modelRequestMaxRetriesConfigured).toBe(3);
    expect(read.modelRequestMaxRetriesEnvOverride).toBe(true);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("model-request retry budget env override covers a clamped legacy value", async () => {
  const key = "OCX_MODEL_REQUEST_MAX_RETRIES";
  const previous = process.env[key];
  process.env[key] = "10";
  try {
    const h = harness();
    const read = await (await h.call())!.json() as Record<string, unknown>;
    // A parsed env number clamps into range (10 -> 5) and IS an override: it is the
    // operator's explicit instruction, not a malformed value.
    expect(read.modelRequestMaxRetries).toBe(5);
    expect(read.modelRequestMaxRetriesEnvOverride).toBe(true);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("model-request retry budget candidate writes validate the accepted integer range", () => {
  const defaults = getDefaultConfig();
  for (const value of [0, 1, 3, 5]) {
    const validated = validateConfigCandidate({ ...defaults, modelRequestMaxRetries: value });
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.config.modelRequestMaxRetries).toBe(value);
  }
  for (const value of [6, 10, 101, 1.5, -1, "25", {}, [], NaN, Infinity]) {
    expect(validateConfigCandidate({ ...defaults, modelRequestMaxRetries: value }).ok).toBe(false);
  }
});

test("model-request retry budget malformed disk value degrades to the default without losing providers", () => {
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
    // config survives: the pipeline then resolves the absent value to the default 3.
    expect(loaded.modelRequestMaxRetries).toBeUndefined();
    expect(loaded.defaultProvider).toBe("openai");
    expect(loaded.providers.openai).toBeDefined();
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    toTrash(home);
  }
});

test("model-request retry budget legacy on-disk 10 degrades to absent and resolves to 3", () => {
  const home = mkdtempSync("/data/tmp/ocx-mrr-config-");
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const config = getDefaultConfig();
    writeFileSync(join(home, "config.json"), JSON.stringify({
      ...config,
      modelRequestMaxRetries: 10,
      defaultProvider: "openai",
    }));
    const loaded = loadConfig();
    // The pre-ruling default 10 is out of the new range: it never survives as a number the
    // pipeline would reinterpret (no migration to 5, no silent clamp), it degrades to absent
    // and the leaf resolves the absent value to the default 3.
    expect(loaded.modelRequestMaxRetries).toBeUndefined();
    expect(loaded.defaultProvider).toBe("openai");
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    toTrash(home);
  }
});
