/**
 * 自有 ladder adapter 的统一模型 HTTP 重试壳（fork 新增，owner: small adapters）。
 *
 * 运维合同（2026-10-23）：真实上游返回任何 HTTP 4xx/5xx 都算模型请求出错，必须按配置重试
 * 至少 10 次（默认 11 次物理发送 = 10 次重试 + 首发）。Command Code / Zed / MiMo-free 三条
 * ladder 原本都是「单发 + 一次协议恢复」（401 刷票 / 400 降 ladder）：4xx/5xx 直接交还，
 * 一次都不重。本壳把这三条 ladder 接到统一 lane 上，复用 fetchWithTransientRetry 的
 * modelRetryMode（400..599 全状态门、Retry-After 完整下限等待、caller abort 一票否决、
 * 统一 retry scope），不另造一套循环。auth/refresh/bootstrap 是支持流量，不占模型发送账本。
 *
 * **单一 ledger，不相乘**：预算权威是共享 RequestExecutionBudget 的
 * policy.maxTotalModelSends（ingress fund 的绝对总额；显式小上限——含 0——原样尊重，
 * 绝不用统一地板抬升它）。每物理发送的硬闸是 createAdapterPhysicalSend → reserveDispatch；
 * lane 的 attempts 只是轮次数上界，beforeSend 每轮发送前再读账本实时剩余，任何嵌套形状
 * 的总物理发送都被同一个绝对值封顶。context-free 调用（adapter 单测）在壳内现场创建一个
 * cap=统一请求额（默认 11）的真实预算，所以 context-free 也精确止于 11 发。
 *
 * **每轮单物理发**（root 裁决）：协议恢复（401 刷票 / 400 降 ladder）在轮内只做解析与
 * 本地状态更新（换新 header / 换修复后的 body），重发交还下一轮的统一 lane；轮次与模型
 * 物理发送一一对应。唯一例外是 Zed：401 重放在 zedLlmFetch 内部（其自有协议），该轮可花
 * 2 次物理发送——provider 侧以 shouldReplay 门控（账本无剩余发送时不取消 first 401、不发
 * 第二发，完整 401 原样交还），两发全部经同一个 send 闭包记账，外层 attempts 是剩余发送
 * 数下界的安全上界。
 *
 * 终态语义：lane 决定重试时会取消上一轮响应 body，随后预算闸（beforeSend / reserveDispatch）
 * 才拒——所以本壳对每个非 2xx 响应在返回后即时留**一份**有界快照（对 clone 的单次有界读，
 * 原响应 body 不消费、留给 lane 的正常生命周期：重试前取消、终态交还时完好；快照为
 * status/statusText/headers 原样 + body ≤64 KiB 文本，超界/非 UTF-8/不可显示以空 body 交还，
 * 状态码与错误头仍保真），预算抛错出口交还快照：不交出已取消的空流，也不合成预算错误盖掉
 * 真实答案。adapter 闭包一律返回**原响应**（协议谓词需要 body 时自行读安全 clone），
 * 快照只作为 catch 出口的底本。一次真实响应都没有时预算错误原样上抛；
 * caller abort 恒上抛 abort 错误（外层 handler 负责 499）。
 */
import type { AdapterFetchContext } from "./base";
import { createAdapterPhysicalSend } from "./physical-send";
import { abortError, fetchWithTransientRetry, SendBudgetExhaustedError } from "../lib/upstream-retry";
import { modelRequestMaxAttempts } from "../lib/model-request-retry";
import { createRequestExecutionBudget } from "../lib/request-execution-budget";
import { BOUNDED_BODY_MAX_BYTES, readBoundedResponseBody } from "../lib/bounded-body";

/** createAdapterPhysicalSend 返回的发送闭包；一轮 ladder 的物理发送经它记账。 */
export type AdapterPhysicalSend = ReturnType<typeof createAdapterPhysicalSend>;

/** 传给一轮 ladder 的预算视图：轮内恢复动作在改写本地状态前自查剩余额度。 */
export interface ModelRetryLane {
  /** 本逻辑请求的剩余模型发送数（绝对总额 − 已用）。<=0 表示预算内已无发送可用。 */
  sendsRemaining(): number;
}

function remainingSends(budget: AdapterFetchContext["sendBudget"]): number {
  const total = budget?.policy.maxTotalModelSends;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return Number.POSITIVE_INFINITY;
  const used = budget?.used;
  return Math.max(0, Math.floor(total - (typeof used === "number" && Number.isFinite(used) ? used : 0)));
}

