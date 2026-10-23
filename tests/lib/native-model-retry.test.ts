/**
 * 统一模型重试 leaf 算术（src/server/native-model-retry.ts）：一个逻辑请求一个发送上限，
 * funded 精确合同不被抬、地板统一 11、env/config 只能上抬、跨 leg 扣减单调。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRequestExecutionBudget, CODEX_TEXT_GUARDED_BUDGET_POLICY } from "../../src/lib/request-execution-budget";
import { nativeModelAuthorityAttempts, nativeModelSendsRemaining } from "../../src/server/native-model-retry";
import { modelRequestMaxAttempts } from "../../src/lib/model-request-retry";

const ENV_KEY = "OCX_MODEL_REQUEST_MAX_RETRIES";
let previousEnv: string | undefined;
afterEach(() => {
  if (previousEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousEnv;
});
function setEnv(value: string | undefined): void {
  previousEnv = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
}

describe("nativeModelAuthorityAttempts", () => {
  test("an ingress budget funded by the unified leaf reads back the funded total", () => {
    setEnv(undefined);
    const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 11, baseSendAllowance: 11 });
    expect(nativeModelAuthorityAttempts(budget)).toBe(11);
  });

  test("an exact caller budget keeps its hard cap: a funded 4 is never raised to the 11 floor", () => {
    // The floor lives at the ingress fund (createInferenceSendBudget). A caller that hands the
    // lane its OWN precise policy (fixtures, exact-cap providers) is a hard contract: the lane
    // must respect 4 sends, not widen them.
    setEnv(undefined);
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    expect(budget.policy.maxTotalModelSends).toBe(4);
    expect(nativeModelAuthorityAttempts(budget)).toBe(4);
  });

  test("env raises the authority a fresh ingress budget will fund", () => {
    setEnv("20");
    const attempts = modelRequestMaxAttempts();
    expect(attempts).toBe(21);
    expect(nativeModelAuthorityAttempts(
      createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: attempts, baseSendAllowance: attempts }),
    )).toBe(21);
  });
});

describe("nativeModelSendsRemaining", () => {
  test("counts every prior physical send of the logical request against the one cap", () => {
    setEnv(undefined);
    const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 11, baseSendAllowance: 11 });
    expect(nativeModelSendsRemaining(budget, 0)).toBe(11);
    expect(nativeModelSendsRemaining(budget, 3)).toBe(8);
    // budget.used is the shared ledger; the lane-local count is the reporter view. The
    // remaining takes the MAX of the two usages: any accounting that saw spend shrinks
    // the leg, and two half-counters can never re-fund a spent request.
    budget.used = 7;
    expect(nativeModelSendsRemaining(budget, 2)).toBe(4);
    budget.used = 11;
    expect(nativeModelSendsRemaining(budget, 11)).toBe(0);
  });

  test("a ledger that spent past the authority floors the remainder at zero", () => {
    setEnv(undefined);
    // A shared ledger can be drained past this lane's authority by sibling owners (combo
    // hops). The remainder is a send count: it floors at 0, never negative - a negative
    // handed to the retry helper normalizes to InvalidSendBudgetError and would lose the
    // real last upstream failure the caller was about to return.
    const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 11, baseSendAllowance: 11 });
    budget.used = 12;
    expect(nativeModelSendsRemaining(budget, 0)).toBe(0);
    expect(nativeModelSendsRemaining(budget, 30, 40)).toBe(0);
  });

  test("a provider-configured attempts may raise the cap and never lower it", () => {
    setEnv(undefined);
    const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 11, baseSendAllowance: 11 });
    // explicit attempts:3 is the pre-fork narrow ladder; the user floor (>=10 retries) wins.
    expect(nativeModelSendsRemaining(budget, 0, 3)).toBe(11);
    // Root ruling: the unified authority is the hard absolute. A legacy provider ladder
    // configured ABOVE it (30 > 11) must not widen the model cap: a 30 here would be a
    // phantom allowance the request-wide ledger can never honour.
    expect(nativeModelSendsRemaining(budget, 0, 30)).toBe(11);
  });

  test("an exact caller cap of 2 bounds every leg to 2 total", () => {
    setEnv(undefined);
    const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 2, baseSendAllowance: 2 });
    expect(nativeModelSendsRemaining(budget, 0, 30)).toBe(2);
    expect(nativeModelSendsRemaining(budget, 1, 30)).toBe(1);
    expect(nativeModelSendsRemaining(budget, 2, 30)).toBe(0);
  });
});
