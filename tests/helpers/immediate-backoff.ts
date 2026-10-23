/**
 * 统一模型重试合同下的旧 fixture 计时器替身（owner: native model-retry 测试面）。
 *
 * 按调用栈识别，不按 delay 数值粗过滤（root 2026-10-23 诊断，/data/tmp/debug-verdict-mock.ts
 * 独立重现确证）：所有阶梯退避与 Retry-After 等待都出自共享 sleepWithAbort（upstream-retry），
 * 其栈帧带该函数名；只有这些定时器被改成立即触发，并把安排的 delay 记录进 delays，供
 * 「Retry-After 作为下界被尊重」的断言读取。其余定时器一律走真实调度：30s provider-pacing
 * 租约、readBoundedResponseBody 的 250ms/2s body deadline、connect deadline。旧版按 <60s（以及
 * 收窄后的 <=6s）数值带粗拦会把它们即时 fire：body 被假取消、永久拒绝读取拿 reason=undefined
 * （auto-pause 的 oauth_organization_disabled 归因丢失）、header 超时变假快失败。栈过滤天然覆盖
 * 45s/600s 的 RA 下界用例，无需白名单。restore 统一登记，afterEach 里调 restoreImmediateBackoff()
 * 归还。
 */
import { spyOn } from "bun:test";

const spies: Array<{ mockRestore(): void }> = [];

export function immediateBackoff(
  delays: number[] = [],
  options: { abortAfter?: number; controller?: AbortController } = {},
): void {
  const native = globalThis.setTimeout;
  let slept = 0;
  spies.push(spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const delay = ms ?? 0;
    // 只拦 sleepWithAbort 排定的定时器：调用栈里有它才是退避/RA 等待。
    if ((new Error("immediate-backoff").stack ?? "").includes("sleepWithAbort")) {
      delays.push(delay);
      slept += 1;
      if (options.controller && options.abortAfter !== undefined && slept >= options.abortAfter) {
        queueMicrotask(() => options.controller!.abort());
      }
      queueMicrotask(() => { if (typeof handler === "function") handler(...(args as [])); });
      return native(() => {}, 0);
    }
    return native(handler as () => void, delay, ...args);
  }) as typeof setTimeout));
}

export function restoreImmediateBackoff(): void {
  for (const spy of spies.splice(0)) spy.mockRestore();
}
