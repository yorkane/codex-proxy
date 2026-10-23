/**
 * 模型统一重试 scope（fork 新增，纯 leaf，仅依赖 node:async_hooks）。
 *
 * 契约（root 裁决 + pause-deferral owner 实现细化）：自动账号暂停的观察照常进行
 * （verdict 即时读 body），但**自动** pause 的持久化提交在 scope 激活期间排队，scope
 * 的最外层 run 结束时（任何出口：返回、抛出、abort）在 finally 里统一 flush——中途的
 * 401 累计不能把同一个逻辑请求的 11 送额度自我截断。**显式**用户 pause、revocation、
 * generation/fence 变化全部即时生效，与 scope 无关。
 *
 * 语义：
 * - reentrant 幂等：scope 已激活时内层 run 直接执行，flush 归最外层 owner（防 nested
 *   双 flush 与回调错 flush）。
 * - flush 永不抛：单条提交失败 console.warn 后继续，请求终态不受影响。
 *
 * 本文件是接口基线（runModelRetryScope/modelRetryScopeActive + 排队原语）；
 * pause-deferral owner 在同一文件上扩展 observer 侧的入队 API。leaf 纪律：只 import
 * node:async_hooks，绝不 import src/oauth 或 src/server。
 */
import { AsyncLocalStorage } from "node:async_hooks";

type PendingCommit = { key?: string; run: () => void | Promise<void> };

type RetryScope = {
  pending: PendingCommit[];
  flushed: boolean;
};

const scopeStorage = new AsyncLocalStorage<RetryScope>();

/**
 * scope 内排队一个延迟提交；无活动 scope 时立即执行（调用方语义与直接执行一致）。
 * `key`（credential 身份：key+incarnation+fence）供 success 取消同 key 的排队错误用。
 * commit 可以是异步函数：排队侧按入队顺序 await 执行（见 flushModelRetryScope），立即侧
 * fire-and-forget 且自带 catch，两条路径都不得让拒绝逃逸成 unhandled rejection。
 * scope 已 flush 后（异步任务在 flush 之后才回到保留的 store）排队即丢，所以 flushed
 * 的 scope 视同无 scope：提交立即执行，绝不写回一个不会再被 flush 的队列。
 */
export function deferModelRetryCommit(commit: () => void | Promise<void>, key?: string): void {
  const scope = scopeStorage.getStore();
  if (!scope || scope.flushed) {
    void runCommit(commit);
    return;
  }
  scope.pending.push(key === undefined ? { run: commit } : { key, run: commit });
}

/** 丢弃同 key 的排队提交（scope 内成功观察重置 streak 时调用），保持剩余入队顺序。 */
export function cancelModelRetryCommitsForKey(key: string): void {
  const scope = scopeStorage.getStore();
  if (!scope) return;
  scope.pending = scope.pending.filter(entry => entry.key !== key);
}

/** 当前是否运行在模型重试 scope 内（诊断用）。 */
export function modelRetryScopeActive(): boolean {
  const scope = scopeStorage.getStore();
  return scope !== undefined && !scope.flushed;
}

/**
 * 在模型重试 scope 内运行一段异步工作。nested 调用共享最外层 scope；最外层 run 的
 * finally 之前 await flush 全部排队提交，flush 永不抛。flush 完成前 `run` 的返回值
 * 不向调用方传播：调用方（dispatch 层）看到终态 response 时，排队提交已结算完毕。
 */
export async function runModelRetryScope<T>(fn: () => Promise<T>): Promise<T> {
  const existing = scopeStorage.getStore();
  if (existing) return fn();
  const scope: RetryScope = { pending: [], flushed: false };
  try {
    return await scopeStorage.run(scope, fn);
  } finally {
    await flushModelRetryScope(scope);
  }
}

async function flushModelRetryScope(scope: RetryScope): Promise<void> {
  if (scope.flushed) return;
  scope.flushed = true;
  const queue = scope.pending;
  scope.pending = [];
  // Sequential in arrival order: the streak serializer behind each commit owns its own tail, and
  // an async commit that lands after this scope is gone re-checks its fences at run time.
  for (const entry of queue) await runCommit(entry.run);
}

async function runCommit(commit: () => void | Promise<void>): Promise<void> {
  try {
    await commit();
  } catch (err) {
    console.warn("[model-retry-scope] deferred commit failed:", err instanceof Error ? err.message : String(err));
  }
}
