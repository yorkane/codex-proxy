/**
 * Shadow 页 "Plaintext V2 agent messages" 一节的挂载行为（fork 追加）。
 *
 * 该开关存在的原因：plaintextV2AgentMessages 是顶层 config 字段，此前没有别的编辑面，
 * 运维只能手改 config.json 加重启。源码字符串断言看不到这里锁住的接线：开关反映服务端
 * 报告的值、点击恰好 PUT { plaintextV2AgentMessages: <next> }、被拒绝的写入把服务端原因
 * 显示在 toast 里而不是静默回滚（saveShadowCall 契约）。
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
let settings: Record<string, unknown> = { enabled: false, model: "" };
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
  const heading = [...container.querySelectorAll("h3")].find(h => h.textContent?.includes("Plaintext V2 agent messages"));
  const host = heading?.parentElement;
  if (!host) throw new Error("Missing 'Plaintext V2 agent messages' section");
  return host;
}

const pv2Switch = (container: HTMLElement) =>
  section(container).querySelector<HTMLButtonElement>('button.switch[aria-label="Enable"]')!;

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
  settings = { enabled: false, model: "" };
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

test("服务端缺省该字段时开关渲染为关闭", async () => {
  const { container, root } = await mountShadow();
  try {
    // 缺省即关闭：新服务器没这个键时页面不得显示为已启用。
    expect(pv2Switch(container).getAttribute("aria-pressed")).toBe("false");
  } finally {
    await act(async () => root.unmount());
  }
});

test("影子拦截关闭时开关照常渲染并跟随服务端值", async () => {
  settings = { enabled: false, model: "", plaintextV2AgentMessages: true };
  const { container, root } = await mountShadow();
  try {
    // 总闸是顶层配置：拦截关着的服务器同样暴露这个开关。
    expect(pv2Switch(container).getAttribute("aria-pressed")).toBe("true");
  } finally {
    await act(async () => root.unmount());
  }
});

test("点击开关只 PUT 明文字段", async () => {
  const { container, root } = await mountShadow();
  try {
    await act(async () => { pv2Switch(container).click(); });
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual({ plaintextV2AgentMessages: true });
    expect(pv2Switch(container).getAttribute("aria-pressed")).toBe("true");
  } finally {
    await act(async () => root.unmount());
  }
});

test("被拒绝的写入把服务端原因显示在 toast", async () => {
  putStatus = 400;
  putError = "plaintextV2AgentMessages must be a boolean";
  const { container, root } = await mountShadow();
  try {
    await act(async () => { pv2Switch(container).click(); });
    await flush();
    const toast = document.body.querySelector(".toast-notice");
    expect(toast?.textContent).toContain(putError);
  } finally {
    await act(async () => root.unmount());
  }
});

test("一节文案点名实验性、历史留存与不解密既有任务", async () => {
  const { container, root } = await mountShadow();
  try {
    const text = section(container).textContent ?? "";
    expect(text).toContain("Experimental");
    expect(text).toContain("history");
    expect(text).toContain("does not decrypt");
  } finally {
    await act(async () => root.unmount());
  }
});
