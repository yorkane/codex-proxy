import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { LanguageProvider } from '../src/i18n/provider';
import { clearClientResourceStoresForTests } from '../src/client-resource';
import Logs from '../src/pages/Logs';

const globals = ['document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT', 'ResizeObserver'] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

function row(requestId: string): Record<string, unknown> {
  return {
    requestId,
    timestamp: 1_700_000_000_000,
    model: 'gpt-test',
    provider: 'openai',
    status: 200,
    durationMs: 42,
    usageStatus: 'unreported',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function installLayoutStubs(win: Window): void {
  const proto = win.HTMLElement.prototype as unknown as HTMLElement;
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800, toJSON() { return this; } };
    },
  });
  class ResizeObserverStub {
    observe() {} unobserve() {} disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(win, 'ResizeObserver', { configurable: true, value: ResizeObserverStub });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: 'http://localhost/#logs' });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installLayoutStubs(testWindow);
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  clearClientResourceStoresForTests();
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mountLogs(): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Logs apiBase='http://localhost' /></LanguageProvider>);
  });
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });
  return { root, container };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    await act(async () => {
      jest.advanceTimersByTime(Math.min(1000, ms - elapsed));
    });
    await flushMicrotasks();
    await act(async () => {
      jest.advanceTimersByTime(0);
      await Promise.resolve();
    });
  }
}

function cachedRows(): unknown {
  const raw = testWindow.sessionStorage.getItem('ocx.logs.list.v1:http://localhost');
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as { data?: unknown } | unknown[];
  return Array.isArray(parsed) ? parsed : (parsed as { data: unknown }).data;
}

interface Scripted { polls: string[]; writes: number }

function scriptedServer(responses: Array<{ logs: unknown[]; cursor: string; reset: boolean }>): Scripted {
  const scripted: Scripted = { polls: [], writes: 0 };
  let index = 0;
  const next = () => responses[Math.min(index, responses.length - 1)]!;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (!url.includes('/api/logs')) return new Response(null, { status: 404 });
    scripted.polls.push(url);
    const body = next();
    index += 1;
    return jsonResponse({ ...body, total: body.logs.length, generatedAt: 1_700_000_000_000, timeZone: 'UTC' });
  }) as typeof fetch;
  // writeSessionListCache captured sessionStorage.setItem by reference at module load,
  // so the spy must replace the prototype method before the first page mount for it to land.
  const proto = testWindow.sessionStorage.constructor.prototype;
  const original = proto.setItem;
  proto.setItem = function (key: string, value: string) {
    if (String(key).startsWith('ocx.logs.list')) scripted.writes += 1;
    return original.call(this, key, value);
  };
  return scripted;
}

test('Logs: idle polls back off to the 5s cadence, not the old 2s storm', async () => {
  const scripted = scriptedServer([{ logs: [row('a')], cursor: 'c1', reset: false }]);
  const { root } = await mountLogs();
  await flushMicrotasks();
  expect(scripted.polls.filter(u => u.includes('/api/logs'))).toHaveLength(1);
  // Two old-interval ticks (4s) would have been two more polls at 2s; at 5s the cadence is quiet.
  await advance(4000);
  expect(scripted.polls.filter(u => u.includes('/api/logs'))).toHaveLength(1);
  await advance(2000);
  expect(scripted.polls.filter(u => u.includes('/api/logs')).length).toBeGreaterThanOrEqual(2);
  await act(async () => { root.unmount(); });
});

test('Logs: an empty delta does not rewrite the sessionStorage cache', async () => {
  const scripted = scriptedServer([
    { logs: [row('a')], cursor: 'c1', reset: false },
    { logs: [], cursor: 'c1', reset: false },
  ]);
  const { root } = await mountLogs();
  await flushMicrotasks();
  const writesAfterInitial = scripted.writes;
  expect(writesAfterInitial).toBe(1);
  expect(cachedRows()).toEqual([expect.objectContaining({ requestId: 'a' })]);
  await advance(6000);
  await advance(6000);
  const polls = scripted.polls.filter(u => u.includes('/api/logs')).length;
  expect(polls).toBeGreaterThanOrEqual(2);
  // Idle empty deltas must not re-stringify the window into sessionStorage.
  expect(scripted.writes).toBe(writesAfterInitial);
  await act(async () => { root.unmount(); });
});

test('Logs: a delta that advances the cursor still writes the merged window', async () => {
  const scripted = scriptedServer([
    { logs: [row('a')], cursor: 'c1', reset: false },
    { logs: [row('b')], cursor: 'c2', reset: false },
  ]);
  const { root } = await mountLogs();
  await flushMicrotasks();
  await advance(6000);
  expect(scripted.writes).toBeGreaterThanOrEqual(2);
  expect(cachedRows()).toEqual([
    expect.objectContaining({ requestId: 'a' }),
    expect.objectContaining({ requestId: 'b' }),
  ]);
  await act(async () => { root.unmount(); });
});

test('Logs: a jitter reset with an unchanged cursor and row count skips the write', async () => {
  // Server reset=true but the cursor did not advance and the window length held: the same
  // bytes re-sent. The cache already holds exactly this window from the previous write.
  const scripted = scriptedServer([
    { logs: [row('a')], cursor: 'c1', reset: false },
    { logs: [row('a')], cursor: 'c1', reset: true },
  ]);
  const { root } = await mountLogs();
  await flushMicrotasks();
  const writesAfterInitial = scripted.writes;
  await advance(6000);
  await advance(6000);
  expect(scripted.polls.filter(u => u.includes('/api/logs')).length).toBeGreaterThanOrEqual(2);
  expect(scripted.writes).toBe(writesAfterInitial);
  expect(cachedRows()).toEqual([expect.objectContaining({ requestId: 'a' })]);
  await act(async () => { root.unmount(); });
});