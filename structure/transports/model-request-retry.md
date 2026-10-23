# Unified Model Request Retry

Contract owner for the fork's unified model-request retry budget: the configuration surface, every
consumption layer that implements it, and the boundaries that keep a retry from becoming a resend of
something the client already received. The persisted field and its schema live in
[Config Surface](../config.md); the dispatch wiring stays with the owners named below. Every area listed
here is also described by the docs that already describe it - shared transport and config areas keep
their existing owners - and this doc is the single statement of the retry contract, so a dependent
links here instead of restating it.

## The contract

Every model request that receives a real upstream HTTP 4xx/5xx is retried within one configured budget,
with a floor of 10 retries. The floor is the requirement, not a validation: any parsable configured
number below 10 (including 0 and negatives) resolves to 10, and no caller can obtain fewer than 10
retries. The ceiling is 100, matching the Codex client's own read-side clamp so both layers agree.
The configured value counts **retries**, excluding the first send; the send budget is retries + 1
(`modelRequestMaxAttempts`), so the shipped default is 11 physical sends per logical request.

Resolution is single-sourced in `src/lib/model-request-retry.ts`, a pure leaf with no `src/config/**`
or `src/server/**` import: environment `OCX_MODEL_REQUEST_MAX_RETRIES` over the caller-supplied
configured value over the default. Fractions floor. An empty/whitespace environment value is unset; a
non-empty value that is not a number is not a switch — it falls back to the configured value and then
to the floor, because a malformed environment must not disable retry protection. The authority for
the per-request total has exactly three tiers: environment > global `modelRequestMaxRetries`
> default 10. Ingress funds `maxTotalModelSends` and `baseSendAllowance` with
`modelRequestMaxAttempts(configured)` in the inference context;
`transientRetryOn5xx.attempts` on a provider row is not a tier of that authority.
`transientSendCapFor` keeps it as the legacy per-leg cap candidate only:
max(authority, provider attempts) minus sends already used, intersected per leg with the shared
ledger. A provider value can widen one leg above the authority but cannot raise the logical
request's total past it (attempts 12 on an 11-funded request still ends at 11 physical sends),
and a low provider value cannot press the authority down. The read/write boundary is asymmetric
and is documented on [the config surface](../config.md): a hand-edited config value outside
10-100, a fraction, a negative or a string is malformed, degrades to absent at load, and
resolves to the default 10 (never clamped to 100); an environment value, once parsed as a number,
floors fractions and clamps into 10-100. Candidate writes reject the malformed values.

The configured value is a top-level key of the **proxy's own `config.json`**. It is not the injected
`config.toml` pair `request_max_retries` / `stream_max_retries` that bounds the Codex client's own
retries (`OCX_CODEX_REQUEST_MAX_RETRIES` / `OCX_CODEX_STREAM_MAX_RETRIES`); the two key families are
independent, with no aliasing and no inheritance in either direction.

Focused test files cover every layer named above (
  `tests/lib/model-request-retry.test.ts`,
  `tests/lib/model-request-http-retry.test.ts`,
  `tests/lib/model-retry-scope.test.ts`,
  `tests/lib/native-model-retry.test.ts`,
  `tests/lib/owned-model-retry.test.ts`,
  `tests/lib/sidecar-model-retry.test.ts`,
  `tests/adapters/model-http-retry.test.ts`,
  `tests/adapters/google/google-http-model-retry.test.ts`,
  `tests/providers/kiro/kiro-model-retry.test.ts`,
  `tests/providers/cursor/cursor-model-retry.test.ts`,
  `tests/config/model-request-retry-config.test.ts`,
  `tests/responses/responses-capacity-pre-output.test.ts`,
  `tests/responses/responses-model-retry-adapter.test.ts`,
  `tests/responses/native-model-retry-ladder.test.ts`,
  `tests/oauth/oauth-account-auto-pause-deferral.test.ts`); the suite is executed centrally by the
