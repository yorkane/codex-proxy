export interface OcxTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  /**
   * Anthropic `tools[*].allowed_callers`: which callers may invoke this tool. Carried rather
   * than diagnosed, because rebuilding the declaration without it hands the model a tool the
   * caller had restricted and returns a normal response (#5210).
   */
  allowedCallers?: string[];
  /** MCP namespace (e.g. "mcp__context7") for tools flattened out of a Responses "namespace" tool. */
  namespace?: string;
  /** Freeform/custom tool (e.g. apply_patch): the model's call must be relayed as a custom_tool_call. */
  freeform?: boolean;
  /** Client-executed tool discovery (tool_search): the model's call must be relayed as a tool_search_call. */
  toolSearch?: boolean;
  /** Tool definition restored from a prior tool_search output; transports may prioritize it when catalogs are bounded. */
  loadedFromToolSearch?: boolean;
  /** Cursor-only synthetic exact-match edit tool; never inferred from the wire name. */
  cursorStructuredEdit?: true;
  /** Synthetic web_search tool: the model's call is executed by the gpt-5.6-luna sidecar, not relayed to Codex. */
  webSearch?: boolean;
  /** Synthetic image_gen tool: the model's call is executed by the xAI image bridge sidecar, not relayed to Codex. */
  imageGeneration?: boolean;
  /** Synthetic video_gen tool: executed by the xAI video bridge sidecar. */
  videoGeneration?: boolean;
}

/**
 * Wire name a chat model sees for a tool. Namespaced (MCP) tools are flattened to
 * "<namespace>__<name>" so they survive the chat-completions function-tool format;
 * the proxy maps this back to {namespace, name} on the return trip (Codex routes MCP
 * calls by an explicit `namespace` field, not by parsing the name).
 */
export function namespacedToolName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

/**
 * Whether a declaration actually narrows who may call the tool.
 *
 * `["direct"]` is the state every unrestricted tool is already in, so treating it as a
 * restriction would refuse ordinary traffic. Mirrors the `caller_mode` predicate in
 * src/claude/compatibility.ts, which draws the same line.
 */
export function toolRestrictsCallers(tool: Pick<OcxTool, "allowedCallers">): boolean {
  const callers = tool.allowedCallers;
  if (callers === undefined) return false;
  return !(callers.length === 1 && callers[0] === "direct");
}

/**
 * Dotted alias of a namespaced tool's wire name. Some routed providers (observed: muse-spark
 * via opencode-go) echo a namespaced tool call as "<namespace>.<name>" instead of the flattened
 * "<namespace>__<name>" form. It names the same tool identity+�u���T never a new grant"��y��y� so the
 * undeclared-tool guard and the tool bridge maps accept it wherever the wire name is accepted
 * (mirroring the second entry of `toolChoiceAliases`). See #3402.
 */
