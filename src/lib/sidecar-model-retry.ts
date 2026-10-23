/**
 * 模型 sidecar 的统一重试入口（fork 新增 leaf）。
 *
 * 运维合同（2026-10-23 用户裁决）：每一次**模型推理调用**（一份请求 body 对应一次逻辑
 * 模型请求）遇到真实上游 HTTP 4xx/5xx 都必须按配置重试，至少 10 次。这一层把合同落到
 * `fetchWithTransientRetry` 的 model lane 上，集中三件在调用点各写一遍必然漂移的事：
 *
 * 1. 预算源头只有一个：有共享账本时权威是账本 policy 的 `maxTotalModelSends`（ingress 由
 *    `config.modelRequestMaxRetries` fund，env 在 leaf 内压过配置），无账本的独立调用才读
 *    `modelRequestMaxAttempts(configured)`。lane 内 transient 与 connection-reset 两层共享
 *    同一个 attempts 总额（外层 helper 的单一预算语义），不逐层相乘。
 * 2. 记账所有权只选一：调用方自带 reporter（`opts.onSendsConsumed`）时它已绑好账本，本层
 *    原样透传、绝不二次上报；调用方无 reporter 而有共享账本时，用现成的
 *    `createPhysicalSendReporter` 建一个 —— 它在 enforced 路径做 beforeSend 物理准入，在
 *    非 enforced 路径内部自己调 `reportDispatchSends`，两条路都只有一个记账人。
 * 3. 非模型请求不从这里走：网页抓取、Exa 这类第三方搜索 API、auth refresh 等保持各自的
 *    窄策略。模型 POST 不幂等，本层不声明 replaySafe：歧义 reset 按现状 settle 成
 *    non-replayable 拒绝，HTTP 错误的重试义务不受影响。
 *
 * 刻意不 import `src/config/**` 与 `src/server/**`：与 `model-request-retry.ts` 同构的纯
 * leaf，配置的 `configured` 由调用方作为标量传入。
 */
import { modelRequestMaxAttempts } from "./model-request-retry";
import {
  fetchWithTransientRetry,
  type TransientRetryOptions,
  type UpstreamSendRecovery,
} from "./upstream-retry";
import {
  createPhysicalSendReporter,
  isRequestExecutionBudget,
  type RequestExecutionBudget,
} from "./request-execution-budget";
import type { SpendScopes } from "./spend-reservation-ledger";

/** 统一模型 lane 的整调用发送总额（env > configured > 地板 10 次重试）。 */
export function sidecarModelRetryAttempts(configuredRetries?: number): number {
  return modelRequestMaxAttempts(configuredRetries);
}

export interface SidecarModelFetchOptions {
  /** 已解析的全局配置值（provider 级折叠由调用方完成）；env 在 leaf 内压过它。 */
  configuredRetries?: number;
  abortSignal?: AbortSignal;
  /** 重试日志的短标签（无密钥、无 query）。 */
  label: string;
  /**
   * 调用方持有的共享请求账本。传入时发送权威是账本 policy 的绝对总额（cap =
   * `policy.maxTotalModelSends`），本腿预算 = cap 与账本剩余额度的交集：spend/workflow
   * 硬上限先到就硬停，其拒绝以 `SendBudgetExhaustedError` 原样上抛，不伪装成上游错误。
   */
  sendBudget?: RequestExecutionBudget;
  /**
   * 调用方自有的发送 reporter（loop/adapter 路径由 `createPhysicalSendReporter` 建好传下）。
   * 提供时它独占记账：本层原样透传给底层 helper，不再创建自己的 reporter。
   */
  onSendsConsumed?: TransientRetryOptions["onSendsConsumed"];
  /** 本层自建 reporter 时的 spend 作用域（poolId/identityId），由调用方从现成上下文带入。 */
  spendScopes?: SpendScopes;
  /** 本层自建 reporter 时的目标键（通常是本轮请求 URL），逐发取当前值。 */
  targetKey?: () => string;
  /**
   * 调用方自报的 `Retry-After` 等待上限（毫秒）。缺省 = Infinity：model lane 把上游点名的
   * 等待当完整下限并一直等（abortable，不 60s 提前 fail）。有显式边界的调用（sidecar 的
   * settings.timeoutMs）传入剩余预算，超出的指令以真实响应收尾——与既有 sidecar 合同一致。
   */
  retryAfterCeilingMs?: number;
}

/**
 * 以统一模型合同执行一次 sidecar 模型调用。
 *
 * model lane 语义由底层 helper 定义：400..599 全状态重试、无 slow-attempt 早退、
 * `Retry-After` 完整下限（缺省 deadline Infinity，caller abort 全程可打断）、本地
 * non-replayable 标记一票否决。预算耗尽时返回最后一次的真实响应（原状态码、原 body，
 * 不伪 429/200）；账本拒绝时抛 `SendBudgetExhaustedError`，调用方原样传播。
 */
export async function fetchSidecarModel(
  doFetch: (recovery?: UpstreamSendRecovery) => Promise<Response>,
  opts: SidecarModelFetchOptions,
): Promise<Response> {
  const shared = isRequestExecutionBudget(opts.sendBudget) ? opts.sendBudget : undefined;
  // 权威优先级：共享账本 policy 的绝对总额 > env > 传入配置 > 地板 10。
  const cap = shared?.policy?.maxTotalModelSends ?? sidecarModelRetryAttempts(opts.configuredRetries);
  const attempts = shared ? shared.remainingBaseSends(cap) : cap;
  // 记账所有权只选一（root 裁决）：caller reporter 优先，其次本层为共享账本建 reporter。
  const onSendsConsumed = opts.onSendsConsumed
    ?? (shared
      ? createPhysicalSendReporter(shared, () => ({
        ...(opts.spendScopes ?? {}),
        targetKey: opts.targetKey?.() ?? opts.label,
      }))
      : undefined);
  return fetchWithTransientRetry(doFetch, {
    modelRetryMode: true,
    attempts,
    abortSignal: opts.abortSignal,
    label: opts.label,
    onSendsConsumed,
    ...(opts.retryAfterCeilingMs !== undefined ? { retryAfterCeilingMs: opts.retryAfterCeilingMs } : {}),
  });
}
