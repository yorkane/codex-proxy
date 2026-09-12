/**
 * Shadow call intercept source-model matching (issue #311): Codex 0.145.0 moved
 * its hard-coded helper model from gpt-5.4-mini to gpt-5.6-luna. The current
 * default follows modern clients, while sourceModels keeps an escape hatch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, isShadowSourceModel } from "../../src/server/responses";
import { DEFAULT_PHANTOM_TOOL_ALLOWLIST, shadowCallReplacementFor, shadowPhantomToolNames, shadowSourceModelPrefix, shouldInterceptShadowCall } from "../../src/lib/shadow-call";
import { handleManagementAPI } from "../../src/server/management-api";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("isShadowSourceModel", () => {
  test("matches default shadow source models by prefix", () => {
    expect(isShadowSourceModel("gpt-5.6-luna")).toBe(true);
    expect(isShadowSourceModel("gpt-5.6-luna-2026-08")).toBe(true);
  });

  test("matches the legacy helper as a default and supports an explicit override", () => {
    // gpt-5.4-mini is now a default source model (Plan B expanded defaults).
    expect(isShadowSourceModel("gpt-5.4-mini")).toBe(true);
    expect(isShadowSourceModel("gpt-5.4-mini", ["gpt-5.4-mini"])).toBe(true);
  });

 test("does not match non-helper models", () => {
    // luna/sol/terra/5.5/5.4-mini are all default shadow source models now.
    expect(isShadowSourceModel("gpt-5.6-terra")).toBe(true);
    expect(isShadowSourceModel("gpt-5.5")).toBe(true);
    expect(isShadowSourceModel("gpt-5.6-sol")).toBe(true);
    // a non-listed native id still does not match.
    expect(isShadowSourceModel("gpt-5.4")).toBe(false);
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
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
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

  // The intercept matches by PREFIX, so a caller can append anything and still be intercepted.
  // The recorded marker is persisted to usage.jsonl and served from /api/logs, and the runtime
  // redactor is pattern-based: a credential family it does not recognize would survive verbatim.
  // Recording the operator-configured prefix instead of the caller's raw string removes the
  // class, rather than adding one more pattern to a deny-list.
  test("the recorded marker is the configured prefix, never the caller's raw model string", async () => {
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
  test("a helper call rewritten to a combo hops past a 429 to the second target", async () => {
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

  test("a combo whose first target intersects the source still routes as a combo", async () => {
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
 test("GET reports the 0.145.0+ helper-model default", async () => {
   await withTempHome(async () => {
     const body = await shadowApi({ port: 0, defaultProvider: "xai", providers: {} } as OcxConfig, "GET");
      expect(body.sourceModels).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4-mini"]);
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

  // Wiring tests for the per-request directive-correction budget allocated in
  // core.ts (shadowCallIntercept.phantomToolFeedbackMax): rejected calls on
  // shadow requests with a declared exec channel must reach the model as an
  // exec directive instead of the silent drop or the fail-closed error.
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

  test("a NON-shadow request with exec declared still fails closed (no budget)", async () => {
    phantomFetch();
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: execDeclaringBody("xai/grok-4.5"),
    }), interceptConfig(), { model: "", provider: "" });
    const payload = JSON.stringify(await response.json());
    expect(payload).toContain("undeclared client tool");
    expect(payload).not.toContain("undeclared-tool repair");
  });

  test("the kill switch removes the directive path too (pure fail-closed)", async () => {
    phantomFetch();
    const config = interceptConfig();
    config.shadowCallIntercept = { ...config.shadowCallIntercept, phantomToolAllowlistEnabled: false };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: execDeclaringBody("gpt-5.6-luna"),
    }), config, { model: "", provider: "" });
    const payload = JSON.stringify(await response.json());
    expect(payload).toContain("undeclared client tool");
    expect(payload).not.toContain("undeclared-tool repair");
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
