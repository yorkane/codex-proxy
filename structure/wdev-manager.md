# Wdev manager surface (fork opt-in)

The proxy can register itself as a wdev-managed component. The wdev manager (`~/wdev/manager/wdev.py`
of the deploy user) owns installs, restarts, and the release ledger; this proxy is a thin client
that shows the inventory, submits operations, and obeys a maintenance fence. The block is opt-in:
an install with no `wdevManager` config and no `WDEV_*` environment runs none of this code.

Source areas: `src/wdev/` (activation seam, CLI invoker, maintenance fence, request gate),
`src/server/management/wdev-routes.ts` (the `/api/wdev/*` handlers). The dispatcher gate and the
lazy mount live in `src/server/management-api.ts`; the fence hook on the request path is the
`wdevFenceGateResponse` call in `src/server/index/serve-options.ts`, and the same file projects
the fence into `/healthz`. The upstream npm self-update entry refuses in wdev mode in
`src/server/management/config-routes.ts`. The config block is declared in
`src/config/schema/config-schema.ts` (`wdevManager`) and typed in `src/types/config.ts`.

## Activation and trust contract

Every executable coordinate is fixed at deploy time by environment variables written into the
service unit. A management request supplies only whitelisted data fields; nothing in a request
body can name a binary, an interpreter, a directory, a unit, or a shell. The config block carries
no paths for the same reason: the file is operator data, and the env is deployment data.

| Env | Meaning | Default |
|---|---|---|
| `WDEV_MANAGER_HOME` | Manager root, `<deploy home>/wdev`. Absolute, required. | unset = disabled |
| `WDEV_DEPLOY_HOME` | The `--home` the CLI receives. | manager root minus its `/wdev` suffix |
| `WDEV_MANAGER_PYTHON` | Interpreter. Absolute path only; never a PATH lookup. | `/usr/bin/python3` |
| `WDEV_MANIFEST_ROOT` | The only directory `manifestPath` may resolve inside. | `<manager root>/manifests` |
| `WDEV_MAINTENANCE_FILE` | Supervisor fence file for this component. The manager writes `<deploy home>/state/maintenance-llm-proxy.json`, so deployments set this explicitly. | `<manager root>/state/maintenance-llm-proxy.json` |
| `WDEV_MANAGER_TIMEOUT_MS` | CLI kill window, 500-120000. | 30000 |
| `WDEV_MANAGER_SUBMIT_DISPATCH` | Send the explicit `--dispatch` argv flag on submit. The real parser accepts it (default True, `--no-dispatch` queue-only); set `0`/`false` for a manager build whose parser predates the flag. | on |

The CLI entry is always `<WDEV_MANAGER_HOME>/manager/wdev.py` (the installer materializes it; a
releases symlink is fine as long as `realpath` stays inside the root, which `assertTrustedManagerRuntime`
in `src/wdev/manager-cli.ts` verifies on every invocation, not once at boot). The config block is
`{ enabled?: true, brand?: string }`; a malformed block degrades to disabled, and `brand` is display
copy for the dashboard page only. Internal identity never renames: `/healthz` keeps
`service: "opencodex"`, the header stays `x-opencodex-api-key`, and the npm package name and provider
namespace are untouched.

## Manager CLI contract

argv is a fixed array built by `buildArgv`: `<python> <cli> --home <deploy home> <verb> ...`, no
shell, cwd is the manager root, stdout must be a single JSON document, and the output cap is 256 KiB.

- `components` -> `{components:[{id,unit,url,status,releaseId,dataEpoch,configRevision,lastGood,health,caps}],activation}`.
  `status` is the systemd reading `"active"|"inactive"|"unknown"` and the config counter is
  `configRevision` (a non-negative int); the route maps `active`->`ok`, `inactive|failed`->`down`,
  `configRevision`->`revision` (display string) and projects an allowlist, so an extra manager
  field never reaches a client.
