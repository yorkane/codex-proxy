/**
 * Schema-bound repair for tool-call arguments the Codex client would otherwise reject.
 *
 * The client validates function-call arguments against its own Rust structs and a parse
 * failure is a TERMINAL outcome: the whole turn ends, not just the call. Two model
 * spellings reach that terminal constantly on this fleet (10-day client-log counts):
 *
 *   167x  invalid type: string "240000", expected u64      -- numbers quoted as strings
 *          ({"yield_time_ms":"10000"} where the schema declares integer/number)
 *    70x  missing field `cmd` at line 1 column N           -- exec_command given
 *          {"command": "..."} instead of {"cmd": "..."}. The code-mode helper compiler
 *          (code-mode-helper-compat) and the passthrough input-wrapper repair
 *          (function-call-compat) each cover a DIFFERENT shape; a direct function_call
 *          to a bare exec_command with a command-keyed body is reached by neither.
 *
 * The intent boundary matches src/lib/tool-argument-integers.ts (#1611/#1938): repair only
 * what has exactly one faithful reading, leave every genuine disagreement to fail as it
 * does today.
 *   - a string is converted to a number only when the schema node accepts a numeric type
 *     and does NOT also accept string (a union keeps the string legal, so it stays);
 *   - only a fully-numeric literal (no whitespace, no plus sign), and only a value whose
 *     serialization round-trips what the text already meant;
 *   - booleans, objects, arrays, and any other string never change;
 *   - the alias never overwrites an existing cmd, never invents one, and only fires for
 *     the exact bare exec_command declaration whose schema itself demands a string cmd.
 */
import { coerceIntegerToolArguments } from "../lib/tool-argument-integers";

/** JSON Schema subset we need; provider tool schemas are untrusted input. */
type SchemaNode = Record<string, unknown>;

function asSchema(value: unknown): SchemaNode | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as SchemaNode
    : undefined;
}

function typeList(schema: SchemaNode): unknown[] {
  const type = schema.type;
  if (Array.isArray(type)) return type;
  return typeof type === "string" ? [type] : [];
}

const COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"] as const;

function compositionBranches(schema: SchemaNode): SchemaNode[] {
  const branches: SchemaNode[] = [];
  for (const key of COMPOSITION_KEYS) {
    const value = schema[key];
    if (!Array.isArray(value)) continue;
    for (const branch of value) {
      const node = asSchema(branch);
      if (node) branches.push(node);
    }
  }
  return branches;
}

/** Local `#/$defs/...` refs only: an unfetchable remote ref must leave values alone. */
function resolveRef(schema: SchemaNode, root: SchemaNode, seen: Set<string>): SchemaNode | undefined {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  if (seen.has(ref)) return undefined;
  seen.add(ref);
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    const current = asSchema(node);
    if (!current) return undefined;
    node = current[segment];
  }
  const resolved = asSchema(node);
  return resolved ? resolveRef(resolved, root, seen) : undefined;
}

/** The types the node itself declares, counting composition branches. */
function declaredTypes(node: SchemaNode | undefined): Set<string> {
  const types = new Set<string>();
  if (!node) return types;
  for (const entry of typeList(node)) if (typeof entry === "string") types.add(entry);
  for (const branch of compositionBranches(node)) {
    for (const entry of typeList(branch)) if (typeof entry === "string") types.add(entry);
  }
  return types;
}

// JSON number grammar, split so an integer-declared field cannot accept a fractional or
// exponent spelling through the loose path (those are genuine disagreements and stay).
const INTEGER_LITERAL = /^-?(?:0|[1-9][0-9]*)$/;
const NUMBER_LITERAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/**
 * Convert only what has one faithful reading. Returns undefined when the value must stay.
 *
 * An integer-declared field additionally refuses any text carrying a fraction or exponent
 * marker: "10000.0" as a STRING stays a string even though the real number 10000.0 is
    repaired by the sibling module. A quoted value has no representation-artifact excuse --
    the model wrote quotes deliberately, and which side of the boundary it meant is exactly
    the disagreement that must still fail.
 */
function numericReading(text: string, integerOnly: boolean): number | undefined {
  if (text.length === 0) return undefined;
  // Leading + and leading zeros are not JSON number syntax, however lenient JS's Number()
  // is about them; an integer-declared field additionally refuses any text carrying a
  // fraction or exponent marker, so "1.5" never becomes 1 or 1.5 under an integer type.
  const strict = !text.startsWith("+") && !/^0[0-9]/.test(text)
    && !(integerOnly && /[.eE]/.test(text));
  if (!strict) return undefined;
  const ok = integerOnly ? INTEGER_LITERAL.test(text) : NUMBER_LITERAL.test(text);
  if (!ok) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) return undefined;
  // Round-trip guard: "10000000000000000000001" parses to a value whose serialization
  // differs from the text; keeping the string is the only faithful option.
  if (String(value) !== text) return undefined;
  return value;
}

interface WalkResult {
  value: unknown;
  changed: boolean;
  repairs: number;
}

