# deploy.md — opencodex fork 安装与配置指南

本 fork 与上游的定位不同：**仓库只做定时上游同步**（`.github/workflows/sync-upstream.yml`，
每天 07:00 UTC 把 lidge-jun/opencodex 合入补丁分支，冲突/测试失败自动开 issue）与
**发布安装包**（`.github/workflows/fork-release.yml`，补丁分支每次非文档 push 自动重建）。
本地产物仅供调试，正式分发一律走 GitHub Release。

当前基线：上游 v2.78.0，补丁分支 `codex/shadow-call-per-source-modelmap`。

## 下载与安装

安装包挂在 Rolling release 上（每次补丁分支更新自动重发，tag 固定，**文件名里的版本号与短 sha
随构建变化**，所以别写死 URL）：

```bash
# 1) 下载最新安装包（无需认证）
gh release download rolling-fork-build --repo yorkane/codex-proxy --pattern '*.tgz' --dir /tmp

# 没有 gh 时：先查真实资产名，再拼 URL（别照抄历史里的旧文件名）
curl -s https://api.github.com/repos/yorkane/codex-proxy/releases/tags/rolling-fork-build \
  | grep browser_download_url | grep tgz
curl -sL -o /tmp/opencodex-fork.tgz "<上一条输出的 URL>"

# 2) 安装（--allow-scripts=bun 必须带，否则捆绑的 bun 运行时不落盘、服务起不来）
npm install -g --allow-scripts=bun /tmp/bitkyc08-opencodex-*.tgz

# 3) 前台起服务验证
ocx start --port 10100
curl -s http://127.0.0.1:10100/healthz   # 期望 {"status":"ok","version":"2.78.0",...}
```

要求：Node ≥ 18（推荐 20/24）。GUI 管理界面：浏览器打开 `http://127.0.0.1:10100/`。

## 配置（`~/.opencodex/config.json`）

首次运行自动生成。本 fork 的定制能力全部可选，默认关闭、不影响上游行为：

```jsonc
{
  "defaultProvider": "my-llm",
  "providers": {
    "my-llm": {
      "baseUrl": "https://your-openai-compatible-host/v1",
      "apiKey": "***",
      "models": ["qwen3-next"],
      // 该模型真实输出上限；调用方的 max_tokens 与之取 min 封顶，防止越界被上游拒
      "defaultMaxOutputTokens": 32768,
      "modelMaxOutputTokens": { "qwen3-next": 131072 }
    }
  },
  // 影子调用拦截：按 Codex 请求里的来源模型精确替换为第三方模型
  "shadowCallIntercept": {
    "enabled": true,
    // 逐来源映射：luna/sol/terra/5.5/5.4-mini 可以各走不同模型
    "modelMap": { "gpt-5.6-terra": "my-llm/qwen3-next", "gpt-5.5": "my-llm/qwen3-next" },
    "model": "my-llm/qwen3-next",              // modelMap 未覆盖的来源走这条兜底；不需要就删掉
    "sourceModels": ["gpt-5.6-terra", "gpt-5.5"],  // 自定义来源 id 必须同时登记在这里
    "phantomToolAllowlistEnabled": true,       // 幻影工具 kill switch（默认 true）
    "phantomToolAllowlist": ["update_plan", "web__run"],  // 不写=内置 9 项默认；显式 []=全 fail-closed
    "phantomToolFeedbackMax": 2                // 0-10；未声明调用的指令纠错预算，0=只丢弃不回喂
  },
  // 空完成重放：上游回了空 completion 时按预算重放，避免回合无输出静默结束
  "emptyCompletionRetry": true,
  "emptyCompletionRetryMax": 1,
  // 外部反代场景：放行反代 origin（供浏览器 gui-session 使用；脚本仍显式带 x-opencodex-api-key）
  "corsAllowOrigins": ["https://your-proxy.example.com"]
}
```

改完执行 `sudo systemctl restart opencodex-proxy.service`（或前台重跑 `ocx start`）。

**已删除字段，别再写**：`providers.*.undeclaredToolAllowlist` 已从 provider 类型与字段策略中移除，
容忍名单改由 `shadowCallIntercept.phantomToolAllowlist` 统一管（幻影名属于**替换模型**，不属于 provider）。
config.json 里残留该字段会让 `PUT /api/providers` 报 non-editable field 400。

## 管理面认证：x-opencodex-api-key 与 authz 免认证

管理 API（`/api/*`）与数据面（`/v1/*`）是两道独立的门，`/healthz` 则完全公开。搞混这两道门是
"网页能开、脚本 401" 这类问题的全部来源。

