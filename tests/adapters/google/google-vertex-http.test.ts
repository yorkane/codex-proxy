import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as retry from "../../../src/lib/upstream-retry";
import { modelRequestMaxAttempts } from "../../../src/lib/model-request-retry";
import { createRequestExecutionBudget } from "../../../src/lib/request-execution-budget";
import { budgetOwner } from "../../helpers/send-budget-owner";
import type { AdapterRequest } from "../../../src/adapters/base";
import { fetchAntigravityWithRetry, fetchDirectGeminiWithRetry, fetchVertexWithRetry } from "../../../src/adapters/google-http";
import { ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX, safeVertexHttpErrorMessage, retryableGoogleStatus } from "../../../src/adapters/google-errors";
import { isAntigravityValidationRefusal } from "../../../src/server/responses/antigravity-validation-refusal";

describe("Antigravity 403 body boundary", () => {
  // 统一模型 lane 下 403 也进 ladder；本组钉的是 403 体边界（读取上限/脱敏），
  // 用 caller 单发送预算把 ladder 固定在一次，保持测试的时间边界原义。
  const singleSend = () => createRequestExecutionBudget({
    maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
    maxAlternateTargetSends: 1, maxTargetTransitions: 0,
  });
  test("a complete structured reason inside 4096 bytes survives normalization", async () => {
    const payload = JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "validate",
      details: [{ reason: "VALIDATION_REQUIRED" }] } });
    const result = await fetchAntigravityWithRetry(request, {
      sendBudget: singleSend(),
      executor: (async () => new Response(payload, { status: 403 })) as typeof fetch,
    });
    expect((await result.text()).startsWith(`${ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX}:`)).toBe(true);
  });

  test("only a complete normalized marker admits rotation and inspection preserves the response", async () => {
    const accepted = new Response(`${ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX}: validation needed`, { status: 403 });
    expect(await isAntigravityValidationRefusal(accepted)).toBe(true);
    expect(await accepted.text()).toContain("validation needed");
    for (const text of [ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX, `${ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX}x: fake`,
      `Antigravity access denied: ${ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX}: fake`]) {
      const refused = new Response(text, { status: 403 });
      expect(await isAntigravityValidationRefusal(refused)).toBe(false);
      expect(await refused.text()).toBe(text);
    }
    const controller = new AbortController();
    controller.abort();
    const aborted = new Response(`${ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX}: validation needed`, { status: 403 });
    expect(await isAntigravityValidationRefusal(aborted, controller.signal)).toBe(false);
    expect(await aborted.text()).toContain("validation needed");
  });

  test("an oversized validation body is discarded before formatting", async () => {
    const payload = JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "secret-canary",
      filler: "x".repeat(4200), details: [{ reason: "VALIDATION_REQUIRED" }] } });
    const result = await fetchAntigravityWithRetry(request, {
      sendBudget: singleSend(),
      executor: (async () => new Response(payload, { status: 403 })) as typeof fetch,
    });
    const text = await result.text();
    expect(text).toBe("Antigravity access denied: HTTP 403");
    expect(text).not.toContain("secret-canary");
  });

  test("a stalled validation body falls back after the 2 second bound", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const start = performance.now();
    const result = await fetchAntigravityWithRetry(request, {
      sendBudget: singleSend(),
      executor: (async () => new Response(stalled, { status: 403 })) as typeof fetch,
    });
    expect(performance.now() - start).toBeLessThan(3500);
    expect(await result.text()).toBe("Antigravity access denied: HTTP 403");
  });
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const request: AdapterRequest = {
  url: "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse",
  method: "POST",
  headers: { authorization: "Bearer tok", "content-type": "application/json" },
  body: "{}",
};

