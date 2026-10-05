/**
 * A legal apply_patch envelope must never be rewritten by the exec envelope-leak repair.
 *
 * The leak repair exists for one symptom: a model dumps a serialized tool-call envelope
 * (quoted-key JSON, or an XML parameter tag) into the freeform `exec` body, which is
 * dead-on-arrival JavaScript in the client VM. A genuine patch is a different thing
 * entirely, and the two boundaries must not collide -- if the repair ever claimed a legal
 * patch body, the model would receive a directive error instead of its own patch and the
 * edit would silently not happen.
 *
 * Locks the pairing between the two boundaries: code-mode recognition claims complete patch
 * envelopes BEFORE the leak repair can see them (bridge/sse.ts, bridge/response-json.ts),
 * and every form the repair does see -- because recognition legitimately declined it --
 * is forwarded byte-identical.
 */
import { describe, expect, test } from "bun:test";
import { looksLikeExecEnvelopeLeak, repairExecEnvelopeLeak } from "../../src/responses/exec-envelope-repair";
import { repairFreeformToolInput } from "../../src/responses/apply-patch-envelope";
import { compileCodeModeHelperInput, resolveCodeModeHelperName } from "../../src/responses/code-mode-helper-compat";

const PATCH = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch";
const CODE_MODE = new Set(["exec"]);
const FENCE = String.fromCharCode(96, 96, 96);

function wrap(key: string, value: string): string {
  const body: Record<string, string> = {};
  body[key] = value;
  return JSON.stringify(body);
}

/** Exactly what both bridges do: recognize first, and only reach the repair on a decline. */
function bridgeFreeformInput(args: string, toolName = "exec", namespace?: string, declared?: ReadonlySet<string>) {
  const helper = resolveCodeModeHelperName(undefined, toolName, args, namespace, declared);
  if (helper) return { claimed: helper, out: compileCodeModeHelperInput(args, helper, toolName) };
  const unwrapped = repairFreeformToolInput(args, toolName, namespace);
  return {
    claimed: undefined,
    out: (namespace === undefined || namespace === "functions") && toolName === "exec"
      ? repairExecEnvelopeLeak(unwrapped)
      : unwrapped,
  };
}

/**
 * The compiled call must carry the patch verbatim (modulo the trailing newline the
 * envelope regex legitimately keeps, which no patch parser cares about).
 */
function compilesToRawPatch(result: { claimed?: string; out: string }): boolean {
  if (result.claimed !== "apply_patch") return false;
  const match = /^const result = await tools\.apply_patch\((.*)\);\ntext\(result\);$/.exec(result.out);
  if (!match) return false;
  return JSON.parse(match[1]).replace(/\n+$/, "") === PATCH;
}

describe("legal patch envelopes survive the exec envelope-leak repair", () => {
  test("every wrapper field that recognition accepts compiles to the raw patch", () => {
    // If a key is added to FREEFORM_FALLBACK_KEYS.exec and not here, the two drifted.
    for (const key of ["input", "code", "script", "js", "javascript", "command", "cmd", "content"]) {
      expect(compilesToRawPatch(bridgeFreeformInput(wrap(key, PATCH), "exec", undefined, CODE_MODE))).toBe(true);
    }
  });

  test("bare, trailing-newline, and fenced patch forms compile to the raw patch", () => {
    expect(compilesToRawPatch(bridgeFreeformInput(PATCH, "exec", undefined, CODE_MODE))).toBe(true);
    expect(compilesToRawPatch(bridgeFreeformInput(PATCH + "\n", "exec", undefined, CODE_MODE))).toBe(true);
    expect(compilesToRawPatch(bridgeFreeformInput(FENCE + "\n" + PATCH + "\n" + FENCE, "exec", undefined, CODE_MODE))).toBe(true);
  });

  test("patch bodies recognition declines are forwarded byte-identical, never thrown at", () => {
    // No code-mode catalog -> recognition stands down, and a bare `*** Begin Patch` line is
    // not one of the two leak signatures, so the body keeps its byte-exact form.
    const noCatalog = new Set(["exec", "shell_command"]);
    expect(bridgeFreeformInput(PATCH, "exec", undefined, noCatalog)).toEqual({ claimed: undefined, out: PATCH });
    expect(bridgeFreeformInput(wrap("input", PATCH), "exec", undefined, noCatalog)).toEqual({ claimed: undefined, out: PATCH });
    // A remote namespace owns its grammar, so the repair is not even consulted.
    expect(bridgeFreeformInput(PATCH, "exec", "mcp", CODE_MODE)).toEqual({ claimed: undefined, out: PATCH });
  });

  test("the detector itself never flags a patch envelope or patch-bearing JavaScript", () => {
    expect(looksLikeExecEnvelopeLeak(PATCH)).toBe(false);
    expect(repairExecEnvelopeLeak(PATCH)).toBe(PATCH);
    const jsMentionsEnvelope = 'const s = "' + PATCH.replace(/\n/g, "\\n") + '"; text(s);';
    expect(looksLikeExecEnvelopeLeak(jsMentionsEnvelope)).toBe(false);
    expect(repairExecEnvelopeLeak(jsMentionsEnvelope)).toBe(jsMentionsEnvelope);
  });

  test("genuine leaked envelopes are still caught after these exemptions", () => {
    // The exemptions above must not widen the repair: a quoted-key object naming another
    // tool's fields, and a program opening on a parameter tag, both stay dead-on-arrival.
    const leaked = wrap("update_plan", "");
    expect(looksLikeExecEnvelopeLeak(leaked)).toBe(true);
    expect(repairExecEnvelopeLeak(leaked)).toContain("opencodex envelope repair");
    const tag = String.fromCharCode(60) + "parameter" + String.fromCharCode(62) + " name=x";
    expect(looksLikeExecEnvelopeLeak(tag)).toBe(true);
    expect(repairExecEnvelopeLeak(tag)).toContain("opencodex envelope repair");
    expect(bridgeFreeformInput(leaked, "exec", undefined, CODE_MODE).out).toContain("opencodex envelope repair");
  });
});
