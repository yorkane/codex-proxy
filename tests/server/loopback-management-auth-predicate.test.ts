/**
 * Pure predicate for loopback management anonymity: `isLoopbackManagementRequestAllowed`.
 *
 * The contract under test is the leaf decision, not the admission chain: a request is a
 * trusted loopback management request when the kernel peer is a loopback address, the
 * ingress mark says a trusted loopback listener carried it, the Host header parses to a
 * loopback name, the Origin (when present) is loopback or operator-allowlisted, and the
 * operator has not set `loopbackManagementAuth: true`. Three of those proofs are not
 * request data: peer comes from the socket, ingress from the Bun listener object, bind from
 * config. That is the whole reason the predicate takes them as arguments — a header cannot
 * reach any of them, which is what Docker port mapping, host-network containers, XFF and
 * forged Host all defeat on a header-only check.
 *
 * The Host/Origin checks are deliberately STRICTER than the data-plane sibling
 * `isLoopbackRequestHost`, which fails open on an unparseable Host (characterization-pinned
 * in tests/server/server-loopback-host-gate.test.ts). This surface admits credential-free
 * WRITES, so a Host that cannot be parsed is a Host that cannot be trusted.
 */
import { describe, expect, test } from "bun:test";
import { isLoopbackManagementRequestAllowed } from "../../src/server/loopback-management-auth";
import type { OcxConfig } from "../../src/types";

type ConfigView = Pick<OcxConfig, "loopbackManagementAuth" | "hostname" | "corsAllowOrigins">;
type LocalContext = Parameters<typeof isLoopbackManagementRequestAllowed>[2];

const PORT = 10100;

function local(peerAddress: string | null | undefined = "127.0.0.1", trustedLoopbackIngress = true): LocalContext {
  return { peerAddress, trustedLoopbackIngress };
}

function predicate(
  overrides: Partial<ConfigView> = {},
  ctx: LocalContext = local(),
  headers: Record<string, string> = { Host: `127.0.0.1:${PORT}` },
): boolean {
  const config: ConfigView = { hostname: "127.0.0.1", ...overrides };
  return isLoopbackManagementRequestAllowed(new Request("http://placeholder/api/config", { headers }), config, ctx);
}

describe("the flag", () => {
  test("absent, false and the shipped default admit; the leaf itself never reads a token", () => {
    expect(predicate()).toBe(true);
    expect(predicate({ loopbackManagementAuth: undefined })).toBe(true);
    expect(predicate({ loopbackManagementAuth: false })).toBe(true);
  });

  test("strict true keeps the management gate closed on a perfect loopback request", () => {
    expect(predicate({ loopbackManagementAuth: true })).toBe(false);
    // The deny must be flag-driven and reversible, not sticky: same request, flag cleared.
    expect(predicate({ loopbackManagementAuth: false })).toBe(true);
  });

  test("a value that is not a boolean is read as true (fail closed), never as false", () => {
    // On disk the schema `.catch(true)` lands here already; the leaf refusing to read a
    // non-boolean as "not true" is the second line of defense, so a hand-edited `"true"` or a
    // `1` cannot arrive through any seam and open the surface.
    for (const malformed of ["true", "yes", "false", 1, 0, "", {}, [], { enabled: false }, null, Number.NaN]) {
      expect(predicate({ loopbackManagementAuth: malformed as ConfigView["loopbackManagementAuth"] })).toBe(false);
    }
  });

  test("a config that carries no flag is the anonymous mode", () => {
    // The gate only calls the leaf when it has a config, so "config absent" is not a state the
    // leaf defines. What it defines is a config that carries nothing: no flag is the shipped
    // default, and the default is anonymous.
    const req = new Request("http://placeholder/api/config", { headers: { Host: `127.0.0.1:${PORT}` } });
    expect(isLoopbackManagementRequestAllowed(req, {} as ConfigView, local())).toBe(true);
  });
});

