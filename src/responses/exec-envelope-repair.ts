// Representation repair for exec freeform tool-call envelope leaks.
//
// Some routed models serialize a call to ANOTHER tool (their own function-call
// or parameter tags) as a JSON-shaped blob and dump it into the freeform `exec`
// tool input. Codex code-mode exec executes JavaScript, and a leading
// `{"quoted-key":` is a guaranteed SyntaxError in every ECMAScript goal symbol
// (a block statement cannot carry a string-literal label), as is a program
// starting with `<parameter`. The client VM therefore rejects the original
// source with an opaque "Unexpected token" that many models cannot act on, and
// the turn silently ends.
//
// Replacing dead-on-arrival source with a directive throw gives the model
// something actionable. Inputs that do not match the envelope shapes pass
// through byte-identical, so genuine JavaScript — including object literals
// mid-program and `{"use strict";` blocks — is never touched.

const EXEC_TOOL_NAME = "exec";
/** `{` immediately followed by a quoted key and a colon: illegal as JS, the leak signature. */
const LEAKED_JSON_ENVELOPE = /^\{\s*['"][^'"\n]{1,200}['"]\s*:/;
/** Program opening on a serialized parameter tag: also never valid JS. */
const LEAKED_PARAMETER_TAG = /^<\/?parameter[\s>=]/i;

const REPAIR_MESSAGE =
  "opencodex envelope repair: exec input was rejected because it looks like a " +
  "serialized tool-call envelope (a JSON object with quoted keys, or an XML " +
  "<parameter> tag), not JavaScript. If you meant to call a different tool, " +
  "emit it as its own declared tool call; exec takes plain JavaScript source " +
  "(e.g. `const r = await tools.some_tool({...}); text(JSON.stringify(r));`).";

/** Whether one unwrapped exec body is guaranteed to crash the client JS VM. */
export function looksLikeExecEnvelopeLeak(unwrapped: string): boolean {
  const head = unwrapped.trimStart();
  return LEAKED_JSON_ENVELOPE.test(head) || LEAKED_PARAMETER_TAG.test(head);
}

/**
 * Repair exec freeform input BEFORE it is relayed to the client.
 *
 * Takes the ALREADY-UNWRAPPED body (the `{input: ...}` function-call wrapper is
 * removed upstream by unwrapFreeformToolInput, so a legitimately wrapped call
 * never reaches this check in wrapper form). Envelope-lookalikes are replaced
 * with a thrown directive; everything else is byte-identical.
 */
export function repairExecEnvelopeLeak(unwrappedBody: string): string {
  if (!looksLikeExecEnvelopeLeak(unwrappedBody)) return unwrappedBody;
  return "throw new Error(" + JSON.stringify(REPAIR_MESSAGE) + ");";
}

export const EXEC_REPAIR_TOOL_NAME = EXEC_TOOL_NAME;

// ---------------------------------------------------------------------------
// Namespace-leak feedback: a routed model that calls the client namespace
// itself (e.g. `tools`, `collaboration`) emitted the container instead of a
// real tool. Dropping that call loses the intent with no learning signal, so
// when a declared freeform exec channel exists we replace the phantom call
// with a directive error the client VM runs: the model receives an explicit
// "use namespace__toolname" instruction as the tool result and can retry in
// form instead of silently continuing without the action it meant to take.
//
// `tools` is the JS sandbox namespace inside exec bodies (tools.exec_command,
// ...), which never appears in the declared tool list; any other name counts
// as a namespace only when a declared tool actually lives under it
// (`collaboration` for `collaboration__update_plan`).
// ---------------------------------------------------------------------------

const SANDBOX_NAMESPACE = "tools";

function isNamespaceLeakName(name: string, declaredToolNames: ReadonlySet<string>): boolean {
  if (name === SANDBOX_NAMESPACE) return true;
  const prefix = name + "__";
  for (const declared of declaredToolNames) {
    if (declared.length > prefix.length && declared.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * When a phantom call is a namespace leak and a declared freeform `exec` exists,
 * build the directive-error body the exec VM should receive, else undefined.
 * The feedback is emitted under the exec name so the client executes it as an
 * ordinary tool call and reports the thrown message back to the model.
 */
export function buildNamespaceLeakFeedback(
  name: string,
  declaredToolNames?: ReadonlySet<string>,
  freeformToolNames?: ReadonlySet<string>,
): string | undefined {
  if (!declaredToolNames || !freeformToolNames) return undefined;
  if (!declaredToolNames.has(EXEC_TOOL_NAME) || !freeformToolNames.has(EXEC_TOOL_NAME)) return undefined;
  if (!isNamespaceLeakName(name, declaredToolNames)) return undefined;
  const message =
    "opencodex namespace-leak repair: \"" + name + "\" is a tool namespace, not a callable tool, " +
    "so the call was intercepted and not executed. Emit the call with the flattened form " +
    name + "__<tool> (for example " + name + "__update_plan), or - if you meant the exec sandbox " +
    "namespace - call the exec tool and put the " + name + ".<tool>(...) expression inside its " +
    "JavaScript input. Retry with the correct form.";
  return "throw new Error(" + JSON.stringify(message) + ");";
}
