/**
 * End-to-end coverage for anonymous loopback management access (`loopbackManagementAuth`).
 *
 * The unit files exercise the leaf and the admission chain by construction. Only a real
 * listener proves the three things this feature lives or dies on: the peer address the gate
 * reads is the one the kernel assigned, the ingress mark is bound to the socket that received
 * the request, and a request arriving over an actual TCP connection — with the Host header an
 * attacker controls verbatim — gets the answer the contract demands. Every case here speaks
 * HTTP to a started server.
 *
 * Ports are kernel-assigned and the config home is a temp directory: nothing in this file
 * touches a deployed listener.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { findAvailablePort } from "../../src/server/ports";
import type { OcxConfig } from "../../src/types";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ADMIN_TOKEN = ["loopback", "anon", "fixture", "token"].join("-");
const previousHome = process.env.OPENCODEX_HOME;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
let testDir = "";

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "chatgpt",
    providers: {
      chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    },
    ...overrides,
  } as unknown as OcxConfig;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-loopback-anon-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (testDir && existsSync(testDir)) removeTreeWithRetry(testDir);
  testDir = "";
});

/** One raw HTTP/1.1 exchange: the Host header is written by us, byte for byte, not by fetch. */
function rawRequest(port: number, host: string, path = "/api/config", method = "GET", headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let buffer = "";
    const settle = (value: number) => { socket.destroy(); resolve(value); };
    socket.setTimeout(5_000);
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("raw request timed out")));
    socket.once("connect", () => {
      const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, "Connection: close", "Accept: application/json"];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", chunk => {
      buffer += chunk.toString("latin1");
      const match = /^HTTP\/1\.1 (\d{3})/.exec(buffer);
      if (match) settle(Number(match[1]));
    });
  });
}

function firstNonLoopbackIPv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

