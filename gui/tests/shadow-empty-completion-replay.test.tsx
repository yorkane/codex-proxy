/**
 * The Shadow page's "Empty completion replay" section — mounted behaviour.
 *
 * The switch exists because the field is TOP-LEVEL config with no other edit surface: an
 * operator had to hand-edit config.json and restart. What a source-string assertion cannot
 * see is the wiring this locks: the switch reflects the value the server reported, a click
 * PUTs exactly { emptyCompletionRetry: <next> }, and a rejected write surfaces the server's
 * reason in the toast instead of silently reverting (the saveShadowCall contract).
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
let settings: Record<string, unknown> = { enabled: false, model: "", emptyCompletionRetry: true };
let putStatus = 200;
let putError = "";

function installFetch(): void {
  puts.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/shadow-call-settings")) {
      if (String(init?.method ?? "GET").toUpperCase() === "PUT") {
        puts.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        if (putStatus !== 200) return Response.json({ error: putError }, { status: putStatus });
        settings = { ...settings, ...(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>) };
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
  const heading = [...container.querySelectorAll("h3")].find(h => h.textContent?.includes("Empty completion replay"));
  const host = heading?.parentElement;
  if (!host) throw new Error("Missing 'Empty completion replay' section");
  return host;
}

const replaySwitch = (container: HTMLElement) =>
  section(container).querySelector<HTMLButtonElement>('button.switch[aria-label="Enable"]')!;
const replayCountInput = (container: HTMLElement) =>
  section(container).querySelector<HTMLInputElement>('input[type="number"][aria-label="Empty completion replays"]')!;

async function setCount(container: HTMLElement, value: string): Promise<void> {
  const input = replayCountInput(container);
  await act(async () => {
    // React tracks the value on the native setter, so assigning .value directly would make the
    // change handler see no delta (same reason the pool tests use the prototype setter).
    const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
    await flush();
  });
}

/** Select-all then backspace, the way someone actually retypes the number. */
async function clearCount(container: HTMLElement): Promise<string> {
  const input = replayCountInput(container);
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "");
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
    await flush();
  });
  return input.value;
}

