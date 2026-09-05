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
