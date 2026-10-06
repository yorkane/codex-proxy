import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  admitWorkflowTurn,
  clearWorkflowBudgetForRoot,
  DEFAULT_WORKFLOW_BUDGET_POLICY,
  listWorkflowBudgetEvents,
  resetWorkflowBudgetsForTest,
  workflowBudgetSnapshot,
  WORKFLOW_MAX_LEASE_AGE_MS,
  type WorkflowBudgetPolicy,
} from "../../src/lib/workflow-budget";

const policy: WorkflowBudgetPolicy = { ...DEFAULT_WORKFLOW_BUDGET_POLICY };
const T0 = 1_700_000_000_000;
const MIN = 60_000;

const prevEnv = process.env.OCX_WORKFLOW_LEASE_MAX_AGE_MS;
beforeEach(() => {
  resetWorkflowBudgetsForTest();
  delete process.env.OCX_WORKFLOW_LEASE_MAX_AGE_MS;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.OCX_WORKFLOW_LEASE_MAX_AGE_MS;
  else process.env.OCX_WORKFLOW_LEASE_MAX_AGE_MS = prevEnv;
});

describe("concurrency leases are reaped, not permanent (subagent 429 deaths)", () => {
  test("the default worker ceiling admits a fan-out at the measured production peak", () => {
    // The regression this closes: with the old default of 8 (7 usable by workers), the root
    // family that sustains p99=14 / peak 16 simultaneous turns got 429 refusals and a
    // 56-minute subagent died at the client retry limit. At the observed peak, the ceiling
    // must admit.
    for (let i = 0; i < 15; i += 1) {
      const decision = admitWorkflowTurn("root-peak", "worker", policy, "c" + i, T0);
      expect(decision?.admitted, "worker " + i).toBe(true);
    }
    // And it still FIRES above the peak -- the cap bounds a runaway fan-out, which is the
    // whole reason it exists. Raising the number without losing the guard is the fix.
    const denied = admitWorkflowTurn("root-peak", "worker", policy, "c15", T0);
    expect(denied?.admitted).toBe(false);
    if (denied && !denied.admitted) expect(denied.reason).toBe("workflow-concurrency-exhausted");
  });

  test("an interactive turn always has its reserved slot even at the worker ceiling", () => {
    for (let i = 0; i < 15; i += 1) {
      const decision = admitWorkflowTurn("root-resv", "worker", policy, "c" + i, T0);
      expect(decision?.admitted, "worker " + i).toBe(true);
    }
    const inter = admitWorkflowTurn("root-resv", "interactive", policy, undefined, T0);
    expect(inter?.admitted).toBe(true);
  });

  test("a released lease frees its slot for the next child", () => {
    const first = admitWorkflowTurn("root-rel", "worker", policy, "c1", T0);
    expect(first?.admitted).toBe(true);
    first?.lease.release();
    const second = admitWorkflowTurn("root-rel", "worker", policy, "c2", T0 + 1);
    expect(second?.admitted).toBe(true);
    second?.lease.release();
    expect(workflowBudgetSnapshot("root-rel", policy, T0 + 2)?.active).toBe(0);
  });

  test("a double release cannot drive the count negative or hand out a phantom slot", () => {
    const held = admitWorkflowTurn("root-dbl", "worker", policy, "c1", T0);
    expect(held?.admitted).toBe(true);
    held?.lease.release();
    held?.lease.release();
    expect(workflowBudgetSnapshot("root-dbl", policy, T0 + 1)?.active).toBe(0);
    // The ceiling is exactly as high as it was before: no second slot was minted.
    for (let i = 0; i < 15; i += 1) {
      expect(admitWorkflowTurn("root-dbl", "worker", policy, "x" + i, T0 + 2)?.admitted).toBe(true);
    }
    expect(admitWorkflowTurn("root-dbl", "worker", policy, "overflow", T0 + 3)?.admitted).toBe(false);
  });

  test("a leaked lease ages out of the count and the refusal stops", () => {
    // The defect: a turn that never calls release() kept its slot forever. clear() could not
    // help (it deliberately refuses to touch the in-flight count), and the only cure was a
    // process restart. Here the holders are abandoned -- no release call at all.
    for (let i = 0; i < 15; i += 1) {
      expect(admitWorkflowTurn("root-leak", "worker", policy, "c" + i, T0)?.admitted).toBe(true);
    }
    const mid = workflowBudgetSnapshot("root-leak", policy, T0 + MIN);
    expect(mid?.active).toBe(15);
    expect(admitWorkflowTurn("root-leak", "worker", policy, "late", T0 + MIN)?.admitted).toBe(false);

    // Past the age bound, the next read -- even a pure snapshot read -- reaps them all.
    const later = workflowBudgetSnapshot("root-leak", policy, T0 + WORKFLOW_MAX_LEASE_AGE_MS + MIN);
    expect(later?.active).toBe(0);
    const revived = admitWorkflowTurn("root-leak", "worker", policy, "late", T0 + WORKFLOW_MAX_LEASE_AGE_MS + MIN);
    expect(revived?.admitted).toBe(true);
  });

  test("a live turn holding its slot is never reaped inside the bound, and its release is a no-op after the reap", () => {
    // A live turn is only un-reapable while it is YOUNG: the bound measures the lease, not
    // the wall clock, so the busy turn is admitted near the read moment and the dead one is
    // old. A turn that actually runs past the bound loses its slot -- one slot of precision,
    // the documented trade -- which is also asserted below.
    const leaked = admitWorkflowTurn("root-live", "worker", policy, "dead", T0);
    expect(leaked?.admitted).toBe(true);
    const held = admitWorkflowTurn("root-live", "worker", policy, "busy", T0 + WORKFLOW_MAX_LEASE_AGE_MS);
    expect(held?.admitted).toBe(true);

    const within = T0 + WORKFLOW_MAX_LEASE_AGE_MS - MIN;
    expect(workflowBudgetSnapshot("root-live", policy, within)?.active).toBe(2);
    const after = workflowBudgetSnapshot("root-live", policy, T0 + WORKFLOW_MAX_LEASE_AGE_MS + MIN);
    expect(after?.active).toBe(1);
    // The late release of the reaped lease must not subtract from the live turn's slot.
    leaked?.lease.release();
    expect(workflowBudgetSnapshot("root-live", policy, T0 + WORKFLOW_MAX_LEASE_AGE_MS + MIN + 1)?.active).toBe(1);
    held?.lease.release();
    expect(workflowBudgetSnapshot("root-live", policy, T0 + WORKFLOW_MAX_LEASE_AGE_MS + MIN + 2)?.active).toBe(0);
  });

  test("the reaper is observable: reaping lands on the event record with what it took", () => {
    const held = admitWorkflowTurn("root-obs", "worker", policy, "c1", T0);
    expect(held?.admitted).toBe(true);
    // Snapshot read at T0+HOUR+... does the reap (a reaped event is the receipt).
    const late = T0 + WORKFLOW_MAX_LEASE_AGE_MS + MIN;
    expect(workflowBudgetSnapshot("root-obs", policy, late)?.active).toBe(0);
    const events = listWorkflowBudgetEvents(8);
    const reaped = events.filter(e => e.kind === "reaped" && e.rootId === "root-obs");
    expect(reaped.length).toBe(1);
    expect(reaped[0]?.reaped).toBe(1);
    held?.lease.release();
  });

  test("clear still forgives count ceilings and still refuses to launder live slots", () => {
    const held = admitWorkflowTurn("root-clear", "worker", policy, "c1", T0);
    expect(held?.admitted).toBe(true);
    const before = clearWorkflowBudgetForRoot("root-clear", policy, T0 + 1);
    expect(before?.active).toBe(1);
    // The in-flight lease survives the clear -- it is a live turn, not a ceiling to forgive.
    expect(workflowBudgetSnapshot("root-clear", policy, T0 + 2)?.active).toBe(1);
    held?.lease.release();
    expect(workflowBudgetSnapshot("root-clear", policy, T0 + 3)?.active).toBe(0);
  });

  test("a leaked root's slot also unsticks the eviction path", () => {
    // An active root can never be evicted; a leaked lease used to make a root permanently
    // un-evictable as well as permanently full. After the reap both resolve together.
    const first = admitWorkflowTurn("root-a", "interactive", policy, undefined, T0);
    expect(first?.admitted).toBe(true); // leaked on purpose: no release
    const late = T0 + WORKFLOW_MAX_LEASE_AGE_MS + MIN;
    expect(workflowBudgetSnapshot("root-a", policy, late)?.active).toBe(0);
    const decision = admitWorkflowTurn("root-a", "interactive", policy, undefined, late);
    expect(decision?.admitted).toBe(true);
    decision && decision.admitted && decision.lease.release();
  });

  test("the env knob tightens the bound but a bad value never disables the reaper", () => {
    process.env.OCX_WORKFLOW_LEASE_MAX_AGE_MS = "60000";
    const held = admitWorkflowTurn("root-env", "worker", policy, "c1", T0);
    expect(held?.admitted).toBe(true);
    expect(workflowBudgetSnapshot("root-env", policy, T0 + 2 * MIN)?.active).toBe(0);

    // A nonsense value must fall back to the default bound, NOT to "never reap".
    process.env.OCX_WORKFLOW_LEASE_MAX_AGE_MS = "not-a-number";
    const leak2 = admitWorkflowTurn("root-env2", "worker", policy, "c1", T0);
    expect(leak2?.admitted).toBe(true);
    expect(workflowBudgetSnapshot("root-env2", policy, T0 + WORKFLOW_MAX_LEASE_AGE_MS + MIN)?.active).toBe(0);
  });
});

