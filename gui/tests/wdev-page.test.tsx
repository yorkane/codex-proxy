/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Wdev from "../src/pages/Wdev";
import { buildOperationBody, type WdevDraft } from "../src/pages/wdev-shared";

/*
 * The submit whitelist is the security story of this page: the manager acts on
 * componentId/action and nothing else, so the assertions read the body that actually
 * left fetch, not a shape rebuilt beside the component. The polling half pins the
 * honesty rule: a 202 is not success, and the timeline must show queued before succeeded.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

interface SentRequest { url: string; method: string; body: Record<string, unknown> }

const INVENTORY = {
  enabled: true,
  brand: "wdev-proxy",
  components: [{
    id: "llm-proxy", unit: "wdev-llm-proxy.service", url: "http://127.0.0.1:10100",
    status: "ok", releaseId: "2.87.0", revision: 41,
  }],
  manifests: [{ name: "wdev-proxy", path: "manifests/current.json", version: "2.88.0", sizeBytes: 4096 }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#wdev" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

/** Let the page's real 2s poll tick run, then drain the promises its fetch chain leaves. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => { setTimeout(resolve, ms); });
  });
  await flush();
}

async function mount(container: HTMLElement): Promise<Root> {
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Wdev apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await flush();
  return root;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(b => (b.textContent ?? "").trim() === text);
  expect(button, text).toBeTruthy();
  return button!;
}

test("a restart submit posts exactly the whitelist keys, then follows the ledger", async () => {
  const sent: SentRequest[] = [];
  const ledger: Record<string, { state: string; updatedAt: number }> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "http://localhost/api/wdev/components" && method === "GET") return jsonResponse(INVENTORY);
    if (url === "http://localhost/api/wdev/operations" && method === "GET") {
      return jsonResponse({ operations: Object.entries(ledger).map(([operationId, detail]) => ({
        operationId, componentId: "llm-proxy", action: "restart", state: detail.state,
        submittedAt: detail.updatedAt, updatedAt: detail.updatedAt,
      })) });
    }
    if (url === "http://localhost/api/wdev/operations" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      sent.push({ url, method, body });
      ledger.op1 = { state: "queued", updatedAt: Date.now() };
      return jsonResponse({ operationId: "op1", state: "queued", componentId: body.componentId, action: body.action, submittedAt: Date.now() }, 202);
    }
    const detail = url.match(/^http:\/\/localhost\/api\/wdev\/operations\/(.+)$/);
    if (detail && method === "GET") {
      const row = ledger[decodeURIComponent(detail[1]!)];
      if (!row) return jsonResponse({ error: "unknown operation" }, 404);
      return jsonResponse({ operationId: decodeURIComponent(detail[1]!), componentId: "llm-proxy", action: "restart", state: row.state, updatedAt: row.updatedAt });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  const root = await mount(container);
  try {
    await act(async () => { buttonByText(container, "Restart").click(); });
    await flush();
    await act(async () => { buttonByText(container, "Submit").click(); });
    await flush();

    expect(sent).toHaveLength(1);
    // Exactly the whitelist: no shell, unit, exe, url, or service-name field can ride along.
    expect(Object.keys(sent[0]!.body).sort()).toEqual(["action", "componentId", "idempotencyKey"]);
    expect(sent[0]!.body.componentId).toBe("llm-proxy");
    expect(sent[0]!.body.action).toBe("restart");
    expect(String(sent[0]!.body.idempotencyKey)).toMatch(/^[0-9a-f-]{36}$/);

    // 202 alone renders queued, never succeeded.
    expect(container.textContent).toContain("queued");
    expect(container.textContent).not.toContain("succeeded");

    // The ledger is the authority: the row follows only after a poll.
    ledger.op1 = { state: "running", updatedAt: Date.now() };
    await advance(2_100);
    expect(container.textContent).toContain("running");

    ledger.op1 = { state: "succeeded", updatedAt: Date.now() };
    await advance(2_100);
    expect(container.textContent).toContain("succeeded");
    expect(container.textContent).not.toContain("polling");
  } finally {
    await act(async () => { root.unmount(); });
  }
}, 30_000);


test("a real ledger phase sequence polls mid-flight and never reads as cancelled", async () => {
  // The G70 bug: the manager advances queued -> wait_idle -> quiesce -> verify ->
  // commit -> succeeded. A mid-flight phase is NOT terminal, so the row must keep
  // polling, show the raw phase name, and only the ledger's own succeeded ends it.
  const ledger: Record<string, { state: string; updatedAt: number }> = {};
  let detailPolls = 0;
  let inventoryFetches = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "http://localhost/api/wdev/components" && method === "GET") { inventoryFetches += 1; return jsonResponse(INVENTORY); }
    if (url === "http://localhost/api/wdev/operations" && method === "GET") {
      return jsonResponse({ operations: Object.entries(ledger).map(([operationId, detail]) => ({
        operationId, componentId: "llm-proxy", action: "restart", state: detail.state,
        submittedAt: detail.updatedAt, updatedAt: detail.updatedAt,
      })) });
    }
    if (url === "http://localhost/api/wdev/operations" && method === "POST") {
      ledger.op1 = { state: "queued", updatedAt: Date.now() };
      return jsonResponse({ operationId: "op1", state: "queued", componentId: "llm-proxy", action: "restart", submittedAt: Date.now() }, 202);
    }
    const detail = url.match(/^http:\/\/localhost\/api\/wdev\/operations\/(.+)$/);
    if (detail && method === "GET") {
      const row = ledger[decodeURIComponent(detail[1]!)];
      if (!row) return jsonResponse({ error: "unknown operation" }, 404);
      detailPolls += 1;
      return jsonResponse({ operationId: decodeURIComponent(detail[1]!), componentId: "llm-proxy", action: "restart", state: row.state, updatedAt: row.updatedAt });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  const root = await mount(container);
  try {
    await act(async () => { buttonByText(container, "Restart").click(); });
    await flush();
    await act(async () => { buttonByText(container, "Submit").click(); });
    await flush();
    const badge = () => [...container.querySelectorAll(".wdev-state-row span.badge")]
      .map(el => (el.textContent ?? "").trim())
      .find(text => text.length > 0) ?? "";

    for (const phase of ["wait_idle", "quiesce", "verify", "commit"] as const) {
      ledger.op1 = { state: phase, updatedAt: Date.now() };
      await advance(2_100);
      expect(badge()).toContain(phase);
      expect(container.textContent).not.toContain("Cancelled");
    }
    const pollsMidFlight = detailPolls;
    expect(pollsMidFlight).toBeGreaterThanOrEqual(4);

    ledger.op1 = { state: "succeeded", updatedAt: Date.now() };
    await advance(2_100);
    expect(badge()).toBe("succeeded");
    expect(container.textContent).not.toContain("polling");
    // Terminal stops the poll loop outright: one more tick fetches nothing new.
    const pollsAtTerminal = detailPolls;
    await advance(2_100);
    expect(detailPolls).toBe(pollsAtTerminal);
    // The completed operation refreshed the inventory once (the G70 re-verify path).
    expect(inventoryFetches).toBeGreaterThanOrEqual(2);
  } finally {
    await act(async () => { root.unmount(); });
  }
}, 30_000);

test("rolled_back and protected read as their own outcomes, not success or cancelled", async () => {
  for (const [phase, labelPart] of [
    ["rolled_back", "Rolled back"],
    ["protected", "Protected"],
  ] as const) {
    const ledger: Record<string, { state: string; updatedAt: number }> = { op1: { state: "queued", updatedAt: Date.now() } };
    let detailPolls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "http://localhost/api/wdev/components") return jsonResponse(INVENTORY);
      if (url === "http://localhost/api/wdev/operations" && method === "GET") {
        return jsonResponse({ operations: Object.entries(ledger).map(([operationId, detail]) => ({
          operationId, componentId: "llm-proxy", action: "restart", state: detail.state,
          submittedAt: detail.updatedAt, updatedAt: detail.updatedAt,
        })) });
      }
      if (url === "http://localhost/api/wdev/operations" && method === "POST") return jsonResponse({ operationId: "op1", state: "queued", componentId: "llm-proxy", action: "restart", submittedAt: Date.now() }, 202);
      if (url.includes("/api/wdev/operations/") && method === "GET") {
        detailPolls += 1;
        return jsonResponse({ operationId: "op1", componentId: "llm-proxy", action: "restart", state: ledger.op1!.state, updatedAt: ledger.op1!.updatedAt });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const container = testWindow.document.createElement("div") as unknown as HTMLElement;
    testWindow.document.body.appendChild(container as never);
    const root = await mount(container);
    try {
      await act(async () => { buttonByText(container, "Restart").click(); });
      await flush();
      await act(async () => { buttonByText(container, "Submit").click(); });
      await flush();
      ledger.op1 = { state: phase, updatedAt: Date.now() };
      await advance(2_100);
      const badge = [...container.querySelectorAll(".wdev-state-row span.badge")]
        .map(el => (el.textContent ?? "").trim())
        .find(text => text.includes(labelPart));
      expect(badge, phase).toBeTruthy();
      expect(badge).toContain(phase === "rolled_back" ? "restored" : "not restored");
      expect(container.textContent).not.toContain("Cancelled");
      const pollsAtTerminal = detailPolls;
      await advance(2_100);
      expect(detailPolls, phase).toBe(pollsAtTerminal);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  }
}, 30_000);

test("an unknown phase from a newer manager keeps polling and shows its raw name", async () => {
  const ledger: Record<string, { state: string; updatedAt: number }> = { op1: { state: "queued", updatedAt: Date.now() } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "http://localhost/api/wdev/components") return jsonResponse(INVENTORY);
    if (url === "http://localhost/api/wdev/operations" && method === "GET") {
      return jsonResponse({ operations: Object.entries(ledger).map(([operationId, detail]) => ({
        operationId, componentId: "llm-proxy", action: "restart", state: detail.state,
        submittedAt: detail.updatedAt, updatedAt: detail.updatedAt,
      })) });
    }
    if (url === "http://localhost/api/wdev/operations" && method === "POST") return jsonResponse({ operationId: "op1", state: "queued", componentId: "llm-proxy", action: "restart", submittedAt: Date.now() }, 202);
    if (url.includes("/api/wdev/operations/") && method === "GET") {
      return jsonResponse({ operationId: "op1", componentId: "llm-proxy", action: "restart", state: ledger.op1!.state, updatedAt: ledger.op1!.updatedAt });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  const root = await mount(container);
  try {
    await act(async () => { buttonByText(container, "Restart").click(); });
    await flush();
    await act(async () => { buttonByText(container, "Submit").click(); });
    await flush();
    ledger.op1 = { state: "frobnicate", updatedAt: Date.now() };
    await advance(2_100);
    const badge = [...container.querySelectorAll(".wdev-state-row span.badge")]
      .map(el => (el.textContent ?? "").trim())
      .find(text => text.includes("frobnicate"));
    expect(badge).toBeTruthy();
    expect(container.textContent).not.toContain("Cancelled");
    expect(container.textContent).toContain("polling");
    ledger.op1 = { state: "succeeded", updatedAt: Date.now() };
    await advance(2_100);
    expect(container.textContent).toContain("succeeded");
  } finally {
    await act(async () => { root.unmount(); });
  }
}, 30_000);

test("the inventory table header carries one column per body cell (status aligned)", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/wdev/components")) return jsonResponse(INVENTORY);
    if (String(input).endsWith("/api/wdev/operations")) return jsonResponse({ operations: [] });
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  const root = await mount(container);
  try {
    const inventoryTable = container.querySelector("table")!;
    const headerCells = [...inventoryTable.querySelectorAll("thead th")].map(th => (th.textContent ?? "").trim());
    // The status badge lives in its own cell: the header must name every column the
    // body row renders, in order, so no column pair can shift by one.
    expect(headerCells).toEqual(["Components", "Status", "Unit", "URL", "Release", "Actions"]);
    const bodyCells = inventoryTable.querySelectorAll("tbody tr:first-child td").length;
    expect(bodyCells).toBe(headerCells.length);
    // The actions header is the page's own key: the Dashboard label reads "Proxy" and
    // must never ride into this table.
    expect(container.textContent).not.toContain("Proxy");
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("a failed submit shows the code and status, never the transport detail", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/wdev/components")) return jsonResponse(INVENTORY);
    if (url.endsWith("/api/wdev/operations") && (init?.method ?? "GET") === "GET") return jsonResponse({ operations: [] });
    if (url.endsWith("/api/wdev/operations")) {
      // The proxy contract: a fixed phrase + code; stderr never reaches this layer.
      return jsonResponse({ error: "wdev manager command failed", code: "manager_exit" }, 502);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  const root = await mount(container);
  try {
    await act(async () => { buttonByText(container, "Restart").click(); });
    await flush();
    await act(async () => { buttonByText(container, "Submit").click(); });
    await flush();
    const notice = [...container.querySelectorAll("*")].map(el => el.textContent ?? "")
      .find(text => text.includes("not submitted"));
    expect(notice).toBeTruthy();
    expect(notice).toContain("manager_exit");
    expect(notice).toContain("502");
    // Operator-facing reason only: no transport prose, no raw upstream text.
    expect(notice).not.toContain("command failed");
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("a disabled manager renders the notice and no operation controls", async () => {
  globalThis.fetch = (async () => jsonResponse({ error: "wdev manager disabled", code: "wdev_disabled" }, 404)) as typeof fetch;

  const container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  const root = await mount(container);
  try {
    expect(container.textContent).toContain("wdev manager");
    for (const label of ["Restart", "Upgrade", "Configure"]) {
      expect([...container.querySelectorAll<HTMLButtonElement>("button")].some(b => (b.textContent ?? "").trim() === label)).toBe(false);
    }
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("upgrade and configure bodies carry the action's required fields only", () => {
  const base: WdevDraft = {
    componentId: "web", action: "restart", idempotencyKey: "key-1",
    manifestPath: "", configPatchText: "", expectedRevision: "", maxWaitText: "",
  };
  expect(buildOperationBody(base)).toEqual({ componentId: "web", action: "restart", idempotencyKey: "key-1" });
  expect(buildOperationBody({ ...base, action: "upgrade", manifestPath: "m.json", expectedRevision: "41", maxWaitText: "900" }))
    .toEqual({ componentId: "web", action: "upgrade", idempotencyKey: "key-1", manifestPath: "m.json", expectedRevision: "41", maxWait: 600 });
  expect(buildOperationBody({ ...base, action: "configure", configPatchText: '{"a":1}', expectedRevision: "41" }))
    .toEqual({ componentId: "web", action: "configure", idempotencyKey: "key-1", configPatch: { a: 1 }, expectedRevision: "41" });
});