export function dottedToolName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}.${name}` : name;
}

/**
 * Codex unified-exec name normalization.
 *
 * Codex's code-mode shell tool is declared as `exec` (a freeform custom tool whose own
 * description mentions the nested `await tools.exec_command(...)` helper). Some routed providers
 * echo that helper name as the tool-call name, emitting `exec_command`, `write_stdin`,
 * `apply_patch`, `view_image`, or one of the goal helpers (`create_goal`, `get_goal`,
 * `update_goal`, #5495) instead of the declared `exec`. Accept these nested helper names only
 * when the request catalog actually declares `exec` and does not itself declare the emitted name
 * (an MCP server may legitimately advertise one under its own namespace). The helper list itself
 * is closed; the one other admission through `exec` is a direct `mcp__<server>__<tool>` call,
 * which `isCodeModeMcpDirectName` recognizes.
 */
const LEGACY_SHELL_BRIDGE_TOOL_NAMES = ["exec_command", "shell_command"] as const;
const CODE_MODE_HELPER_TOOL_NAMES = [
  ...LEGACY_SHELL_BRIDGE_TOOL_NAMES,
  "write_stdin",
  "apply_patch",
  "view_image",
  "create_goal",
  "get_goal",
  "update_goal",
] as const;

/**
 * The one declared name that turns nested-helper normalization on. Declaring it is not just a
 * name: it also decides whether an emitted helper name is accepted as that shell tool, so callers
 * that build declared-name sets must add it only for a genuine bare declaration.
 */
export const CODE_MODE_EXEC_TOOL_NAME = "exec";

/**
 * Sandbox-namespace prefixes a routed model sticks in front of a real tool name.
 *
 * Codex code-mode tools are reached as `await tools.exec_command({...})` inside the
 * `exec` freeform channel, so the model learns them under that qualified spelling.
 * When it later emits one as a wire-level tool call it copies the qualification and
 * mangles the separator: `tools__exec_command` (it flattens the member access the way
 * the wire format does), `tools.exec_command` (it keeps the dot), `tools=exec_command`
 * (it renders the call as an assignment, the shape it saw in the argument syntax), or
 * `tools/exec_command` (it treats the namespace like a path). All four name the same
 * single tool, so the prefix is recoverable; an empty or unknown remainder stays
 * phantom and goes to the undeclared guard.
 */
// 现场取证（241.t，429 条）里除了上面四种拼法，模型还会用赋值语句的冒号形态
// `tools:exec_command` 与 `tools::exec_command`。顺序是硬约束：`find` 取第一个命中的前缀，
// 双冒号必须排在单冒号之前，否则 `tools::x` 会被单冒号吃掉半个分隔符，剩下 `:x` 谁也不认识。
export const SANDBOX_NAMESPACE_PREFIXES = [
  "tools__",
  "tools.",
  "tools=",
  "tools/",
  "tools::",
  "tools:",
] as const;

/**
 * Whether an emitted name is a sandbox-namespace-qualified reference
 * (`tools.apply_patch`, `tools=apply_patch`, ...). Such a name is never a valid declared wire
 * name on the current Responses wire: `tools` is the exec sandbox namespace and these are all
 * renderings of the same member access, so even without a catalog the guard can treat the form
 * itself as undeclared rather than relay it into a client-side `unsupported call`.
 */
export function isSandboxNamespacePrefixedName(name: string): boolean {
  return SANDBOX_NAMESPACE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Collaboration/sub-agent call-shape repair.
 *
 * Routed models (Q38-class) frequently emit a Codex tool in a different naming
 * form than the request declared: the bare name for a namespaced declaration
 * (spawn_agent for collaboration__spawn_agent), the dotted form
 * (collaboration.spawn_agent), or a functions__-prefixed form. When exactly one
 * declared wire name matches the emitted one after flattening, rewrite the call
 * to that declared name so the turn survives; ambiguous or unmatched names fall
 * through to the undeclared phantom guard unchanged.
 */
/**
 * 只对「参与匹配判定」开放的有界清洗。
 *
 * 现场有模型把零宽字符与控制字符夹进工具名（`tools=\u200b="exec_command"`），也有把调用
 * envelope 的残尾（`</function`、引号、尖括号）粘在名字尾巴上的。清洗结果只用来查候选，
 * 绝不会被当作对外发出的名字：名字本身是否合法由调用方的 schema 校验决定，这里放宽的只是
 * 「同一个意图的另一种脏写法」，不是「多接受一个名字」。清洗后为空或不命中，照旧 fail closed。
 */
function sanitizedNameForMatching(name: string): string {
  let out = name;
  // 成对残尾与赋值残渣一律用码位写，避免在源码里嵌引号转义：
  // 双引号 34、单引号 39、反引号 96、尖括号 60/62、等号 61、冒号 58。
  const PAIRED = [[34, 34], [39, 39], [96, 96], [60, 62]] as const;
  const STRIP_EDGE = [61, 58] as const;
  let changed = true;
  while (changed) {
    changed = false;
    out = out.replace(/[\u200b-\u200f\u2060\ufeff]/g, "").replace(/[\u0000-\u001f\u007f]/g, "");
    const trimmed = out.trim();
    if (trimmed !== out) { out = trimmed; changed = true; }
    for (const [open, close] of PAIRED) {
      const o = String.fromCharCode(open);
      const c = String.fromCharCode(close);
      while (out.length >= 2 && out.startsWith(o) && out.endsWith(c)) {
        out = out.slice(1, -1).trim();
        changed = true;
      }
    }
    // 赋值形态的残渣（`tools=\u200b="exec_command"` 剥完前缀剩 `="exec_command"`）只在两端各剥
    // 一个等号/冒号。这里放宽的仍然只是「同一个名字的脏外壳」：最终是否放行由 push() 要求
    // declared 逐字命中决定，而合法 wire 名不可能以等号或冒号开头，所以不存在因此被多接受的
    // 真实工具名；脏串如果底下不是已声明的名字，照旧一个都救不回来。
    for (const code of STRIP_EDGE) {
      const ch = String.fromCharCode(code);
      while (out.startsWith(ch) || out.endsWith(ch)) {
        out = (out.startsWith(ch) ? out.slice(1) : out.slice(0, -1)).trim();
        changed = true;
      }
    }
  }
  return out;
}

export function repairEmittedToolName(
  name: string,
  declared: ReadonlySet<string> | undefined,
  declaredBare?: ReadonlySet<string>,
  declaredCustom?: ReadonlySet<string>,
): string {
  const repaired = repairEmittedToolNameShape(name, declared, declaredBare, declaredCustom);
  if (repaired !== name) return repaired;
  // 脏字符可能落在前缀与名字之间（`tools=\u200b="exec_command"`），那种位置在「剥完前缀再清洗」
  // 之后仍然把 `=` 后面的残块留在串首，认不出来。所以整名清洗一次再走同一套规则：清洗只影响
  // 匹配，命中后回传的仍然是声明表里的名字，不会把脏串发出去。原始名优先，保证已声明的名字
  // 永远先按原样命中。
  const cleaned = sanitizedNameForMatching(name);
  if (cleaned === name || cleaned.length === 0) return name;
  const repairedCleaned = repairEmittedToolNameShape(cleaned, declared, declaredBare, declaredCustom);
  return repairedCleaned === cleaned ? name : repairedCleaned;
}

function repairEmittedToolNameShape(
  name: string,
  declared: ReadonlySet<string> | undefined,
  declaredBare?: ReadonlySet<string>,
  declaredCustom?: ReadonlySet<string>,
): string {
  if (!declared || declared.size === 0 || declared.has(name)) return name;
  const candidates: string[] = [];
  const push = (n: string) => {
    if (declared.has(n) && !candidates.includes(n)) candidates.push(n);
  };
  // 脏写法（零宽/控制字符/成对残尾）只在查候选时归一，不改变 candidates 里真正回传的名字。
  const consider = (n: string): void => {
    push(n);
    const clean = sanitizedNameForMatching(n);
    if (clean !== n && clean.length > 0) push(clean);
  };
  // functions__exec / functions.exec are the historical ChatGPT prefix for the
  // built-in surface; the current catalog declares the bare name.
  if (name.startsWith("functions__")) push(name.slice("functions__".length));
  if (name.startsWith("functions.")) push(name.slice("functions.".length));
  // Dotted namespace form: collaboration.spawn_agent -> collaboration__spawn_agent.
  if (name.includes(".")) push(name.replaceAll(".", "__"));
  // Bare name: unique declared namespace__name suffix match.
  if (!name.includes("__") && !name.includes(".")) {
    const suffix = "__" + name;
    for (const d of declared) {
      if (d.length > suffix.length && d.endsWith(suffix)) push(d);
    }
  }
  // Namespaced emission with only the bare name declared: collaboration__update_plan
  // -> update_plan. Only when the bare form is declared and the full form is not.
  if (candidates.length === 0 && name.includes("__")) {
    const bare = name.slice(name.indexOf("__") + 2);
    if (bare.length > 0) push(bare);
  }
  // Sandbox-namespace composition: tools__web_run means the model prefixed the JS
  // sandbox namespace onto a real tool name. Strip the prefix when the remainder
  // is declared (the intended call is recoverable), otherwise leave it phantom.
  if (candidates.length === 0) {
    // 反复剥前缀：正文侧的 stripKnownHelperPrefixes 本来就是循环（现场有 tools=tools.exec_command
    // 这种把沙箱命名空间写两遍的），名字侧只剥一层会和它得出不同答案——名字判 undeclared 而正文
    // 已认出 helper。两边同一趟数，才不会出现「一侧认得一侧不认」的第三种漂移。
    let stripped = name;
    for (;;) {
      const prefix = SANDBOX_NAMESPACE_PREFIXES.find((p) => stripped.startsWith(p) && stripped.length > p.length);
      if (prefix === undefined) break;
      stripped = stripped.slice(prefix.length);
    }
    if (stripped === name) return name;
    stripped = sanitizedNameForMatching(stripped);
    if (stripped.length === 0) return name;
    consider(stripped);
    // 分隔符打杂的形态（现场 tools=__exec_command：多写了一对下划线）：剥掉两端多余下划线再试。
    // 同样只影响查候选，放行仍要求 declared/normalize 逐字命中。
    const sepTrimmed = stripped.replace(/^_+|_+$/g, "");
    if (sepTrimmed !== stripped && sepTrimmed.length > 0) {
      consider(sepTrimmed);
      if (candidates.length === 0) {
        const viaTrim = normalizeDeclaredToolName(sepTrimmed, declared, declaredBare, declaredCustom);
        if (viaTrim !== sepTrimmed && declared.has(viaTrim)) consider(viaTrim);
      }
    }
    // The model also tends to collapse the namespace separator itself
    // (tools__web_run -> web_run for declared web__run), so fall back to a
    // separator-insensitive exact match when the plain strip misses.
    const squashed = stripped.replaceAll("__", "_");
    for (const d of declared) {
      if (d.replaceAll("__", "_") === squashed) push(d);
    }
    // 剥完前缀仍未命中声明时，再走一遍 nested-helper 词表。
    //
    // 这是本函数与 normalizeDeclaredToolName 的组合缺口：code-mode 目录只声明 exec，从不声明
    // exec_command / apply_patch / write_stdin 这些 helper，所以「剥前缀后要求逐字命中声明」
    // 对现场主犯（tools=exec_command 137 次、tools=apply_patch 91 次、tools=write_stdin 24 次）
    // 永远落空 —— 裸写 exec_command 能被 normalize 归到已声明的 exec，加上 tools 前缀就两头
    // 不靠，整轮 502。同一个已声明 exec 通道的错误拼写不该是两种命运。
    //
    // 分隔符折叠后的形态同样要再走一遍词表：现场有 `tools__exec__command`（1 次），剥完前缀是
    // `exec__command`，逐字不在 helper 闭集里，折叠成 `exec_command` 才是。
    if (candidates.length === 0 && squashed !== stripped) {
      const viaSquash = normalizeDeclaredToolName(squashed, declared, declaredBare, declaredCustom);
      if (viaSquash !== squashed && declared.has(viaSquash)) push(viaSquash);
    }
    // 授权边界不放宽：helper->exec 仍然要求目录声明了 CODE_MODE_EXEC_TOOL_NAME 且没有声明任何
    // LEGACY_SHELL_BRIDGE_TOOL_NAMES，这两个门都在 normalizeDeclaredToolName 里面。目录里没有
    // exec 时这里拿不到候选，照旧 fail closed。
    if (candidates.length === 0) {
      const viaHelper = normalizeDeclaredToolName(stripped, declared, declaredBare, declaredCustom);
      if (viaHelper !== stripped && declared.has(viaHelper)) consider(viaHelper);
    }
  }
  return candidates.length === 1 ? candidates[0] : name;
}

/**
 * The nested-helper spellings, as a membership view of the same list.
 *
 * A code-mode catalog never DECLARES any of them — they exist only as `tools.<helper>(...)` inside
 * `exec` — so a recorded call under one of these names can only have come from a provider echoing
 * the helper, which is what makes the set usable as a bounded recovery vocabulary for stored
 * history (#5095). Kept beside the tuple it is built from so the two can never drift; this is a
 * different question from `NAMESPACED_BARE_ALIAS_EXCLUDED_NAMES` below, which also covers `exec`
 * itself because declaring THAT name is what turns normalization on.
 */
export const CODE_MODE_HELPER_WIRE_NAMES: ReadonlySet<string> = new Set<string>(
  CODE_MODE_HELPER_TOOL_NAMES,
);

/**
 * A flattened MCP wire name (`mcp__<server>__<tool>`) emitted as a direct tool call.
 *
 * Codex code mode reaches the host's nested tools through `tools.<name>(...)` inside `exec`,
 * so none of them are declared; routed models (observed: Kimi K3, GLM 5.3) occasionally skip the
 * wrapper and call the flattened name directly. Under a code-mode catalog the call is compiled
 * into the equivalent `tools.<name>(...)` exec body instead of failing closed — capability-
 * equivalent, since the model could have written that JavaScript itself. Server and tool must
 * both be non-empty so a bare `mcp__` prefix never qualifies.
 */
export function isCodeModeMcpDirectName(name: string): boolean {
  if (!name.startsWith("mcp__")) return false;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  return separator > 0 && separator + "__".length < rest.length;
}

/**
 * Spellings that may never be MANUFACTURED as a bare alias for a namespaced tool.
 *
 * A bare alias is an ordinary compatibility affordance -- providers echo a namespaced tool
 * without its prefix, and restoring the identity needs the bare spelling registered. For these
 * names it is also an authorization decision, because a declared-name set is what
 * `normalizeDeclaredToolName` and `declaresCodeModeExec` read: bare `exec` turns nested-helper
 * normalization on for a catalog that never declared the shell, bare `exec_command` or
 * `shell_command` turns it off for one that did, and the rest are accepted as declared calls the
 * caller only ever authorized under a namespace.
 *
 * This is a property of the SPELLING, not of the namespace that declared it and not of the reason
 * the alias was being added. It lives here, beside the names it protects, because every site that
 * builds a declared-name set has to apply the same list -- the two that kept their own copies each
 * drifted, once to a single namespace and once to a single name.
 *
 * A genuine namespace-free declaration is NOT covered: that is the caller declaring the tool, not
 * a namespace being discarded to synthesize a bare name.
 */
export const NAMESPACED_BARE_ALIAS_EXCLUDED_NAMES: ReadonlySet<string> = new Set<string>([
  CODE_MODE_EXEC_TOOL_NAME,
  ...CODE_MODE_HELPER_TOOL_NAMES,
]);

/**
 * Normalizes provider-emitted tool names against declared tool catalogs.
 *
 * Rewrites invented `default.<name>` prefixes back to a declared bare tool when that bare tool
 * is declared and neither `default.<name>` nor `default__<name>` was explicitly declared (#4176).
 * The same wrapper may surround an already-flattened namespace identity; accept that exact
 * declared suffix without treating its child name as a bare declaration.
 * Also normalizes nested helper names (`exec_command`, `shell_command`, `write_stdin`,
 * `apply_patch`, `view_image`, `create_goal`, `get_goal`, `update_goal`) and direct
 * `mcp__<server>__<tool>` calls to `exec` when code-mode `exec` is declared in the
 * request catalog. MCP recovery additionally requires explicit custom-tool provenance;
 * a structured function named `exec` is not a JavaScript executor.
 *
 * @param name - The tool name emitted on the wire by the provider.
 * @param declared - All wire tool names declared in the request catalog, including aliases.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 *                       When omitted, falls back to `declared`.
 * @param declaredCustom - Custom wire identities from the caller's catalog, never bare aliases
 *                         manufactured from foreign namespaces.
 * @returns The normalized tool name to expose downstream.
 */
export function normalizeDeclaredToolName(
  name: string,
  declared: ReadonlySet<string> | undefined,
  declaredBare?: ReadonlySet<string>,
  declaredCustom?: ReadonlySet<string>,
): string {
  if (!declared) return name;
  if (declared.has(name)) return name;
  let candidate = name;
  if (name.startsWith("default.")) {
    const bare = name.slice("default.".length);
    const bareDeclared = declaredBare ?? declared;
    if (
      bare.length > 0
      && (
        bareDeclared.has(bare)
        // Muse can wrap the complete `namespace__tool` identity in `default.`. Requiring the
        // exact flattened identity to be declared preserves the #4176 provenance boundary:
        // `default.tool` still cannot borrow a namespaced tool's manufactured bare alias.
        || (bare.includes("__") && declared.has(bare))
      )
      && !declared.has("default." + bare)
      && !declared.has("default__" + bare)
    ) {
      candidate = bare;
    } else if (
      // Code mode never declares bare helper names; a provider that invents `default.`
      // for one still means the nested helper. The same wrapper can surround a direct MCP
      // name, but only a custom exec declaration authorizes that recovery.
      bare.length > 0
      && declared.has(CODE_MODE_EXEC_TOOL_NAME)
      && ((CODE_MODE_HELPER_TOOL_NAMES as readonly string[]).includes(bare)
        || (declaredCustom?.has(CODE_MODE_EXEC_TOOL_NAME) && isCodeModeMcpDirectName(bare)))
      && !declared.has("default." + bare)
      && !declared.has("default__" + bare)
    ) {
      candidate = bare;
    }
  }
  if (!declared.has(CODE_MODE_EXEC_TOOL_NAME)) return candidate;
  if (declared.has(candidate)) return candidate;
  if (candidate === "apply_patch") return CODE_MODE_EXEC_TOOL_NAME;
  // When the catalog explicitly declares any legacy shell bridge name, the environment
  // genuinely exposes that tool — turn normalization off so a call is never mis-routed
  // to `exec`.
  if ((LEGACY_SHELL_BRIDGE_TOOL_NAMES as readonly string[]).some(legacy => declared.has(legacy))) {
    return candidate;
  }
  if ((CODE_MODE_HELPER_TOOL_NAMES as readonly string[]).includes(candidate)) {
    return CODE_MODE_EXEC_TOOL_NAME;
  }
  // A direct `mcp__<server>__<tool>` call names a nested host tool the code-mode catalog
  // never declares; `compileCodeModeHelperInput` turns it into the `tools.<name>(...)`
  // exec body the model could have written itself.
  return declaredCustom?.has(CODE_MODE_EXEC_TOOL_NAME) && isCodeModeMcpDirectName(candidate)
    ? CODE_MODE_EXEC_TOOL_NAME
    : candidate;
}

/**
 * True when a declared catalog is the genuine Codex code-mode shape.
 *
 * `exec` is a name, not a guarantee. A catalog that lists `exec` NEXT TO a bare
 * `exec_command` or `shell_command` is the flat-bridge shape: there `exec` may be an
 * ordinary caller-defined tool, and nested `tools.*` helpers are not what it runs.
 * `normalizeDeclaredToolName` already refuses to reinterpret helper names in that shape,
 * and anything inferring code mode from the bare name owes the same check.
 */
export function declaresCodeModeExec(declared: ReadonlySet<string> | undefined): boolean {
  if (!declared || !declared.has(CODE_MODE_EXEC_TOOL_NAME)) return false;
  return !(LEGACY_SHELL_BRIDGE_TOOL_NAMES as readonly string[]).some(legacy => declared.has(legacy));
}

export function toolChoiceAliases(tool: Pick<OcxTool, "namespace" | "name">): string[] {
  const wireName = namespacedToolName(tool.namespace, tool.name);
  return tool.namespace ? [wireName, dottedToolName(tool.namespace, tool.name)] : [wireName];
}

function sameToolIdentity(
  left: Pick<OcxTool, "namespace" | "name">,
  right: Pick<OcxTool, "namespace" | "name">,
): boolean {
  return left.namespace === right.namespace && left.name === right.name;
}

type ToolIdentity = Readonly<Pick<OcxTool, "namespace" | "name">>;

function snapshotToolIdentity(tool: Pick<OcxTool, "namespace" | "name">): ToolIdentity {
  return Object.freeze({
    name: tool.name,
    ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
  });
}

function buildToolChoiceCatalog(
  tools: readonly ToolIdentity[],
): {
  candidatesByName: ReadonlyMap<string, readonly ToolIdentity[]>;
  sourceCandidatesByName: ReadonlyMap<string, readonly ToolIdentity[]>;
  identitiesByTool: WeakMap<object, ToolIdentity>;
} {
  const index = new Map<string, ToolIdentity[]>();
  const sourceIndex = new Map<string, ToolIdentity[]>();
  const identities = new Map<string, Set<string>>();
  const identitiesByTool = new WeakMap<object, ToolIdentity>();
  for (const tool of tools) {
    const snapshot = snapshotToolIdentity(tool);
    identitiesByTool.set(tool, snapshot);
    const identity = JSON.stringify([snapshot.namespace ?? null, snapshot.name]);
    for (const selector of [...toolChoiceAliases(snapshot), snapshot.name]) {
      const candidates = index.get(selector);
      if (!candidates) {
        index.set(selector, [snapshot]);
        sourceIndex.set(selector, [tool]);
        identities.set(selector, new Set([identity]));
      } else if (!identities.get(selector)!.has(identity)) {
        candidates.push(snapshot);
        sourceIndex.get(selector)!.push(tool);
        identities.get(selector)!.add(identity);
      }
    }
  }
  return { candidatesByName: index, sourceCandidatesByName: sourceIndex, identitiesByTool };
}

/** Compile one immutable view of a request's tool catalog for repeated policy checks. */
export function createToolChoiceResolver(tools: readonly ToolIdentity[] | undefined) {
  const compiled = tools ? buildToolChoiceCatalog(tools) : undefined;
  const candidatesByName = compiled?.candidatesByName;
  const snapshotFor = (tool: ToolIdentity): ToolIdentity | undefined => {
    const snapshot = compiled?.identitiesByTool.get(tool);
    return snapshot && sameToolIdentity(snapshot, tool) ? snapshot : undefined;
  };
  return {
    candidates(name: string): ToolIdentity[] {
      return (candidatesByName?.get(name) ?? []).map(candidate => ({ ...candidate }));
    },
    candidateCount(name: string): number {
      return candidatesByName?.get(name)?.length ?? 0;
    },
    allows(tool: ToolIdentity, allowedTools: ReadonlySet<string>): boolean {
      if (!candidatesByName) return toolChoiceAliases(tool).some(name => allowedTools.has(name));
      const snapshot = snapshotFor(tool);
      return snapshot ? toolAllowedByChoiceFromIndex(snapshot, allowedTools, candidatesByName) : false;
    },
    selects(tool: ToolIdentity, name: string): boolean {
      const snapshot = snapshotFor(tool);
      const candidates = candidatesByName?.get(name);
      return !!snapshot && candidates?.length === 1 && sameToolIdentity(candidates[0], snapshot);
    },
  };
}

/**
 * All tools that could be selected by one client-facing name. Bare logical names are included
 * here because they are a compatibility selector for namespaced tools, while wire and dotted
 * aliases come from `toolChoiceAliases`. A selector with more than one candidate is invalid.
 */
export function toolChoiceCandidates(
  tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined,
  name: string,
): Pick<OcxTool, "namespace" | "name">[] {
  if (!tools) return [];
  return [...(buildToolChoiceCatalog(tools).sourceCandidatesByName.get(name) ?? [])];
}

/**
 * Newer Codex clients can select a tool nested in a namespace by its bare name. Resolve that
 * shorthand only when the request contains one tool with the logical name, so an ambiguous name
 * cannot authorize a tool from an unintended namespace.
 */
export function toolAllowedByChoice(
  tool: Pick<OcxTool, "namespace" | "name">,
  allowedTools: ReadonlySet<string>,
  tools?: readonly Pick<OcxTool, "namespace" | "name">[],
): boolean {
  if (!tools) return toolChoiceAliases(tool).some(name => allowedTools.has(name));
  return toolAllowedByChoiceFromIndex(
    snapshotToolIdentity(tool),
    allowedTools,
    buildToolChoiceCatalog(tools).candidatesByName,
  );
}

function toolAllowedByChoiceFromIndex(
  tool: ToolIdentity,
  allowedTools: ReadonlySet<string>,
  candidatesByName: ReadonlyMap<string, readonly ToolIdentity[]>,
): boolean {
  for (const name of [...toolChoiceAliases(tool), tool.name]) {
    if (!allowedTools.has(name)) continue;
    const candidates = candidatesByName.get(name);
    if (candidates?.length === 1 && sameToolIdentity(candidates[0], tool)) return true;
  }
  return false;
}

export function resolveToolChoiceWireName(tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined, name: string): string {
  const candidates = toolChoiceCandidates(tools, name);
  if (candidates.length === 1) {
    const match = candidates[0];
    return namespacedToolName(match.namespace, match.name);
  }
  // Keep unknown/ambiguous names unchanged for callers that only serialize a selector. The
  // catalog-aware predicate rejects them, and parseRequest rejects ambiguous request selectors.
  return name;
}

/**
 * Whether `modelId` is in a per-provider classification list (e.g. `noVisionModels`). Matches the full
 * id, OR — for Ollama-style ids — the family before the ":size" tag, so a `gpt-oss` entry covers
 * `gpt-oss:120b`/`gpt-oss:20b`. Colon-less ids (e.g. `grok-build-0.1`) still match exactly only.
 */
export function modelInList(list: string[] | undefined, modelId: string): boolean {
  if (!list || list.length === 0) return false;
  if (list.includes(modelId)) return true;
  const colon = modelId.indexOf(":");
  return colon > 0 && list.includes(modelId.slice(0, colon));
}

export type OcxToolChoice =
  | "auto"
  | "none"
  | "required"
  | { name: string }
  | { allowedTools: string[]; mode: "auto" | "required" };

export function isAllowedToolChoice(value: OcxToolChoice | undefined): value is { allowedTools: string[]; mode: "auto" | "required" } {
  return typeof value === "object" && value !== null && "allowedTools" in value;
}

/** Compile the request's tool-choice policy into a reusable advertisement/restoration predicate. */
export function toolChoiceToolPredicate(
  choice: OcxToolChoice | undefined,
  tools?: readonly Pick<OcxTool, "namespace" | "name">[],
): (tool: Pick<OcxTool, "namespace" | "name">) => boolean {
  if (!choice || choice === "auto" || choice === "required") return () => true;
  if (choice === "none") return () => false;
  if (isAllowedToolChoice(choice)) {
    const allowed = new Set(choice.allowedTools);
    const resolver = createToolChoiceResolver(tools);
    return tool => resolver.allows(tool, allowed);
  }
  if (!tools) return tool => toolChoiceAliases(tool).includes(choice.name);
  const resolver = createToolChoiceResolver(tools);
  return tool => resolver.selects(tool, choice.name);
}
