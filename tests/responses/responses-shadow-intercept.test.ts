/**
 * Shadow call intercept source-model matching (issue #311): Codex 0.145.0 moved
 * its hard-coded helper model from gpt-5.4-mini to gpt-5.6-luna. The current
 * default follows modern clients (gpt-6-luna since Codex 0.154.0, with gpt-5.6-luna
 * kept for 0.145.0-0.153.x), while sourceModels keeps an escape hatch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, isShadowSourceModel } from "../../src/server/responses";
import { DEFAULT_PHANTOM_TOOL_ALLOWLIST, shadowCallPreservesSelectedModel, shadowCallReplacementFor, shadowPhantomToolNames, shadowSourceModelPrefix, shouldInterceptShadowCall } from "../../src/lib/shadow-call";
import { handleManagementAPI } from "../../src/server/management-api";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { shadowPhantomScope } from "../../src/server/responses/shadow-call-route";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { repoPath } from "../helpers/repo-root";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { prepareResponsesRequest } from "../../src/server/responses/request-prepare";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
// Taken only by rows that reach upstream through the direct handler helper.
const takeSpendHome = (): void => { releaseSpendHome = acquireOwnedSpendHome(); };

afterEach(() => {
  // Released first so a failed dispatch cannot leak the writer lease into the next row.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
});

describe("isShadowSourceModel", () => {
  test("matches default shadow source models by prefix", () => {
    expect(isShadowSourceModel("gpt-6-luna")).toBe(true);
    expect(isShadowSourceModel("gpt-6-luna-2026-09")).toBe(true);
    expect(isShadowSourceModel("gpt-5.6-luna")).toBe(true);
    expect(isShadowSourceModel("gpt-5.6-luna-2026-08")).toBe(true);
  });

  test("matches the legacy helper as a default and supports an explicit override", () => {
    // gpt-5.4-mini is now a default source model (Plan B expanded defaults).
    expect(isShadowSourceModel("gpt-5.4-mini")).toBe(true);
    expect(isShadowSourceModel("gpt-5.4-mini", ["gpt-5.4-mini"])).toBe(true);
  });

  test("does not match non-helper models", () => {
    // Fork default source models: the whole ChatGPT-native helper lineup plus upstream's
    // 0.154.0+ gpt-6-luna. Upstream narrowed its own default list to the two luna slugs;
    // the fork keeps the wider lineup because each source maps to its own replacement, and
    // a source with neither a modelMap entry nor a shared fallback is left native anyway.
    expect(isShadowSourceModel("gpt-5.6-terra")).toBe(true);
    expect(isShadowSourceModel("gpt-5.5")).toBe(true);
    expect(isShadowSourceModel("gpt-5.6-sol")).toBe(true);
    // a non-listed native id still does not match.
    expect(isShadowSourceModel("gpt-5.4")).toBe(false);
    expect(isShadowSourceModel("gpt-6-sol")).toBe(false);
    expect(isShadowSourceModel("gpt-6-astra")).toBe(false);
  });

  test("slash request ids only match explicit slash source entries", () => {
    // An explicit routed selection must never be hijacked by a bare entry.
    expect(isShadowSourceModel("openai/gpt-5.6-luna")).toBe(false);
    expect(isShadowSourceModel("openai/gpt-5.6-luna", ["gpt-5.6-luna"])).toBe(false);
    // An operator-configured slash entry is an explicit opt-in and is honored.
    expect(isShadowSourceModel("openai/gpt-5.4", ["openai/gpt-5.4"])).toBe(true);
    expect(isShadowSourceModel("gpt-5.4", ["openai/gpt-5.4"])).toBe(false);
  });

  test("longest configured prefix wins over array order", () => {
    const configured = ["gpt-5.4", "gpt-5.4-mini"];
    expect(isShadowSourceModel("gpt-5.4-mini", configured)).toBe(true);
    expect(shadowSourceModelPrefix("gpt-5.4-mini", configured)).toBe("gpt-5.4-mini");
    expect(shadowSourceModelPrefix("gpt-5.4-2026-01", configured)).toBe("gpt-5.4");
    const reversed = ["gpt-5.4-mini", "gpt-5.4"];
    expect(shadowSourceModelPrefix("gpt-5.4-mini", reversed)).toBe("gpt-5.4-mini");
  });

  test("configured sourceModels replace the defaults", () => {
    expect(isShadowSourceModel("custom-helper-v2", ["custom-helper"])).toBe(true);
    expect(isShadowSourceModel("gpt-5.6-luna", ["custom-helper"])).toBe(false);
  });

  test("tolerates malformed persisted config without throwing", () => {
    expect(isShadowSourceModel("x-model", [1, "", "x"])).toBe(true);
    expect(isShadowSourceModel("gpt-5.6-luna", [1, ""])).toBe(true); // no valid strings -> defaults
    expect(isShadowSourceModel("gpt-5.6-luna", "not-an-array")).toBe(true); // non-array -> defaults
  });

  test("empty array falls back to defaults", () => {
    expect(isShadowSourceModel("gpt-5.6-luna", [])).toBe(true);
  });
});

describe("shouldInterceptShadowCall", () => {
  test("intercepts every shadow source model unconditionally (#1684)", () => {
    const source = { providerName: "openai", modelId: "gpt-5.6-luna" };
    const target = { providerName: "xai", modelId: "grok-4.5" };
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, source, target)).toBe(true);
    expect(shouldInterceptShadowCall("gpt-5.6-luna-2026-08", undefined, source, target)).toBe(true);
  });

 test("does not intercept non-source models", () => {
   const source = { providerName: "openai", modelId: "gpt-5.6-luna" };
   const target = { providerName: "xai", modelId: "grok-4.5" };
    // terra/5.5 are now default source models, so they intercept.
    expect(shouldInterceptShadowCall("gpt-5.6-terra", undefined, source, target)).toBe(true);
    expect(shouldInterceptShadowCall("gpt-5.5", undefined, source, target)).toBe(true);
    // gpt-5.4 is not a default source model.
    expect(shouldInterceptShadowCall("gpt-5.4", undefined, source, target)).toBe(false);
  });

  test("respects configured sourceModels override", () => {
    const source = { providerName: "openai", modelId: "custom-helper" };
    const target = { providerName: "xai", modelId: "grok-4.5" };
    expect(shouldInterceptShadowCall("custom-helper-v2", ["custom-helper"], source, target)).toBe(true);
    expect(shouldInterceptShadowCall("gpt-5.6-luna", ["custom-helper"], source, target)).toBe(false);
  });

  test("matches source-target intersections by provider and model, not slug alone (#2706)", () => {
    const source = {
      providerName: "openai",
      modelId: "gpt-5.6-luna",
    };
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, source, {
      providerName: "openai",
      modelId: "gpt-5.6-luna",
    })).toBe(false);
    expect(shouldInterceptShadowCall("gpt-5.6-luna", undefined, source, {
      providerName: "xai",
      modelId: "gpt-5.6-luna",
    })).toBe(true);
  });
});

describe("shadow-call turn provenance (#6921)", () => {
  const user = JSON.stringify({ request_kind: "turn", thread_source: "user" });
  const helper = JSON.stringify({ request_kind: "turn", thread_source: "memory_consolidation" });
  const headers = (metadata?: string, subagent?: string) => new Headers({
    ...(metadata === undefined ? {} : { "x-codex-turn-metadata": metadata }),
    ...(subagent === undefined ? {} : { "x-openai-subagent": subagent }),
  });
  const frame = (metadata: unknown) => ({
    type: "response.create", model: "gpt-6-luna",
    client_metadata: { "x-codex-turn-metadata": metadata },
  });

  test("preserves only an explicit user turn, not request_kind alone (#1684)", () => {
    expect(shadowCallPreservesSelectedModel({}, headers(user))).toBe(true);
    for (const metadata of [helper, '{"request_kind":"turn"}', '{"thread_source":"user"}',
      '{"request_kind":"memory","thread_source":"user"}']) {
      expect(shadowCallPreservesSelectedModel({}, headers(metadata))).toBe(false);
    }
  });

  test("retains exact spawned-child markers and helper header provenance", () => {
    expect(shadowCallPreservesSelectedModel({}, headers(undefined, "collab_spawn"))).toBe(true);
    expect(shadowCallPreservesSelectedModel({}, headers('{"subagent_kind":"thread_spawn"}'))).toBe(true);
    for (const marker of ["compact", "review", "memory_consolidation", "collab_spawn_extra"]) {
      expect(shadowCallPreservesSelectedModel({}, headers(helper, marker))).toBe(false);
    }
  });

  test("missing and malformed HTTP metadata retains interception compatibility", () => {
    for (const metadata of [undefined, "", "{", "null", "[]", "42", '"user"',
      '{"request_kind":"turn","thread_source":true}']) {
      expect(shadowCallPreservesSelectedModel({}, headers(metadata))).toBe(false);
    }
  });

  test("WS helper frames override a stale user handshake", () => {
    expect(shadowCallPreservesSelectedModel(frame(helper), headers(user), "websocket")).toBe(false);
  });

  test("WS user frames override a stale helper handshake", () => {
    expect(shadowCallPreservesSelectedModel(frame(user), headers(helper, "review"), "websocket")).toBe(true);
  });

  test("WS missing and malformed frame metadata never falls back to handshake provenance", () => {
    for (const body of [{}, { client_metadata: {} }, { client_metadata: null },
      { client_metadata: [] }, ...[undefined, null, 42, {}, "{", "null", "[]"].map(frame)]) {
      expect(shadowCallPreservesSelectedModel(body, headers(user), "websocket")).toBe(false);
    }
  });

  test("WS spawned-child frames and child connections preserve their model", () => {
    const child = '{"request_kind":"turn","subagent_kind":"thread_spawn"}';
    expect(shadowCallPreservesSelectedModel(frame(child), headers(helper), "websocket")).toBe(true);
    // x-openai-subagent is a connection header, not a per-frame one: a child session's
    // own connection keeps its model even when a frame carries no or helper metadata.
    expect(shadowCallPreservesSelectedModel(frame(helper), headers(undefined, "collab_spawn"), "websocket")).toBe(true);
    expect(shadowCallPreservesSelectedModel({}, headers(undefined, "collab_spawn"), "websocket")).toBe(true);
    // A per-frame turn-metadata child marker left on the upgrade is stale and does not.
    expect(shadowCallPreservesSelectedModel(frame(helper), headers(child), "websocket")).toBe(false);
  });

  test("a metadata-eligible Luna helper still observes the provider-specific self-target guard", () => {
    const source = { providerName: "openai", modelId: "gpt-6-luna" };
    expect(shadowCallPreservesSelectedModel({}, headers(helper))).toBe(false);
    expect(shouldInterceptShadowCall("gpt-6-luna", undefined, source, source)).toBe(false);
    expect(shouldInterceptShadowCall("gpt-6-luna", undefined, source,
      { providerName: "xai", modelId: "gpt-6-luna" })).toBe(true);
  });
});

describe("both shadow intercept sites preserve user turns (#6921)", () => {
  const user = JSON.stringify({ request_kind: "turn", thread_source: "user" });
  const helper = JSON.stringify({ request_kind: "turn", thread_source: "memory_consolidation" });

  // Stop at routing: no native OpenAI provider is configured, a concrete helper
  // target is deliberately unavailable, and combo dispatch is injected. No send,
  // account selection, auth-store mutation or spend journal is needed.
  async function probe(target: "concrete" | "combo", metadata?: string, options: {
    websocket?: boolean; frameMetadata?: unknown; subagent?: string;
  } = {}) {
    return withTempHome(async () => {
      const config = target === "combo"
        ? comboInterceptConfig([{ provider: "xai", model: "grok-4.5" }]) : interceptConfig();
      if (target === "concrete") config.providers.xai.disabled = true;
      const input = {
        model: "gpt-6-luna", input: "hi", stream: false,
        ...(Object.hasOwn(options, "frameMetadata")
          ? { client_metadata: { "x-codex-turn-metadata": options.frameMetadata } } : {}),
      };
      const logCtx: RequestLogContext = { model: "", provider: "" };
      let parsedBody: unknown;
      let comboBody: unknown;
      const response = await prepareResponsesRequest({
        req: new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json",
            ...(metadata === undefined ? {} : { "x-codex-turn-metadata": metadata }),
            ...(options.subagent ? { "x-openai-subagent": options.subagent } : {}),
          },
          body: JSON.stringify(input),
        }), config, logCtx, options: {
          translatorBudget: createTestTranslatorBudget(),
          ...(options.websocket ? { inboundTransport: "websocket" as const } : {}),
          onRequestBodyParsed: body => { parsedBody = body; },
        },
      }, { pendingHostAdmissionLease: null, authCtx: { kind: "main", accountId: null } }, {
        handleResponses: () => Promise.reject(new Error("unexpected recursion")),
        handleComboResponses: async (_req, body, comboId, _config, _log, comboOptions) => {
          expect(comboId).toBe("shadow");
          expect(comboOptions.shadowCallIntercepted).toBe(true);
          comboBody = body;
          return new Response(null, { status: 202 });
        },
      });
      expect(response).toBeInstanceOf(Response);
      if (!(response instanceof Response)) throw new Error("expected routing to stop before dispatch");
      return { response, logCtx, parsedBody, comboBody };
    });
  }

  for (const target of ["concrete", "combo"] as const) {
    async function assertPreserved(metadata: string | undefined, options?: Parameters<typeof probe>[2]) {
      const result = await probe(target, metadata, options);
      expect(result.response.status).toBe(404); // original bare Luna needs an OpenAI route
      expect(await result.response.text()).toContain("gpt-6-luna");
      expect(result.parsedBody).toMatchObject({ model: "gpt-6-luna" });
      expect(result.logCtx.shadowCallRewrittenFrom).toBeUndefined();
      expect(result.comboBody).toBeUndefined();
    }
    async function assertIntercepted(metadata: string | undefined, options?: Parameters<typeof probe>[2]) {
      const result = await probe(target, metadata, options);
      expect(result.logCtx.shadowCallRewrittenFrom).toBe("gpt-6-luna");
      if (target === "combo") {
        expect(result.response.status).toBe(202);
        expect(result.comboBody).toMatchObject({ model: "combo/shadow" });
      } else {
        expect(result.response.status).toBe(409);
        expect(result.logCtx.errorCode).toBe("intercept_target_unavailable");
      }
    }

    test(`${target} target preserves an explicit HTTP user turn`, () => assertPreserved(user));
    test(`${target} target still intercepts turn-kind helpers (#1684)`, () => assertIntercepted(helper));
    test(`${target} target still intercepts missing and malformed HTTP metadata`, async () => {
      for (const metadata of [undefined, "{", "null", '{"request_kind":"turn"}']) {
        await assertIntercepted(metadata);
      }
    });
    test(`${target} target preserves both HTTP spawned-child markers`, async () => {
      await assertPreserved(undefined, { subagent: "collab_spawn" });
      await assertPreserved('{"subagent_kind":"thread_spawn"}');
    });
    test(`${target} target uses WS frame provenance over the handshake in both directions`, async () => {
      await assertIntercepted(user, { websocket: true, frameMetadata: helper });
      await assertPreserved(helper, { websocket: true, frameMetadata: user });
    });
    test(`${target} target intercepts missing and malformed WS metadata despite a user handshake`, async () => {
      await assertIntercepted(user, { websocket: true });
      for (const frameMetadata of ["{", "null", 42, null]) {
        await assertIntercepted(user, { websocket: true, frameMetadata });
      }
    });
    test(`${target} target preserves a WS spawned-child frame`, () => assertPreserved(helper, {
      websocket: true, frameMetadata: '{"subagent_kind":"thread_spawn"}',
    }));
    test(`${target} target preserves every frame of a WS child connection`, () => assertPreserved(undefined, {
      websocket: true, subagent: "collab_spawn",
    }));
  }
});

function interceptConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "test-xai-key",
      },
    },
    shadowCallIntercept: { enabled: true, model: "xai/grok-4.5" },
  } as OcxConfig;
}

async function post(
  config: OcxConfig,
  model: string,
  requestKind?: string,
  logCtx: RequestLogContext = { model: "", provider: "" },
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (requestKind) {
    headers["x-codex-turn-metadata"] = JSON.stringify({ request_kind: requestKind });
  }
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: false,
      reasoning: { effort: "high" },
    }),
  }), config, logCtx);
}

describe("shadow call intercept request path (issue #311)", () => {
  test("rewrites a gpt-5.6-luna helper call without overriding configured effort (#2706)", async () => {
    takeSpendHome();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await post(interceptConfig(), "gpt-5.6-luna", "memory");

    expect(bodies.length).toBe(1);
    // Routed through xai openai-chat: upstream model is the decoded routed id, not the helper id
    expect(String(bodies[0]?.model ?? "")).toContain("grok-4.5");
    const effort = (bodies[0]?.reasoning as { effort?: string } | undefined)?.effort
      ?? bodies[0]?.reasoning_effort;
    expect(effort).toBe("high");
  });

  test("a self-target is a no-op instead of an intercept loop (#2706)", async () => {
    takeSpendHome();
    const bodies: Array<Record<string, unknown>> = [];
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as typeof fetch;

    const config = interceptConfig();
    config.shadowCallIntercept = {
      enabled: true,
      model: "xai/custom-helper",
      sourceModels: ["custom-helper"],
    };

    const response = await post(config, "custom-helper", "turn", logCtx);

    expect(response.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.model).toBe("custom-helper");
    expect(logCtx.shadowCallRewrittenFrom).toBeUndefined();
  });

  test("rewrites a gpt-5.6-luna turn request too (#1684)", async () => {
    takeSpendHome();
    const bodies: Array<Record<string, unknown>> = [];
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await post(interceptConfig(), "gpt-5.6-luna", "turn", logCtx);

    expect(bodies.length).toBe(1);
    expect(String(bodies[0]?.model ?? "")).toContain("grok-4.5");
    expect(logCtx.shadowCallRewrittenFrom).toBe("gpt-5.6-luna");
  });

  test("rewrites a gpt-6-luna helper call from Codex 0.154.0+ and records that prefix", async () => {
    takeSpendHome();
    const bodies: Array<Record<string, unknown>> = [];
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return chatOk("ok");
    }) as typeof fetch;

    await post(interceptConfig(), "gpt-6-luna", "turn", logCtx);

    expect(bodies.length).toBe(1);
    expect(String(bodies[0]?.model ?? "")).toContain("grok-4.5");
    expect(logCtx.shadowCallRewrittenFrom).toBe("gpt-6-luna");
  });

  // gpt-6-luna is both the helper slug and a default sub-agent model, so a spawned child that
  // chose it must keep it. Both markers Codex puts on spawned children are honoured; other
  // internal turns that reuse x-openai-subagent (compact, review) are still helpers.
  for (const [label, headers] of [
    ["x-openai-subagent: collab_spawn", { "x-openai-subagent": "collab_spawn" }],
    ["subagent_kind thread_spawn metadata", { "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }) }],
  ] as const) {
    test(`a spawned sub-agent turn is never intercepted (${label})`, async () => {
      takeSpendHome();
      const bodies: Array<Record<string, unknown>> = [];
      const logCtx: RequestLogContext = { model: "", provider: "" };
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return chatOk("ok");
      }) as typeof fetch;

      await post(interceptConfig(), "gpt-6-luna", undefined, logCtx, headers);

      expect(logCtx.shadowCallRewrittenFrom).toBeUndefined();
      expect(bodies.some(body => String(body.model ?? "").includes("grok-4.5"))).toBe(false);
    });
  }

  test("a maintenance turn tagged x-openai-subagent: compact is still intercepted", async () => {
    takeSpendHome();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async () => chatOk("ok")) as typeof fetch;

    await post(interceptConfig(), "gpt-6-luna", undefined, logCtx, { "x-openai-subagent": "compact" });

    expect(logCtx.shadowCallRewrittenFrom).toBe("gpt-6-luna");
  });

  // The intercept matches by PREFIX, so a caller can append anything and still be intercepted.
  // The recorded marker is persisted to usage.jsonl and served from /api/logs, and the runtime
  // redactor is pattern-based: a credential family it does not recognize would survive verbatim.
  // Recording the operator-configured prefix instead of the caller's raw string removes the
  // class, rather than adding one more pattern to a deny-list.
  test("the recorded marker is the configured prefix, never the caller's raw model string", async () => {
    takeSpendHome();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    // A Google-shaped key: the runtime redactor has no rule for this family, and the newline
    // is stripped before redaction runs, so the old code persisted this string intact.
    const smuggled = "gpt-5.6-luna\nAIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6";
    await post(interceptConfig(), smuggled, "turn", logCtx);

    expect(logCtx.shadowCallRewrittenFrom).toBe("gpt-5.6-luna");
    expect(logCtx.shadowCallRewrittenFrom ?? "").not.toContain("AIza");
  });

  test("a configured non-default prefix is recorded as itself", async () => {
    takeSpendHome();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const config = interceptConfig();
    config.shadowCallIntercept = { enabled: true, model: "grok-4.5", sourceModels: ["gpt-5.4-mini"] };
    await post(config, "gpt-5.4-mini-2024-07-18", "turn", logCtx);

    expect(logCtx.shadowCallRewrittenFrom).toBe("gpt-5.4-mini");
  });

  test("rewrites gpt-5.6-terra to the configured fallback model", async () => {
    takeSpendHome();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const response = await post(interceptConfig(), "gpt-5.6-terra");
    // terra is now a default source model; the shared `model` fallback rewrites it.
    expect(response.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(String(bodies[0]?.model ?? "")).toContain("grok-4.5");
  });
});

/**
 * A shadow-call replacement naming a COMBO used to run exactly one attempt and never enter
 * the failover loop (#4129). Two cooperating causes: the combo gate reads the UN-rewritten
 * body, where the model is still the bare helper slug, and the late intercept resolved the
 * replacement through routeModel/tryPickComboModel, which collapses the combo table to a
 * single target while still tagging routeKind "combo" — so the reported "combo route, one
 * attempt" was a collapsed native pick, and 429/5xx hops (which only exist inside
 * handleComboResponses) were unreachable.
 */
