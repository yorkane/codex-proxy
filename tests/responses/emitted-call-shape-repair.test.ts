/**
 * Emitted call-shape repair: routed models that emit a Codex tool in the wrong
 * naming form (bare sub-agent name, dotted namespace, functions__ prefix) get
 * rewritten to the declared wire name instead of dying on the phantom guard.
 * Ambiguous or unmatched names stay fail-closed.
 */
import { describe, expect, test } from 'bun:test';
import { repairEmittedToolName } from '../../src/types';
import { bridgeToResponsesSSE, buildResponseJSON } from '../../src/bridge';
import type { AdapterEvent } from '../../src/types';

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function* callTurn(name: string): AsyncGenerator<AdapterEvent> {
  yield { type: 'tool_call_start', id: 'call-x', name } as AdapterEvent;
  yield { type: 'tool_call_delta', id: 'call-x', arguments: '{}' } as AdapterEvent;
  yield { type: 'tool_call_end', id: 'call-x' } as AdapterEvent;
  yield { type: 'done' } as AdapterEvent;
}

const collabDeclared = new Set(['collaboration__spawn_agent', 'collaboration__update_plan', 'exec', 'web_search']);

describe('repairEmittedToolName', () => {
  test('bare sub-agent name maps to its unique namespaced declaration', () => {
    expect(repairEmittedToolName('spawn_agent', collabDeclared)).toBe('collaboration__spawn_agent');
  });
  test('dotted namespace form flattens', () => {
    expect(repairEmittedToolName('collaboration.spawn_agent', collabDeclared)).toBe('collaboration__spawn_agent');
  });
  test('functions__ prefix strips to the bare builtin', () => {
    expect(repairEmittedToolName('functions__exec', collabDeclared)).toBe('exec');
    expect(repairEmittedToolName('functions.exec', collabDeclared)).toBe('exec');
  });
  test('declared names pass through unchanged', () => {
    expect(repairEmittedToolName('web_search', collabDeclared)).toBe('web_search');
    expect(repairEmittedToolName('collaboration__spawn_agent', collabDeclared)).toBe('collaboration__spawn_agent');
  });
  test('ambiguous bare name stays undeclared', () => {
    const two = new Set(['a__run', 'b__run']);
    expect(repairEmittedToolName('run', two)).toBe('run');
  });
  test('unknown name stays undeclared', () => {
    expect(repairEmittedToolName('hallucinated_tool', collabDeclared)).toBe('hallucinated_tool');
  });
  test('namespaced form falls back to a declared bare name', () => {
    const bareOnly = new Set(['update_plan']);
    expect(repairEmittedToolName('collaboration__update_plan', bareOnly)).toBe('update_plan');
  });
});
describe('sandbox-namespace composition repair', () => {
  test('tools__web_run repairs to declared web__run', () => {
    const declared = new Set(['web__run', 'exec']);
    expect(repairEmittedToolName('tools__web_run', declared)).toBe('web__run');
  });
  test('tools.exec repairs to declared exec', () => {
    expect(repairEmittedToolName('tools.exec', new Set(['exec']))).toBe('exec');
  });
  test('tools__ prefix without a declared remainder stays phantom', () => {
    expect(repairEmittedToolName('tools__web_run', new Set(['exec']))).toBe('tools__web_run');
  });
});

describe('bridge call-shape repair', () => {
  test('a bare sub-agent call reaches the client under its declared name', async () => {
    const sse = await drain(bridgeToResponsesSSE(callTurn('spawn_agent'), 'llm-248/x', undefined, undefined, undefined, undefined, 50_000, { declaredToolNames: collabDeclared }));
    expect(sse).not.toContain('undeclared client tool');
    expect(sse).toContain('response.completed');
    expect(sse).toContain('spawn_agent');
  });
  test('an unrepairable phantom still fails closed', async () => {
    const sse = await drain(bridgeToResponsesSSE(callTurn('made_up_tool'), 'llm-248/x', undefined, undefined, undefined, undefined, 50_000, { declaredToolNames: collabDeclared }));
    expect(sse).toContain('undeclared client tool');
  });
  test('batch path repairs the same shape', async () => {
    const events: AdapterEvent[] = [];
    for await (const e of callTurn('collaboration.spawn_agent')) events.push(e);
    const built = buildResponseJSON(events, 'llm-248/x', { declaredToolNames: collabDeclared });
    expect(JSON.stringify(built)).toContain('spawn_agent');
    expect(JSON.stringify(built)).not.toContain('undeclared client tool');
  });
});

