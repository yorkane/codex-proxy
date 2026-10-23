# opencodex fork 代理部署合同（组件发布线 · 无托管）

> **本文坐标**：组件发布线（无托管）的代理组件（直启 `wdev-proxy.service`）。**最新发布 =
> `wdev-proxy_2.89.0-wdev.7cf2a33c_linux-amd64.tar.gz`**（sha256
> `7d4f4eb3b0a17d546f66b4f0dff24626f263ce1421600cd962914bcd5ee5ad68`，197,744,992 字节，
> 6174 regular 成员，源 commit `7cf2a33cc47ec46122934a7bce09c0272152f517`）。
> **发布通道 = GitLab 公共仓库 `yorkane/wdev-suit`（project 23）Release 部署包直链**；资产名与
> 坐标一律从该机读清单读取，文档不写死、不拼 latest。
> **引擎已删除托管集成模块**（2026-10-21，见 §6）：`/api/wdev/*` 恒 404（Unknown endpoint）属预期。
> web 侧（gateway deb / 3737）仍走 wdev-app manager 托管，其托管合同文档（ref
> `codex/wdev-managed-upgrade`）仍是 web 侧权威，**proxy 组件不再依赖**。
> 升级合同见 [upgrade.md](upgrade.md)；开发规范见仓内 [AGENTS.md](AGENTS.md)；235.t 本机现役坐标见
> 工作区根 [deploy.md](../deploy.md)。

## 1. 身份与边界

- 外部品牌 wdev 只落薄壳：单元名 `wdev-proxy.service`、CLI `wdev-proxy`（组件 id 固定 `llm-proxy`）、authz label。
- 内部身份**不改**：npm 包名 `@bitkyc08/opencodex`、bin `ocx`/`opencodex`、数据目录 `~/.opencodex`、
  `/healthz` 的 `service:"opencodex"`、注入头 `x-opencodex-api-key`、provider namespace、`OPENCODEX_*`/`OCX_*` env 前缀。
- 默认端口 **10100**、默认绑 `127.0.0.1`；**端口是装配期实例特定值**（241 装配为 10101），验收命令按 inventory 实值。
- 数据边界：`~/.opencodex`（config/history/spend-ledger/state-lock）、`~/.codex`、官方 userData（含旧
  `/var/lib/codex-desktop/*`）**原位不迁不删不改属主**；无 purge 路径。
- **proxy 的进程监督归部署层 systemd 单元，引擎自身不感知托管协议**：部署 = 直启单元（§3），
  重启/换树 = 部署层 systemctl 操作（§5/§8）。
- 235.t 已于 2026-10-20 完成 cutover（§7）：10100 由当时的托管线承载，旧 npm 链退役。

## 2. 发布物与校验

| 形态 | 说明 |
|---|---|
| portable 离线包 `wdev-proxy_<ver>-wdev.<shortsha>_linux-amd64.tar.gz` | 包根=安装树平铺：`bin/ocx.mjs`（Node shim，0755）+ `node_modules/`（依赖整树物化，含真 ELF `node_modules/bun/bin/bun.exe`）+ payload node 固定槽 `gateway/node/bin/node`；全树仅 regular+dir 无 symlink（历史托管合同遗留的形状约束，保持即可；现行意义只是便于 tar 落盘）。**直启部署用这个** |
| npm 源包 `wdev-proxy-<ver>-fork-<shortsha>.npm.tgz` | `npm pack` 形态，只服务已退役的旧 prod npm 全局链（§7），组件发布线不用 |

取包与校验：从 wdev-suit（project 23）Release 部署包直链取包（直链形态
`/-/releases/<tag>/downloads/packages/<文件名>`，具体坐标读该机读清单），落盘后 `sha256sum -c` 对账，
必须 OK 才继续：

```bash
set -eu
STAGE=/data/tmp/wdev-release-pull && mkdir -p "$STAGE" && cd "$STAGE"
# 资产名与 sha256 从 wdev-suit 机读清单读取（占位符，不写死）
ASSET='<portable资产名>'
curl -sfL -O "<清单给出的 Release 部署包直链>"
echo '<清单给出的sha256>  '"$ASSET" | sha256sum -c -
tar -tzf "$ASSET" | head   # 应见 bin/ocx.mjs、node_modules/bun/bin/bun.exe、gateway/node/bin/node
```