describe("the kernel peer, not a header", () => {
  test("the three kernel loopback spellings admit, including the IPv4-mapped IPv6 form", () => {
    // Bun reports a v4 connection on an IPv6 socket as ::ffff:127.0.0.1, which is why the
    // mapping is in the list and not the v4 form alone (gui-session.ts pins the same trio).
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(predicate({}, local(peer))).toBe(true);
    }
  });

  test("every other peer is refused, whatever the Host and forwarding headers claim", () => {
    // 192.168.32.1 is the Docker bridge on this fleet, 10.0.0.9 a tailnet peer, 64.186.236.113
    // a public address. Each can arrive with Host: 127.0.0.1; the socket is what distinguishes
    // them, and it is the one thing in the request that a caller does not write.
    for (const peer of ["192.168.32.1", "10.0.0.9", "64.186.236.113", "8.8.8.8", "::ffff:8.8.8.8",
      "::ffff:127.0.0.2", "127.0.0.2", "127.1", "127.0.0.01", "localhost", "fe80::1", "0.0.0.0",
      " 127.0.0.1", "127.0.0.1 ", "127.0.0.1\u0000"]) {
      expect(predicate({}, local(peer))).toBe(false);
    }
  });

  test("a missing, empty, or null peer is refused", () => {
    // Written as literals, not through the helper: a default parameter would turn an explicit
    // `undefined` peer into the loopback default, which is the helper's convenience, not a
    // request property.
    const req = new Request("http://placeholder/api/config", { headers: { Host: `127.0.0.1:${PORT}` } });
    for (const ctx of [{ peerAddress: undefined, trustedLoopbackIngress: true },
      { peerAddress: null, trustedLoopbackIngress: true },
      { peerAddress: "", trustedLoopbackIngress: true }]) {
      expect(isLoopbackManagementRequestAllowed(req, { hostname: "127.0.0.1" }, ctx)).toBe(false);
    }
  });

  test("the ingress mark is required: a peer that looks local without it is refused", () => {
    // The mark is bound to the Bun listener object (serve-options.ts). A context that carries
    // no peer, no mark, or an untrusted ingress is the public listener, and the public listener
    // answers exactly as it did before this flag existed. The absent-context cases go through
    // a wrapper so `undefined` arrives as an argument, not as a defaulted parameter.
    const req = new Request("http://placeholder/api/config", { headers: { Host: `127.0.0.1:${PORT}` } });
    const cfg: ConfigView = { hostname: "127.0.0.1" };
    expect(predicate({}, local("127.0.0.1", false))).toBe(false);
    expect(predicate({}, { peerAddress: "127.0.0.1" })).toBe(false);
    expect(predicate({}, { trustedLoopbackIngress: true })).toBe(false);
    expect(predicate({}, {})).toBe(false);
    expect(isLoopbackManagementRequestAllowed(req, cfg, undefined)).toBe(false);
    expect(isLoopbackManagementRequestAllowed(req, cfg, local())).toBe(true);
  });

  test("bind trust rides the ingress mark; a public ingress refuses a local peer", () => {
    // The authz host-network topology inverted: a proxy on the box dials 127.0.0.1, so the
    // peer is local, but the socket is reachable from the LAN. `trustedLoopbackForIngress()`
    // is what turns "is this bind loopback" into a per-listener mark bound to the Bun server
    // object, and the leaf consumes the mark rather than re-deriving trust from the config's
    // hostname string — the mark cannot be manufactured from request data, the field can.
    expect(predicate({ hostname: "0.0.0.0" }, local("127.0.0.1", false))).toBe(false);
    expect(predicate({ hostname: "10.252.25.235" }, local("127.0.0.1", false))).toBe(false);
    expect(predicate({ hostname: "::" }, local("127.0.0.1", false))).toBe(false);
    // Pinned deliberately: the leaf itself is mark-driven and does not second-guess it. The
    // end-to-end wildcard-bind refusal (real listener producing mark=false with peer
    // 127.0.0.1) is covered in management-loopback-anon.test.ts.
    expect(predicate({ hostname: "0.0.0.0" }, local("127.0.0.1", true))).toBe(true);
  });

  test("forwarding headers neither grant nor revoke admission", () => {
    const config: ConfigView = { hostname: "127.0.0.1" };
    const headers = {
      Host: `127.0.0.1:${PORT}`,
      "X-Forwarded-For": "127.0.0.1",
      "X-Real-IP": "127.0.0.1",
      Forwarded: 'for="127.0.0.1"',
    };
    const req = new Request("http://placeholder/api/config", { headers });
    expect(isLoopbackManagementRequestAllowed(req, config, local("10.0.0.9"))).toBe(false);
    expect(isLoopbackManagementRequestAllowed(req, config, local("127.0.0.1", false))).toBe(false);
    expect(isLoopbackManagementRequestAllowed(req, config, local())).toBe(true);
  });
});