describe("loopback bind, flag absent (the shipped default)", () => {
  test("management reads answer as JSON with no credential, and the principal is not a session", async () => {
    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/config`);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      // A login page or an error envelope would satisfy "200", so read the payload shape.
      expect(body).toHaveProperty("providers");
      expect(body.error).toBeUndefined();
      // The GUI bootstrap path is untouched: a loopback dashboard still mints its session.
      const bootstrap = await fetch(`http://127.0.0.1:${server.port}/opencodex-session`);
      expect(bootstrap.status).toBe(200);
      expect(await bootstrap.text()).toContain('name="opencodex-session-token"');
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("a same-host caller with a stale token keeps working as the anonymous principal", async () => {
    // The migration property: token rotation on a box that now allows anonymous loopback
    // management must not break the CLI that still sends the old value.
    saveConfig(config());
    const server = startServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
        headers: { "x-opencodex-api-key": "rotated-away-token" },
      });
      expect(response.status).toBe(200);
      // The write face rides the same branch: a stale-token CLI can still change settings.
      const write = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "rotated-away-token" },
        body: JSON.stringify({ loopbackManagementAuth: false }),
      });
      expect(write.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("the authz simulate_local shape admits: Host portless 127.0.0.1, Origin stripped", async () => {
    // 235's cc binding rewrites the upstream Host to a portless `127.0.0.1` and runs
    // origin_mode=remove, i.e. exactly this wire. The point of the feature is that the token
    // injection can be dropped without breaking it.
    saveConfig(config());
    const server = startServer(0);
    try {
      expect(await rawRequest(server.port, "127.0.0.1")).toBe(200);
      expect(await rawRequest(server.port, `127.0.0.1:${server.port}`)).toBe(200);
      expect(await rawRequest(server.port, "localhost")).toBe(200);
      expect(await rawRequest(server.port, "localhost:20100")).toBe(200);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("a hostile browser Origin gets no anonymous admission, and keeps the origin gate", async () => {
    // Binding to 127.0.0.1 does not stop a web page from making the victim's browser connect
    // to 127.0.0.1, which is why the anonymous branch carries the loopback Host/Origin gate.
    // Two refusals with two different answers, and the difference is the interesting part: a
    // credential-free hostile request dies at admission with 401 (the anonymous branch denies,
    // and there is nothing else to authenticate it), while an authenticated hostile request
    // passes admission as `admin-token` and is then refused by the management origin gate with
    // 403. Both are refusals; only the second one proves the CSRF gate still runs.
    saveConfig(config());
    const server = startServer(0);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const hostileAnonymous: Array<[string, Record<string, string>]> = [
        ["cross-site Origin", { Origin: "https://evil.example" }],
        ["opaque null Origin", { Origin: "null" }],
        ["rebinding Host", { Host: "attacker.example" }],
        ["lookalike Host", { Host: "127.0.0.1.evil.example" }],
      ];
      for (const [label, headers] of hostileAnonymous) {
        const response = await fetch(`${base}/api/config`, { headers });
        expect({ label, status: response.status }).toEqual({ label, status: 401 });
      }
      expect(await rawRequest(server.port, `127.0.0.1:${server.port}`, "/api/config", "GET", { Origin: "null" })).toBe(401);
      // Authenticated, same hostile headers: admitted on the token, refused on the origin.
      for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { Host: "attacker.example" }]) {
        const response = await fetch(`${base}/api/config`, { headers: { ...headers, "x-opencodex-api-key": ADMIN_TOKEN } });
        expect({ header: Object.keys(headers)[0]!, status: response.status }).toEqual({ header: Object.keys(headers)[0]!, status: 403 });
      }
      // Control: the same request without the hostile header is admitted.
      expect((await fetch(`${base}/api/config`)).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("a consent-bound route stays refused for the anonymous principal", async () => {
    // The admission layer answers "is this a local caller"; it does not widen any route. Key
    // reveal, consent star and session logout compare the principal and must refuse anonymous
    // exactly as they refuse a bare admin token.
    saveConfig(config());
    const server = startServer(0);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const logout = await fetch(`${base}/api/session/logout`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(logout.status).toBe(403);
      const reveal = await fetch(`${base}/api/keys/reveal`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(reveal.status).toBe(403);
      const star = await fetch(`${base}/api/github/star`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(star.status).toBe(403);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("an anonymous write is admitted, and the flag closes the door behind itself", async () => {
    // The flag is the safest thing to flip from a test: it is the feature under test, and the
    // flip is observable as a status change. The asymmetry is the contract, not a defect: an
    // anonymous caller may SET the flag to true (lock), and that request is the last anonymous
    // one it can make. Reopening requires the admin token, so a caller that can only speak
    // anonymously can never unlock what it opened, and a hostile local page cannot toggle the
    // surface back open after the operator shuts it.
    saveConfig(config());
    const server = startServer(0);
    const base = `http://127.0.0.1:${server.port}`;
    const put = (body: unknown) => fetch(`${base}/api/settings`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const putAsAdmin = (body: unknown) => fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-opencodex-api-key": ADMIN_TOKEN },
      body: JSON.stringify(body),
    });
    try {
      const close = await put({ loopbackManagementAuth: true });
      // 400 here means the key is not on the settings write whitelist: anonymous then cannot
      // self-secure, and the restart-required path is the only way to set it. Fails loudly.
      expect(close.status).toBe(200);
      expect((await close.json() as Record<string, unknown>).loopbackManagementAuth).toBe(true);
      expect((await fetch(`${base}/api/config`)).status).toBe(401);

      // The lock is not cosmetic: the anonymous request that would undo it is refused.
      expect((await put({ loopbackManagementAuth: false })).status).toBe(401);
      expect((await fetch(`${base}/api/config`)).status).toBe(401);

      const reopen = await putAsAdmin({ loopbackManagementAuth: false });
      expect(reopen.status).toBe(200);
      expect((await fetch(`${base}/api/config`)).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("a non-boolean flag is a 400 and changes nothing on disk", async () => {
    saveConfig(config());
    const server = startServer(0);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      for (const value of ["yes", 1, "true", {}, null]) {
        const response = await fetch(`${base}/api/settings`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ loopbackManagementAuth: value }),
        });
        expect({ value: JSON.stringify(value), status: response.status }).toEqual({ value: JSON.stringify(value), status: 400 });
      }
      // State unchanged: still anonymous-admissible, and the persisted file has no true in it.
      expect((await fetch(`${base}/api/config`)).status).toBe(200);
      expect(loadConfig().loopbackManagementAuth ?? false).toBe(false);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);
});

describe("loopback bind, flag strictly true", () => {
  test("the management gate behaves exactly as before the feature", async () => {
    saveConfig(config({ loopbackManagementAuth: true }));
    const server = startServer(0);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const anonymous = await fetch(`${base}/api/config`);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({ error: "opencodex admin token required" });
      expect(await rawRequest(server.port, "127.0.0.1")).toBe(401);
      const wrong = await fetch(`${base}/api/config`, { headers: { "x-opencodex-api-key": "nope" } });
      expect(wrong.status).toBe(401);
      expect((await fetch(`${base}/api/config`, { headers: { "x-opencodex-api-key": ADMIN_TOKEN } })).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("an unavailable admin token stays a 503 on loopback", async () => {
    saveConfig(config({ loopbackManagementAuth: true }));
    const server = startServer(0, { managementAuthState: { available: false, reason: "injected unavailable state" } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/config`);
      expect(response.status).toBe(503);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);
});

describe("loopback bind, flag absent, admin token unavailable", () => {
  test("the local operator keeps a working console (no 503 on the anonymous path)", async () => {
    // The branch runs before the 503 on purpose: a machine whose secret store is broken must
    // stay administrable from its own loopback, which is where the recovery happens.
    saveConfig(config());
    const server = startServer(0, { managementAuthState: { available: false, reason: "injected unavailable state" } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/config`);
      expect(response.status).toBe(200);
      expect(await rawRequest(server.port, "127.0.0.1")).toBe(200);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);
});

describe("malformed flag on disk fails closed", () => {
  test("a non-boolean value loads as true, i.e. the gate stays shut", async () => {
    const cfg = config();
    saveConfig(cfg);
    const path = join(testDir, "config.json");
    const written = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
    written.loopbackManagementAuth = "yes";
    writeFileSync(path, JSON.stringify(written));
    expect(loadConfig().loopbackManagementAuth).toBe(true);
    const server = startServer(0);
    try {
      expect(await rawRequest(server.port, "127.0.0.1")).toBe(401);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);
});

describe("non-loopback bind keeps every existing contract", () => {
  // A public bind is refused at startup when it carries no data-plane credential
  // (assertServerAuthConfig, pinned in its own file). These cases are about the MANAGEMENT
  // surface, so they supply the credential the bind requires and pin nothing about it — in
  // particular they never read a token from the ambient environment.
  beforeEach(() => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "data-plane-fixture-secret";
  });

  test("a local peer on a wildcard bind is refused (peer alone is not locality)", async () => {
    saveConfig(config({ hostname: "0.0.0.0" }));
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    const server = startServer(publicPort);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      for (const headers of [
        {},
        { "x-opencodex-api-key": "nope" },
        { Host: "127.0.0.1" },
        { "x-forwarded-for": "127.0.0.1" },
      ]) {
        const response = await fetch(`${base}/api/config`, { headers });
        expect({ headers: Object.keys(headers).join(",") || "none", status: response.status })
          .toEqual({ headers: Object.keys(headers).join(",") || "none", status: 401 });
      }
      // The credential path is unchanged.
      expect((await fetch(`${base}/api/config`, { headers: { "x-opencodex-api-key": ADMIN_TOKEN } })).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("a real remote peer over a real interface stays refused with a spoofed Host", async () => {
    const address = firstNonLoopbackIPv4();
    if (!address) {
      console.warn("[loopback-anon] no non-loopback IPv4 interface; remote-peer check not run");
      return;
    }
    saveConfig(config({ hostname: "0.0.0.0" }));
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    const server = startServer(publicPort);
    try {
      // The whole point of keying on the socket: from off-box, Host 127.0.0.1 is a string.
      const response = await fetch(`http://${address}:${server.port}/api/config`, { headers: { Host: "127.0.0.1" } });
      expect(response.status).toBe(401);
      const forwarded = await fetch(`http://${address}:${server.port}/api/config`, {
        headers: { Host: "127.0.0.1", "x-forwarded-for": "127.0.0.1", forwarded: 'for="127.0.0.1"' },
      });
      expect(forwarded.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("the data-only unauthenticated loopback listener still 404s /api/* (no route growth)", async () => {
    // Two features, one socket each. The data listener's default-deny allowlist is unchanged
    // by this flag: it serves /v1 and nothing else, and the anonymous management branch must
    // not leak /api/* onto it.
    const loopbackPort = await findAvailablePort(0, "127.0.0.1");
    const publicPort = await findAvailablePort(0, "0.0.0.0", { reservedPort: loopbackPort });
    saveConfig(config({ hostname: "0.0.0.0", unauthenticatedLoopbackListener: { enabled: true, port: loopbackPort } }));
    const server = startServer(publicPort);
    try {
      for (const path of ["/api/config", "/api/settings", "/api/providers", "/healthz"]) {
        const response = await fetch(`http://127.0.0.1:${loopbackPort}${path}`);
        expect({ path, status: response.status }).toEqual({ path, status: 404 });
      }
      expect((await fetch(`http://127.0.0.1:${loopbackPort}/v1/models`)).status).toBe(200);
      // And the public listener on the same box is unchanged.
      expect((await fetch(`http://127.0.0.1:${server.port}/api/config`)).status).toBe(401);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);
});
