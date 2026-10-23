/**
 * Native Chat candidates inside a combo (PF-07).
 *
 * With `protocols.rollout.nativeChatCombos` on, a Chat combo's openai-chat candidate is sent on
 * the native Chat lane from the caller's own body, while every other candidate keeps the
 * Chat -> Responses bridge. The cases drive the real Chat ingress against loopback upstreams and
 * read what each upstream received, because the point of the change is the body on the wire and
 * the sends the combo is allowed to make, neither of which an in-process stub can show.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { getRequestLogEntries } from "../../src/server/request-log";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { chatErrorStream, chatStream, responsesSuccess } from "../helpers/combo-failover-upstream";
import { immediateBackoff, restoreImmediateBackoff } from "../helpers/immediate-backoff";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

type Rec = Record<string, unknown>;

// A transient ladder with backoff plus a loopback failover can pass 5s under suite load.
setDefaultTimeout(30_000);

const MESSAGES = [{ role: "user", content: "fixture" }];

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let releaseSpendHome: (() => void) | undefined;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-chat-native-combo-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-chat-native-combo-"));
  process.env.OPENCODEX_HOME = testDir;
  // Taken after the home is installed so the physical sends own this journal.
  releaseSpendHome = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearResponseStateForTests();
  clearReasoningReplayCacheForTests();
});

afterEach(async () => {
  restoreImmediateBackoff();
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  for (const server of servers.splice(0)) await server.stop(true);
  // Policy routes open the routing-history index under OPENCODEX_HOME; Windows cannot remove
  // the home while that SQLite handle is open (EBUSY).
  closeRequestHistoryIndex();
  await flushResponseState();
  clearResponseStateForTests();
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  resetProviderRequestPacingForTest();
  clearReasoningReplayCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

/** A loopback upstream that records every body it receives. */
function upstream(answer: (body: Rec, hit: number, headers: Headers) => Response | Promise<Response>) {
  const bodies: Rec[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as Rec;
      bodies.push(body);
      return answer(body, bodies.length, request.headers);
    },
  });
  servers.push(server);
  return { bodies, baseUrl: new URL("/v1", server.url).href };
}

function provider(adapter: string, baseUrl: string, extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter, baseUrl, allowPrivateNetwork: true, authMode: "key", apiKey: `key-${adapter}`, ...extra };
}

/** A completed Responses stream, which is what the bridge always asks a Responses upstream for. */
function responsesStream(text: string): Response {
  const response = responsesSuccess(text, "m2");
  return new Response([
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text, item_id: "msg_backup", output_index: 0, content_index: 0 })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

/** A Chat completion carrying two choices with logprobs: only the native lane can return it. */
function twoChoiceCompletion(): Response {
  const choice = (index: number) => ({
    index,
    message: { role: "assistant", content: `choice ${index}` },
    logprobs: { content: [{ token: "choice", logprob: -0.1, top_logprobs: [] }] },
    finish_reason: "stop",
  });
  return Response.json({
    id: "chatcmpl-native",
    object: "chat.completion",
    model: "m1",
    choices: [choice(0), choice(1)],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  });
}

function comboConfig(
  providers: Record<string, OcxProviderConfig>,
  targets: Array<{ provider: string; model: string }>,
  protocols?: OcxConfig["protocols"],
): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0]!,
    providers,
    combos: { pair: { strategy: "failover", targets } },
    ...(protocols ? { protocols } : {}),
  };
}

const NATIVE_ON: OcxConfig["protocols"] = { rollout: { nativeChatCombos: true } };

async function send(config: OcxConfig, body: Rec, options: {
  headers?: Record<string, string>;
  admission?: DataPlaneAdmission;
} = {}) {
  const requestId = `pf07-${crypto.randomUUID()}`;
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify({ model: "combo/pair", messages: MESSAGES, ...body }),
  }), config, { model: "", provider: "" }, {
    requestId,
    start: Date.now(),
    // What the listener resolved; a loopback bind carries no caller identity of its own.
    ...(options.admission ? { admission: options.admission } : {}),
  });
  const text = await response.text();
  const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
  return { response, text, rows };
}

