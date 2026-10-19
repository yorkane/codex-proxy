# opencodex fork 代理部署（managed 发布线，2026-10-19）

> 本文聚焦 **managed 新安装**：wdev 薄壳托管的代理组件（`wdev-proxy.service`）。
> 235.t 旧生产（systemd + npm 全局树，`opencodex-proxy.service`，2.86.0）仅列现状，不作为新部署默认路径。
> 升级合同见 [upgrade.md](upgrade.md)；仓库开发规范见仓内 [AGENTS.md](AGENTS.md)。

## 0. 发布坐标与身份

- 本轮 GitLab tag：`wdev-proxy-v2.87.0-managed.3`（project 22 `yorkane/codex-proxy`，绑定默认 API 登录 commit `b8f3e0f5d2`）。
  下载入口：Release assets links 与 Generic Package Registry
  `https://gitlab.ai-t.wtvdev.com/api/v4/projects/22/packages/generic/wdev-managed/2026.10.19-managed.3/<file>`。
  **资产名与哈希以 Release 附带的 `manifest.json`（schema 2，逐产物 key/file/sha256）为唯一权威**，本文不写死文件名、不虚构 latest。
- 发布物两种形态：
  - **portable 离线包** `wdev-proxy_<ver>-wdev.<shortsha>_linux-amd64.tar.gz`（`<ver>`/`<shortsha>` 取 Release manifest.json 实值，短 sha 随最终 feature commit 变化）：
    包根即安装树平铺——`bin/ocx.mjs`（Node shim，755）、`node_modules/`（依赖整树物化，含真 ELF
    `node_modules/bun/bin/bun.exe`，捆绑 bun 运行时槽）、`gateway/node/bin/node`（payload node 固定槽）＋包体全量。
    与 manager stage 合同（safe_extract_tar：仅 regular+dir、无 symlink）对齐。
  - **npm 源包**（Release 资产名 `wdev-proxy-<ver>-fork-<shortsha>.npm.tgz`，同 manifest.json 取实值）：
    `npm pack` 形态（解包后 package/ 即 @bitkyc08/opencodex），供 npm 全局安装链（旧 prod 通道）。
- 当前源码版本 2.87.0（`package.json:3`）；235.t 生产安装树 2.86.0。
- 内部身份不改：npm 包名 `@bitkyc08/opencodex`、bin `ocx`/`opencodex`、`~/.opencodex`、`/healthz` 的 `service:"opencodex"`、
  `x-opencodex-api-key` 头、provider namespace 保持原名；wdev 品牌只在薄壳单元名与展示层。
- 服务默认端口 **10100**，默认绑 `127.0.0.1`。

## 1. 获取与校验

```bash
# GitLab：tag 资产清单（PAT 见组内规范；域名 TLS 需已信任该实例证书链，勿用 -k）
curl -sf --header "PRIVATE-TOKEN: $GLPAT" \
  "https://gitlab.ai-t.wtvdev.com/api/v4/projects/22/releases/wdev-proxy-v2.87.0-managed.1" | jq '.assets.links'
# Generic Package Registry 直下到本地暂存目录（fleet 规范：临时物放 /data/tmp）
mkdir -p /data/tmp/wdev-release-pull
curl -sfL --header "PRIVATE-TOKEN: $GLPAT" -o /data/tmp/wdev-release-pull/<file> \
  "https://gitlab.ai-t.wtvdev.com/api/v4/projects/22/packages/generic/wdev-managed/2026.10.19-managed.1/<file>"
sha256sum /data/tmp/wdev-release-pull/<file>   # 与 manifest.json / SHA256SUMS / 服务端 package_files 回显 file_sha256 对账
```

GitLab 链接是**provenance 与下载入口**，不是自动升级源：向 wdev manager 提交升级时 `manifest.url` 的 host 白名单
只有 `file-235.ai-t.wtvdev.com`（`wdev_manager/artifacts.py:30`），GitLab 域名直接拒收。正确序列：
下载→sha256 对账→放入 trusted roots→以 manifest 的 `path` 字段提交。

