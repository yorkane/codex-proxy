/**
 * The Shadow page's "Model request retries" card — mounted behaviour.
 *
 * The budget is TOP-LEVEL config with no other edit surface, and it is independent of the
 * shadow intercept switch, so the card must render (and stay editable) while interception is
 * off. What this locks is the wiring the copy alone cannot show: the control reflects the value
 * the SERVER resolved, a change PUTs exactly { modelRequestMaxRetries: <n> }, a rejected write
 * surfaces the server's reason, an environment override disables the control and names the
 * variable, and a server that reports no bounds is exposed as "needs a newer proxy" rather than
 * a fake default-3.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Shadow from "../src/pages/Shadow";

const API_BASE = "http://localhost";
const globals = ["document", "window", "navigator", "localStorage", "sessionStorage"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

type Put = { body: Record<string, unknown> };
const puts: Put[] = [];
let settings: Record<string, unknown> = {};
let putStatus = 200;
let putError = "";
// Set to make every fetch reject (the proxy is mid-restart), and to what the PUT 200 echoes
// when the server's resolved DTO differs from the value just saved (env override, clamp).
let fetchThrows = false;
let putEcho: Record<string, unknown> | null = null;
// Set to answer the PUT with 200 and an empty body: the write itself succeeded (the mock, like
// the real server, applies the patch before answering), only the acknowledgement is incomplete.
let putEmptyBody = false;
// Counts GETs on /api/shadow-call-settings after the initial mount load, so a test can prove
// the body-less-200 path really refetches instead of trusting the optimistic value.
let settingsGets = 0;

function installFetch(): void {
  puts.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (fetchThrows) throw new TypeError("fetch failed");
    const url = String(input);
    if (url.includes("/api/shadow-call-settings")) {
      if (String(init?.method ?? "GET").toUpperCase() === "PUT") {
        puts.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        if (putStatus !== 200) return Response.json({ error: putError }, { status: putStatus });
        settings = { ...settings, ...(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>) };
        if (putEmptyBody) return new Response("", { status: 200 });
        if (putEcho) return Response.json({ modelMap: {}, sourceModels: [], ...settings, ...putEcho });
      } else {
        settingsGets++;
      }
      return Response.json({ modelMap: {}, sourceModels: [], ...settings });
    }
    if (url.includes("/api/models")) return Response.json([]);
    if (url.includes("/api/selected-models")) return Response.json({});
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

async function mountShadow(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Shadow apiBase={API_BASE} />);
  });
  await act(async () => { await Promise.resolve(); });
  return { container, root };
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
}

function section(container: HTMLElement): HTMLElement {
  const heading = [...container.querySelectorAll("h3")].find(h => h.textContent?.includes("Model request retries"));
  const host = heading?.parentElement;
  if (!host) throw new Error("Missing 'Model request retries' section");
  return host;
}

const retrySelect = (container: HTMLElement) =>
  section(container).querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Proxy retries"]')!;

/** Opens the listbox and clicks the option whose visible label matches. */
async function chooseOption(container: HTMLElement, label: string): Promise<void> {
  const trigger = retrySelect(container);
  await act(async () => { trigger.click(); });
  await flush();
  const option = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(b => b.textContent?.trim() === label);
  if (!option) throw new Error("No retry option labelled: " + label);
  await act(async () => { option.click(); });
  await flush();
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#shadow" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  settings = {
    enabled: false,
    model: "",
    modelRequestMaxRetries: 3,
    modelRequestMaxRetriesConfigured: 3,
    modelRequestMaxRetriesMin: 0,
    modelRequestMaxRetriesLimit: 5,
    modelRequestMaxRetriesDefault: 3,
  };
  putStatus = 200;
  putError = "";
  fetchThrows = false;
  putEcho = null;
  putEmptyBody = false;
  settingsGets = 0;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("the card renders while interception is off and shows the server-resolved budget", async () => {
  const { container, root } = await mountShadow();
  try {
    expect(retrySelect(container).textContent).toContain("3");
    expect(retrySelect(container).disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

test("choosing a value PUTs only the retry field and keeps the copy honest", async () => {
  const { container, root } = await mountShadow();
  try {
    await chooseOption(container, "1");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual({ modelRequestMaxRetries: 1 });
    expect(retrySelect(container).textContent).toContain("1");
    // The shared hint spells out what N means without the label repeating it.
    expect(section(container).textContent).toContain("(N+1 sends)");
  } finally {
    await act(async () => root.unmount());
  }
});

test("the list offers exactly 0-5 and says what 0 means", async () => {
  const { container, root } = await mountShadow();
  try {
    await act(async () => { retrySelect(container).click(); });
    await flush();
    const labels = [...document.body.querySelectorAll('[role="option"]')].map(o => o.textContent?.trim());
    expect(labels).toEqual(["0 — no retries", "1", "2", "3", "4", "5"]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a zero budget is explained as first send only", async () => {
  settings = { ...settings, modelRequestMaxRetries: 0, modelRequestMaxRetriesConfigured: 0 };
  const { container, root } = await mountShadow();
  try {
    expect(retrySelect(container).textContent).toContain("0");
    expect(section(container).textContent).toContain("No proxy retries");
    expect(section(container).textContent).toContain("first send only");
  } finally {
    await act(async () => root.unmount());
  }
});

test("the copy says client retries are separate, never an end-to-end cap", async () => {
  const { container, root } = await mountShadow();
  try {
    const text = section(container).textContent!;
    expect(text).toContain("Proxy retries");
    expect(text).toContain("Retry model HTTP 4xx/5xx errors up to N times");
    expect(text).toContain("Client retries");
    expect(text).toContain("separate");
    expect(text).toContain("Default 3");
    // Scope, not sales pitch: nothing here claims to cap the whole client+proxy chain.
    expect(/end-to-end/.test(text)).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

test("an environment override disables the control, names the variable, shows the effective value", async () => {
  settings = { ...settings, modelRequestMaxRetries: 5, modelRequestMaxRetriesEnvOverride: true };
  const { container, root } = await mountShadow();
  try {
    expect(retrySelect(container).disabled).toBe(true);
    const text = section(container).textContent!;
    expect(text).toContain("OCX_MODEL_REQUEST_MAX_RETRIES");
    // The number on screen is the effective one; the saved value stays visible separately.
    expect(text).toContain("5 retries (6 sends)");
    expect(text).toContain("Saved value: 3");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a server without the new fields disables the control and asks for an upgrade", async () => {
  settings = { enabled: false, model: "" };
  const { container, root } = await mountShadow();
  try {
    expect(retrySelect(container).disabled).toBe(true);
    const text = section(container).textContent!;
    expect(text).toContain("newer proxy");
    // No pretending the default was honoured by a server that never reported it.
    expect(text).not.toContain("Default is 3 retries");
    await act(async () => { retrySelect(container).click(); });
    await flush();
    expect(puts).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a rejected write surfaces the server's reason", async () => {
  putStatus = 400;
  putError = "modelRequestMaxRetries must be an integer 0-5";
  const { container, root } = await mountShadow();
  try {
    await chooseOption(container, "2");
    expect(puts).toHaveLength(1);
    const toast = document.body.querySelector(".toast-notice");
    expect(toast?.textContent).toContain(putError);
    // Rollback is inherited from saveShadowCall: the rejected PUT leaves the mock's settings
    // untouched, and the failure path refetches, so the control snaps back to the old
    // server-resolved value rather than keeping the number that was refused.
    expect(retrySelect(container).textContent).toContain("3");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a server error rolls the control back to the saved value", async () => {
  putStatus = 500;
  putError = "config write failed";
  const { container, root } = await mountShadow();
  try {
    await chooseOption(container, "5");
    expect(retrySelect(container).textContent).toContain("3");
    expect(document.body.querySelector(".toast-notice")?.textContent).toContain("config write failed");
  } finally {
    await act(async () => root.unmount());
  }
});

// The optimistic merge is a preview, not the truth. The rollback is a snapshot, not a refetch:
// with the proxy down the PUT and the follow-up GET both fail, so a refetch-only design would
// leave the picked number on screen as if it had been stored.
test("a network failure rolls back from the snapshot and says the proxy was unreachable", async () => {
  const { container, root } = await mountShadow();
  try {
    fetchThrows = true;
    await chooseOption(container, "4");
    const toast = document.body.querySelector(".toast-notice");
    expect(toast?.textContent).toContain("cannot reach the proxy");
    expect(retrySelect(container).textContent).toContain("3");
  } finally {
    await act(async () => root.unmount());
  }
});

// The snapshot rollback fires on HTTP/network failure; a 200 with an empty body is a write that
// the server already applied, so the honest display is the refetched value, not the pre-save
// snapshot. The toast stays as the "incomplete acknowledgement" notice.
test("an empty PUT body triggers a refetch and shows the server-confirmed saved value", async () => {
  const { container, root } = await mountShadow();
  try {
    const getsBefore = settingsGets;
    putEmptyBody = true;
    await chooseOption(container, "5");
    expect(puts).toHaveLength(1);
    const toast = document.body.querySelector(".toast-notice");
    expect(toast?.textContent).toContain("no settings");
    expect(settingsGets).toBeGreaterThan(getsBefore);
    expect(retrySelect(container).textContent).toContain("5");
  } finally {
    await act(async () => root.unmount());
  }
});

test("the PUT response wins, so an override that appeared mid-save becomes visible", async () => {
  const { container, root } = await mountShadow();
  try {
    putEcho = { modelRequestMaxRetries: 5, modelRequestMaxRetriesEnvOverride: true };
    await chooseOption(container, "2");
    // The server said the effective budget is 5 via the environment, so that is what shows and
    // the control locks - the saved 2 is not presented as the live value.
    expect(retrySelect(container).textContent).toContain("5");
    expect(retrySelect(container).disabled).toBe(true);
    expect(section(container).textContent).toContain("OCX_MODEL_REQUEST_MAX_RETRIES");
  } finally {
    await act(async () => root.unmount());
  }
});

test("the retry card sits above the empty-completion replay card", async () => {
  const { container, root } = await mountShadow();
  try {
    const headings = [...container.querySelectorAll("h3")].map(h => h.textContent);
    const retryIndex = headings.findIndex(h => h?.includes("Model request retries"));
    const replayIndex = headings.findIndex(h => h?.includes("Empty completion replay"));
    expect(retryIndex).toBeGreaterThan(-1);
    expect(replayIndex).toBeGreaterThan(-1);
    expect(retryIndex).toBeLessThan(replayIndex);
  } finally {
    await act(async () => root.unmount());
  }
});
