import {
  collectAmbiguousDottedAliases,
  dottedAliasIsUnambiguous,
  isSchemaValidResponsesToolName,
  wireToolInnerName,
} from "../responses/tool-name-aliases";
import {
  dottedToolName,
  NAMESPACED_BARE_ALIAS_EXCLUDED_NAMES,
  namespacedToolName,
  normalizeDeclaredToolName,
} from "../types";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";
// 改名器与桥接侧唯一决策点(src/responses/emitted-call-guard.ts)引用的是同一份实现。
// 它不在 src/types.ts 那层 barrel 上，所以从定义处具名导入；在本文件里另抄一份改名规则
// 才是那条注释警告的漂移来路。
import { repairEmittedToolName } from "../types/tools";

/** Item types the client executes through a request-declared wire name. */
export const CLIENT_EXECUTED_CALL_TYPES: ReadonlySet<string> = new Set([
  "function_call",
  "custom_tool_call",
]);
/** Codex groups ordinary top-level tools here; unlike an MCP namespace, it has no wire prefix. */
const BUILTIN_FUNCTIONS_NAMESPACE = "functions";

/**
 * Hosted declarations whose response items the PROVIDER executes, keyed by the request
 * declaration type. These need no client answer, so their names are deliberately absent from
 * the request catalog and must not be read as an undeclared client tool.
 *
 * xAI surfaces hosted `x_search` as `custom_tool_call`. Probed 2026-08-23 against the OAuth CLI
 * destination: its hosted calls use an `xs_call-` call-id prefix. Observed call names were
 * `x_keyword_search`, `x_semantic_search`, and `x_user_search` — three literals for one tool,
 * which is why authorization keys on the declaration, item type, and call-id prefix, never on
 * the name.
 */
export type ProviderExecutedCallType = Readonly<{
  itemType: string;
  callIdPrefix: string;
}>;

type ProviderExecutedCallTypes = ReadonlySet<ProviderExecutedCallType>;

export const PROVIDER_EXECUTED_DECLARATION_CALL_TYPES = new Map<string, ProviderExecutedCallType>([
  ["x_search", { itemType: "custom_tool_call", callIdPrefix: "xs_call-" }],
]);

/** Nameless declaration kinds whose response items still require client execution. */
const NAMELESS_CLIENT_DECLARATION_CALL_TYPES = new Map([
  ["local_shell", "local_shell_call"],
  ["tool_search", "tool_search_call"],
  ["computer_use_preview", "computer_call"],
  ["computer_use", "computer_call"],
]);

const NAMELESS_CLIENT_CALL_DISPLAY_NAMES = new Map([
  ["local_shell_call", "local_shell"],
  ["tool_search_call", "tool_search"],
  ["computer_call", "computer_use"],
]);

const EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES: ReadonlySet<string> = new Set();
const EMPTY_PROVIDER_EXECUTED_CALL_TYPES: ReadonlySet<ProviderExecutedCallType> = new Set();

/** Supported hosted/private declarations that carry no client-executable wire name. */
const NAMELESS_TOOL_SPEC_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "file_search",
  "computer_use_preview",
  "computer_use",
  "code_interpreter",
  "image_generation",
  "image_gen",
  "mcp",
  "tool_search",
  "local_shell",
  "x_search",
]);

/** An upstream-supplied name reaches the error message; keep it bounded. */
const MAX_REPORTED_NAME_CHARS = 100;

export const UNDECLARED_TOOL_CALL_ERROR_CODE = "undeclared_tool_call";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 本 guard 的裸名解析链：先 normalizeDeclaredToolName，再 repairEmittedToolName。
 *
 * 授权（undeclaredNameInItem）与发射（normalizeDefaultNamespaceInItem）必须读这一个函数。
 * 过去授权侧只 normalize，而桥接侧 resolveEmittedCall 是 normalize + repair，于是同一个畸形名
 * （exec 沙箱命名空间的四种拼法，以及 collaboration / functions 前缀形状）在两条路径上得到
 * 两个答案：桥接改名放行，passthrough 按 1700 fail closed 并回一个 response.failed。这正是
 * 本文件里 normalizeDefaultNamespaceInItem 那段长注释警告的「授权与发射读两套解析器」，
 * 也是 5095 的成因。
 *
 * repair 自身的 fail-closed 性质原样保留：候选数不等于 1 时它返回输入本身，所以未知剩余、
 * 空剩余、裸容器名、相似而不同的前缀、随机后缀与被截断的名字，全部仍然算 undeclared。
 */