function comboInterceptConfig(
  targets: Array<{ provider: string; model: string }>,
  shadowCallIntercept: Record<string, unknown> = { enabled: true, model: "combo/shadow" },
): OcxConfig {
  return {
    port: 0,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "test-xai-key",
      },
      alt: {
        adapter: "openai-chat",
        baseUrl: "https://alt.example/v1",
        authMode: "key",
        apiKey: "test-alt-key",
      },
    },
    combos: {
      shadow: { strategy: "failover", targets },
    },
    shadowCallIntercept,
  } as unknown as OcxConfig;
}

function chatOk(text: string): Response {
  return Response.json({
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

describe("a combo shadow-call target enters the failover loop (#4129)", () => {
  test("a combo child of a shadow-intercepted call gets Cursor conversation isolation", async () => {
    const config = comboInterceptConfig([{ provider: "xai", model: "grok-4.5" }]);
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const mkreq = () => new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-4.5",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        stream: false,
      }),
    });
    const dispatchers = {
      handleResponses: () => Promise.reject(new Error("unexpected recursion")),
      handleComboResponses: () => Promise.reject(new Error("unexpected combo dispatch")),
    };
    const admission = () => ({ pendingHostAdmissionLease: null, authCtx: { kind: "main", accountId: null } }) as never;

    const intercepted = await prepareResponsesRequest(
      { req: mkreq(), config, logCtx, options: { comboAttempt: true, shadowCallIntercepted: true, translatorBudget: createTestTranslatorBudget() } },
      admission(),
      dispatchers,
    );
    expect(intercepted).not.toBeInstanceOf(Response);
    if (intercepted instanceof Response) throw new Error("expected a prepared request, got HTTP " + intercepted.status);
    expect(intercepted.parsed._cursorIsolateConversation).toBe(true);

    // A plain combo child (no interception marker) must not be isolated.
    const plain = await prepareResponsesRequest(
      { req: mkreq(), config, logCtx, options: { comboAttempt: true, translatorBudget: createTestTranslatorBudget() } },
      admission(),
      dispatchers,
    );
    expect(plain).not.toBeInstanceOf(Response);
    if (plain instanceof Response) throw new Error("expected a prepared request, got HTTP " + plain.status);
    expect(plain.parsed._cursorIsolateConversation).not.toBe(true);
  });

  test("carries helper conversation isolation into concrete combo children", () => {
    const prepare = readFileSync(repoPath("src/server/responses/request-prepare.ts"), "utf8");
    const comboDispatchStart = prepare.indexOf("return requestDispatchers.handleComboResponses(");
    const comboDispatchEnd = prepare.indexOf("let unreadableEncryptedAgentTask", comboDispatchStart);
    expect(comboDispatchStart).toBeGreaterThanOrEqual(0);
    expect(comboDispatchEnd).toBeGreaterThan(comboDispatchStart);
    const comboDispatch = prepare.slice(comboDispatchStart, comboDispatchEnd);
    const parsedHandoff = prepare.slice(
      prepare.indexOf("if (cursorClientThreadId) parsed._cursorClientThreadId"),
      prepare.indexOf("} catch (err)", prepare.indexOf("if (cursorClientThreadId) parsed._cursorClientThreadId")),
    );

    expect(comboDispatch).toContain("shadowCallIntercepted,");
    expect(parsedHandoff).toContain(
      "if (options.shadowCallIntercepted === true) parsed._cursorIsolateConversation = true;",
    );
  });

  test("a helper call rewritten to a combo hops past a 429 to the second target", async () => {
    takeSpendHome();
    // The 429 hops to the next combo target once per target. The unified model lane
    // (7d4957b231) retries a 429 on the same target inside the shared budget, which
    // would consume the first target's turn here; this row pins the combo hop with the
    // ladder at its minimum (env=1 -> the combo per-target initial allowance of one
    // send wins the intersection). Same-target ladder behavior is pinned in
    // model-request-http-retry.test.ts.
    const prevModelRetries = process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
    process.env.OCX_MODEL_REQUEST_MAX_RETRIES = "1";
    const urls: string[] = [];
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return urls.length === 1
        ? Response.json({ error: { message: "rate limited" } }, { status: 429 })
        : chatOk("ok");
    }) as typeof fetch;

    const config = comboInterceptConfig([
      { provider: "xai", model: "grok-4.5" },
      { provider: "alt", model: "grok-4.5" },
    ]);
    const response = await post(config, "gpt-5.6-luna", "turn", logCtx);

    if (prevModelRetries === undefined) delete process.env.OCX_MODEL_REQUEST_MAX_RETRIES;
    else process.env.OCX_MODEL_REQUEST_MAX_RETRIES = prevModelRetries;
    expect(response.ok).toBe(true);
    // The whole point: two upstream attempts, in configured order.
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("api.x.ai");
    expect(urls[1]).toContain("alt.example");
    expect(logCtx.provider).toBe("combo");
    expect(logCtx.comboId).toBe("shadow");
    expect(logCtx.routeDecision?.routeKind).toBe("combo");
    expect(logCtx.shadowCallRewrittenFrom).toBe("gpt-5.6-luna");
    const attempts = (logCtx.attempts ?? []) as Array<{ provider?: string; model?: string }>;
    expect(attempts).toHaveLength(2);
    expect(attempts.map(a => `${a.provider}/${a.model}`))
      .toEqual(["xai/grok-4.5", "alt/grok-4.5"]);
  });

  test("a spawned sub-agent turn never takes the early combo rewrite either", async () => {
    takeSpendHome();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async () => chatOk("ok")) as typeof fetch;

    const config = comboInterceptConfig([{ provider: "xai", model: "grok-4.5" }]);
    await post(config, "gpt-6-luna", undefined, logCtx, { "x-openai-subagent": "collab_spawn" });

    expect(logCtx.comboId).toBeUndefined();
    expect(logCtx.shadowCallRewrittenFrom).toBeUndefined();
  });

  test("a combo whose first target intersects the source still routes as a combo", async () => {
    takeSpendHome();
    const urls: string[] = [];
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return chatOk("ok");
    }) as typeof fetch;

    // The #2706 self-target shape: the source model routes to xai, and the combo's FIRST
    // target is that same provider+model. shadowCallTargetsIntersect is therefore true for
    // the collapsed one-candidate pick, which is what used to suppress the intercept
    // outright and leave the request on a plain native route.
    const config = comboInterceptConfig(
      [
        { provider: "xai", model: "custom-helper" },
        { provider: "alt", model: "grok-4.5" },
      ],
      { enabled: true, model: "combo/shadow", sourceModels: ["custom-helper"] },
    );
    const response = await post(config, "custom-helper", "turn", logCtx);

    expect(response.ok).toBe(true);
    // A healthy first target still costs exactly one upstream call.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("api.x.ai");
    expect(logCtx.provider).toBe("combo");
    expect(logCtx.comboId).toBe("shadow");
    expect(logCtx.routeDecision?.routeKind).toBe("combo");
    // Red before the fix: shouldInterceptShadowCall saw the collapsed pick as a self-target,
    // skipped the rewrite, and the request left as a plain native route with no marker.
    expect(logCtx.shadowCallRewrittenFrom).toBe("custom-helper");
  });

  test("a non-combo replacement still takes the ordinary late intercept", async () => {
    takeSpendHome();
    const urls: string[] = [];
    const logCtx: RequestLogContext = { model: "", provider: "" };
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return chatOk("ok");
    }) as typeof fetch;

    const config = comboInterceptConfig([{ provider: "xai", model: "grok-4.5" }]);
    config.shadowCallIntercept = { enabled: true, model: "xai/grok-4.5" };
    const response = await post(config, "gpt-5.6-luna", "turn", logCtx);

    expect(response.ok).toBe(true);
    expect(urls).toHaveLength(1);
    expect(logCtx.comboId).toBeUndefined();
    expect(logCtx.shadowCallRewrittenFrom).toBe("gpt-5.6-luna");
  });
});

