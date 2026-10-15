/**
 * 明文 V2 协作消息总闸在 Shadow 管理面的接线（fork 追加）。
 *
 * plaintextV2AgentMessages 是顶层 config 字段，本页是它唯一的编辑面：此前只能手改
 * config.json 并重启。本文件锁住三件会静默回归的事：GET 投影该字段；PUT 同时改写
 * live config 对象（热生效、无需重启）并落盘；非布尔被 400 拒绝，而不是被 schema 的
 * .catch(undefined) 悄悄吃掉。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// 隔离 OPENCODEX_HOME 是强制的：路由走真实的 saveConfigPreservingClaudeCode，
// 不隔离会把测试写进开发者自己的 config.json。
const previousHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-shadow-pv2-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

function fixtureConfig(): OcxConfig {
  return { port: 0, defaultProvider: "xai", providers: {} } as OcxConfig;
}

async function shadowApi(config: OcxConfig, method: "GET" | "PUT", body?: unknown): Promise<Response> {
  // 管理 API 有同源门：无浏览器调用方必须伪装成本机来源。
  const headers: Record<string, string> = { origin: "http://127.0.0.1:10100", host: "127.0.0.1:10100" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request("http://localhost/api/shadow-call-settings", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  expect(res).not.toBeNull();
  return res!;
}

async function settingsBody(config: OcxConfig): Promise<Record<string, unknown>> {
  const res = await shadowApi(config, "GET");
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

function persistedConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
}

describe("shadow-call settings API plaintextV2AgentMessages", () => {
  test("GET 默认报告 false，开启后报告 true", async () => {
    const config = fixtureConfig();
    expect(await settingsBody(config)).toMatchObject({ plaintextV2AgentMessages: false });
    expect((await shadowApi(config, "PUT", { plaintextV2AgentMessages: true })).status).toBe(200);
    expect(await settingsBody(config)).toMatchObject({ plaintextV2AgentMessages: true });
  });

  test("PUT 一次调用同时改写 live config 并落盘", async () => {
    const config = fixtureConfig();
    // 请求管线读的是运行中服务持有的这个 config 对象本身，所以改写该引用即下一请求生效。
    const put = await shadowApi(config, "PUT", { plaintextV2AgentMessages: true });
    expect(put.status).toBe(200);
    expect((await put.json()).plaintextV2AgentMessages).toBe(true);
    expect(config.plaintextV2AgentMessages).toBe(true);
    expect(persistedConfig().plaintextV2AgentMessages).toBe(true);

    const off = await shadowApi(config, "PUT", { plaintextV2AgentMessages: false });
    expect((await off.json()).plaintextV2AgentMessages).toBe(false);
    expect(config.plaintextV2AgentMessages).toBe(false);
    expect(persistedConfig().plaintextV2AgentMessages).toBe(false);
  });

  test("PUT 拒绝非布尔而不是强制转换", async () => {
    const config = fixtureConfig();
    await shadowApi(config, "PUT", { plaintextV2AgentMessages: true });
    for (const bad of ["true", 1, 0, null, {}, []]) {
      const res = await shadowApi(config, "PUT", { plaintextV2AgentMessages: bad });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("plaintextV2AgentMessages must be a boolean");
    }
    // 被拒绝的写入既不进 live 值也不进落盘文件。
    expect(config.plaintextV2AgentMessages).toBe(true);
    expect(persistedConfig().plaintextV2AgentMessages).toBe(true);
  });

  test("缺该键的 PUT 不动存量开关", async () => {
    const config = fixtureConfig();
    await shadowApi(config, "PUT", { plaintextV2AgentMessages: true });
    const res = await shadowApi(config, "PUT", { phantomToolAllowlistEnabled: false });
    expect(res.status).toBe(200);
    expect((await res.json()).plaintextV2AgentMessages).toBe(true);
    expect(persistedConfig().plaintextV2AgentMessages).toBe(true);
  });

  test("影子拦截关闭时总闸照常可切", async () => {
    const config = fixtureConfig();
    expect(config.shadowCallIntercept?.enabled ?? false).toBe(false);
    const res = await shadowApi(config, "PUT", { plaintextV2AgentMessages: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, plaintextV2AgentMessages: true });
  });
});
