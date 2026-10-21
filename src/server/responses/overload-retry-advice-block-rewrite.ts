import { sseDataPayload, replaceSseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";
import { overloadRetryAdviceForTerminal, overloadRetryAfterHeader } from "../../lib/overload-retry-advice";

/**
 * 给透传的终态 `response.failed` 帧补上过载重试建议（主路径）。
 *
 * 现场形态不是代理合成的帧：上游（177.t）以 HTTP 200 + SSE 流内逐字转发的
 * `response.failed{error:{code:"server_is_overloaded"}}` 终结回合，235 日志
 * `terminalSource=upstream` 证实帧来自上游。既有重写链只做脱敏与结构修复，**不动终态
 * 帧的 error 对象**，所以客户端拿到零建议、零重试。这里在重写链的最出站一侧补上：
 * `createTerminalErrorRedactionBlockRewrite` 之后插入，看到的已是脱敏后的终态帧。
 *
 * 无状态、纯函数（判定逻辑在 leaf `overload-retry-advice.ts`），env 在工厂创建时读一次 ——
 * 每个请求新建一条重写链，热改 env 需要重启进程，与其它 OCX_ 变量的语义一致。
 * 上游帧自带建议时逐字保留：235 与 177 部署同一个包，两层注入必须幂等。
 */
export function createOverloadRetryAdviceBlockRewrite(
  env: Record<string, string | undefined> = process.env,
): SseBlockRewrite {
  const retryAfterSec = overloadRetryAfterHeader(env);
  return (block: string): readonly string[] => {
    const payload = sseDataPayload(block);
    // 便宜的预筛：绝大多数数据帧不是终态，也不含该字面量，不值得为它们 parse。
    if (payload === null || !payload.includes("response.failed")) return [block];
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return [block];
    }
    const patched = overloadRetryAdviceForTerminal(event, retryAfterSec);
    if (patched === undefined) return [block];
    const rewritten = JSON.stringify(patched);
    return [rewritten === payload ? block : replaceSseDataPayload(block, rewritten)];
  };
}
