/**
 * exec freeform envelope-leak repair: routed models that dump a serialized
 * tool-call envelope (quoted-key JSON or parameter-tag XML) into the JS exec
 * tool get a directive error instead of an opaque dead-on-arrival SyntaxError;
 * every other input - genuine JavaScript first of all - byte-identical.
 */
import { describe, expect, test } from 'bun:test';
import { bridgeToResponsesSSE, buildResponseJSON } from '../src/bridge';
import { looksLikeExecEnvelopeLeak, repairExecEnvelopeLeak } from '../src/responses/exec-envelope-repair';
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

function execTurn(input: string): AsyncGenerator<AdapterEvent> {
  return (async function* () {
    yield { type: 'tool_call_start', id: 'call-exec', name: 'exec' } as AdapterEvent;
    yield { type: 'tool_call_delta', id: 'call-exec', arguments: input } as AdapterEvent;
    yield { type: 'tool_call_end', id: 'call-exec' } as AdapterEvent;
    yield { type: 'done' } as AdapterEvent;
  })();
}

const execOptions = {
  declaredToolNames: new Set(['exec']),
  freeformToolNames: new Set(['exec']),
};
// Streaming takes freeform names as the 4th positional argument; declaredToolNames
// rides in the options bag (8th).
const streamExec = (input: string) => bridgeToResponsesSSE(
  execTurn(input), 'llm-248/x', undefined, new Set(['exec']), undefined, undefined,
  50_000, { declaredToolNames: new Set(['exec']) },
);

// A quoted-key object at program position is illegal JavaScript (the leak shape).
const LEAK_JSON = JSON.stringify({ update_plan: '', null: 'x' });
const LEAK_XML = '<parameter=cmd>ls</parameter>';
// Quote-free so the raw assertion below is not defeated by JSON escaping in SSE.
const GENUINE_JS = 'const r = await tools.list_apps(); text(JSON.stringify(r));';

describe('exec envelope-leak detector', () => {
  test('flags the two leak shapes', () => {
    expect(looksLikeExecEnvelopeLeak(LEAK_JSON)).toBe(true);
    expect(looksLikeExecEnvelopeLeak(LEAK_XML)).toBe(true);
  });
  test('genuine JavaScript passes the detector untouched', () => {
    expect(looksLikeExecEnvelopeLeak(GENUINE_JS)).toBe(false);
    expect(repairExecEnvelopeLeak(GENUINE_JS)).toBe(GENUINE_JS);
    expect(looksLikeExecEnvelopeLeak('')).toBe(false);
    expect(looksLikeExecEnvelopeLeak('throw 1')).toBe(false);
    // A string literal mid-statement is not a program-leading envelope.
    expect(looksLikeExecEnvelopeLeak('const x = { ' + String.fromCharCode(34) + 'a' + String.fromCharCode(34) + ': 1 };')).toBe(false);
  });
});

describe('streaming bridge exec repair', () => {
  test('a leaked envelope becomes a directive error input', async () => {
    const sse = await drain(streamExec(LEAK_JSON));
    expect(sse).toContain('opencodex envelope repair');
    expect(sse).toContain('response.completed');
    expect(sse).not.toContain('response.failed');
    expect(sse).not.toContain(LEAK_JSON);
  });
  test('genuine exec JavaScript is byte-identical', async () => {
    const sse = await drain(streamExec(GENUINE_JS));
    expect(sse).toContain(GENUINE_JS);
    expect(sse).not.toContain('opencodex envelope repair');
  });
});

describe('batch bridge exec repair', () => {
  test('a leaked envelope is replaced in the batch output item', async () => {
    const events: AdapterEvent[] = [];
    for await (const e of execTurn(LEAK_XML)) events.push(e);
    const built = buildResponseJSON(events, 'llm-248/x', execOptions);
    const json = JSON.stringify(built);
    expect(json).toContain('opencodex envelope repair');
    expect(json).not.toContain('response.failed');
    expect(built.status).toBe('completed');
  });
});