function walkValue(
  value: unknown,
  schema: SchemaNode | undefined,
  root: SchemaNode,
  depth: number,
): WalkResult {
  if (depth > 64) return { value, changed: false, repairs: 0 };
  const resolved = schema ? resolveRef(schema, root, new Set()) : undefined;

  if (typeof value === "string") {
    if (!resolved) return { value, changed: false, repairs: 0 };
    const types = declaredTypes(resolved);
    const numeric = types.has("integer") || types.has("number");
    // A union that also names string keeps the raw value schema-valid; rewriting it
    // would be a guess about which leg the client will actually parse with.
    if (!numeric || types.has("string")) return { value, changed: false, repairs: 0 };
    const reading = numericReading(value, types.has("integer") && !types.has("number"));
    if (reading === undefined) return { value, changed: false, repairs: 0 };
    return { value: reading, changed: true, repairs: 1 };
  }

  if (Array.isArray(value)) {
    const itemSchema = resolved ? asSchema(resolved.items) : undefined;
    let changed = false;
    let repairs = 0;
    const next = value.map(entry => {
      const result = walkValue(entry, itemSchema, root, depth + 1);
      if (result.changed) changed = true;
      repairs += result.repairs;
      return result.value;
    });
    return changed ? { value: next, changed, repairs } : { value, changed: false, repairs: 0 };
  }

  const object = asSchema(value);
  if (!object) return { value, changed: false, repairs: 0 };

  const properties = resolved ? asSchema(resolved.properties) : undefined;
  const additional = resolved ? asSchema(resolved.additionalProperties) : undefined;
  let changed = false;
  let repairs = 0;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    const childSchema = asSchema(properties?.[key]) ?? additional;
    const result = walkValue(entry, childSchema, root, depth + 1);
    if (result.changed) changed = true;
    repairs += result.repairs;
    next[key] = result.value;
  }
  return changed ? { value: next, changed, repairs } : { value, changed: false, repairs: 0 };
}

/**
 * exec_command direct-call alias, gated by the request's own declaration.
 *
 * The client declares cmd:string (required). A body carrying command (and no cmd) has
 * exactly one faithful reading when that declaration is present; anything less — a
 * third-party tool that merely shares the name, a schema where command is also a declared
 * property — keeps its own contract and stays untouched.
 */
function repairExecCommandAlias(
  parsed: Record<string, unknown>,
  parameters: SchemaNode,
): Record<string, unknown> | undefined {
  const properties = asSchema(parameters.properties);
  const cmdNode = asSchema(properties?.cmd);
  if (parameters.type !== "object" || !cmdNode || cmdNode.type !== "string") return undefined;
  if (!Array.isArray(parameters.required) || !parameters.required.includes("cmd")) return undefined;
  if (Object.hasOwn(parsed, "cmd")) return undefined;
  const command = parsed.command;
  if (typeof command !== "string" || command === "") return undefined;
  const next: Record<string, unknown> = { ...parsed, cmd: command };
  // A schema that does not declare command would reject the leftover as an unknown field.
  if (!properties || !Object.hasOwn(properties, "command")) delete next.command;
  return next;
}

export interface ToolArgumentRepairOutcome {
  /** The arguments text to relay — the original bytes unless something was repaired. */
  value: string;
  /** Count of quoted-number conversions applied this call (observability only). */
  numericRepairs: number;
  /** True when the exec_command command->cmd alias fired this call. */
  aliasRepaired: boolean;
}

/**
 * Repair one completed tool-call arguments string against the declared schema. Replaces the
 * direct coerceIntegerToolArguments call at the bridge/encoder sites: the integral-float
 * pass keeps running first, so #1611/#1938 semantics are byte-identical for unaffected calls.
 */
export function repairToolCallArguments(
  args: string,
  parameters: Record<string, unknown> | undefined,
  toolName?: string,
  namespace?: string,
): ToolArgumentRepairOutcome {
  const integerRepaired = coerceIntegerToolArguments(
    args,
    parameters,
    namespace === undefined ? toolName : undefined,
  );
  if (!parameters || !integerRepaired) {
    return { value: integerRepaired, numericRepairs: 0, aliasRepaired: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(integerRepaired);
  } catch {
    return { value: integerRepaired, numericRepairs: 0, aliasRepaired: false };
  }
  const root = parameters as SchemaNode;
  let value = parsed;
  let changed = integerRepaired !== args;
  let numericRepairs = 0;
  let aliasRepaired = false;

  const walked = walkValue(value, root, root, 0);
  if (walked.changed) {
    value = walked.value;
    changed = true;
    numericRepairs += walked.repairs;
  }

  const object = asSchema(value);
  if (object && namespace === undefined && toolName === "exec_command") {
    const aliased = repairExecCommandAlias(object, root);
    if (aliased) {
      value = aliased;
      changed = true;
      aliasRepaired = true;
    }
  }

  if (!changed) return { value: integerRepaired, numericRepairs: 0, aliasRepaired: false };
  return { value: JSON.stringify(value), numericRepairs, aliasRepaired };
}