function resolveGuardedEmittedName(
  name: string,
  declared: ReadonlySet<string>,
  declaredBare?: ReadonlySet<string>,
  declaredCustom?: ReadonlySet<string>,
  // 发射名改写门控（thirdPartyEmissionRepair）：缺省 false = 官方端点语义 —— 整趟改名器不走，
  // 只 normalize，恢复到 95f462434 之前；true（三方 / shadow 流量）与现实现逐字节一致。
  // 授权侧与发射侧共用本函数，所以门控只在这里落地一次，所有上层入口透传同一个布尔。
  allowEmissionRepair?: boolean,
): string {
  const normalized = normalizeDeclaredToolName(name, declared, declaredBare, declaredCustom);
  if (allowEmissionRepair !== true) return normalized;
  const repaired = repairEmittedToolName(normalized, declared);
  if (repaired === normalized) return normalized;
  // 只放行「客户端真能用」的改名结果。repair 可以命中一个点号形式的别名（web.run 这种
  // 展平拼法，见 addWireToolName 与 #3402），而 Responses 的 name 正则只接受 [A-Za-z0-9_-]：
  // 收下它等于把一个上游会在 input[N].name 上拒绝、且会被 Codex 写进会话历史永久污染的形状
  // 中继出去（#5095）。改名结果不合规矩就退回改名前，让它照旧 fail closed。
  if (!isSchemaValidResponsesToolName(repaired)) return normalized;
  // repair 的「裸名命中唯一 ns__name 后缀」那条规则，会凭一个只在命名空间里声明过的工具，
  // 凭空接受它的裸拼法。裸拼法对本 guard 从来不是兼容性的边缘情况，而是授权决策：声明集正是
  // normalizeDeclaredToolName 读的那份，裸 exec 会给一个从未声明外壳的目录打开 nested-helper
  // 归一化，裸 exec_command / shell_command 会反过来给声明过的目录关掉它，其余裸名则把只在
  // 命名空间下授权过的调用当作已声明收下。收集侧（addWireToolName）已经用
  // NAMESPACED_BARE_ALIAS_EXCLUDED_NAMES 拒绝为这些拼法制造裸别名，repair 不能从后门口把
  // 同一批名字再放进来——那条既有意图（只在 mcp 命名空间声明 exec 时绝不授权裸 helper 名）
  // 由测试 a namespaced-only exec declaration does not authorize the nested helper names 锁住。
  //
  // 判据看 provenance 而不看名称猜测：只有 caller 确实裸声明过（collectDeclaredBareWireToolNames
  // 收录的、不带命名空间来源的声明）的裸拼法才配当别名。省略 declaredBare 的调用方没有这份
  // 来源信息，一律按未授权处理——fail closed 一侧不需要额外证据。
  // collaboration__spawn_agent 这类不在名单里的名字不受影响，两条路径的改名对称照旧成立。
  if (
    NAMESPACED_BARE_ALIAS_EXCLUDED_NAMES.has(normalized)
    && !normalized.includes("__")
    && !normalized.includes(".")
    && declaredBare?.has(normalized) !== true
  ) return normalized;
  return repaired;
}

function addWireToolName(
  names: Set<string>,
  tool: unknown,
  namespace?: string,
  ambiguousDottedAliases?: ReadonlySet<string>,
): void {
  if (!isPlainObject(tool)) return;
  const name = wireToolInnerName(tool);
  if (!name) return;
  // Codex routes MCP calls by an explicit `namespace` field, so the same tool is reachable
  // as a bare inner name or as the flattened form; accept both rather than guess which
  // coordinate system this provider echoes back.
  if (!namespace || namespace === BUILTIN_FUNCTIONS_NAMESPACE) {
    names.add(name);
    return;
  }
  names.add(namespacedToolName(namespace, name));
  // Some routed providers echo the flattened wire name with a dot (`ns.name`, observed with
  // muse-spark via opencode-go) instead of `ns__name`. It is the same tool identity, so register
  // the dotted spelling too, mirroring `toolChoiceAliases` (#3402) -- but only while that
  // spelling names exactly one declared tool. Dots are legal inside both a namespace and a
  // name, so two distinct identities can flatten onto one dotted alias; accepting it then would
  // authorize a call the caller never declared under that identity. Ambiguous aliases fall back
  // to the unambiguous `ns__name` form.
  const dotted = dottedToolName(namespace, name);
  if (dottedAliasIsUnambiguous(namespace, name) && !ambiguousDottedAliases?.has(dotted)) {
    names.add(dotted);
  }
  // The code-mode helper spellings do not get a bare alias for a namespaced tool. Bare `exec`
  // switches nested-helper normalization on for a catalog that never declared the shell; bare
  // `exec_command`/`shell_command` switch it off for one that did; bare `write_stdin`/
  // `apply_patch`/`view_image` are simply accepted as declared under a name the caller only ever
  // authorized inside a namespace. This guard named only `exec` and let the other five through,
  // which is the same drift the bridge-side copy had; both now read one list
  // (src/types/tools.ts). Every other inner name keeps the bare alias.
  if (!NAMESPACED_BARE_ALIAS_EXCLUDED_NAMES.has(name)) names.add(name);
}

/**
 * Catalog view owned by the current Responses turn.
 *
 * `previous_response_id` expansion prepends stored input items, including historical
 * `additional_tools` declarations. Those items remain conversation history but cannot grant
 * execution authority to this turn. Top-level `tools` always belongs to the current request;
 * only input catalogs at or after the replay boundary are current.
 */
export function currentTurnWireToolCatalogBody(
  body: unknown,
  replayPrefixLength: number | undefined,
): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  if (typeof replayPrefixLength !== "number" || !Number.isFinite(replayPrefixLength)) return body;
  const start = Math.min(body.input.length, Math.max(0, Math.trunc(replayPrefixLength)));
  if (start === 0) return body;
  return { ...body, input: body.input.slice(start) };
}

