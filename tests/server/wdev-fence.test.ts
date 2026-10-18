import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWdevFenceDocument,
  wdevFenceClearIdentitiesForTests,
  wdevFenceNoteAdmitted,
  wdevFenceRead,
  wdevFenceResetCacheForTests,
} from "../../src/wdev/maintenance-fence";
import { wdevFenceGateResponse, wdevFenceHealthPair } from "../../src/wdev/gate";

/**
 * The supervisor fence contract, tested at the document, cache, and gate layers.
 *
 * The invariants the supervisor depends on, each with a case below: a fence takes effect
 * on the NEXT request (per-request stat, no polling window), a fence is only released by
 * the file going away, a malformed file is fenced, healthz acks, and the drain admits
 * ONLY validated in-flight tool continuations - quiesced/expired hard-block generation.
 */
let root: string;
let fenceFile: string;
const NOW = 1_760_000_000_000;

function fenceDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    component: "llm-proxy",
    operationId: "22222222-2222-4222-8222-222222222222",
    fenceEpoch: 1,
    phase: "draining",
    generation: 5,
    deadline: NOW + 120_000,
    ...overrides,
  };
}

function writeFence(doc: unknown): void {
  writeFileSync(fenceFile, typeof doc === "string" ? doc : JSON.stringify(doc));
  wdevFenceResetCacheForTests();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-wdev-fence-"));
  fenceFile = join(root, "maintenance-llm-proxy.json");
  process.env.WDEV_MAINTENANCE_FILE = fenceFile;
});

afterAll(() => {
  delete process.env.WDEV_MAINTENANCE_FILE;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  try { unlinkSync(fenceFile); } catch { /* absent */ }
  wdevFenceResetCacheForTests();
  wdevFenceClearIdentitiesForTests();
});

async function gate(path: string, init: RequestInit): Promise<Response | Request | null> {
  const url = path.split("?")[0] ?? path;
  return wdevFenceGateResponse(new Request(`http://x${path}`, init), url);
}

describe("fence document", () => {
  test("a valid draining document parses with the frozen deadline field", () => {
    const state = parseWdevFenceDocument(JSON.stringify(fenceDoc()), NOW);
    expect(state).toMatchObject({
      active: true, phase: "draining", strict: false, fenceEpoch: 1, generation: 5, deadline: NOW + 120_000,
    });
  });

  test("quiesced and expired parse as strict live fences", () => {
    for (const phase of ["quiesced", "expired"] as const) {
      const state = parseWdevFenceDocument(JSON.stringify(fenceDoc({ phase })), NOW);
      expect([phase, state?.active, state?.phase, state?.strict]).toEqual([phase, true, phase, true]);
    }
  });

  test("every structural violation is a null (fail-closed), not a false release", () => {
    const bad: Array<Record<string, unknown> | string> = [
      "{ not json",
      "[]",
      "null",
      fenceDoc({ schemaVersion: 2 }),
      fenceDoc({ component: "web" }),
      fenceDoc({ operationId: "" }),
      fenceDoc({ phase: "done" }),
      fenceDoc({ fenceEpoch: "one" }),
      fenceDoc({ generation: null }),
      fenceDoc({ deadline: "soon" }),
    ];
    for (const doc of bad) {
      const text = typeof doc === "string" ? doc : JSON.stringify(doc);
      expect([text.slice(0, 40), parseWdevFenceDocument(text, NOW)]).toEqual([text.slice(0, 40), null]);
    }
  });

  test("the legacy deadlineUnixMs spelling satisfies the contract as a fallback", () => {
    const doc = fenceDoc();
    delete doc.deadline;
    doc.deadlineUnixMs = NOW + 60_000;
    expect(parseWdevFenceDocument(JSON.stringify(doc), NOW)?.deadline).toBe(NOW + 60_000);
  });
});

