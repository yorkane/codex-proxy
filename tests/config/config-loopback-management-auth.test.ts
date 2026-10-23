/**
 * Configuration contract for `loopbackManagementAuth`.
 *
 * Three faces of one flag, and the interesting part is that they do not share a default:
 *
 *  - absent (the shipped state) means ANONYMOUS loopback management, so `getDefaultConfig()`
 *    writes `false` explicitly and the reader treats `undefined` the same way;
 *  - a malformed hand edit on disk means AUTH REQUIRED — `.catch(true)`, the opposite of the
 *    degrading neighbours above it. A typo in a security field must not open it, which is why
 *    this key cannot copy `codexDesktopAuthless`'s `.catch(undefined)`;
 *  - the write boundary is strict: a non-boolean is a 400 and leaves the file untouched, and
 *    `false` is a delete rather than a stored false, so the shipped shape stays "absent".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, saveConfig, validateConfigCandidate } from "../../src/config";
import { handleConfigRoutes } from "../../src/server/management/config-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

const TRASH_ROOT = "/data/.trash";
let trashSeq = 0;

/** Repository rule: nothing is deleted, it is moved to the local trash bucket. */
function toTrash(path: string): void {
  mkdirSync(TRASH_ROOT, { recursive: true });
  trashSeq += 1;
  renameSync(path, join(TRASH_ROOT, `lbma-config-${Date.now()}-${trashSeq}`));
}

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-lbma-config-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) toTrash(home);
  home = "";
});

describe("the shipped default", () => {
  test("getDefaultConfig names the key explicitly, with the anonymous value", () => {
    const config = getDefaultConfig();
    expect(Object.hasOwn(config, "loopbackManagementAuth")).toBe(true);
    expect(config.loopbackManagementAuth).toBe(false);
  });

  test("a round-trip through disk keeps the default", () => {
    saveConfig(getDefaultConfig());
    expect(loadConfig().loopbackManagementAuth).toBe(false);
  });

  test("an absent key loads as absent, and the reader treats that as anonymous", () => {
    const config = getDefaultConfig();
    delete (config as Partial<OcxConfig>).loopbackManagementAuth;
    saveConfig(config);
    const loaded = loadConfig();
    expect(loaded.loopbackManagementAuth).toBeUndefined();
    // The gate's own reading of undefined === anonymous is pinned in
    // tests/server/loopback-management-auth-admission.test.ts; the config layer must not
    // silently invent a `true` here, which would lock every default install out of its own
    // dashboard.
    expect(loaded.loopbackManagementAuth !== true).toBe(true);
  });
});

describe("a malformed hand edit fails closed", () => {
  test.each([["yes"], ["true"], [1], [0], [null], [[]], [{}], [Number.NaN]])(
    "a malformed disk value loads as true (auth required)", (value: unknown) => {
      const config = getDefaultConfig();
      saveConfig(config);
      const path = getConfigPath();
      const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      written.loopbackManagementAuth = value;
      writeFileSync(path, JSON.stringify(written));
      expect(loadConfig().loopbackManagementAuth).toBe(true);
    });

  test("the degrading value does not poison the rest of the file", () => {
    const config = getDefaultConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const path = getConfigPath();
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    written.loopbackManagementAuth = "yes";
    writeFileSync(path, JSON.stringify(written));
    const loaded = loadConfig();
    expect(loaded.loopbackManagementAuth).toBe(true);
    expect(loaded.providers).toEqual(config.providers);
    expect(loaded.hostname).toBe("127.0.0.1");
  });

  test("a valid boolean hand edit survives the parse", () => {
    for (const value of [true, false]) {
      const config = getDefaultConfig();
      saveConfig(config);
      const path = getConfigPath();
      const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      written.loopbackManagementAuth = value;
      writeFileSync(path, JSON.stringify(written));
      expect(loadConfig().loopbackManagementAuth).toBe(value);
    }
  });
});

describe("the candidate write boundary is strict", () => {
  test("a boolean candidate is accepted", () => {
    for (const value of [true, false]) {
      const result = validateConfigCandidate({ ...getDefaultConfig(), loopbackManagementAuth: value });
      expect(result.ok).toBe(true);
    }
  });

  test("a non-boolean candidate is rejected, not degraded", () => {
    // `.catch(true)` is the load path for a file the operator already broke. A write — API,
    // CLI, import — must refuse the same value, so the strict schema never has to fire on
    // something the proxy itself produced.
    for (const value of ["yes", "true", 1, 0, null, [], {}]) {
      const result = validateConfigCandidate({ ...getDefaultConfig(), loopbackManagementAuth: value });
      expect({ value: JSON.stringify(value), ok: result.ok }).toEqual({ value: JSON.stringify(value), ok: false });
    }
  });
});