describe("native Chat candidates in a combo", () => {
  test("distributed 401 recovery stays bounded and avoids the failed key on subsequent requests", async () => {
    const keys: string[] = [];
    // 统一 lane（root 2026-10-23 对同族用例的裁决）：401 进同 key ladder，脚本必须恒 401
    // 才测得出"首 key 烧满预算、请求内不换 key、失败持久化、下一请求避开"。脚本恒 401：
    // 钉默认预算（2026-10-23 改约：3 重试 + 首发 = 4 送）烧满终 401 的形态。
    const a = upstream((_body, hit, headers) => {
      keys.push(headers.get("authorization")!);
      return Response.json({ error: { message: "invalid key" } }, { status: 401 });
    });
    const row = provider("openai-chat", a.baseUrl, { apiKey: "synthetic-first",
      apiKeyPool: [{ id: "first", key: "synthetic-first" }, { id: "second", key: "synthetic-second" }],
      requestPacing: { enabled: true, keySelection: "round-robin" } });
    const config = comboConfig({ a: row }, [{ provider: "a", model: "m1" }], NATIVE_ON);
    immediateBackoff();
    const first = await send(config, { stream: false });
    // Unified model lane (root 2026-10-23 amended: default authority = 4 sends, per-target
    // holdback keeps one send for rotation): the child's 401 rides the SAME-key ladder to
    // the per-target cap of three; the fourth send is the rotation hop spending the one
    // held-back send - rotation no longer interrupts a ladder, it follows a spent one.
    // The request ends on the recorded 401 and
    // the NEXT request avoids the failed key.
    expect(first.response.status).toBe(401);
    expect(a.bodies).toHaveLength(4);
    expect(keys.slice(0, 3)).toEqual(Array(3).fill("Bearer synthetic-first"));
    expect(keys[3]).toBe("Bearer synthetic-second");
    // 统一 lane 的持久后果（root 2026-10-23 授权的 newstrategy 更新）：rotation hop 让
    // 兄弟 key 也在本请求内吃了真实 401，两把 key 都被记为失败。下一请求面对全失败池
    // 走 exhausted-pool 合同：零上游发送、本地 503 拒绝（与 messages-native 的同名用例
    // 同形）。配置的 active key 不被轮换改写。
    const second = await send(config, { stream: false });
    expect(second.response.status).toBe(503);
    expect(a.bodies).toHaveLength(4);
    expect(config.providers.a!.apiKey).toBe("synthetic-first");
  });
  test("a native candidate receives the caller's own Chat body, n and logprobs included", async () => {
    const a = upstream(() => twoChoiceCompletion());
    const b = upstream(() => responsesStream("bridge"));
    const config = comboConfig(
      { a: provider("openai-chat", a.baseUrl), b: provider("openai-responses", b.baseUrl) },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      NATIVE_ON,
    );

    const { response, text, rows } = await send(config, { stream: false, n: 2, logprobs: true, top_logprobs: 1 });

    expect(response.status).toBe(200);
    const completion = JSON.parse(text) as { choices: unknown[] };
    // Both choices reach the client: the Responses bridge would have folded them into one.
    expect(completion.choices).toHaveLength(2);
    expect(a.bodies).toHaveLength(1);
    expect(a.bodies[0]).toMatchObject({ model: "m1", messages: MESSAGES, n: 2, logprobs: true, top_logprobs: 1, stream: false });
    expect(b.bodies).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(200);
    expect(rows[0]!.spend).toMatchObject({ sends: 1, unresolved: 0 });
    expect(rows[0]!.provider).toBe("combo");
    expect(rows[0]!.protocolTrace).toMatchObject({
      inbound: "chat", mode: "native", requestPath: ["chat", "chat"],
      attempts: [{ ordinal: 1, mode: "native", requestPath: ["chat", "chat"] }],
    });
  });

  test("native combo plaintext reasoning replay follows admission without changing parent callbacks", async () => {
    const a = upstream((_body, hit) => Response.json({
      id: `chatcmpl-replay-${hit}`,
      object: "chat.completion",
      model: "m1",
      choices: [{
        index: 0,
        message: hit === 1
          ? { role: "assistant", content: null, reasoning_content: "private reasoning", tool_calls: [
            { id: "call_replay", type: "function", function: { name: "inspect", arguments: "{}" } },
          ] }
          : { role: "assistant", content: "continued" },
        finish_reason: hit === 1 ? "tool_calls" : "stop",
      }],
    }));
    const config = comboConfig(
      { a: provider("openai-chat", a.baseUrl) },
      [{ provider: "a", model: "deepseek-v4.1-flash" }],
      NATIVE_ON,
    );
    const owner: DataPlaneAdmission = {
      kind: "configured", keyId: "fixture-owner", source: "dedicated", contextPrincipalId: "principal-owner",
    };
    const foreign: DataPlaneAdmission = {
      kind: "configured", keyId: "fixture-foreign", source: "dedicated", contextPrincipalId: "principal-foreign",
    };
    const thread = { "thread-id": "combo-replay-thread" };
    const first = await send(config, { stream: false }, { headers: thread, admission: owner });
    expect(first.response.status).toBe(200);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]!.spend).toMatchObject({ sends: 1, unresolved: 0 });

    const history: Rec[] = [
      { role: "user", content: "fixture" },
      { role: "assistant", content: null, tool_calls: [
        { id: "call_replay", type: "function", function: { name: "inspect", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "call_replay", content: "done" },
      { role: "user", content: "continue" },
    ];
    const samePrincipal = await send(config, { stream: false, messages: history }, { headers: thread, admission: owner });
    expect(samePrincipal.response.status).toBe(200);
    expect(a.bodies[1]!.messages[1]!.reasoning_content).toBe("private reasoning");

    const foreignPrincipal = await send(config, { stream: false, messages: history }, { headers: thread, admission: foreign });
    expect(foreignPrincipal.response.status).toBe(200);
    expect(a.bodies[2]!.messages[1]!.reasoning_content).toBe(" ");

    const keyless = await send(config, { stream: false, messages: history }, { headers: thread });
    expect(keyless.response.status).toBe(200);
    expect(a.bodies[3]!.messages[1]!.reasoning_content).toBe(" ");
    // Native children remain on the combo's parent row and retain its send accounting.
    expect(keyless.rows).toHaveLength(1);
    expect(keyless.rows[0]!.provider).toBe("combo");
    expect(keyless.rows[0]!.spend).toMatchObject({ sends: 1, unresolved: 0 });
  });

  test.each([
    ["native", "low", "unset", "high->low"],
    ["native", "xhigh", "unset", "high->xhigh"],
    ["native", "high", "unset", "high"],
    ["native", "low", "medium", "high->low->medium"],
    ["bridge", "low", "unset", "high->low"],
    ["bridge", "xhigh", "unset", "high->xhigh"],
    ["bridge", "low", "medium", "high->low->medium"],
  ] as const)("JEV wire effort: lane=%s, selected=%s, pin=%s, label=%s", async (lane, selected, pinned, label) => {
    const native = lane === "native";
    const pin = pinned === "unset" ? undefined : pinned;
    const a = upstream(body => body.stream === true ? chatStream("effort fixture") : twoChoiceCompletion());
    const config = comboConfig({
      a: provider("openai-chat", a.baseUrl, {
        models: ["m1"], liveModels: false, reasoningEfforts: ["low", "medium", "high", "xhigh"],
        ...(pin ? { pinnedReasoningEffort: pin } : {}),
      }),
      jev: {
        adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone",
        authMode: "key", apiKey: "decision-fixture", liveModels: false,
        fetch: (async () => Response.json({ answers: { route: { choice: `a/m1:${selected}` } } })) as typeof fetch,
      },
    }, [{ provider: "a", model: "m1" }], native ? NATIVE_ON : undefined);
    config.combos!.pair!.strategy = "jev";

    const { response, rows } = await send(config, { stream: false, reasoning_effort: "high" });

    expect(response.status).toBe(200);
    expect(a.bodies).toHaveLength(1);
    expect(a.bodies[0]!.reasoning_effort).toBe(pin ?? selected);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jevDecision?.selected).toEqual({ provider: "a", model: "m1", effort: selected });
    expect(rows[0]!.requestedEffort).toBe(label);
    expect(rows[0]!.attempts).toHaveLength(1);
    expect(rows[0]!.attempts![0]!.requestedEffort).toBe(label);
    expect(rows[0]!.protocolTrace!.attempts![0]!.mode).toBe(native ? "native" : "legacy-bridge");
  });

  test("a failed native candidate fails over to the bridge within the shared send budget", async () => {
    // The provider asks for five ladder sends and the unified default would allow four, but
    // the combo's per-target budget holds the sibling's reserve back: the native child
    // reaches its upstream twice (base 3 - 1 held for B), and the bridge sibling still gets
    // the send the holdback reserved for it.
    immediateBackoff();
    const a = upstream(() => Response.json({ error: { message: "fixture outage", type: "server_error" } }, { status: 503 }));
    const b = upstream(() => responsesStream("recovered on the bridge"));
    const config = comboConfig(
      {
        a: provider("openai-chat", a.baseUrl, { transientRetryOn5xx: { attempts: 5 } }),
        b: provider("openai-responses", b.baseUrl),
      },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      NATIVE_ON,
    );

    const { response, text, rows } = await send(config, { stream: false, n: 2 });

    expect(response.status).toBe(200);
    expect(text).toContain("recovered on the bridge");
    // 实测（D6-baseline 日志）：默认权威 4 送下 base=4-1(final reserve)=3，per-target 再扣
    // 兄弟 reserve 1，A 的 ladder 收在 2 送，reserve 留给 B——B 的合法发送在 4 内完成。
    // "共享预算内 failover" 的下界由 ladder 合同在 4 权威上守住，per-target holdback 是
    // 上层权威（#4546）。断言按实测 2+B=1 钉住。
    expect(a.bodies).toHaveLength(2);
    for (const body of a.bodies) expect(body).toMatchObject({ n: 2, messages: MESSAGES });
    expect(b.bodies).toHaveLength(1);
    // The bridge candidate got a Responses body, built from the source rather than from A's.
    expect(b.bodies[0]).toHaveProperty("input");
    expect(b.bodies[0]).not.toHaveProperty("messages");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts?.map(attempt => attempt.status)).toEqual([503, 200]);
    // 实测：A 的 ladder 收在 2（per-target base），B 的合法发送是第 3 送；
    // 共享权威 4 内完成 failover，settled=3。
    expect(rows[0]!.spend).toMatchObject({ sends: 3, unresolved: 0 });
    expect(rows[0]!.protocolTrace).toMatchObject({
      inbound: "chat",
      requestPath: ["chat", "responses"],
      attempts: [
        { ordinal: 1, mode: "native", requestPath: ["chat", "chat"] },
        { ordinal: 2, requestPath: ["chat", "responses"] },
      ],
    });
  });

  test("Chat reasoning intent survives an empty-ladder first target and reaches failover", async () => {
    // 统一 lane 下 A 要烧满 per-target 阶梯（10 送）才到 failover：真实退避合计 >30s，
    // 用栈过滤 fast-timer helper 秒过退避，验证点（failover 抵达 + reasoning 保住）不变。
    // 默认权威 4 送：A 的阶梯为 per-target 3 送（4 - 兄弟 reserve 1）。
    immediateBackoff();
    const a = upstream(() => Response.json({ error: { message: "fixture outage" } }, { status: 503 }));
    const b = upstream(() => responsesStream("reasoned fallback"));
    const config = comboConfig(
      {
        a: provider("openai-responses", a.baseUrl, { reasoningEfforts: [] }),
        b: provider("openai-responses", b.baseUrl, { reasoningEfforts: ["low", "high"] }),
      },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
    );

    const { response, text } = await send(config, { stream: false, reasoning_effort: "high" });

    expect(response.status).toBe(200);
    expect(text).toContain("reasoned fallback");
    // 统一 lane：A 的 ladder 花满 per-target 授权（4 总 - 兄弟 reserve 1 = 3）才 failover
    // 到 B；验证点（空 ladder 目标后 reasoning 意图在兄弟上存活）不变。
    expect(a.bodies).toHaveLength(3);
    for (const body of a.bodies) {
      expect((body.reasoning as Rec | undefined)?.effort).toBeUndefined();
    }
    expect(b.bodies).toHaveLength(1);
    expect((b.bodies[0]!.reasoning as Rec | undefined)?.effort).toBe("high");
  });

  test("Chat policy fallback strips only the empty-ladder attempt's reasoning effort", async () => {
    // The bridge lane runs the unified ladder now (the anthropic provider has no opt-in knob to
    // stop it short); fast timers keep the 4-send default from costing wall time.
    immediateBackoff();
    const a = upstream(() => Response.json({ error: { message: "fixture outage" } }, { status: 503 }));
    const b = upstream(() => responsesStream("reasoned policy fallback"));
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "a",
      providers: {
        // Anthropic consumes parsed options rather than the Responses raw-body
        // sanitizer, so this catches an effort that leaks past policy selection.
        a: provider("anthropic", a.baseUrl, { models: ["m1"], reasoningEfforts: [] }),
        b: provider("openai-responses", b.baseUrl, { models: ["m2"], reasoningEfforts: ["low", "high"] }),
      },
      routingProfiles: { daily: { candidates: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } },
    };

    const { response, text, rows } = await send(config, {
      model: "policy/daily", stream: false, reasoning_effort: "high", include_reasoning: true,
    });

    expect(response.status).toBe(200);
    expect(text).toContain("reasoned policy fallback");
    expect(a.bodies.length).toBeGreaterThan(0);
    for (const body of a.bodies) {
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toBeUndefined();
    }
    expect(b.bodies).toHaveLength(1);
    expect(b.bodies[0]!.reasoning).toMatchObject({ effort: "high", summary: "auto" });
    expect(rows[0]!.attempts?.map(attempt => attempt.status)).toEqual([503, 200]);
  });

  test("a streamed native answer that fails after output is not re-sent to the next target", async () => {
    const a = upstream(() => chatErrorStream("fixture broke mid-stream", "partial answer"));
    const b = upstream(() => responsesStream("must not run"));
    const config = comboConfig(
      { a: provider("openai-chat", a.baseUrl), b: provider("openai-responses", b.baseUrl) },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      NATIVE_ON,
    );

    const { response, text } = await send(config, { stream: true });

    expect(response.status).toBe(200);
    expect(text).toContain("partial answer");
    expect(a.bodies).toHaveLength(1);
    expect(b.bodies).toHaveLength(0);
  });

  test("a folded native answer that fails after output stops the combo instead of hopping", async () => {
    // The caller asked for JSON, so the native lane folds the stream before answering. Output
    // already left the upstream, so the failure must end the combo, as it does on the bridge.
    const a = upstream(() => chatErrorStream("fixture broke mid-stream", "partial answer"));
    const b = upstream(() => responsesStream("must not run"));
    const config = comboConfig(
      { a: provider("openai-chat", a.baseUrl), b: provider("openai-responses", b.baseUrl) },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      NATIVE_ON,
    );

    const { response } = await send(config, { stream: false });

    expect(response.status).not.toBe(200);
    expect(a.bodies).toHaveLength(1);
    expect(b.bodies).toHaveLength(0);
  });

  test("with the switch off the same combo keeps the Responses bridge", async () => {
    const a = upstream(body => body.stream === true ? chatStream("bridged") : twoChoiceCompletion());
    const b = upstream(() => responsesStream("unused"));
    const config = comboConfig(
      { a: provider("openai-chat", a.baseUrl), b: provider("openai-responses", b.baseUrl) },
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
    );

    const { response, text, rows } = await send(config, { stream: false, n: 2 });

    expect(response.status).toBe(200);
    expect(text).toContain("bridged");
    expect(a.bodies).toHaveLength(1);
    // The bridge always streams internally and cannot carry `n`.
    expect(a.bodies[0]!.stream).toBe(true);
    expect(a.bodies[0]).not.toHaveProperty("n");
    expect(rows[0]!.protocolTrace).toMatchObject({ mode: "legacy-bridge" });
  });
});