/**
 * 进入 lane 时的轮次数（每轮 1 物理发时等于剩余发送数）：共享预算的绝对剩余，
 * 显式 cap（含 0）原样；无预算时统一 leaf 默认（env OCX_MODEL_REQUEST_MAX_RETRIES > 地板 10 → 11）。
 * 纯函数，导出供测试钉住「显式小 cap 不被抬升」与 context-free 默认 11 这两条裁决。
 */
export function modelHttpRetryAttempts(ctx: AdapterFetchContext = {}): number {
  if (ctx.sendBudget) return remainingSends(ctx.sendBudget);
  return modelRequestMaxAttempts();
}

/**
 * 把一次真实上游响应转成可读快照：status/statusText 原样，header 去掉逐跳与长度头，
 * body 以至多 64 KiB 文本重放（超界/非文本以空 body 交还）。run 闭包对每个非 2xx 即时调用，
 * 让预算抛错出口仍能交还真实的状态码与错误 body（原 body 随后可被 lane 取消）。
 */
export async function snapshotResponse(response: Response, signal?: AbortSignal): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  let text = "";
  let captured = false;
  try {
    const observed = await readBoundedResponseBody(response.clone(), {
      ...(signal ? { signal } : {}),
      maxBytes: BOUNDED_BODY_MAX_BYTES,
    });
    captured = observed.displaySafe && !observed.oversized;
    if (captured) text = observed.text;
  } catch { /* status-only snapshot */ }
  return new Response(captured && text ? text : null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * 用统一预算跑一条自有 ladder：run 每轮被调用一次，每轮**一次模型物理发送**，经传入的
 * send（createAdapterPhysicalSend，同一 fetchResponse 调用内共享 ordinal 序列）记账。
 * run 一律返回**原响应**（非 2xx 的协议谓词读 response.clone()，不消费原 body）；
 * 本壳对非 2xx 留一份 catch 快照，lane 决定重试时按原样取消/交还原响应。
 *
 * fallback 透传给 createAdapterPhysicalSend（Command Code 用 provider 注入的 fetch）。
 */
export async function fetchModelHttpResponseWithRetry(
  run: (send: AdapterPhysicalSend, lane: ModelRetryLane) => Promise<Response>,
  ctx: AdapterFetchContext = {},
  options: { label: string; fallback?: typeof globalThis.fetch },
): Promise<Response> {
  // context-free 调用现场创建一个真实共享预算：cap 是统一请求额本身（默认 11），不是轮次配额。
  const laneCtx: AdapterFetchContext = ctx.sendBudget
    ? ctx
    : (() => {
        const attempts = modelRequestMaxAttempts();
        return { ...ctx, sendBudget: createRequestExecutionBudget({
          maxTotalModelSends: attempts,
          baseSendAllowance: attempts,
          finalRecoveryAllowance: 0,
          maxAlternateTargetSends: 0,
          maxTargetTransitions: 0,
        }) };
      })();
  const lane: ModelRetryLane = { sendsRemaining: () => remainingSends(laneCtx.sendBudget) };
  const send = createAdapterPhysicalSend(laneCtx, options.fallback ?? globalThis.fetch);
  let snapshot: Response | undefined;
  try {
    return await fetchWithTransientRetry(
      async () => {
        const response = await run(send, lane);
        // 单点快照（catch 出口的底本）：clone 读取，原响应生命周期仍归 lane（重试前取消、
        // 终态完好交还）。协议恢复谓词在 run 内读自己的安全 clone，与此快照互不消费。
        if (!response.ok) snapshot = await snapshotResponse(response, ctx.abortSignal);
        return response;
      },
      {
        modelRetryMode: true,
        // 显式 cap 0 就是 0：预算层自己拒绝首发，不在这里抬升。
        attempts: modelHttpRetryAttempts(laneCtx),
        ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        label: options.label,
        // 每轮发送前自查共享账本实时剩余（物理发送记账单点在 reserveDispatch，这里不重复计数）：
        // 剩余额度 0 时在发送前拒绝；此刻上轮响应已有快照底本，出口交还快照。
        onSendsConsumed: Object.assign(() => {}, { beforeSend: () => lane.sendsRemaining() > 0 }),
      },
    );
  } catch (error) {
    // caller abort 恒上抛：外层已有 499 语义，绝不返回被 lane 取消过的 body。
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    // 预算在发送前拒绝：交还最后一次真实响应的快照（status/headers/body≤64KiB 保真）。
    if (error instanceof SendBudgetExhaustedError && snapshot) return snapshot;
    throw error;
  }
}