function addWireToolSpecs(
  names: Set<string>,
  specs: unknown,
  ambiguousDottedAliases?: ReadonlySet<string>,
): void {
  if (!Array.isArray(specs)) return;
  for (const spec of specs) {
    if (!isPlainObject(spec)) continue;
    if (spec.type === "namespace" && Array.isArray(spec.tools)) {
      const namespace = typeof spec.name === "string" ? spec.name : undefined;
      for (const inner of spec.tools) addWireToolName(names, inner, namespace, ambiguousDottedAliases);
      continue;
    }
    addWireToolName(names, spec, undefined, ambiguousDottedAliases);
  }
}

/**
 * Tool names the OUTBOUND Responses body actually declared.
 *
 * This reads the body that goes upstream rather than the parsed internal tool list: the
 * passthrough forwards wire shapes (namespaced MCP groups, `additional_tools` items carried
 * inside `input`, routed custom-tool rewrites) that the internal list flattens or renames, and
 * only the wire names can be compared against what the provider echoes back.
 */
export function collectDeclaredWireToolNames(body: unknown): Set<string> {
  const names = new Set<string>();
  if (!isPlainObject(body)) return names;
  const specGroups: unknown[] = [body.tools];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isPlainObject(item)
        && (item.type === "additional_tools" || item.type === "tool_search_output")
      ) specGroups.push(item.tools);
    }
  }
  const ambiguousDottedAliases = collectAmbiguousDottedAliases(specGroups);
  for (const specs of specGroups) addWireToolSpecs(names, specs, ambiguousDottedAliases);
  return names;
}

/**
 * Collects explicitly declared bare wire tool names from a Responses request body.
 *
 * Bare wire tools are top-level declarations (or grouped under the builtin `functions`
 * namespace) that are not namespaced and do not carry a flattened namespace delimiter (`__`)
 * or dotted namespace alias (`.`).
 *
 * @param body - The outbound or inbound request body.
 * @returns A set of declared bare tool names.
 */
export function collectDeclaredBareWireToolNames(body: unknown): Set<string> {
  const names = new Set<string>();
  if (!isPlainObject(body)) return names;
  const specGroups: unknown[] = [body.tools];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isPlainObject(item)
        && (item.type === "additional_tools" || item.type === "tool_search_output")
      ) specGroups.push(item.tools);
    }
  }
  for (const specs of specGroups) {
    if (!Array.isArray(specs)) continue;
    for (const spec of specs) {
      if (!isPlainObject(spec)) continue;
      if (spec.type === "namespace" && Array.isArray(spec.tools)) {
        if (spec.name === BUILTIN_FUNCTIONS_NAMESPACE) {
          for (const inner of spec.tools) {
            if (!isPlainObject(inner)) continue;
            const name = wireToolInnerName(inner);
            if (name && !name.includes("__") && !name.includes(".")) names.add(name);
          }
        }
        continue;
      }
      const name = wireToolInnerName(spec);
      if (name && !name.includes("__") && !name.includes(".")) names.add(name);
    }
  }
  return names;
}

/** Custom declarations with no foreign namespace, for code-mode exec recovery. */
export function collectDeclaredBareCustomWireToolNames(body: unknown): Set<string> {
  const names = new Set<string>();
  if (!isPlainObject(body)) return names;
  const specGroups: unknown[] = [body.tools];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isPlainObject(item) && (item.type === "additional_tools" || item.type === "tool_search_output")) {
        specGroups.push(item.tools);
      }
    }
  }
  const add = (tool: unknown): void => {
    if (isPlainObject(tool) && tool.type === "custom" && typeof tool.name === "string") names.add(tool.name);
  };
  for (const specs of specGroups) {
    if (!Array.isArray(specs)) continue;
    for (const spec of specs) {
      if (!isPlainObject(spec)) continue;
      if (spec.type === "namespace") {
        if (spec.name === BUILTIN_FUNCTIONS_NAMESPACE && Array.isArray(spec.tools)) {
          for (const inner of spec.tools) add(inner);
        }
      } else add(spec);
    }
  }
  return names;
}

function addNamelessClientCallTypes(callTypes: Set<string>, specs: unknown): void {
  if (!Array.isArray(specs)) return;
  for (const spec of specs) {
    if (!isPlainObject(spec) || typeof spec.type !== "string") continue;
    const callType = NAMELESS_CLIENT_DECLARATION_CALL_TYPES.get(spec.type);
    if (callType) callTypes.add(callType);
  }
}

function addProviderExecutedCallTypes(
  callTypes: Set<ProviderExecutedCallType>,
  specs: unknown,
): void {
  if (!Array.isArray(specs)) return;
  for (const spec of specs) {
    if (!isPlainObject(spec) || typeof spec.type !== "string") continue;
    const callType = PROVIDER_EXECUTED_DECLARATION_CALL_TYPES.get(spec.type);
    if (callType) callTypes.add(callType);
  }
}

/**
 * Item types this turn's hosted declarations authorize the PROVIDER to emit unnamed.
 *
 * Caller must gate this on the destination actually being that provider; a declaration alone
 * is not authority, or any upstream could claim a hosted shape it never serves.
 */
export function collectProviderExecutedCallTypes(body: unknown): Set<ProviderExecutedCallType> {
  const callTypes = new Set<ProviderExecutedCallType>();
  if (!isPlainObject(body)) return callTypes;
  addProviderExecutedCallTypes(callTypes, body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isPlainObject(item)
        && (item.type === "additional_tools" || item.type === "tool_search_output")
      ) addProviderExecutedCallTypes(callTypes, item.tools);
    }
  }
  return callTypes;
}

