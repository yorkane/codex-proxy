/**
 * 241.t 现场形态的回归：code-mode 目录只声明 exec（外加 collaboration__* 与 wait），从不声明
 * exec_command / apply_patch / write_stdin 这些 nested helper，而模型把 exec 沙箱里的成员访问抄成
 * wire 名时用了六种脏拼法（双下划线 / 点 / 等号 / 斜杠 / 双冒号 / 冒号）。
 *
 * 过去这些名字在 guard 上整轮 502（客户端表现为 stream disconnected before completion），因为剥
 * 前缀那一步只接受「逐字命中声明」，而 code-mode 目录里没有这些裸名；裸写同名却能归到已声明的
 * exec。同一个已声明通道的错误拼法不该有两种命运。
 *
 * 这里同时锁两件容易单独做错的事：
 *  1. 名字侧要改名（认成 exec），否则整轮死；
 *  2. 正文侧要以原始发射名继续解析出 helper，把结构化 body 编译成 await tools.<helper>(...)，否则
 *     shell / patch 正文会以裸 exec JavaScript 的形式送给客户端，静默丢掉 wrapper 语义。只测名字抓不到。
 */
import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { resolveEmittedCall } from "../../src/responses/emitted-call-guard";
import type { AdapterEvent } from "../../src/types";

const NL = String.fromCharCode(10);
const MARK = "***";
const PATCH_BODY = [MARK + " Begin Patch", MARK + " Add File: a.txt", "+hi", MARK + " End Patch"].join(NL);
const SHELL_ARGS = JSON.stringify({ cmd: "df -h /" });
const PATCH_ARGS = JSON.stringify({ patch: PATCH_BODY });

const CODE_MODE_CATALOG = new Set([
  "exec",
  "collaboration__spawn_agent",
  "collaboration__wait_agent",
  "collaboration__list_agents",
  "collaboration__followup_task",
  "collaboration__send_message",
  "collaboration__interrupt_agent",
  "wait",
]);

const SANDBOX_SPELLINGS = ["tools__", "tools.", "tools=", "tools/", "tools::", "tools:"] as const;
const HELPER_NAMES = ["exec_command", "apply_patch", "write_stdin", "view_image"] as const;

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

async function* turn(name: string, args: string): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call-1", name } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-1", arguments: args } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-1" } as AdapterEvent;
  yield { type: "done" } as AdapterEvent;
}

async function viaSse(emitted: string, args: string): Promise<string> {
  return drain(bridgeToResponsesSSE(turn(emitted, args), "llm-248/x", undefined, new Set(["exec"]),
    // 发射名改写门控：本文件锁的是三方流量（241.t 现网 llm-248 直连）的救回语义，显式开启。
    undefined, undefined, 50_000, { declaredToolNames: CODE_MODE_CATALOG, servingRouteIsThirdParty: true }));
}

async function viaBatch(emitted: string, args: string): Promise<string> {
  const events: AdapterEvent[] = [];
  for await (const e of turn(emitted, args)) events.push(e);
  return JSON.stringify(buildResponseJSON(events, "llm-248/x", {
    declaredToolNames: CODE_MODE_CATALOG,
    servingRouteIsThirdParty: true,
    freeformToolNames: new Set(["exec"]),
    bareCustomToolNames: new Set(["exec"]),
  } as never));
}