- `submit --component <web|llm-proxy> --action <restart|upgrade|configure> --request-json <json>`
  -> `{operationId, state:"queued"}`.
  Submit dispatches by default and the parser accepts the explicit `--dispatch` spelling
  (`--no-dispatch` is the queue-only opt-out), so the proxy's argv sends `--dispatch`; a deployment
  pinned to a manager build whose parser predates the flag sets `WDEV_MANAGER_SUBMIT_DISPATCH=0`
  to drop it. Submit returns only after the operation is durable
  in the manager ledger (fsync of a real file descriptor), which is what makes the proxy's `202`
  mean "durably queued". It is never evidence the operation applied.

- `doctor` is the manager's own health verb and is not proxied by these routes.

`--request-json` carries exactly `{manifestPath, configPatch, expectedRevision, idempotencyKey, maxWait}`.
`manifestPath` is a name the route resolves with `resolveTrustedManifestPath`; the CLI receives the
realpath inside `WDEV_MANIFEST_ROOT`, never the request string. A reused `idempotencyKey` bound to a
different `operationId` is a 409, so a client retry is safe and a key rebinding is not.
The route pre-enforces the manager's own sanitize rules so a rejected submit is a fast 400 and
never a ledger record: `expectedRevision` must be a non-negative integer (numeric strings are
normalised to numbers before forwarding), `configure` requires `configPatch`, `upgrade` requires
`manifestPath`, and `maxWait` is clamped to 0-600 (the manager's own bound is 0-86400 seconds).

## Routes

Registered in `src/server/management/route-registry.ts` under `server/management/wdev-routes`, all
behind the standard `requireManagementAuth` gate (no new bypass, no loopback exception), and all
declared `deferred-verb` because the terminal surface in this phase is the manager CLI, not `ocx`:

- `GET /api/wdev/components` - inventory + brand + the manifest listing of the trusted root.
- `POST /api/wdev/operations` - submit; `202 {operationId, state:"queued", componentId, action, submittedAt}`.
  The idempotency gate runs BEFORE the manager CLI: a key bound to a different request is
  a 409 with zero enqueue side effect; a key re-POSTed with the identical request replays
  the bound operation (`replayed: true`) without a second submit. The manager's own
  ledger dedup is the cross-restart layer; the proxy never grants a 202 it then 409s.
- `GET /api/wdev/operations` - the operations this process submitted, newest first.
- `GET /api/wdev/operations/{id}` - uuid-anchored; the ledger record, projected field by field.
  The real record names the component key `component` and carries `state`+`phase` plus ISO
  `createdAt`/`updatedAt` strings; the projection maps `component`->`componentId`, prefers
  `state` over `phase`, and passes ISO timestamps through.

When the config block is absent the dispatcher answers `404 wdev_disabled` before importing the
handler; with the block set and the env incomplete, `404 wdev_env_missing`. The spawner is a second
dynamic import inside the handler, so a disabled install loads no spawn code: that is the claim of
`tests/server/wdev-core-boundary.test.ts`, which walks the management import graph.
`POST /api/wdev/operations` is in `SIBLING_REFUSED_MANAGEMENT_PATHS`: a sibling proxy must not
drive the shared machine's one manager.

In wdev mode `POST /api/update/run` returns `409 wdev_mode_update_disabled` before touching the
update job: the manager installs verified releases, and the upstream npm entry would install an
upstream package over a wdev-managed tree.

## Maintenance fence

The supervisor fences this proxy from outside the process by writing the maintenance file, and the
proxy refuses new generation work while that file is live. The document is
`{schemaVersion:1, component:"llm-proxy", operationId, fenceEpoch, phase:"draining"|"quiesced"|"expired", generation, deadline, writtenAt}`
with `deadline` a unix-milliseconds number (the frozen supervisor field name; `deadlineUnixMs` is
accepted as a legacy alias and the ack echoes one value). The file is stat-ed per data-plane request
and its content re-read only when mtime/size moved, so the fence takes effect on the next request
and an acknowledged `/healthz` can never disagree with a gated POST by more than one request.
The `expired` phase is part of the supervisor's state machine: when the lease deadline passes it
flips `phase` to `expired` and RETAINS the fence file, and admission stays blocked. The proxy parses
`expired` as a live fence (a fenced `/healthz` acks it), never as a release.

Fail-closed and release-only-by-removal: a malformed, unknown-schema, oversized, directory, or
lease-expired file is fenced, and the proxy never lifts a fence on a timeout, because an operation
that outlived its lease is precisely when an unattended release would be worst.

Phase semantics: `draining` admits ONLY validated in-flight continuations; `quiesced` and
`expired` (and the fail-closed sentinel) are STRICT and refuse ALL generation work,
continuations included, with zero body reads - quiesced means the supervisor's idle gate
passed and the kill is imminent, expired means the lease died mid-transaction with the
fence retained; a turn admitted there would ride into the kill.

Continuation validation (draining only). A tool round trip is request -> tool output ->
request, so a fence that refused every `POST /v1/*` would deadlock the drain it waits for:
the second leg is a new POST. Admission requires BOTH evidences: (1) the request's bounded
body prefix is tool-continuation shaped (`function_call_output` / `tool_result` /
`role":"tool"` / `call_response`), and (2) an anchor proves the turn is in flight through
THIS process. Anchoring is lane-only by design: the responses store is deliberately NOT
consulted on the admission path - the replay entry points (`expandPreviousResponseInput`)
call `ensureLoaded()` (first use reads the whole durable snapshot) and `materializeEntry()`
(a spilled payload moves into RAM, cap 256 MiB), and validating continuations through them
would amplify memory exactly while the process drains. The lane registry is bounded (4096
ids, TTL, refreshed on use) and header-only. Consequence: a second leg with NO lane header
(thread/session id) is refused and retries on the 503 - the drain window is minutes, and a
false release is an in-flight turn killed mid-transaction. A plain new user turn on a
registered lane is refused: lane registration alone does not prove an open tool loop.
Documented draining boundaries: a continuation leg that arrives `Content-Encoding: gzip`
is refused (the prefix scan is over the raw stream; decoding on the admission path is not
worth the attack surface), as is a Responses-API client whose tool leg carries no lane
header. Both are retryable 503s - the refusal is `Retry-After: 5`, and clients that treat
a 503 inside their maxWait as retryable (not a hard failure) ride the drain out; the
supervisor's fence window is minutes. In the management GUI these show as the inventory
status badge `unknown` passthrough - no new UI surface is warranted for a refusal the
client already retries. The prefix is a bounded STREAM read capped at 2 MiB with cancellation of
the remainder (the gate runs on the admission path, before the route-level body limits;
`clone().text()` on a headless oversized body would buffer unbounded); the read body is
re-attached to the request via a Request replacement the entry routes onward. Refusals
cancel the stream; admitted requests are exactly the prefix the JSON reader may see.

WebSocket upgrades that open new sessions - `/v1/responses`, `/v1/live`, `/v1/realtime*`,
and the dictation stream `/v1/audio/transcriptions/stream` - are fresh generation work and
refused while fenced (they carry no HTTP-continuation evidence). Everything refused lands
on `503 wdev_maintenance` with `Retry-After: 5`. Read surfaces stay answerable while fenced:
`GET /v1/models` (health clients probe it), `/healthz`, `/readyz`, `/api/*`, and
`count_tokens` (no provider quota spent).

`/healthz` gains a `maintenance` field only while fenced - `{active, operationId, phase, strict,
fenceEpoch, ack:true}` - and `ack:true` means this process observed this fence on this request,
which is what the supervisor's quiesce gate requires after its write. The unfenced health bytes
are unchanged.
