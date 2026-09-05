/**
 * Per-provider `undeclaredToolAllowlist`: a routed model's hallucinated native tool names
 * (e.g. `update_plan` / `collaboration__update_plan` replayed by a Q38-family gateway) are
 * dropped silently instead of failing the whole turn with the #1700 undeclared-tool error.
 * These pin every kill path: the streaming bridge, the batch bridge, the passthrough SSE
 * guard rewrite, the passthrough bounded-JSON path, and the guard's fail-closed twin.
 */
import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import {
  createUndeclaredToolCallGuardBlockRewrite,
  stripDroppableToolCallsInJsonString,
  stripDroppableToolCallsInResponse,
  undeclaredToolCallName,
} from "../src/server/responses-undeclared-tool-guard";
import { relaySseWithBlockRewrite } from "../src/server/sse-payload-rewrite";
import type { AdapterEvent } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

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

async function* phantomTurn(secondName: string): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call-real", name: "web_search" } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-real", arguments: '{"q":"x"}' } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-real" } as AdapterEvent;
  yield { type: "tool_call_start", id: "call-phantom", name: secondName } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-phantom", arguments: '{"steps":[]}' } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-phantom" } as AdapterEvent;
  yield { type: "text_delta", text: "all done" } as AdapterEvent;
  yield { type: "done" } as AdapterEvent;
}

const streaming = (phantom: string, secondName = "update_plan") => drain(
  bridgeToResponsesSSE(
    phantomTurn(secondName), "llm-248/x", undefined, undefined, undefined, undefined, 50_000,
    {
      declaredToolNames: new Set(["web_search"]),
      ...(phantom === "" ? {} : { undeclaredToolPhantomNames: new Set([phantom]) }),
    },
  ),
);

describe("streaming bridge phantom drop", () => {
  test("an allowed phantom call disappears and the turn completes", async () => {
    const sse = await streaming("update_plan");
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).not.toContain("update_plan");
    expect(sse).toContain("web_search");
    expect(sse).toContain("all done");
    expect(sse).toContain("response.completed");
    expect(sse).not.toContain("response.failed");
  });

  test("without an allowlist the same turn still fails closed", async () => {
    const sse = await streaming("");
    expect(sse).toContain("undeclared client tool");
    expect(sse).toContain("update_plan");
  });

  test("a phantom outside the allowlist still fails the turn", async () => {
    const sse = await streaming("update_plan", "spawn_agent");
    expect(sse).toContain("undeclared client tool");
    expect(sse).toContain("spawn_agent");
  });

  test("a flattened namespaced name matches the allowlist on its raw form", async () => {
    const sse = await streaming("collaboration__update_plan", "collaboration__update_plan");
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain("response.completed");
  });
});

describe("batch bridge phantom drop", () => {
  test("the phantom call never enters the output and the turn completes", async () => {
    const events: AdapterEvent[] = [];
    for await (const event of phantomTurn("update_plan")) events.push(event);
    const built = buildResponseJSON(events, "llm-248/x", {
      declaredToolNames: new Set(["web_search"]),
      undeclaredToolPhantomNames: new Set(["update_plan"]),
    });
    expect(built.status).toBe("completed");
    const output = built.output as Array<{ type: string; name?: string }>;
    const names = output.filter(item => item.type === "function_call").map(item => item.name);
    expect(names).toEqual(["web_search"]);
  });

  test("without an allowlist the batch path still refuses the phantom", async () => {
    const events: AdapterEvent[] = [];
    for await (const event of phantomTurn("update_plan")) events.push(event);
    const built = buildResponseJSON(events, "llm-248/x", {
      declaredToolNames: new Set(["web_search"]),
    });
    expect(JSON.stringify(built)).toContain("undeclared client tool");
  });
});

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) { controller.close(); return; }
      sent = true;
      controller.enqueue(chunk);
    },
  });
}

async function relay(upstream: string, phantom: string | undefined): Promise<string> {
  const budget = createTestTranslatorBudget();
  try {
    return await drain(relaySseWithBlockRewrite(
      streamFromText(upstream),
      createUndeclaredToolCallGuardBlockRewrite(
        new Set(["web_search"]),
        undefined,
        undefined,
        phantom ? new Set([phantom]) : undefined,
      ),
      budget,
    ));
  } finally {
    budget.dispose();
  }
}