async function blurCount(container: HTMLElement): Promise<void> {
  const input = replayCountInput(container);
  await act(async () => {
    input.blur();
    input.dispatchEvent(new testWindow.Event("focusout", { bubbles: true }) as unknown as Event);
    await flush();
  });
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
  settings = { enabled: false, model: "", emptyCompletionRetry: true };
  putStatus = 200;
  putError = "";
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("the section renders while interception is off and follows the reported state", async () => {
  const { container, root } = await mountShadow();
  try {
    // The guard is top-level config: an intercept-off server still exposes the switch.
    expect(replaySwitch(container).getAttribute("aria-pressed")).toBe("true");
  } finally {
    await act(async () => root.unmount());
  }
});

test("clicking the switch PUTs only the replay field", async () => {
  const { container, root } = await mountShadow();
  try {
    await act(async () => { replaySwitch(container).click(); });
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual({ emptyCompletionRetry: false });
    expect(replaySwitch(container).getAttribute("aria-pressed")).toBe("false");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a rejected write surfaces the server's reason", async () => {
  putStatus = 400;
  putError = "emptyCompletionRetry must be a boolean";
  const { container, root } = await mountShadow();
  try {
    await act(async () => { replaySwitch(container).click(); });
    await flush();
    const toast = document.body.querySelector(".toast-notice");
    expect(toast?.textContent).toContain(putError);
  } finally {
    await act(async () => root.unmount());
  }
});

test("the env override is announced next to the switch", async () => {
  settings = { enabled: false, model: "", emptyCompletionRetry: true, emptyCompletionRetryEnvOverride: true };
  const { container, root } = await mountShadow();
  try {
    expect(section(container).textContent).toContain("OCX_EMPTY_COMPLETION_RETRY=0");
  } finally {
    await act(async () => root.unmount());
  }
});

// ---- the replay budget input beside the switch ----

test("the count input reflects the budget the server resolved", async () => {
  settings = { enabled: false, model: "", emptyCompletionRetry: true, emptyCompletionRetryMax: 2 };
  const { container, root } = await mountShadow();
  try {
    expect(replayCountInput(container).value).toBe("2");
    // The copy follows the number rather than always claiming "once".
    expect(section(container).textContent).toContain("up to 2 times");
    expect(section(container).textContent).not.toContain("up to 1 times");
  } finally {
    await act(async () => root.unmount());
  }
});

test("changing the count PUTs only the budget field", async () => {
  const { container, root } = await mountShadow();
  try {
    await setCount(container, "3");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual({ emptyCompletionRetryMax: 3 });
    expect(replayCountInput(container).value).toBe("3");
  } finally {
    await act(async () => root.unmount());
  }
});

// Regression: the guard against Number("") === 0 used to return from onChange without touching
// state, so React re-rendered the old value and the field could never be cleared. A read-only-
// looking box is worse than a missing guard: nobody can retype the number at all.
test("the field can be cleared and retyped instead of snapping back", async () => {
  settings = { enabled: false, model: "", emptyCompletionRetry: true, emptyCompletionRetryMax: 2 };
  const { container, root } = await mountShadow();
  try {
    expect(replayCountInput(container).value).toBe("2");
    const cleared = await clearCount(container);
    expect(cleared).toBe("");
    // Nothing was written by the act of clearing.
    expect(puts).toHaveLength(0);
    await setCount(container, "3");
    expect(replayCountInput(container).value).toBe("3");
    expect(puts).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
  }
});

test("an out-of-range draft snaps back to the saved value on blur, without a PUT", async () => {
  settings = { enabled: false, model: "", emptyCompletionRetry: true, emptyCompletionRetryMax: 2 };
  const { container, root } = await mountShadow();
  try {
    await clearCount(container);
    await setCount(container, "9");
    expect(puts).toHaveLength(0);
    await blurCount(container);
    expect(replayCountInput(container).value).toBe("2");
    expect(puts).toHaveLength(0);
    // The refusal is announced in the page-level toast, which renders outside the container.
    expect(document.body.querySelector(".toast-notice")?.textContent).toContain("whole number between");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a value outside the accepted bounds is refused locally and never PUT", async () => {
  const { container, root } = await mountShadow();
  try {
    // Each rejection must produce NO request at all — the point is that the browser never sends a
    // value the server would answer with 400, so the number the operator sees is a number that sticks.
    for (const bad of ["9", "-1", "1.5", "abc"]) {
      await setCount(container, bad);
      expect(puts.length).toBe(0);
    }
    // A value back inside the range still works after the refusals.
    await setCount(container, "2");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual({ emptyCompletionRetryMax: 2 });
  } finally {
    await act(async () => root.unmount());
  }
});

test("a zero budget explains that it means the same as the switch being off", async () => {
  settings = { enabled: false, model: "", emptyCompletionRetry: true, emptyCompletionRetryMax: 0 };
  const { container, root } = await mountShadow();
  try {
    expect(replayCountInput(container).value).toBe("0");
    expect(section(container).textContent).toContain("nothing is replayed");
    // The switch is still on, so the section must say the two settings disagree.
    expect(replaySwitch(container).getAttribute("aria-pressed")).toBe("true");
  } finally {
    await act(async () => root.unmount());
  }
});

test("an environment-controlled budget is announced", async () => {
  settings = {
    enabled: false, model: "", emptyCompletionRetry: true,
    emptyCompletionRetryMax: 3, emptyCompletionRetryMaxEnvOverride: true,
  };
  const { container, root } = await mountShadow();
  try {
    expect(section(container).textContent).toContain("OCX_EMPTY_COMPLETION_RETRY_MAX");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a rejected budget write surfaces the server's reason", async () => {
  putStatus = 400;
  putError = "emptyCompletionRetryMax must be an integer 0-3";
  const { container, root } = await mountShadow();
  try {
    await setCount(container, "2");
    expect(puts).toHaveLength(1); // the write really went out before being refused
    const toast = document.body.querySelector(".toast-notice");
    expect(toast === null).toBe(false);
    expect(String(toast?.textContent)).toContain(putError);
  } finally {
    await act(async () => root.unmount());
  }
});
