import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import {
  PLAINTEXT_V2_COLLABORATION_NAMESPACE,
  plaintextV2AgentMessagesEligibleForProvider,
  preparePlaintextV2AgentMessages,
  shouldPreparePlaintextV2AgentMessages,
} from "../../src/responses/plaintext-v2-agent-messages";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

// 第三方 Responses provider 的 provider 级明文 opt-in 契约（fork 定制）：
// 全局键是总闸，provider 字段把生效范围从 canonical ChatGPT 转发扩展到显式 opt-in 的第三方线路；
// canonical 行为由全局键单独覆盖，必须不被本次改动破坏。

/** 构造一个 v2 协作目录，message 属性带 encrypted:true 标记。 */
function collaborationTool(name: string): Record<string, unknown> {
  return {
    type: "function",
    name,
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", encrypted: true },
      },
      required: ["message"],
    },
  };
}

function thirdPartyRequestBody(): Record<string, unknown> {
  return {
    model: "gpt/gpt-6.1-sol",
    tools: [{
      type: "namespace",
      name: "collaboration",
      description: "Delegate work to sub-agents.",
      tools: [
        collaborationTool("spawn_agent"),
        collaborationTool("send_message"),
        collaborationTool("followup_task"),
      ],
    }],
  };
}

function messageSchema(tool: Record<string, unknown>): Record<string, unknown> {
  return ((tool.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).message;
}

describe("plaintext v2 agent messages third-party provider opt-in", () => {
  test("provider opt-in 生效需要全局总闸开启：全局关 + opt-in true 不改写", () => {
    expect(plaintextV2AgentMessagesEligibleForProvider({
      enabled: false,
      providerName: "gpt",
      provider: { plaintextV2AgentMessages: true },
      isCanonical: false,
    })).toBe(false);

    // 资格判定为 false 时调用点不会进入改写；再确认改写函数本身与门无关的纯函数性质：
    // 直接调用 prepare 仍会改写，说明门（资格判定）是唯一收窄点，不在纯函数里。
    const body = thirdPartyRequestBody();
    const prepared = preparePlaintextV2AgentMessages(structuredClone(body));
    const namespace = (prepared.body as typeof body).tools[0] as { name: string; tools: Record<string, unknown>[] };
    expect(namespace.name).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(namespace.tools[0]!.name).toBe("start_delegated_task");
    expect(messageSchema(namespace.tools[0]!).encrypted).toBeUndefined();
  });

  test("全局开 + 无 opt-in + 非 canonical provider 不改写（保持现状）", () => {
    expect(plaintextV2AgentMessagesEligibleForProvider({
      enabled: true,
      providerName: "gpt",
      provider: {},
      isCanonical: false,
    })).toBe(false);
    // 显式 false 与缺省同义
    expect(plaintextV2AgentMessagesEligibleForProvider({
      enabled: true,
      providerName: "gpt",
      provider: { plaintextV2AgentMessages: false },
      isCanonical: false,
    })).toBe(false);
  });

  test("全局开 + provider opt-in true 触发改写：目录别名、encrypted 剥离", () => {
    expect(plaintextV2AgentMessagesEligibleForProvider({
      enabled: true,
      providerName: "gpt",
      provider: { plaintextV2AgentMessages: true },
      isCanonical: false,
    })).toBe(true);

    const body = thirdPartyRequestBody();
    const prepared = preparePlaintextV2AgentMessages(body);
    const namespace = (prepared.body as typeof body).tools[0] as { name: string; tools: Record<string, unknown>[] };
    expect(prepared.namespaceAliased).toBe(true);
    expect(namespace.name).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(namespace.tools.map(tool => tool.name)).toEqual([
      "start_delegated_task",
      "deliver_delegated_message",
      "continue_delegated_task",
    ]);
    for (const tool of namespace.tools) expect(messageSchema(tool).encrypted).toBeUndefined();
  });

  test("canonical provider + 全局开仍改写（回归保护，provider 字段不参与 canonical 分支）", () => {
    expect(plaintextV2AgentMessagesEligibleForProvider({
      enabled: true,
      providerName: "openai",
      provider: {},
      isCanonical: true,
    })).toBe(true);
    expect(plaintextV2AgentMessagesEligibleForProvider({
      enabled: true,
      providerName: "openai",
      provider: { plaintextV2AgentMessages: false },
      isCanonical: true,
    })).toBe(true);
    // canonical 分支同样受全局总闸约束
    expect(plaintextV2AgentMessagesEligibleForProvider({
      enabled: false,
      providerName: "openai",
      provider: { plaintextV2AgentMessages: true },
      isCanonical: true,
    })).toBe(false);

    // 既有门函数语义不变：canonical + responses 线 + 合法目录 → 进入改写
    expect(shouldPreparePlaintextV2AgentMessages({
      enabled: true,
      inboundWire: "responses",
      canonicalChatGpt: true,
      requestBody: thirdPartyRequestBody(),
    })).toBe(true);
    const body = thirdPartyRequestBody();
    const prepared = preparePlaintextV2AgentMessages(body);
    const namespace = (prepared.body as typeof body).tools[0] as { name: string; tools: Record<string, unknown>[] };
    expect(namespace.name).toBe(PLAINTEXT_V2_COLLABORATION_NAMESPACE);
    expect(messageSchema(namespace.tools[0]!).encrypted).toBeUndefined();
  });

  test("第三方线路在 namespace 展平前完成明文改写", () => {
    const provider = {
      adapter: "openai-responses",
      baseUrl: "http://127.0.0.1:10100/v1",
      authMode: "key" as const,
      allowPrivateNetwork: true,
      plaintextV2AgentMessages: true,
    };
    const rawBody = thirdPartyRequestBody();
    const request = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "gpt-6.1-sol",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: rawBody,
      _plaintextV2AgentMessages: true,
    }, { headers: new Headers({ authorization: "Bearer test" }) });
    const sent = JSON.parse(request.body);
    const serialized = JSON.stringify(sent);
    expect(serialized).toContain("collaboration-optimize__start_delegated_task");
    expect(serialized).not.toContain('"encrypted":true');
    expect(serialized).not.toContain("collaboration__spawn_agent");
    expect([...(request.plaintextV2AgentMessageToolNames ?? [])]).toEqual([
      "spawn_agent", "send_message", "followup_task",
    ]);
    expect([...(request.plaintextV2AgentMessageAliasedToolNames ?? [])]).toEqual([
      "spawn_agent", "send_message", "followup_task",
    ]);
    expect(rawBody.tools[0]!.name).toBe("collaboration");
    expect(JSON.stringify(rawBody)).toContain('"encrypted":true');
  });
});
