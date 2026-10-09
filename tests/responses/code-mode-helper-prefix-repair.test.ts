/**
 * Tool-name prefix normalization must not steal code-mode helper ownership.
 *
 * Call-shape repair rewrites tools=exec (and the __ / . / variants) to the declared name
 * exec, while the bridge keeps the ORIGINAL emitted string as the helper hint. Handed to
 * the helper compiler raw, that string names nothing the compiler knows: the call falls
 * through to the exec_command fallback and the wrapper semantics are lost. A patch body
 * reaches exec_command as {"input":"*** Begin Patch..."} instead of tools.apply_patch.
 * These cases pin that every sandbox prefix behaves exactly like bare exec.
 */
import { describe, expect, test } from "bun:test";
import { buildResponseJSON, bridgeToResponsesSSE } from "../../src/bridge";
import {
  compileCodeModeHelperInput,
  normalizeCodeModeHelperName,
  resolveCodeModeHelperName,
} from "../../src/responses/code-mode-helper-compat";
import type { AdapterEvent } from "../../src/types";

const STAR = "***";
const PATCH_BODY = [STAR + " Begin Patch", STAR + " Add File: a.txt", "+hi", STAR + " End Patch"].join("\n");
// Not valid JavaScript, so the shell recognizer cannot mistake it for a program.
const COMMAND = 'cd "/tmp/example repo" && git status --short';

function shellExpected(args: Record<string, unknown>): string {
  return "const result = await tools.exec_command(" + JSON.stringify(args) + ");\ntext(result);";
}
const PATCH_EXPECTED = "const result = await tools.apply_patch(" + JSON.stringify(PATCH_BODY) + ");\ntext(result);";

async function* turn(name: string, args: string): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call-1", name } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-1", arguments: args } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-1" } as AdapterEvent;
  yield { type: "done" } as AdapterEvent;
}

// Streaming takes the freeform vocabulary positionally; batch takes it in options.
async function viaSse(emitted: string, args: string, code: Set<string>) {
  const stream = bridgeToResponsesSSE(turn(emitted, args), "llm-248/x", undefined, code,
    // 发射名改写门控：本文件锁的是三方流量（llm-248 直连）的救回语义，显式开启。
    undefined, undefined, 50_000, { declaredToolNames: code, servingRouteIsThirdParty: true });
  const raw = await new Response(stream).text();
  const items: Array<Record<string, unknown>> = [];
  for (const block of raw.split("\n\n")) {
    if (!block.includes("response.output_item.done")) continue;
    const idx = block.indexOf("data: ");
    if (idx < 0) continue;
    const parsed = JSON.parse(block.slice(idx + 6)) as { item?: Record<string, unknown> };
    if (parsed.item) items.push(parsed.item);
  }
  return { items, raw };
}

async function viaBatch(emitted: string, args: string, code: Set<string>) {
  const events: AdapterEvent[] = [];
  for await (const e of turn(emitted, args)) events.push(e);
  return buildResponseJSON(events, "llm-248/x",
    { declaredToolNames: code, freeformToolNames: code, servingRouteIsThirdParty: true });
}

const CODE_MODE = new Set(["exec"]);
const EXEC_SPELLINGS = ["exec", "tools=exec", "tools__exec", "tools.exec", "tools/exec", "functions__exec"];
const BODIES: Array<[string, string, string]> = [
  ["cmd object", JSON.stringify({ cmd: COMMAND }), shellExpected({ cmd: COMMAND })],
  ["command alias", JSON.stringify({ command: COMMAND }), shellExpected({ cmd: COMMAND })],
  ["input wrapper", JSON.stringify({ input: JSON.stringify({ cmd: COMMAND }) }), shellExpected({ cmd: COMMAND })],
  ["extra options", JSON.stringify({ cmd: COMMAND, workdir: "/tmp" }),
    shellExpected({ cmd: COMMAND, workdir: "/tmp" })],
];

describe("sandbox-prefixed exec keeps helper ownership from the body", () => {
  for (const emitted of EXEC_SPELLINGS) {
    test(emitted + " compiles shell bodies to the nested exec_command", async () => {
      for (const [label, args, expected] of BODIES) {
        const batch = await viaBatch(emitted, args, CODE_MODE);
        expect([label, batch.output[0]]).toMatchObject([label,
          { type: "custom_tool_call", name: "exec", input: expected }]);
        const sse = await viaSse(emitted, args, CODE_MODE);
        expect([label, sse.items[0]]).toMatchObject([label,
          { type: "custom_tool_call", name: "exec", input: expected }]);
      }
    });
  }

  for (const emitted of EXEC_SPELLINGS) {
    test(emitted + " compiles a patch wrapper to tools.apply_patch", async () => {
      const args = JSON.stringify({ input: PATCH_BODY });
      const batch = await viaBatch(emitted, args, CODE_MODE);
      expect(batch.output[0]).toMatchObject({ type: "custom_tool_call", name: "exec", input: PATCH_EXPECTED });
      const sse = await viaSse(emitted, args, CODE_MODE);
      expect(sse.items[0]).toMatchObject({ type: "custom_tool_call", name: "exec", input: PATCH_EXPECTED });
    });
  }
});