const phantomItem = { type: "function_call", id: "fc_p", call_id: "c2", name: "update_plan", arguments: "{\"a\":1}" };
const realItem = { type: "function_call", id: "fc_r", call_id: "c1", name: "web_search", arguments: "{\"q\":\"x\"}" };

const phantomStream = [
  frame("response.output_item.added", { output_index: 0, item: realItem }),
  frame("response.output_item.done", { output_index: 0, item: realItem }),
  frame("response.output_item.added", { output_index: 1, item: phantomItem }),
  frame("response.function_call_arguments.delta", { item_id: "fc_p", delta: "{\"a\":1}" }),
  frame("response.output_item.done", { output_index: 1, item: phantomItem }),
  frame("response.completed", { response: { id: "r1", status: "completed", output: [realItem, phantomItem] } }),
  "data: [DONE]\n\n",
].join("");

describe("passthrough guard phantom drop", () => {
  test("phantom announce/delta/done blocks are dropped and the completed snapshot is stripped", async () => {
    const out = await relay(phantomStream, "update_plan");
    expect(out).not.toContain("undeclared");
    expect(out).toContain("fc_r");
    expect(out).not.toContain("fc_p");
    expect(out).toContain("response.completed");
    expect(out).toContain("[DONE]");
    // The stripped terminal must not smuggle the phantom back in.
    const completedPayload = out.match(/event: response\.completed\ndata: (.*)\n/);
    expect(completedPayload?.[1]).toBeDefined();
    const snapshot = JSON.parse(completedPayload![1]!) as { response: { output: Array<{ id?: string }> } };
    expect(snapshot.response.output.map(item => item.id)).toEqual(["fc_r"]);
  });

  test("without an allowlist the guard fails closed as before", async () => {
    const out = await relay(phantomStream, undefined);
    expect(out).toContain("undeclared client tool");
    expect(out).toContain("update_plan");
    expect(out).toContain("response.failed");
  });

  test("an undeclared NON-allowed phantom in the terminal snapshot still fails closed", async () => {
    const out = await relay(phantomStream, "other_thing");
    expect(out).toContain("undeclared client tool");
    expect(out).toContain("update_plan");
  });
});

describe("guard terminal-name verdicts", () => {
  test("undeclaredToolCallName stands down on a droppable name with the allowlist", () => {
    const payload = { type: "response.output_item.added", item: phantomItem };
    expect(undeclaredToolCallName(payload, new Set(["web_search"]))).toBe("update_plan");
    expect(undeclaredToolCallName(payload, new Set(["web_search"]), undefined, undefined, new Set(["update_plan"]))).toBeUndefined();
  });
});

describe("bounded-JSON phantom strip", () => {
  const body = JSON.stringify({ id: "r1", status: "completed", output: [realItem, phantomItem] });

  test("strips the phantom item from the JSON string", () => {
    const stripped = stripDroppableToolCallsInJsonString(
      body, new Set(["web_search"]), new Set(["update_plan"]),
    );
    const parsed = JSON.parse(stripped) as { output: Array<{ id?: string }> };
    expect(parsed.output.map(item => item.id)).toEqual(["fc_r"]);
  });

  test("returns the input byte-identical without an allowlist", () => {
    expect(stripDroppableToolCallsInJsonString(body, new Set(["web_search"]), new Set([])))
      .toBe(body);
  });

  test("a declared name is never stripped even when the allowlist repeats it", () => {
    const declaredBody = JSON.stringify({ output: [{ type: "function_call", id: "fc_d", name: "update_plan", arguments: "{}" }] });
    expect(stripDroppableToolCallsInResponse(
      JSON.parse(declaredBody), new Set(["update_plan"]), new Set(["update_plan"]),
    ).removed).toEqual([]);
  });

  test("malformed JSON passes through untouched", () => {
    expect(stripDroppableToolCallsInJsonString("{oops", new Set(["web_search"]), new Set(["update_plan"])))
      .toBe("{oops");
  });
});