describe("Host: required, parseable, loopback", () => {
  test("a missing Host is refused", () => {
    const req = new Request(`http://127.0.0.1:${PORT}/api/config`);
    req.headers.delete("Host");
    expect(req.headers.get("Host")).toBeNull();
    expect(isLoopbackManagementRequestAllowed(req, { hostname: "127.0.0.1" }, local())).toBe(false);
  });

  test("a Host that does not parse is refused (fail closed, unlike the data-plane gate)", () => {
    // Each entry fails the same `new URL("http://" + value)` parse that production's
    // parseHttpHost performs, so a strict predicate has nothing to compare.
    for (const host of ["", " ", "not a host", "127.0.0.1:not-a-port", "127.0.0.1:-1",
      "127.0.0.1:10100:10101", "http://127.0.0.1", "?127.0.0.1", "::1", "[::1", "-"]) {
      expect(predicate({}, local(), { Host: host })).toBe(false);
    }
  });

  test("a non-loopback Host is refused, including rebinding and lookalike shapes", () => {
    for (const host of ["evil.example", "evil.example:10100", "10.0.0.9:10100", "0.0.0.0:10100",
      "127.0.0.1.evil.example", "localhost.evil.example", ["127.0.0.1", "evil.example"].join("@"),
      "evil.example#127.0.0.1", "127.0.0.1.evil.example:10100"]) {
      expect(predicate({}, local(), { Host: host })).toBe(false);
    }
  });

  test("loopback Host spellings admit: quad, name, bracketed IPv6, trailing dot, any port", () => {
    // Port is not part of the trust boundary: `ssh -L 20100:localhost:10100` arrives as
    // localhost:20100, and 235's authz cc binding rewrites the upstream Host to a portless
    // `127.0.0.1`. The rebinding defense is the hostname, which is why a foreign port on a
    // loopback name still admits and a loopback name glued to a foreign domain does not.
    for (const host of ["127.0.0.1", `127.0.0.1:${PORT}`, "127.0.0.1:1", "127.0.0.1:65535",
      "localhost", "localhost:20100", "LOCALHOST:10100", "localhost.",
      "[::1]", "[::1]:10100", "[::1]:3000"]) {
      expect(predicate({}, local(), { Host: host })).toBe(true);
    }
  });

  test("the raw Host grammar is exact: no quad trailing dot, no empty port, no oversized port", () => {
    // Characterization of the documented grammar, which lists `localhost.` and not
    // `127.0.0.1.`. Both directions are fail-closed, and the asymmetry is only visible to a
    // client that dials an FQDN-shaped literal — the name form is what dashboards and `ocx`
    // commands send, so it keeps working. Pinned so loosening the grammar is a decision, not
    // drift. `127.0.0.1:` fails the raw regex; `127.0.0.1:65536` passes it and fails URL
    // parsing. `:0` is a legal authority the URL layer accepts, and port is not the boundary.
    expect(predicate({}, local(), { Host: "127.0.0.1." })).toBe(false);
    expect(predicate({}, local(), { Host: "localhost." })).toBe(true);
    expect(predicate({}, local(), { Host: "127.0.0.1:" })).toBe(false);
    expect(predicate({}, local(), { Host: "127.0.0.1:65536" })).toBe(false);
    expect(predicate({}, local(), { Host: "127.0.0.1:0" })).toBe(true);
  });

  test("a loopback bind is not required to be the loopback the Host names", () => {
    // hostname localhost and Host 127.0.0.1 are the same interface; refusing the mismatch
    // would break the loopback bind that the shipped default config uses.
    expect(predicate({ hostname: "localhost" }, local(), { Host: "127.0.0.1:10100" })).toBe(true);
  });
});

