import { describe, expect, test } from "bun:test";

import { resolveMaxTokens } from "../../src/adapters/openai-chat/summary-budget";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

/**
 * Codex sends the whole advertised context window as max_output_tokens because the Codex model
 * catalog has no separate max-output field. A model whose real engine window is larger than the
 * advertised one then fails the upstream pre-check (input + max_tokens > engine window) long
 * before the input reaches the advertised window, and auto-compaction never fires because it only
 * watches the input against the advertised window. modelMaxOutputTokens is the operator's
 * declaration of what the engine can actually emit, so it has to cap the caller's value instead of
 * only filling in a missing one.
 */
const provider = {
  baseUrl: "https://upstream.example/v1",
  apiKey: "k",
  modelMaxOutputTokens: { "Q38-Flash-Next": 131072 },
  modelContextWindows: { "Q38-Flash-Next": 350000 },
} as unknown as OcxProviderConfig;

function parsedWith(modelId: string, maxOutputTokens?: number): OcxParsedRequest {
  return {
    modelId,
    options: maxOutputTokens === undefined ? {} : { maxOutputTokens },
  } as unknown as OcxParsedRequest;
}

describe("resolveMaxTokens output ceiling", () => {
  test("caps a caller value that exceeds the engine ceiling", () => {
    // The 2026-10-03 400: Codex advertises 350000 and sends max_output_tokens=350000.
    expect(resolveMaxTokens(provider, parsedWith("Q38-Flash-Next", 350000))).toBe(131072);
  });

  test("keeps a caller value below the ceiling untouched", () => {
    expect(resolveMaxTokens(provider, parsedWith("Q38-Flash-Next", 20000))).toBe(20000);
  });

  test("keeps a caller value exactly at the ceiling", () => {
    expect(resolveMaxTokens(provider, parsedWith("Q38-Flash-Next", 131072))).toBe(131072);
  });

  test("fills in the ceiling when the caller declared no allowance", () => {
    expect(resolveMaxTokens(provider, parsedWith("Q38-Flash-Next"))).toBe(131072);
  });

  test("does not cap a model with no declared ceiling", () => {
    expect(resolveMaxTokens(provider, parsedWith("some-other-model", 350000))).toBe(350000);
  });

  test("falls back to defaultMaxOutputTokens as a ceiling for unlisted models", () => {
    const withDefault = { ...provider, defaultMaxOutputTokens: 64000 } as OcxProviderConfig;
    expect(resolveMaxTokens(withDefault, parsedWith("some-other-model", 350000))).toBe(64000);
  });

  test("honours the tighter of the per-model and default ceilings", () => {
    const both = {
      ...provider,
      modelMaxOutputTokens: { "Q38-Flash-Next": 200000 },
      defaultMaxOutputTokens: 64000,
    } as unknown as OcxProviderConfig;
    // The per-model entry is the more specific declaration, so it wins over the default.
    expect(resolveMaxTokens(both, parsedWith("Q38-Flash-Next", 350000))).toBe(200000);
    expect(resolveMaxTokens(both, parsedWith("Q38-Flash-Next", 100000))).toBe(100000);
    // The default only governs models the per-model map does not list.
    expect(resolveMaxTokens(both, parsedWith("unlisted-model", 350000))).toBe(64000);
  });

  test("leaves the caller's value alone when the provider declares nothing", () => {
    const bare = { baseUrl: "https://upstream.example/v1", apiKey: "k" } as OcxProviderConfig;
    expect(resolveMaxTokens(bare, parsedWith("Q38-Flash-Next", 350000))).toBe(350000);
  });
});
