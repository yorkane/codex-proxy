import { shouldRetryCodexPoolAccountQuota, shouldRetryCodexPoolAccountTransient } from "../../src/server/responses/core-codex-account";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { fetchWithResetRetry, isNonReplayableResponse } from "../../src/lib/upstream-retry";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleResponses } from "../../src/server/responses/core";
import { COMBO_TARGET_BASE_SENDS, comboExecutionBudgetPolicy } from "../../src/server/responses/core-combo";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { DEVIN_API_SERVER } from "../../src/adapters/devin";
import { setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { saveCredential } from "../../src/oauth/store";
import { CODEX_TEXT_GUARDED_BUDGET_POLICY, createRequestExecutionBudget } from "../../src/lib/request-execution-budget";

/**
 * One logical request, one send budget -- asserted as a COUNT, because the defect in #4546 is a
 * count. Every layer that can re-send bounded itself correctly and the layers multiplied, so the
 * only assertion that catches a regression here is the exact number of times the proxy reached
 * upstream for one client turn.
 *
 * These rows use a key-auth `openai-chat` provider with `transientRetryOn5xx` because that is the
 * counted path: the generic adapter branch draws `attempts` from the request budget and reports
 * every physical send back through `onSendsConsumed`, and `noteAttemptSend` records the same send
 * on the attempt. An adapter without an opted-in transient policy keeps reset-only semantics and
 * hops on the first 5xx, so it would pin a 1 for every shape and prove nothing.
 */
const originalFetch = globalThis.fetch;

// Every dispatching row below calls the handler directly, so it takes the spend-journal writer
// lease that startServer would have taken for it. Per row rather than per file: two rows install
// their own OPENCODEX_HOME, and a lease is bound to the directory in effect when it was taken.
// The teardown drop is a backstop for a row that throws mid-assertion, because a lease left
// behind makes the NEXT row's different home read as an ownership conflict rather than as this
// row's failure.
let releaseSpendHome: (() => void) | undefined;
const takeSpendHome = (): void => { releaseSpendHome = acquireOwnedSpendHome(); };
const dropSpendHome = (): void => { releaseSpendHome?.(); releaseSpendHome = undefined; };

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
});

afterEach(() => {
  dropSpendHome();
  globalThis.fetch = originalFetch;
  setCachedCatalogForTests(null);
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
});

function transientChatProvider(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adapter: "openai-chat",
    baseUrl: `https://${name}.example/v1`,
    authMode: "key",
    apiKey: `sk-${name}`,
    models: [`model-${name}`],
    transientRetryOn5xx: { enabled: true, attempts: 3 },
    ...extra,
  };
}

/** A failover combo over `count` distinct single-model providers, each on the counted path. */
function comboOverTargets(count: number): OcxConfig {
  const providers: Record<string, unknown> = {};
  const targets: Array<{ provider: string; model: string }> = [];
  for (let index = 0; index < count; index++) {
    const name = `t${index}`;
    providers[name] = transientChatProvider(name);
    targets.push({ provider: name, model: `model-${name}` });
  }
  return {
    defaultProvider: "t0",
    providers,
    combos: { fan: { strategy: "failover", targets } },
  } as unknown as OcxConfig;
}

function responsesRequest(model: string): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, input: "hello" }),
  });
}