function isAuthorizedProviderExecutedCall(
  item: Record<string, unknown>,
  callTypes: ProviderExecutedCallTypes,
): boolean {
  if (typeof item.call_id !== "string") return false;
  for (const callType of callTypes) {
    if (
      item.type === callType.itemType
      && item.call_id.startsWith(callType.callIdPrefix)
    ) return true;
  }
  return false;
}

/** Nameless client-call item types authorized by supported request tool declarations. */
export function collectDeclaredNamelessClientCallTypes(body: unknown): Set<string> {
  const callTypes = new Set<string>();
  if (!isPlainObject(body)) return callTypes;
  addNamelessClientCallTypes(callTypes, body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isPlainObject(item)
        && (item.type === "additional_tools" || item.type === "tool_search_output")
      ) {
        addNamelessClientCallTypes(callTypes, item.tools);
      }
    }
  }
  return callTypes;
}

function isReadableWireToolSpec(spec: unknown): boolean {
  if (!isPlainObject(spec) || typeof spec.type !== "string" || spec.type.length === 0) return false;
  if (spec.type === "function") {
    return (typeof spec.name === "string" && spec.name.length > 0)
      || (isPlainObject(spec.function)
        && typeof spec.function.name === "string"
        && spec.function.name.length > 0);
  }
  if (spec.type === "custom") return typeof spec.name === "string" && spec.name.length > 0;
  if (spec.type === "namespace") {
    return typeof spec.name === "string"
      && spec.name.length > 0
      && Array.isArray(spec.tools)
      && (spec.tools.length === 0 || spec.tools.some(inner =>
        isPlainObject(inner)
        && (inner.type === "function" || inner.type === "custom")
        && typeof inner.name === "string"
        && inner.name.length > 0
      ));
  }
  if (NAMELESS_TOOL_SPEC_TYPES.has(spec.type)) return true;
  return typeof spec.name === "string" && spec.name.length > 0;
}

function isReadableWireToolCatalog(value: unknown): boolean {
  return Array.isArray(value)
    && (value.length === 0 || value.some(isReadableWireToolSpec));
}

/** Whether a request contains a supported catalog, including an explicit empty deny-all array. */
export function hasExplicitWireToolCatalog(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  if (isReadableWireToolCatalog(body.tools)) return true;
  if (!Array.isArray(body.input)) return false;
  return body.input.some(item =>
    isPlainObject(item)
    && item.type === "additional_tools"
    && isReadableWireToolCatalog(item.tools)
  );
}

/**
 * Evaluates whether an individual output item represents an undeclared tool call.
 *
 * @param item - The item to check.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredNamelessClientCallTypes - Nameless client call types declared by the request.
 * @param providerExecutedCallTypes - Call types executed by the provider.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @param declaredCustom - Current bare custom declarations eligible for code-mode recovery.
 * @returns The undeclared tool call name if unauthorized, or undefined if permitted.
 */
function undeclaredNameInItem(
  item: unknown,
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string>,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
  declaredBare?: ReadonlySet<string>,
  declaredCustom?: ReadonlySet<string>,
  allowlist?: ReadonlySet<string>,
  allowEmissionRepair?: boolean,
): UndeclaredToolVerdict | undefined {
  if (!isPlainObject(item)) return undefined;
  if (typeof item.type !== "string") return undefined;
  // The provider executes this exact measured shape itself, so there is no client name to
  // authorize. The caller supplies these signatures only for the matching destination and
  // declarations; the item must additionally carry the hosted call-id prefix.
  if (isAuthorizedProviderExecutedCall(item, providerExecutedCallTypes)) return undefined;
  const namelessDisplayName = NAMELESS_CLIENT_CALL_DISPLAY_NAMES.get(item.type);
  if (namelessDisplayName !== undefined) {
    // Only Codex's explicit `execution: "client"` form delegates tool search to the client.
    if (item.type === "tool_search_call" && item.execution !== "client") return undefined;
    return declaredNamelessClientCallTypes.has(item.type) ? undefined
      : { name: namelessDisplayName, droppable: false };
  }
  if (!CLIENT_EXECUTED_CALL_TYPES.has(item.type)) return undefined;
  const name = item.name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (typeof item.namespace === "string") {
    // Namespaced calls are matched by their full wire name only — never legacy-normalize
    // them, or an undeclared namespaced `exec_command` could slip through as bare `exec`.
    // Both flattened spellings (`ns__name` and the dotted `ns.name` some providers echo,
    // #3402) name the same tool identity.
    if (declared.has(namespacedToolName(item.namespace, name))) return undefined;
    // Only consult the dotted spelling when it cannot double as another identity's canonical
    // name; otherwise a stranger's `ns__name` would authorize this call.
    if (
      dottedAliasIsUnambiguous(item.namespace, name)
      && declared.has(dottedToolName(item.namespace, name))
    ) return undefined;
    const bareDeclared = declaredBare ?? declared;
    const bare = name.startsWith("default.") ? name.slice("default.".length) : name;
    if (
      item.namespace === "default"
      && bare.length > 0
      && bareDeclared.has(bare)
      && !declared.has(namespacedToolName(item.namespace, bare))
      && !declared.has(dottedToolName(item.namespace, bare))
    ) return undefined;
    const wireName = namespacedToolName(item.namespace, name);
    return { name, droppable: droppableFor(wireName, name, allowlist) };
  }
  // C1：与桥接侧读同一个解析器。normalize 之后再过一遍 repairEmittedToolName，沙箱前缀形状
  // 与 collaboration / functions 前缀形状才能在两条路径上得到同一个答案。
  // 发射名改写门控：缺省 false（官方端点）只 normalize，即 95f462434 之前的上游语义。
  const effectiveName = resolveGuardedEmittedName(name, declared, declaredBare, declaredCustom, allowEmissionRepair);
  if (declared.has(effectiveName)) return undefined;
  return { name, droppable: droppableFor(effectiveName, name, allowlist) };
}

