/**
 * Response 释放登记（fork 扩展：共享 leaf）。
 *
 * 有些 Response 是代理合成的替身（预输出投影），它的 body 一旦被读完就已关闭，对它
 * `cancel()` 不会触达真正需要清理的上游 reader。重试阶梯丢弃这类响应时必须有一个中心
 * 钩子，而不是让每个调用点各自 import 生产者模块 —— 那会把 server 层拖进 `src/lib` 造成
 * 循环依赖。本 leaf 不做任何判断，只登记 `Response -> cleanup`。
 *
 * 语义：
 * - `registerResponseDisposal` 覆盖同一 Response 的旧登记（一个响应只有一个释放者）。
 * - `disposeResponse` 单次：先摘除登记再调用，幂等、异常不外抛由调用方按需包裹。
 * - `removeResponseDisposal` 只摘除不调用：替身被还原成原流时，释放责任随流交给下游
 *   （原流的 cancel 自己会清理），登记必须消失，否则重试方随后 dispose 会误杀已交付的流。
 */

const disposers = new WeakMap<Response, () => void>();

export function registerResponseDisposal(response: Response, cleanup: () => void): void {
  disposers.set(response, cleanup);
}

export function disposeResponse(response: Response): void {
  const cleanup = disposers.get(response);
  if (!cleanup) return;
  disposers.delete(response);
  cleanup();
}

/** 摘除登记但不执行：责任移交（restore/transfer）路径用。 */
export function removeResponseDisposal(response: Response): (() => void) | undefined {
  const cleanup = disposers.get(response);
  if (!cleanup) return undefined;
  disposers.delete(response);
  return cleanup;
}

export function hasResponseDisposal(response: Response): boolean {
  return disposers.has(response);
}