安装门（先门后装）：fleet 根 CA 三条同时成立（导入公钥 + `update-ca-certificates` → 按 SHA-256 指纹锚定位 +
`openssl verify` → 无 `-k` 实探测 22700 落 200/401/403 且 `ssl_verify=0`）。完整命令与指纹见 wdev-app
[deploy.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-app/-/blob/codex/wdev-managed-upgrade/deploy.md) §3.1。

## 3. 安装（直启：部署层 systemd 单元，无托管安装器）

四步：解包落 release 目录 → 写 env → 写直启 unit → enable/start 后按 §8 验收。

1. **解包落 release 目录**：`mkdir -p ~/wdev/proxy/releases/<id>`（如 `engine-2.89.0+7cf2a33c`），
   `tar -xzf <portable包> -C ~/wdev/proxy/releases/<id>`（包根=安装树平铺）。release 目录一次写入
   不可变，手工覆盖在用目录 = 破坏回滚判据，禁止。
2. **写 `~/.wdev/proxy.env`**（0600）：`OPENAI_APIKEY_API_KEY`（§4）、`OPENCODEX_ADMIN_AUTH_TOKEN`（§5）等；
   token 值为部署时本地强随机（例 `openssl rand -hex 24`），不进 unit、不进文档。
3. **写直启 unit**（241.t 实测形态；端口按装配期实值）：

