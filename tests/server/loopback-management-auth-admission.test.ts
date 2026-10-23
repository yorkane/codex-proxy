/**
 * Admission-chain contract for the loopback anonymous management principal.
 *
 * The predicate file tests the leaf. This file tests where the leaf sits in
 * `resolveManagementAdmission`, because placement is where the contract can silently break:
 *
 *  - after the capability family and the credential family, so a request that carries real
 *    authority is attributed to that authority and never downgraded to anonymous (a
 *    session-only route keys on the principal, so a downgrade would 403 a legitimate caller);
 *  - before the 503 that `requireManagementAuth` returns when the admin token could not be
 *    initialized, so a machine whose secret store is broken still serves its own dashboard
 *    (the operator is logged in locally; refusing them is refusing the operator);
 *  - with no fallback the other way, so `loopbackManagementAuth: true` plus a wrong token is
 *    the 401 it has always been.
 *
 * The `local` context is what the listener builds per request (serve-options.ts): the kernel
 * peer plus the ingress mark. Tests pass it directly, which is the same shape the gate reads.
 */
import { describe, expect, test } from "bun:test";
import { opencodeCatalogToken } from "../../src/lib/admin-secrets";
import {
  initializeManagementAuthState,
  createManagementSessionControl,
  managementPrincipal,
  requireManagementAuth,
  type LocalManagementAuthContext,
  type ManagementAuthState,
} from "../../src/server/management-auth";
import type { OcxConfig } from "../../src/types";

const ADMIN_TOKEN = "admission-chain-admin-token";
const PORT = 10100;

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: PORT,
    hostname: "127.0.0.1",
    defaultProvider: "test",
    providers: {},
    ...overrides,
  } as unknown as OcxConfig;
}

function availableState(): ManagementAuthState {
  return { available: true, token: ADMIN_TOKEN, source: "environment", sessions: new Map(), pairingGrants: new Map() };
}

function unavailableState(): ManagementAuthState {
  return { available: false, reason: "injected unavailable state" };
}

function local(overrides: Partial<LocalManagementAuthContext> = {}): LocalManagementAuthContext {
  return {
    attestationSecret: "A".repeat(43),
    pid: process.pid,
    port: PORT,
    peerAddress: "127.0.0.1",
    trustedLoopbackIngress: true,
    ...overrides,
  } as LocalManagementAuthContext;
}

