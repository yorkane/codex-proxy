/**
 * 发射名改写门控（三方 vs 官方）：只有三方路由（含 shadow 替换官方名的那一族）允许
 * emitted-call guard 改名/救回；OpenAI 运营的官方 Responses 端点恢复纯上游语义 ——
 * 不改写发射名，强制模式下前缀名与容器名照旧 fail closed。三方改写全部落 durable 行
 * （attempt.toolNameRewrites）并触发 onToolNameRewrite 回调（run-turn 侧打进程日志）。
 *
 * 谓词 thirdPartyEmissionRepair 见 src/server/responses/shadow-call-route.ts；
 * guard 侧门控见 src/responses/emitted-call-guard.ts 的 servingRouteIsThirdParty。
 */
import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { resolveEmittedCall } from "../../src/responses/emitted-call-guard";
import { thirdPartyEmissionRepair } from "../../src/server/responses/shadow-call-route";
import { normalizeAttemptToolNameRewrites } from "../../src/usage/attempt-delivery";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const CODE_MODE_CATALOG = new Set([
  "exec",
  "collaboration__spawn_agent",
  "collaboration__wait_agent",
  "wait",
]);
const FREEFORM = new Set(["exec"]);
const CUSTOM = new Set(["exec"]);

function guardCtx(gate: boolean) {
  return {
    declaredToolNames: CODE_MODE_CATALOG,
    enforceDeclaredToolNames: true,
    freeformToolNames: FREEFORM,
    bareCustomToolNames: CUSTOM,
    servingRouteIsThirdParty: gate,
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function* turn(emitted: string): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call-1", name: emitted } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-1", arguments: "const r = await tools.exec_command({cmd: 'ls'}); text(r.output);" } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-1" } as AdapterEvent;
  yield { type: "done" } as AdapterEvent;
}

async function collectTurn(emitted: string): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const e of turn(emitted)) events.push(e);
  return events;
}

const PROVIDER_OPENAI_OFFICIAL: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
} as OcxProviderConfig;
const PROVIDER_OPENAI_INTERNAL: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://8802-248.ai-t.wtvdev.com/v1",
  authMode: "api-key",
} as OcxProviderConfig;
const PROVIDER_CUSTOM: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "http://127.0.0.1:8800/v1",
  authMode: "api-key",
} as OcxProviderConfig;

describe("thirdPartyEmissionRepair 真值表", () => {
  test("shadow 替换过官方名 -> 恒三方", () => {
    const parsed = { modelId: "gpt-5.6-codex", _shadowIntercepted: true } as OcxParsedRequest;
    expect(thirdPartyEmissionRepair(parsed, { providerName: "openai", provider: PROVIDER_OPENAI_OFFICIAL })).toBe(true);
  });
  test("OpenAI 运营的官方 Responses 端点 -> 不三方", () => {
    const parsed = { modelId: "gpt-5.6-codex" } as OcxParsedRequest;
    expect(thirdPartyEmissionRepair(parsed, { providerName: "openai", provider: PROVIDER_OPENAI_OFFICIAL })).toBe(false);
  });
  test("provider 名叫 openai 但 baseUrl 是内网 -> 三方", () => {
    const parsed = { modelId: "gpt-5.6-codex" } as OcxParsedRequest;
    expect(thirdPartyEmissionRepair(parsed, { providerName: "openai", provider: PROVIDER_OPENAI_INTERNAL })).toBe(true);
  });
  test("任意自定义 provider -> 三方", () => {
    const parsed = { modelId: "llm-248/Q38-Flash-Next" } as OcxParsedRequest;
    expect(thirdPartyEmissionRepair(parsed, { providerName: "llm-248", provider: PROVIDER_CUSTOM })).toBe(true);
  });
});

describe("guard 门控：同一个畸形名在两种路由下两个答案", () => {
  test("tools=exec_command：三方救回成 exec，官方按未声明 drop", () => {
    const tp = resolveEmittedCall("tools=exec_command", guardCtx(true));
    expect(tp.kind).toBe("allow");
    if (tp.kind === "allow") {
      expect(tp.name).toBe("exec");
      expect(tp.repaired).toBe(true);
    }
    const official = resolveEmittedCall("tools=exec_command", guardCtx(false));
    expect(official.kind).toBe("drop");
  });
  test("缺省 = 官方语义（不传 gate 不救回）", () => {
    const { servingRouteIsThirdParty, ...noGate } = guardCtx(true);
    expect(resolveEmittedCall("tools=exec_command", noGate).kind).toBe("drop");
  });
  test("无 catalog + 前缀名：三方仍 fail closed，官方恢复中继（9ecf76f44 那一档）", () => {
    expect(resolveEmittedCall("tools.apply_patch", { servingRouteIsThirdParty: true })).toEqual(
      { kind: "drop", name: "tools.apply_patch" });
    expect(resolveEmittedCall("tools.apply_patch", { servingRouteIsThirdParty: false })).toEqual(
      { kind: "allow", name: "tools.apply_patch", repaired: false });
    // 官方语义下容器名那一档仍 fail closed（那是上游就有的，不接 gate）。
    expect(resolveEmittedCall("tools", { servingRouteIsThirdParty: false }).kind).toBe("drop");
  });
});