describe("code-mode 沙箱前缀 helper 名不再整轮 502（241.t 现场形态）", () => {
  test("六种拼法 x 四个 helper 都被改名器认成已声明的 exec", () => {
    for (const prefix of SANDBOX_SPELLINGS) {
      for (const helper of HELPER_NAMES) {
        const verdict = resolveEmittedCall(prefix + helper, {
          declaredToolNames: CODE_MODE_CATALOG,
          enforceDeclaredToolNames: true,
          freeformToolNames: new Set(["exec"]),
          bareCustomToolNames: new Set(["exec"]),
          servingRouteIsThirdParty: true,
        });
        expect(verdict.kind).toBe("allow");
        if (verdict.kind !== "allow") continue;
        expect(verdict.name).toBe("exec");
        expect(verdict.repaired).toBe(true);
      }
    }
  });

  test("目录里没有 exec 时，同一批拼法照旧 fail closed", () => {
    const noExec = new Set(["web_search", "update_plan"]);
    for (const prefix of SANDBOX_SPELLINGS) {
      const verdict = resolveEmittedCall(prefix + "exec_command", {
        declaredToolNames: noExec,
        enforceDeclaredToolNames: true,
        freeformToolNames: new Set<string>(),
      });
      expect(verdict.kind).toBe("drop");
    }
  });

  test("端到端：shell 正文编译成 nested exec_command，而不是裸 body 交给 exec", async () => {
    for (const prefix of SANDBOX_SPELLINGS) {
      const sse = await viaSse(prefix + "exec_command", SHELL_ARGS);
      expect(sse).not.toContain("undeclared client tool");
      expect(sse).not.toContain("response.failed");
      expect(sse).toContain(String.raw`"name":"exec"`);
      expect(sse).toContain("await tools.exec_command(");
      expect(sse).toContain("df -h /");
      expect(sse).not.toContain(SHELL_ARGS);
    }
  });

  test("端到端：patch 正文编译成 nested apply_patch，不被误当成 shell", async () => {
    for (const prefix of SANDBOX_SPELLINGS) {
      const sse = await viaSse(prefix + "apply_patch", PATCH_ARGS);
      expect(sse).not.toContain("undeclared client tool");
      expect(sse).toContain(String.raw`"name":"exec"`);
      expect(sse).toContain("await tools.apply_patch(");
      expect(sse).not.toContain("await tools.exec_command(");
    }
  });

  test("非流式批次路径与流式同答案", async () => {
    const json = await viaBatch("tools=exec_command", SHELL_ARGS);
    expect(json).not.toContain("undeclared client tool");
    expect(json).toContain(String.raw`"name":"exec"`);
    expect(json).toContain("await tools.exec_command(");
  });

  test("分隔符被折叠的变体也认得（现场 tools__exec__command）", () => {
    const verdict = resolveEmittedCall("tools__exec__command", {
      declaredToolNames: CODE_MODE_CATALOG,
      enforceDeclaredToolNames: true,
      freeformToolNames: new Set(["exec"]),
      bareCustomToolNames: new Set(["exec"]),
      servingRouteIsThirdParty: true,
    });
    expect(verdict.kind).toBe("allow");
    if (verdict.kind === "allow") expect(verdict.name).toBe("exec");
  });

  test("多写的一对下划线也认得（现场 tools=__exec_command）", () => {
    // 它与 tools=exec_command 的唯一区别是分隔符多打了一遍：剥完前缀是 _exec_command。目标仍然
    // 唯一落在闭集 helper 上、仍然要求目录声明 exec，所以救回它的授权强度和主犯完全一致。
    for (const name of ["tools=__exec_command", "tools=tools.exec_command", "tools__tools.apply_patch"]) {
      const verdict = resolveEmittedCall(name, {
        declaredToolNames: CODE_MODE_CATALOG,
        enforceDeclaredToolNames: true,
        freeformToolNames: new Set(["exec"]),
        bareCustomToolNames: new Set(["exec"]),
        servingRouteIsThirdParty: true,
      });
      expect(verdict.kind).toBe("allow");
      if (verdict.kind === "allow") expect(verdict.name).toBe("exec");
    }
  });
});

describe("脏写法保持 fail closed（没有唯一可恢复目标就不救）", () => {
  const LT = String.fromCharCode(60);
  const stuck = [
    "tools",
    "tools=",
    "tools/",
    "tools::",
    "tools:",
    "tools=not_a_tool",
    "tools__not_a_tool",
    "toolz=exec",
    "toolset=exec",
    "tools__exec_4ll9",
    "tools__apply_patch_14",
    "tools__exec_comman",
    "tools=" + NL + LT + "/function",
    "tools=" + NL + LT + "parameter=cmd",
    "tools=" + NL + "{" ,
  ];
  for (const name of stuck) {
    test(JSON.stringify(name) + " 仍然 undeclared", () => {
      const verdict = resolveEmittedCall(name, {
        declaredToolNames: CODE_MODE_CATALOG,
        enforceDeclaredToolNames: true,
        freeformToolNames: new Set(["exec"]),
        bareCustomToolNames: new Set(["exec"]),
      });
      expect(verdict.kind).toBe("drop");
      if (verdict.kind === "drop") expect(verdict.name).toBe(name);
    });
  }
});