### 门 1：opencodex 自己的管理令牌（无法绕过）

`requireManagementAuth` 没有 loopback 免凭据分支——**本机裸调 `/api/*` 一样 401**，本机实测：

| 请求 | 结果 |
|---|---|
| `GET http://127.0.0.1:10100/healthz` | 200（公开探针） |
| `GET http://127.0.0.1:10100/api/config` | **401** `opencodex admin token required` |
| 同上，带 `x-opencodex-api-key: <token>` | 200 |
| 同上，带 `Authorization: Bearer <token>` | 200 |

令牌来源优先级：环境变量 `OPENCODEX_ADMIN_AUTH_TOKEN` > `~/.opencodex/admin-api-token` 文件。
env 优先，且**只有 env 能承载任意明文令牌**——文件形态强制 `ocx_admin_` 前缀的生成格式，
手写进去会判非法、管理 API 直接 503。

浏览器不需要手动带令牌：GUI 首次访问由 `issueGuiSession` 签一个 `ocx_session_*` 会话凭据，
之后按 gui-session principal 放行。会话 TTL：回环签发 5 分钟（到期后由页面下次加载重新签发），
远程签发 12 小时并按活动滑动续期；跨 origin 必须匹配签发时的 serverOrigin / browserOrigin，
写操作额外校验 `x-opencodex-csrf-token`。**脚本走不了这条路**，一律显式带 `x-opencodex-api-key`：

```bash
TOKEN=$(sudo sed -n 's/^OPENCODEX_ADMIN_AUTH_TOKEN=//p' /etc/opencodex-proxy.env)
curl -s -H "x-opencodex-api-key: $TOKEN" http://127.0.0.1:10100/api/shadow-call-settings
```

`hostname` 是非回环绑定（如 `0.0.0.0`）时，数据面另外要求一个独立凭据
（`OPENCODEX_API_AUTH_TOKEN` 或 `config.apiKeys`），且不能与管理令牌同值；数据面凭据只用
`x-opencodex-api-key` 提交，绝不进 `Authorization`（后者是转发给上游的槽位）。

> 本机 10100 的 token 在 **EnvironmentFile**（`/etc/opencodex-proxy.env`）里，单元的 `Environment=` 行没有它；
> `~/.opencodex/admin-api-token` 里的值早已失效，不要拿它去试。token 值不得进日志、回复或提交物。

### 门 2：authz 网关托管注入（让调用方免带令牌）

235.t 上的 authz 网关（OpenResty，HTTP 6080 / HTTPS 6443）把 `cc` 前缀绑定到 127.0.0.1:10100，
并在**绑定的"改写请求"（`request_rewrite`）里托管注入** `x-opencodex-api-key`。效果：走 `cc-235.*`
入口的请求不需要自己带 opencodex 令牌，网关在转发前替它补上，管理面（含 Shadow 页）直接可读写。

```
浏览器/脚本 ──HTTPS──> authz 入口 cc-235.<zone>
                          │
                          ├─ 门 2：Casbin 鉴权（authz 会话 Cookie 或 x-api-key）
                          │        匿名 → 302 /_authz/login?next=...
                          │
                          └─ 转发前 proxy.prepare 按 request_rewrite 注入
                                    x-opencodex-api-key: <token>
                                     │
                                     └─ 门 1：opencodex requireManagementAuth
                                               命中托管值 → 200
```

两条关键语义（均已实测）：

- **注入是覆盖，不是追加。** `request_rewrite.headers` 走 `ngx.req.set_header`，客户端自带的同名头
  会被替换成托管值——外部即使伪造 `x-opencodex-api-key: 错的` 仍然 200（上游只认托管那个），
  也伪造不出别人的凭据。要追加得用 `append_headers`，但**注入鉴权头绝不要用 append**，
  否则上游可能读到客户端自己填的那一行。
- **注入发生在授权之后，绕不过门 2。** 改写由 `proxy.prepare` 执行，位置在 Casbin 判定之后，
  它只解决 opencodex 那一道门。匿名请求 `cc-235.*` 依然 302 到 authz 登录页。

### 走入口的两条免登录路径（按需选）

1. **脚本 / Agent：带 authz 的机器 Key。** 请求加 `x-api-key: <AUTHZ_API_KEY>` 即可，authz 直接放行、
   不签会话 Cookie；opencodex 那侧由托管注入兜住，调用方全程不需要知道 opencodex 的 token。
   实例级环境变量 Key 只对 `AUTHZ_API_KEY_ALLOWED_IPS` 白名单内的来源生效（本机现值 `127.0.0.1`，
   即只允许从网关所在机器发起），默认 admin 角色，想收窄就用库里发的 Key 配 `api` 之类的角色。
