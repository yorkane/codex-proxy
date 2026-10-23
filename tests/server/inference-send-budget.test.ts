import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { CODEX_TEXT_GUARDED_BUDGET_POLICY } from "../../src/lib/request-execution-budget";
import { createInferenceSendBudget, expandInferenceOAuthSendBudget } from "../../src/server/inference/context";
import type { RequestLogContext } from "../../src/server/request-log";
import { createRequestExecutionBudget, deriveRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { fetchWithTransientRetry, TRANSIENT_RETRY_MAX_ATTEMPTS } from "../../src/lib/upstream-retry";
import { budgetOwner } from "../helpers/send-budget-owner";

let home: string;
let originalHome: string | undefined;
let releaseHome: () => void;
beforeEach(() => {
  originalHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-inference-budget-"));
  process.env.OPENCODEX_HOME = home;
  releaseHome = acquireOwnedSpendHome();
});
afterEach(() => {
  releaseHome();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

describe("createInferenceSendBudget", () => {
  test.each([0, 1])("an adapter credential hop enforces a real endpoint transition (limit=%i)", limit => {
    const budget = createRequestExecutionBudget({
      ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      maxTargetTransitions: limit,
      maxAlternateTargetSends: limit,
    });
    const { owner, dispose } = budgetOwner(budget);
    try {
      const initial = owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey: "https://region-a.example/" });
      if (initial.allowed) initial.permit.use();
      const hop = owner.reserveCredentialHop("auth-recovery", "provider|model|oauth-429", true);
      owner.pendingHopPermit = hop.permit;
      const replay = owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey: "https://region-b.example/" });
      expect(replay.allowed).toBe(limit === 1);
      if (replay.allowed) replay.permit.use();
      expect(budget.used).toBe(1 + limit);
      expect(budget.targetTransitions).toBe(limit);
      expect(budget.alternateTargetSends).toBe(limit);
      expect(budget.lastTargetKey).toBe(limit ? "https://region-b.example/" : "https://region-a.example/");
    } finally { dispose(); }
  });

  test("the last helper-driven account spends its prepaid hop plus the unified remainder", async () => {
    // 统一合同：总额 11 是唯一权威，roster 数不再抬高它。已花 9 送的请求，末段账号的
    // prepaid hop + 阶梯只剩 2 送（旧合同是 3 送到 12）；耗尽后返回最后一次真实 503，
    // 任何后续 reserve 被拒。
    const budget = createInferenceSendBudget(new Request("http://localhost/v1/responses"), { model: "m", provider: "p" });
    const { owner, dispose } = budgetOwner(budget);
    try {
      owner.noteTransientSends(9);
      const hop = owner.reserveCredentialHop("auth-recovery", "provider|model|oauth-429", true);
      owner.pendingHopPermit = hop.permit;
      const allowance = owner.recoverySendAllowance(3, "auth-recovery", "provider|model|oauth-429");
      let sends = 0;
      const response = await fetchWithTransientRetry(async () => {
        if (sends === 0) hop.permit?.use();
        sends++;
        return new Response("", { status: 503 });
      }, { attempts: allowance.attempts, onSendsConsumed: owner.transientSendReporter(allowance.permit) });
      expect(allowance.attempts).toBe(2);
      expect(response.status).toBe(503);
      expect(sends).toBe(2);
      expect(budget.used).toBe(11);
      expect(budget.reserveDispatch({ sendClass: "auth-recovery", targetKey: "provider|model|oauth-429" }).allowed).toBe(false);
    } finally { dispose(); }
  });

  test("same-provider auth recovery keeps the adapter's physical target", () => {
    const budget = createRequestExecutionBudget();
    const { owner, dispose } = budgetOwner(budget);
    try {
      const targetKey = "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent";
      const initial = owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey });
      expect(initial.allowed).toBe(true);
      if (initial.allowed) initial.permit.use();
      const hop = owner.reserveCredentialHop("auth-recovery", "google-antigravity|model|oauth-429");
      expect(hop.allowed).toBe(true);
      owner.pendingHopPermit = hop.permit;
      const replay = owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey });
      expect(replay.allowed).toBe(true);
      if (replay.allowed) replay.permit.use();
      const retry = owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey });
      expect(retry.allowed).toBe(true);
      expect(budget.lastTargetKey).toBe(targetKey);
      expect(budget.targetTransitions).toBe(0);
      expect(budget.used).toBe(3);
    } finally { dispose(); }
  });
  test.each([false, true])("an undispatched adapter hop remains refundable (externally counted=%s)", external => {
    const budget = createRequestExecutionBudget();
    const { owner, dispose } = budgetOwner(budget);
    try {
      const targetKey = "https://upstream.example/model";
      const initial = owner.refundableAdapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey });
      if (!initial.allowed) throw new Error("Expected initial permit");
      initial.permit.use();
      const hop = owner.reserveCredentialHop("auth-recovery", targetKey, external);
      owner.pendingHopPermit = hop.permit;
      const replay = owner.refundableAdapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey });
      if (!replay.allowed) throw new Error("Expected replay permit");
      expect(budget.used).toBe(2);
      replay.permit.release();
      replay.permit.release();
      expect(budget.used).toBe(1);
      expect(budget.remainingBaseSends(3)).toBe(2);
      expect(replay.permit.use()).toBe(false);
      expect(replay.permit.assumeCharge()).toBe(false);
      owner.noteTransientSends(1);
      expect(budget.used).toBe(2); // No abandoned external booking can swallow a later send.
    } finally { dispose(); }
  });

  test.each(["use", "assumeCharge"] as const)("adapter hop %s settles an external booking once and cannot refund a send", confirm => {
    const budget = createRequestExecutionBudget();
    const { owner, dispose } = budgetOwner(budget);
    try {
      const targetKey = "https://upstream.example/model";
      const hop = owner.reserveCredentialHop("auth-recovery", targetKey, true);
      owner.pendingHopPermit = hop.permit;
      const replay = owner.refundableAdapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey });
      if (!replay.allowed) throw new Error("Expected replay permit");
      expect(replay.permit[confirm]()).toBe(true);
      expect(replay.permit.use()).toBe(false);
      expect(replay.permit.assumeCharge()).toBe(false);
      replay.permit.release();
      expect(budget.used).toBe(1);
      owner.noteTransientSends(1);
      expect(budget.used).toBe(2);
    } finally { dispose(); }
  });

  test("a previously settled adapter hop falls back to a fresh reservation", () => {
    const budget = createRequestExecutionBudget();
    const { owner, dispose } = budgetOwner(budget);
    try {
      const targetKey = "https://upstream.example/model";
      const hop = owner.reserveCredentialHop("auth-recovery", targetKey, true);
      expect(hop.permit?.assumeCharge()).toBe(true);
      owner.pendingHopPermit = hop.permit;
      const replay = owner.refundableAdapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey });
      if (!replay.allowed) throw new Error("Expected replay permit");
      expect(replay.permit.use()).toBe(true);
      expect(budget.used).toBe(2);
      replay.permit.release();
      expect(budget.used).toBe(2);
    } finally { dispose(); }
  });
  test("mints a unified-authority holder and parks this request's spend tracker on the log", () => {
    const logCtx: RequestLogContext = { model: "m", provider: "p" };
    const req = new Request("http://localhost/v1/responses", { method: "POST" });
    const budget = createInferenceSendBudget(req, logCtx);
    // 统一模型请求合同：ingress 自有预算 mint 时直接 fund 权威额（默认 11 = 10 次重试 +
    // 首发），base 与 total 相等（第 11 送不要求 reserve-funded 类）；reserve/alternate/
    // transition 保持 guarded 形态。
    expect(budget.policy).toEqual({
      ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      maxTotalModelSends: 11,
      baseSendAllowance: 11,
    });
    expect(typeof budget.logicalRequestId).toBe("string");
    expect(budget.used).toBe(0);
    expect(logCtx.spendTracker).toBeDefined();
  });

  test("each call mints its own holder", () => {
    const req = new Request("http://localhost/v1/responses", { method: "POST" });
    const a = createInferenceSendBudget(req, { model: "m", provider: "p" });
    const b = createInferenceSendBudget(req, { model: "m", provider: "p" });
    expect(a).not.toBe(b);
    expect(a.logicalRequestId).not.toBe(b.logicalRequestId);
  });

  test("roster expansion is clamped by the unified authority and leaves other scopes alone", () => {
    const req = new Request("http://localhost/v1/responses");
    const budget = createInferenceSendBudget(req, { model: "m", provider: "p" });
    const other = createInferenceSendBudget(req, { model: "m", provider: "p" });
    const exact = createRequestExecutionBudget();
    const child = deriveRequestExecutionBudget(budget, { ...budget.policy });
    expandInferenceOAuthSendBudget(budget, 4);
    expandInferenceOAuthSendBudget(exact, 4);
    expandInferenceOAuthSendBudget(child, 4);
    // 统一合同：4 账号 × 3 的旧抬升 (12) 被权威 11 钳住——总额是一个权威数字，不随
    // roster 数放大 (#4546 的乘法教训在 roster 维度同样成立)。
    expect(budget.policy.baseSendAllowance).toBe(11);
    expect(budget.policy.maxTotalModelSends).toBe(11);
    // "不被别人的抬升改动"在新合同下的逐项形状：other 是独立 ingress（自带统一 11 基金，
    // 不被 budget 的 roster 调用触碰）；exact 是显式 caller 预算（4/3 精确性永不扩）；
    // child 携带派生时的父 policy 快照（11/11），同样不被触碰。
    expect(other.policy).toEqual({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 11, baseSendAllowance: 11 });
    expect(exact.policy).toEqual(CODEX_TEXT_GUARDED_BUDGET_POLICY);
    expect(child.policy).toEqual({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 11, baseSendAllowance: 11 });
    // Later cooldowns or logins cannot shrink or replenish this request's snapshot.
    expandInferenceOAuthSendBudget(budget, 2);
    expandInferenceOAuthSendBudget(budget, 8);
    for (let i = 0; i < 11; i++) {
      const send = budget.reserveDispatch({ sendClass: "transient", targetKey: "physical-url" });
      expect(send.allowed).toBe(true);
      if (send.allowed) send.permit.use();
    }
    expect(budget.reserveDispatch({ sendClass: "auth-recovery", targetKey: "physical-url" }).allowed).toBe(false);
    expect(child.used).toBe(budget.used);
  });

  test("one credential keeps the unified fund and a spent request cannot expand", () => {
    const req = new Request("http://localhost/v1/responses");
    const single = createInferenceSendBudget(req, { model: "m", provider: "p" });
    expandInferenceOAuthSendBudget(single, 1);
    expect(single.policy).toEqual({
      ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      maxTotalModelSends: 11,
      baseSendAllowance: 11,
    });
    const started = createInferenceSendBudget(req, { model: "m", provider: "p" });
    const send = started.reserveDispatch({ sendClass: "initial", targetKey: "physical-url" });
    if (send.allowed) send.permit.use();
    expandInferenceOAuthSendBudget(started, 4);
    expect(started.policy).toEqual({
      ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      maxTotalModelSends: 11,
      baseSendAllowance: 11,
    });
  });
});

test("ingress reuses its tracker only for the same request even when log context is reused", () => {
  const logCtx: RequestLogContext = { model: "m", provider: "p" };
  const first = new Request("http://localhost/v1/responses");
  createInferenceSendBudget(first, logCtx);
  const initial = logCtx.spendTracker;
  createInferenceSendBudget(first, logCtx);
  expect(logCtx.spendTracker).toBe(initial);
  createInferenceSendBudget(new Request("http://localhost/v1/responses"), logCtx);
  expect(logCtx.spendTracker).not.toBe(initial);
});

test("checking an unconfigured ingress budget does not open its journal", async () => {
  const { existsSync } = await import("node:fs");
  const { createPhysicalSendReporter } = await import("../../src/lib/request-execution-budget");
  const budget = createInferenceSendBudget(new Request("http://localhost/v1/responses"), { model: "m", provider: "p" });
  expect(budget.spendEnforced).toBe(false);
  expect(createPhysicalSendReporter(budget, () => ({ poolId: "p" })).beforeSend).toBeFunction();
  expect(existsSync(join(home, "spend-ledger.salt"))).toBe(false);
  expect(existsSync(join(home, "spend-ledger.jsonl"))).toBe(false);
});