/**
 * First undeclared client tool named by a Responses SSE payload, or undefined.
 *
 * @param payload - The parsed SSE event payload.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredNamelessClientCallTypes - Nameless client call types declared by the request.
 * @param providerExecutedCallTypes - Call types executed by the provider.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @param declaredCustom - Current bare custom declarations eligible for code-mode recovery.
 * @returns The name of the first undeclared tool call, or undefined.
 */
/**
 * Guard outcome for one client-executed call: `name` is what an error message would report,
 * `droppable` says the shadow phantom-tool allowlist covers it, in which case the call is
 * silently dropped (or answered with directive feedback by the bridge) instead of failing
 * the turn. Fork addition: scoped to shadow-intercepted requests only.
 */
export type UndeclaredToolVerdict = Readonly<{ name: string; droppable: boolean }>;

function droppableFor(
  effectiveName: string,
  rawName: string,
  allowlist: ReadonlySet<string> | undefined,
): boolean {
  if (!allowlist || allowlist.size === 0) return false;
  return allowlist.has(rawName) || allowlist.has(effectiveName);
}

export function undeclaredToolCallVerdict(
  payload: unknown,
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string> = EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
  declaredBare?: ReadonlySet<string>,
  declaredCustom?: ReadonlySet<string>,
  allowlist?: ReadonlySet<string>,
  allowEmissionRepair?: boolean,
): UndeclaredToolVerdict | undefined {
  if (!isPlainObject(payload)) return undefined;
  if (payload.type === "response.output_item.added" || payload.type === "response.output_item.done") {
    return undeclaredNameInItem(payload.item, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare, declaredCustom, allowlist, allowEmissionRepair);
  }
  if (payload.type === "response.function_call_arguments.done" && typeof payload.name === "string") {
    const fakeItem = { type: "function_call", name: payload.name, namespace: payload.namespace };
    return undeclaredNameInItem(fakeItem, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare, declaredCustom, allowlist, allowEmissionRepair);
  }
  // Sparse gateways skip incremental items and only ever ship the terminal snapshot.
  if (payload.type === "response.completed" || payload.type === "response.incomplete") {
    return undeclaredToolCallVerdictInResponse(payload.response, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare, declaredCustom, allowlist, allowEmissionRepair);
  }
  return undefined;
}

function undeclaredToolCallVerdictInResponse(
  response: unknown,
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string>,
  providerExecutedCallTypes: ProviderExecutedCallTypes,
  declaredBare?: ReadonlySet<string>,
  declaredCustom?: ReadonlySet<string>,
  allowlist?: ReadonlySet<string>,
  allowEmissionRepair?: boolean,
): UndeclaredToolVerdict | undefined {
  if (!isPlainObject(response) || !Array.isArray(response.output)) return undefined;
  for (const item of response.output) {
    const verdict = undeclaredNameInItem(item, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare, declaredCustom, allowlist, allowEmissionRepair);
    if (verdict !== undefined) return verdict;
  }
  return undefined;
}

/**
 * Remove phantom calls named by the shadow allowlist from a Responses `output` array.
 * Returns the original object untouched when nothing matched, so callers can cheaply test
 * for a rewrite. Names the request itself declared are always kept: the allowlist exists for
 * names the request can NEVER legitimately carry, and a same-name declaration wins.
 */
export function stripDroppableToolCallsInResponse(
  response: unknown,
  declared: ReadonlySet<string>,
  allowlist: ReadonlySet<string>,
  declaredBare?: ReadonlySet<string>,
  allowEmissionRepair?: boolean,
): { response: unknown; removed: string[] } {
  if (!allowlist || allowlist.size === 0) return { response, removed: [] };
  if (!isPlainObject(response) || !Array.isArray(response.output)) return { response, removed: [] };
  const removed: string[] = [];
  const kept = response.output.filter(item => {
    if (!isPlainObject(item)) return true;
    if (item.type !== "function_call" && item.type !== "custom_tool_call") return true;
    const name = item.name;
    if (typeof name !== "string" || name.length === 0) return true;
    if (typeof item.namespace === "string") {
      const wireName = namespacedToolName(item.namespace, name);
      if (declared.has(wireName)) return true;
      if (allowlist.has(wireName) || allowlist.has(name)) {
        removed.push(wireName);
        return false;
      }
      return true;
    }
    // 与授权侧共用同一条解析链：终态快照的剥离判定必须和逐条 verdict 同答案，否则同一个
    // 条目可能在增量事件里被放行、在 completed 快照里被当成 phantom 剥掉（或反之）。
    // 发射名改写门控：调用方（passthrough）在其 shadow/三方作用域传 true；缺省 false 时
    // 授权侧同样只 normalize，两侧仍然同答案。
    const effectiveName = resolveGuardedEmittedName(name, declared, declaredBare, undefined, allowEmissionRepair);
    if (declared.has(effectiveName)) return true;
    if (allowlist.has(name) || allowlist.has(effectiveName)) {
      removed.push(name);
      return false;
    }
    return true;
  });
  if (removed.length === 0) return { response, removed };
  return { response: { ...response, output: kept }, removed };
}

