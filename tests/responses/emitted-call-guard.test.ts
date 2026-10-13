/**
 * Emitted-call guard: the unified verdict layer that replaced the four
 * separately-patched wrong-name symptoms (shape repair, namespace leak,
 * phantom drop, fail-closed). These tests pin the ORDER between the layers,
 * because that order is the whole point of merging them: a repairable name must
 * never be dropped, and a namespace leak must never be silently discarded.
 */
import { describe, expect, test } from 'bun:test';
import {
  droppedEmitDisposition,
  isDroppedNamespaceContainer,
  preflightEmittedCall,
  resolveEmittedCall,
} from '../../src/responses/emitted-call-guard';

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
      // 三方作用域：改名只发生在三方路由（本文件锁的是 repair 层本身）。
      servingRouteIsThirdParty: true,
    });
    expect(v).toEqual({ kind: 'allow', name: 'collaboration__spawn_agent', repaired: true });
  });
  test('a code-mode helper echo is repaired to exec before the phantom list is consulted', () => {
    // Upstream #5495 made the goal helpers part of the code-mode echo vocabulary, so with
    // exec declared these names relay as exec even when an operator kept them allowlisted.
    for (const helper of ['update_goal', 'create_goal', 'get_goal']) {
      expect(resolveEmittedCall(helper, {
        declaredToolNames: new Set(['exec', 'web__run']),
        freeformToolNames: freeform,
        phantomNames: new Set([helper]),
        servingRouteIsThirdParty: true,
      })).toEqual({ kind: 'allow', name: 'exec', repaired: true });
    }
  });

  test('sandbox-prefixed composition is repaired to the declared tool', () => {
    const v = resolveEmittedCall('tools__web_run', { declaredToolNames: collab, servingRouteIsThirdParty: true });
    expect(v).toEqual({ kind: 'allow', name: 'web__run', repaired: true });
  });

  test('a namespace container becomes directive feedback, and pays for it', () => {
    // The container directive is a synthetic throw like any other, so it draws on the
    // same per-request budget: a model looped on a container name must not mint an
    // unlimited number of directive items (the observed production failure shape).
    const budget = { remaining: 1 };
    const v = resolveEmittedCall('tools', {
      declaredToolNames: collab,
      freeformToolNames: freeform,
      phantomNames: new Set(['tools']),
      undeclaredFeedback: budget,
    });
    expect(v.kind).toBe('feedback');
    if (v.kind !== 'feedback') return;
    expect(v.input).toContain('namespace-leak repair');
    expect(v.input).toContain('throw new Error');
    expect(budget.remaining).toBe(0);
    // Spent: the container falls back to the drop it had before directives existed.
    expect(resolveEmittedCall('tools', {
      declaredToolNames: collab,
      freeformToolNames: freeform,
      phantomNames: new Set(['tools']),
      undeclaredFeedback: budget,
    })).toEqual({ kind: 'drop', name: 'tools' });
  });

  test('a namespace container with no budget at all drops, as it did pre-directive', () => {
    expect(resolveEmittedCall('tools', {
      declaredToolNames: collab,
      freeformToolNames: freeform,
      phantomNames: new Set(['tools']),
    })).toEqual({ kind: 'drop', name: 'tools' });
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
      servingRouteIsThirdParty: true,
      // Budget present: the container layer only reports namespace-leak when it can
      // actually answer with a directive, which now costs one unit.
      undeclaredFeedback: { remaining: 5 },
      ...opts,
    });
    track('exec');
    track('spawn_agent');
    track('tools');
    track('web_search');
    track('nonsense');
    // With a budget the two rejected names are answered with directives (each consuming
    // one unit) instead of the silent drop / fail-closed pair: the allowlisted phantom and
    // the fresh hallucination both report undeclared-feedback, the container reports
    // namespace-leak. The budget-less twin of this sequence is the layer-order block above.
    expect(seen).toEqual(['declared', 'repaired', 'namespace-leak', 'undeclared-feedback', 'undeclared-feedback']);
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

