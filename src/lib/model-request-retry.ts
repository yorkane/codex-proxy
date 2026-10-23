/**
 * 统一模型请求重试预算（fork 新增，纯 leaf）。
 *
 * 运维要求：所有模型请求遇到 4xx/5xx 出错都必须按配置重试，且至少 10 次。这句话有两个
 * 约束，落在这个 leaf 里：**可配置**（env > 全局 config）与**有地板**（读时下限 10）。
 * 地板是需求的一部分，不是防御性校验，所以它写在解析里而不是调用方——任何调用点都拿不到
 * 小于 10 的重试次数，配置被手改成 0 也一样重试 10 次。
 *
 * 与 `empty-completion-budget.ts` / `codex-retry-budget.ts` 同构：一个纯 leaf 把「env 覆盖
 * 一个配置量」的解析集中到一处，schema、管理 API、调度管线与测试消费同一个函数，边界值
 * 只写一遍。方向也是同一个：env 是运维的显式指令，压过持久化配置，既可上调也可下调
 * （下调受地板约束）。
 *
 * 刻意**不** import `src/config/**` 与 `src/server/**`：调度侧（`src/server/responses/**`）
 * 与配置侧（`src/config/schema/**`）都要消费它，任何一方被引进来都会形成 cycle。因此
 * `configured` 是已解析好的标量，provider 级覆盖由调用方折叠进来（provider 值 ?? 全局值），
 * leaf 只认「一个配置值 + env + 默认」三层。
 *
 * 与 `OCX_CODEX_REQUEST_MAX_RETRIES` / `OCX_CODEX_STREAM_MAX_RETRIES` 是两回事：那两个是
 * **客户端**（codex-rs）的重试预算，由注入器写进 `config.toml`，本 leaf 不读、不别名、
 * 不互相继承。这里是**代理侧**发起的模型请求的重试预算。
 */

export const MODEL_REQUEST_MAX_RETRIES_ENV = "OCX_MODEL_REQUEST_MAX_RETRIES";

/** 需求给定的地板：任何解析结果都不会低于它。 */
export const DEFAULT_MODEL_REQUEST_MAX_RETRIES = 10;

/** 钳制上限，与 codex-rs 读侧上限同值，双向一致防误解。 */
export const MODEL_REQUEST_MAX_RETRIES_LIMIT = 100;

/**
 * 单个候选值的归一：小数向下取整；低于地板的值（含 0 与负数）抬到地板；超过上限钳到上限。
 * 地板是需求本身，所以「小于 10」这件事（0、5、负数）不区分「配置」与「手误」，一律抬到 10，
 * 任何调用点都拿不到低于 10 的重试次数。
 * 返回 null 只表示这个候选**无法解析**（NaN / ±Infinity 这类非有限数）：它不算被设置，调用方
 * 回落到下一优先级——一个解析不出数字的环境变量不该把重试保护整个关掉。
 */
function clampRetryValue(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  if (rounded < DEFAULT_MODEL_REQUEST_MAX_RETRIES) return DEFAULT_MODEL_REQUEST_MAX_RETRIES;
  return Math.min(MODEL_REQUEST_MAX_RETRIES_LIMIT, rounded);
}

/**
 * 解析这一轮模型请求允许的重试次数（不含首次发送）。
 *
 * 优先级：env > `configured`（调用方传入的全局/折叠后的配置值）> 默认 10。
 * env 空串与纯空白视为未设置；env 非空但解析不出数字（NaN、Infinity）不静默关闭重试保护，
 * 回落到 `configured`，再回落默认；能解析出数字但小于地板的值（含 0 与负数）按地板取 10。
 * `configured` 无法解析同样回落默认。返回值恒在
 * `[DEFAULT_MODEL_REQUEST_MAX_RETRIES, MODEL_REQUEST_MAX_RETRIES_LIMIT]`。
 *
 * 纯函数，env 可注入以便单测与 passthrough 测试。
 */
export function modelRequestMaxRetries(
  configured?: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[MODEL_REQUEST_MAX_RETRIES_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    const fromEnv = clampRetryValue(Number(raw));
    if (fromEnv !== null) return fromEnv;
  }
  if (configured !== undefined) {
    const fromConfig = clampRetryValue(configured);
    if (fromConfig !== null) return fromConfig;
  }
  return DEFAULT_MODEL_REQUEST_MAX_RETRIES;
}

/**
 * 总发送预算 = 重试次数 + 首次发送。调度侧的 maxTotalModelSends / send allowance 用这个，
 * 不要各自再 +1，否则「一次发送」到底算不算重试会在两处漂移。恒为 11..101。
 */
export function modelRequestMaxAttempts(
  configured?: number,
  env: Record<string, string | undefined> = process.env,
): number {
  return modelRequestMaxRetries(configured, env) + 1;
}