// Client-log census (2026-10-04, ~/.codex/logs_2.sqlite, 30d): the model copies the
// code-mode qualification 'tools.x' into a wire-level tool call and mangles the
// separator. Every spelling this function fails to repair ends the whole turn with
// 'unsupported call' on the client, so the = and / forms need the same treatment the
// older __ and . forms already get.
const sandboxDeclared = new Set([
  'exec',
  'exec_command',
  'apply_patch',
  'view_image',
  'write_stdin',
  'update_plan',
  'text',
  'commentary',
  'agent',
  'collaboration__spawn_agent',
  'collaboration__send_message',
  'collaboration__update_plan',
  'web__run',
  'web__search',
]);

describe('sandbox-namespace composition repair: = and / spellings', () => {
  test('tools= repairs to the declared tool', () => {
    expect(repairEmittedToolName('tools=exec', sandboxDeclared)).toBe('exec');
    expect(repairEmittedToolName('tools=exec_command', sandboxDeclared)).toBe('exec_command');
    expect(repairEmittedToolName('tools=apply_patch', sandboxDeclared)).toBe('apply_patch');
    expect(repairEmittedToolName('tools=write_stdin', sandboxDeclared)).toBe('write_stdin');
    expect(repairEmittedToolName('tools=view_image', sandboxDeclared)).toBe('view_image');
  });
  test('tools/ repairs to the declared tool', () => {
    expect(repairEmittedToolName('tools/exec_command', sandboxDeclared)).toBe('exec_command');
  });
  test('separator-insensitive match still works through the = and / prefixes', () => {
    // web__run is declared; the model collapses the namespace separator to web_run.
    expect(repairEmittedToolName('tools=web_run', sandboxDeclared)).toBe('web__run');
    expect(repairEmittedToolName('tools/web_run', sandboxDeclared)).toBe('web__run');
  });
  test('empty or unknown remainder after the prefix stays fail-closed', () => {
    expect(repairEmittedToolName('tools=', sandboxDeclared)).toBe('tools=');
    expect(repairEmittedToolName('tools=', new Set(['exec']))).toBe('tools=');
    expect(repairEmittedToolName('tools=__NA__', sandboxDeclared)).toBe('tools=__NA__');
    expect(repairEmittedToolName('tools=not_a_tool', sandboxDeclared)).toBe('tools=not_a_tool');
    expect(repairEmittedToolName('tools/unknown_thing', sandboxDeclared)).toBe('tools/unknown_thing');
    expect(repairEmittedToolName('tools/', sandboxDeclared)).toBe('tools/');
  });
  test('ambiguous strip after the = prefix stays fail-closed', () => {
    // web__run and web_run both declared, so tools=web_run names two candidates.
    const ambiguous = new Set(['web__run', 'web_run', 'exec']);
    expect(repairEmittedToolName('tools=web_run', ambiguous)).toBe('tools=web_run');
  });
  test('already-declared names are untouched by the new prefixes', () => {
    expect(repairEmittedToolName('exec', sandboxDeclared)).toBe('exec');
    expect(repairEmittedToolName('web__run', sandboxDeclared)).toBe('web__run');
  });
  test('bare tools keeps its current passthrough behaviour', () => {
    // The bare namespace form belongs to the namespace-leak feedback path; lock the
    // behaviour so the prefix table cannot silently start rewriting it.
    expect(repairEmittedToolName('tools', sandboxDeclared)).toBe('tools');
  });
  test('similar-but-different prefixes are not swallowed by the table', () => {
    expect(repairEmittedToolName('toolz=exec', sandboxDeclared)).toBe('toolz=exec');
    expect(repairEmittedToolName('toolset=exec', sandboxDeclared)).toBe('toolset=exec');
  });
});
