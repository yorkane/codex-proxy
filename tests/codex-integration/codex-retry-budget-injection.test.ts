import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import {
  CODEX_REQUEST_MAX_RETRIES_ENV,
  CODEX_STREAM_MAX_RETRIES_ENV,
  CODEX_RETRY_MAX_RETRIES_LIMIT,
  DEFAULT_CODEX_REQUEST_MAX_RETRIES,
  DEFAULT_CODEX_STREAM_MAX_RETRIES,
  codexRetryBudget,
} from "../../src/lib/codex-retry-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

/**
 * Codex 客户端重试预算的注入契约（fork 新增）。
 *
 * 现场：代理过载返回 SSE 体内 response.failed 时，codex-rs 的重试次数由
 * [model_providers.opencodex] 的 stream_max_retries 决定（默认 5），HTTP 层读
 * request_max_retries（默认 4），且客户端没有环境变量覆盖——只能来自 config.toml。
 * 本文件钉住三件事：
 * 1. leaf 解析（默认 10、env 覆盖、0 合法、非法回落默认、小数取整、env 钳到 100）；
 * 2. 注入器把两行写进 owned 表、幂等、restore 干净移除；
 * 3. 用户显式值优先：owned 表里手写的同名键原样搬运过每轮剥离重写，env 只填没写的键。
 *
 * 注入跑子进程（CODEX_HOME/OPENCODEX_HOME 隔离到临时目录，让模块级路径常量绑定 fixture，
 * 与 codex-inject-integration.test.ts 同一模式），env 覆盖也必须在子进程里真实生效。
 */

const AUTHLESS_CONFIG = JSON.stringify({ codexDesktopAuthless: true });

