/**
 * runTurn preflight 的统一模型错误重放门（fork 新增，2026-10-23 用户裁决）。
 *
 * 用户合同：所有真实上游模型 HTTP 4xx/5xx 都必须按统一预算重试（默认 10 次重试 = 11 次
 * 发送，env `OCX_MODEL_REQUEST_MAX_RETRIES` 只可上调，地板 10、上限 100）。这不以状态码
 * 白名单、响应体文案、也不以上游/适配器的 `retryable` 提示为门：4xx/5xx 全量进统一 lane。
 * runTurn lane 的预输出重放此前只对 401/429 白名单恢复（key/oauth 轮换），其余状态一律早
 * 退把错误交给客户端。本 leaf 集中「这个预输出 error 事件是不是可重放的上游模型拒绝」的
 * 判定，供 run-turn-execution 的同目标重放消费；预算算术不在这里——重放发送走与轮换 hop
 * 相同的 reserveCredentialHop/reserveDispatch ledger，绝对上限由请求预算的
 * policy.maxTotalModelSends（统一 fund）相交封顶。
 *
 * 排除项只有两类，且都以结构化标记判定，不以文案判定：
 * 1. 歧义重置族（isNonReplayableUpstreamCode 的三个码：upstream_no_response /
 *    upstream_closed_before_response / upstream_reset_replay_refused）。发送已离手、上游
 *    执行状态未知，RFC 9110 §9.2.2 禁止自动重发非幂等请求；这条否决与预算余量无关。
 * 2. 本进程制造的精确本地拒绝码（代理发送预算、spend-ledger 存储、密钥模型范围、输入准
 *    入、Claude 订阅冷却预检）。这些是本地 admission 决定，不是上游模型 fault，重放只会
  *    放大拒绝。最终 core review（P1）补充四个发出前（never sent to any model upstream）
  *    确定性本地 400 码：unsupported_input_modality（claude-cli/qoder/input-media-guard）、
  *    tool_catalog_invalid（claude-cli/codebuddy/qoder）、cursor_root_envelope_limit、
  *    non_canonical_destination——本地发射、零上游接触，重放=本地风暴。
  *    client_closed_request 同样排除（显式码，499 的本地关闭标记；数字 499 不泛排——
  *    真实上游 499 响应按合同进 lane）。上游 cyber_policy 拒绝不在此列：它是 origin 真实
  *    说出的 4xx，按合同进统一 lane；本地 guard 若与上游同码，由 guard 自 set origin 标记，
  *    门不靠码值全杀。
 *
 * 状态来源纪律：只认事件上显式的 `status`（上游/transport 结构化状态）。从文案推断状态把
 * 一切无状态本地 Error 分类成 502 并全部重放，会把本地故障放大成重试风暴，因此无显式
 * status 的事件不进本门（消息推断的 429 轮换 arm 保持既有形状，不受本门管辖）。
 *
 * 已产生输出后不可整轮重放：调用方在首个有意义事件后不再咨询本门（防重复工具执行）。
 * caller abort 立即停：abortSignal 由调用方在每次重放前检查。
 *
 * MUST stay a leaf: 只 import lib 层，不 import server/ 或 adapters/。
 */
import {
  SEND_BUDGET_EXHAUSTED_CODE,
  SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE,
  parseRetryAfterFromMessage,
} from "../../lib/errors";
import { isNonReplayableUpstreamCode } from "../../lib/upstream-retry";

/** 本 leaf 判定所用的最小事件形状（AdapterEvent 的 error 变体子集，避免类型依赖成环）。 */
export interface ModelErrorPreflightEvent {
  type: "error";
  message: string;
  status?: number;
  code?: string;
  retryable?: boolean;
}

/**
 * 精确本地拒绝码白名单（本进程 admission/storage/scope 决定）。
 *
 * 刻意不含 CYBER_POLICY_ERROR_CODE：上游内容策略拒绝是真实的 origin 4xx，用户合同覆盖全部
 * 4xx/5xx；本地 cyber guard 的排除（若有）由 guard 自己以专属码/标记做，不共用这一个码互杀。
 */
const LOCAL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  SEND_BUDGET_EXHAUSTED_CODE,
  SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE,
  "model_not_allowed_for_key",
  "input_admission_refused",
  "claude_subscription_cooldown",
  // 发出前本地拒绝（P1，最终 core review）：全部在 adapter 本地产生、任何模型发送之前，
  // 重放它们只会对零上游接触的确定性拒绝烧满 10 次重试。逐码精确匹配，不做前缀/文案匹配。
  "unsupported_input_modality",
  "tool_catalog_invalid",
  "cursor_root_envelope_limit",
  "non_canonical_destination",
  // 499 只按这个显式本地码排除（errors.ts 把本地关闭归一到它）；数字 499 不泛排。
  "client_closed_request",
]);

/**
 * 这个预输出 error 事件是否是统一 lane 应重放的上游模型 4xx/5xx？
 *
 * 真 = 事件带显式结构化 status 且落在 400..599 + 非歧义重置码 + 非精确本地拒绝码。
 * `retryable: false` 不再是否决项：上游的 x-should-retry/retryable 提示从不豁免本地重试义务
 * （2026-10-23 用户明确）。401/429 返回 true 时只是「该重」；调用方先让 key/oauth 轮换 arm
 * 消费它们（凭证恢复优先于同目标重试），轮换 arm 拒绝时才落到本门的同目标重放。
 */
export function isModelHttpErrorForPreflight(error: ModelErrorPreflightEvent): boolean {
  if (error.type !== "error") return false;
  const status = error.status;
  if (typeof status !== "number" || !Number.isFinite(status)) return false;
  if (status < 400 || status > 599) return false;
  if (isNonReplayableUpstreamCode(error.code)) return false;
  if (typeof error.code === "string" && LOCAL_REFUSAL_CODES.has(error.code)) return false;
  return true;
}

/**
 * 预输出重放的最早合法发送时刻（毫秒）。
 *
 * runTurn lane 的恢复事件没有响应头可读，上游的 `Retry-After` 指令由 transport 层折进事件消
 * 息（`parseRetryAfterFromMessage` 是既有解析器）。合同是下限语义：指令多久就至少等多久，
 * 绝不提前发送；解析不出指令时返回 0（立即重放）。caller abort 全程可打断等待（调用方用
 * sleepWithAbort）。
 */
export function modelErrorPreflightRetryDelayMs(error: ModelErrorPreflightEvent): number {
  const seconds = parseRetryAfterFromMessage(error.message);
  return seconds === undefined ? 0 : Math.max(0, seconds * 1000);
}
