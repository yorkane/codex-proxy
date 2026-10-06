/**
 * The turn lease behind runAdmittedHttpTurn must settle when a streamed response
 * goes quiescent (2026-10-05 subagent slot leak).
 *
 * Reproduced failure: a child agent's turn streams fine, then its app host is
 * orphan-recycled upstream. The client socket stays half-alive, Bun stops driving
 * the tracked stream's pull(), the producer's final chunk was already delivered,
 * and neither trackStreamLifetime's finish() nor any release path ever runs. The
 * attached workflow lease keeps its concurrency slot counted for the process's
 * whole life; eight such zombies and every later child under the same root is
 * refused with a synthetic 429 workflow_concurrency_exhausted.
 *
 * The lease is attached exactly the way runAdmittedHttpTurn does it —
 * tryAdmitTurn() + attach(workflow.lease) — so the test exercises the real
 * release chain: pull/cancel/abort/watchdog -> finish() -> unregisterTurn(ac)
 * -> activeTurns lookup -> lease.release() -> attached workflow release.
 */
import { describe, expect, test } from "bun:test";
import {
  admitWorkflowTurn,
  resetWorkflowBudgetsForTest,
  workflowBudgetSnapshot,
} from "../../src/lib/workflow-budget";
import {
  resetLifecycleDrainStateForTests,
  trackStreamLifetime,
  tryAdmitTurn,
} from "../../src/server/lifecycle";

const endlessUpstream = () =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
    },
  });

async function admittedTurnWithWorkflowLease(rootId: string) {
  const decision = admitWorkflowTurn(rootId, "worker", undefined, rootId + "-child");
  expect(decision?.admitted).toBe(true);
  if (!decision?.admitted) throw new Error("expected admission");
  const turn = tryAdmitTurn();
  expect(turn).not.toBeNull();
  turn!.attach(decision.lease);
  if (!turn) throw new Error("expected turn");
  return turn;
}

describe("quiescent streamed responses release the workflow slot", () => {
  test("consumer stops pulling and the producer is idle: the watchdog settles the turn", async () => {
    resetWorkflowBudgetsForTest();
    resetLifecycleDrainStateForTests();
    const turn = await admittedTurnWithWorkflowLease("wpb2-quiescent");
    const ac = new AbortController();

    const tracked = trackStreamLifetime(endlessUpstream(), ac, undefined, turn, 120);
    const consumer = tracked.getReader();
    await consumer.read();
    // The client vanished: nobody reads again, and the producer's read() never
    // resolves for a next pull. This is the state that used to hang forever.
    await Bun.sleep(400);

    expect(workflowBudgetSnapshot("wpb2-quiescent")?.active).toBe(0);
    expect(ac.signal.aborted).toBe(true);
  });

  test("a client abort settles the turn even while the producer is idle", async () => {
    resetWorkflowBudgetsForTest();
    resetLifecycleDrainStateForTests();
    const turn = await admittedTurnWithWorkflowLease("wpb2-abort");
    const ac = new AbortController();

    // A producer whose reads resolve immediately is NOT quiescent while a pull is
    // pending; the abort listener is the path that must settle this one.
    const tracked = trackStreamLifetime(endlessUpstream(), ac, undefined, turn, 60_000);
    const consumer = tracked.getReader();
    await consumer.read();
    ac.abort(new Error("client_cancel"));
    await Bun.sleep(50);

    expect(workflowBudgetSnapshot("wpb2-abort")?.active).toBe(0);
  });

  test("an actively streaming turn keeps its slot while bytes flow", async () => {
    resetWorkflowBudgetsForTest();
    resetLifecycleDrainStateForTests();
    const turn = await admittedTurnWithWorkflowLease("wpb2-live");
    const ac = new AbortController();

    // A pull-driven producer with a continuously reading consumer: pendingPull or
    // pendingRead is always outstanding, so the watchdog must NOT fire mid-turn.
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      },
    });
    const tracked = trackStreamLifetime(body, ac, undefined, turn, 150);
    const consumer = tracked.getReader();
    for (let i = 0; i < 30; i += 1) {
      await consumer.read();
      await Bun.sleep(10); // > grace/2 keeps both sides alternately pending
    }
    expect(workflowBudgetSnapshot("wpb2-live")?.active).toBe(1);
    expect(produced).toBeGreaterThan(20);
    await consumer.cancel();
    expect(workflowBudgetSnapshot("wpb2-live")?.active).toBe(0);
  });

  test("OCX_STREAM_LIFETIME_IDLE_GRACE_MS=0 disables the watchdog", async () => {
    resetWorkflowBudgetsForTest();
    resetLifecycleDrainStateForTests();
    const previous = process.env.OCX_STREAM_LIFETIME_IDLE_GRACE_MS;
    process.env.OCX_STREAM_LIFETIME_IDLE_GRACE_MS = "0";
    try {
      const turn = await admittedTurnWithWorkflowLease("wpb2-disabled");
      const ac = new AbortController();
      const tracked = trackStreamLifetime(endlessUpstream(), ac, undefined, turn);
      const consumer = tracked.getReader();
      await consumer.read();
      await Bun.sleep(300);
      expect(workflowBudgetSnapshot("wpb2-disabled")?.active).toBe(1);
      await consumer.cancel();
      expect(workflowBudgetSnapshot("wpb2-disabled")?.active).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.OCX_STREAM_LIFETIME_IDLE_GRACE_MS;
      else process.env.OCX_STREAM_LIFETIME_IDLE_GRACE_MS = previous;
    }
  });

  test("watchdog firing on an already-settled stream is harmless (late chunks)", async () => {
    resetWorkflowBudgetsForTest();
    resetLifecycleDrainStateForTests();
    const turn = await admittedTurnWithWorkflowLease("wpb2-late");
    const ac = new AbortController();
    // Synchronous-enqueue producer: pull() resolves the pending read immediately,
    // so the first chunk is delivered without racing a hand-pumped emitNext.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
    });
    const tracked = trackStreamLifetime(body, ac, undefined, turn, 80);
    const consumer = tracked.getReader();
    await consumer.read();
    // Settle normally through cancel, THEN let the (already cleared) watchdog
    // window pass: a double release must not resurrect the slot nor crash.
    await consumer.cancel("done");
    expect(workflowBudgetSnapshot("wpb2-late")?.active).toBe(0);
    await Bun.sleep(200);
    expect(workflowBudgetSnapshot("wpb2-late")?.active).toBe(0);
  });
});
