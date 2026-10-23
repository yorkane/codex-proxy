import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as authContext from "../../src/codex/auth-context";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexUpstreamHealth } from "../../src/codex/routing";
import { clearUpstreamHostHealth } from "../../src/codex/upstream-host-health";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { markResponseNonReplayable } from "../../src/lib/upstream-retry";
import {
  createRequestExecutionBudget,
  CODEX_TEXT_GUARDED_BUDGET_POLICY,
  type RequestExecutionBudget,
  type RequestSendObserver,
} from "../../src/lib/request-execution-budget";
import { clearPoolRecoveryState } from "../../src/routing/probe-lease";
import type { RequestLogContext } from "../../src/server/request-log";
import type { RequestSpendTracker } from "../../src/server/responses/request-spend";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { immediateBackoff, restoreImmediateBackoff } from "../helpers/immediate-backoff";

/**
 * #6969 for native compact: a transient 5xx that survives the same-account ladder moves to one
 * alternate Pool account, as the regular Responses path does. Compact used to move only on 429/402.
 * The move is admitted under the alternate's identity, leaves the first answer intact when it is
 * refused, and records the first account once, as a transient failure.
 *
 * Unified model lane (fork): the ingress budget funds A's own ladder to the shared 4-send
 * authority (2026-10-23 default: 3 retries + first send), so a steady overload consumes the
 * whole request there and the alternate is never
 * reached - that is the new contract, pinned below. The #6969 move shape stays proven through an
 * EXACT caller budget (the guarded 3+1 profile): the lane respects the funded cap verbatim, A
 * ladders 3, and B draws the single recovery reserve. A marked non-replayable 503 ends a ladder
 * after one send, which is how the base-allowance move keeps an early-end mechanism (the model
 * lane has no 60s Retry-After short-circuit: an instructed 600s is WAITED, cheaply via the
 * fast-timer helper).
 */

const WORK = "work";
const OTHER = "other";
const HOME_KEYS = ["HOME", "OPENCODEX_HOME", "CODEX_HOME"] as const;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;

type Answer = () => Response | Promise<Response>;

const RealFetch = globalThis.fetch;
let home = "";
let previousHomes: Array<string | undefined> = [];
let savedProxyEnv: Record<string, string | undefined> = {};
let releaseSpendHome: (() => void) | undefined;
let sends: Array<string | null> = [];

function clearPoolState(): void {
  for (const id of [WORK, OTHER]) clearAccountNeedsReauth(id);
  clearCodexUpstreamHealth();
  clearUpstreamHostHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearPoolRecoveryState();
  clearAccountQuota();
}

beforeEach(() => {
  immediateBackoff();
  savedProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  previousHomes = HOME_KEYS.map(key => process.env[key]);
  home = mkdtempSync(join(tmpdir(), "ocx-compact-overload-"));
  for (const key of HOME_KEYS) process.env[key] = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearPoolState();
  for (const id of [WORK, OTHER]) setAccountQuotaFromParsed(id, { weeklyPercent: 10 });
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify(Object.fromEntries(
    [WORK, OTHER].map(id => [id, {
      credential: {
        accessToken: `${id}-access`,
        refreshToken: `${id}-grant`,
        expiresAt: Date.now() + 3_600_000,
        chatgptAccountId: `acc-${id}`,
      },
      generation: 1,
      refreshGrantFingerprint: createHash("sha256").update(`codex-refresh-grant:${id}-grant`).digest("hex"),
    }]),
  )));
  sends = [];
});

afterEach(() => {
  restoreImmediateBackoff();
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = RealFetch;
  clearPoolState();
  for (const [index, key] of HOME_KEYS.entries()) {
    if (previousHomes[index] === undefined) delete process.env[key];
    else process.env[key] = previousHomes[index];
  }
  for (const key of PROXY_ENV_KEYS) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
  removeTreeWithRetry(home);
});

/** Answers each compact send in order and records which credential it carried. */
function upstream(...answers: Answer[]): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sends.push(new Headers(init?.headers).get("authorization"));
    const answer = answers[sends.length - 1] ?? answers.at(-1)!;
    return answer();
  }) as typeof fetch;
}