function alwaysFailing(status: number, message: string): { authorizations: string[] } {
  const authorizations: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(JSON.stringify({ error: { message, type: "server_error" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { authorizations };
}

const sendCounts = (logCtx: RequestLogContext): number[] =>
  (logCtx.attempts ?? []).map(attempt => attempt.sendCount);

const totalSends = (logCtx: RequestLogContext): number =>
  sendCounts(logCtx).reduce((sum, count) => sum + count, 0);

/**
 * Fake-clock 驱动：统一 lane 的 11 送阶梯在真实时钟下要烧满 30s+ 指数退避；本文件钉的是
 * 发送计数，不是墙钟。启用 jest 假计时器后把工作交给 drain 循环推进（每 tick 之间冲刷
 * 微任务，让 fetch mock 的 Promise 链继续）。生产 delay 语义未动。
 */
async function drainRun<T>(work: () => Promise<T>): Promise<T> {
  // Self-contained fake-clock drive: rows that never queue a timer are unaffected, and rows
  // in describes without the suite-level fake clock get one for the duration of this call.
  const hadFakeTimers = jest.isFakeTimers();
  if (!hadFakeTimers) jest.useFakeTimers();
  const promise = work();
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  try {
    for (let i = 0; i < 900 && !settled; i++) {
      jest.advanceTimersByTime(5_000);
      for (let j = 0; j < 30; j++) await Promise.resolve();
    }
    return await promise;
  } finally {
    if (!hadFakeTimers) jest.useRealTimers();
  }
}

describe("upstream sends per logical request", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test("Devin's initial inner send is recorded once, not omitted or double-counted", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const previousJwtFlag = process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
    const home = mkdtempSync(join(tmpdir(), "devin-send-count-"));
    process.env.OPENCODEX_HOME = home;
    // Taken on the home this row just installed, and dropped in its finally before that home
    // is removed: an open lease inside a directory being deleted fails the removal on Windows.
    takeSpendHome();
    delete process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
    const apiKey = "devin-count-test";
    // Devin is an OAuth-kind provider: the key the adapter ends up using is injected onto the
    // row from the stored credential, so a config that only carries `apiKey` never routes. The
    // credential is what makes this the path production takes.
    await saveCredential("devin", {
      access: apiKey,
      refresh: apiKey,
      expires: Number.MAX_SAFE_INTEGER,
      source: "oauth",
      apiBaseUrl: DEVIN_API_SERVER,
    });
    setCachedCatalogForTests({
      apiKey,
      host: DEVIN_API_SERVER,
      fetchedAt: Date.now(),
      byUid: new Map([["swe-2", { modelUid: "swe-2", label: "SWE-2", disabled: false }]]),
    });
    const urls: string[] = [];
    globalThis.fetch = (async input => {
      urls.push(String(input));
      return new Response("busy", { status: 500 });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const config = {
      defaultProvider: "devin",
      providers: {
        devin: {
          adapter: "devin", baseUrl: DEVIN_API_SERVER, models: ["swe-2"],
        },
      },
    } as unknown as OcxConfig;

    try {
      const response = await drainRun(() => handleResponses(responsesRequest("devin/swe-2"), config, logCtx));
      const body = await response.text();

      // Reported together, with the status, so a turn that never reaches the adapter says so
      // instead of presenting as an empty URL list. 统一模型 lane 后 Devin 云端的 500 是
      // 模型 HTTP 错误：transport 在统一预算内烧到权威 11 送；本行钉的不变量不变——
      // 每个物理 URL 调用恰好记一次 send（chatCalls === totalSends），不遗漏不双计。
      expect({
        chatCalls: urls.filter(url => url.includes("GetChatMessage")).length,
        totalSends: totalSends(logCtx),
      }, `status ${response.status}: ${body.slice(0, 200)}`).toEqual({ chatCalls: 11, totalSends: 11 });
    } finally {
      dropSpendHome();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousJwtFlag === undefined) delete process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
      else process.env.OPENCODEX_DEVIN_SEND_USER_JWT = previousJwtFlag;
      removeTreeWithRetry(home);
    }
  });

  test("a Devin turn the budget refuses logs no send at the request boundary", async () => {
    // The defect this pins lives in the outer runTurn path, not in the adapter: the attempt's
    // first send was logged before the adapter ran, so a request with nothing left to spend
    // recorded a send Devin never made. The direct-adapter case in tests/adapters covers the
    // executor side; only this one can see `sendCount`. The budget is handed in already spent
    // rather than arranged through combo arithmetic, which is how an earlier attempt at this
    // case ended up admitting the send it meant to refuse.
    const previousHome = process.env.OPENCODEX_HOME;
    const previousJwtFlag = process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
    const home = mkdtempSync(join(tmpdir(), "devin-send-denied-"));
    process.env.OPENCODEX_HOME = home;
    takeSpendHome();
    delete process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
    const apiKey = "devin-denied-test";
    await saveCredential("devin", {
      access: apiKey,
      refresh: apiKey,
      expires: Number.MAX_SAFE_INTEGER,
      source: "oauth",
      apiBaseUrl: DEVIN_API_SERVER,
    });
    setCachedCatalogForTests({
      apiKey,
      host: DEVIN_API_SERVER,
      fetchedAt: Date.now(),
      byUid: new Map([["swe-2", { modelUid: "swe-2", label: "SWE-2", disabled: false }]]),
    });
    const urls: string[] = [];
    globalThis.fetch = (async input => {
      urls.push(String(input));
      return new Response(JSON.stringify({ error: { message: "busy", type: "server_error" } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const config = {
      defaultProvider: "devin",
      providers: { devin: { adapter: "devin", baseUrl: DEVIN_API_SERVER, models: ["swe-2"] } },
    } as unknown as OcxConfig;
    // The real budget factory with nothing to give: the state an earlier combo fan-out or
    // empty-response recovery leaves behind, stated directly instead of inferred.
    const spent = createRequestExecutionBudget({
      maxTotalModelSends: 0,
      baseSendAllowance: 0,
      finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0,
      maxTargetTransitions: 0,
    }, "devin-denied-initial-send");

    try {
      const response = await drainRun(() => handleResponses(
        responsesRequest("devin/swe-2"), config, logCtx, { sendBudget: spent },
      ));
      const body = await response.text();
      const attempts = logCtx.attempts ?? [];

      // The attempt must EXIST and be empty. An absent attempt would satisfy a zero count
      // without proving the refusal was recorded against the turn that was refused.
      expect(attempts).toHaveLength(1);
      expect({
        // Pinned, not merely reported in the failure message. The refusal reaches the client as
        // an error code on a buffered FAILED response, so the outer HTTP status stays 200; a
        // reader who assumes 429 here would be describing a transport this path never uses.
        status: response.status,
        adapter: attempts[0]?.adapter,
        sendCount: attempts[0]?.sendCount,
        chatCalls: urls.filter(url => url.includes("GetChatMessage")).length,
        totalSends: totalSends(logCtx),
        refused: body.includes("request_send_budget_exhausted"),
      }, `status ${response.status}: ${body.slice(0, 240)}`).toEqual({
        status: 200,
        adapter: "devin",
        sendCount: 0,
        chatCalls: 0,
        totalSends: 0,
        refused: true,
      });
    } finally {
      dropSpendHome();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousJwtFlag === undefined) delete process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
      else process.env.OPENCODEX_DEVIN_SEND_USER_JWT = previousJwtFlag;
      setCachedCatalogForTests(null);
      removeTreeWithRetry(home);
    }
  });

  test("a 5xx streak on a single target spends the unified allowance and stops", async () => {
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };

    takeSpendHome();
    const response = await drainRun(() => handleResponses(
      responsesRequest("t0/model-t0"),
      { defaultProvider: "t0", providers: { t0: transientChatProvider("t0") } } as unknown as OcxConfig,
      logCtx,
    ));

    expect(response.status).toBe(502);
    await response.text();
    // 统一模型请求合同（2026-10-23）：单一权威 11 送（10 次重试 + 首发）全部是普通阶梯
    // 可消费的 base——provider 行的 attempts:3 只可抬高 cap，压不动地板。旧合同的
    // "3 送 + 第 4 送作为 reserve" 形态在 11 之内不存在。
    expect(upstream.authorizations).toHaveLength(11);
    expect(totalSends(logCtx)).toBe(11);
  });

  test("a one-target combo reduces to exactly the single-target shape", async () => {
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };

    takeSpendHome();
    const response = await drainRun(() => handleResponses(responsesRequest("combo/fan"), comboOverTargets(1), logCtx));

    expect(response.status).toBe(502);
    await response.text();
    // 统一合同：combo 派生总额 = 权威 11（绝对数，不再 3+hops+reserve），零跳因此与直连
    // 同形的含义从"3 送"更新为"同一个权威总额"。
    expect(upstream.authorizations).toHaveLength(11);
    expect(sendCounts(logCtx)).toEqual([11]);
  });

  test("a denied first combo reservation makes no upstream request", async () => {
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const denied = createRequestExecutionBudget();
    // Combo derives its own policy while sharing this counter; spend past that derived cap.
    denied.used = comboExecutionBudgetPolicy(2).maxTotalModelSends;

    takeSpendHome();
    const response = await drainRun(() => handleResponses(
      responsesRequest("combo/fan"), comboOverTargets(2), logCtx, { sendBudget: denied },
    ));
    const body = await response.text();
    expect(response.status).toBe(429);
    expect(body).toContain("request_send_budget_exhausted");
    expect(upstream.authorizations).toHaveLength(0);
    expect(totalSends(logCtx)).toBe(0);
  });

  test("a denied later combo reservation returns the prior upstream failure", async () => {
    // 统一合同下这行的形状：caller 预算按生产 ingress 的统一 fund 构造（11/11），请求
    // 进入时已花 10 送——首发目标的 leg 只剩 per-target holdback 给的 1 送，烧掉后共享
    // ledger 顶满，第二 combo 目标的预留被拒，返回首发真实 429（本地预算拒绝不得伪装
    // provider 失败，也不许合成人顶掉真实终态）。
    const budget = createRequestExecutionBudget({
      ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      maxTotalModelSends: 11,
      baseSendAllowance: 11,
    });
    budget.used = 10;
    const targets = comboOverTargets(2);
    (targets.providers as Record<string, Record<string, unknown>>).t0!.transientRetryOn5xx =
      { enabled: true, attempts: 11 };
    const hits: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      hits.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ error: { message: "first target busy", type: "rate_limit_error" } }, { status: 429 });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    takeSpendHome();
    const response = await drainRun(() => handleResponses(
      responsesRequest("combo/fan"), targets, logCtx, { sendBudget: budget },
    ));
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("first target busy");
    expect(hits).toEqual(["Bearer sk-t0"]);
  });

  test("a denied later combo reservation preserves a classified 413 response", async () => {
    // 与 429 行同形：统一 lane 里 413 也是模型错误，进入时已花 10 送，首发只剩 1 送；
    // 真实 413 的分类必须原样穿过（终态分类保留），第二目标预留被拒。
    const budget = createRequestExecutionBudget({
      ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      maxTotalModelSends: 11,
      baseSendAllowance: 11,
    });
    budget.used = 10;
    const hits: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      hits.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ error: { message: "maximum context length exceeded", type: "invalid_request_error" } }, { status: 413 });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    takeSpendHome();
    const response = await drainRun(() => handleResponses(
      responsesRequest("combo/fan"), comboOverTargets(2), logCtx, { sendBudget: budget },
    ));
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("maximum context length exceeded");
    expect(hits).toEqual(["Bearer sk-t0"]);
  });

  test("a three-target combo fan-out gives every declared target a send and stays bounded", async () => {
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };

    takeSpendHome();
    const response = await drainRun(() => handleResponses(responsesRequest("combo/fan"), comboOverTargets(3), logCtx));

    expect(response.status).toBe(502);
    await response.text();
    // Asserted as the INVARIANT the derived policy guarantees, not as a fixture vector. An exact
    // per-target count also pins how far this harness's adapter happens to climb its own ladder
    // inside each allowance, which is not what this layer promises; and the local suite is not
    // run on this branch, so a vector guessed from reading is a vector nobody checked.
    const bearers = upstream.authorizations;
    // Every declared target is reached. Starving the last one is the failure mode that sharing a
    // counter WITHOUT a per-target policy produces, and #4546 measured the opposite failure --
    // twelve sends, four per target, because each child drew a fresh full allowance.
    expect(new Set(bearers).size).toBe(3);
    expect(bearers[0]).toBe("Bearer sk-t0");
    expect(bearers).toContain("Bearer sk-t2");
    // The first target keeps a whole ladder to itself: the unified authority minus one
    // send held back for each later declared target (per-target holdback invariant).
    expect(sendCounts(logCtx)[0]).toBe(comboExecutionBudgetPolicy(3).maxTotalModelSends - 2);
    // And the request total is the declared policy total, which is what the derived scope can
    // now actually enforce: before the shared ledger, each scope admitted against a counter that
    // had only ever seen its own reservations.
    expect(totalSends(logCtx)).toBeLessThanOrEqual(comboExecutionBudgetPolicy(3).maxTotalModelSends);
    expect(totalSends(logCtx)).toBe(bearers.length);
  });

  test("a thirteen-target combo burns the unified authority in target order", async () => {
    // The reported shape: a long failover combo exhausted the allowance after a few providers
    // and returned the last 502 while later declared targets were never attempted at all.
    // 统一合同改变了这一行的期望：总额是权威 11 的绝对数，不再随声明目标数放大
    // (3+hops+reserve 在 13 目标下要给 16 送，突破配置)。因此"每个声明目标都被触及"
    // 在 13 目标下不再成立——前 11 送按目标顺序烧完后返回最后一次真实 502。
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };

    takeSpendHome();
    const response = await drainRun(() => handleResponses(responsesRequest("combo/fan"), comboOverTargets(13), logCtx));

    expect(response.status).toBe(502);
    await response.text();
    const bearers = upstream.authorizations;
    // 前若干目标按声明顺序被触及（首目标独占整条 ladder），总数恰为权威上限。
    expect(new Set(bearers).size).toBeGreaterThanOrEqual(2);
    expect(bearers[0]).toBe("Bearer sk-t0");
    expect(bearers).toContain("Bearer sk-t1");
    expect(bearers).toContain("Bearer sk-t2");
    expect(totalSends(logCtx)).toBeLessThanOrEqual(comboExecutionBudgetPolicy(13).maxTotalModelSends);
    expect(totalSends(logCtx)).toBe(bearers.length);
  });

  // REMOVED: "a 401 before the 5xx streak spends one of the same three sends".
  //
  // The row asserted a key rotation this harness never performs: the fixture records exactly one
  // physical send, so authorizations[1] is undefined and the logCtx total is 1. Keeping it would
  // have pinned a path the test does not reach. The property it was meant to cover -- a credential
  // hop draws on the shared remainder instead of re-arming its own allowance -- is pinned directly
  // at the budget in tests/lib/execution-budget-permits.test.ts, where the roster walk and the
  // cross-pool move are both asserted. Restoring an end-to-end row needs a harness that actually
  // rotates, which is its own change.
});