/**
 * JSON-string sibling of stripDroppableToolCallsInResponse for the bounded-JSON passthrough
 * path. A parse failure, a non-object body, or an empty removal set returns the input string
 * byte-identical: the phantom drop is best-effort, never a new way to fail a request.
 */
export function stripDroppableToolCallsInJsonString(
  json: string,
  declared: ReadonlySet<string>,
  allowlist: ReadonlySet<string>,
  declaredBare?: ReadonlySet<string>,
  allowEmissionRepair?: boolean,
): string {
  if (allowlist.size === 0) return json;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  const stripped = stripDroppableToolCallsInResponse(parsed, declared, allowlist, declaredBare, allowEmissionRepair);
  if (stripped.removed.length === 0) return json;
  return JSON.stringify(stripped.response);
}

export function undeclaredToolCallName(
  payload: unknown,
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string> = EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
  declaredBare?: ReadonlySet<string>,
  declaredCustom?: ReadonlySet<string>,
  phantomAllowlist?: ReadonlySet<string>,
  allowEmissionRepair?: boolean,
): string | undefined {
  const verdict = undeclaredToolCallVerdict(payload, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare, declaredCustom, phantomAllowlist, allowEmissionRepair);
  return verdict !== undefined && !verdict.droppable ? verdict.name : undefined;
}

/**
 * First undeclared client tool in a Responses object's `output` array, or undefined.
 *
 * @param response - The Responses result object containing `output`.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredNamelessClientCallTypes - Nameless client call types declared by the request.
 * @param providerExecutedCallTypes - Call types executed by the provider.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @param declaredCustom - Current bare custom declarations eligible for code-mode recovery.
 * @returns The name of the first undeclared tool call, or undefined.
 */
export function undeclaredToolCallNameInResponse(
  response: unknown,
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string> = EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
  declaredBare?: ReadonlySet<string>,
  declaredCustom?: ReadonlySet<string>,
  phantomAllowlist?: ReadonlySet<string>,
  allowEmissionRepair?: boolean,
): string | undefined {
  const verdict = undeclaredToolCallVerdictInResponse(
    response,
    declared,
    declaredNamelessClientCallTypes,
    providerExecutedCallTypes,
    declaredBare,
    declaredCustom,
    phantomAllowlist,
    allowEmissionRepair,
  );
  return verdict !== undefined && !verdict.droppable ? verdict.name : undefined;
}

/**
 * Formats an error message indicating that a routed provider emitted an undeclared tool call.
 *
 * @param name - The undeclared tool name emitted by the provider.
 * @returns A formatted error message string.
 */
export function undeclaredToolCallMessage(name: string): string {
  const reported = name.slice(0, MAX_REPORTED_NAME_CHARS);
  return `routed provider emitted undeclared client tool "${reported}"; only request-declared tools may be called`;
}

/**
 * Normalizes a single output item's default-namespaced tool call back to declared bare tool.
 *
 * Strips invented `default.` prefixes or `namespace: "default"` from tool calls when the bare
 * tool name was declared and neither dotted nor flattened namespaced forms were declared (#4176).
 *
 * @param item - The output item to normalize.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns An object with the normalized value and a boolean indicating if changes occurred.
 */
