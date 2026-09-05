/**
 * Emitted-call guard: the unified verdict layer that replaced the four
 * separately-patched wrong-name symptoms (shape repair, namespace leak,
 * phantom drop, fail-closed). These tests pin the ORDER between the layers,
 * because that order is the whole point of merging them: a repairable name must
 * never be dropped, and a namespace leak must never be silently discarded.
 */
import { describe, expect, test } from 'bun:test';
import { resolveEmittedCall } from '../src/responses/emitted-call-guard';

const collab = new Set(['collaboration__spawn_agent', 'collaboration__update_plan', 'exec', 'web__run']);
const freeform = new Set(['exec']);

describe('resolveEmittedCall layer order', () => {
  test('a declared name passes through untouched', () => {
    const v = resolveEmittedCall('exec', { declaredToolNames: collab });
    expect(v).toEqual({ kind: 'allow', name: 'exec', repaired: false });
  });

  test('shape repair wins over the phantom drop', () => {
    // The repairable name is also on the allowlist, which must not matter:
    // a name that maps back to a real tool is relayed, never discarded.
    const v = resolveEmittedCall('spawn_agent', {
      declaredToolNames: collab,
      freeformToolNames: freeform,
      phantomNames: new Set(['spawn_agent', 'collaboration__spawn_agent']),
    });
    expect(v).toEqual({ kind: 'allow', name: 'collaboration__spawn_agent', repaired: true });
  });

  test('sandbox-prefixed composition is repaired to the declared tool', () => {
    const v = resolveEmittedCall('tools__web_run', { declaredToolNames: collab });
    expect(v).toEqual({ kind: 'allow', name: 'web__run', repaired: true });
  });

  test('a namespace container becomes directive feedback, not a drop', () => {
    const v = resolveEmittedCall('tools', {
      declaredToolNames: collab,
      freeformToolNames: freeform,
      phantomNames: new Set(['tools']),
    });
    expect(v.kind).toBe('feedback');
    if (v.kind !== 'feedback') return;
    expect(v.input).toContain('namespace-leak repair');
    expect(v.input).toContain('throw new Error');
  });

  test('a namespace leak without an exec channel falls back to dropping', () => {
    // No freeform exec declared: there is nowhere to deliver the correction,
    // so the call is removed rather than relayed as an undeclared tool.
    const v = resolveEmittedCall('tools', {
      declaredToolNames: collab,
      phantomNames: new Set(['tools']),
    });
    expect(v.kind).toBe('drop');
  });

  test('a known phantom with no repair and no leak is dropped', () => {
    const v = resolveEmittedCall('web_search', {
      declaredToolNames: collab,
      freeformToolNames: freeform,
      phantomNames: new Set(['web_search']),
    });
    expect(v).toEqual({ kind: 'drop', name: 'web_search' });
  });

  test('an unknown name is dropped so the caller fails closed', () => {
    const v = resolveEmittedCall('hallucinated_tool', { declaredToolNames: collab });
    expect(v).toEqual({ kind: 'drop', name: 'hallucinated_tool' });
  });

  test('no catalog means no enforcement', () => {
    expect(resolveEmittedCall('anything')).toEqual({ kind: 'allow', name: 'anything', repaired: false });
    expect(resolveEmittedCall('anything', { declaredToolNames: new Set() })).toEqual({
      kind: 'allow', name: 'anything', repaired: false,
    });
  });
});

describe('resolveEmittedCall observability', () => {
  test('every layer reports a decision without changing the verdict', () => {
    const seen: string[] = [];
    const track = (name: string, opts = {}) => resolveEmittedCall(name, {
      declaredToolNames: collab,
      freeformToolNames: freeform,
      phantomNames: new Set(['tools', 'web_search']),
      onDecision: (info) => seen.push(info.decision),
      ...opts,
    });
    track('exec');
    track('spawn_agent');
    track('tools');
    track('web_search');
    track('nonsense');
    expect(seen).toEqual(['declared', 'repaired', 'namespace-leak', 'phantom-drop', 'undeclared']);
  });

  test('a name that is both ambiguous and allowlisted is never guessed', () => {
    // Two declared tools share the bare suffix: repair must abstain, and the
    // allowlist entry must not smuggle an ambiguous call through as a drop.
    const two = new Set(['collaboration__update_plan', 'other__update_plan', 'exec']);
    const v = resolveEmittedCall('update_plan', {
      declaredToolNames: two,
      freeformToolNames: freeform,
      phantomNames: new Set(['update_plan']),
    });
    expect(v.kind).toBe('drop');
    expect(v.name).toBe('update_plan');
  });
});