2. **浏览器：authz 会话。** 正常登录 authz 后打开 `https://cc-235.<zone>/` 就是 Shadow/Dashboard，
   什么都不用配。

要让某个路径对**匿名**彻底开放（不带 authz 凭据也能访问），配置面是 Casbin 策略，不是绑定上的开关：

```bash
# 只放开健康探针（授权对象是「/<端口><路径>」，同端口的绑定共用策略）
curl -X POST "http://127.0.0.1:6080/_authz/api/policies" \
  -H "x-api-key: $AK" -H 'Content-Type: application/json' \
  -d '{"ptype":"p","v0":"role:guest","v1":"/10100/healthz","v2":"GET","eft":"allow"}'
```

默认 fail-closed，`role:guest` 没有策略就是 302。谨慎给 `/10100/*`——那等于把管理面公开到该入口。

### 改与查这条注入

绑定 id 7（`domain=cc`、`port=10100`、`simulate_local=1`）的现值与读回方式：

```bash
AK=$(docker exec authz printenv AUTHZ_API_KEY)
# 读回必须用 /api/authorization —— GET /api/applications 的 SQL 不 select 改写两列，看不到 request_rewrite
curl -s -H "x-api-key: $AK" http://127.0.0.1:6080/_authz/api/authorization \
  | python3 -c "import json,sys; d=json.load(sys.stdin)['data']['bindings']; \
    print([b for b in d if b.get('port')==10100 and 'request_rewrite' in b][0]['request_rewrite'])"
```

写入用 PATCH（机器 Key 免 CSRF；控制面同样只允许白名单来源 IP）：

```bash
curl -s -X PATCH http://127.0.0.1:6080/_authz/api/applications/7 \
  -H "x-api-key: $AK" -H 'Content-Type: application/json' \
  -d '{"request_rewrite":{"enabled":true,"headers":{"x-opencodex-api-key":"<token>"}}}'
```

几个容易踩的点：

- body 里只要出现任一代理字段（`upstream_host`/`simulate_local`/`request_rewrite`/…），网关会把
  这 13 个代理字段**整批重写**，未提交的从库里补值——只传 `request_rewrite` 是安全的，
  但要清楚这是整批覆盖而非字段级增量。body 无任何可更新字段时报 422「没有可更新字段」。
- 禁止注入的头名固定：分帧与 hop-by-hop 头（`content-length`、`transfer-encoding`、`connection`、
  `upgrade`、`te`、`trailer`）、网关凭据头（`x-authz-key`、`x-api-key`、`x-role-key`），以及
  `X-Authz-*` 前缀（只放行 `x-authz-user/source/identity` 三个断言头）与 `Proxy-*` 前缀，
  塞进去保存即 422。`host`/`cookie`/`origin`/`x-forwarded-*`/`x-real-ip` 属于网关托管头，
  改写走变量覆盖、优先生效；执行顺序是 remove → append → set。
- `simulate_local=1` 只伪造 `X-Real-IP`/`X-Forwarded-For`/`Host` 这些请求头，不改 TCP 来源；
  opencodex 的管理面认证不看这些头，**不会**因为"看起来像回环"就免凭据。
- 改写配置有缓存（`AUTHZ_DB_CACHE_TTL`，默认 30s），改完立刻测可能还是旧值。

**轮换 opencodex 的 admin token 后必须同步这条注入**（写回绑定 7 的 `request_rewrite`）并跑 authz 回归，
否则 `cc-235.*` 入口整体 401 而 127.0.0.1 仍正常——很容易误判成服务挂了。

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
EnvironmentFile=/etc/opencodex-proxy.env   # 只放 OPENCODEX_ADMIN_AUTH_TOKEN=<强随机>
ExecStart=<node或nvm的bin目录>/ocx start --port 10100
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=75

[Install]
WantedBy=multi-user.target
```

注意：`stop → 换包 → start` 必须一次性做完——`Restart=always` 会在中途拉起孤儿进程占住端口，
导致后续 start 失败。`KillMode=mixed` 下自重启时看到成批 `SIGKILL` 属正常（按设计清扫接班进程），
中间约 5 秒不可用也不是故障。

## 交给 agent 的 Prompt（复制即用）

把下面整段发给目标机上的编码 agent，它会完成下载、安装、配置、验证：

```text
安装 opencodex fork 代理（本 fork 提供 Codex 的第三方模型代理与影子调用拦截）：