export function normalizeDefaultNamespaceInItem(
  item: unknown,
  declared: ReadonlySet<string>,
  declaredBare?: ReadonlySet<string>,
  allowEmissionRepair?: boolean,
): { value: unknown; changed: boolean } {
  if (!isPlainObject(item)) return { value: item, changed: false };
  if (!CLIENT_EXECUTED_CALL_TYPES.has(item.type as string)) {
    return { value: item, changed: false };
  }
  const name = item.name;
  if (typeof name !== "string" || name.length === 0) {
    return { value: item, changed: false };
  }
  const bareDeclared = declaredBare ?? declared;
  if (item.namespace === "default") {
    const bare = name.startsWith("default.") ? name.slice("default.".length) : name;
    if (
      bare.length > 0
      && bareDeclared.has(bare)
      && !declared.has(namespacedToolName("default", bare))
      && !declared.has(dottedToolName("default", bare))
    ) {
      const next: Record<string, unknown> = { ...(item as Record<string, unknown>), name: bare };
      delete next.namespace;
      return { value: next, changed: true };
    }
    return { value: item, changed: false };
  }
  if (item.namespace === undefined || item.namespace === BUILTIN_FUNCTIONS_NAMESPACE) {
    if (name.startsWith("default.")) {
      const bare = name.slice("default.".length);
      if (
        bare.length > 0
        && bareDeclared.has(bare)
        && !declared.has("default." + bare)
        && !declared.has("default__" + bare)
      ) {
        return { value: { ...item, name: bare }, changed: true };
      }
    }
    // Authorization and emission were reading two different resolvers for the same question.
    // `undeclaredNameInItem` resolves an emitted name through `normalizeDeclaredToolName`, which
    // maps a `default.`-prefixed code-mode helper onto the declared `exec` (#4412) as well as a
    // `default.`-prefixed bare tool (#4176); the rewrite above learned only the second case. So a
    // routed Muse turn under a code-mode catalog had `default.view_image` ACCEPTED as `exec` and
    // then relayed under the name the upstream schema rejects. Codex stored
    // `{"type":"function_call","name":"default.view_image"}`, answered "unsupported call", and
    // every later replay of that history — a side chat, a compaction — was refused on
    // `input[N].name` for the lifetime of the conversation (#5095).
    //
    // Emit the name the guard authorized rather than a second, weaker opinion about it. The two
    // must agree: a name good enough to admit is the name the client has to receive.
    //
    // 改写只可能发生在「解析器把名字换成了另一个已声明且客户端可用的名字」时，所以这个分支
    // 不会碰一个本来就合法的名字：目录真的声明了它，authorized 就等于 name。The routed-custom-tool
    // and namespace restores run earlier in the same chain and already rewrite the shapes they
    // own, which leaves this as the boundary check for the names no restore claimed.
    // C2 扩展：授权查询换成 resolveGuardedEmittedName（normalize + repair），与
    // undeclaredNameInItem 完全同一条链。一个够格被放行的名字，客户端就必须以那个被授权的
    // 声明名收到它；把畸形拼法原样中继回去，等于让同一个改名在桥接侧生效、在 passthrough
    // 侧只生效一半（放行的是 exec，送出去的是 tools__exec —— 客户端对不上号，又是一条
    // unsupported call / #5095 式污染会话历史）。
    // 两道保险维持原语义：合法声明的名字永远 authorized === name，不会走到改写；repair
    // 失手（候选数不是 1）时 authorized 仍等于畸形输入，同样不会改写，也照样不会把名字
    // 改成第二个猜测。改写结果还必须是 schema-valid 的名字，宁可放行也不发送一个会被上游
    // 按 input[N].name 拒绝的形状。
    // 发射名改写门控：改名只可能发生在三方流量（调用方显式传 true）；官方端点缺省 false 时
    // authorized === normalize 的结果，合法声明的名字永远 authorized === name，改写分支自然不触发。
    const authorized = resolveGuardedEmittedName(name, declared, declaredBare, undefined, allowEmissionRepair);
    if (
      authorized !== name
      && declared.has(authorized)
      && isSchemaValidResponsesToolName(authorized)
    ) return { value: { ...item, name: authorized }, changed: true };
  }
  return { value: item, changed: false };
}

/**
 * Normalizes default-namespaced tool calls in a Responses object's `output` array.
 *
 * @param response - The Responses result object containing `output`.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns An object with the normalized response and a boolean indicating if changes occurred.
 */
export function normalizeDefaultNamespaceInResponse(
  response: unknown,
  declared: ReadonlySet<string>,
  declaredBare?: ReadonlySet<string>,
  allowEmissionRepair?: boolean,
): { value: unknown; changed: boolean } {
  if (!isPlainObject(response) || !Array.isArray(response.output)) {
    return { value: response, changed: false };
  }
  let changed = false;
  const newOutput = response.output.map(item => {
    const res = normalizeDefaultNamespaceInItem(item, declared, declaredBare, allowEmissionRepair);
    if (res.changed) changed = true;
    return res.value;
  });
  if (!changed) return { value: response, changed: false };
  return { value: { ...response, output: newOutput }, changed: true };
}

/**
 * Normalizes default-namespaced tool calls in a Responses SSE payload object.
 *
 * @param payload - The parsed SSE event payload.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns An object with the normalized payload and a boolean indicating if changes occurred.
 */
export function normalizeDefaultNamespaceInPayload(
  payload: unknown,
  declared: ReadonlySet<string>,
  declaredBare?: ReadonlySet<string>,
  allowEmissionRepair?: boolean,
): { value: unknown; changed: boolean } {
  if (!isPlainObject(payload)) return { value: payload, changed: false };
  if (payload.type === "response.output_item.added" || payload.type === "response.output_item.done") {
    const res = normalizeDefaultNamespaceInItem(payload.item, declared, declaredBare, allowEmissionRepair);
    if (!res.changed) return { value: payload, changed: false };
    return { value: { ...payload, item: res.value }, changed: true };
  }
  if (payload.type === "response.function_call_arguments.done" && typeof payload.name === "string") {
    const fakeItem = { type: "function_call", name: payload.name, namespace: payload.namespace };
    const res = normalizeDefaultNamespaceInItem(fakeItem, declared, declaredBare, allowEmissionRepair);
    if (res.changed) {
      const normalizedItem = res.value as Record<string, unknown>;
      const next: Record<string, unknown> = { ...payload, name: normalizedItem.name };
      if ("namespace" in next && !("namespace" in normalizedItem)) {
        delete next.namespace;
      }
      return { value: next, changed: true };
    }
  }
  if (payload.type === "response.completed" || payload.type === "response.incomplete") {
    const res = normalizeDefaultNamespaceInResponse(payload.response, declared, declaredBare, allowEmissionRepair);
    if (!res.changed) return { value: payload, changed: false };
    return { value: { ...payload, response: res.value }, changed: true };
  }
  return { value: payload, changed: false };
}

/**
 * Normalizes default-namespaced tool calls in a raw Responses JSON string.
 *
 * @param jsonText - Raw JSON string representing a Responses object.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns The normalized JSON string, or original text if unchanged or invalid JSON.
 */