describe("unrepresentable candidates under the reject policy", () => {
  const REJECT: OcxConfig["protocols"] = { unrepresentable: "reject", rollout: { nativeChatCombos: true } };

  test("a candidate whose path cannot carry n is skipped with its reason recorded", async () => {
    const a = upstream(() => twoChoiceCompletion());
    const b = upstream(() => responsesStream("must not run"));
    const config = comboConfig(
      { a: provider("openai-chat", a.baseUrl), b: provider("openai-responses", b.baseUrl) },
      // The unrepresentable candidate is declared first, so only the skip can explain A serving.
      [{ provider: "b", model: "m2" }, { provider: "a", model: "m1" }],
      REJECT,
    );

    const { response, text, rows } = await send(config, { stream: false, n: 2 });

    expect(response.status).toBe(200);
    expect((JSON.parse(text) as { choices: unknown[] }).choices).toHaveLength(2);
    expect(b.bodies).toHaveLength(0);
    expect(a.bodies).toHaveLength(1);
    expect(rows[0]!.attempts).toHaveLength(1);
    expect(rows[0]!.protocolTrace).toMatchObject({ mode: "native" });
    expect(rows[0]!.protocolTrace!.reasonCodes).toContain("feature-unrepresentable");
  });

  test("when every candidate is skipped the combo answers the ingress refusal with no send", async () => {
    const b = upstream(() => responsesStream("must not run"));
    const config = comboConfig(
      { b: provider("openai-responses", b.baseUrl) },
      [{ provider: "b", model: "m2" }],
      REJECT,
    );

    const { response, text, rows } = await send(config, { stream: false, n: 2 });

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ error: {
      type: "invalid_request_error",
      code: "unsupported_feature",
      message: "The selected route cannot carry these request features: request.multiple_choices",
    } });
    expect(b.bodies).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(400);
    expect(rows[0]!.protocolTrace).toMatchObject({
      inbound: "chat", mode: "blocked", requestPath: [], reasonCodes: ["feature-unrepresentable"],
    });
  });
});