## 2. 安装（managed 通道：包内 install.sh + flat 包）

代理作为 wdev 托管组件安装 = wdev-app deploy.md §3 的一次 apply，`--engine-tgz` 传**portable 离线包**：

```bash
bash <extract>/opt/codex-desktop/wdev-deploy/script/wdev-manager/install.sh \
  --with-bin \
  --deb <extract-parent>/wdev_<版本>_amd64.deb \
  --engine-tgz /data/tmp/wdev-release-pull/wdev-proxy_<ver>-wdev.<shortsha>_linux-amd64.tar.gz \
  --gateway-env-source ~/.wdev/gateway.env \
  --proxy-env-source ~/.wdev/proxy.env \
  --apply apply
```

`--gateway-env-source`/`--proxy-env-source` 缺省读旧 prod 机器路径 `/etc/codex-desktop/gateway.env`、
`/etc/opencodex-proxy.env`（install.py `OLD_ENV_SOURCES`）；fresh 机器没有这两个文件，**显式传自有路径**，
apply 原文复制为 0600 自有配置。fresh 自有配置按 wdev-app deploy.md §3 的最小集生成：
`~/.wdev/gateway.env` 只需 `HOST=127.0.0.1`、`PORT=3737`、`DISPLAY=:99`、
`CODEX_WEB_CONFIG_PATH=<绝对路径>/.wdev/gateway.yaml`（站点配置起步文件复制包内 `wdev-deploy/config/config.yaml` 重命名）；
`~/.wdev/proxy.env` 至少含本地强随机生成的 `OPENCODEX_ADMIN_AUTH_TOKEN` 一行。
包内 `config/gateway.env` 模板含旧布局绝对路径键（`CODEX_DESKTOP_*=/opt/…`、`CODEX_HOME=/var/lib/…`），
**fresh 机器不要原样拷**；无历史数据时数据目录用用户默认原位（`~/.codex`、`~/.opencodex`、官方 userData 默认路径），
不迁移任何现存文件。web 运行时定位键 `CODEX_DESKTOP_APP_PATH` 不写，由 supervisor 按 activation release 注入。
解包后的引擎 release 树（`~/wdev/proxy/releases/<id>/`）由 manager 拉起：`bin/ocx.mjs` 是 Node shim，
按包内布局解析捆绑 bun（`node_modules/bun/bin/bun.exe`）后 exec；payload node 固定槽
`gateway/node/bin/node` 供 manager `{node}` 解析（§6）。校验：

```bash
tar -tzf /data/tmp/wdev-release-pull/<flat>.tar.gz | head    # 应见 bin/ocx.mjs、node_modules/bun/bin/bun.exe、gateway/node/bin/node
```

npm 全局树通道（旧 prod 形态，235 现网在用）：`npm install -g --allow-scripts=bun <tgz>`——
`--allow-scripts=bun` 必须带，否则捆绑 bun 不落盘（`bin/ocx.mjs` 只剩占位 stub）、systemd 起服即败。
**新装机器不要走这条**；它列在这里只为对 235 现网现状。

## 3. 配置（`~/.opencodex/config.json`）

首次运行自动生成。fork 定制全部可选、默认关闭、不影响上游行为（契约速查见仓内 AGENTS.md 与 `structure/wdev-manager.md`）。
下面样例的 JSON 等价形（去注释、占位符替换为真实值，如 baseUrl 用公网域名）经仓库 `configSchema.safeParse` 纯校验通过
（不 launch 服务，校验脚本 `/data/tmp/wdev-release-20261019/schema-check3.mjs`）：
`providers` 是 record(id -> 对象) 非数组；provider 必填 `adapter`＋`baseUrl`；`models` 为字符串数组
（providerConfigSchema 对该键 passthrough 透传，模型表由适配器侧消费）；私网 baseUrl 须该 provider 加 `allowPrivateNetwork:true`：