describe("Origin: absent, loopback, or allowlisted", () => {
  test("no Origin admits (curl, the CLI, and authz origin_mode=remove)", () => {
    expect(predicate()).toBe(true);
  });

  test("a loopback Origin admits when it matches the request origin exactly", () => {
    // The leaf inherits the management CSRF gate verbatim (`isAllowedManagementOrigin`):
    // exact match against the origin derived from the Host header, or an operator-listed
    // corsAllowOrigins entry. The GUI dashboard sends exactly its own origin, so this is the
    // shape that must pass; anything else on the loopback subnet must not, because the defense
    // being inherited is DNS rebinding, and "some loopback string" is not a rebinding defense
    // once an attacker-controlled page has moved the victim's browser onto a port it chooses.
    expect(predicate({}, local(), { Host: `127.0.0.1:${PORT}`, Origin: `http://127.0.0.1:${PORT}` })).toBe(true);
    expect(predicate({}, local(), { Host: "127.0.0.1", Origin: "http://127.0.0.1" })).toBe(true);
    expect(predicate({}, local(), { Host: "localhost:20100", Origin: "http://localhost:20100" })).toBe(true);
    expect(predicate({}, local(), { Host: "[::1]:10100", Origin: "http://[::1]:10100" })).toBe(true);
    expect(predicate({}, local(), { Host: "LOCALHOST:10100", Origin: "http://localhost:10100" })).toBe(true);
    // Cross-port, cross-scheme and cross-spelling loopback pairs are the CSRF gate's denials:
    // same machine, different authority string, so the same-origin proof is broken.
    expect(predicate({}, local(), { Host: `127.0.0.1:${PORT}`, Origin: "http://127.0.0.1" })).toBe(false);
    expect(predicate({}, local(), { Host: "127.0.0.1", Origin: `http://127.0.0.1:${PORT}` })).toBe(false);
    expect(predicate({}, local(), { Host: `127.0.0.1:${PORT}`, Origin: "http://localhost:10100" })).toBe(false);
    expect(predicate({}, local(), { Host: `127.0.0.1:${PORT}`, Origin: "https://127.0.0.1:10100" })).toBe(false);
  });

  test("a cross-site, opaque, or malformed Origin is refused", () => {
    // `null` is the opaque origin a sandboxed iframe and file:// pages send. It carries no
    // host, so reading it as "local" would let any local HTML file on disk drive the API.
    // A whitespace-only Origin is absent from the list: the header layer normalizes it to the
    // empty value, which is the documented "no Origin" case pinned in its own test below.
    for (const origin of ["null", "https://evil.example", "https://cc-235.ai-t.wtvdev.com",
      "http://10.0.0.9:10100", "http://127.0.0.1.evil.example", "https://localhost.evil.example",
      "127.0.0.1", "//127.0.0.1:10100", "ftp://127.0.0.1", "not an origin", "http://[::1", "*"]) {
      expect(predicate({}, local(), { Host: `127.0.0.1:${PORT}`, Origin: origin })).toBe(false);
    }
  });

  test("an empty Origin header is the no-Origin case, not a cross-site one", () => {
    // Non-browser clients send `Origin:` with no value; fetch surfaces it as "".
    expect(predicate({}, local(), { Host: `127.0.0.1:${PORT}`, Origin: "" })).toBe(true);
  });

  test("corsAllowOrigins admits an exact entry and refuses the lookalikes", () => {
    const listed = "https://dashboard.example.test";
    const config = { hostname: "127.0.0.1", corsAllowOrigins: [listed] } satisfies ConfigView;
    expect(predicate({ corsAllowOrigins: [listed] }, local(), { Host: `127.0.0.1:${PORT}`, Origin: listed })).toBe(true);
    // The lookalikes are the ones a hostile operator entry must not admit: a suffix extension,
    // the wrong scheme, a non-default port, and a truncated domain. A path-bearing Origin is
    // NOT asserted here: the shared comparator normalizes it to the bare origin (browsers
    // never send one), and this predicate reuses that comparator rather than forking it.
    for (const near of [listed + ".evil.example", "http://dashboard.example.test",
      "https://dashboard.example.test:444", "https://dashboard.example"]) {
      expect(predicate({ corsAllowOrigins: [listed] }, local(), { Host: `127.0.0.1:${PORT}`, Origin: near })).toBe(false);
    }
    // One allowlisted host must not admit every Origin, and the allowlist must not be read
    // when it is absent.
    expect(predicate({ corsAllowOrigins: [listed] }, local(), { Host: `127.0.0.1:${PORT}`, Origin: "https://other.example.test" })).toBe(false);
    expect(predicate(config, local(), { Host: `127.0.0.1:${PORT}`, Origin: "null" })).toBe(false);
  });

  test("a cross-site Origin is refused even with a valid admin token in the request", () => {
    // The predicate answers "is this a trusted local caller". A token makes the request
    // authenticated, not loopback: the origin gate that stops a hostile page is the
    // management origin check, and the anonymous branch must not become a way around it.
    const headers = {
      Host: `127.0.0.1:${PORT}`,
      Origin: "https://evil.example",
      "x-opencodex-api-key": "correct-admin-token",
    };
    expect(predicate({}, local(), headers)).toBe(false);
  });
});