export function normalizeDefaultNamespaceInJson(
  jsonText: string,
  declared: ReadonlySet<string>,
  declaredBare?: ReadonlySet<string>,
  allowEmissionRepair?: boolean,
): string {
  try {
    const parsed = JSON.parse(jsonText);
    const normalized = normalizeDefaultNamespaceInResponse(parsed, declared, declaredBare, allowEmissionRepair);
    return normalized.changed ? JSON.stringify(normalized.value) : jsonText;
  } catch {
    return jsonText;
  }
}

function failedBlocks(name: string, newline: string): readonly string[] {
  const failure = {
    type: "upstream_error",
    code: UNDECLARED_TOOL_CALL_ERROR_CODE,
    message: undeclaredToolCallMessage(name),
  };
  const payload = JSON.stringify({
    type: "response.failed",
    response: { status: "failed", error: failure, last_error: failure },
  });
  return [`event: response.failed${newline}data: ${payload}`, "data: [DONE]"];
}

/**
 * Fail closed when a routed provider calls a tool the request never declared (#1700),
 * and normalize provider-invented default namespaces back to declared bare tools (#4176).
 *
 * The bridged paths already refuse such a call (`declaredToolNames` in src/bridge.ts), but the
 * native Responses passthrough relayed it verbatim: Codex received a `function_call` for a tool
 * it has no top-level handler for — `apply_patch`, which under code mode exists only as a nested
 * `tools.apply_patch(...)` helper inside `exec` — and the turn surfaced as a bare `aborted` with
 * no output and no explanation. Replacing the offending event with an explicit `response.failed`
 * turns that silent dead end into a compatibility error naming the tool.
 *
 * Everything after the trip is dropped so a later `response.completed` cannot contradict the
 * terminal already sent. Non-JSON and non-item blocks pass through untouched.
 *
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredNamelessClientCallTypes - Nameless client call types declared by the request.
 * @param providerExecutedCallTypes - Call types executed by the provider.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @param declaredCustom - Current bare custom declarations eligible for code-mode recovery.
 * @returns An SSE block rewrite function.
 */
export function createUndeclaredToolCallGuardBlockRewrite(
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string> = EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
  declaredBare?: ReadonlySet<string>,
  declaredCustom?: ReadonlySet<string>,
  phantomAllowlist?: ReadonlySet<string>,
  // 发射名改写门控：passthrough 的调用方按 thirdPartyEmissionRepair(parsed, route) 传值。
  // 缺省 false —— phantom 本来就只在 shadow 作用域出现（此时 gate 恒 true），授权/发射/快照
  // 三处必须同答案，所以整条 rewrite 共用这一个布尔。
  allowEmissionRepair?: boolean,
): SseBlockRewrite {
  let tripped = false;
  const phantomActive = phantomAllowlist !== undefined && phantomAllowlist.size > 0;
  // Ids of items whose announce event the phantom allowlist dropped; every later block
  // naming them (argument/input deltas, the terminal done event) is dropped with it, and
  // the terminal snapshot has phantom items stripped so a client that reconstructs output
  // from `response.completed` never sees the call either.
  const droppedItemIds = new Set<string>();
  return (block: string) => {
    if (tripped) return [];
    const payload = sseDataPayload(block);
    if (payload === null || payload === "[DONE]") return [block];
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (phantomActive && isPlainObject(parsed)) {
      if (droppedItemIds.size > 0 && referencesDroppedItem(parsed, droppedItemIds)) return [];
      if (parsed.type === "response.completed" || parsed.type === "response.incomplete") {
        // Sparse gateways skip the incremental items entirely, so the terminal snapshot
        // is the only place the phantom call surfaces. Strip every droppable item first;
        // any undeclared NON-droppable item the snapshot still carries below takes the
        // ordinary fail-closed path.
        const stripped = stripDroppableToolCallsInResponse(parsed.response, declared, phantomAllowlist, declaredBare, allowEmissionRepair);
        if (stripped.removed.length > 0) {
          parsed = { ...parsed, response: stripped.response };
          block = replaceSseDataPayload(block, JSON.stringify(parsed));
        }
      } else {
        const verdict = undeclaredToolCallVerdict(parsed, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare, declaredCustom, phantomAllowlist, allowEmissionRepair);
        if (verdict !== undefined && verdict.droppable) {
          if (parsed.type === "response.output_item.added" && isPlainObject(parsed.item) && typeof parsed.item.id === "string") {
            droppedItemIds.add(parsed.item.id);
          }
          return [];
        }
      }
    }
    const name = undeclaredToolCallName(parsed, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare, declaredCustom, undefined, allowEmissionRepair);
    if (name !== undefined) {
      tripped = true;
      return failedBlocks(name, block.includes("\r\n") ? "\r\n" : "\n");
    }
    const normalized = normalizeDefaultNamespaceInPayload(parsed, declared, declaredBare, allowEmissionRepair);
    if (normalized.changed) {
      return [replaceSseDataPayload(block, JSON.stringify(normalized.value))];
    }
    return [block];
  };
}

function referencesDroppedItem(parsed: Record<string, unknown>, droppedItemIds: ReadonlySet<string>): boolean {
  if (typeof parsed.item_id === "string" && droppedItemIds.has(parsed.item_id)) return true;
  const item = parsed.item;
  return isPlainObject(item) && typeof item.id === "string" && droppedItemIds.has(item.id);
}