```jsonc
{
  "defaultProvider": "my-llm",
  "providers": {
    "my-llm": {
      "adapter": "openai-chat",   // 必填（providerConfigSchema 强制，缺则解析拒）
      "baseUrl": "https://<openai-compatible-host>/v1",
      "apiKey": "***",
      "models": ["Q38-Flash-Next"],
      // 真实输出上限；调用方 max_tokens 与之取 min 封顶，防越界被上游拒
      "defaultMaxOutputTokens": 32768,
      "modelMaxOutputTokens": { "Q38-Flash-Next": 131072 }
    }
  },
  // （OpenAI 兼容端点用 adapter:"openai-chat"；示例 baseUrl 用公网域名占位，私网自加 allowPrivateNetwork:true）
  // 影子拦截：按来源模型精确替换（modelMap 逐来源，model 兜底；自定义来源必须登记 sourceModels）
  "shadowCallIntercept": {
    "enabled": true,
    "modelMap": { "gpt-5.6-terra": "my-llm/Q38-Flash-Next" },
    "model": "my-llm/Q38-Flash-Next",
    "sourceModels": ["gpt-5.6-terra"],
    "phantomToolAllowlistEnabled": true,
    "phantomToolAllowlist": ["update_plan", "web__run"],   // 缺省=内置 9 项；显式 []=全 fail-closed
    "phantomToolFeedbackMax": 2
  },
  "emptyCompletionRetry": true,
  "emptyCompletionRetryMax": 1,
  // 外部反代场景放行 origin（浏览器 gui-session 用；脚本仍显式带 x-opencodex-api-key）
  "corsAllowOrigins": ["https://your-proxy.example.com"],
  // wdev 托管 opt-in（见 §6）：
  "wdevManager": { "enabled": true, "brand": "wdev-proxy" }
}
```

fresh 安装默认 provider 为 `openai-apikey`，API key 从 `OPENAI_APIKEY_API_KEY` 环境变量读取；未设置 key 时代理仍可启动，但上游请求返回 401。已有 `~/.opencodex/config.json` 的 `defaultProvider` 会原样保留，不会把账户池配置静默切换。

- 影子拦截只在 `POST /v1/responses` 生效（`/v1/chat/completions` 不测影子）；斜杠来源条目必须配斜杠 id，最长前缀优先。
- `undeclaredToolAllowlist`（provider 级）已删除，残留该键会让 provider PUT 报 400。
- 管理面 PUT/PATCH 支持的字段热载不重启；结构变更后由 manager 事务执行 restart（§6），不手工 systemctl。

## 4. 管理面认证（两道门）

门 1（进程内，无法绕过）：`/api/*` 一律要凭据，无 loopback 免认证分支。令牌优先级：env
`OPENCODEX_ADMIN_AUTH_TOKEN` > `~/.opencodex/admin-api-token`（文件形态强制 `ocx_admin_` 前缀生成值，手写明文判非法→503）。
**令牌取值为部署时本地生成的强随机串**（例：`openssl rand -hex 24`），只写入该实例的 env 与 authz 注入配置；
本文与任何文档/报告不携带具体令牌值。非 loopback 绑定时数据面另需独立凭据
（`OPENCODEX_API_AUTH_TOKEN` 或 `config.apiKeys`，不能与管理令牌同值；只用 `x-opencodex-api-key` 提交）。

```bash
# 本机自取（managed 形态取法；旧 prod 的 /etc/opencodex-proxy.env 只列现状不默认）
TOKEN=$(sed -n 's/^OPENCODEX_ADMIN_AUTH_TOKEN=//p' ~/.wdev/proxy.env)   # 或文件态：$(cat "$OPENCODEX_HOME/admin-api-token")
curl -s -H "x-opencodex-api-key: $TOKEN" http://127.0.0.1:10100/api/shadow-call-settings
```

