/**
 * Emitted call-shape repair: routed models that emit a Codex tool in the wrong
 * naming form (bare sub-agent name, dotted namespace, functions__ prefix) get
 * rewritten to the declared wire name instead of dying on the phantom guard.
 * Ambiguous or unmatched names stay fail-closed.
 */
import { describe, expect, test } from 'bun:test';
import { repairEmittedToolName } from '../src/types';
import { bridgeToResponsesSSE, buildResponseJSON } from '../src/bridge';
import type { AdapterEvent } from '../src/types';

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
