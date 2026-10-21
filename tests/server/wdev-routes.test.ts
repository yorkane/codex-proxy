/**
 * Route-level tests for the fork's /api/wdev/* management surface (opt-in).
 *
 * The manager is a real process: tests/fixtures/wdev-manager-fake.py implements the
 * contract and steers failure modes through FAKE_WDEV_MODE. Everything runs in a temp
 * manager root; nothing here touches a real ~/wdev, spawns npm, or restarts a service.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { resolveWdevManagerRuntime, WDEV_MANAGER_ENV } from "../../src/wdev/activation";
import type { OcxConfig } from "../../src/types";
import { repoPath } from "../helpers/repo-root";

const ENABLED = { wdevManager: { enabled: true, brand: "wdev-proxy" } } as Partial<OcxConfig>;
const DISABLED = {} as Partial<OcxConfig>;
const baseConfig = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;

let root: string;
let managerRoot: string;
let envBackup: Record<string, string | undefined>;

async function call(method: string, pathname: string, body?: unknown, override: Partial<OcxConfig> = ENABLED) {
  const url = new URL(`http://127.0.0.1:10100${pathname}`);
  const req = new Request(url, {
    method,
    headers: { host: "127.0.0.1:10100", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await handleManagementAPI(req, url, { ...baseConfig, ...override } as OcxConfig, {}, "admin-token");
  return { status: res?.status ?? 0, body: res ? await res.json().catch(() => null) : null, routed: res !== null };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-wdev-routes-"));
  managerRoot = join(root, "wdev");
  mkdirSync(join(managerRoot, "manager"), { recursive: true });
  mkdirSync(join(managerRoot, "manifests"), { recursive: true });
  mkdirSync(join(managerRoot, "state"), { recursive: true });
  copyFileSync(repoPath("tests", "fixtures", "wdev-manager-fake.py"), join(managerRoot, "manager", "wdev.py"));
  chmodSync(join(managerRoot, "manager", "wdev.py"), 0o755);
  writeFileSync(join(managerRoot, "manifests", "wdev-2026.10.18.manifest.json"), "{\"version\":\"2026.10.18\"}");
  envBackup = {};
  for (const key of Object.values(WDEV_MANAGER_ENV)) {
    envBackup[key] = process.env[key];
    delete process.env[key];
  }
  process.env[WDEV_MANAGER_ENV.home] = managerRoot;
  process.env[WDEV_MANAGER_ENV.deployHome] = root;
  process.env[WDEV_MANAGER_ENV.maintenanceFile] = join(managerRoot, "state", "maintenance-llm-proxy.json");
  // The fake CLI mirrors the durable-write contract onto a real file; keep it in the
  // temp tree so a test run never dirties the fixture directory.
  process.env.FAKE_WDEV_LEDGER = join(root, "fake-ledger.jsonl");
});

afterAll(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function withMode<T>(mode: string | null, run: () => Promise<T>): Promise<T> {
  const backup = process.env.FAKE_WDEV_MODE;
  if (mode === null) delete process.env.FAKE_WDEV_MODE;
  else process.env.FAKE_WDEV_MODE = mode;
  return run().finally(() => {
    if (backup === undefined) delete process.env.FAKE_WDEV_MODE;
    else process.env.FAKE_WDEV_MODE = backup;
  });
}

describe("wdev routes: gates", () => {
  test("the config block round-trips through the zod schema (no silent strip)", async () => {
    const { configSchema } = await import("../../src/config/schema/config-schema");
    const parsed = configSchema.parse({
      providers: { xai: { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1" } },
      defaultProvider: "xai",
      wdevManager: { enabled: true, brand: "wdev-proxy" },
    }) as { wdevManager?: { enabled?: boolean; brand?: string } };
    expect(parsed.wdevManager).toEqual({ enabled: true, brand: "wdev-proxy" });
  });

  test("a malformed wdevManager block degrades to disabled, never rejects the config", async () => {
    const { configSchema } = await import("../../src/config/schema/config-schema");
    const parsed = configSchema.parse({
      providers: { xai: { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1" } },
      defaultProvider: "xai",
      wdevManager: { enabled: "yes please", brand: 42 },
    }) as { wdevManager?: unknown; providers?: unknown };
    expect(parsed.wdevManager).toBeUndefined();
    expect(parsed.providers).toBeDefined();
  });

  test("disabled config answers 404 wdev_disabled for the whole namespace", async () => {
    for (const path of ["/api/wdev/components", "/api/wdev/operations"]) {
      const res = await call("GET", path, undefined, DISABLED);
      expect(res.status).toBe(404);
      expect((res.body as { code?: string }).code).toBe("wdev_disabled");
    }
    const post = await call("POST", "/api/wdev/operations", {
      componentId: "web", action: "restart", idempotencyKey: "key-00000001",
    }, DISABLED);
    expect(post.status).toBe(404);
    expect((post.body as { code?: string }).code).toBe("wdev_disabled");
  });

  test("enabled config with an incomplete deploy env answers 404 wdev_env_missing", async () => {
    const backup = process.env[WDEV_MANAGER_ENV.home];
    delete process.env[WDEV_MANAGER_ENV.home];
    try {
      const res = await call("GET", "/api/wdev/components");
      expect(res.status).toBe(404);
      expect((res.body as { code?: string }).code).toBe("wdev_env_missing");
    } finally {
      if (backup !== undefined) process.env[WDEV_MANAGER_ENV.home] = backup;
    }
  });

  test("the dispatcher never routes an unrelated path into wdev", async () => {
    const res = await call("GET", "/api/wdevx/components");
    expect(res.routed).toBe(false);
  });
});

describe("wdev routes: components", () => {
  test("GET components projects the manager inventory and the brand", async () => {
    const res = await withMode(null, () => call("GET", "/api/wdev/components"));
    expect(res.status).toBe(200);
    const body = res.body as {
      enabled: boolean; brand: string;
      components: Array<Record<string, unknown>>;
      manifests: Array<Record<string, unknown>>;
    };
    expect(body.enabled).toBe(true);
    expect(body.brand).toBe("wdev-proxy");
    expect(body.components.map(c => c.id)).toEqual(["web", "llm-proxy"]);
    expect(body.components[0]).toMatchObject({ unit: "wdev.service", status: "ok" });
    // The projection is allowlisted: an extra manager field never rides along.
    expect(body.components[0].secret).toBeUndefined();
    expect(body.manifests.map(m => m.path)).toContain("wdev-2026.10.18.manifest.json");
  });

  test("manager stdout that is not JSON becomes 502 manager_bad_json, never a crash", async () => {
    const res = await withMode("badjson", () => call("GET", "/api/wdev/components"));
    expect(res.status).toBe(502);
    expect((res.body as { code?: string }).code).toBe("manager_bad_json");
  });

  test("oversized manager stdout is refused, not buffered into the response", async () => {
    const res = await withMode("huge", () => call("GET", "/api/wdev/components"));
    expect(res.status).toBe(502);
    expect((res.body as { code?: string }).code).toBe("manager_output_too_large");
  });

  test("manager failure is a sanitized 502: the code survives, the stderr never leaks", async () => {
    const res = await withMode("fail2", () => call("GET", "/api/wdev/components"));
    expect(res.status).toBe(502);
    expect((res.body as { code?: string }).code).toBe("manager_exit");
    expect(JSON.stringify(res.body)).not.toContain("SUPERSECRET");
  });
});

describe("wdev routes: operations", () => {
  test("POST restart returns 202 with the manager operationId and is listed", async () => {
    process.env.FAKE_WDEV_OP_ID = "11111111-2222-4333-8444-555555555555";
    const res = await withMode(null, () => call("POST", "/api/wdev/operations", {
      componentId: "web", action: "restart", idempotencyKey: "opkey-restart-1",
    }));
    delete process.env.FAKE_WDEV_OP_ID;
    expect(res.status).toBe(202);
    const body = res.body as Record<string, unknown>;
    expect(body).toMatchObject({
      operationId: "11111111-2222-4333-8444-555555555555",
      state: "queued", componentId: "web", action: "restart",
    });
    const list = await call("GET", "/api/wdev/operations");
    expect((list.body as { operations: Array<Record<string, unknown>> }).operations[0])
      .toMatchObject({ operationId: "11111111-2222-4333-8444-555555555555", action: "restart" });
  });

  test("GET operation/:id is the authoritative ledger record", async () => {
    const res = await withMode(null, () => call("GET", "/api/wdev/operations/11111111-2222-4333-8444-555555555555"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      operationId: "11111111-2222-4333-8444-555555555555",
      state: "succeeded", newRevision: 8,
    });
  });

  test("a non-uuid operation id never reaches the CLI as an argument", async () => {
    // The route matcher is anchored on a 36-char uuid character class, so an encoded
    // traversal, a bare word, and a shell-metacharacter tail all fall through to the
    // namespace terminal 404. None of them can become an `operation <arg>` argv token:
    // the value is only ever matched, never interpolated.
    for (const path of [
      "/api/wdev/operations/..%2F..%2Fetc%2Fpasswd",
      "/api/wdev/operations/not-a-uuid",
      "/api/wdev/operations/11111111-2222-4333-8444-555555555551;rm",
    ]) {
      const res = await call("GET", path);
      expect([path, res.status]).toEqual([path, 404]);
      expect([path, (res.body as { code?: string }).code]).toEqual([path, "wdev_route_not_found"]);
    }
  });

  test("whitelist: unknown fields, bad enums, and path overrides are all 400", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["shell field", { componentId: "web", action: "restart", idempotencyKey: "wl-key-0001", shell: "/bin/sh" }],
      ["unit field", { componentId: "web", action: "restart", idempotencyKey: "wl-key-0002", unit: "evil.service" }],
      ["exe field", { componentId: "web", action: "restart", idempotencyKey: "wl-key-0003", exe: "/bin/rm" }],
      ["bad component", { componentId: "gpu", action: "restart", idempotencyKey: "wl-key-0004" }],
      ["bad action", { componentId: "web", action: "stop", idempotencyKey: "wl-key-0005" }],
      ["short key", { componentId: "web", action: "restart", idempotencyKey: "ab" }],
      ["maxWait range", { componentId: "web", action: "restart", idempotencyKey: "wl-key-0006", maxWait: 9999 }],
      ["absolute manifestPath", { componentId: "web", action: "upgrade", manifestPath: "/etc/passwd", idempotencyKey: "wl-key-0007" }],
      ["escaping manifestPath", { componentId: "web", action: "upgrade", manifestPath: "../../secret.manifest.json", idempotencyKey: "wl-key-0008" }],
      ["missing manifest", { componentId: "web", action: "upgrade", idempotencyKey: "wl-key-0009" }],
      ["restart with payload", { componentId: "web", action: "restart", configPatch: { a: 1 }, idempotencyKey: "wl-key-0010" }],
      ["configPatch non-object", { componentId: "web", action: "configure", configPatch: "x", idempotencyKey: "wl-key-0011" }],
      // The manager's own sanitize rules, enforced at the route boundary: configure
      // requires a configPatch and expectedRevision is a non-negative integer.
      ["configure without patch", { componentId: "web", action: "configure", idempotencyKey: "wl-key-0012" }],
      ["expectedRevision negative", { componentId: "web", action: "upgrade", manifestPath: "wdev-2026.10.18.manifest.json", expectedRevision: -1, idempotencyKey: "wl-key-0013" }],
      ["expectedRevision non-integer string", { componentId: "web", action: "upgrade", manifestPath: "wdev-2026.10.18.manifest.json", expectedRevision: "1.5", idempotencyKey: "wl-key-0014" }],
    ];
    for (const [label, body] of cases) {
      const res = await withMode(null, () => call("POST", "/api/wdev/operations", body));
      expect([res.status, label]).toEqual([400, label]);
    }
  });

  test("the manifestPath whitelist resolves a name to a trusted realpath and rejects every escape", async () => {
    process.env.FAKE_WDEV_OP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
    const res = await withMode(null, () => call("POST", "/api/wdev/operations", {
      componentId: "web", action: "upgrade",
      manifestPath: "wdev-2026.10.18.manifest.json",
      expectedRevision: 7, maxWait: 30, idempotencyKey: "opkey-upgrade-1",
    }));
    delete process.env.FAKE_WDEV_OP_ID;
    expect(res.status).toBe(202);
    const { resolveTrustedManifestPath } = await import("../../src/server/management/wdev-routes");
    const manifestsRoot = join(managerRoot, "manifests");
    expect(resolveTrustedManifestPath(manifestsRoot, "wdev-2026.10.18.manifest.json"))
      .toBe(join(manifestsRoot, "wdev-2026.10.18.manifest.json"));
    // A request value is a NAME. The route computes the realpath; no traversal form,
    // absolute form, NUL, or missing-file form survives into --request-json.
    for (const evil of ["../../etc/passwd", "/etc/passwd", "../manifests2/x", "", "a\u0000b", "missing.manifest.json"]) {
      expect(resolveTrustedManifestPath(manifestsRoot, evil)).toBeNull();
    }
  });

  test("argv carries --dispatch by default; the env spelling drops it for old parsers", async () => {
    // The real manager parser accepts the explicit --dispatch spelling (submit
    // dispatches by default, --no-dispatch is the queue-only opt-out), so the proxy
    // sends the flag and the strict fake accepts it: default submit is 202.
    // FAKE_WDEV_MODE=no_dispatch_flag simulates a parser build predating the flag:
    // the default argv then fails with manager_exit 502, which is the proof the flag
    // is present by default; WDEV_MANAGER_SUBMIT_DISPATCH=0 removes it and recovers.
    process.env.FAKE_WDEV_OP_ID = "cccccccc-0000-4000-8000-000000000004";
    const dispatchBackup = process.env.WDEV_MANAGER_SUBMIT_DISPATCH;
    try {
      const defaultSubmit = await withMode(null, () => call("POST", "/api/wdev/operations", {
        componentId: "web", action: "restart", idempotencyKey: "opkey-dispatch-1",
      }));
      expect(defaultSubmit.status).toBe(202);
      const oldParser = await withMode("no_dispatch_flag", () => call("POST", "/api/wdev/operations", {
        componentId: "web", action: "restart", idempotencyKey: "opkey-dispatch-2",
      }));
      expect(oldParser.status).toBe(502);
      expect((oldParser.body as { code?: string }).code).toBe("manager_exit");
      process.env.WDEV_MANAGER_SUBMIT_DISPATCH = "0";
      const oldParserOptOut = await withMode("no_dispatch_flag", () => call("POST", "/api/wdev/operations", {
        componentId: "web", action: "restart", idempotencyKey: "opkey-dispatch-3",
      }));
      expect(oldParserOptOut.status).toBe(202);
    } finally {
      if (dispatchBackup === undefined) delete process.env.WDEV_MANAGER_SUBMIT_DISPATCH;
      else process.env.WDEV_MANAGER_SUBMIT_DISPATCH = dispatchBackup;
    }
    delete process.env.FAKE_WDEV_OP_ID;
  });

  test("a rebound idempotencyKey is 409 BEFORE the manager runs (zero enqueue)", async () => {
    const ledgerFile = join(root, "fake-ledger.jsonl");
    const ledgerLines = () => { try { return readFileSync(ledgerFile, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
    process.env.FAKE_WDEV_OP_ID = "aaaaaaaa-0000-4000-8000-000000000002";
    const first = await withMode(null, () => call("POST", "/api/wdev/operations", {
      componentId: "web", action: "restart", idempotencyKey: "opkey-conflict-1",
    }));
    expect(first.status).toBe(202);
    const linesAfterFirst = ledgerLines();
    delete process.env.FAKE_WDEV_OP_ID;
    process.env.FAKE_WDEV_OP_ID = "bbbbbbbb-0000-4000-8000-000000000003";
    // Same key, DIFFERENT request (maxWait moved): the ledger dedup cannot save a
    // key-bound-to-another-request, so this must be the conflict case.
    const second = await withMode(null, () => call("POST", "/api/wdev/operations", {
      componentId: "web", action: "restart", idempotencyKey: "opkey-conflict-1", maxWait: 45,
    }));
    delete process.env.FAKE_WDEV_OP_ID;
    expect(second.status).toBe(409);
    expect((second.body as { code?: string }).code).toBe("wdev_idempotency_conflict");
    // The conflict gate runs BEFORE the CLI: the fake's durable ledger gained no line,
    // so a refused bind has zero enqueue side effect (no 202-granted-then-409ed window).
    expect(ledgerLines()).toBe(linesAfterFirst);
  });

  test("an identical re-POST under a bound key replays the operation without a second submit", async () => {
    const ledgerFile = join(root, "fake-ledger.jsonl");
    const ledgerLines = () => { try { return readFileSync(ledgerFile, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
    process.env.FAKE_WDEV_OP_ID = "dddddddd-0000-4000-8000-000000000005";
    const body = { componentId: "web", action: "restart" as const, idempotencyKey: "opkey-replay-1", maxWait: 30 };
    const first = await withMode(null, () => call("POST", "/api/wdev/operations", body));
    expect(first.status).toBe(202);
    delete process.env.FAKE_WDEV_OP_ID;
    const linesAfterFirst = ledgerLines();
    const retry = await withMode(null, () => call("POST", "/api/wdev/operations", body));
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({
      operationId: "dddddddd-0000-4000-8000-000000000005",
      replayed: true,
    });
    // Replay must not reach the manager: no second durable ledger write.
    expect(ledgerLines()).toBe(linesAfterFirst);
  });
});

describe("wdev routes: trust", () => {
  test("WDEV_MANAGER_PYTHON cannot be a bare command name (no PATH lookup)", () => {
    const backup = process.env[WDEV_MANAGER_ENV.python];
    process.env[WDEV_MANAGER_ENV.python] = "python3";
    try {
      expect(resolveWdevManagerRuntime()).toBeNull();
    } finally {
      if (backup === undefined) delete process.env[WDEV_MANAGER_ENV.python];
      else process.env[WDEV_MANAGER_ENV.python] = backup;
    }
  });

  test("a manager CLI entry symlinked outside the root is a trust rejection", async () => {
    const { rmSync: rm, symlinkSync } = await import("node:fs");
    const cli = join(managerRoot, "manager", "wdev.py");
    const real = join(root, "real-manager.py");
    copyFileSync(cli, real);
    rm(cli);
    symlinkSync(real, cli);
    try {
      const res = await withMode(null, () => call("GET", "/api/wdev/components"));
      expect(res.status).toBe(500);
      expect((res.body as { code?: string }).code).toBe("manager_trust_rejected");
    } finally {
      rm(cli);
      copyFileSync(real, cli);
    }
  });

  test("the slow manager hits the CLI timeout and 504s (no hung request)", async () => {
    const timeoutBackup = process.env.WDEV_MANAGER_TIMEOUT_MS;
    process.env.WDEV_MANAGER_TIMEOUT_MS = "500";
    const started = Date.now();
    try {
      const res = await withMode("slow", () => call("GET", "/api/wdev/components"));
      expect(res.status).toBe(504);
      expect((res.body as { code?: string }).code).toBe("manager_timeout");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      if (timeoutBackup === undefined) delete process.env.WDEV_MANAGER_TIMEOUT_MS;
      else process.env.WDEV_MANAGER_TIMEOUT_MS = timeoutBackup;
    }
  }, 15_000);
});
