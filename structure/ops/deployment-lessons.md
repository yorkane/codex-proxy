# Deployment Lessons

Operational contract for installing, upgrading and accepting the wdev fork's portable proxy package on a
fleet box. Root `deploy.md` and `upgrade.md` state the product contract; this doc states the procedure
invariants that the 2026-10-23 two-box rollouts proved. It is a procedure contract, not a release log:
versions, hashes and machine coordinates are always read from the target's machine-readable manifest, never
copied from here.

## Identity is the manifest, not the CLI version

The bundle built from a fork commit reports the plain product version: `bin/ocx.mjs --version` prints
`2.91.0` for every `2.91.0-wdev.<sha>` build, so grepping the version output for a fork SHA can never
succeed. Four facts together identify an installed tree, and all four are checked:

1. `runtime-manifest.json` `sourceCommit` and `runtimeSourceCommit` — two distinct keys, not interchangeable,
   and never rebound after the package is built.
2. The install-tree hash and regular-file count recorded in that manifest.
3. An installed-files manifest matching the tree on disk, file by file.
4. The live unit's `ExecStart` pointing at that release directory.

`/healthz` `version` is a liveness field. When the old and new packages report the same version, rollback
evidence is `ExecStart` plus the tree, never the version value.

## Direct start: process shape and restart budget

The fork's direct-start unit is `Type=simple` with `Restart=always`, `KillMode=mixed` and
`TimeoutStopSec=75`. `ExecStart` runs the Node shim in `bin/ocx.mjs` using the payload node slot
`gateway/node/bin/node` inside the same release directory, so `MainPID` is the shim and the listening socket
is owned by the bundled Bun worker it starts. `MainPID` not holding the port is the normal shape: the
acceptance check is that the shim and the port owner sit in one parent-child tree under the same release
directory. `KillMode=mixed` with a 75-second stop budget is what makes `systemctl restart` apply the
application's own drain, so an authorized restart is logged with its in-flight request count and no
zero-interruption claim is made. `NRestarts` counts systemd-initiated restarts only, so a manual restart
leaves the delta at zero and the acceptance gate is `delta == 0` against the pre-change baseline.

## Acceptance is bounded polling plus a real stream

`/healthz` answers liveness and `/readyz` answers readiness; readiness settles 2-6 seconds after start
(`runtime.md` lifecycle). Acceptance polls health AND ready together with a bounded retry loop — a single
early probe is a false negative and triggers a needless rollback.

With the loopback management policy at its default (`config-proxy.md`: local peers admitted anonymously),
a 200 on a management GET is not evidence: the SPA fallback also answers 200 HTML. The stream route is the
gate — `GET /api/accounts/events` (the `/api` prefix is part of the route; `/accounts/events` falls through
to the SPA) must return 200 with `Content-Type: text/event-stream` and a first `event: ready` frame, read
with a bounded timeout and then closed. Anonymous admission is revalidated on every frame against the
kernel-observed ingress snapshot, so flipping the flag to strict mid-stream must break an open anonymous
stream. Browser acceptance runs a fresh anonymous profile with no injected headers or cookies and observes
zero 401s for 15-20 seconds.

## The upgrading script outlives the proxy it upgrades

The proxy being upgraded can be the channel the operator is talking through, so the whole sequence from stop
to acceptance to rollback is one pre-written script launched through `systemd-run` with an explicit uid/gid
and an absolute interpreter path (the script file itself does not need the executable bit). The root side
drains its own in-flight agents first, because the script must finish without the operator thinking after
the service is down. The script stages a new immutable release directory, swaps only `ExecStart` via
same-directory `install` + `mv`, keeps a full snapshot of the old unit, and restores the unit (plus the authz
binding, only if this run changed it), waits for health and ready, and verifies the old release identity on
any failure. Rollback paths must be reachable from the failure trap: a hand-written `exit` outside the trap
that skips rollback is a defect. Traffic observation is bounded — waiting indefinitely for two consecutive
idle samples is what leaves a package staged and never deployed.

## authz accounting is read-only and idempotent

See `deploy.md` §4 for the auth contract. Operationally: audit the gateway database through the SQLite
`mode=ro` backup API for a consistent online snapshot — copying a live WAL database, or opening it with
`immutable`, reads a torn state. Removing the injected management header deletes that one entry from
`request_rewrite.headers` and rewrites the rest of the block; the gateway normalizes an all-empty rewrite to
an empty string, which is a legal "no rewrite" value, so an audit that parses it as JSON and reports failure
is a false negative — and the real accident behind that rule is rolling back a run that changed nothing.
Idempotent runs skip when the rewrite is already empty.

## Credential and artifact hygiene

Tokens reach the process only from the environment, an env file, or a 0600 header file used with `curl -H @file`
or `curl --config file` — never argv, never a query string, never a log. TLS verification is never disabled.
Scratch artifacts live in `/data/tmp`; deletion means truncating secret-bearing files and moving them to the
trash root. Processes are stopped by exact PID.

## Build and release discipline

One builder at a time: long builds are polled through a reusable session, and 30 seconds of silence is not
evidence of a dead builder. The gzip stage does not move a same-named `.raw` artifact. A changed source tree
is freshly packed; a reused GUI build is allowed only when every file hash matches the verified dist. The
tested candidate and the published package are the same bytes. Package `source` commit, application-repo
merge SHA, and suite-repo release ref are three distinct coordinates and are recorded separately — a sidecar
is never edited after the fact to make them look equal. Published assets are immutable: a fix ships as a new
version, and a version directory's SHA list is pinned to its tag snapshot (verify by cloning the tag, never
by checking out a moving branch). `published` and `installed` are separate states; only a real installed-files
manifest moves the installed record.

## Scope

These procedures cover the direct-start proxy component only. The web component (gateway deb, port 3737) is
a separate release line with its own supervisor: a proxy rollout neither restarts it nor depends on it, and a
verification run compares its real listener PID and HTTP response to the recorded baseline instead of
starting a service to make a script pass. Boxes not covered by a rollout are not reported as upgraded.

## Rollback pairs with the authentication policy of the target release

A rollback selects a release **and** the credential shape that release expects, as one pair. Rolling back to
a release that predates the loopback anonymous policy (any build before the policy landed) restores the
enforcing shape: an unauthenticated management call returning 401 is then the **correct** result, the authz
binding needs its token-injection entry back, and the acceptance matrix runs with `required` semantics.
Running the anonymous-shape assertions against an enforcing release produces a false failure and provokes an
unnecessary second rollback. Pair the target, its credential shape, and its matrix; the SSE check takes the
same shape (an anonymous stream is expected to be refused when strict is on).