describe("the shape of the decision", () => {
  test("method and path do not change the answer", () => {
    // Admission is about the caller, not the intent. Route policy (session-only, consent-bound)
    // is enforced downstream against the principal; a leaf that gated on path would put that
    // policy in two places and let them drift.
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/api/config", "/api/settings", "/api/providers", "/api/keys/reveal", "/api/session/logout", "/healthz", "/"]) {
        const req = new Request(`http://placeholder${path}`, { method, headers: { Host: `127.0.0.1:${PORT}` } });
        expect(isLoopbackManagementRequestAllowed(req, { hostname: "127.0.0.1" }, local())).toBe(true);
      }
    }
  });

  test("a request with no credentials and a request with wrong credentials answer the same", () => {
    // Anonymous admission is defined by the transport, so a wrong token must not make a
    // trusted local caller LESS trusted. Credential precedence is the admission chain's job,
    // tested in tests/server/management-loopback-anon.test.ts.
    for (const headers of [
      { Host: `127.0.0.1:${PORT}` },
      { Host: `127.0.0.1:${PORT}`, "x-opencodex-api-key": "wrong" },
      { Host: `127.0.0.1:${PORT}`, authorization: "Bearer wrong" },
    ]) {
      expect(predicate({}, local(), headers)).toBe(true);
    }
  });

  test("two requests on the same socket do not share a decision", () => {
    const remote = new Request("http://placeholder/api/config", { headers: { Host: "evil.example" } });
    const localReq = new Request("http://placeholder/api/config", { headers: { Host: `127.0.0.1:${PORT}` } });
    expect(isLoopbackManagementRequestAllowed(remote, { hostname: "127.0.0.1" }, local())).toBe(false);
    expect(isLoopbackManagementRequestAllowed(localReq, { hostname: "127.0.0.1" }, local())).toBe(true);
    expect(isLoopbackManagementRequestAllowed(remote, { hostname: "127.0.0.1" }, local())).toBe(false);
  });
});
