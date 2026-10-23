import { describe, expect, test } from "bun:test";
import {
  cancelModelRetryCommitsForKey,
  deferModelRetryCommit,
  modelRetryScopeActive,
  runModelRetryScope,
} from "../../src/lib/model-retry-scope";

describe("model-retry-scope queue semantics", () => {
  test("an active scope defers, and the outermost flush runs the queue in arrival order", async () => {
    const log: string[] = [];
    await runModelRetryScope(async () => {
      expect(modelRetryScopeActive()).toBe(true);
      deferModelRetryCommit(async () => { await Promise.resolve(); log.push("first"); });
      deferModelRetryCommit(() => { log.push("sync"); });
      deferModelRetryCommit(async () => { await new Promise(r => setTimeout(r, 5)); log.push("slow"); });
      expect(log).toEqual([]);
    });
    expect(log).toEqual(["first", "sync", "slow"]);
  });

  test("an inner run shares the outermost owner: nested defers flush once, after the outer body", async () => {
    const log: string[] = [];
    await runModelRetryScope(async () => {
      await runModelRetryScope(async () => {
        deferModelRetryCommit(() => { log.push("nested"); });
      });
      expect(log).toEqual([]); // the inner run owns no flush
      deferModelRetryCommit(() => { log.push("outer"); });
    });
    expect(log).toEqual(["nested", "outer"]);
  });

  test("the flush completes before the return value propagates to the caller", async () => {
    let committed = false;
    const value = await runModelRetryScope(async () => {
      deferModelRetryCommit(async () => { await Promise.resolve(); committed = true; });
      return "response";
    });
    expect(value).toBe("response");
    expect(committed).toBe(true);
  });

  test("a mid-scope success cancels the key queued commits; survivors keep their order", async () => {
    const log: string[] = [];
    await runModelRetryScope(async () => {
      deferModelRetryCommit(() => { log.push("drop-1"); }, "k1");
      deferModelRetryCommit(() => { log.push("keep"); }, "k2");
      deferModelRetryCommit(() => { log.push("drop-2"); }, "k1");
      cancelModelRetryCommitsForKey("k1");
    });
    expect(log).toEqual(["keep"]);
  });

  test("a commit rejection is swallowed at flush and later entries still run", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      await runModelRetryScope(async () => {
        deferModelRetryCommit(async () => { throw new Error("boom"); });
        deferModelRetryCommit(() => { warnings.push("ran-after"); });
      });
    } finally {
      console.warn = original;
    }
    expect(warnings.some(w => w.includes("boom"))).toBe(true);
    expect(warnings).toContain("ran-after");
  });

  test("a deferral from a task that resumes after the flush executes immediately, never lost", async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await runModelRetryScope(async () => {
      // A continuation created inside the scope inherits the store and resumes after the
      // scope has flushed: the deferral must run immediately, not park in a dead queue.
      void (async () => {
        await gate;
        deferModelRetryCommit(() => { log.push("late"); });
      })();
      deferModelRetryCommit(() => { log.push("in-scope"); });
    });
    expect(log).toEqual(["in-scope"]);
    release();
    await new Promise(r => setTimeout(r, 0));
    expect(log).toEqual(["in-scope", "late"]);
  });

  test("modelRetryScopeActive is false outside and after a flushed scope", async () => {
    expect(modelRetryScopeActive()).toBe(false);
    let inside = false;
    await runModelRetryScope(async () => { inside = modelRetryScopeActive(); });
    expect(inside).toBe(true);
    expect(modelRetryScopeActive()).toBe(false);
  });
});
