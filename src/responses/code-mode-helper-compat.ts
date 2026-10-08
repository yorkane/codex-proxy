import {
  isCompletePatchEnvelope,
  normalizeApplyPatchDelimiters,
  unwrapFreeformToolInput,
} from "./apply-patch-envelope";
import {
  CODE_MODE_HELPER_WIRE_NAMES,
  declaresCodeModeExec,
  isCodeModeMcpDirectName,
  SANDBOX_NAMESPACE_PREFIXES,
} from "../types/tools";
import { parseCodeModeShellInput } from "./code-mode-shell-input";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A nested host tool reachable as `tools.<name>` when the flattened name is one identifier. */
const CODE_MODE_IDENTIFIER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Convert a nested Code Mode helper call into unified-exec JavaScript.
 *
 * Parsed values are serialized as data, never interpolated as source, so command and patch text
 * cannot escape the generated call. Invalid structured helper payloads are also passed as data so
 * nested-tool validation can reject them without evaluating provider text as JavaScript.
 *
 * `wireToolName` is the name the body actually arrived under, which is not always the helper:
 * a provider that got the NAME right and the BODY wrong sends `exec`, and the apply-patch
 * helper is inferred from the payload. Recognition and compilation must read ONE canonical
 * body, so both unwrap under that same name — see the apply-patch branch below. It defaults to
 * the helper name, which is correct for the name-based path where the wire name IS the helper.
 */
export function compileCodeModeHelperInput(
  argumentsText: unknown,
  toolName: string,
  wireToolName?: string,
): string {
  if (typeof argumentsText !== "string") return "";
  const helperName = toolName.startsWith("default.")
    ? toolName.slice("default.".length)
    : toolName;
  if (helperName === "exec_command" && wireToolName === "exec") {
    const args = parseCodeModeShellInput(argumentsText);
    if (args) return `const result = await tools.exec_command(${JSON.stringify(args)});\ntext(result);`;
  }
  if (helperName === "apply_patch") {
    // `resolveCodeModeHelperName` decides this IS an apply-patch call by reading
    // `unwrapFreeformToolInput(argumentsText, wireToolName)`, which strips an outer Markdown
    // fence and accepts that name's fallback fields (#4983). Compiling from a narrower unwrap
    // meant a body accepted through a fence or a fallback field reached `tools.apply_patch`
    // still wrapped, so the host rejected the JSON or the fence instead of applying the patch
    // (#5046). One unwrap, one body, one decision.
    //
    // The vocabulary is the WIRE name rather than the helper name on purpose. `{"patch": ...}`
    // is an apply_patch wrapper and is not an `exec` fallback field, and the recognizer already
    // declines it under `exec`; reading it here would compile a body that recognition rejected,
    // which is exactly the drift a second, looser unwrap introduces.
    const bodyToolName = wireToolName ?? helperName;
    const normalizedBodyToolName = bodyToolName.startsWith("default.")
      ? bodyToolName.slice("default.".length)
      : bodyToolName;
    const patch = normalizeApplyPatchDelimiters(
      unwrapFreeformToolInput(argumentsText, normalizedBodyToolName),
    );
    return `const result = await tools.apply_patch(${JSON.stringify(patch)});\ntext(result);`;
  }
  let parsed: unknown = argumentsText;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    // Keep malformed provider text as data rather than executable source.
  }
  const args: unknown = isPlainObject(parsed) ? { ...parsed } : parsed;
  if (
    helperName === "shell_command"
    && isPlainObject(args)
    && typeof args.command === "string"
    && args.cmd === undefined
  ) {
    args.cmd = args.command;
    delete args.command;
  }
  if (helperName === "write_stdin") {
    return `const result = await tools.write_stdin(${JSON.stringify(args)});\ntext(result);`;
  }
  if (helperName === "view_image") {
    // Codex code-mode `exec` exposes `tools.view_image({path, detail?})`; the host answers
    // with a custom_tool_call_output carrying `input_image`, which `image()` surfaces back
    // to the model. Aliases map onto Codex's `path`/`detail`; anything else is passed as
    // data so nested validation can reject it.
    const viewArgs: unknown = isPlainObject(args) ? { ...args } : args;
    if (isPlainObject(viewArgs)) {
      for (const alias of ["file_path", "file", "image_path"]) {
        if (typeof viewArgs.path !== "string" && typeof viewArgs[alias] === "string") {
          viewArgs.path = viewArgs[alias];
        }
        delete viewArgs[alias];
      }
    }
    return `const result = await tools.view_image(${JSON.stringify(viewArgs)});\nif (result && result.image_url) { image(result.image_url); } else { text(result); }`;
  }
  if (helperName === "create_goal" || helperName === "get_goal" || helperName === "update_goal") {
    return `const result = await tools.${helperName}(${JSON.stringify(args)});\ntext(result);`;
  }
  if (isCodeModeMcpDirectName(helperName)) {
    // Direct `mcp__<server>__<tool>` call under a code-mode catalog: the emitted name IS the
    // nested host tool's name, so compile to the same `tools.<name>(args)` the model could
    // have written. Dot access when the name is a clean identifier (the common case); bracket
    // access otherwise, so a hyphenated server name still addresses the same tool.
    const target = CODE_MODE_IDENTIFIER_NAME.test(helperName)
      ? `tools.${helperName}`
      : `tools[${JSON.stringify(helperName)}]`;
    return `const result = await ${target}(${JSON.stringify(args)});\ntext(result);`;
  }
  return `const result = await tools.exec_command(${JSON.stringify(args)});\ntext(result);`;
}