```ini
[Unit]
Description=wdev-proxy (opencodex llm-proxy, direct-start)
After=network-online.target

[Service]
Type=simple
ExecStart=<release目录绝对路径>/gateway/node/bin/node <release目录绝对路径>/bin/ocx.mjs start --port 10101
EnvironmentFile=~/.wdev/proxy.env
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

4. `systemctl daemon-reload && systemctl enable --now wdev-proxy.service`，按 §8 验收。

引擎 bin `bin/ocx.mjs` 是 Node shim，按包内布局解析捆绑 bun（override→bundled→PATH）后 exec；
`gateway/node/bin/node` 是 payload node 固定槽，直启 ExecStart 用它，不依赖系统 node。

## 4. 默认登录：API key，无账户

fresh 出厂默认（`getDefaultConfig`，src/config/proxy-env.ts）：`defaultProvider: "openai-apikey"`，provider
`openai-apikey` 的 `apiKey` 是环境变量引用 `${OPENAI_APIKEY_API_KEY}`（id 派生名），**不存密钥字面值**。

- 凭据注入：`~/.wdev/proxy.env` 写 `OPENAI_APIKEY_API_KEY=<key>`（0600，systemd EnvironmentFile 读取）。
- **未设置该键时服务仍能正常启动**（启动不因缺 key 失败），API 请求由上游返回 401（`ocx status` 报
  "no API key" 态）。不要为 fresh 安装做账户登录。
- 官方 ChatGPT forward 行（provider `openai`）byte-identical 保留：账户池运维可把 `defaultProvider` 翻回
  `openai`，该能力不删。已有机器 `~/.opencodex/config.json` 的 `defaultProvider` 原样保留，升级不静默切换。
- 桌面免账户注入开关 `codexDesktopAuthless` 只在 wdev 出厂配置层显式设置，不进通用默认工厂、不迁移官方数据。

## 5. 配置与管理面认证

`~/.opencodex/config.json` 首次运行自动生成；fork 定制全部可选、默认关闭（契约速查 AGENTS.md 与
`structure/config-proxy.md` 等）。要点：`providers` 是 record(id→对象) 非数组；provider 必填 `adapter`+`baseUrl`；
`models` 字符串数组；私网 baseUrl 该 provider 加 `allowPrivateNetwork:true`；`shadowCallIntercept` 只在
`POST /v1/responses` 生效（斜杠来源条目配斜杠 id，最长前缀优先，自定义来源必须登记 `sourceModels`）；
`undeclaredToolAllowlist` 键已删除（残留会让 provider PUT 400）；管理面 PUT/PATCH 支持字段热载不重启；
结构变更后的重启由部署层执行（部署层 = systemd：直启单元直接 `systemctl restart wdev-proxy.service`）。

引擎无托管集成面：部署层与引擎的交互只剩两条通道——systemd 单元生命周期与 EnvironmentFile 注入的
配置（§6）；`wdev-proxy` CLI 是部署层自带的 shim，不由本仓库提供。

认证（2026-10-23 口径；fork 定制 `loopbackManagementAuth`，合同见
fork 运维层 [doc/2026-10-23-loopback-management-auth.md](../doc/2026-10-23-loopback-management-auth.md)）：

1. **进程内**：`/api/*` 默认对**本机 loopback 匿名放行**（`loopbackManagementAuth` 缺省 `false`；判定 =
   可信 loopback listener + 真 socket peer `127.0.0.1/::1/::ffff:127.0.0.1` + 严格 Host/Origin，
   `X-Forwarded-*` 一律不参与；principal `loopback-anonymous` 不冒充 `gui`，`session-only` 路由仍拒）。
   `loopbackManagementAuth: true`（strict）恢复强制凭据、逐字节旧行为；畸形值 fail-closed 按 `true`。
   **仅非 loopback 必须认证**，与 `hostname` 绑定值无关。令牌优先级 env `OPENCODEX_ADMIN_AUTH_TOKEN` >
   文件 `~/.opencodex/admin-api-token`（文件态强制 `ocx_admin_` 前缀生成值，手写明文判非法→503；
   真源是 env，文件仅作回落）。令牌为部署时本地强随机（例 `openssl rand -hex 24`），只落该实例 env 与 authz
   注入配置（strict / 非 loopback 形态用）；文档/报告不携带值。非 loopback 绑定时数据面另需独立凭据（`OPENCODEX_API_AUTH_TOKEN` 或
   `config.apiKeys`，不得与管理令牌同值；只用 `x-opencodex-api-key` 头提交）。
2. **authz 边缘授权**：`cc` 前缀域名绑定回源本机 proxy（235 绑定 id 7，`simulate_local=1`），
   guest 策略只放行该 proxy 端口路径（本轮=完整 app 入口全方法）。authz 与 proxy 同机 + host 网络时
   proxy 看到的 kernel peer 是真 `127.0.0.1`，匿名准入由第 1 条的策略给出；`request_rewrite` 注入
   `x-opencodex-api-key` **不再必须**（移除时只删该 header 单项、保留其余字段，不发 `null`），
   降级为 strict / 非 loopback 形态的可选旧通道。该形态下轮换 admin token 后必须同步绑定注入值
   （`PATCH /_authz/api/applications/7`），否则外部入口整体 401 而 127.0.0.1 正常。
   已知代价（用户已接受）：`simulate_local` 入口的 `/opencodex-session` 自铸会话管理配置读面即主要暴露面，
   Shadow UI 对外可读写；收窄手段（strict、guest 收窄 `/v1/*`+`/healthz`、绑定路径排除）本轮不启用。

```bash
TOKEN=$(sed -n 's/^OPENCODEX_ADMIN_AUTH_TOKEN=//p' ~/.wdev/proxy.env)
P=http://127.0.0.1:10100      # 端口按 inventory 实值（241=10101）
curl -s -H "x-opencodex-api-key: $TOKEN" $P/api/shadow-call-settings
```

## 6. 引擎不含托管集成（2026-10-21 移除）

本仓库曾提供 opt-in 的托管集成模块（config 块 `wdevManager`、`/api/wdev/components` 与
`/api/wdev/operations` 路由、维护 fence 消费方、`POST /api/update/run` 的 409 门、GUI `#wdev`
页，注册依赖 `wdevManager` 块与部署 env）。该模块已整体删除（分支 `codex/remove-wdev-module`，
HEAD `7cf2a33cc4`：src/wdev/ 四文件、management/wdev-routes、GUI #wdev 页与 11 locale 的 nav.wdev、
wdevManager 配置块与 schema、serve-options fence 判定、config-routes 409 门、sibling-guard、
structure/wdev-manager.md、相关测试与登记），引擎侧对应语义全部不存在：

- 配置里的 `wdevManager` 块是未知键（schema 无此条目）；请求 `/api/wdev/*` 恒 **404 Unknown
  endpoint**（任何机器、带不带令牌都一样）——这是预期，不是故障。
- 引擎**不读** `WDEV_MAINTENANCE_FILE` 等任何 `WDEV_*` env；supervisor 写下的 fence 文件没有消费方，
  `/healthz` 无 `maintenance.ack` 回执。
- 因此**依赖 fence ack 的托管升级事务对 proxy 组件 fail-closed（notwired）**：supervisor 无法从
  引擎侧收到排空确认。
- **部署 proxy 不需要 manager**：直启单元（§3）即完整部署合同。web 组件的托管合同（wdev-app，ref
  `codex/wdev-managed-upgrade`）不受影响。

liveness/readiness 分离保留：`/healthz status:"ok"` 只答进程活着；`/readyz` 在启动后 catalog/config
同步 settle 且 `ok=true` 才 `status:"ready"`（降级 warning 关门不开）。

## 7. 235.t 现状：cutover 已完成（2026-10-20），npm 链退役；新包直启切流未执行

cutover 历史事实：托管三件套 2026-10-20 01:51 UTC 接管 235，`wdev-proxy.service`（10100）、
`wdev.service`（3737）、`wdev-xvfb.service` active。切换 = 独立排空 root cutover job
（`~/wdev/operations/cutover-20261020T012833Z.tsv` 逐行 rc0），**不是** activate-235 脚本——该脚本
`--apply` 恒 fail-closed（legacy-admission-unavailable，见 wdev-app deploy.md §11），一键切换从来不存在。
旧面全部退役：`opencodex-proxy.service`、`codex-desktop-gateway.service`、`codex-desktop-xvfb.service`
及 watchdog/reaper 等 timer **masked**（单元文件移入 `/data/.trash/`，`is-enabled` 报 masked）。
npm 固定链（`wdev-proxy/script/upgrade-codex-proxy.sh`，发布清单
`/data/share/deb/codex-proxy-latest.json`）**已退役且当前不可执行**：脚本 `UNIT` 指向 masked 单元；
latest 清单缺 `installedManifestPath`/`installedManifestSha256` 两键（脚本 `jq -er` 硬依赖）。脚本与归档
产物只读保留历史，**禁止按旧文档执行 npm 换树升级**（细节 upgrade.md §2）。

**现役与"引擎能力"是两件事**：引擎代码已无托管能力（§6），但 235 现役部署**仍是旧托管形态**——
`wdev-proxy.service` Type=notify、由 `wdev.py` supervisor 承载，现役引擎树 =
`~/wdev/proxy/releases/engine-2.87.0+3c30b15a5e02`（唯一 release 目录，import-baseline 基线导入包，
未经 241 验收）。2.89.0 直启包**尚未在 235 切流**：切流是单独受控动作（摘流量→落 release 目录→
直启单元接管→§8 验收），不在本文档发布范围内。**禁动清单不变**：现役承载面 = `wdev.service` /
`wdev-xvfb.service` / `wdev-proxy.service`（验证窗口只读）。

## 8. 验收（直启部署后逐条跑）

```bash
systemctl is-active wdev-proxy.service                     # active
systemctl show -p NRestarts --value wdev-proxy.service     # 验收窗口内不增
P=http://127.0.0.1:10100; TOKEN=$(sed -n 's/^OPENCODEX_ADMIN_AUTH_TOKEN=//p' ~/.wdev/proxy.env)
curl -s --noproxy '*' $P/healthz | head -c 400             # status:"ok"（liveness）
curl -s --noproxy '*' $P/readyz                            # status:"ready"（readiness）
curl -s -o /dev/null -w '%{http_code}\n' $P/api/config                               # 默认 200（本机匿名放行）；loopbackManagementAuth=true 时 401
curl -s -o /dev/null -w '%{http_code}\n' -H "x-opencodex-api-key: $TOKEN" $P/api/config  # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "x-opencodex-api-key: $TOKEN" $P/api/wdev/components
#   恒 404（Unknown endpoint，随模块删除；任何机器都是 404 —— 这是预期，不是故障）
```

- 托管门族随模块删除**作废**；**proxy 验收 = 本表**（healthz/readyz/认证判据 + 单元 active、
  NRestarts 不增；换树时加子进程新 PID 代际 + 逐文件 sha256，见 upgrade.md §1）。
  web 组件门族不受影响（manager 侧直操作）。验收窗口内 235 现役三单元只读。
- 241.t 实测基线（2.89.0 包）：直启单元 active、NRestarts=0，`/healthz` ok 2.89.0，`/readyz` ready，
  `/api/config` 401 / 带 token 200，`/api/wdev/components` 带 token 404 Unknown endpoint，
  run-test.sh 七场景 ALL_DONE_PASS——口径为**七场景回归 + 直启验收通过**，不宣称过了 241 正式门。
- `/healthz` version 同号换树不构成升级证据；换树证据 = 逐文件 sha256 + 树内契约串 grep（见 upgrade.md）。
- ready 正向判据按目标机集成配置判定：`clientIntegrations.codex:false` 隔离 fixture 下 ready 已实证通过，
  不要求真实登录 websession 作 ready 前置；不宣称超出配置范围的 ready 结论。

## 9. 操作索引

按 §2 从 wdev-suit Release 直链取包并 `sha256sum -c` 对账，按 §3 直启安装，按 §8 验收；
升级与回滚见 [upgrade.md](upgrade.md)；本机（235.t）现役坐标以工作区根 [deploy.md](../deploy.md) 为权威。