describe('resolveEmittedCall undeclared correction feedback (budget)', () => {
  const withExec = new Set(['exec', 'web__run', 'collaboration__update_plan']);
  const freeform = new Set(['exec']);

  test('an allowlisted phantom with budget becomes directive feedback', () => {
    const budget = { remaining: 2 };
    // web_search: neither a declared name nor a bare form of one nor a code-mode helper
    // echo, so shape repair cannot rescue it and the feedback layer is what answers.
    const v = resolveEmittedCall('web_search', {
      declaredToolNames: withExec,
      freeformToolNames: freeform,
      phantomNames: new Set(['web_search']),
      undeclaredFeedback: budget,
    });
    expect(v.kind).toBe('feedback');
    if (v.kind !== 'feedback') return;
    expect(v.reason).toBe('undeclared');
    expect(v.input).toContain('undeclared-tool repair');
    expect(v.input).toContain('web_search');
    expect(v.input).toContain('collaboration__update_plan');
    expect(budget.remaining).toBe(1);
  });

  test('a fresh hallucination with budget is corrected instead of failing closed', () => {
    const budget = { remaining: 1 };
    const v = resolveEmittedCall('totally_made_up', {
      declaredToolNames: withExec,
      freeformToolNames: freeform,
      undeclaredFeedback: budget,
    });
    expect(v.kind).toBe('feedback');
    if (v.kind !== 'feedback') return;
    expect(v.input).toContain('totally_made_up');
    expect(budget.remaining).toBe(0);
    const again = resolveEmittedCall('totally_made_up', {
      declaredToolNames: withExec,
      freeformToolNames: freeform,
      undeclaredFeedback: budget,
    });
    expect(again).toEqual({ kind: 'drop', name: 'totally_made_up' });
  });

  test('without an exec channel no budget is spent and old verdicts stand', () => {
    const budget = { remaining: 2 };
    const opts = {
      declaredToolNames: new Set(['web__run']),
      freeformToolNames: new Set<string>(),
      phantomNames: new Set(['update_plan']),
      undeclaredFeedback: budget,
    };
    expect(resolveEmittedCall('update_plan', opts)).toEqual({ kind: 'drop', name: 'update_plan' });
    expect(budget.remaining).toBe(2);
  });

  test('no budget object keeps the historical drop/fail-closed split', () => {
    const v = resolveEmittedCall('web_search', {
      declaredToolNames: withExec,
      freeformToolNames: freeform,
      phantomNames: new Set(['web_search']),
    });
    expect(v).toEqual({ kind: 'drop', name: 'web_search' });
  });

  test('the suggestion names the closest declared tool for a near-miss', () => {
    const v = resolveEmittedCall('collaboration__update_plna', {
      declaredToolNames: withExec,
      freeformToolNames: freeform,
      undeclaredFeedback: { remaining: 1 },
    });
    expect(v.kind).toBe('feedback');
    if (v.kind !== 'feedback') return;
    // The directive rides inside a thrown string literal, so its quotes are escaped.
    expect(v.input).toContain('closest declared tool is \\"collaboration__update_plan\\"');
  });
});

describe('canonical container lookup (third-party only)', () => {
  const zw = '\u200b';
  const fullwidthEq = '\uff1d';

  test('a misspelled container on a direct route is answered and pays for it', () => {
    // Layer order is unchanged by the widening: a name the phantom list does not carry is
    // answered by the fresh-undeclared directive (the catalog listing), drawing on the same
    // budget. The canonical container reading is what happens WITHOUT a payable directive -
    // the bridge's container tier (drop + continue, namespace-container telemetry) instead
    // of the 502 cliff - pinned at the disposition layer below.
    for (const name of ['TOOLS', 'Tools', 'tools' + zw, 'to' + zw + 'ols', 'COLLABORATION']) {
      const budget = { remaining: 2 };
      const v = resolveEmittedCall(name, {
        declaredToolNames: collab,
        freeformToolNames: freeform,
        servingRouteIsThirdParty: true,
        undeclaredFeedback: budget,
      });
      expect(v.kind).toBe('feedback');
      if (v.kind !== 'feedback') continue;
      expect(v.reason).toBe('undeclared');
      expect(v.input).toContain('undeclared-tool repair');
      expect(budget.remaining).toBe(1);
    }
  });

  test('a listed container keeps the namespace tier, and pays for it', () => {
    // The shadow phantom list is matched raw (it records what the model emitted); a listed
    // container answers with the flattened-form directive, now budget-charged like any
    // other synthetic throw.
    const budget = { remaining: 2 };
    const v = resolveEmittedCall('tools', {
      declaredToolNames: collab,
      freeformToolNames: freeform,
      phantomNames: new Set(['tools']),
      servingRouteIsThirdParty: true,
      undeclaredFeedback: budget,
    });
    expect(v.kind).toBe('feedback');
    if (v.kind !== 'feedback') return;
    expect(v.reason).toBe('namespace-leak');
    expect(v.input).toContain('namespace-leak repair');
    expect(budget.remaining).toBe(1);
  });

  test('the official gate keeps the raw comparison byte-for-byte', () => {
    // gate=false must answer exactly as v2.82.0 does: TOOLS is not a container there, so the
    // emission lands on the undeclared path, never on the container directive.
    const v = resolveEmittedCall('TOOLS', {
      declaredToolNames: collab,
      freeformToolNames: freeform,
      servingRouteIsThirdParty: false,
      undeclaredFeedback: { remaining: 2 },
    });
    expect(v.kind).toBe('feedback');
    if (v.kind === 'feedback') expect(v.reason).toBe('undeclared');
    expect(isDroppedNamespaceContainer('TOOLS', collab)).toBe(false);
    expect(isDroppedNamespaceContainer('TOOLS', collab, true)).toBe(true);
  });

  test('canonicalization never releases a name and never outranks a declared tool', () => {
    // A catalog that declares TOOLS refutes the container reading, and the call is relayed.
    const declaredTools = new Set(['TOOLS', 'exec']);
    expect(isDroppedNamespaceContainer('TOOLS', declaredTools, true)).toBe(false);
    expect(resolveEmittedCall('TOOLS', {
      declaredToolNames: declaredTools,
      freeformToolNames: freeform,
      servingRouteIsThirdParty: true,
      undeclaredFeedback: { remaining: 1 },
    })).toEqual({ kind: 'allow', name: 'TOOLS', repaired: false });
    // A sandbox-prefixed assignment name is NOT a bare container: it is a name repair target,
    // and the canonical container check must not swallow it into the container tier.
    expect(isDroppedNamespaceContainer('tools' + fullwidthEq + 'exec_command', collab, true)).toBe(false);
  });

  test('a canonical container with no budget drops under its folded name', () => {
    // The drop CARRIES the canonical spelling, so every consumer's raw container check - the
    // bridge tier and the telemetry label - sees a container, and the turn survives on drop
    // + continue instead of relaunching the 502 cliff. No consumer has to widen its table.
    const v = resolveEmittedCall('TOOLS', {
      declaredToolNames: collab,
      freeformToolNames: freeform,
      servingRouteIsThirdParty: true,
    });
    expect(v).toEqual({ kind: 'drop', name: 'tools' });
    expect(droppedEmitDisposition(v.name, 'TOOLS', collab)).toBe('namespace-container');
    // A raw miss that is not a container under any fold keeps its old label.
    expect(droppedEmitDisposition('update_plan', 'update_plan', collab)).toBe('phantom');
    // Official routes get the raw rule only: TOOLS is not a container there, so the drop
    // carries the emission unchanged and the name lands on the fail-closed path.
    expect(resolveEmittedCall('TOOLS', {
      declaredToolNames: collab,
      freeformToolNames: freeform,
      servingRouteIsThirdParty: false,
    })).toEqual({ kind: 'drop', name: 'TOOLS' });
  });
});