// exec 沙箱前缀表必须与 src/types/tools.ts 的 SANDBOX_NAMESPACE_PREFIXES 同源。
//
// 名字侧（repairEmittedToolName）与正文侧（这里，经 normalizeCodeModeHelperName）是两次独立解析：
// 桥接在 tool_call_start 上先用改名器把畸形名认成已声明的 exec，再用**原始发射名**推 helper 名
// 决定要不要编译成 await tools.<helper>(...)。两张表各自持字面量时必然漂移——冒号形态先前只
// 加在名字侧，结果名字修好了、helper 解析返回 undefined，shell/patch 正文就以裸 exec JavaScript
// 的形式送给客户端，静默丢掉 wrapper 语义（正是 normalizeCodeModeHelperName 注释警告的失效）。
const HELPER_NAMESPACE_PREFIXES = [
  ...SANDBOX_NAMESPACE_PREFIXES,
  "functions__",
  "functions.",
  "default.",
  "default__",
] as const;

function stripKnownHelperPrefixes(name: string): string {
  let out = name;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of HELPER_NAMESPACE_PREFIXES) {
      if (out.length > prefix.length && out.startsWith(prefix)) {
        out = out.slice(prefix.length);
        changed = true;
      }
    }
  }
  return out;
}

/**
 * The helper a call genuinely belongs to, or undefined when the recorded name names
 * nothing the compiler knows.
 *
 * Call-shape repair rewrites a mis-shaped name (tools=exec) to the declared name, so the
 * ORIGINAL emitted string kept on the call is no longer guaranteed to be a helper: it can
 * be a sandbox-prefixed spelling of exec itself, which is the tool rather than a nested
 * helper. Compiling against such a name silently loses the wrapper semantics -- a patch
 * body would reach exec_command still wrapped as {input: ...} -- so recognition resolves
 * through the prefixes to a member of the known-helper vocabulary and otherwise declines,
 * letting body inference make the call exactly as it does for a plain exec.
 */
export function normalizeCodeModeHelperName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const bare = stripKnownHelperPrefixes(name);
  if (bare === "") return undefined;
  return CODE_MODE_HELPER_WIRE_NAMES.has(bare) || isCodeModeMcpDirectName(bare) ? bare : undefined;
}

/**
 * Resolve the effective code-mode helper for one freeform call.
 *
 * `codeModeHelperName` already covers the NAME-based case: a provider emitted
 * `apply_patch` under a declared `exec` catalog, so `normalizeDeclaredToolName` rewrote
 * the name and recorded the original. That decision happens at tool-call start, before
 * any arguments exist, so it cannot see a provider that got the NAME right and the BODY
 * wrong.
 *
 * This adds that second case: the name is already `exec` so nothing was rewritten, but
 * the body is a complete patch envelope or an unambiguous structured shell call.
 * Same inference the name-based path makes, drawn from the payload.
 *
 * Returns undefined for everything else, including JavaScript that merely mentions a
 * patch envelope — that body is a real program and is forwarded byte-identical.
 */
export function resolveCodeModeHelperName(
  codeModeHelperName: string | undefined,
  toolName: string,
  argumentsText: unknown,
  namespace?: string,
  declaredNames?: ReadonlySet<string>,
): string | undefined {
  const declaredHelper = normalizeCodeModeHelperName(codeModeHelperName);
  if (declaredHelper) return declaredHelper;
  if (toolName !== "exec" || namespace !== undefined) return undefined;
  // `exec` is a name, not a guarantee. Without a catalog that is genuinely code mode, a
  // caller-defined `exec` could legitimately take patch text, and handing it generated
  // `tools.apply_patch(...)` JavaScript would be the mis-route this repair exists to avoid.
  if (!declaresCodeModeExec(declaredNames)) return undefined;
  if (typeof argumentsText !== "string" || argumentsText === "") return undefined;
  if (isCompletePatchEnvelope(unwrapFreeformToolInput(argumentsText, "exec"))) return "apply_patch";
  return parseCodeModeShellInput(argumentsText) ? "exec_command" : undefined;
}