门 2（authz 网关托管注入）：235.t authz 把 `cc` 前缀绑定 127.0.0.1:10100（绑定 id 7，`simulate_local=1`），
`request_rewrite.headers` 以 `ngx.req.set_header` **覆盖式**注入 `x-opencodex-api-key`——走 `cc-235.*` 入口的调用方
免带 ocx 令牌；数据面 `/v1/*` 对过 authz 门的调用方完全免 ocx 凭据（loopback 转写形态），管理面靠注入。
轮换 admin token 后必须同步绑定 7 的注入值（`PATCH /_authz/api/applications/7`），否则 `cc-235.*` 整体 401 而 127.0.0.1 正常。
注入是覆盖不是追加、发生在授权之后绕不过门 2；`simulate_local` 入口的 `/opencodex-session` 自铸会话有管理配置读面，
按需把 `/api/*`、`/opencodex-session` 排除出绑定（只放行 `/v1/*` 与 `/healthz`）。

## 5. 235.t 旧生产现状（只读参考，非新部署路径）

`opencodex-proxy.service`（systemd，enabled/active）：npm 全局树（`@bitkyc08/opencodex` 2.86.0，prefix nvm node v24），
`EnvironmentFile=/etc/opencodex-proxy.env`（仅 `OPENCODEX_ADMIN_AUTH_TOKEN` 一键），
`ExecStart=… bin/ocx start --port 10100`，Restart=always/5s、KillMode=mixed、TimeoutStopSec=75，仅绑 127.0.0.1。
该通道日常升级走固定发布链脚本（见 upgrade.md §1）。托管三件套上 235 的切换条件与边界见
wdev-app deploy.md §8（activate-235 `--apply` 恒拒绝；生产面只读）。

## 6. wdev 薄壳托管合同

`wdev-proxy.service`（Type=notify，KillMode=mixed/TimeoutStopSec=75/WatchdogSec=120，Restart=always+5s；token 不进单元）
由 manager 拉起（部署与 root 集成见 wdev-app deploy.md）。代理侧合同（`structure/wdev-manager.md`，源码 `src/wdev/`）：

- opt-in：`config.json` 加 `wdevManager:{enabled:true, brand:"wdev-proxy"}`；整块缺失=关闭（路由 404、零 spawn、零 timer）。
- 可执行坐标全部来自部署 env，请求体永远不能指定二进制/目录/单元：`~/.wdev/proxy.env` 由 installer 追加
  `WDEV_MANAGER_HOME`/`WDEV_DEPLOY_HOME`/`WDEV_MANIFEST_ROOT` 三键；`WDEV_MANAGER_PYTHON`（缺省 `/usr/bin/python3`）
  与 `WDEV_MAINTENANCE_FILE`（fence 文件，布局函数派生）由 supervisor 启动进程时注入环境。
  CLI 入口固定 `<WDEV_MANAGER_HOME>/manager/wdev.py`，逐次校验 realpath 与 root 属主。
- 管理端点：`GET /api/wdev/components`、`POST /api/wdev/operations`（202=**durable queued**，非成功）、
  `GET /api/wdev/operations[/{id}]`。wdev 模式下 `POST /api/update/run` 恒 409（禁 npm 自更新覆盖托管树）。
- 维护 fence：manager 在重启/升级前写 `WDEV_MAINTENANCE_FILE`；生效期间新生成请求 503 `wdev_maintenance`
  （`Retry-After: 5`），draining 相位放行带锚定的 tool 续传，quiesced/expired 一律拒；`/healthz` 带
  `maintenance:{active,operationId,phase,strict,fenceEpoch,ack:true}` 回执。fence 只由 supervisor 删文件释放，**永不超时自解**。
