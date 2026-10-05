import { describe, expect, test } from "bun:test";
import { collectShadowDiagnosticEvents } from "../../src/server/management/shadow-diagnostics-routes";
import type { RequestLogEntry } from "../../src/server/request-log";

function entry(over: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    requestId: "ocx-test",
    timestamp: 1_000,
    model: "Q38-Flash-Next",
    provider: "llm-248",
    status: 200,
    ...over,
  } as RequestLogEntry;
}

function withAttempt(attempt: Record<string, unknown>, over: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return entry({ attempts: [attempt] as RequestLogEntry["attempts"], ...over });
}

describe("shadow diagnostics feed", () => {
  test("a healthy request produces no events", () => {
    expect(collectShadowDiagnosticEvents([entry()])).toEqual([]);
    expect(collectShadowDiagnosticEvents([withAttempt({ status: 200, recoveryKinds: [] })])).toEqual([]);
  });

  test("each dropped-emit decision maps to its own kind", () => {
    const events = collectShadowDiagnosticEvents([
      withAttempt({ droppedEmits: [{ name: "tools", decision: "namespace-container", count: 1 }] }),
      withAttempt({ droppedEmits: [{ name: "update_plan", decision: "phantom", count: 3 }] }),
      withAttempt({ droppedEmits: [{ name: "web__run", decision: "directive-feedback", count: 2 }] }),
    ]);
    expect(events.map((e) => e.kind).sort()).toEqual([
      "directive-feedback", "namespace-container", "phantom-drop",
    ]);
    const feedback = events.find((e) => e.kind === "directive-feedback")!;
    expect(feedback.names).toEqual(["web__run"]);
    expect(feedback.count).toBe(2);
  });

  test("the correction is reported, which is the disposition that saved the turn", () => {
    const events = collectShadowDiagnosticEvents([
      withAttempt({ droppedEmits: [{ name: "tools", decision: "directive-feedback", count: 1 }] }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toContain("taught the right spelling");
  });

  test("a repeated (kind, name) pair within one request yields one event carrying the count", () => {
    // Two attempts of the SAME request: the durable row already folds repeats, so the feed must
    // not multiply them. Two different requests stay two events - see the test below.
    const events = collectShadowDiagnosticEvents([entry({
      attempts: [
        { status: 200, droppedEmits: [{ name: "tools", decision: "phantom", count: 7 }] },
        { status: 200, droppedEmits: [{ name: "tools", decision: "phantom", count: 9 }] },
      ] as RequestLogEntry["attempts"],
    })]);
    expect(events).toHaveLength(1);
    expect(events[0]!.count).toBe(7);
  });

  test("the same name in two different requests stays two events", () => {
    const events = collectShadowDiagnosticEvents([
      withAttempt({ droppedEmits: [{ name: "tools", decision: "phantom", count: 1 }] }, { requestId: "a" }),
      withAttempt({ droppedEmits: [{ name: "tools", decision: "phantom", count: 1 }] }, { requestId: "b" }),
    ]);
    expect(events).toHaveLength(2);
  });

  test("an unknown decision is ignored rather than surfaced as a bogus kind", () => {
    const events = collectShadowDiagnosticEvents([
      withAttempt({ droppedEmits: [{ name: "x", decision: "something-new", count: 1 }] }),
    ]);
    expect(events).toEqual([]);
  });

  test("an empty-completion replay is recognised from the recovery kind", () => {
    const events = collectShadowDiagnosticEvents([
      withAttempt({ recoveryKinds: ["empty-completion"] }),
    ]);
    expect(events.map((e) => e.kind)).toEqual(["empty-completion"]);
  });

  test("an exhausted replay is recognised from the terminal text", () => {
    const events = collectShadowDiagnosticEvents([
      entry({ status: 500, upstreamError: "opencodex empty_completion_retry_failed" }),
    ]);
    expect(events.map((e) => e.kind)).toContain("empty-completion");
  });

  test("a fail-closed undeclared tool is matched on the error text and names the tool", () => {
    const events = collectShadowDiagnosticEvents([
      entry({
        status: 502,
        upstreamError: 'routed provider emitted undeclared client tool "zzz"; only request-declared tools may be called',
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("undeclared-tool-rejected");
    expect(events[0]!.names).toEqual(["zzz"]);
    // The kind is the only one derived from prose, so the panel has to say so.
    expect(events[0]!.detail).toContain("no dedicated telemetry field");
  });

  test("a 502 that is not an undeclared tool is not mislabelled", () => {
    expect(collectShadowDiagnosticEvents([entry({ status: 502, upstreamError: "Bad Gateway" })])).toEqual([]);
  });

  test("events come back newest first", () => {
    const events = collectShadowDiagnosticEvents([
      withAttempt({ droppedEmits: [{ name: "a", decision: "phantom", count: 1 }] }, { timestamp: 10, requestId: "old" }),
      withAttempt({ droppedEmits: [{ name: "b", decision: "phantom", count: 1 }] }, { timestamp: 99, requestId: "new" }),
    ]);
    expect(events.map((e) => e.requestId)).toEqual(["new", "old"]);
  });

  test("the event carries enough to locate the request", () => {
    const events = collectShadowDiagnosticEvents([
      withAttempt({ droppedEmits: [{ name: "tools", decision: "directive-feedback", count: 1 }] }, {
        requestId: "ocx-abc",
        model: "Q38-Flash-Next",
        provider: "llm-248",
        status: 200,
      }),
    ]);
    expect(events[0]).toMatchObject({ requestId: "ocx-abc", model: "Q38-Flash-Next", provider: "llm-248", status: 200 });
  });
});