1. 下载：gh release download rolling-fork-build --repo yorkane/codex-proxy --pattern '*.tgz' --dir /tmp
   （没有 gh 时先查 releases/tags/rolling-fork-build 的真实资产名再拼 URL，别写死旧文件名）
2. 安装：npm install -g --allow-scripts=bun /tmp/bitkyc08-opencodex-*.tgz
3. 写 ~/.opencodex/config.json：defaultProvider 与 providers 用我提供的 baseUrl/apiKey/models，
   并按模型真实上限填 defaultMaxOutputTokens / modelMaxOutputTokens；
   如需 Codex 原生模型改道，配置 shadowCallIntercept.modelMap（来源模型 → provider/model），
   自定义来源模型 id 要同时写进 sourceModels；幻影工具名单用 shadowCallIntercept.phantomToolAllowlist
   （别再写已删除的 provider.undeclaredToolAllowlist）；需要空完成重放就置 emptyCompletionRetry；
   经外部反代访问把 origin 写进 corsAllowOrigins。
4. 管理面凭据：设一个强随机 admin token 走 Environment=OPENCODEX_ADMIN_AUTH_TOKEN=...（env 优先，
   文件形态只接受 ocx_admin_ 前缀的生成值）；本机裸调 /api/* 也要凭据，没有 loopback 免认证分支；
   如果这台机前面有 authz 网关，把同一个 token 写进对应绑定的 request_rewrite 的 headers
   ["x-opencodex-api-key"]，走入口就免带凭据；轮换 token 后记得同步那里。
5. 启动并验证：ocx start --port 10100 &（或复用已有 systemd 单元，停→换→起一步做完）；
   curl -s http://127.0.0.1:10100/healthz 应返回 status ok；
   无凭据 GET /api/config 应 401（证明认证生效）、带 x-opencodex-api-key 应 200；
   再 POST /v1/responses 发一个带 tools 声明的最小请求（影子拦截只在 /v1/responses 生效，
   /v1/chat/completions 不测影子），确认工具往返正常、无 502。
6. 报告：healthz 输出、版本号、认证四态（/healthz 200、裸 /api/config 401、带凭据 200）、
   以及影子映射是否生效（响应里模型是否被替换）。
```

## fork 定制能力速查

| 能力 | 配置键 | 说明 |
|---|---|---|
| 影子调用拦截 | `shadowCallIntercept.{enabled,model,modelMap,sourceModels}` | 按来源模型把 Codex 原生模型（luna/sol/terra/5.5/5.4-mini 及自定义）换成任意已配置 provider/model；`modelMap` 逐来源映射、`model` 兜底；斜杠来源条目要配斜杠 id，最长前缀优先 |
| 幻影工具容忍 | `shadowCallIntercept.{phantomToolAllowlistEnabled,phantomToolAllowlist}` | 替换模型幻觉出的未声明工具名：命中名单整条剥除、回合继续；未命中仍 502 fail-closed。不写=内置 9 项，显式 `[]=`全 fail-closed。只对**被影子替换过**的请求生效，直连路由恒 fail-closed |
| 未声明调用指令纠错 | `shadowCallIntercept.phantomToolFeedbackMax` | 默认 2（0-10，0=退回只丢弃）：被拒的调用回喂一条纠错指令让模型改名重试；仅影子请求且声明了 exec 时分配 |
| 统一工具名修复 | （无需配置） | 内置 emitted-call-guard：`tools__` / `tools.` / `tools=` / `tools/` 四种前缀与裸名自动改写为声明名、命名空间误调回喂纠错、纯幻影按名单丢弃 |
| exec 信封泄漏修复 | （无需配置） | bridge 的 sse 与 response-json 两条路径修复泄漏进正文的 exec 信封 |
| 输出上限封顶 | `providers.*.{defaultMaxOutputTokens,modelMaxOutputTokens}` | 调用方 max_tokens 与配置值取 min，越界不再被上游 400 |
| 空完成重放 | `emptyCompletionRetry` / `emptyCompletionRetryMax` | 默认关；env `OCX_EMPTY_COMPLETION_RETRY=0` / `OCX_EMPTY_COMPLETION_RETRY_MAX` 可强关/改预算 |
| 反代 origin 白名单 | `corsAllowOrigins`（上游原生） | 放行反代 origin 让浏览器 gui-session 可用；**不是**管理 API 的免认证开关，schema 里的 zod 防护条目不可删 |

管理面凭据与 authz 免认证见上一节。更细的设计与运维手册见 fork 运维层仓库根目录的 AGENTS.md / design.md。