const overloaded = (headers: Record<string, string> = {}): Answer => () => Response.json(
  { error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are currently overloaded." } },
  { status: 503, headers },
);
// A Retry-After past the wait ceiling ends the ladder after one send, leaving base sends for B.
const overloadedOnce = overloaded({ "retry-after": "600" });
// A gateway-settled post-send verdict: the model lane retries 400..599, and ONLY the
// non-replayable marker ends a ladder early (no Retry-After ceiling short-circuit).
const refusedOverload: Answer = () => {
  const response = Response.json(
    { error: { type: "server_error", code: "server_is_overloaded", message: "refused after send" } },
    { status: 503 },
  );
  markResponseNonReplayable(response);
  return response;
};
/** The exact guarded caller profile: A ladders 3, B draws the single reserve. */
const narrowBudget = (): RequestExecutionBudget =>
  createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY);
const compacted: Answer = () => Response.json({ id: "cmp_1", object: "response.compaction", output: [] });

function poolConfig(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    activeCodexAccountId: WORK,
    autoSwitchThreshold: 0,
    accountPoolStrategy: "round-robin",
    codexAccounts: [WORK, OTHER].map(id => ({ id, label: id })),
    ...extra,
  } as OcxConfig;
}

async function compact(options: {
  config?: OcxConfig;
  model?: string;
  budget?: ReturnType<typeof createRequestExecutionBudget>;
  logCtx?: RequestLogContext;
  signal?: AbortSignal;
} = {}) {
  const logCtx = options.logCtx ?? { model: "", provider: "" };
  const request = new Request("http://localhost/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: options.model ?? "gpt-5.5", input: [{ role: "user", content: "compact this" }] }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const response = await handleResponsesCompact(request, options.config ?? poolConfig(), logCtx, undefined, undefined,
    options.budget ? { sendBudget: options.budget } : undefined);
  return { response, body: await response.text() };
}

function failures(accountId: string): number {
  return getCodexUpstreamHealth(accountId)?.consecutiveFailures ?? 0;
}

