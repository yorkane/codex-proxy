import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRequestLog, clearRequestLogsForTests, getRequestLogEntries } from '../../src/server/request-log';
import { queryRequestLogs } from '../../src/server/request-log-filter';
import {
  decodeRequestLogCursor,
  requestLogWindowSeqs,
  selectRequestLogPoll,
} from '../../src/server/request-log-cursor';
import { requestLogDto } from '../../src/server/management/shared';
import type { RequestLogEntry } from '../../src/server/request-log';

function baseEntry(requestId: string, extra: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    requestId,
    timestamp: 1_700_000_000_000,
    model: 'gpt-test',
    provider: 'openai',
    status: 200,
    durationMs: 10,
    usageStatus: 'unreported',
    ...extra,
  };
}

const epoch = 'a'.repeat(32);
const query = new URLSearchParams('limit=2000');

/**
 * Mirror of the /api/logs route path: query the ring (which stamps ring-row positions),
 * project fresh DTOs, and hand the cursor the RING positions keyed by window index.
 * Calling selectRequestLogPoll without appendKeys would re-number every fresh DTO -- this
 * helper is what makes the test exercise the same wiring the route uses.
 */
function pollWith(q: URLSearchParams, cursor: ReturnType<typeof decodeRequestLogCursor>) {
  const queried = queryRequestLogs(getRequestLogEntries(), q);
  const seqs = requestLogWindowSeqs(queried.logs) ?? undefined;
  const projected = queried.logs.map(entry => requestLogDto(entry));
  return selectRequestLogPoll(projected, q, cursor, epoch, seqs);
}

let testDir = '';
let previousHome: string | undefined;
beforeEach(() => {
  clearRequestLogsForTests();
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), 'ocx-cursor-append-'));
  process.env.OPENCODEX_HOME = testDir;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});

describe('/api/logs ring-append storm regression', () => {
  test('steady-state ring appends at capacity ship a one-row delta, never a full reset', () => {
    // The exact hot path that cost 6MB per poll: ring at capacity, every new request appends
    // and evicts, GUI polls with limit=2000. Under v2 window-slice hashing each reset.
    for (let index = 0; index < 2000; index++) addRequestLog(baseEntry('seed-' + index));
    const first = pollWith(query, null);
    expect(first.reset).toBe(false);
    expect(first.logs).toHaveLength(2000);
    let cursor = decodeRequestLogCursor(first.cursor)!;
    for (let round = 0; round < 5; round++) {
      addRequestLog(baseEntry('busy-' + round));
      const poll = pollWith(query, cursor);
      expect(poll.reset).toBe(false);
      expect(poll.logs).toHaveLength(1);
      expect(poll.logs[0]).toMatchObject({ requestId: 'busy-' + round });
      cursor = decodeRequestLogCursor(poll.cursor)!;
    }
  });

  test('deltas merge to the full snapshot without loss or duplication under continuous load', () => {
    for (let index = 0; index < 20; index++) addRequestLog(baseEntry('merge-' + index));
    const initial = pollWith(query, null);
    let accepted = initial.logs;
    let cursor = decodeRequestLogCursor(initial.cursor)!;
    for (let round = 0; round < 7; round++) {
      addRequestLog(baseEntry('later-' + round));
      const poll = pollWith(query, cursor);
      expect(poll.reset).toBe(false);
      accepted = [...accepted, ...poll.logs];
      cursor = decodeRequestLogCursor(poll.cursor)!;
    }
    const snapshot = pollWith(query, null);
    expect(accepted).toEqual(snapshot.logs);
  });

  test('a changed filter resets against the same ring, then the new window appends incrementally', () => {
    for (let index = 0; index < 3; index++) addRequestLog(baseEntry('f-' + index, { provider: 'openai' }));
    const openai = new URLSearchParams('provider=openai&limit=2000');
    const first = pollWith(openai, null);
    let cursor = decodeRequestLogCursor(first.cursor)!;
    addRequestLog(baseEntry('other', { provider: 'anthropic' }));
    const unchanged = pollWith(openai, cursor);
    expect(unchanged.reset).toBe(false);
    expect(unchanged.logs).toHaveLength(0);
    cursor = decodeRequestLogCursor(unchanged.cursor)!;
    const anthropic = new URLSearchParams('provider=anthropic&limit=2000');
    const switched = pollWith(anthropic, cursor);
    expect(switched.reset).toBe(true);
    expect(switched.logs.map(row => row.requestId)).toEqual(['other']);
  });

  test('below-capacity clients cannot fold evictions and keep the historical reset', () => {
    // Small windows must never silently drop evicted head rows: the client cap only trims
    // correctly at ring capacity. This pins the deliberate asymmetry.
    for (let index = 0; index < 5; index++) addRequestLog(baseEntry('cap-' + index));
    const first = pollWith(query, null);
    const cursor = decodeRequestLogCursor(first.cursor)!;
    for (let index = 0; index < 2000; index++) addRequestLog(baseEntry('pressure-' + index));
    const shifted = pollWith(query, cursor);
    expect(shifted.reset).toBe(true);
    expect(shifted.logs).toHaveLength(2000);
  });

  test('a foreign-window cursor cannot ship rows it never held', () => {
    addRequestLog(baseEntry('mine'));
    const first = pollWith(query, null);
    const cursor = decodeRequestLogCursor(first.cursor)!;
    clearRequestLogsForTests();
    addRequestLog(baseEntry('different'));
    const swapped = pollWith(query, cursor);
    expect(swapped.reset).toBe(true);
    expect(swapped.logs).toHaveLength(1);
  });
});