function request(method: "GET" | "POST" | "PUT", headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:${PORT}/api/config`, {
    method,
    headers: { Host: `127.0.0.1:${PORT}`, ...headers },
  });
}

/** The gate's answer: null means admitted. */
function admitted(req: Request, cfg: OcxConfig, state: ManagementAuthState, ctx: LocalManagementAuthContext): number | null {
  return requireManagementAuth(req, state, cfg, ctx)?.status ?? null;
}

/**
 * The principal, read in this file's (request, config, state) order. `managementPrincipal`
 * takes the state before the config, and the gate caches its answer per Request object, so a
 * call with the arguments transposed is not a type error — the state arrives where a config is
 * expected, the leaf then sees no flag and no bind, and a cached admission from the paired
 * `admitted()` call answers for it. Wrapping once keeps every call site honest.
 */
function principalOf(req: Request, cfg: OcxConfig, state: ManagementAuthState, ctx: LocalManagementAuthContext) {
  return managementPrincipal(req, state, cfg, ctx);
}

describe("anonymous loopback admission, via the public gate", () => {
  test("the shipped default admits a local read and a local write with no credential", () => {
    const cfg = config();
    const state = availableState();
    expect(admitted(request("GET"), cfg, state, local())).toBeNull();
    expect(admitted(request("PUT", { "content-type": "application/json" }), cfg, state, local())).toBeNull();
    expect(principalOf(request("GET"), cfg, state, local())).toBe("loopback-anonymous");
  });

  test("explicit false is the same answer as the default; explicit true restores the 401", () => {
    const state = availableState();
    expect(admitted(request("GET"), config({ loopbackManagementAuth: false }), state, local())).toBeNull();
    expect(admitted(request("GET"), config({ loopbackManagementAuth: true }), state, local())).toBe(401);
    expect(principalOf(request("GET"), config({ loopbackManagementAuth: true }), state, local())).toBeNull();
  });

  test("a malformed on-disk flag reaches the gate as true, i.e. closed", () => {
    // loadConfig's `.catch(true)` is what produces this shape; the gate must read it as the
    // strict setting rather than as "not true, so anonymous".
    const cfg = config({ loopbackManagementAuth: true });
    expect(admitted(request("GET"), cfg, availableState(), local())).toBe(401);
  });

  test("the principal is loopback-anonymous and impersonates nothing", () => {
    // Every consent- and session-bound route compares the principal to a specific string, so
    // the value doubles as authorization. It must not be any of the names those routes accept.
    const principal = principalOf(request("PUT", { "content-type": "application/json" }), config(), availableState(), local());
    expect(principal).toBe("loopback-anonymous");
    for (const privileged of ["gui-session", "admin-token", "local-read-capability", "gui-pair-capability"]) {
      expect(principal).not.toBe(privileged);
    }
  });

  test("unavailable token state does not disable the local anonymous path", () => {
    // The whole point of putting the branch above the 503: a machine that cannot initialize its
    // admin token must stay operable from its own console, and flag=true must still 503.
    expect(admitted(request("GET"), config(), unavailableState(), local())).toBeNull();
    expect(principalOf(request("GET"), config(), unavailableState(), local())).toBe("loopback-anonymous");
    expect(admitted(request("GET"), config({ loopbackManagementAuth: true }), unavailableState(), local())).toBe(503);
  });
});

describe("a wrong credential never opens the anonymous door, and the anonymous door never opens a remote one", () => {
  test("a wrong token on the default config is admitted as the anonymous principal", () => {
    // The caller is local and the surface is anonymous, so a stale token is not evidence of an
    // attacker: the answer must be the anonymous principal, not 401. This is the migration
    // property — a client configured with a token that has since rotated keeps working.
    const cfg = config();
    const req = request("GET", { "x-opencodex-api-key": "stale-rotated-token" });
    expect(admitted(req, cfg, availableState(), local())).toBeNull();
    expect(principalOf(req, cfg, availableState(), local())).toBe("loopback-anonymous");
  });

  test("a wrong token with the flag strictly true is the historical 401", () => {
    const cfg = config({ loopbackManagementAuth: true });
    for (const headers of [{ "x-opencodex-api-key": "stale-rotated-token" }, { authorization: "Bearer nope" }, { "x-opencodex-api-key": "" }]) {
      const req = request("GET", headers);
      expect(admitted(req, cfg, availableState(), local())).toBe(401);
      expect(principalOf(req, cfg, availableState(), local())).toBeNull();
    }
  });

  test("a remote peer is refused on the default flag, with and without a forged Host", () => {
    for (const headers of [
      { Host: "127.0.0.1:10100" },
      { Host: "localhost:10100" },
      { Host: "127.0.0.1:10100", "x-forwarded-for": "127.0.0.1" },
      { Host: "127.0.0.1:10100", forwarded: 'for="127.0.0.1"' },
    ]) {
      const req = request("GET", headers);
      expect(admitted(req, config(), availableState(), local({ peerAddress: "10.0.0.9" }))).toBe(401);
      expect(admitted(req, config(), unavailableState(), local({ peerAddress: "10.0.0.9" }))).toBe(503);
    }
  });

  test("a public listener carrying the same request is refused", () => {
    // ingress is the listener's identity, not the request's. Peer 127.0.0.1 on a socket bound
    // to 0.0.0.0 is a Docker port mapping.
    const cfg = config({ hostname: "0.0.0.0" });
    expect(admitted(request("GET"), cfg, availableState(), local({ trustedLoopbackIngress: false }))).toBe(401);
    expect(admitted(request("GET"), cfg, availableState(), local({ peerAddress: null }))).toBe(401);
    expect(admitted(request("GET"), cfg, unavailableState(), { attestationSecret: "A".repeat(43), pid: process.pid, port: PORT } as LocalManagementAuthContext)).toBe(503);
  });

  test("the flag being false does not make a remote bind anonymous", () => {
    const cfg = config({ hostname: "0.0.0.0", loopbackManagementAuth: false });
    expect(admitted(request("GET"), cfg, availableState(), local({ trustedLoopbackIngress: false }))).toBe(401);
  });
});

describe("credential precedence over the anonymous principal", () => {
  test("a valid admin token on a trusted loopback request is attributed to the token", () => {
    // Order matters: the admin token is the operator's own credential and carries admin-only
    // routes the anonymous principal is refused. Attributing it to anonymous would silently
    // 403 the CLI, which is the exact regression shape this branch could cause.
    const req = request("GET", { "x-opencodex-api-key": ADMIN_TOKEN });
    expect(admitted(req, config(), availableState(), local())).toBeNull();
    expect(principalOf(req, config(), availableState(), local())).toBe("admin-token");
  });

  test("a bearer admin token is attributed to the token too", () => {
    const req = request("PUT", { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" });
    expect(principalOf(req, config(), availableState(), local())).toBe("admin-token");
  });

  test("the catalog token still resolves for GET /api/models", () => {
    const req = new Request(`http://127.0.0.1:${PORT}/api/models`, { headers: { Host: `127.0.0.1:${PORT}` } });
    req.headers.set("x-opencodex-api-key", opencodeCatalogToken(ADMIN_TOKEN));
    expect(principalOf(req, config(), availableState(), local())).toBe("opencode-catalog-token");
  });

  test("a valid loopback GUI session keeps its session principal", () => {
    // Session-only routes (key reveal, consent star, pairing) refuse everything but
    // gui-session. If the anonymous branch ran first, those routes would 403 for the
    // dashboard that is allowed to use them.
    const state = availableState();
    const origin = `http://127.0.0.1:${PORT}`;
    const sessionToken = "ocx_session_loopback_anon_test";
    state.sessions.set(sessionToken, {
      serverOrigin: origin,
      browserOrigin: origin,
      csrfToken: "csrf-loopback-anon",
      expiresAt: Date.now() + 60_000,
      issuance: "loopback",
    });
    const req = request("POST", { Origin: origin, "x-opencodex-api-key": sessionToken, "x-opencodex-gui-origin": origin, "x-opencodex-csrf-token": "csrf-loopback-anon" });
    expect(admitted(req, config(), state, local())).toBeNull();
    expect(principalOf(req, config(), state, local())).toBe("gui-session");
  });
});

