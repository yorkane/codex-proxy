/**
 * 过载终态（overload）的重试建议注入（fork 扩展）。
 *
 * 现场形态：ChatGPT 后端以 503 `server_is_overloaded` 拒绝回合，代理把该终态交给客户端。
 * Codex 客户端在 SSE 终态路径上只认**帧体内 `error.headers` 这个 JSON 对象**作为重试指令
 * （codex-rs parse_failed_response → json_headers_to_http_headers），HTTP 响应头在该路径不参与；
 * `ServerOverloaded` 的 retry_delay 在缺少 retry-after 时返回 None，客户端零重试，直接终结为
 * "Selected model is at capacity"。代理合成的 503 同理：`resolveClientRetryAfter` 的合成默认值
 * 只覆盖可重试 429（429-only 门禁），503 拿不到任何等待建议。
 *
 * 本模块只做一件事：终态确属过载类、且建议位置**尚无** retry-after 时，注入一个可配置的建议。
 * 方向是补齐缺失，不是改写上游 —— 上游给了值就原样保留。235 与 177 部署同一个包，两层注入
 * 会叠加，所以幂等（绝不缩短上游值）是硬要求。
 *
 * `OCX_OVERLOAD_RETRY_AFTER_SEC` 是等待秒数（Retry-After 的 delta-seconds 形式），默认 2 秒：
 * 1 秒下 11 次尝试约 11 秒窗口，2 秒约 22 秒，更匹配 ChatGPT 过载恢复的时间尺度，且把过载期
 * 的重放压力减半。非法/非正/非数字回落默认，上限 60 秒钳制 —— 过载期上游无 usage 上报
 * （sendCount=1、不计费），风险是风暴而非配额，钳制上限就是风暴半径的控制参数。
 */

export const OVERLOAD_RETRY_AFTER_SEC_ENV = "OCX_OVERLOAD_RETRY_AFTER_SEC";
export const DEFAULT_OVERLOAD_RETRY_AFTER_SEC = 2;
export const OVERLOAD_RETRY_AFTER_SEC_LIMIT = 60;

/** 过载类错误码：与 `recognizedUpstreamError` 映射到 503 的两个码保持一致。 */
export function isOverloadRetryCode(code: unknown): boolean {
  return code === "server_is_overloaded" || code === "overloaded_error";
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 解析 `OCX_OVERLOAD_RETRY_AFTER_SEC`：非数字/非正回落默认 2 秒，地板取整后钳制到 60。
 * 每次调用读传入的 env，所以测试与运行时的热路径都不需要重建模块。
 */
export function overloadRetryAfterSec(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[OVERLOAD_RETRY_AFTER_SEC_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_OVERLOAD_RETRY_AFTER_SEC;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_OVERLOAD_RETRY_AFTER_SEC;
  const floored = Math.floor(parsed);
  if (floored <= 0) return DEFAULT_OVERLOAD_RETRY_AFTER_SEC;
  return Math.min(OVERLOAD_RETRY_AFTER_SEC_LIMIT, floored);
}

/** 注入用的秒数字符串（HTTP delta-seconds 形式）。 */
export function overloadRetryAfterHeader(
  env: Record<string, string | undefined> = process.env,
): string {
  return String(overloadRetryAfterSec(env));
}

/** 帧内 headers 对象是否已携带合法的 retry-after（HTTP 头名大小写不敏感）。 */
export function hasFrameRetryAdvice(headersField: unknown): boolean {
  if (!plainRecord(headersField)) return false;
  return Object.entries(headersField).some(([name, value]) =>
    name.toLowerCase() === "retry-after" && (typeof value === "string" || typeof value === "number"));
}

/**
 * 给终态事件负载注入过载重试建议；返回 null 表示不改（非终态、非过载码、建议已存在、
 * 建议位置形态不可信）。纯函数、无状态。
 *
 * 注入位置跟随各自的读取路径：`response.failed` 写 `response.error.headers`（及同形
 * `last_error`），这是 codex-rs parse_failed_response 唯一认的通道；裸 `error` 事件写**顶层**
 * `headers`，这是 WS 投影 `rejectionHeaders` 读取的位置。
 */
export function overloadRetryAdviceForTerminal(
  event: unknown,
  retryAfterSec: string,
): Record<string, unknown> | undefined {
  if (!plainRecord(event)) return undefined;
  const type = event.type;
  const response = plainRecord(event.response) ? event.response : undefined;
  if (type === "response.failed") {
    if (response === undefined) return undefined;
    const error = plainRecord(response.error) ? response.error : undefined;
    const lastError = plainRecord(response.last_error) ? response.last_error : undefined;
    // 码的取值顺序与 boundedBareUpstreamError 一致：error 先于 last_error。
    const code = error?.code ?? lastError?.code;
    if (!isOverloadRetryCode(code)) return undefined;
    const targets = [error, lastError].filter(
      (target, index, all): target is Record<string, unknown> =>
        target !== undefined && all.indexOf(target) === index,
    );
    if (targets.length === 0) return undefined;
    // headers 已存在但不是对象时不动：宁可不注入，也不破坏客户端能读的结构。
    if (targets.some(target => target.headers !== undefined && !plainRecord(target.headers))) return undefined;
    const missing = targets.filter(target => !hasFrameRetryAdvice(target.headers));
    if (missing.length === 0) return undefined;
    const patchedResponse = { ...response };
    for (const target of missing) {
      const next = { ...target, headers: { "retry-after": retryAfterSec } };
      if (patchedResponse.error === target) patchedResponse.error = next;
      if (patchedResponse.last_error === target) patchedResponse.last_error = next;
    }
    return { ...event, response: patchedResponse };
  }
  if (type === "error") {
    const error = plainRecord(event.error) ? event.error : undefined;
    const code = error?.code ?? event.code;
    if (!isOverloadRetryCode(code)) return undefined;
    if (event.headers !== undefined && !plainRecord(event.headers)) return undefined;
    if (hasFrameRetryAdvice(event.headers)) return undefined;
    return { ...event, headers: { "retry-after": retryAfterSec } };
  }
  return undefined;
}

/**
 * HTTP 非流式路径的判定：响应体（JSON）是否声明过载类错误码。
 * 只认结构化码，不凭诊断文案猜类别 —— 与裸事件码优先于文案的既有分类规则一致。
 */
export function overloadCodeFromJsonBody(body: string): string | undefined {
  if (!body.includes("server_is_overloaded") && !body.includes("overloaded_error")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!plainRecord(parsed)) return undefined;
  const response = plainRecord(parsed.response) ? parsed.response : undefined;
  const error = plainRecord(parsed.error) ? parsed.error : undefined;
  const responseError = plainRecord(response?.error) ? response!.error : undefined;
  const lastError = plainRecord(response?.last_error) ? response!.last_error : undefined;
  // 码的取值位置与 SSE 侧一致：外层 error 优先，其次 response.error / response.last_error，
  // 最后是顶层 code。文案命中不算（预筛只为了避免为每个 503 都 parse 一次 JSON）。
  return [error?.code, responseError?.code, lastError?.code, parsed.code]
    .find((candidate): candidate is string => typeof candidate === "string"
      && isOverloadRetryCode(candidate));
}