/**
 * The GUI badge/tooltip used to hard-code "5.4-mini", so it kept naming a model
 * Codex no longer sends. The management API is the single source of truth for
 * which models are intercepted; every client renders what it reports.
 */
async function withTempHome<T>(run: () => Promise<T>): Promise<T> {
  const previousHome = process.env.OPENCODEX_HOME;
  const dir = mkdtempSync(join(tmpdir(), "ocx-shadow-"));
  process.env.OPENCODEX_HOME = dir;
  try {
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(dir);
  }
}

async function shadowApi(config: OcxConfig, method: string, body?: unknown): Promise<Record<string, unknown>> {
  // Management API enforces a same-origin gate; a browserless caller must look local.
  const headers: Record<string, string> = { origin: "http://127.0.0.1:10100", host: "127.0.0.1:10100" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request("http://localhost/api/shadow-call-settings", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  return await res!.json() as Record<string, unknown>;
}

async function shadowApiResponse(config: OcxConfig, body: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/shadow-call-settings", {
    method: "PUT",
    headers: {
      origin: "http://127.0.0.1:10100",
      host: "127.0.0.1:10100",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  expect(res).not.toBeNull();
  return res!;
}

describe("shadow-call settings API reports the intercepted source models", () => {
  test("GET reports the helper-model defaults, Q38-Flash-Next first", async () => {
    await withTempHome(async () => {
      const body = await shadowApi({ port: 0, defaultProvider: "xai", providers: {} } as OcxConfig, "GET");
      expect(body.sourceModels).toEqual([
        "gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4-mini",
      ]);
    });
  });

  test("GET and PUT report a configured override instead of the defaults", async () => {
    await withTempHome(async () => {
      const config = {
        port: 0,
        defaultProvider: "xai",
        providers: {
          xai: {
            adapter: "openai-chat",
            baseUrl: "https://api.x.ai/v1",
            authMode: "key",
            apiKey: "test-xai-key",
          },
        },
        shadowCallIntercept: { enabled: true, model: "xai/grok-4.5", sourceModels: ["gpt-5.6-luna"] },
      } as OcxConfig;
      expect((await shadowApi(config, "GET")).sourceModels).toEqual(["gpt-5.6-luna"]);
      const put = await shadowApi(config, "PUT", { enabled: true });
      expect(put.sourceModels).toEqual(["gpt-5.6-luna"]);
    });
  });

  test("PUT rejects an invalid self-target without persisting it (#2706)", async () => {
    await withTempHome(async () => {
      const config = {
        port: 0,
        defaultProvider: "xai",
        providers: {
          xai: {
            adapter: "openai-chat",
            baseUrl: "https://api.x.ai/v1",
            authMode: "key",
            apiKey: "test-xai-key",
          },
        },
        shadowCallIntercept: { sourceModels: ["custom-helper"] },
      } as OcxConfig;

      const response = await shadowApiResponse(config, { enabled: true, model: "xai/custom-helper" });

      expect(response.status).toBe(400);
     expect(config.shadowCallIntercept).toEqual({ sourceModels: ["custom-helper"] });
   });
 });
});

describe("shadowCallReplacementFor (Plan B per-source mapping)", () => {
  test("prefers modelMap over the shared model fallback", () => {
    const sci = { enabled: true, model: "xai/grok-4.5", modelMap: { "gpt-5.6-luna": "deepseek/deepseek-chat" } };
    expect(shadowCallReplacementFor("gpt-5.6-luna", sci)).toBe("deepseek/deepseek-chat");
    expect(shadowCallReplacementFor("gpt-5.6-sol", sci)).toBe("xai/grok-4.5");
  });

  test("returns undefined when no replacement is configured for the source", () => {
    expect(shadowCallReplacementFor("gpt-5.6-luna", { enabled: true })).toBeUndefined();
    const sci = { enabled: true, modelMap: { "gpt-5.6-luna": "xai/grok-4.5" } };
    expect(shadowCallReplacementFor("gpt-5.6-terra", sci)).toBeUndefined();
  });

  test("each source routes to a different third-party model", () => {
    const sci = {
      enabled: true,
      modelMap: {
        "gpt-5.6-luna": "deepseek/deepseek-chat",
        "gpt-5.6-sol": "anthropic/claude-opus-5",
        "gpt-5.6-terra": "xai/grok-4.5",
        "gpt-5.5": "google/gemini-3-pro",
        "gpt-5.4-mini": "ollama/llama3",
      },
    };
    expect(shadowCallReplacementFor("gpt-5.6-luna", sci)).toBe("deepseek/deepseek-chat");
    expect(shadowCallReplacementFor("gpt-5.6-sol", sci)).toBe("anthropic/claude-opus-5");
    expect(shadowCallReplacementFor("gpt-5.6-terra", sci)).toBe("xai/grok-4.5");
    expect(shadowCallReplacementFor("gpt-5.5", sci)).toBe("google/gemini-3-pro");
    expect(shadowCallReplacementFor("gpt-5.4-mini", sci)).toBe("ollama/llama3");
  });
});

// The phantom-tool tolerance now lives with the shadow intercept (global list, default
// on) instead of per-provider undeclaredToolAllowlist. These pin the scoping decision:
// shadow-replaced requests tolerate the listed names, everything else fails closed.
describe("shadow phantom-tool allowlist scoping", () => {
  test("shadowPhantomToolNames defaults to the built-in list", () => {
    const names = shadowPhantomToolNames({});
    expect(names.has("update_plan")).toBe(true);
    expect(names.has("web__run")).toBe(true);
    expect(names.has("tools__apply_patch")).toBe(true);
    expect(names.size).toBe(DEFAULT_PHANTOM_TOOL_ALLOWLIST.length);
  });

  test("the kill switch empties the list", () => {
    expect(shadowPhantomToolNames({ phantomToolAllowlistEnabled: false }).size).toBe(0);
  });

  test("an explicit operator list replaces the defaults; empty means fail-closed", () => {
    expect(Array.from(shadowPhantomToolNames({ phantomToolAllowlist: ["web__run"] }))).toEqual(["web__run"]);
    expect(shadowPhantomToolNames({ phantomToolAllowlist: [] }).size).toBe(0);
  });

  test("a shadow-replaced request drops an allowlisted phantom and completes", async () => {
    takeSpendHome();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: "all done",
            tool_calls: [{ id: "call-p", type: "function", function: { name: "update_plan", arguments: "{}" } }],
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools: [{ type: "function", function: { name: "web_search", parameters: {} } }],
        stream: false,
      }),
    }), interceptConfig(), { model: "", provider: "" });

    expect(response.status).toBe(200);
    const payload = JSON.stringify(await response.json());
    expect(payload).not.toContain("undeclared client tool");
    expect(payload).not.toContain("update_plan");
    expect(payload).toContain("all done");
    expect(bodies.length).toBeGreaterThan(0);
    expect(String(bodies[0]?.model ?? "")).toContain("grok");
  });

  test("a NON-shadow request keeps fail-closed behavior for the same name", async () => {
    takeSpendHome();
    globalThis.fetch = (async () => Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: "all done",
          tool_calls: [{ id: "call-p", type: "function", function: { name: "update_plan", arguments: "{}" } }],
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })) as typeof fetch;

    // xai/grok-4.5 is a direct routed selection: no shadow intercept, no tolerance.
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "xai/grok-4.5",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools: [{ type: "function", function: { name: "web_search", parameters: {} } }],
        stream: false,
      }),
    }), interceptConfig(), { model: "", provider: "" });

    // The batch bridge fails the turn closed: the completion carries status
    // "failed" with the undeclared-tool error (same shape the allowlist regression
    // tests pin); the phantom call never reaches the client as an output item.
    expect(response.status).toBe(200);
    const payload = JSON.stringify(await response.json());
    expect(payload).toContain("undeclared client tool");
    expect(payload).toContain("failed");
    expect(payload).not.toContain('"name":"update_plan"');
  });

  // Wiring tests for the per-request directive-correction budget
  // (shadowCallIntercept.phantomToolFeedbackMax): a rejected call on a request with a
  // declared exec channel reaches the model as an exec directive instead of the silent
  // drop or the fail-closed error. The budget follows the THIRD-PARTY gate, so it is
  // allocated on direct (non-shadow) third-party routes too; the phantom ALLOWLIST stays
  // shadow-scoped, because a replayed native name is a property of the replacement model.
  // The OpenAI-operated official Responses endpoint stays fail-closed on every layer.
  const execDeclaringBody = (model: string) => JSON.stringify({
    model,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools: [
      { type: "function", function: { name: "web_search", parameters: {} } },
      { type: "custom", name: "exec" },
    ],
    stream: false,
  });
  const phantomFetch = () => {
    takeSpendHome();
    globalThis.fetch = (async () => Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: "all done",
          tool_calls: [{ id: "call-p", type: "function", function: { name: "update_plan", arguments: "{}" } }],
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })) as typeof fetch;
  };

  test("a shadow request with a declared exec gets the directive correction, not a silent drop", async () => {
    phantomFetch();
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: execDeclaringBody("gpt-5.6-luna"),
    }), interceptConfig(), { model: "", provider: "" });
    expect(response.status).toBe(200);
    const payload = JSON.stringify(await response.json());
    expect(payload).toContain("undeclared-tool repair");
    expect(payload).toContain("web_search");
    expect(payload).toContain("completed");
    expect(payload).not.toContain("undeclared client tool");
    expect(payload).not.toContain('"name":"update_plan"');
  });

  test("a DIRECT third-party request with exec declared is answered with the directive", async () => {
    // The observed production failure: an explicit-provider (non-shadow) route emitted a
    // name the request never declared, owned no budget, and the turn died as an undeclared
    // 502 / empty round. Third-party routes now own the correction budget, so the model is
    // told what is declared and can retry in form.
    phantomFetch();
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: execDeclaringBody("xai/grok-4.5"),
    }), interceptConfig(), { model: "", provider: "" });
    const payload = JSON.stringify(await response.json());
    expect(payload).toContain("undeclared-tool repair");
    expect(payload).not.toContain("undeclared client tool");
    expect(payload).not.toContain('"name":"update_plan"');
  });

  test("a direct third-party request gets no shadow allowlist, and no budget means fail closed", async () => {
    // Scoping split, pinned: the budget follows the route, the allowlist follows the model.
    // An allowlisted name on a direct route is a FRESH hallucination - it is answered by the
    // declared-catalog directive, never dropped silently, and with the budget switched off
    // the same turn fails closed as it did before the directive layer existed.
    phantomFetch();
    const config = interceptConfig();
    config.shadowCallIntercept = { ...config.shadowCallIntercept, phantomToolFeedbackMax: 0 };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: execDeclaringBody("xai/grok-4.5"),
    }), config, { model: "", provider: "" });
    const payload = JSON.stringify(await response.json());
    expect(payload).toContain("undeclared client tool");
    expect(payload).not.toContain("undeclared-tool repair");
  });

  test("a direct third-party STREAM gets the gate as well as the budget", async () => {
    takeSpendHome();
    // The budget is only half the fix: the bridge skips its whole emission-repair layer
    // (name repair, the container drop tier, the filtered-container terminal) unless the
    // serving-route gate rides the translator options. A streaming direct-third-party turn
    // that emits an all-caps container must therefore be answered with a directive here,
    // exactly as the buffered twin above - pinned end-to-end through the adapter-delivery
    // path (stream=true, openai-chat upstream), not at the guard layer.
    const zw = String.fromCharCode(0x200b);
    const sseUpstream = (name: string) => {
      globalThis.fetch = (async () => new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-c", function: { name, arguments: "{}" } }] } }] })}`,
        "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    };
    const streamBody = JSON.stringify({
      model: "xai/grok-4.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [
        { type: "function", function: { name: "web_search", parameters: {} } },
        { type: "custom", name: "exec" },
      ],
      stream: true,
    });
    const postStream = () => handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: streamBody,
    }), interceptConfig(), { model: "", provider: "" });

    // Case 1: all-caps container. With the gate threaded, the container is recognized through
    // the shared glyph fold and answered with a directive (budget paid); the turn completes.
    sseUpstream("TOOLS");
    const sse = await (await postStream()).text();
    expect(sse).toContain("undeclared-tool repair");
    expect(sse).toContain("response.completed");
    expect(sse).not.toContain("response.failed");
    expect(sse).not.toContain('"name":"TOOLS"');

    // Case 2: budget spent (max 0) -> the same emission falls to the container tier: dropped
    // and, with no valid call in the turn, the terminal states the loss instead of relaying
    // the container (the client would end the turn on unsupported call).
    const noBudget = interceptConfig();
    noBudget.shadowCallIntercept = { ...noBudget.shadowCallIntercept, phantomToolFeedbackMax: 0 };
    sseUpstream("tools" + zw);
    const dropped = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: streamBody,
    }), noBudget, { model: "", provider: "" });
    const droppedText = await dropped.text();
    expect(droppedText).not.toContain("undeclared client tool");
    expect(droppedText).not.toContain('"name":"tools' + zw + '"');
    expect(droppedText).toContain("filtered_container_no_valid_output");
  });

  test("the official OpenAI-operated endpoint allocates no budget (gate=false)", () => {
    // The official Responses destination is the one route the fork must never apply
    // third-party semantics to, and the budget is the third-party lever. The integration
    // path for that endpoint needs a real account pool, so the allocation itself is pinned
    // at the scope function (the bridge/gate pair is pinned by
    // tool-name-repair-official-gate.test.ts).
    const officialRoute = {
      providerName: "openai",
      provider: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } as OcxProviderConfig,
    };
    const config = interceptConfig();
    const direct = shadowPhantomScope({ modelId: "gpt-5.6-luna" } as OcxParsedRequest, config, officialRoute);
    expect(direct.undeclaredToolFeedbackBudget).toBeUndefined();
    expect(direct.undeclaredPhantomNames.size).toBe(0);
    // An internal baseUrl under the same "openai" provider name is third-party, and gets it.
    const internal = shadowPhantomScope({ modelId: "gpt-5.6-luna" } as OcxParsedRequest, config, {
      providerName: "openai",
      provider: { adapter: "openai-responses", baseUrl: "https://8802-248.ai-t.wtvdev.com/v1", authMode: "api-key" } as OcxProviderConfig,
    });
    expect(internal.undeclaredToolFeedbackBudget?.remaining).toBe(2);
    // Shadow interception keeps its historical allocation with or without the route argument.
    const shadow = { modelId: "gpt-5.6-luna", _shadowIntercepted: true } as OcxParsedRequest;
    expect(shadowPhantomScope(shadow, config, officialRoute).undeclaredToolFeedbackBudget?.remaining).toBe(2);
    expect(shadowPhantomScope(shadow, config).undeclaredToolFeedbackBudget?.remaining).toBe(2);
    // A direct third-party request without the route argument keeps the old shadow-only
    // allocation, so callers that cannot pass a route change nothing.
    expect(shadowPhantomScope({ modelId: "xai/grok-4.5" } as OcxParsedRequest, config).undeclaredToolFeedbackBudget).toBeUndefined();
    // No shadowCallIntercept block at all is the DEFAULT configuration, not an opt-out, so
    // the direct third-party route gets the default budget there too - the fleet that hit
    // the production failure runs exactly this shape.
    const thirdRoute = {
      providerName: "llm-248",
      provider: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:8800/v1", authMode: "api-key" } as OcxProviderConfig,
    };
    expect(shadowPhantomScope({ modelId: "llm-248/Q38-Flash-Next" } as OcxParsedRequest, {} as OcxConfig, thirdRoute).undeclaredToolFeedbackBudget?.remaining).toBe(2);
    // The explicit kill switch still wins over the absent block.
    expect(shadowPhantomScope({ modelId: "llm-248/Q38-Flash-Next" } as OcxParsedRequest, {
      shadowCallIntercept: { phantomToolAllowlistEnabled: false },
    } as OcxConfig, thirdRoute).undeclaredToolFeedbackBudget).toBeUndefined();
  });

  test("the kill switch removes the directive path on every route (pure fail-closed)", async () => {
    phantomFetch();
    const config = interceptConfig();
    config.shadowCallIntercept = { ...config.shadowCallIntercept, phantomToolAllowlistEnabled: false };
    const send = async (model: string) => {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: execDeclaringBody(model),
      }), config, { model: "", provider: "" });
      return JSON.stringify(await response.json());
    };
    // Shadow traffic keeps its historical behaviour; the DIRECT third-party route the budget
    // was just extended to loses it in the same breath. The operator who turned the allowlist
    // off asked for pure fail-closed, not for fail-closed on one family of third-party calls.
    expect(await send("gpt-5.6-luna")).toContain("undeclared client tool");
    const direct = await send("xai/grok-4.5");
    expect(direct).toContain("undeclared client tool");
    expect(direct).not.toContain("undeclared-tool repair");
  });
});