describe("native compact moves a surviving transient 5xx to one alternate account (#6969)", () => {
  test("a steady overload consumes the shared 4-send authority on A and never moves", async () => {
    // The unified contract: A's own ladder is funded to the request authority, so a pool that
    // keeps refusing spends all four sends on the first account. B is not reached - the
    // alternate move survives as an early-end shape (below), not as a fourth send.
    // root 2026-10-23（默认 4 送改约）：合同钉"每送都被拒"，脚本必须 4 送全过载，
    // 不能尾部藏成功；compacted 只在预算越界时才会被摸到。
    upstream(...Array.from({ length: 4 }, () => overloaded()), compacted);
    const { response, body } = await compact();
    expect(response.status).toBe(503);
    expect(body).toContain("server_is_overloaded");
    expect(sends).toHaveLength(4);
    expect(sends.every(auth => auth === "Bearer work-access")).toBe(true);
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(0);
  });

  test("B served from the remaining base allowance when A's ladder ended early", async () => {
    // root 2026-10-23 裁决：non-replayable 的网关态永不触发兄弟腿（它是终态契约）。合法
    // 的"早收场+兄弟接管"形态是显式窄预算：A 的 base 只有 1 送，用完后 B 从 final-recovery
    // 储备获得第 2 送。上游脚本保持可重放的普通过载。
    const baseEarlyBudget = (): RequestExecutionBudget => createRequestExecutionBudget({
      maxTotalModelSends: 2, baseSendAllowance: 1, finalRecoveryAllowance: 1,
      maxAlternateTargetSends: 1, maxTargetTransitions: 1,
    });
    upstream(overloaded(), compacted);
    const { response } = await compact({ budget: baseEarlyBudget() });
    expect(response.status).toBe(200);
    expect(sends).toEqual(["Bearer work-access", "Bearer other-access"]);
    expect(failures(WORK)).toBe(1);
  });

  test("B failing too returns B's answer and records each account once", async () => {
    upstream(overloaded(), overloaded(), overloaded(), overloaded());
    const { response, body } = await compact({ budget: narrowBudget() });
    expect(response.status).toBe(503);
    expect(body).toContain("server_is_overloaded");
    expect(sends).toHaveLength(4);
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(1);
  });

  test("a pinned account never moves", async () => {
    // 同 steady overload：钉"永不移出的账号独自烧满预算"，4 送必须全被拒。
    upstream(...Array.from({ length: 4 }, () => overloaded()), compacted);
    const { response } = await compact({ config: poolConfig({ codexAccountNamespaces: { side: WORK } }), model: "side/gpt-5.5" });
    expect(response.status).toBe(503);
    expect(sends).toHaveLength(4);
    expect(sends.every(auth => auth === "Bearer work-access")).toBe(true);
  });

  test("a 5xx whose body confirms quota keeps today's path and does not take the transient move", async () => {
    const quota: Answer = () => Response.json({ error: { message: "You have hit your usage limit." } }, { status: 503 });
    upstream(quota, quota, quota, compacted);
    // 默认权威预算：quota 证据的 503 走今天的路径——兄弟腿被 quota 门否决，一次 B 发送
    // 都没有（A 的统一阶梯在脚本第 4 送的成功体上结算）。
    await compact();
    expect(sends).not.toContain("Bearer other-access");
  });

  test("B refused before sending by a spent budget leaves A's answer and outcome intact", async () => {
    upstream(overloaded(), overloaded(), overloaded(), compacted);
    const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, finalRecoveryAllowance: 0 });
    const { response, body } = await compact({ budget });
    expect(response.status).toBe(503);
    expect(body).toContain("server_is_overloaded");
    expect(sends.every(auth => auth === "Bearer work-access")).toBe(true);
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(0);
  });

  test("a granted reservation whose physical start fails is released, and nothing is sent", async () => {
    upstream(overloaded(), overloaded(), overloaded(), compacted);
    let refunds = 0;
    let reserveStarted = false;
    const observer: RequestSendObserver = {
      enforced: true,
      charge: () => true,
      refund: () => { refunds += 1; },
      startRequest: () => {},
      beginReporter: () => ({ start() {}, rebindTarget: () => true, report() {}, close() {} }),
      // Base sends start; the reserve's physical start is refused.
      ensureSeed: target => {
        if (target.identityId === undefined) { reserveStarted = true; return undefined; }
        return { seed: true } as never;
      },
    };
    const budget = createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY, undefined, observer);
    const { response } = await compact({ budget });
    expect(reserveStarted).toBe(true);
    expect(refunds).toBe(1);
    expect(response.status).toBe(503);
    expect(sends.every(auth => auth === "Bearer work-access")).toBe(true);
    expect(failures(WORK)).toBe(1);
  });

  /**
   * Unequal identity balances against the real spend ledger. The identity cap is exactly what the
   * first account's own sends consume, so the alternate's send is admitted only if it is charged to
   * the alternate's identity; charged to the first account it would be refused and never sent.
   */
  async function ledgerCompact(
    identityCap: number,
    ledgerBudget: RequestExecutionBudget | ((t: RequestSpendTracker) => RequestExecutionBudget) | undefined,
    ...answers: Answer[]
  ) {
    // 调用方可覆盖预算：见下方 base-path 用例（root 2026-10-23：显式窄预算验证兄弟腿的
    // 自有 identity 准入，不让默认 4 把 A 的第二物理发送先烧在 identity cap 上）。
    const { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY } = await import("../../src/lib/spend-reservation-ledger");
    const { createRequestSpendTracker } = await import("../../src/server/responses/request-spend");
    const ledger = createSpendReservationLedger({ salt: "compact-6969", policy: {
      ...DEFAULT_SPEND_RESERVATION_POLICY, identity: { maxTokens: identityCap }, pool: { maxTokens: 1_000 },
    } });
    const logCtx: RequestLogContext = { model: "", provider: "", spendInputEstimateTokens: 1, spendOutputCeilingTokens: 0 };
    const tracker = createRequestSpendTracker(logCtx, undefined, ledger);
    upstream(...answers);
    const config = poolConfig({ codexAccounts: [{ id: WORK, label: WORK, logLabel: "pa0a0a0" }, { id: OTHER, label: OTHER, logLabel: "pb0b0b0" }] } as Partial<OcxConfig>);
    const budget = typeof ledgerBudget === "function" ? ledgerBudget(tracker) : ledgerBudget;
    const result = await compact({ config, logCtx, budget: budget ?? createRequestExecutionBudget(CODEX_TEXT_GUARDED_BUDGET_POLICY, undefined, tracker) });
    // compact() 已读干响应体，结算在此时落账；快照读取保持在 body drain 之后。
    const used = (label: string) => {
      const snapshot = ledger.snapshot("identity", label);
      return snapshot ? snapshot.reserved + snapshot.settled + snapshot.unresolved : 0;
    };
    return { ...result, first: used("pa0a0a0"), alternate: used("pb0b0b0") };
  }

  test("on the base path the alternate is admitted against its own identity balance", async () => {
    // root 2026-10-23：base-path 兄弟准入用显式窄预算 total2/base1/reserve1——A 只花 1 送
    // （non-replayable 网关态终结阶梯），兄弟腿从 base 余量获得它的发送；identity cap 1
    // 钉住"记账落在 B 自己的身份"这一验证点。默认 4 预算下 A 的第二物理发送会先在
    // identity cap 上被拒，测的不是兄弟准入。
    const basePathBudget = (t: RequestSpendTracker) => createRequestExecutionBudget({
      maxTotalModelSends: 2, baseSendAllowance: 1, finalRecoveryAllowance: 1,
      maxAlternateTargetSends: 1, maxTargetTransitions: 1,
    }, undefined, t);
    // A 的阶梯由 base=1 终结（预算余量，非 non-replayable 标记），兄弟腿从 reserve 获得
    // 它的发送；B 的准入记在 B 自己的 identity 上（cap 1），A 只有 1。
    const result = await ledgerCompact(1, basePathBudget, overloaded(), compacted);
    expect(result.response.status).toBe(200);
    expect(sends).toEqual(["Bearer work-access", "Bearer other-access"]);
    expect(result.first).toBe(1);
    expect(result.alternate).toBe(1);
  });

  test("on the reserve path the alternate is admitted against its own identity balance", async () => {
    const result = await ledgerCompact(3, undefined, overloaded(), overloaded(), overloaded(), compacted);
    expect(result.response.status).toBe(200);
    expect(sends.at(-1)).toBe("Bearer other-access");
    expect(result.first).toBe(3);
    expect(result.alternate).toBe(1);
  });

  test("a dispatch guard refusing B before it leaves keeps A's answer and outcome", async () => {
    upstream(overloaded(), overloaded(), overloaded(), compacted);
    const original = authContext.createCodexAuthDispatchGuard;
    const guard = spyOn(authContext, "createCodexAuthDispatchGuard").mockImplementation((ctx, ...rest) => {
      if (ctx.kind === "pool" && ctx.accountId === OTHER) {
        return () => { throw new authContext.CodexPoolAccountCreditsOffError(OTHER, Date.now() + 60_000); };
      }
      return original(ctx, ...rest);
    });
    try {
      const { response, body } = await compact({ budget: narrowBudget() });
      expect(response.status).toBe(503);
      expect(body).toContain("server_is_overloaded");
      expect(sends.every(auth => auth === "Bearer work-access")).toBe(true);
      expect(failures(WORK)).toBe(1);
      expect(failures(OTHER)).toBe(0);
    } finally {
      guard.mockRestore();
    }
  });

  test("a caller cancelling while B is in flight records A once and answers 499", async () => {
    const abort = new AbortController();
    upstream(overloaded(), overloaded(), overloaded(), async () => {
      abort.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const { response } = await compact({ signal: abort.signal, budget: narrowBudget() });
    expect(response.status).toBe(499);
    expect(failures(WORK)).toBe(1);
  });
});