describe("helper recognition vocabulary", () => {
  test("a provider echoing a helper under a prefix still compiles that helper", () => {
    expect(normalizeCodeModeHelperName("tools=write_stdin")).toBe("write_stdin");
    expect(normalizeCodeModeHelperName("tools.view_image")).toBe("view_image");
    expect(normalizeCodeModeHelperName("functions__get_goal")).toBe("get_goal");
    expect(normalizeCodeModeHelperName("tools/mcp__codex__handoff")).toBe("mcp__codex__handoff");
    expect(normalizeCodeModeHelperName("apply_patch")).toBe("apply_patch");
  });

  test("unknown names decline instead of becoming a manufactured nested call", () => {
    for (const name of ["tools=exec", "tools.exec", "tools/exec", "tools__exec", "functions__exec",
      "tools", "made_up_tool", "tools=pwd", "tools=", "tools=__NA__"]) {
      expect(normalizeCodeModeHelperName(name)).toBeUndefined();
    }
    expect(normalizeCodeModeHelperName(undefined)).toBeUndefined();
    expect(normalizeCodeModeHelperName("")).toBeUndefined();
  });

  test("a declined helper never reaches the compiler as a nested tool name", () => {
    // Regression guard for the exact defect: the unrecognized recorded name used to be
    // forwarded, and the compiler final fallback turned it into an exec_command call with
    // the wrapper still attached.
    for (const emitted of EXEC_SPELLINGS) {
      const body = JSON.stringify({ input: PATCH_BODY });
      const helper = resolveCodeModeHelperName(emitted, "exec", body, undefined, CODE_MODE);
      expect([emitted, helper]).toEqual([emitted, "apply_patch"]);
      expect([emitted, compileCodeModeHelperInput(body, helper, normalizeCodeModeHelperName(emitted) ?? "exec")])
        .toEqual([emitted, PATCH_EXPECTED]);
    }
  });

  test("resolveCodeModeHelperName falls through to body inference for a prefixed exec", () => {
    expect(resolveCodeModeHelperName("tools=exec", "exec", JSON.stringify({ cmd: COMMAND }), undefined, CODE_MODE))
      .toBe("exec_command");
    expect(resolveCodeModeHelperName("tools=exec", "exec", "text(1)", undefined, CODE_MODE))
      .toBeUndefined();
    expect(resolveCodeModeHelperName("apply_patch", "exec", PATCH_BODY, undefined, CODE_MODE))
      .toBe("apply_patch");
  });
});

describe("unaffected paths stay byte-identical", () => {
  test("plain JavaScript under any exec spelling is forwarded untouched", async () => {
    const body = "const r = await tools.exec_command({ cmd: 'pwd' });\ntext(r);";
    for (const emitted of EXEC_SPELLINGS) {
      const batch = await viaBatch(emitted, body, CODE_MODE);
      expect([emitted, (batch.output[0] as { input: string }).input]).toEqual([emitted, body]);
      const sse = await viaSse(emitted, body, CODE_MODE);
      expect([emitted, (sse.items[0] as { input: string }).input]).toEqual([emitted, body]);
    }
  });

  test("a flat bridge catalog that genuinely declares exec_command is never code mode", async () => {
    const flat = new Set(["exec", "exec_command"]);
    const args = JSON.stringify({ cmd: COMMAND });
    for (const emitted of ["exec", "tools=exec"]) {
      const batch = await viaBatch(emitted, args, flat);
      expect((batch.output[0] as { input: string }).input).not.toContain("await tools.exec_command(");
    }
  });

  test("non-exec tools keep their arguments verbatim", async () => {
    const declared = new Set(["web_search", "exec"]);
    const freeform = new Set(["exec"]);
    const args = JSON.stringify({ query: "x" });
    const events: AdapterEvent[] = [];
    for await (const e of turn("web_search", args)) events.push(e);
    const batch = buildResponseJSON(events, "llm-248/x",
      { declaredToolNames: declared, freeformToolNames: freeform, servingRouteIsThirdParty: true });
    expect(batch.output[0]).toMatchObject({ type: "function_call", name: "web_search", arguments: args });
    const stream = bridgeToResponsesSSE(turn("tools=web_search", args), "llm-248/x", undefined,
      freeform, undefined, undefined, 50_000, { declaredToolNames: declared, servingRouteIsThirdParty: true });
    const raw = await new Response(stream).text();
    expect(raw).not.toContain("undeclared client tool");
    expect(raw).toContain('"name":"web_search"');
  });
});