function mockFetch(responses: Array<Response | Error | (() => Response | Error)>): { calls: RequestInit[] } {
  // 统一 lane 的 ladder 会打到默认预算（4 送）：单元素脚本被重复消费时，重试路径会 cancel 掉被丢弃
  // 的响应体，之后复用同一 Response（连 clone 都不行——原体已 disturbed）就报 Body already
  // used（旧 3 送合同在 cancel 之前收场，掩盖了这一点）。首次投递交付原对象——身份断言与
  // body 钩子挂在它身上——并在投递前捕获体/状态/头规格；之后的重复投递按规格新建独立
  // Response，每送消费各自的流。需要逐字保真身份/钩子且被反复消费的用例（自定义
  // body.cancel）传工厂函数：每送调用一次，不做 clone 规格捕获（clone 会 tee 掉流，
  // 把钩子换掉）。
  const calls: RequestInit[] = [];
  let i = 0;
  type Spec = { text: string; status: number; statusText: string; headers: Headers };
  const specs: Array<Spec | undefined> = responses.map(() => undefined);
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const index = i < responses.length ? i : responses.length - 1;
    i += 1;
    const entry = responses[index]!;
    const next = typeof entry === "function" ? entry() : entry;
    if (next instanceof Error) throw next;
    if (typeof entry === "function") return next;
    if (specs[index] === undefined) {
      // 首投：先捕获规格，再交付原对象本体（身份断言与 body 钩子挂在它身上）。
      specs[index] = {
        text: await next.clone().text(),
        status: next.status,
        statusText: next.statusText,
        headers: new Headers(next.headers),
      };
      return next;
    }
    const spec = specs[index]!;
    return new Response(spec.text, {
      status: spec.status,
      statusText: spec.statusText,
      headers: new Headers(spec.headers),
    });
  }) as typeof fetch;
  return { calls };
}

function vertexError(code: number, status: string, message: string): string {
  return JSON.stringify({ error: { code, status, message } });
}

