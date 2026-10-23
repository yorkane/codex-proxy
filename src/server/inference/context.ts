import { CODEX_TEXT_GUARDED_BUDGET_POLICY, createRequestExecutionBudget, type RequestExecutionBudget } from "../../lib/request-execution-budget";
import { modelRequestMaxAttempts } from "../../lib/model-request-retry";
import { TRANSIENT_RETRY_MAX_ATTEMPTS, type TransientSendBudget } from "../../lib/upstream-retry";
import { GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST } from "../../oauth/generic-account-failover";
import type { RequestLogContext } from "../request-log";
import { attachRequestSpendTracker } from "../responses/request-spend";

// Only ingress owns an expandable policy. Exact caller budgets and combo-derived scopes
// never enter this map, even when their policy happens to equal the default profile.
const ingressPolicies = new WeakMap<TransientSendBudget, {
  maxTotalModelSends: number;
  baseSendAllowance: number;
}>();

/**
 * The one construction of an ingress-owned send budget: the default guarded policy, no logical
 * request id, and this request's spend tracker as the send observer. Attaching the tracker
 * parks it on `logCtx`, so callers that inherit a holder must not call this at all.
 *
 * 统一模型请求 lane（fork）：ingress 自有预算在首发前直接 fund 统一额——
 * `maxTotalModelSends = baseSendAllowance = modelRequestMaxAttempts(configured)`
 * （默认 11 = 10 次重试 + 首发，env `OCX_MODEL_REQUEST_MAX_RETRIES` 优先，上限 100）。
 * reserve/alternate/transition 三项语义不变（1/1/1）：换账号仍是唯一一次，总额是包含
 * 关系的绝对上限，不存在「11 + 4」的叠加。显式 caller 预算与 Combo 派生 scope 不经过
 * 这里，其精确性由共享 ledger 相交保持；`configuredRetries` 只抬不降（leaf 地板钳 10）。
 */
export function createInferenceSendBudget(
  req: Pick<Request, "headers">,
  logCtx: RequestLogContext,
  configuredRetries?: number,
): RequestExecutionBudget {
  const attempts = modelRequestMaxAttempts(configuredRetries);
  const policy = {
    ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
    maxTotalModelSends: attempts,
    baseSendAllowance: attempts,
  };
  const budget = createRequestExecutionBudget(policy, undefined, attachRequestSpendTracker(req, logCtx));
  ingressPolicies.set(budget, policy);
  return budget;
}

/**
 * Fund each account's normal transient ladder once, before the first physical send. The account
 * count is clamped here as well as at the caller, so no caller can raise the ceiling past
 * GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST × TRANSIENT_RETRY_MAX_ATTEMPTS.
 *
 * 统一模型请求 lane（root 2026-10-23 裁决）：抬升被钳在本预算**已权威的**
 * `maxTotalModelSends` 之内——ingress 构造时就是统一权威额（默认 11），roster 抬升
 * 只在权威之下的旧形态里有效（例如 caller 显式 fund 的窄 policy），4 账号 × 3 = 12
 * 或 5 账号 = 15 顶不破 11 总盘。统一 lane 里它因此是恒等（no-op）：总额语义从
 * "roster 数 × 阶梯"迁移到了单一权威数字。
 */
export function expandInferenceOAuthSendBudget(budget: TransientSendBudget | undefined, accounts: number): void {
  if (!budget) return;
  const policy = ingressPolicies.get(budget);
  if (!policy || budget.used !== 0 || ("physicalStarted" in budget && Number(budget.physicalStarted) > 0)) return;
  ingressPolicies.delete(budget);
  if (accounts < 2 || !Number.isSafeInteger(accounts)) return;
  const rosterSends = Math.min(accounts, GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST) * TRANSIENT_RETRY_MAX_ATTEMPTS;
  const sends = Math.min(rosterSends, policy.maxTotalModelSends);
  policy.baseSendAllowance = Math.max(policy.baseSendAllowance, sends);
  policy.maxTotalModelSends = Math.max(policy.maxTotalModelSends, sends);
}