describe("PUT /api/settings", () => {
  function harness() {
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
        deps: { saveConfigPreservingClaudeCode: (_c: OcxConfig) => { saves++; } },
      } as unknown as ManagementContext);
    };
    return { config, call, saves: () => saves };
  }

  test("the key is on the settings surface, readable and writable", async () => {
    const h = harness();
    const read = await (await h.call())!.json() as Record<string, unknown>;
    expect(read.loopbackManagementAuth).toBe(false);

    const closed = await (await h.call({ loopbackManagementAuth: true }))!.json() as Record<string, unknown>;
    expect(closed.loopbackManagementAuth).toBe(true);
    expect(h.config.loopbackManagementAuth).toBe(true);
    expect(h.saves()).toBe(1);
  });

  test("false clears the key rather than storing a false, and the read is identical", async () => {
    const h = harness();
    await (await h.call({ loopbackManagementAuth: true }))!.json();
    expect(h.config.loopbackManagementAuth).toBe(true);
    const reopened = await (await h.call({ loopbackManagementAuth: false }))!.json() as Record<string, unknown>;
    expect(reopened.loopbackManagementAuth).toBe(false);
    expect(Object.hasOwn(h.config, "loopbackManagementAuth")).toBe(false);
  });

  test("a non-boolean is a 400 and changes nothing", async () => {
    for (const value of ["yes", "true", 1, 0, {}, [], null]) {
      const h = harness();
      const response = await h.call({ loopbackManagementAuth: value });
      expect({ value: JSON.stringify(value), status: response!.status }).toEqual({ value: JSON.stringify(value), status: 400 });
      expect(await response!.json()).toEqual({ error: "loopbackManagementAuth boolean is required" });
      expect(h.config.loopbackManagementAuth).toBe(false);
      expect(h.saves()).toBe(0);
    }
  });

  test("the key alone is a sufficient settings body, and the hint names it", async () => {
    const h = harness();
    const empty = await h.call({});
    expect(empty!.status).toBe(400);
    expect(await empty!.json()).toMatchObject({
      error: expect.stringContaining("loopbackManagementAuth"),
    });
  });

  test("a PUT for another setting preserves the persisted flag", async () => {
    const h = harness();
    await (await h.call({ loopbackManagementAuth: true }))!.json();
    expect(h.saves()).toBe(1);
    const response = await h.call({ streamMode: "eager-relay" });
    expect(response!.status).toBe(200);
    expect(h.config.loopbackManagementAuth).toBe(true);
  });

  test("a failed save rolls the flag back, including a cleared key", async () => {
    // The route rethrows a persistence failure (the caller must see it), so every call here is
    // wrapped; the assertion is about the in-memory config after the throw, which is the part
    // a rollback can get wrong.
    const config = getDefaultConfig();
    const call = async (body: Record<string, unknown>) => handleConfigRoutes({
      url: new URL("http://localhost/api/settings"),
      req: new Request("http://localhost/api/settings", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }),
      config,
      version: "test",
      deps: { saveConfigPreservingClaudeCode: () => { throw new Error("fixture-save-failed"); } },
    } as unknown as ManagementContext);
    const attempt = async (body: Record<string, unknown>) => {
      try {
        return await call(body);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        return null;
      }
    };

    // The seed state: a persisted `true`, which only a successful save may produce.
    saveConfig({ ...getDefaultConfig(), loopbackManagementAuth: true });
    Object.assign(config, loadConfig());
    expect(config.loopbackManagementAuth).toBe(true);

    // A redundant close that fails to persist leaves the flag true — it was true before.
    expect(await attempt({ loopbackManagementAuth: true })).toBeNull();
    expect(config.loopbackManagementAuth).toBe(true);

    // The clear path: the mutation deletes the key, the save then throws, and the tombstone
    // must be withdrawn with it — a leaked deletion intent would drop the key on the next
    // unrelated save, silently reopening the surface on a machine that asked for auth.
    expect(await attempt({ loopbackManagementAuth: false })).toBeNull();
    expect(config.loopbackManagementAuth).toBe(true);
    expect(Object.hasOwn(config, "loopbackManagementAuth")).toBe(true);

    // A save that fails for an unrelated reason rolls the flag back the same way: the key is
    // restored to its captured value, not left as the mutation's `true`.
    expect(await attempt({ loopbackManagementAuth: true, streamMode: "eager-relay" })).toBeNull();
    expect(config.loopbackManagementAuth).toBe(true);
  });
});
