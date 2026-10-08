/**
 * 原生 passthrough guard 与桥接侧单一决策点的对称性（C1/C2/C3）。
 *
 * 桥接路径(src/responses/emitted-call-guard.ts resolveEmittedCall)对同一个畸形名做
 * normalize + repair，而本 guard 过去只 normalize：同一个 exec 沙箱前缀拼法或
 * collaboration / functions 前缀形状，在桥接被改名放行、在 passthrough 按 #1700 fail closed
 * 回一个 response.failed。这组用例锁住两条路径现在读同一个解析器，并锁住 fail-closed 边界
 * （repair 失手、候选不唯一、命名空间裸别名）没有被顺手放宽。
 */
import { describe, expect, test } from "bun:test";
import {
  collectDeclaredBareCustomWireToolNames,
  collectDeclaredBareWireToolNames,
  collectDeclaredWireToolNames,
  createUndeclaredToolCallGuardBlockRewrite,
  normalizeDefaultNamespaceInItem,
  normalizeDefaultNamespaceInJson,
  normalizeDefaultNamespaceInPayload,
  stripDroppableToolCallsInResponse,
  undeclaredToolCallNameInResponse,
  undeclaredToolCallVerdict,
} from "../../src/server/responses-undeclared-tool-guard";
import { relaySseWithBlockRewrite } from "../../src/server/sse-payload-rewrite";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { readAll, streamFromText } from "../helpers/sse-stream";

// ---------------------------------------------------------------------------
// 与桥接侧单一决策点(src/responses/emitted-call-guard.ts resolveEmittedCall)的对称性。
//
// 两条路径过去读两套解析器：桥接是 normalize + repair，passthrough guard 只 normalize。
// 同一个畸形拼法因此在桥接被改名放行、在 passthrough 按 #1700 fail closed 回一个
// response.failed。C1 让授权读同一条链，C2 让发射也读同一条链——够格被放行的名字，
// 客户端就必须以那个被授权的声明名收到它。
// ---------------------------------------------------------------------------

/** code-mode 目录：一个 custom exec 加两个普通函数工具。 */
const CODE_MODE_BODY = {
  tools: [
    { type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } },
    { type: "function", name: "web_search", parameters: { type: "object" } },
    { type: "function", name: "update_plan", parameters: { type: "object" } },
  ],
};

/** 客户端日志普查里那套扁平目录（对齐 emitted-call-shape-repair.test.ts 的 sandboxDeclared）。 */
const FLAT_HELPER_BODY = {
  tools: [
    { type: "function", name: "exec", parameters: { type: "object" } },
    { type: "function", name: "exec_command", parameters: { type: "object" } },
    { type: "function", name: "apply_patch", parameters: { type: "object" } },
    { type: "function", name: "view_image", parameters: { type: "object" } },
    { type: "function", name: "write_stdin", parameters: { type: "object" } },
    { type: "namespace", name: "web", tools: [{ type: "function", name: "run", parameters: { type: "object" } }] },
    { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }] },
  ],
};

function catalogViews(body: unknown): { declared: Set<string>; bare: Set<string>; custom: Set<string> } {
  return {
    declared: collectDeclaredWireToolNames(body),
    bare: collectDeclaredBareWireToolNames(body),
    custom: collectDeclaredBareCustomWireToolNames(body),
  };
}

/** 测试内联辅助：只走本文件真正导出的入口，不为测试放宽可见性。 */
function verdictForTest(
  payload: Record<string, unknown>,
  views: { declared: Set<string>; bare: Set<string>; custom: Set<string> },
): { name: string; droppable: boolean } | undefined {
  return undeclaredToolCallVerdict(payload, views.declared, new Set(), new Set(), views.bare, views.custom);
}
function undeclaredNameForTest(
  item: Record<string, unknown>,
  views: { declared: Set<string>; bare: Set<string>; custom: Set<string> },
): string | undefined {
  return undeclaredToolCallNameInResponse({ output: [item] }, views.declared, new Set(), new Set(), views.bare, views.custom);
}