describe("shadow-call settings API phantom allowlist", () => {
  test("GET reports effective defaults when nothing was stored", async () => {
    await withTempHome(async () => {
      const body = await shadowApi({ port: 0, defaultProvider: "xai", providers: {} } as OcxConfig, "GET");
      expect(body.phantomToolAllowlistEnabled).toBe(true);
      expect(body.phantomToolAllowlist).toEqual([...DEFAULT_PHANTOM_TOOL_ALLOWLIST].sort());
      expect(body.phantomToolDefaults).toEqual([...DEFAULT_PHANTOM_TOOL_ALLOWLIST]);
    });
  });

  test("PUT stores an explicit list (deduped, trimmed) and the kill switch round-trips", async () => {
    await withTempHome(async () => {
      const config = { port: 0, defaultProvider: "xai", providers: {} } as OcxConfig;
      const put = await shadowApi(config, "PUT", {
        phantomToolAllowlist: ["web__run", "web__run", " my_phantom "],
      });
      expect(put.phantomToolAllowlist).toEqual(["my_phantom", "web__run"]);
      expect(config.shadowCallIntercept?.phantomToolAllowlist).toEqual(["web__run", "my_phantom"]);
      const off = await shadowApi(config, "PUT", { phantomToolAllowlistEnabled: false });
      expect(off.phantomToolAllowlistEnabled).toBe(false);
    });
  });

  test("PUT rejects malformed phantom lists", async () => {
    await withTempHome(async () => {
      const config = { port: 0, defaultProvider: "xai", providers: {} } as OcxConfig;
      expect((await shadowApiResponse(config, { phantomToolAllowlist: ["ok", ""] })).status).toBe(400);
      expect((await shadowApiResponse(config, { phantomToolAllowlist: "nope" })).status).toBe(400);
      expect((await shadowApiResponse(config, { phantomToolAllowlistEnabled: "yes" })).status).toBe(400);
    });
  });

  test("phantomToolFeedbackMax defaults to 2 and round-trips with validation", async () => {
    await withTempHome(async () => {
      const config = { port: 0, defaultProvider: "xai", providers: {} } as OcxConfig;
      const get = await shadowApi(config, "GET");
      expect(get.phantomToolFeedbackMax).toBe(2);
      const put = await shadowApi(config, "PUT", { phantomToolFeedbackMax: 0 });
      expect(put.phantomToolFeedbackMax).toBe(0);
      expect(config.shadowCallIntercept?.phantomToolFeedbackMax).toBe(0);
      expect((await shadowApiResponse(config, { phantomToolFeedbackMax: 11 })).status).toBe(400);
      expect((await shadowApiResponse(config, { phantomToolFeedbackMax: 1.5 })).status).toBe(400);
      expect((await shadowApiResponse(config, { phantomToolFeedbackMax: "2" })).status).toBe(400);
    });
  });
});