test slot, not claimed here. This page defines the contract's behavior and invariants; it carries
no dynamic publication, deployment, or production state - those facts live in the dated
operations report of the proxy workspace (`doc/model-request-retry-20261023.md`), not
here. No path is promised to issue exactly 11 sends: the floor is a minimum, and the limitations
named below cut against full-path exactness.

## One ledger, no multiplication

The budget belongs to **one logical request**. Same-account ladder steps, 429 same-key resends,
key/OAuth rotation, and alternate-account moves all draw from the same ledger, so there is no
per-account 11 and no layer-by-layer multiplication. `src/lib/owned-model-retry.ts` states the rule
the fork already convicted (#4546: an outer 3 over an inner 3 became 9): the shell counts rounds and
never books sends itself, and every physical send goes through the existing accounting boundary.

- `src/lib/model-request-retry.ts` — the arithmetic: `modelRequestMaxRetries`,
  `modelRequestMaxAttempts`, `DEFAULT_MODEL_REQUEST_MAX_RETRIES` (10),
  `MODEL_REQUEST_MAX_RETRIES_LIMIT` (100), `MODEL_REQUEST_MAX_RETRIES_ENV`.
- `src/lib/upstream-retry.ts` — the shared dispatch lane. With `modelRetryMode` set, the transient and
  connection-reset layers share one attempts total read from the leaf, the status gate is the whole
  400..599 set (upstream `x-should-retry` hints do not exempt a local obligation), the
  `Retry-After` ceiling is unbounded by default, and the run is wrapped in the deferral scope.
- `src/server/native-model-retry.ts` — the three native lanes (Chat Completions, Anthropic Messages,
  Responses compact). `nativeModelAuthorityAttempts` takes the funded
  `budget.policy.maxTotalModelSends` as authoritative and falls back to the leaf only when that value
  is malformed; an explicitly smaller caller/combo-derived ceiling (e.g. 4) is a precise contract and
  is never raised by the floor. `nativeModelSendsRemaining` deducts the greater of the lane's own
  counter and `budget.used`, so two accountings cannot each spend the whole budget.
- `src/lib/owned-model-retry.ts` — the budget shell for adapters that own their ladder: Kiro
  (`src/adapters/kiro-retry.ts`, reset + throttle) and Cursor (`src/adapters/cursor/transport-retry.ts`,
  whole-turn replay). `ownedModelSendTotal` prefers the request budget's policy total and falls back to
  the leaf; `ownedModelSendsRemaining` returns 0 once spent. `upstreamHttpErrorStatus` extracts a status
  of 400..599 from thrown `HTTP <n>` / `failed: <n>` text and returns undefined otherwise, so a
  connection reset stays non-replayable instead of gaining a blind resend. Command Code / Zed /
  MiMo-free use a separate shell, `src/adapters/model-http-retry.ts` below.
- `src/adapters/model-http-retry.ts` — the unified model HTTP retry shell for the three single-shot
  ladders (Command Code, Zed, MiMo-free; the importers named in the source). It reuses
  `fetchWithTransientRetry` in `modelRetryMode` (full 400..599 gate, complete `Retry-After` lower-bound
  wait, caller-abort veto, shared retry scope) rather than inventing a second loop. The budget
  authority is the shared `RequestExecutionBudget` policy total: an explicit cap, **including 0**, is
  honoured as-is and never raised by the floor; a context-free call creates a budget capped at the
  unified leaf total (default 11) inside the shell. Each physical send goes through
  `createAdapterPhysicalSend` → `reserveDispatch`, so nesting cannot exceed the absolute total, and
  `modelHttpRetryAttempts` is the exported seam that pins both rules. Protocol recovery (401 token
  refresh, 400 ladder downgrade) is parsed inside the round and the resend is left to the next round,
  one model physical send per round; Zed's internal 401 replay spends two sends in one round through
  the same closure. A non-2xx gets a bounded catch snapshot (status/headers verbatim, body up to
  64 KiB) so a budget-refusal exit still returns the real upstream answer instead of a cancelled
  stream, and a caller abort always rethrows.
- `src/adapters/cursor/http1-bidi.ts` — the Cursor HTTP/1.1 bridge throws `cursorHttp1Error`, which
  carries the structured `status` on every failure (the typed field attaches even when no
  `Retry-After` is present, so the lane never degrades to message-regex recovery on a plain
  503/429), plus a sanitised `retry-after` header: only a valid instruction is forwarded — finite
  non-negative seconds verbatim, decimals preserved (1.5 s is never rounded down to an early send at
  1.0), an HTTP-date preserved, nothing truncated at 86400, a value over the 128-char header cap
  dropped — and the message text carries no secret.
- `src/providers/zed.ts` — the Zed 401 token-refresh protocol replay is gated by optional
  `options.shouldReplay`: the budget-carrying model closure (`src/adapters/zed.ts`) passes a
  ledger-remaining guard. The first 401 arrives after its own send was already spent: the gate
  decides the replay, so with one total sends and none remaining it returns false and the first 401
  is handed back intact with its body — cancelling it first and then throwing a synthetic budget
  error would bury the real upstream answer. Callers without the gate keep the replay-once
  semantics of the 401 path verbatim.
- `src/lib/sidecar-model-retry.ts` — model inference behind sidecars (`src/vision/describe.ts`,
  `src/web-search/loop.ts`, `src/images/loop.ts`). `fetchSidecarModel` is the single entry:
  `sidecarModelRetryAttempts` resolves the budget, and with a caller-held `sendBudget` the authority is
  that ledger's policy total, spent through `SendBudgetExhaustedError` when exhausted rather than
  laundered as an upstream failure. A caller-supplied `onSendsConsumed` reporter owns the accounting.
  Web scraping, third-party search APIs and auth refresh keep their own narrow policies and do not
  route through this leaf.
- `src/server/responses/model-error-preflight.ts` — the runTurn preflight replay gate. The lane
  previously recovered only 401/429 (key and OAuth rotation); `isModelHttpErrorForPreflight` admits
  the full 400..599 set for same-target, same-credential retries. A structured finite status in range
  is required and ambiguous-reset codes are excluded. Excluded are the exact local-refusal code list
  in `model-error-preflight.ts` — the budget, storage, input, tool-catalog, local-destination and
  client-cancel families (representative codes: `request_send_budget_exhausted`,
  `spend_ledger_storage_unavailable`, `client_closed_request`; the source's `LOCAL_REFUSAL_CODES`
  set is the authority and the list is not copied here so it cannot drift). Deliberately **not**
  excluded: an upstream `cyber_policy` 4xx, which is a real origin answer under the all-4xx/5xx
  mandate, and an upstream `retryable: false` / `x-should-retry` hint, which is never a veto
  (2026-10-23 user ruling: an upstream hint does not exempt the local retry obligation). The gate
  does not rotate accounts, change credentials, or touch pin/credit/spend policy.
- `src/server/responses/capacity-pre-output.ts` — the bounded HTTP/SSE pre-output projection: the
  sibling of the WebSocket #6969 behaviour. A 200 event-stream whose structured 4xx/5xx terminal
  (bare `error` frame, empty `response.failed`) arrives before any committed output becomes a gateway
  status plus JSON body so the outer ladder sees a rejection it can act on; the projection status
  follows what the upstream itself declared, `Retry-After` takes the longest stated lower bound
  (frame headers, response headers, message hint, else `OCX_OVERLOAD_RETRY_AFTER_SEC`). Committed
  output, response-id conflicts, `stream_id` frames, local non-replayable marks, caller aborts, and
  every bound breach (64 KiB / 512 frames / 2 s window from observation start, strict UTF-8, parse
  and read errors) pass the original stream through byte for byte. `restorePreOutputError` rebuilds
  the original stream single-use; `disposePreOutputError` releases the upstream reader.
  `tests/responses/responses-capacity-pre-output.test.ts` covers it.
- `src/lib/response-disposal.ts` — the `Response -> cleanup` registry the ladder uses when it discards
  a synthesized projection, whose body is already consumed so `cancel()` would not reach the upstream
  reader. `registerResponseDisposal` overwrites (one response, one disposer); `disposeResponse` is
  single-shot; `removeResponseDisposal` detaches without invoking, which is what a restored stream needs
  so a later dispose cannot kill a delivered stream.
- `src/lib/model-retry-scope.ts` — the deferral scope: `runModelRetryScope` queues the **persistence
  commits** of automatic account pause while a retry ladder runs, flushing at the outermost exit
  (return, throw, abort), so mid-ladder 401s cannot self-truncate the request's own send budget.
  Queued commits may be async and are awaited, in enqueue order, before `run` resolves; a scope that
  already flushed counts as inactive, so a late commit executes immediately instead of disappearing
  into a queue that will never flush. Reentrant and idempotent (inner runs share the outermost owner;
  flush is once and never throws). Explicit user pause, revocation, and generation/fence changes
  commit immediately and are unaffected. The mount point is the **handler boundary**: `handleResponses`
  in `src/server/responses/core.ts` wraps the implementation in the scope, so per-leg helper scopes and
  combo child requests reenter it and one flush belongs to the handler; the same wrapper sits at the
  three native handlers (`src/server/chat-native.ts`, `src/server/messages-native.ts`,
  `src/server/responses/compact.ts`). `tests/lib/model-retry-scope.test.ts` pins the queue semantics and
  `tests/oauth/oauth-account-auto-pause-deferral.test.ts` the pause contract inside a scope; the
  deferral policy is also described in [account auto-pause](../account-auto-pause.md).

## Boundaries that do not replay

- Caller abort: the run stops and no further send is issued.
- Local refusals (send budget exhausted, spend-ledger storage, input admission, pacing, byte-accounting
  413, key-scope and subscription-cooldown refusals): produced by this process, never retried, never
  laundered as an upstream failure. A `cyber_policy` 4xx from the origin is an upstream answer and
  retries like any other 4xx.
- Committed output: once upstream content has reached the client (an output snapshot, a delta,
  `output_index`, positive usage, `response.completed`/`response.incomplete`, an unknown event name, or
  a frame carrying `stream_id`), the stream is passed through and the request is not replayed.
- Ambiguous transport resets stay non-replayable.

## Known limits against a strict "every failure retries" reading

The raw-HTTP mandate (400..599 retried within the budget) is implemented on the dispatch lane, the
adapter shells, the native lanes, the sidecars and the runTurn preflight gate. The three limits
below are the named exceptions to that mandate, not a general hedge;
closing them needs an owner-level restart-protocol decision.

- **Native-control WebSocket multi-response channels**: only a refusal on the **first frame** is
  replayable. An `error` that arrives after `response.created` on a native-control exchange is not
  held and not retried — the ownership boundary that keeps a live control channel from being restarted
  mid-exchange wins over the retry mandate. Recorded here as a known limitation, not a defect to hide.
- **Bounded pre-output window on HTTP/SSE**: the projection observes at most 64 KiB, 512 frames and a
  2 s window (measured from the start of observation, not extended by heartbeats). A terminal refusal
  that arrives **after** the window closes with no committed output is delivered as-is and is not
  inspected, so it is not retried. `tests/responses/responses-capacity-pre-output.test.ts` proves the
  bound and the pass-through; it does not represent a promise about late failures.
- **Nothing after committed output is replayed** (§Boundaries). A refusal that follows delivered output
  ends the request on the delivered stream.

Consequently no path claims exactly 11 sends: 11 is the funded ceiling, the floor applies to the
configured count, and the limits above plus local refusals and aborts end runs earlier.

## Counting

The budget counts the model upstream requests issued **inside one logical proxy request** (first send
plus retries, default ceiling 11). It is not the number of requests a session exchanges with the proxy:
multi-turn conversations, tool-loop continuations, sub-agent concurrency, and the client's own retries
each count separately. Reading capacity benefit across those layers multiplies and overstates.
