/**
 * Codex 客户端的重试预算（fork 新增）。
 *
 * 与 `src/lib/empty-completion-budget.ts` 同构：一个纯 leaf，把「env 覆盖一个配置量」的
 * 解析集中到一处，注入器（`src/codex/inject/*`）与测试消费同一个函数，边界值只写一遍，
 * 不会注入器和断言各钳各的。
 *
 * 背景：codex-rs 的 `ModelProviderInfo` 用 `request_max_retries`（HTTP 层，默认 4）与
 * `stream_max_retries`（SSE 层，默认 5）决定对 5xx / 流内 `response.failed` 的重试次数，
 * 客户端读时上限都是 100，且**只能来自 config.toml**——客户端没有任何环境变量能改这两个值。
 * 「代理过载时秒报 Selected model is at capacity」的现场，就是流内 failed 帧的重试预算用的
 * 默认值。所以旋钮必须由写 config.toml 的一方（opencodex 注入器）读 env 后代写。
 *
 * `OCX_CODEX_REQUEST_MAX_RETRIES` / `OCX_CODEX_STREAM_MAX_RETRIES` 是**数量**而非开关，
 * 所以环境既可上调也可下调（同 empty-completion-budget 的方向）：运维在 `~/.wdev/proxy.env`
 * 加一行、重启代理，下一轮注入就把新值写进 `[model_providers.opencodex]`。
 *
 * 优先级（plan.ts 消费这两个函数时落实）：env 已设置且合法 > config.toml 里携带的用户值 >
 * 默认 10。env 是运维的显式指令，压过文件里的任何值；env 没设置时，注入器原样搬运文件里
 * 已有的值（用户的显式配置优先于默认注入）；文件里也没有才写默认。
 */

export const CODEX_REQUEST_MAX_RETRIES_ENV = "OCX_CODEX_REQUEST_MAX_RETRIES";
export const CODEX_STREAM_MAX_RETRIES_ENV = "OCX_CODEX_STREAM_MAX_RETRIES";

/** 用户要求的默认重试次数（HTTP 层与 SSE 层同值）。 */
export const DEFAULT_CODEX_REQUEST_MAX_RETRIES = 10;
export const DEFAULT_CODEX_STREAM_MAX_RETRIES = 10;

/** 钳制上限，与 codex-rs model-provider-info 的 MAX_REQUEST_MAX_RETRIES / MAX_STREAM_MAX_RETRIES 一致。 */
export const CODEX_RETRY_MAX_RETRIES_LIMIT = 100;

export interface CodexRetryBudget {
  requestMaxRetries: number;
  streamMaxRetries: number;
}

/**
 * 单个键的解析：`0` 合法（= 不重试，与客户端 `request_max_retries = 0` 同义）；
 * 负数、非数字、Infinity/NaN → null（= 这个 env 值不算被设置，调用方回落到下一优先级，
 * 一个解析失败的环境变量不该把客户端的重试保护整个关掉）；小数向下取整；
 * 超过 100 钳到 100（客户端读侧同样钳到 100，双向一致防误解）。
 */
function parseRetryValue(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(CODEX_RETRY_MAX_RETRIES_LIMIT, Math.floor(parsed));
}

/** env 显式设置且合法的重试键；未设置的键缺项，供注入器与文件携带值合并。 */
export function codexRetryBudgetFromEnv(
  env: Record<string, string | undefined> = process.env,
): Partial<CodexRetryBudget> {
  const result: Partial<CodexRetryBudget> = {};
  const request = parseRetryValue(env[CODEX_REQUEST_MAX_RETRIES_ENV]);
  const stream = parseRetryValue(env[CODEX_STREAM_MAX_RETRIES_ENV]);
  if (request !== null) result.requestMaxRetries = request;
  if (stream !== null) result.streamMaxRetries = stream;
  return result;
}

/** env 优先、缺项回默认；注入器在无文件携带值时的最终预算。纯函数，env 可注入以便单测。 */
export function codexRetryBudget(
  env: Record<string, string | undefined> = process.env,
): CodexRetryBudget {
  const fromEnv = codexRetryBudgetFromEnv(env);
  return {
    requestMaxRetries: fromEnv.requestMaxRetries ?? DEFAULT_CODEX_REQUEST_MAX_RETRIES,
    streamMaxRetries: fromEnv.streamMaxRetries ?? DEFAULT_CODEX_STREAM_MAX_RETRIES,
  };
}

/**
 * 单个键的优先级裁决（fork 新增）：env > 用户认领值 > 默认。逐键独立，plan.ts 对
 * request/stream 各调用一次。认领这件事必须跨轮次持久：表每轮被整表剥离重写，文件里的
 * 行等于「上一轮注入写下的值」时无法区分「注入器写的」和「用户改回注入值（撤销认领）」，
 * 所以上一轮的 journal 记录（写了什么、是否 env 强制、用户认领了什么）是裁决的输入。
 *
 * - envValue 已设置 → 写 env。env 是运维的显式指令，压过认领；认领记录原样保留，
 *   env 撤掉后恢复。
 * - 文件行与上一轮注入值不同（含首次注入前的手写值）→ 用户认领，原样搬运。
 * - 有 journal 认领记录时优先搬运认领值，除了撤销认领：文件行等于上一轮注入值、那一轮
 *   不是 env 强制、且认领值与注入值不同——这三条同时成立说明用户把行改回了注入器的值。
 *   env 轮里的「改回注入值」不算用户改的（那一行本来就是注入器奉命写的）。
 * - 都没有 → 默认。
 *
 * 返回的 claim 是本轮应写进 journal 的认领记录（number），null 表示无认领。fromEnv 记录
 * 本轮写入值是否 env 强制。认领值原样搬运，不钳制（>100 由客户端读侧钳，搬运不改写值）。
 */
export interface CodexRetryKeyState {
  /** 文件里该键的标量值；无键/畸形值时 undefined。 */
  fileValue?: number;
  /** journal：上一轮注入写下的值；从未注入过该键时 undefined。 */
  lastWritten?: number;
  /** journal：上一轮写入是否 env 强制。 */
  lastFromEnv: boolean;
  /** journal：用户认领值；无认领时 undefined。 */
  userClaim?: number;
  /** 本轮 env 解析值；未设置/非法时 undefined。 */
  envValue?: number;
  /** 默认值。 */
  fallback: number;
}

export function resolveCodexRetryKey(state: CodexRetryKeyState): { written: number; claim: number | null; fromEnv: boolean } {
  const freshClaim = state.fileValue !== undefined && state.fileValue !== state.lastWritten;
  if (state.envValue !== undefined) {
    return {
      written: state.envValue,
      claim: freshClaim ? state.fileValue! : state.userClaim ?? null,
      fromEnv: true,
    };
  }
  if (freshClaim) return { written: state.fileValue!, claim: state.fileValue!, fromEnv: false };
  const claimRevoked = state.fileValue !== undefined
    && state.fileValue === state.lastWritten
    && !state.lastFromEnv
    && state.userClaim !== undefined
    && state.userClaim !== state.lastWritten;
  const claim = claimRevoked ? undefined : state.userClaim;
  if (claim !== undefined) return { written: claim, claim, fromEnv: false };
  return { written: state.fallback, claim: null, fromEnv: false };
}