describe("bridge 流式/批量：门控端到端 + 改写日志", () => {
  test("三方：tools=exec_command 编译成 nested exec_command 中继，并上报改写", async () => {
    const rewrites: Array<{ emitted: string; effective: string }> = [];
    const sse = await drain(bridgeToResponsesSSE(turn("tools=exec_command"),
      "llm-248/x", undefined, FREEFORM, undefined, undefined, 50_000, {
        declaredToolNames: CODE_MODE_CATALOG,
        servingRouteIsThirdParty: true,
        onToolNameRewrite: info => { rewrites.push(info); },
      }));
    expect(sse).toContain("await tools.exec_command(");
    expect(sse).not.toContain("undeclared client tool");
    expect(rewrites).toEqual([{ emitted: "tools=exec_command", effective: "exec" }]);
  });
  test("官方（gate=false）：同一事件流拿到 response.failed 502，且没有改写上报", async () => {
    const rewrites: Array<{ emitted: string; effective: string }> = [];
    const sse = await drain(bridgeToResponsesSSE(turn("tools=exec_command"),
      "gpt-5.6-codex", undefined, FREEFORM, undefined, undefined, 50_000, {
        declaredToolNames: CODE_MODE_CATALOG,
        onToolNameRewrite: info => { rewrites.push(info); },
      }));
    expect(sse).toContain("response.failed");
    expect(sse).toContain("undeclared client tool");
    expect(rewrites).toEqual([]);
  });
  test("官方：缺省（完全不传 gate）与显式 false 同答案", async () => {
    const sse = await drain(bridgeToResponsesSSE(turn("tools=exec_command"),
      "gpt-5.6-codex", undefined, FREEFORM, undefined, undefined, 50_000, {
        declaredToolNames: CODE_MODE_CATALOG,
      }));
    expect(sse).toContain("response.failed");
  });
  test("批量孪生：三方中继 + 上报；官方整批 error", async () => {
    const rewrites: Array<{ emitted: string; effective: string }> = [];
    const events = await collectTurn("tools=exec_command");
    const third = buildResponseJSON(events, "llm-248/x", {
      declaredToolNames: CODE_MODE_CATALOG,
      servingRouteIsThirdParty: true,
      onToolNameRewrite: info => { rewrites.push(info); },
    } as never);
    const thirdJson = JSON.stringify(third);
    expect(thirdJson).toContain("await tools.exec_command(");
    expect(rewrites).toEqual([{ emitted: "tools=exec_command", effective: "exec" }]);
    const official = buildResponseJSON(events, "gpt-5.6-codex", {
      declaredToolNames: CODE_MODE_CATALOG,
      servingRouteIsThirdParty: false,
    } as never);
    expect(JSON.stringify(official)).toContain("undeclared client tool");
  });
  test("合法声明名：官方路由原样中继，零改写（不误伤正常流量）", async () => {
    const rewrites: Array<{ emitted: string; effective: string }> = [];
    const sse = await drain(bridgeToResponsesSSE(turn("exec"),
      "gpt-5.6-codex", undefined, FREEFORM, undefined, undefined, 50_000, {
        declaredToolNames: CODE_MODE_CATALOG,
        onToolNameRewrite: info => { rewrites.push(info); },
      }));
    expect(sse).not.toContain("response.failed");
    expect(sse).toContain("response.completed");
    expect(rewrites).toEqual([]);
  });
});

describe("toolNameRewrites durable 行的规范化", () => {
  test("折叠形状通过；畸形输入整体丢弃", () => {
    expect(normalizeAttemptToolNameRewrites([{ name: "tools=exec_command", effective: "exec", count: 3 }]))
      .toEqual([{ name: "tools=exec_command", effective: "exec", count: 3 }]);
    expect(normalizeAttemptToolNameRewrites([])).toBeUndefined();
    expect(normalizeAttemptToolNameRewrites([{ name: "x", effective: "exec" }])).toBeUndefined();
    expect(normalizeAttemptToolNameRewrites([{ name: "x", effective: "exec", count: 0 }])).toBeUndefined();
    expect(normalizeAttemptToolNameRewrites([{ name: "x", effective: "exec", count: 1.5 }])).toBeUndefined();
    expect(normalizeAttemptToolNameRewrites("nope")).toBeUndefined();
  });
});
