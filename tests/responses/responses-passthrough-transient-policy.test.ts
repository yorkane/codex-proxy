import { describe, expect, test } from "bun:test";
import { readResponsesCoreModule } from "../helpers/responses-core-source";
import {
  createResponsesSendBudget,
  transientSendCapFor,
} from "../../src/server/responses/request-send-budget";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { TRANSIENT_RETRY_MAX_ATTEMPTS } from "../../src/lib/upstream-retry";
import type { RequestLogContext } from "../../src/server/request-log";
import type { ResponsesRequestContext } from "../../src/server/responses/core-options";

/** Whitespace-independent, so reformatting a call site cannot silently retire an assertion. */
function dense(source: string): string {
  return source.replace(/\s+/gu, "");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * #4893. A provider's `transientRetryOn5xx` never reached the Responses passthrough lane.
 *
 * `createResponsesPassthroughAdapter` sets `passthrough: true`, and `core.ts` returns into
 * `executePassthroughResponse` on that flag before the three call sites that read
 * `transientRetryPolicyFor` are ever constructed. This file hard-codes nothing else: it asserts
 * that every send this lane makes takes its ladder from the provider policy, so the fix cannot
 * regress by one call site being left on the constant -- which is exactly how the defect looked,
 * with four sites in one file all passing `TRANSIENT_RETRY_MAX_ATTEMPTS`.
 */
describe("the Responses passthrough lane reads the provider transient policy", () => {
  const source = readResponsesCoreModule("passthrough-dispatch.ts");
  const packed = dense(source);

  test("the ladder is resolved from the provider row, not a constant", () => {
    expect(packed).toContain(dense(
      "const transientSendPolicy = () => transientRetryPolicyFor(route.provider);\n"
      + "const transientSendAttempts = (): number => transientSendCapFor(\n"
      + "  transientSendPolicy()?.attempts,\n"
      + "  sendBudgetState.targetSendsUsed,\n"
      + "  sendBudgetState.requestModelSendLimit,\n"
      + ");",
    ));
  });

  test("every transient-retry send takes its attempts from that resolver", () => {
    // Every helper this lane sends through, not just the one it started with. The post-header
    // replacement reaches upstream exactly like the legs above it and has to draw on the same
    // resolver; counting only `fetchWithTransientRetry` would let a second send helper be added
    // on the constant while this file still reported balance.
    const sites = occurrences(packed, "fetchWithTransientRetry(")
      + occurrences(packed, "refetchAfterProtocolSafeReset(");
    // The lane's initial send plus its recovery legs. A site that stops being counted here is a
    // site that stopped being governed by the policy.
    expect(sites).toBeGreaterThanOrEqual(4);

    const budgeted = occurrences(packed, "attempts:remainingTransientSendBudget(transientSendAttempts())");
    const allowanceBacked = occurrences(packed, "attempts:allowance.attempts");
    const prepaidInitial = occurrences(packed, "attempts:sendBudgetState.initialSendAllowance(transientSendAttempts())");
    expect(prepaidInitial).toBe(1);
    // Combo-owned, non-enforced sends settle at physical dispatch; every other send keeps the
    // shared reporter, so exactly one of the two accounts for any given send.
    expect(packed).toContain("onPhysicalDispatch:receiptMode?sendBudgetState.noteInitialDispatch:undefined");
    expect(packed).toContain("...(receiptMode?{}:{onSendsConsumed:transientSendReporter()})");
    expect(budgeted + allowanceBacked + prepaidInitial).toBe(sites);

    // The rebuild leg spends a recovery allowance rather than the base budget directly, so its
    // cap has to come from the same resolver one level up.
    expect(occurrences(packed, "recoverySendAllowance(transientSendAttempts(),")).toBe(allowanceBacked);
  });

  test("no dispatch or exhaustion check is left on the fixed constant", () => {
    expect(packed).not.toContain("remainingTransientSendBudget(TRANSIENT_RETRY_MAX_ATTEMPTS)");
    expect(packed).not.toContain("recoverySendAllowance(TRANSIENT_RETRY_MAX_ATTEMPTS,");
    // The exhaustion predicate has to ask at the SAME cap the sends use. Asking at the constant
    // while dispatching at a configured value is how a request with headroom gets told it is
    // spent, and how one configured below the constant passes the check and is then refused.
    const checks = occurrences(packed, "sendBudgetExhausted(");
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(occurrences(packed, "sendBudgetExhausted(transientSendAttempts())")).toBe(checks);
    expect(packed).not.toContain("sendBudgetExhausted()");
  });
});

function sendBudgetFor(budget: ReturnType<typeof createRequestExecutionBudget>) {
  const state = createResponsesSendBudget({
    options: { sendBudget: budget } as unknown as ResponsesRequestContext["options"],
    req: new Request("http://127.0.0.1/v1/responses"),
    logCtx: {} as unknown as RequestLogContext,
  });
  if (state instanceof Response) throw new Error("unexpected workflow refusal");
  return state;
}

/**
 * The budget half of the same issue.
 *
 * A configured `attempts` is documented as the TOTAL sends for one request including the first,
 * so the cap each leg receives is that total minus what the request has already sent. Passing the
 * configured value straight through would make it a per-leg ceiling instead, and a provider
 * configured at one send could still reach upstream again on a recovery leg.
 *
 * The result is then intersected with the request-wide base allowance by `remainingBaseSends`.
 * That intersection is the deliberate settlement the issue asked for: an operator can narrow this
 * request's sends exactly, and cannot widen the bound that exists to stop per-request
 * amplification (#4546).
 */
describe("a configured ladder is bounded by the request budget", () => {
  test("an absent policy resolves to the unified authority, reduced by sends used", () => {
    // root design 2026-10-23: the model lane floors every leg at the unified authority
    // (modelRequestMaxAttempts: env OCX_MODEL_REQUEST_MAX_RETRIES > config > 10 retries +
    // first send = 11). An absent provider policy no longer resolves to the old constant 3;
    // it resolves to 11 - used, and the request ledger remains the absolute bound.
    for (const used of [0, 1, 2, 3, 9]) {
      expect(transientSendCapFor(undefined, used)).toBe(11 - used);
    }
  });

  test("an exact authority total is measured against what the request already sent", () => {
    // root design 2026-10-23: a provider row alone can no longer narrow the lane below the
    // floor (see the floor rows). Exact per-request totals live in the third argument -- the
    // caller's own authority (its ledger's policy total) -- and keep the subtraction contract:
    // an exact one-send request that already sent once may not dispatch a later leg.
    expect(transientSendCapFor(1, 0, 1)).toBe(1);
    expect(transientSendCapFor(1, 1, 1)).toBe(0);
    expect(transientSendCapFor(5, 2, 5)).toBe(3);
    expect(transientSendCapFor(5, 9, 5)).toBe(0);
  });

  test("a lower configured value cannot end the ladder the floor continues", () => {
    // root design 2026-10-23 inverts this row's old shape: `attempts: 1` no longer ends the
    // request at one send -- the unified floor (11) wins over a provider row that asks for
    // less, and exhaustion follows the shared ledger. The same request is fundable at one
    // send and refuses only when its ledger allowance is spent.
    const budget = createRequestExecutionBudget();
    const state = sendBudgetFor(budget);

    expect(state.sendBudgetExhausted(transientSendCapFor(1, state.sendsUsed))).toBe(false);
    budget.used = 1;
    // A configured `attempts: 1` cannot make the request exhausted at one send.
    expect(state.sendBudgetExhausted(transientSendCapFor(1, state.sendsUsed))).toBe(false);
    // The ledger is the bound: with the guarded caller's three base sends spent, it is.
    budget.used = 3;
    expect(state.sendBudgetExhausted(transientSendCapFor(1, state.sendsUsed))).toBe(true);
  });

  test("a higher configured value does not lift the request-wide allowance", () => {
    const budget = createRequestExecutionBudget();
    const state = sendBudgetFor(budget);

    // The guarded profile allows three base sends per logical request.
    expect(state.remainingTransientSendBudget(transientSendCapFor(10, state.sendsUsed))).toBe(3);
    budget.used = 2;
    expect(state.remainingTransientSendBudget(transientSendCapFor(10, state.sendsUsed))).toBe(1);
    // A narrower configured value no longer wins: the floor lifts its cap to 11, and the
    // ledger's own remainder (3 base - 2 used = 1) is what bounds the send.
    expect(state.remainingTransientSendBudget(transientSendCapFor(2, state.sendsUsed))).toBe(1);
  });

  test("a configured one-send total cannot draw the final recovery reserve", () => {
    const budget = createRequestExecutionBudget();
    const state = sendBudgetFor(budget);

    state.noteTransientSends(1);
    // An exact one-send authority (third argument, not a provider row) spends the request:
    // root design 2026-10-23 keeps exact caller totals exact; only provider rows are floored.
    const cap = transientSendCapFor(1, state.sendsUsed, 1);
    expect(cap).toBe(0);

    // Compose the real rebuild allowance rather than checking only the exhaustion predicate.
    const allowance = state.recoverySendAllowance(
      cap,
      "repair",
      "provider|model|reasoning-effort-downgrade",
      { allowFinalRecoveryReserve: false },
    );
    expect(allowance).toEqual({ attempts: 0 });
    expect(budget.used).toBe(1);
    expect(budget.reserveSpent).toBe(false);
  });

  test("an unconfigured provider retains the shared final recovery reserve", () => {
    const budget = createRequestExecutionBudget();
    const state = sendBudgetFor(budget);

    state.noteTransientSends(TRANSIENT_RETRY_MAX_ATTEMPTS);
    const cap = transientSendCapFor(undefined, state.sendsUsed);
    const allowance = state.recoverySendAllowance(
      cap,
      "repair",
      "provider|model|reasoning-effort-downgrade",
    );

    expect(allowance.attempts).toBe(1);
    expect(allowance.permit).toBeDefined();
    expect(budget.used).toBe(4);
    expect(budget.reserveSpent).toBe(true);
    allowance.permit?.release();
    expect(budget.used).toBe(3);
    expect(budget.reserveSpent).toBe(false);
  });
});

// The OpenCode Go replaySafe exception is gone for good: the behavioral contract is pinned
// by an execution test in responses-send-budget-counts.test.ts ("an OpenCode Go destination
// refuses an ambiguous pre-answer reset instead of replaying"), which fails if any name for
// the option ever returns.