describe("the gate's own answers stay shaped as before", () => {
  test("401 keeps the historical envelope on a loopback bind with the flag true", async () => {
    const response = requireManagementAuth(request("GET"), availableState(), config({ loopbackManagementAuth: true }), local());
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: "opencodex admin token required" });
  });

  test("503 keeps its envelope for an unavailable state with the flag true", async () => {
    const response = requireManagementAuth(request("GET"), unavailableState(), config({ loopbackManagementAuth: true }), local());
    expect(response?.status).toBe(503);
    expect(Object.keys((await response?.json()) as Record<string, unknown>).sort()).toEqual(["error", "hint", "reason"]);
  });

  test("the real initializer feeds the same path (no hand-built state)", () => {
    const home = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = `/tmp/ocx-lb-anon-${process.pid}`;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
    try {
      const state = initializeManagementAuthState(config());
      expect(state.available).toBe(true);
      expect(admitted(request("GET"), config(), state, local())).toBeNull();
      expect(principalOf(request("GET"), config(), state, local())).toBe("loopback-anonymous");
    } finally {
      delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
      if (home === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = home;
    }
  });
});

describe("SSE revalidation (isCurrent) for the anonymous loopback principal", () => {
  function admittedAnon(cfg: OcxConfig, state: ManagementAuthState, ctx: LocalManagementAuthContext): Request {
    const req = request("GET");
    expect(admitted(req, cfg, state, ctx)).toBeNull();
    return req;
  }

  test("an admitted anonymous request is current and impersonates no session authority", () => {
    // The live SSE stream revalidates through this call, so the anonymous admission must
    // answer "current" with no credential to re-check — while the session-only answers
    // (pairing provenance, key reveal) stay refused, exactly as the gate's principal check.
    const cfg = config();
    const state = availableState();
    const req = admittedAnon(cfg, state, local());
    const control = createManagementSessionControl(state);
    expect(control.isCurrent(req, cfg)).toBe(true);
    expect(control.isPaired(req, cfg)).toBe(false);
    expect(control.canRevealDataKeys?.(req, cfg)).toBe(false);
  });

  test("flipping the flag to strict drops a live admitted request on the next revalidation", () => {
    // The stream must die when the operator shuts the anonymous surface, without waiting
    // for the request's cached admission to expire — admission memoization is per-Request,
    // currency is re-derived from the current flag every time.
    const cfg = config();
    const state = availableState();
    const req = admittedAnon(cfg, state, local());
    const control = createManagementSessionControl(state);
    expect(control.isCurrent(req, cfg)).toBe(true);
    expect(control.isCurrent(req, config({ loopbackManagementAuth: true }))).toBe(false);
    // Deny is flag-driven and reversible, not sticky: clearing it revives the same Request.
    expect(control.isCurrent(req, config())).toBe(true);
  });

  test("mutating the listener-owned context after admission cannot widen the copy", () => {
    const cfg = config();
    const state = availableState();
    const ctx = local();
    const req = admittedAnon(cfg, state, ctx);
    const control = createManagementSessionControl(state);
    expect(control.isCurrent(req, cfg)).toBe(true);
    ctx.peerAddress = "10.0.0.9";
    expect(control.isCurrent(req, cfg)).toBe(true);
  });

  test("a request that was never admitted is not current, forged Host and XFF included", () => {
    const cfg = config();
    const control = createManagementSessionControl(availableState());
    const forged = request("GET", { Host: `127.0.0.1:${PORT}`, "x-forwarded-for": "127.0.0.1" });
    expect(control.isCurrent(forged, cfg)).toBe(false);
    // A remote peer is refused at admission, so it can never become "current" afterwards.
    const refused = request("GET");
    expect(admitted(refused, cfg, availableState(), local({ peerAddress: "10.0.0.9" }))).toBe(401);
    expect(control.isCurrent(refused, cfg)).toBe(false);
  });

  test("an unavailable admin token keeps the anonymous path current", () => {
    // The anonymous branch runs before the token-state check on purpose: a box whose admin
    // token cannot initialize keeps serving its own loopback dashboard, including SSE.
    const cfg = config();
    const state = unavailableState();
    const req = admittedAnon(cfg, state, local());
    const control = createManagementSessionControl(state);
    expect(control.isCurrent(req, cfg)).toBe(true);
    expect(control.isCurrent(request("GET"), cfg)).toBe(false);
  });

  test("the token path keeps its pre-feature currency contract", () => {
    // GUI-session expiry/logout currency is pinned in tests/oauth/oauth-accounts-api.test.ts;
    // this pins only that the new anonymous branch did not disturb the admin-token answer.
    const cfg = config({ loopbackManagementAuth: true });
    const state = availableState();
    const req = request("GET", { "x-opencodex-api-key": ADMIN_TOKEN });
    expect(admitted(req, cfg, state, local())).toBeNull();
    const control = createManagementSessionControl(state);
    expect(control.isCurrent(req, cfg)).toBe(true);
    expect(control.isCurrent(request("GET", { "x-opencodex-api-key": "wrong" }), cfg)).toBe(false);
  });
});