/** guard 的三个入口：逐条 item、参数完成事件、终态快照。 */
function callPayloads(name: string, namespace?: string): Array<Record<string, unknown>> {
  const item: Record<string, unknown> = { type: "function_call", id: "itm-1", call_id: "call-1", name, arguments: "{}" };
  if (namespace !== undefined) item.namespace = namespace;
  return [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.function_call_arguments.done", item_id: "itm-1", output_index: 0, name, arguments: "{}" },
    { type: "response.completed", response: { id: "resp-1", status: "completed", output: [item] } },
  ];
}

/** 把三个入口喂给真实 guard rewrite，返回客户端将收到的名字集合。 */
async function relayCall(
  name: string,
  views: { declared: Set<string>; bare: Set<string>; custom: Set<string> },
  phantom?: Set<string>,
): Promise<{ out: string; names: string[] }> {
  const frames = callPayloads(name).map(payload => "data: " + JSON.stringify(payload) + "\n\n").join("");
  const budget = createTestTranslatorBudget();
  try {
    const out = await readAll(relaySseWithBlockRewrite(
      streamFromText(frames),
      createUndeclaredToolCallGuardBlockRewrite(views.declared, new Set(), new Set(), views.bare, views.custom, phantom),
      budget,
    ));
    return { out, names: [...out.matchAll(/"name":"([^"]+)"/g)].map(m => m[1]) };
  } finally {
    budget.dispose();
  }
}

const SANDBOX_EXEC_SPELLINGS = ["tools.exec", "tools__exec", "tools=exec", "tools/exec", "functions__exec", "functions.exec"];

describe("passthrough guard 与桥接读同一个解析器：exec 沙箱前缀形状", () => {
  for (const emitted of SANDBOX_EXEC_SPELLINGS) {
    test(emitted + " 在三个入口都按声明名 exec 放行（code-mode 目录）", async () => {
      const views = catalogViews(CODE_MODE_BODY);
      for (const payload of callPayloads(emitted)) {
        expect(verdictForTest(payload, views)).toBeUndefined();
      }
      const { out, names } = await relayCall(emitted, views);
      expect(out).not.toContain("response.failed");
      expect(out).not.toContain("undeclared client tool");
      // 客户端收到的必须是 exec 而不是畸形拼法：中继出去会永久污染会话历史（#5095）。
      expect(names).toContain("exec");
      expect(out).not.toContain(JSON.stringify(emitted));
    });
  }

  test("同一批拼法在未声明 exec 的目录下仍然 undeclared", async () => {
    const views = catalogViews({ tools: [{ type: "function", name: "web_search", parameters: { type: "object" } }] });
    for (const emitted of SANDBOX_EXEC_SPELLINGS) {
      expect(verdictForTest(callPayloads(emitted)[0], views)?.name).toBe(emitted);
      const { out } = await relayCall(emitted, views);
      expect(out).toContain("response.failed");
      expect(out).toContain("undeclared client tool");
    }
  });

  test("helper 名的沙箱拼法按其声明名放行（扁平目录）", async () => {
    const views = catalogViews(FLAT_HELPER_BODY);
    const cases: Array<[string, string]> = [
      ["tools.exec_command", "exec_command"],
      ["tools=apply_patch", "apply_patch"],
      ["tools__apply_patch", "apply_patch"],
      ["tools/view_image", "view_image"],
      ["tools.write_stdin", "write_stdin"],
      ["tools=web_run", "web__run"],
      // 点号与裸拼法都是收集侧为命名空间工具登记的合法别名（#3402 / addWireToolName），
      // 声明集里本来就有这个名字，所以原样保留，不走改名。
      ["collaboration.spawn_agent", "collaboration.spawn_agent"],
      // 裸 spawn_agent 由收集侧登记为命名空间工具的合法 bare 别名（它不在
      // NAMESPACED_BARE_ALIAS_EXCLUDED_NAMES 名单里），声明集里已有，原样保留。
      ["spawn_agent", "spawn_agent"],
      ["functions__exec", "exec"],
    ];
    for (const [emitted, authorized] of cases) {
      for (const payload of callPayloads(emitted)) {
        expect(verdictForTest(payload, views)).toBeUndefined();
      }
      const { out, names } = await relayCall(emitted, views);
      expect(out).not.toContain("response.failed");
      expect(names).toContain(authorized);
      // 需要改名时，畸形拼法绝不出现在客户端收到的流里；authorized === emitted 的
      // 用例（合法别名原样保留）本来就带这个名字，跳过这条断言。
      if (authorized !== emitted) expect(out).not.toContain(JSON.stringify(emitted));
    }
  });

  test("code-mode 目录下 helper 的沙箱拼法仍按未声明拒绝，与桥接同答案", () => {
    // normalize 在 repair 之前跑，看不见前缀后面的 helper 词表；桥接侧 resolveEmittedCall
    // 对这些名字同样 drop。锁的是两条路径一致，而不是把它们放宽。
    const views = catalogViews(CODE_MODE_BODY);
    for (const name of ["tools.apply_patch", "tools.exec_command", "tools.view_image", "tools.write_stdin", "tools.create_goal"]) {
      expect(verdictForTest(callPayloads(name)[0], views)?.name).toBe(name);
    }
  });
});

describe("发射名与授权名一致（C2）", () => {
  test("非 schema-valid 的畸形拼法绝不中继给客户端", () => {
    const views = catalogViews(CODE_MODE_BODY);
    for (const emitted of ["tools.exec", "tools=exec", "tools/exec"]) {
      const { value, changed } = normalizeDefaultNamespaceInItem(
        { type: "function_call", id: "itm", name: emitted },
        views.declared,
        views.bare,
      );
      expect(changed).toBe(true);
      const name = (value as { name: string }).name;
      expect(name).toBe("exec");
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("合法声明的名字保持原样，即使 repair 对别的拼法有意见", () => {
    const views = catalogViews(FLAT_HELPER_BODY);
    for (const emitted of ["exec", "apply_patch", "web__run", "collaboration__spawn_agent"]) {
      const { changed } = normalizeDefaultNamespaceInItem(
        { type: "function_call", id: "itm", name: emitted },
        views.declared,
        views.bare,
      );
      expect(changed).toBe(false);
    }
  });

  test("参数完成事件、终态快照与非流式 JSON 拿到同一个改写名", () => {
    const views = catalogViews(CODE_MODE_BODY);
    const args = normalizeDefaultNamespaceInPayload(
      { type: "response.function_call_arguments.done", item_id: "itm-1", name: "tools.exec", arguments: "{}" },
      views.declared,
      views.bare,
    );
    expect(args.changed).toBe(true);
    expect((args.value as { name: string }).name).toBe("exec");
    const done = normalizeDefaultNamespaceInPayload(
      { type: "response.completed", response: { id: "r", status: "completed", output: [{ type: "function_call", id: "itm-1", name: "tools.exec" }] } },
      views.declared,
      views.bare,
    );
    expect(done.changed).toBe(true);
    expect(((done.value as { response: { output: Array<{ name: string }> } }).response.output[0]).name).toBe("exec");
    // bounded-JSON passthrough 走 normalizeDefaultNamespaceInJson，同一口径。
    const json = normalizeDefaultNamespaceInJson(
      JSON.stringify({ id: "r", status: "completed", output: [{ type: "function_call", id: "itm-1", name: "tools=exec" }] }),
      views.declared,
      views.bare,
    );
    expect((JSON.parse(json) as { output: Array<{ name: string }> }).output[0].name).toBe("exec");
  });
});

describe("fail-closed 性质未被放宽（C3）", () => {
  const codeViews = catalogViews(CODE_MODE_BODY);
  const flatViews = catalogViews(FLAT_HELPER_BODY);

  test("前缀后剩余为空 / 未知剩余 / 相似前缀 / 随机后缀 / 截断名仍然 undeclared", () => {
    for (const name of ["tools.", "tools=", "tools__", "tools/", "tools.pwd", "tools__totally_made_up",
      "toolsx_exec", "tools.exec_command_x", "tools.exec_comman"]) {
      expect(undeclaredNameForTest({ type: "function_call", name }, codeViews)).toBe(name);
    }
    // 裸容器名 tools 不是任何已声明工具。
    expect(undeclaredNameForTest({ type: "function_call", name: "tools" }, flatViews)).toBe("tools");
    // tool__exec 不是相似前缀，而是 repair 的 ns__name 降级规则：exec 已被声明，
    // 两侧都认作 exec（对齐 resolveEmittedCall 的 allow/exec）。
    expect(undeclaredNameForTest({ type: "function_call", name: "tool__exec" }, codeViews)).toBeUndefined();
  });

  test("候选数不为 1 时绝不猜第二个名字", () => {
    const ambiguous = { declared: new Set(["a__run", "b__run"]), bare: new Set<string>(), custom: new Set<string>() };
    expect(undeclaredNameForTest({ type: "function_call", name: "run" }, ambiguous)).toBe("run");
    // 只在命名空间里声明过的工具拿不到裸别名（收集侧那条既有意图的锁）。
    const namespacedOnly = catalogViews({ tools: [{ type: "namespace", name: "mcp", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] }] });
    for (const name of ["exec", "exec_command", "apply_patch", "write_stdin", "view_image"]) {
      expect(undeclaredNameForTest({ type: "function_call", name }, namespacedOnly)).toBe(name);
    }
  });

  test("带 namespace 的 exec_command 仍按整名拒绝（锁住既有意图，不回归）", () => {
    const declared = collectDeclaredWireToolNames(FLAT_HELPER_BODY);
    const bare = collectDeclaredBareWireToolNames(FLAT_HELPER_BODY);
    expect(undeclaredToolCallNameInResponse(
      { output: [{ type: "function_call", name: "exec_command", namespace: "mcp", call_id: "call_1" }] },
      declared,
    )).toBe("exec_command");
    expect(undeclaredToolCallNameInResponse(
      { output: [{ type: "function_call", name: "apply_patch", namespace: "collaboration", call_id: "call_1" }] },
      declared,
    )).toBe("apply_patch");
    // default. 命名空间特例照旧放行（#4176）。
    expect(undeclaredToolCallNameInResponse(
      { output: [{ type: "function_call", name: "exec_command", namespace: "default", call_id: "call_1" }] },
      declared,
      new Set(),
      new Set(),
      bare,
    )).toBeUndefined();
  });

  test("#1700 仍在：随机名字既不放行也不改写", () => {
    const name = "suddenly_a_shell_tool";
    expect(undeclaredNameForTest({ type: "function_call", name }, codeViews)).toBe(name);
    const { changed } = normalizeDefaultNamespaceInItem({ type: "function_call", id: "i", name }, codeViews.declared, codeViews.bare);
    expect(changed).toBe(false);
  });
});

describe("phantom 允许列表行为不变", () => {
  test("repair 修不动的名字照旧按允许列表静默丢弃", async () => {
    const views = { declared: new Set(["web_search"]), bare: new Set(["web_search"]), custom: new Set<string>() };
    const { out } = await relayCall("collaboration__update_plan", views, new Set(["collaboration__update_plan"]));
    expect(out).not.toContain("undeclared client tool");
    expect(out).not.toContain("collaboration__update_plan");
    expect(out).toContain("response.completed");
  });

  test("被 repair 认成已声明工具的名字不会被允许列表剥掉", () => {
    // 与桥接一致：改名结果已声明时条目保留，允许列表只处理未声明的名字。
    const views = catalogViews(FLAT_HELPER_BODY);
    const response = { id: "r", status: "completed", output: [{ type: "function_call", id: "i", name: "tools.apply_patch" }] };
    const stripped = stripDroppableToolCallsInResponse(response, views.declared, new Set(["tools.apply_patch"]), views.bare);
    expect(stripped.removed).toEqual([]);
    // 真·phantom 照旧剥掉，说明上面的保留来自「授权名已声明」而不是疏漏。
    const ghost = { id: "r", status: "completed", output: [{ type: "function_call", id: "i", name: "made_up_ghost" }] };
    const dropped = stripDroppableToolCallsInResponse(ghost, views.declared, new Set(["made_up_ghost"]), views.bare);
    expect(dropped.removed).toEqual(["made_up_ghost"]);
  });
});