describe("fence lifecycle as the data plane sees it", () => {
  test("no file: generation proceeds and /healthz carries no maintenance field", async () => {
    expect(wdevFenceRead(fenceFile, NOW)).toBeNull();
    expect(wdevFenceHealthPair()).toEqual({});
    const res = await gate("/v1/responses", {
      method: "POST", headers: { "thread-id": "thr-live-1" }, body: "{}",
    });
    expect(res).toBeNull();
  });

  test("the fence takes effect on the next request, and removal releases on the next request", async () => {
    const fresh = () => gate("/v1/responses", { method: "POST", body: "{}" });
    expect(await fresh()).toBeNull();
    writeFence(fenceDoc());
    const refusal = await fresh();
    expect(refusal).toBeInstanceOf(Response);
    expect((refusal as Response).status).toBe(503);
    expect(await (refusal as Response).json()).toMatchObject({ error: { code: "wdev_maintenance" } });
    unlinkSync(fenceFile);
    expect(await fresh()).toBeNull();
  });

  test("content refresh is driven by mtime/size, so a same-second rewrite is seen", async () => {
    writeFence(fenceDoc({ phase: "draining" }));
    expect(wdevFenceRead(fenceFile, NOW)?.phase).toBe("draining");
    // Same second on the clock: the stat key moves via an explicit mtime bump.
    writeFence(fenceDoc({ phase: "quiesced" }));
    utimesSync(fenceFile, new Date(NOW + 5_000), new Date(NOW + 5_000));
    expect(wdevFenceRead(fenceFile, NOW)?.phase).toBe("quiesced");
  });

  test("an expired lease does NOT self-release: the supervisor removes the file", () => {
    writeFence(fenceDoc({ deadline: NOW - 60_000 }));
    expect(wdevFenceRead(fenceFile, NOW)).not.toBeNull();
  });

  test("the supervisor's expired phase is a live fence, not a release", () => {
    // control.py flips phase to "expired" when the lease deadline passes and RETAINS the
    // fence file: admission stays blocked. A parser that rejected the phase would read
    // the retained file as null = release, which is the opposite of the core contract.
    writeFence(fenceDoc({ phase: "expired", deadline: NOW - 60_000 }));
    const state = wdevFenceRead(fenceFile, NOW);
    expect(state).toMatchObject({ active: true, phase: "expired", strict: true, operationId: "22222222-2222-4222-8222-222222222222" });
    const pair = wdevFenceHealthPair();
    expect(pair.maintenance).toMatchObject({ active: true, phase: "expired", strict: true, ack: true });
  });

  test("a directory at the fence path is fenced (fail-closed)", () => {
    mkdirSync(fenceFile);
    try {
      expect(wdevFenceRead(fenceFile, NOW)).toMatchObject({ active: true, strict: true, operationId: "fence-unreadable" });
    } finally {
      rmSync(fenceFile, { recursive: true });
      wdevFenceResetCacheForTests();
    }
  });

  test("/healthz acks the live fence with the same field values the supervisor wrote", () => {
    writeFence(fenceDoc({ fenceEpoch: 9, phase: "quiesced" }));
    const pair = wdevFenceHealthPair();
    expect(pair.maintenance).toMatchObject({
      active: true,
      operationId: "22222222-2222-4222-8222-222222222222",
      phase: "quiesced",
      strict: true,
      fenceEpoch: 9,
      ack: true,
    });
  });
});

describe("fence gate semantics: non-generation surfaces", () => {
  test("management, health, readiness, and GET /v1/models stay answerable while fenced", async () => {
    writeFence(fenceDoc());
    for (const [method, path] of [
      ["GET", "/api/wdev/components"], ["GET", "/healthz"], ["GET", "/readyz"], ["GET", "/v1/models"],
    ] as const) {
      const res = await gate(path, { method });
      expect([method, path, res]).toEqual([method, path, null]);
    }
  });

  test("count_tokens is not generation work", async () => {
    writeFence(fenceDoc());
    const res = await gate("/v1/messages/count_tokens", { method: "POST", body: "{}" });
    expect(res).toBeNull();
  });
});