describe('preflightEmittedCall agrees with the bridge', () => {
  const phantoms = new Set(['update_plan']);

  test('the preflight passes every emission the bridge would not fail closed', () => {
    const opts = (budget?: { remaining: number }) => ({
      declaredToolNames: collab,
      enforceDeclaredToolNames: true,
      freeformToolNames: freeform,
      phantomNames: phantoms,
      servingRouteIsThirdParty: true,
      ...(budget ? { undeclaredFeedback: budget } : {}),
    });
    // Repaired, declared, container-with-budget, allowlisted phantom, and a container with no
    // budget left (the bridge drops it and continues) all keep the attempt alive.
    expect(preflightEmittedCall('spawn_agent', opts())).toEqual({ action: 'pass' });
    expect(preflightEmittedCall('exec', opts())).toEqual({ action: 'pass' });
    expect(preflightEmittedCall('tools', opts({ remaining: 1 }))).toEqual({ action: 'pass' });
    expect(preflightEmittedCall('tools', opts())).toEqual({ action: 'pass' });
    expect(preflightEmittedCall('update_plan', opts())).toEqual({ action: 'pass' });
    // A fresh hallucination is only survivable while the budget can pay for its directive.
    expect(preflightEmittedCall('totally_made_up', opts({ remaining: 1 }))).toEqual({ action: 'pass' });
    expect(preflightEmittedCall('totally_made_up', opts())).toEqual({ action: 'reject', name: 'totally_made_up' });
  });

  test('the preflight is a pure query: it clones the budget and reports nothing', () => {
    const budget = { remaining: 1 };
    const seen: string[] = [];
    const opts = {
      declaredToolNames: collab,
      enforceDeclaredToolNames: true,
      freeformToolNames: freeform,
      phantomNames: phantoms,
      servingRouteIsThirdParty: true,
      undeclaredFeedback: budget,
      onDecision: (info: { decision: string }) => seen.push(info.decision),
    };
    expect(preflightEmittedCall('tools', opts)).toEqual({ action: 'pass' });
    expect(preflightEmittedCall('totally_made_up', opts)).toEqual({ action: 'pass' });
    expect(budget.remaining).toBe(1);
    expect(seen).toEqual([]);
    // The bridge spends exactly one unit for the directive the preflight waved through.
    expect(resolveEmittedCall('tools', opts).kind).toBe('feedback');
    expect(budget.remaining).toBe(0);
  });

  test('the official gate and the deferred wire keep their own answers', () => {
    // Official enforcing route: a container is fail-closed for the bridge, so the preflight
    // rejects it too - that pair is the byte-identical v2.82.0 behaviour.
    const official = {
      declaredToolNames: collab,
      enforceDeclaredToolNames: true,
      freeformToolNames: freeform,
      servingRouteIsThirdParty: false,
    };
    expect(preflightEmittedCall('tools', official)).toEqual({ action: 'reject', name: 'tools' });
    // Deferred enforcement (#4735): an undeclared provider echo is relayed, never hopped.
    expect(preflightEmittedCall('provider_echo', { ...official, enforceDeclaredToolNames: false })).toEqual({ action: 'pass' });
  });
});
