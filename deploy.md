# deploy.md — opencodex fork 安装与配置指南

本 fork 与上游的定位不同：**仓库只做定时上游同步**（`.github/workflows/sync-upstream.yml`，
每天 07:00 UTC 把 lidge-jun/opencodex 合入补丁分支，冲突/测试失败自动开 issue）与
**发布安装包**（`.github/workflows/fork-release.yml`，补丁分支每次非文档 push 自动重建）。
本地产物仅供调试，正式分发一律走 GitHub Release。

## 下载与安装

安装包挂在 Rolling release 上（每次补丁分支更新自动重发，tag 固定）：

```bash
# 1) 下载最新安装包（无需认证）
curl -sL -o opencodex-fork.tgz \
  "https://github.com/yorkane/codex-proxy/releases/download/rolling-fork-build/bitkyc08-opencodex-2.42.0-fork-42c8fd5d6.tgz"

# tag/文件名会随构建变化，稳妥做法：列出 rolling release 拿真实资产 URL
gh release download rolling-fork-build --repo yorkane/codex-proxy --pattern '*.tgz'

# 2) 安装（--allow-scripts=bun 必须带，否则捆绑的 bun 运行时不落盘、服务起不来）
npm install -g --allow-scripts=bun ./opencodex-fork.tgz

# 3) 前台起服务验证
ocx start --port 10100
curl -s http://127.0.0.1:10100/healthz   # 期望 {"status":"ok",...}
```

要求：Node ≥ 18（推荐 20/24）。GUI 管理界面：浏览器打开 `http://127.0.0.1:10100/`。

## 配置（`~/.opencodex/config.json`）

首次运行自动生成。本 fork 的三个定制能力全部可选，默认关闭、不影响上游行为：

1) providers —— 第三方上游（示例）：

```jsonc
{
  "defaultProvider": "my-llm",
  "providers": {
    "my-llm": {
      "baseUrl": "https://your-openai-compatible-host/v1",
      "apiKey": "***",
      "models": ["qwen3-next"],
      // 模型幻觉出的未声明工具名：命中则整条调用被静默剥除，回合正常结束；
      // 名单外的仍 fail-closed(502)。UI 的 provider JSON 编辑器同样可改。
      "undeclaredToolAllowlist": ["update_plan", "web__run"]
    }
  },
  // 2) 影子调用拦截：按 Codex 请求里的来源模型精确替换为第三方模型
  "shadowCallIntercept": {
    "enabled": true,
    "modelMap": { "gpt-5.6-terra": "my-llm/qwen3-next" },
    "sourceModels": ["gpt-5.6-terra"]   // 自定义来源 id 必须同时登记在这里
  },
  // 3) 管理 API 免 token（仅绑定 loopback 时生效）；反代场景再加 disableOriginCheck
  "managementAuthDisabled": true,
  "disableOriginCheck": false
}
```

改完执行 `sudo systemctl restart opencodex-proxy.service`（或前台重跑 `ocx start`）。

## systemd 部署（可选）

```ini
# /etc/systemd/system/opencodex-proxy.service
[Unit]
Description=opencodex fork proxy
After=network-online.target

[Service]
User=<你的用户>
Environment=HOME=/home/<你的用户>
Environment=OCX_SERVICE=1
ExecStart=<node或nvm的bin目录>/ocx start --port 10100
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

注意：`stop → 换包 → start` 必须一次性做完——Restart 策略会在中途拉起孤儿进程占住端口。

## 交给 agent 的 Prompt（复制即用）

把下面整段发给本机上的编码 agent，它会完成下载、安装、配置、验证：

```text
安装 opencodex fork 代理（本 fork 提供 Codex 的第三方模型代理与影子调用拦截）：

1. 下载：gh release download rolling-fork-build --repo yorkane/codex-proxy --pattern '*.tgz' --dir /tmp
   （没有 gh 时用 curl 打开 https://github.com/yorkane/codex-proxy/releases/tag/rolling-fork-build 里的 .tgz）
2. 安装：npm install -g --allow-scripts=bun /tmp/bitkyc08-opencodex-*.tgz
3. 写 ~/.opencodex/config.json：defaultProvider 与 providers 用我提供的 baseUrl/apiKey/models；
   如需 Codex 原生模型改道，配置 shadowCallIntercept.modelMap（来源模型 → provider/model），
   自定义来源模型 id 要同时写进 sourceModels；provider 可选 undeclaredToolAllowlist
   容忍模型幻觉工具名；管理 API 免 token 用 managementAuthDisabled=true（仅 loopback 生效），
   外部反代访问再加 disableOriginCheck=true。
4. 启动并验证：ocx start --port 10100 &（或复用已有 systemd 单元，停→换→起一步做完）；
   curl -s http://127.0.0.1:10100/healthz 应返回 status ok；
   再 POST /v1/responses 发一个带 tools 声明的最小请求，确认工具往返正常、无 502。
5. 报告：healthz 输出、版本号、以及影子映射是否生效（响应里模型是否被替换）。
```

## fork 定制能力速查

| 能力 | 配置键 | 说明 |
|---|---|---|
| 影子调用拦截 | `shadowCallIntercept` | 按来源模型把 Codex 原生模型（luna/sol/terra/5.5/5.4-mini 及自定义）换成任意已配置 provider/model |
| 幽灵工具容忍 | `providers.*.undeclaredToolAllowlist` | 幻觉工具名命中即整条剥除、回合继续；未命中的仍 502 fail-closed |
| 统一工具名修复 | （无需配置） | 内置 emitted-call-guard：可修复的错名自动改写、命名空间误调回喂纠错指令、纯幻影按名单丢弃 |
| 管理面免认证 | `managementAuthDisabled` / `disableOriginCheck` | 本地免 token / 反代放行；默认全关，行为与上游一致 |

更细的设计与运维手册见 fork 运维层仓库根目录的 AGENTS.md / design.md。