describe("fence gate semantics: draining admits only validated continuations", () => {
  const toolBody = JSON.stringify({ model: "m", input: [{ type: "function_call_output", call_id: "c1", output: "42" }] });

  test("a fresh generation POST is refused, a WS upgrade is refused, the dictation WS is refused", async () => {
    writeFence(fenceDoc());
    const post = await gate("/v1/chat/completions", { method: "POST", body: "{}" });
    expect(post).toBeInstanceOf(Response);
    expect((post as Response).status).toBe(503);
    const ws = new Request("http://x/v1/responses", { headers: { upgrade: "websocket" } });
    const wsVerdict = await wdevFenceGateResponse(ws, "/v1/responses");
    expect((wsVerdict as Response).status).toBe(503);
    const dictation = new Request("http://x/v1/audio/transcriptions/stream", { headers: { upgrade: "websocket" } });
    const dictVerdict = await wdevFenceGateResponse(dictation, "/v1/audio/transcriptions/stream");
    expect(dictVerdict).toBeInstanceOf(Response);
    expect((dictVerdict as Response).status).toBe(503);
  });

  test("a tool-continuation on a lane admitted pre-fence passes, and its body survives intact", async () => {
    await gate("/v1/responses", { method: "POST", headers: { "thread-id": "thr-drain-42" }, body: "{\"input\":\"go\"}" });
    writeFence(fenceDoc());
    const verdict = await gate("/v1/responses", {
      method: "POST", headers: { "thread-id": "thr-drain-42", "content-type": "application/json" }, body: toolBody,
    });
    expect(verdict).toBeInstanceOf(Request);
    expect(await (verdict as Request).text()).toBe(toolBody);
  });

  test("a plain new user turn on an old lane header is refused (lane alone is not evidence)", async () => {
    await gate("/v1/responses", { method: "POST", headers: { "thread-id": "thr-drain-43" }, body: "{\"input\":\"go\"}" });
    writeFence(fenceDoc());
    const verdict = await gate("/v1/responses", {
      method: "POST", headers: { "thread-id": "thr-drain-43", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", input: "brand new user instruction" }),
    });
    expect(verdict).toBeInstanceOf(Response);
    expect((verdict as Response).status).toBe(503);
  });

  test("a tool-shaped body claiming an unregistered lane is refused", async () => {
    writeFence(fenceDoc());
    const verdict = await gate("/v1/responses", {
      method: "POST", headers: { "thread-id": "thr-never-seen" }, body: toolBody,
    });
    expect((verdict as Response).status).toBe(503);
  });

  test("a tool-shaped body claiming previous_response_id on an unregistered lane is refused", async () => {
    // Anchoring is lane-only: the store is deliberately not consulted on the admission
    // path (ensureLoaded/materializeEntry would amplify memory during a drain), so a
    // response-id claim proves nothing by itself.
    writeFence(fenceDoc());
    const claim = JSON.stringify({ previous_response_id: "resp_plausibly_minted", input: [{ type: "function_call_output", call_id: "c1", output: "ok" }] });
    const verdict = await gate("/v1/responses", { method: "POST", body: claim });
    expect((verdict as Response).status).toBe(503);
  });

  test("a lane admitted past the registry TTL no longer proves an in-flight turn", async () => {
    wdevFenceNoteAdmitted({ laneId: "thr-stale-lane" }, Date.now() - 31 * 60 * 1000);
    writeFence(fenceDoc());
    const verdict = await gate("/v1/responses", {
      method: "POST", headers: { "thread-id": "thr-stale-lane" }, body: toolBody,
    });
    expect((verdict as Response).status).toBe(503);
  });
});

describe("fence gate semantics: strict phases block ALL generation", () => {
  for (const phase of ["quiesced", "expired"] as const) {
    test(`${phase}: a validated tool continuation is refused and its body is never read`, async () => {
      await gate("/v1/responses", { method: "POST", headers: { "thread-id": "thr-strict-1" }, body: "{\"input\":\"go\"}" });
      writeFence(fenceDoc({ phase, deadline: NOW - 60_000 }));
      const req = new Request("http://x/v1/responses", {
        method: "POST", headers: { "thread-id": "thr-strict-1", "content-type": "application/json" },
        body: JSON.stringify({ model: "m", input: [{ type: "function_call_output", call_id: "c1", output: "42" }] }),
      });
      const verdict = await wdevFenceGateResponse(req, "/v1/responses");
      expect(verdict).toBeInstanceOf(Response);
      expect((verdict as Response).status).toBe(503);
      // Body-read evidence: the refusal path must leave the request body consumable
      // (the gate never touched it), which a body-consuming gate would break.
      expect(await req.text()).toContain("function_call_output");
    });
  }

  test("the fail-closed sentinel is strict", async () => {
    writeFence("not json at all {{{");
    await gate("/v1/responses", { method: "POST", headers: { "thread-id": "thr-strict-2" }, body: "{\"input\":\"go\"}" });
    const verdict = await gate("/v1/responses", {
      method: "POST", headers: { "thread-id": "thr-strict-2", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", input: [{ type: "function_call_output", call_id: "c1", output: "42" }] }),
    });
    expect((verdict as Response).status).toBe(503);
  });
});

describe("fence gate semantics: bounded prefix read (no unbounded buffering)", () => {
  test("a headless oversized body is capped: the gate reads at most ~2 MiB and refuses", async () => {
    writeFence(fenceDoc());
    let readBytes = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x61); // 'a' padding, no tool marker
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        readBytes += chunk.byteLength;
        if (readBytes > 12 * 1024 * 1024) { controller.close(); return; }
        controller.enqueue(chunk);
      },
    });
    const oversized: RequestInit = { method: "POST", body: stream as BodyInit, duplex: "half" } as RequestInit;
    const req = new Request("http://x/v1/responses", { ...oversized, headers: { "content-type": "application/json" } });
    const verdict = await wdevFenceGateResponse(req, "/v1/responses");
    expect(verdict).toBeInstanceOf(Response);
    expect((verdict as Response).status).toBe(503);
    // The gate streams at most the 2 MiB cap plus one chunk and cancels the rest; a
    // clone().text() gate would have buffered the full 12+ MiB (readBytes keeps growing
    // after cancel, so the bound asserts the CANCEL took effect at the cap, not after).
    expect(readBytes).toBeLessThan(4 * 1024 * 1024);
  });
});