function runInject(
  codexHome: string,
  ocxHome: string,
  configJson: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; status: number } {
  const script = [
    'const { injectCodexConfig } = require("./src/codex/inject");',
    'injectCodexConfig(10100, JSON.parse(process.env.TEST_OCX_CONFIG)).then(r => {',
    '  console.log(JSON.stringify(r));',
    '});',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: ocxHome,
      CODEX_SQLITE_HOME: "",
      TEST_OCX_CONFIG: configJson,
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  return { stdout: result.stdout?.trim() ?? "", status: result.status ?? 1 };
}

function runRestore(codexHome: string, ocxHome: string): number {
  const script = [
    'const { restoreNativeCodex } = require("./src/codex/inject");',
    'console.log(JSON.stringify(restoreNativeCodex()));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot(),
    env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, CODEX_SQLITE_HOME: "" },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  return result.status ?? 1;
}

describe("codexRetryBudget env parsing", () => {
  test("defaults to 10/10 with a clean environment", () => {
    expect(codexRetryBudget({})).toEqual({
      requestMaxRetries: DEFAULT_CODEX_REQUEST_MAX_RETRIES,
      streamMaxRetries: DEFAULT_CODEX_STREAM_MAX_RETRIES,
    });
    expect(codexRetryBudget({ [CODEX_REQUEST_MAX_RETRIES_ENV]: "", [CODEX_STREAM_MAX_RETRIES_ENV]: "   " }))
      .toEqual({ requestMaxRetries: 10, streamMaxRetries: 10 });
  });

  test("env overrides per key, halves independent", () => {
    expect(codexRetryBudget({ [CODEX_REQUEST_MAX_RETRIES_ENV]: "3" }))
      .toEqual({ requestMaxRetries: 3, streamMaxRetries: 10 });
    expect(codexRetryBudget({ [CODEX_STREAM_MAX_RETRIES_ENV]: "25" }))
      .toEqual({ requestMaxRetries: 10, streamMaxRetries: 25 });
  });

  test("0 is a legitimate value meaning no retries", () => {
    expect(codexRetryBudget({ [CODEX_REQUEST_MAX_RETRIES_ENV]: "0", [CODEX_STREAM_MAX_RETRIES_ENV]: "0" }))
      .toEqual({ requestMaxRetries: 0, streamMaxRetries: 0 });
  });

  test("invalid values fall back to the default, never to zero", () => {
    for (const raw of ["abc", "-4", "NaN", "Infinity", "-0.5", "1e400"]) {
      expect(codexRetryBudget({ [CODEX_REQUEST_MAX_RETRIES_ENV]: raw }).requestMaxRetries).toBe(10);
    }
  });

  test("decimals floor down", () => {
    expect(codexRetryBudget({ [CODEX_REQUEST_MAX_RETRIES_ENV]: "7.9" }).requestMaxRetries).toBe(7);
    expect(codexRetryBudget({ [CODEX_STREAM_MAX_RETRIES_ENV]: "12.2" }).streamMaxRetries).toBe(12);
  });

  test("env values above the client ceiling clamp to 100", () => {
    expect(codexRetryBudget({ [CODEX_REQUEST_MAX_RETRIES_ENV]: "1000" }).requestMaxRetries)
      .toBe(CODEX_RETRY_MAX_RETRIES_LIMIT);
    expect(codexRetryBudget({ [CODEX_STREAM_MAX_RETRIES_ENV]: "100.9" }).streamMaxRetries)
      .toBe(CODEX_RETRY_MAX_RETRIES_LIMIT);
    expect(CODEX_RETRY_MAX_RETRIES_LIMIT).toBe(100);
  });
});

describe("provider-table injection of the retry budget", () => {
  let root = "";
  let codexHome = "";
  let ocxHome = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-retry-budget-"));
    codexHome = join(root, "codex");
    ocxHome = join(root, "ocx");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(ocxHome, { recursive: true });
  });

  afterEach(() => removeTreeWithRetry(root));

  const configPath = () => readFileSync(join(codexHome, "config.toml"), "utf8");
  const seed = () => writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
  const editConfig = (from: string, to: string) =>
    writeFileSync(join(codexHome, "config.toml"), configPath().replace(from, to), "utf8");

  test("the owned provider table carries request_max_retries = 10 and stream_max_retries = 10", () => {
    seed();
    const r = runInject(codexHome, ocxHome, AUTHLESS_CONFIG);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);

    const content = configPath();
    expect(content).toContain("[model_providers.opencodex]");
    expect(content).toContain("request_max_retries = 10\n");
    expect(content).toContain("stream_max_retries = 10\n");

    // 两行落在 provider 表内，且是整数——按 TOML 消费方（codex-rs）读到的形状断言。
    const parsed = Bun.TOML.parse(content) as { model_providers: { opencodex: Record<string, unknown> } };
    expect(parsed.model_providers.opencodex.request_max_retries).toBe(10);
    expect(parsed.model_providers.opencodex.stream_max_retries).toBe(10);
  });

  test("env overrides the written values, per key", () => {
    seed();
    const r = runInject(codexHome, ocxHome, AUTHLESS_CONFIG, {
      [CODEX_REQUEST_MAX_RETRIES_ENV]: "25",
      [CODEX_STREAM_MAX_RETRIES_ENV]: "0",
    });
    expect(r.status).toBe(0);
    const content = configPath();
    expect(content).toContain("request_max_retries = 25\n");
    expect(content).toContain("stream_max_retries = 0\n");
  });

  test("an env value above the client ceiling is clamped in the written file", () => {
    seed();
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG, { [CODEX_REQUEST_MAX_RETRIES_ENV]: "1000" }).status).toBe(0);
    expect(configPath()).toContain("request_max_retries = 100\n");
  });

  test("re-injection is idempotent: one line per key, byte-stable file", () => {
    seed();
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG).status).toBe(0);
    const first = configPath();
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG).status).toBe(0);
    const second = configPath();
    expect(second).toBe(first);
    expect((second.match(/request_max_retries/g) ?? []).length).toBe(1);
    expect((second.match(/stream_max_retries/g) ?? []).length).toBe(1);
  });

  test("restore removes both lines together with the owned table", () => {
    seed();
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG).status).toBe(0);
    expect(configPath()).toContain("request_max_retries = 10\n");
    expect(runRestore(codexHome, ocxHome)).toBe(0);
    const restored = configPath();
    expect(restored).not.toContain("request_max_retries");
    expect(restored).not.toContain("stream_max_retries");
    expect(restored).not.toContain("[model_providers.opencodex]");
    expect(restored).toContain('model = "gpt-5.5"');
  });

  test("a user-written value in the owned table survives every later sync at its own value", () => {
    // 235 现场形态：注入器先写表（10/10），用户再把 stream 手改成 30。
    seed();
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG).status).toBe(0);
    expect(configPath()).toContain("stream_max_retries = 10\n");
    editConfig("stream_max_retries = 10\n", "stream_max_retries = 30\n");

    // env 想写 25：request 是注入器拥有的行，照改；stream 已被用户拥有，按用户值搬运。
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG, { [CODEX_REQUEST_MAX_RETRIES_ENV]: "25" }).status).toBe(0);
    expect(configPath()).toContain("request_max_retries = 25\n");
    expect(configPath()).toContain("stream_max_retries = 30\n");

    // 下一轮 sync 没有 env：request 回默认 10，用户的 30 原样保留。
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG).status).toBe(0);
    const settled = configPath();
    expect(settled).toContain("request_max_retries = 10\n");
    expect(settled).toContain("stream_max_retries = 30\n");
    expect((settled.match(/stream_max_retries/g) ?? []).length).toBe(1);
  });

  test("a claimed value written under an env override survives removing the env later", () => {
    // 认领的持久性（journal 双份证据）：env=25 轮里用户值是 30（被 env 压制写的是 25 行），
    // 撤掉 env 后必须回到用户的 30，而不是注入默认 10。
    seed();
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG).status).toBe(0);
    editConfig("stream_max_retries = 10\n", "stream_max_retries = 30\n");
    // env 轮：env 压过认领，写 25；认领记录仍留在 journal。
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG, { [CODEX_STREAM_MAX_RETRIES_ENV]: "25" }).status).toBe(0);
    expect(configPath()).toContain("stream_max_retries = 25\n");
    // env 撤掉：回到用户认领的 30。
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG).status).toBe(0);
    expect(configPath()).toContain("stream_max_retries = 30\n");
  });

  test("a user value above the env ceiling is carried verbatim; codex clamps on read", () => {
    seed();
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG).status).toBe(0);
    editConfig("stream_max_retries = 10\n", "stream_max_retries = 500\n");
    expect(runInject(codexHome, ocxHome, AUTHLESS_CONFIG).status).toBe(0);
    expect(configPath()).toContain("stream_max_retries = 500\n");
  });
});