- argv 与 node 绑定：托管 proxy 启动 argv 首 token 为模板 `{node}`，由 supervisor 按当前 activation release 解析
  `<releaseDir>/gateway/node/bin/node`（regular+X_OK+ELF+`--version`≥22 四重验；flat 包即提供该固定槽）；
  旧 engine 无 payload node 槽时走显式 `nodeSource=system` 回退 `/usr/bin/node`≥22（同四重验）。缺省不回退系统 ABI，
  解析失败 `node-unresolved-fail-closed`。捆绑 bun 运行时的选择由 `bin/ocx.mjs` shim 在包内完成（override→bundled→PATH）。

## 7. 验收（managed 安装后全过）

```bash
systemctl is-active wdev-proxy.service
wdev-proxy doctor
curl -s --noproxy '*' http://127.0.0.1:10100/healthz | jq '.status,.pid,.port'      # status=ok（liveness）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:10100/api/config           # 401（认证生效）
curl -s -o /dev/null -w '%{http_code}\n' -H "x-opencodex-api-key: $TOKEN" http://127.0.0.1:10100/api/config  # 200
# 影子端到端（只在 /v1/responses）：带 tools 声明最小请求 → 响应模型被替换、无 502；usage.jsonl 落 shadowCallRewrittenFrom
python3 ~/wdev/manager/wdev.py operation <uuid>                                      # 托管事务终态 succeeded
```

`/healthz` 的 version 同号换树时不构成升级证据；换树证据 = 逐文件 sha256 ＋树内契约串 grep（见 upgrade.md §1 同款判据）。
ready 正向判据取决于集成配置：`clientIntegrations.codex:false` 隔离 fixture 下 ready 已实证通过；
不要求真实登录 websession 作 ready 前置；验收按目标机集成配置判定，不宣称超出配置范围的 ready 结论。

## 8. 数据与账号边界（managed 形态硬约束）

- 官方数据**原位不迁**：`~/.codex`、`~/.opencodex`（含 catalog、auth、sessions、logs）与 official userData
  （含旧 `/var/lib/codex-desktop/*`）全部保持现路径；managed 安装/升级不移动、不改属主、不重写这些目录。
- 桌面网关与代理联动的前置是**同一服务 UID**（fleet 口径 aigc）：ocx 枚举 app-server 只数同 uid 进程
  （`src/codex/app-server-processes.ts`，SIGTERM 安全边界，上游设计不拆）。managed 三件套单元的 `User=` 即部署用户，
  与代理数据目录天然同 UID，无需任何目录迁移；跨账号形态下桌面「app-server」按钮失效是预期噪音。
- `CODEX_HOME` / `CODEX_WEB_*` 数据目录键沿用现值（cutover 的 `rewrite_app_paths` 只动 `CODEX_DESKTOP_*` 三键，见 wdev-app deploy.md §4）。

## 9. 交给 agent 的 Prompt（复制即用）

```text
部署 opencodex fork 代理（managed 发布线，Linux amd64，非生产验证版）：
1. 读 GitLab project 22 的 Release tag wdev-proxy-v2.87.0-managed.1 附带的 manifest.json，取资产名+sha256，
   经 Generic Package Registry 下载到 /data/tmp 并 sha256 对账；不写死文件名、不拼 latest。
2. 按 wdev-app deploy.md §3 用包内 install.sh apply（--engine-tgz 传 portable 离线包），root 集成脚本先于 start；
   禁 dpkg -i、禁动 235 生产承载面（只读）。
3. 配置 ~/.opencodex/config.json：providers 用我给的 baseUrl/apiKey/models 并填输出上限；
   需要改道配 shadowCallIntercept.modelMap+sourceModels；反代配 corsAllowOrigins；加 wdevManager:{enabled:true}。
   管理令牌本地强随机生成（不从我给的文档抄任何明文口令），authz 前置时同步绑定注入、两处一致。
4. 验收 §7 全跑：healthz status=ok、裸 /api/config 401、带凭据 200、影子端到端 200+usage.jsonl 终证、
   wdev-proxy doctor、operation=succeeded；无账号环境不宣称 ready passed。
5. 报告：版本、认证四态、影子改写证据；token 值不进报告。
```
