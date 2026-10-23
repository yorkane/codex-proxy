import type { OcxConfig } from "../types";
import { isAllowedManagementOrigin, isLoopbackHostname } from "./auth-cors";

/**
 * Fork-owned exemption: a management request that is provably local may skip the
 * admin-token / GUI-session fence. This is the whole attack surface of the
 * exemption, so it lives in its own leaf: no state, no side effects.
 *
 * All conditions are required:
 * - `loopbackManagementAuth` is false/absent (anonymous mode). `true` and any
 *   runtime-illegal value deny, so strict mode stays the fail-closed default.
 * - The listener is a trusted loopback ingress and the kernel-observed peer is
 *   loopback. Forwarded headers never participate; 127.0.0.0/8 is not widened.
 * - Host is a bare loopback authority in raw form: `127.0.0.1`, `localhost`,
 *   `localhost.` or `[::1]`, with an optional port. No userinfo, path, query,
 *   fragment, slash, backslash, or empty port. The grammar runs on the header
 *   before URL normalization, so a Host that a lenient parser would repair into
 *   a loopback authority (`127.0.0.1/`, `//127.0.0.1`, `?#` delimiters) denies.
 *   Port is not required: the 235 authz relay sends portless `127.0.0.1`.
 *   Stricter than isLoopbackRequestHost(), which fails open on unparseable Host.
 * - Request URL scheme is http/https. Origin: absent is allowed (non-browser
 *   local caller); a present Origin must pass isAllowedManagementOrigin(), which
 *   enforces http/https, exact request-origin match and the corsAllowOrigins list,
 *   so cross-site and opaque `null` origins deny.
 */

// Raw Host authority grammar. Bracketed IPv6 is the only IPv6 form a Host header may
// carry. URL normalization (below) bounds the port to 65535 and rejects a trailing colon.
const LOOPBACK_HOST_AUTHORITY = /^(?:127\.0\.0\.1|localhost\.?|\[::1\])(?::[0-9]{1,5})?$/i;

export function isLoopbackManagementRequestAllowed(
  req: Request,
  config: Pick<OcxConfig, "loopbackManagementAuth" | "hostname" | "corsAllowOrigins">,
  local: { peerAddress?: string | null; trustedLoopbackIngress?: boolean } | undefined,
): boolean {
  const flag = config.loopbackManagementAuth;
  if (flag !== undefined && flag !== false) return false;
  if (!local || local.trustedLoopbackIngress !== true) return false;
  const peer = local.peerAddress;
  if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return false;
  const host = req.headers.get("Host");
  if (!host || !LOOPBACK_HOST_AUTHORITY.test(host)) return false;
  let authority: URL;
  let scheme: string;
  try {
    authority = new URL(`http://${host}`);
    scheme = new URL(req.url).protocol;
  } catch {
    return false;
  }
  if (scheme !== "http:" && scheme !== "https:") return false;
  if (authority.username || authority.password || authority.search || authority.hash) return false;
  if (authority.pathname !== "/" && authority.pathname !== "") return false;
  if (!isLoopbackHostname(authority.hostname)) return false;
  const origin = req.headers.get("Origin");
  if (origin === null) return true;
  return isAllowedManagementOrigin(req, config as unknown as OcxConfig);
}
