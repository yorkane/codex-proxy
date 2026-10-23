/**
 * 统一模型请求重试预算（fork 新增，纯 leaf）。
 *
 * 运维合同（2026-10-23 用户裁决，覆盖旧的「至少 10」地板）：模型请求遇到 4xx/5xx 时按配置
 * 重试，默认 3 次，可配 0..5；0 = 关闭代理内模型 HTTP 错误重试（首次发送仍会发出）。这个
 * 约束落在同一个 leaf 里：**可配置**（env > 全局 config > 默认 3），范围钳制 0..5。
 *
 * 与 `empty-completion-budget.ts` 同构：一个纯 leaf 把「env 覆盖一个配置量」的解析集中到
 * 一处，schema、管理 API、调度管线与测试消费同一个函数，边界值只写一遍。方向也是同一个：
 * env 是运维的显式指令，压过持久化配置，既可上调也可下调（下调受范围下限 0 约束）。
 *
 * 刻意**不** import `src/config/**` 与 `src/server/**`：调度侧（`src/server/responses/**`）
 * 与配置侧（`src/config/schema/**`）都要消费它，任何一方被引进来都会形成 cycle。因此
 * `configured` 是已解析好的标量，leaf 只认「一个配置值 + env + 默认」三层。
 *
 * 与 `OCX_CODEX_REQUEST_MAX_RETRIES` / `OCX_CODEX_STREAM_MAX_RETRIES` 是两回事：那两个是
 * **客户端**（codex-rs）的重试预算，由注入器写进 `config.toml`，本 leaf 不读、不别名、
 * 不互相继承。这里是**代理侧**发起的模型请求的重试预算。
 */

export const MODEL_REQUEST_MAX_RETRIES_ENV = "OCX_MODEL_REQUEST_MAX_RETRIES";

/** 需求给定的默认重试次数（不含首发）。默认写在 DEFAULT，范围下限另有独立 MIN 常量。 */
export const DEFAULT_MODEL_REQUEST_MAX_RETRIES = 3;

/** 范围下限：0 合法，表示关闭代理内模型 HTTP 错误重试（首发不受影响）。 */
export const MODEL_REQUEST_MAX_RETRIES_MIN = 0;

/** 范围上限：任何解析结果都不会高于它。 */
export const MODEL_REQUEST_MAX_RETRIES_LIMIT = 5;

/**
 * env 候选值的归一：小数向下取整；越界值钳进 0..5（旧配置遗留的 10 经 env 显式重设时
 * 钳到 5，负数钳 0）。返回 null 只表示这个候选**无法解析**（NaN / ±Infinity 这类非有限
 * 数）：它不算被设置，调用方回落到下一优先级——一个解析不出数字的环境变量不该改变重试预算。
 */
function clampEnvRetryValue(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  if (rounded < MODEL_REQUEST_MAX_RETRIES_MIN) return MODEL_REQUEST_MAX_RETRIES_MIN;
  return Math.min(MODEL_REQUEST_MAX_RETRIES_LIMIT, rounded);
}

/**
 * config 直传候选值的校验：**必须**是 0..5 的整数，否则不算被设置（返回 null，调用方回落
 * 默认 3）。config 走的是「写入侧已严格校验」的通道，leaf 不替它做钳制：一个绕过 schema
 * 直接塞进来的旧 10 若被钳成 5，管理 DTO 会把「配置里的 10」读成 5，而 load 路径经 schema
 * 降级到 absent 读成默认 3——同一个磁盘值在两条路径读出两个数。校验失败统一落默认 3，
 * 与加载 schema（越界降级 absent -> 默认 3）逐值一致。
 */
function configuredRetryValue(value: number): number | null {
  if (!Number.isInteger(value)) return null;
  if (value < MODEL_REQUEST_MAX_RETRIES_MIN || value > MODEL_REQUEST_MAX_RETRIES_LIMIT) return null;
  return value;
}

/**
 * 解析这一轮模型请求允许的重试次数（不含首次发送）。
 *
 * 优先级：env > `configured`（调用方传入的全局配置值）> 默认 3。
 * env 空串与纯空白视为未设置；env 非空但解析不出数字（NaN、Infinity）回落到
 * `configured`，再回落默认；env 能解析出数字的按范围钳到 0..5（env 是运维显式指令，钳制
 * 生效）。config 侧不做钳制：`configured` 必须是 0..5 整数，越界（含旧 10）与小数、非有限
 * 数一律视为未设置并回落默认 3，与加载 schema 的降级口径一致。返回值恒在
 * `[MODEL_REQUEST_MAX_RETRIES_MIN, MODEL_REQUEST_MAX_RETRIES_LIMIT]`。
 * 0 是有效值：解析路径全程用显式 undefined 判断，绝不把 0 当 falsy 回落成默认 3。
 *
 * 纯函数，env 可注入以便单测与 passthrough 测试。
 */
export function modelRequestMaxRetries(
  configured?: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[MODEL_REQUEST_MAX_RETRIES_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    const fromEnv = clampEnvRetryValue(Number(raw));
    if (fromEnv !== null) return fromEnv;
  }
  if (configured !== undefined) {
    const fromConfig = configuredRetryValue(configured);
    if (fromConfig !== null) return fromConfig;
  }
  return DEFAULT_MODEL_REQUEST_MAX_RETRIES;
}

/**
 * env 是否构成**有效覆盖**：非空（非纯空白）且能解析成有限数。负数与旧越界值（如 10）
 * 会被钳进 0..5，但它们仍是运维的显式指令，所以计为覆盖。非法 env（abc/NaN/Infinity）
 * 不改变任何解析结果，返回 false。GET 与 PUT 共用本函数，避免两处对「覆盖」各解读一遍。
 */
export function modelRequestRetryEnvOverride(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[MODEL_REQUEST_MAX_RETRIES_ENV];
  if (raw === undefined || raw.trim() === "") return false;
  return clampEnvRetryValue(Number(raw)) !== null;
}

/**
 * 总发送预算 = 重试次数 + 首次发送。调度侧的 maxTotalModelSends / send allowance 用这个，
 * 不要各自再 +1，否则「一次发送」到底算不算重试会在两处漂移。恒为 1..6。
 */
export function modelRequestMaxAttempts(
  configured?: number,
  env: Record<string, string | undefined> = process.env,
): number {
  return modelRequestMaxRetries(configured, env) + 1;
}