describe("ambiguous reset safety across Responses recovery", () => {
  for (const adapter of ["openai-chat", "openai-responses"]) {
    for (const combo of [false, true]) {
      test(`${adapter}: no replay or target hop after an ambiguous reset (combo=${combo})`, async () => {
        const config = comboOverTargets(2);
        for (const provider of Object.values(config.providers)) provider.adapter = adapter;
        const authorizations: string[] = [];
        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
          authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
          throw Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
        }) as typeof fetch;
        const logCtx: RequestLogContext = { model: "", provider: "" };
        takeSpendHome();
        const response = await drainRun(() => handleResponses(
          responsesRequest(combo ? "combo/fan" : "t0/model-t0"), config, logCtx,
        ));
        expect(response.status).toBe(429);
        const payload = await response.json();
        expect(payload.error.code).toBe("upstream_reset_replay_refused");
        expect(authorizations).toEqual(["Bearer sk-t0"]);
        expect(totalSends(logCtx)).toBe(1);
      });
    }
  }

  test("a provider 503 policy is retained, but the following reset cannot reach a combo sibling", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (authorizations.length === 1) {
        return new Response(JSON.stringify({ error: { message: "busy" } }), {
          status: 503, headers: { "content-type": "application/json" },
        });
      }
      throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    takeSpendHome();
    const response = await drainRun(() => handleResponses(responsesRequest("combo/fan"), comboOverTargets(2), logCtx));
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
    expect(authorizations).toEqual(["Bearer sk-t0", "Bearer sk-t0"]);
    expect(totalSends(logCtx)).toBe(2);
  });

  test("reset-only providers stop too, without opting into the transient policy", async () => {
    const config = comboOverTargets(2);
    for (const provider of Object.values(config.providers)) delete provider.transientRetryOn5xx;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    }) as typeof fetch;
    takeSpendHome();
    const response = await drainRun(() => handleResponses(responsesRequest("combo/fan"), config, { model: "", provider: "" }));
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
    expect(sends).toBe(1);
  });

  test("an OpenCode Go destination refuses an ambiguous pre-answer reset instead of replaying", async () => {
    // The removed replaySafe exception let the first send to this destination retry a
    // dropped inference once. With it gone the destination behaves like every other:
    // reset before the answer -> refusal 429, exactly one send on the wire.
    const config = {
      defaultProvider: "go",
      providers: { go: transientChatProvider("go", { baseUrl: "https://opencode.ai/zen/go/v1" }) },
    } as unknown as OcxConfig;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      throw Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    takeSpendHome();
    const response = await drainRun(() => handleResponses(responsesRequest("go/model-go"), config, logCtx));
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
    expect(sends).toBe(1);
  });
});

