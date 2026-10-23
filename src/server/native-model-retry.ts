/**
 * 三条 native 模型 lane（Chat Completions、Anthropic Messages、Responses compact）共用的
 * 统一重试预算算术（fork 新增 leaf；owner: implement_model_retry_native_paths）。
 *
 * 用户合同（2026-10-23）：模型请求收到真实上游 HTTP 4xx/5xx（任意 code/message，不因上游
 * x-should-retry 提示提前 fatal）时，必须在统一预算内重试至少 10 次（= 11 次物理发送，含
 * 首发）。预算是**一个逻辑请求**的：同账号阶梯、429 同 key 重发、key/OAuth 轮换、换账号
 * alternate 全部从同一个 ledger 扣减，不存在每账号 11 或层间相乘。
 *
 * 三个量：
 * - authority（本请求的绝对发送上限）：max(modelRequestMaxAttempts()（env>config>11 的统一
 *   地板），budget.policy.maxTotalModelSends)。ingress 自有预算在 createInferenceSendBudget
 *   已 fund 到同一数；combo 派生 scope 的更小总额在这里保留，由 ledger 相交兜底。
 * - configuredAttempts（provider 的 transientRetryOn5xx.attempts）只能**上抬** authority，
 *   不能下压：显式 attempts:3 被地板抬到 11（root 裁决「不得少于 10」）。
 * - 某条 leg 的剩余 = transientSendCapFor(configured, 已用, authority)：绝对上限减去整个逻辑
 *   请求已发生的物理发送，绝不每条 leg 重新计数。
 *
 * MUST stay a leaf: 只 import 全局 leaf 与 pipeline owner 的 cap 算术，不 import server 入口。
 */
import { modelRequestMaxAttempts } from "../lib/model-request-retry";
import type { RequestExecutionBudget } from "../lib/request-execution-budget";
import { transientSendCapFor } from "./responses/request-send-budget";

/**
 * 本逻辑请求的统一模型发送上限（attempt 口径，含首发）。
 *
 * 读 budget 的**实时** funded 总额，**原样尊重**：ingress 预算在 createInferenceSendBudget
 * 已 fund 到统一数（11..101，expandInferenceOAuthSendBudget 抬过时读到的就是抬后的值）；
 * 显式 caller / combo 派生 scope 的更小硬上限（如 4）是调用方的精确合同，绝不用地板抬升它。
 * 只有 funded 非有限或为负（畸形/无上限）时才退化为统一 leaf 值，预算层自己的校验负责拒绝畸形值。
 */
export function nativeModelAuthorityAttempts(budget: RequestExecutionBudget): number {
  const funded = budget.policy.maxTotalModelSends;
  return Number.isFinite(funded) && funded >= 0
    ? Math.floor(funded)
    : modelRequestMaxAttempts();
}

/**
 * 一条发送 leg 现在被允许发起的物理发送数：统一上限扣掉本逻辑请求已经发送的。
 *
 * legSendsUsed 传调用方 lane 自己计的 transientSendsUsed（与 budget.used 同向）。取两者较大值
 * 是保守方向：任何一套记账看到的花费都会削减剩余，不存在「两套各算各的」相乘。
 */
export function nativeModelSendsRemaining(
  budget: RequestExecutionBudget,
  legSendsUsed: number,
  configuredAttempts?: number,
): number {
  const authority = nativeModelAuthorityAttempts(budget);
  const used = Math.max(0, Math.floor(legSendsUsed), Number.isFinite(budget.used) ? Math.floor(budget.used) : 0);
  // The unified authority is the HARD absolute (model config + ledger). A provider
  // `transientRetryOn5xx.attempts` larger than it (the legacy opt-in ladder) may not widen
  // the model cap: `transientSendCapFor` floors at the authority, and the intersection with
  // `authority - used` clamps the configured value back down. `remainingBaseSends` intersects
  // the ledger view, so a prepaid booking made by another owner of the shared counter is
  // already deducted here too.
  return Math.max(0, Math.min(
    authority - used,
    transientSendCapFor(configuredAttempts, used, authority),
    budget.remainingBaseSends(authority),
  ));
}