describe("vertex retry fetch", () => {
  test("Google preserves the executor TypeError after its header deadline", async () => {
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    const original = new TypeError("google executor deadline rejection");
    let sends = 0;
    const executor = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sends += 1;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(original);
        else signal?.addEventListener("abort", () => reject(original), { once: true });
      });
    }) as typeof fetch;
    await expect(fetchVertexWithRetry(request, { executor, timeoutMs: 1 })).rejects.toBe(original);
    waits.mockRestore();
    // 统一模型 lane（2026-10-23 改约）：无 caller 账本时 ladder 上限是统一预算（默认 4 送），不再是 3。
    expect(sends).toBe(modelRequestMaxAttempts());
  });

  for (const [name, fetchResponse] of [["Vertex", fetchVertexWithRetry], ["Antigravity", fetchAntigravityWithRetry]] as const) {
    test.each([400, 429, 503, "reset"] as const)(`${name} prepaid final send prevents another inference or backoff (%s)`, async status => {
      const parent = createRequestExecutionBudget();
      parent.used = 3;
      const { owner, dispose } = budgetOwner(parent);
      const raw = status === 400 ? vertexError(400, "INVALID_ARGUMENT", "tools.0.custom.input_schema: JSON schema is invalid") : `fixture ${status}`;
      const first = status === "reset" ? Object.assign(new Error("fixture reset"), { code: "ECONNRESET" })
        : new Response(raw, { status, headers: { "Retry-After": "60" } });
      const fixture = mockFetch([first, new Response("unexpected replay")]);
      const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
      const ordinals: number[] = [];
      try {
        const hop = owner.reserveCredentialHop("auth-recovery", request.url, true);
        if (!hop.allowed || !hop.permit) throw new Error("Expected final prepaid send");
        owner.pendingHopPermit = hop.permit;
        const scope = owner.adapterDispatchBudget;
        if (!scope) throw new Error("Expected an adapter dispatch budget");
        const result = fetchResponse({ ...request, body: JSON.stringify({ request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          tools: [{ functionDeclarations: [{ name: "replace_in_files", parameters: {
            type: "object", properties: { occurrence_ids: { type: "array", items: { type: "string" } } },
          } }] }],
        } }) }, { sendBudget: scope, returnRawErrors: true, onPhysicalSend: send => ordinals.push(send.ordinal) });
        if (status === "reset") await expect(result).rejects.toBeInstanceOf(retry.SendBudgetExhaustedError);
        else {
          const response = await result;
          expect(response).toBe(first);
          expect(await response.text()).toBe(raw);
        }
        expect(fixture.calls).toHaveLength(1);
        expect(waits).not.toHaveBeenCalled();
        expect(parent.used).toBe(4);
        expect(ordinals).toEqual([1]);
      } finally { waits.mockRestore(); dispose(); }
    });
  }

  // #5044. A refused recovery used to leave nothing behind: one physical send, no recovery
  // kind, and a real upstream response — byte-identical in the log to a request where no
  // retry was ever eligible. Those two need opposite follow-ups.
  test.each([429, 503] as const)("a retry the budget refuses is attributed, not silent (%s)", async status => {
    const parent = createRequestExecutionBudget();
    parent.used = 3;
    const { owner, dispose } = budgetOwner(parent);
    const first = new Response(`fixture ${status}`, { status, headers: { "Retry-After": "60" } });
    const fixture = mockFetch([first, new Response("unexpected replay")]);
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    const ordinals: number[] = [];
    const withheld: string[] = [];
    try {
      const hop = owner.reserveCredentialHop("auth-recovery", request.url, true);
      if (!hop.allowed || !hop.permit) throw new Error("Expected final prepaid send");
      owner.pendingHopPermit = hop.permit;
      const scope = owner.adapterDispatchBudget;
      if (!scope) throw new Error("Expected an adapter dispatch budget");
      const response = await fetchVertexWithRetry(request, {
        sendBudget: scope,
        returnRawErrors: true,
        onPhysicalSend: send => ordinals.push(send.ordinal),
        onRecoveryWithheld: event => withheld.push(event.reason),
      });

      // The upstream answer is preserved exactly; the attribution is additional evidence, not
      // a substitute for it.
      expect(response).toBe(first);
      expect(withheld).toEqual(["retry-send-budget"]);
      // And it did not become a send: `sendCount` must keep meaning "requests actually made".
      expect(ordinals).toEqual([1]);
      expect(fixture.calls).toHaveLength(1);
      expect(parent.used).toBe(4);
      expect(waits).not.toHaveBeenCalled();
    } finally { waits.mockRestore(); dispose(); }
  });

  test("a budget-refused 404 reports the withheld recovery (unified lane: 4xx is eligible)", async () => {
    // 统一模型 lane（2026-10-23）：404 现在也是可重放族的一员，被预算拒绝时按 #5044 归因。
    const parent = createRequestExecutionBudget();
    parent.used = 3;
    const { owner, dispose } = budgetOwner(parent);
    const first = new Response(vertexError(404, "NOT_FOUND", "no such model"), { status: 404 });
    mockFetch([first, new Response("unexpected replay")]);
    const withheld: string[] = [];
    try {
      const hop = owner.reserveCredentialHop("auth-recovery", request.url, true);
      if (!hop.allowed || !hop.permit) throw new Error("Expected final prepaid send");
      owner.pendingHopPermit = hop.permit;
      const scope = owner.adapterDispatchBudget;
      if (!scope) throw new Error("Expected an adapter dispatch budget");
      const response = await fetchVertexWithRetry(request, {
        sendBudget: scope,
        returnRawErrors: true,
        onPhysicalSend: () => {},
        onRecoveryWithheld: event => withheld.push(event.reason),
      });
      expect(response).toBe(first);
      expect(withheld).toEqual(["retry-send-budget"]);
    } finally { dispose(); }
  });


  test("successful response bodies survive beyond the response-header timeout", async () => {
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        await Bun.sleep(20);
        controller.enqueue(new TextEncoder().encode("late body"));
        controller.close();
      },
    }), { status: 200 })) as typeof fetch;

    const res = await fetchVertexWithRetry(request, { timeoutMs: 1 });
    expect(await res.text()).toBe("late body");
  });

  test("parent abort after headers still cancels the returned body", async () => {
    const parent = new AbortController();
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }), { status: 200 });
    }) as typeof fetch;

    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000, abortSignal: parent.signal });
    const read = res.body!.getReader().read();
    const reason = new DOMException("client closed", "AbortError");
    parent.abort(reason);
    await expect(read).rejects.toBe(reason);
  });

  test("retries 503 then returns the successful response", async () => {
    const mock = mockFetch([
      new Response(vertexError(503, "UNAVAILABLE", "overloaded"), { status: 503, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(mock.calls).toHaveLength(2);
  });

  test("retries without waiting for retryable response body cancellation", async () => {
    // 行义不变：cancel() 永不 resolve 时重试照走。后退计时器 mock 掉，让 250ms 竞速
    // 只钉"cancel 未被等待"这一件事，而不是撞上 320–480ms 的真实首步退避。
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    // 工厂投递：每送一具新 Response，钩子挂在被投递的那一具本体上——重试路径 cancel 的
    // 正是这具流；mock 对工厂条目不做 clone 规格捕获（clone 的 tee 会替换流、抹掉钩子）。
    const makeStalled = (): Response => {
      const first = new Response("overloaded", { status: 503, headers: { "Retry-After": "0" } });
      const neverSettles = new Promise<void>(() => {});
      const originalCatch = neverSettles.catch.bind(neverSettles);
      Object.defineProperty(neverSettles, "catch", {
        value: (onRejected: (reason: unknown) => unknown) => {
          rejectionObserved = true;
          return originalCatch(onRejected);
        },
      });
      Object.defineProperty(first.body!, "cancel", { value: () => neverSettles });
      return first;
    };
    let rejectionObserved = false;
    const mock = mockFetch([makeStalled, () => new Response("ok", { status: 200 })]);

    const res = await Promise.race([
      fetchVertexWithRetry(request, { timeoutMs: 5_000 }),
      Bun.sleep(250).then(() => { throw new Error("retry waited for response body cancellation"); }),
    ]);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(mock.calls).toHaveLength(2);
    expect(rejectionObserved).toBe(true);
    waits.mockRestore();
  });

  test("retries a thrown network error then succeeds", async () => {
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    const mock = mockFetch([new Error("ECONNRESET"), new Response("ok", { status: 200 })]);
    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
    waits.mockRestore();
  });

  test("retries a quota-exhausted 429 too (unified lane: no body-class veto)", async () => {
    const quota = mockFetch([
      new Response(vertexError(429, "RESOURCE_EXHAUSTED", "Quota exceeded for your current billing plan"), { status: 429, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);
    const qres = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(qres.status).toBe(200);
    expect(quota.calls).toHaveLength(2);

    const rate = mockFetch([
      new Response(vertexError(429, "RESOURCE_EXHAUSTED", "rate limit, try again"), { status: 429, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);
    const rres = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(rres.status).toBe(200);
    expect(rate.calls).toHaveLength(2);
  });

  test("retries a plain 400 to the unified cap and classifies the final body", async () => {
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    const mock = mockFetch([new Response(vertexError(400, "INVALID_ARGUMENT", "bad model"), { status: 400 })]);
    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Vertex AI invalid request");
    expect(mock.calls).toHaveLength(modelRequestMaxAttempts());
    waits.mockRestore();
  });

  test("replays one structurally repaired request after a provider schema 400", async () => {
    const repairableRequest: AdapterRequest = {
      ...request,
      body: JSON.stringify({
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          tools: [{ functionDeclarations: [{
            name: "replace_in_files",
            parameters: { type: "object", properties: { occurrence_ids: { type: "array", items: { type: "string" } } } },
          }] }],
        },
      }),
    };
    const mock = mockFetch([
      new Response(vertexError(400, "INVALID_ARGUMENT", "tools.0.custom.input_schema: JSON schema is invalid"), { status: 400 }),
      new Response("ok", { status: 200 }),
    ]);

    const res = await fetchAntigravityWithRetry(repairableRequest, { timeoutMs: 5_000 });

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
    const replay = JSON.parse(mock.calls[1].body as string);
    expect(replay.request.tools[0].functionDeclarations[0].parameters).toEqual({
      type: "object",
      properties: {},
    });
  });

  test("raw mode preserves final error body and headers without normalization", async () => {
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    const raw = vertexError(400, "INVALID_ARGUMENT", "provider-private-detail");
    const mock = mockFetch([new Response(raw, { status: 400, headers: { "x-provider-error": "raw" } })]);
    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000, returnRawErrors: true });
    expect(res.headers.get("x-provider-error")).toBe("raw");
    expect(await res.text()).toBe(raw);
    expect(mock.calls).toHaveLength(modelRequestMaxAttempts());
    waits.mockRestore();
  });

  test("raw mode retries a quota-exhausted 429 and keeps the raw shape on exhaustion", async () => {
    const raw = vertexError(429, "RESOURCE_EXHAUSTED", "Quota exceeded for billing");
    const mock = mockFetch([
      new Response(raw, { status: 429, headers: { "Retry-After": "0", "x-raw-quota": "1" } }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000, returnRawErrors: true });
    expect(mock.calls).toHaveLength(2);
    expect(res.status).toBe(200);
  });

  test("Antigravity normal mode retains classified redacted errors", async () => {
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    mockFetch([new Response(vertexError(400, "INVALID_ARGUMENT", "bad Authorization: Bearer secret-token"), { status: 400 })]);
    const res = await fetchAntigravityWithRetry(request, { timeoutMs: 5_000 });
    const text = await res.text();
    expect(text).toContain("Antigravity invalid request");
    expect(text).not.toContain("secret-token");
    waits.mockRestore();
  });

  test("Antigravity location denial surfaces as location-not-supported with the upstream 400 (#3467)", async () => {
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    const mock = mockFetch([new Response(
      vertexError(400, "FAILED_PRECONDITION", "User location is not supported for the API use."),
      { status: 400 },
    )]);
    const res = await fetchAntigravityWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Antigravity location not supported");
    expect(text).not.toContain("invalid request");
    // 统一 lane（2026-10-23）：这条 400 也在可重放族里，同目标 ladder 打满预算后按
    // #3467 交付终态分类体；旧"一次即停"合同作废。
    expect(mock.calls).toHaveLength(modelRequestMaxAttempts());
    waits.mockRestore();
  });

  test("retries 401/403 as well (unified lane, cap-bounded, final classified body)", async () => {
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    const mock401 = mockFetch([new Response(vertexError(401, "UNAUTHENTICATED", "bad token"), { status: 401 })]);
    const res401 = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(res401.status).toBe(401);
    expect(await res401.text()).toContain("Vertex AI authentication failed");
    expect(mock401.calls).toHaveLength(modelRequestMaxAttempts());

    const mock403 = mockFetch([new Response(vertexError(403, "PERMISSION_DENIED", "no access"), { status: 403 })]);
    const res403 = await fetchVertexWithRetry(request, { timeoutMs: 5_000 });
    expect(res403.status).toBe(403);
    expect(mock403.calls).toHaveLength(modelRequestMaxAttempts());
    waits.mockRestore();
  });

  test("aborts promptly when the caller signal fires", async () => {
    mockFetch([new Response(vertexError(503, "UNAVAILABLE", "x"), { status: 503, headers: { "Retry-After": "30" } }), new Response("ok", { status: 200 })]);
    const controller = new AbortController();
    const p = fetchVertexWithRetry(request, { timeoutMs: 5_000, abortSignal: controller.signal });
    controller.abort();
    await expect(p).rejects.toBeDefined();
  });

  test("direct AI Studio retries a transient 503 then returns the successful response", async () => {
    const mock = mockFetch([
      new Response(vertexError(503, "UNAVAILABLE", "This model is currently experiencing high demand."), { status: 503, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchDirectGeminiWithRetry(request, { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(mock.calls).toHaveLength(2);
  });

  test("direct AI Studio keeps raw 400 semantics (no repair replay) and retries to the cap", async () => {
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    const raw = vertexError(400, "INVALID_ARGUMENT", "tools.0.custom.input_schema: JSON schema is invalid");
    const mock = mockFetch([
      new Response(raw, { status: 400, headers: { "x-provider-error": "raw" } }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchDirectGeminiWithRetry(request, { timeoutMs: 5_000 });
    // 统一 lane：400 进重放但没有结构修复（AI Studio 无 repair 路径），第二送即恢复。
    // "no repair replay" 钉在重放的字节上：两次投递的 body 逐字相同。
    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]?.body).toBe(mock.calls[0]?.body);
    waits.mockRestore();
  });

  test("direct AI Studio retries a quota-exhausted 429 and serves the recovery", async () => {
    const raw = vertexError(429, "RESOURCE_EXHAUSTED", "Quota exceeded for quota metric 'Generate Content API requests'");
    const mock = mockFetch([
      new Response(raw, { status: 429, headers: { "Retry-After": "0", "x-direct-raw": "quota" } }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchDirectGeminiWithRetry(request, { timeoutMs: 5_000 });
    expect(mock.calls).toHaveLength(2);
    expect(res.status).toBe(200);
  });

  test("direct AI Studio retries transient rate-limit 429s (bounded, raw body on exhaustion)", async () => {
    const waits = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
    const raw = vertexError(429, "RESOURCE_EXHAUSTED", "rate limit, try again");
    const mock = mockFetch([
      new Response(raw, { status: 429, headers: { "Retry-After": "0" } }),
      new Response(raw, { status: 429, headers: { "Retry-After": "0" } }),
      new Response(raw, { status: 429, headers: { "Retry-After": "0", "x-final": "yes" } }),
    ]);
    const res = await fetchDirectGeminiWithRetry(request, { timeoutMs: 5_000 });
    expect(mock.calls).toHaveLength(modelRequestMaxAttempts());
    expect(res.headers.get("x-final")).toBe("yes");
    expect(await res.text()).toBe(raw);
    waits.mockRestore();
  });

  test("fetchGoogleWithRetry routes physical attempts through ctx.executor when provided", async () => {
    const executorCalls: RequestInit[] = [];
    const customExecutor: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      executorCalls.push(init ?? {});
      return new Response("executor-ok", { status: 200 });
    }) as typeof fetch;

    const res = await fetchVertexWithRetry(request, { timeoutMs: 5_000, executor: customExecutor });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("executor-ok");
    expect(executorCalls).toHaveLength(1);
  });
});

describe("safeVertexHttpErrorMessage classification + redaction", () => {
  test("classifies each Google enum row", () => {
    expect(safeVertexHttpErrorMessage(429, vertexError(429, "RESOURCE_EXHAUSTED", "rate"))).toContain("Vertex AI rate limit exceeded");
    expect(safeVertexHttpErrorMessage(429, vertexError(429, "RESOURCE_EXHAUSTED", "quota exceeded for billing"))).toContain("Vertex AI quota exhausted");
    expect(safeVertexHttpErrorMessage(401, vertexError(401, "UNAUTHENTICATED", "x"))).toContain("Vertex AI authentication failed");
    expect(safeVertexHttpErrorMessage(403, vertexError(403, "PERMISSION_DENIED", "x"))).toContain("Vertex AI access denied");
    expect(safeVertexHttpErrorMessage(400, vertexError(400, "INVALID_ARGUMENT", "x"))).toContain("Vertex AI invalid request");
    expect(safeVertexHttpErrorMessage(503, vertexError(503, "UNAVAILABLE", "x"))).toContain("Vertex AI server overloaded");
    expect(safeVertexHttpErrorMessage(500, vertexError(500, "INTERNAL", "x"))).toContain("Vertex AI upstream error");
  });

  test("redacts a bearer token and an absolute path in the detail", () => {
    // A credential header quoted mid-sentence takes the remainder of the line
    // with it: review of the credential-header rule established that anything
    // after the credential is attacker-controlled and cannot be preserved.
    // The scheme word still names which auth failed.
    const msg = safeVertexHttpErrorMessage(400, vertexError(400, "INVALID_ARGUMENT", "failed with Authorization: Bearer secret-abc123 at /Users/example/secret.json"));
    expect(msg).not.toContain("secret-abc123");
    expect(msg).not.toContain("/Users/example/secret.json");
    expect(msg).toContain("Authorization: Bearer [REDACTED]");
  });

  test("redacts an absolute path that is not trailing a credential", () => {
    const msg = safeVertexHttpErrorMessage(400, vertexError(400, "INVALID_ARGUMENT", "failed reading /Users/example/secret.json"));
    expect(msg).not.toContain("/Users/example/secret.json");
    expect(msg).toContain("[REDACTED_PATH]");
  });

  test("retryableGoogleStatus matches the Kiro set", () => {
    for (const s of [429, 500, 502, 503, 504]) expect(retryableGoogleStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 403, 404]) expect(retryableGoogleStatus(s)).toBe(false);
  });
});

describe("adapter fetchResponse wiring", () => {
  test("vertex and antigravity adapters expose fetchResponse; ai-studio direct delegates to canonical server transport", async () => {
    const { createGoogleAdapter } = await import("../../../src/adapters/google");
    const vertex = createGoogleAdapter({ adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex" } as never);
    const aistudio = createGoogleAdapter({ adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k" } as never);
    const antigravity = createGoogleAdapter({ adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", googleMode: "cloud-code-assist" } as never);
    expect(typeof vertex.fetchResponse).toBe("function");
    expect(typeof vertex.formatErrorBody).toBe("function");
    expect(typeof antigravity.fetchResponse).toBe("function");
    expect(typeof antigravity.formatErrorBody).toBe("function");
    expect(aistudio.fetchResponse).toBeUndefined();
    expect(aistudio.formatErrorBody).toBeUndefined();
  });

  test("Vertex and Antigravity formatter hooks are provider-classified and leak-negative", async () => {
    const { createGoogleAdapter } = await import("../../../src/adapters/google");
    const payload = vertexError(400, "INVALID_ARGUMENT", "Bearer secret-token at /Users/example/key.json");
    const vertex = createGoogleAdapter({ adapter: "google", googleMode: "vertex" } as never);
    const antigravity = createGoogleAdapter({ adapter: "google", googleMode: "cloud-code-assist" } as never);
    for (const [adapter, label] of [[vertex, "Vertex AI"], [antigravity, "Antigravity"]] as const) {
      const text = adapter.formatErrorBody!(400, new Headers({ authorization: "Bearer header-secret" }), payload);
      expect(text).toContain(`${label} invalid request`);
      expect(text).not.toContain("secret-token");
      expect(text).not.toContain("header-secret");
      expect(text).not.toContain("/Users/example/key.json");
    }
  });
});