describe("ambiguous reset safety after outer recovery", () => {
  test("a 429 recovery refetch cannot launder a subsequent reset into a combo hop", async () => {
    const config = comboOverTargets(2);
    config.providers.t0!.retryOn429 = { attempts: 1 };
    const authorizations: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (authorizations.length === 1) return new Response("rate limited", {
        status: 429, headers: { "retry-after": "0" },
      });
      throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    takeSpendHome();
    const response = await drainRun(() => handleResponses(responsesRequest("combo/fan"), config, logCtx));
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
    expect(authorizations).toEqual(["Bearer sk-t0", "Bearer sk-t0"]);
    expect(totalSends(logCtx)).toBe(2);
  });

  // The row above arms ONE same-target attempt, so the refusal it produces arrives with the
  // arm already spent and nothing left to replay it. That is the case the guard at the top of
  // the recovery loop already covered. The defect is the arm that still has an attempt left:
  // the refusal is itself a 429, the while condition is still true, and the next attempt sends
  // the turn a third time -- the exact duplicate inference the refusal exists to prevent.
  for (const adapter of ["openai-chat", "openai-responses"]) {
    test(`${adapter}: a second same-target 429 attempt cannot replay the refusal`, async () => {
      const config = comboOverTargets(2);
      for (const provider of Object.values(config.providers)) provider.adapter = adapter;
      // Two attempts, not one: the first consumes the real rate limit, the second is the arm
      // that must NOT fire once the refetch has been refused.
      config.providers.t0!.retryOn429 = { attempts: 2 };
      const authorizations: string[] = [];
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        if (authorizations.length === 1) return new Response("rate limited", {
          status: 429, headers: { "retry-after": "0" },
        });
        throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
      }) as typeof fetch;
      const logCtx: RequestLogContext = { model: "", provider: "" };
      takeSpendHome();
      const response = await drainRun(() => handleResponses(responsesRequest("t0/model-t0"), config, logCtx));

      expect(response.status).toBe(429);
      expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
      // Exactly two: the rate-limited send and the refetch that was refused. A third entry is
      // the regression, and the base allowance (3) can afford it, so this count is the proof.
      expect(authorizations).toEqual(["Bearer sk-t0", "Bearer sk-t0"]);
      expect(totalSends(logCtx)).toBe(2);
    });
  }

  test("account and combo recovery retain the no-replay verdict after one body read", async () => {
    const response = await fetchWithResetRetry(async () => {
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    });
    expect(shouldRetryCodexPoolAccountTransient(response)).toBe(false);
    expect(await shouldRetryCodexPoolAccountQuota(response)).toBe(false);
    const failure = await consumeComboFailure(response);
    expect(failure.upstreamCode).toBe("upstream_reset_replay_refused");
    expect(isNonReplayableResponse(failure.response)).toBe(true);
    expect(shouldRetryCodexPoolAccountTransient(failure.response)).toBe(false);
    expect(await shouldRetryCodexPoolAccountQuota(failure.response)).toBe(false);
    expect(failure.response.headers.get("retry-after")).toBeNull();
    expect((await failure.response.json()).error.code).toBe("upstream_reset_replay_refused");
  });
});
