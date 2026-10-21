# opencodex fork 代理部署合同（managed 发布线）

> **本文坐标**：managed 发布线的代理组件（`wdev-proxy.service`）。**当前已验证坐标 = managed.4**：
> GitLab tag `wdev-proxy-v2.87.0-managed.4`（project 22 `yorkane/codex-proxy`，sourceCommit `7c90afda`），
> portable tar.gz sha256 `3c30b15a5e02cd4151d618b0df55a87ea6c4e43bf51d3f659ced2a63de759254`
> （197,644,140 B），npm.tgz sha256 `361f6b78a9e84f12a62945682f8dee40566d1b2aa8b06b102de78fc7ac8e6ecf`，
> 配对 web tag `v2026.10.19-managed.4`。**managed.5 正在构建（坐标未定）**：下文以 `<managed.N>` 占位，
> **资产名与哈希一律以对应 Release 的 `manifest.json` / `SHA256SUMS` 为唯一权威**，不写死文件名、不虚构 latest。
> managed.3 首包已标 **SUPERSEDED**，禁止在任何步骤指向它取包。
> 升级合同见 [upgrade.md](upgrade.md)；共享事务合同在 wdev-app 仓库 [upgrade.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-app)；
> 开发规范见仓内 [AGENTS.md](AGENTS.md)；托管面结构 [structure/wdev-manager.md](structure/wdev-manager.md)。

## 1. 身份与边界

- 外部品牌 wdev 只落薄壳：单元名 `wdev-proxy.service`、CLI `wdev-proxy`（组件 id 固定 `llm-proxy`）、authz label。
- 内部身份**不改**：npm 包名 `@bitkyc08/opencodex`、bin `ocx`/`opencodex`、数据目录 `~/.opencodex`、
  `/healthz` 的 `service:"opencodex"`、注入头 `x-opencodex-api-key`、provider namespace、`OPENCODEX_*`/`OCX_*` env 前缀。
- 默认端口 **10100**、默认绑 `127.0.0.1`；**端口是装配期实例特定值**（241 装配为 10101），验收命令按 inventory 实值。
- 数据边界：`~/.opencodex`（config/history/spend-ledger/state-lock）、`~/.codex`、官方 userData（含旧
  `/var/lib/codex-desktop/*`）**原位不迁不删不改属主**；无 purge 路径。
- 235.t 旧生产（`opencodex-proxy.service`，npm 全局树 2.86.0）只列现状（§7），不作为新部署默认路径。

## 2. 发布物与校验

| 形态 | 说明 |
|---|---|
| portable 离线包 `wdev-proxy_<ver>-wdev.<shortsha>_linux-amd64.tar.gz` | 包根=安装树平铺：`bin/ocx.mjs`（Node shim，0755）+ `node_modules/`（依赖整树物化，含真 ELF `node_modules/bun/bin/bun.exe`）+ payload node 固定槽 `gateway/node/bin/node`；全树仅 regular+dir 无 symlink（对齐 manager safe_extract_tar 合同）。**托管安装用这个** |
| npm 源包 `wdev-proxy-<ver>-fork-<shortsha>.npm.tgz` | `npm pack` 形态（解包后 package/ 即 @bitkyc08/opencodex），只服务旧 prod npm 全局链（§7） |
| runtime manifest `<flat 包名>.manifest.json` | 引擎侧发布清单（payload node sha、bun.exe sha/size、runtimeFileCount 等） |

下载与校验（Generic Package Registry；GitLab 是 provenance/下载入口）：

```bash
mkdir -p /data/tmp/wdev-release-pull
curl -sfL --header "PRIVATE-TOKEN: $GLPAT" -o /data/tmp/wdev-release-pull/<file> \
  "https://gitlab.ai-t.wtvdev.com/api/v4/projects/22/packages/generic/wdev-managed/<tag>/<file>"
curl -sfL --header "PRIVATE-TOKEN: $GLPAT" -o /data/tmp/wdev-release-pull/SHA256SUMS \
  "https://gitlab.ai-t.wtvdev.com/api/v4/projects/22/packages/generic/wdev-managed/<tag>/SHA256SUMS"
cd /data/tmp/wdev-release-pull && sha256sum -c SHA256SUMS     # 全 OK 才继续；服务端 file_sha256 同步对账
tar -tzf wdev-proxy_<ver>-wdev.<shortsha>_linux-amd64.tar.gz | head   # 应见 bin/ocx.mjs、node_modules/bun/bin/bun.exe、gateway/node/bin/node
```

向 wdev manager 提交升级时 `manifest.url` 的 host 白名单**只有** `file-235.ai-t.wtvdev.com`
（wdev-app `wdev_manager/artifacts.py` 的 `URL_ALLOWLIST`）；**GitLab 域名直接拒收**。正确序列 = 下载 → sha256
对账 → 放 trusted roots（`~/wdev/manifests` 或 `/data/share/deb` 链路）→ 以 `path` 字段提交。包验收后镜像到
`/data/share/deb/`，匿名 HTTPS `https://file-235.ai-t.wtvdev.com/share/deb/<file>`。

安装门（先门后装）：fleet 根 CA 三条同时成立（导入公钥 + `update-ca-certificates` → 按 SHA-256 指纹锚定位 +
`openssl verify` → 无 `-k` 实探测 22700 落 200/401/403 且 `ssl_verify=0`）。完整命令与指纹见 wdev-app
[deploy.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-app) §3.1；235 生产零接触。

## 3. 安装（托管通道 = wdev 安装器一次 apply）

代理作为 wdev 托管组件安装，就是 wdev-app deploy.md §4.3 的同一次 apply（`--engine-tgz` 传 portable 包）：

```bash
EX=/data/tmp/wdev-extract/opt/codex-desktop/wdev-deploy     # deb 只读提取（dpkg-deb --extract，零 maintainer）
bash $EX/script/wdev-manager/install.sh \
  --with-bin \
  --deb <发布物目录>/wdev_<ver>_amd64.deb \
  --engine-tgz /data/tmp/wdev-release-pull/wdev-proxy_<ver>-wdev.<shortsha>_linux-amd64.tar.gz \
  --gateway-env-source ~/.wdev/gateway.env \
  --proxy-env-source ~/.wdev/proxy.env \
  --apply apply
```

合同要点（细节以 wdev-app deploy.md §4 为准）：

- 全局 `--apply` 必须**前置**于 `apply` 子命令；`--engine-tgz` 不收 npm 源包形态。
- fresh 机必须**先**生成 `~/.wdev/{gateway.env,proxy.env}` 再显式传两个 `--*-env-source`：缺省源是旧 prod
  机器路径 `/etc/codex-desktop/gateway.env`、`/etc/opencodex-proxy.env`（`OLD_ENV_SOURCES`），fresh 缺文件时
  生成 `PORT=0/DISPLAY=:97` 占位（`minimal-generated`），服务必起不来。
- apply 之后：`sudo ~/wdev/units-install.sh`（cp+daemon-reload，绝不 start）→
  `sudo bash ~/wdev/root-integration/install-root-integration.sh`（特权 helper，**manager 树任何改动后必重跑**，
  否则 dispatch rc=2）→ `sudo systemctl start wdev-xvfb.service wdev.service wdev-proxy.service`。
- 在跑旧 proxy 的机器不走 fresh start 序列：切换是独立排空 cutover job（`WDEV_CUTOVER_AUTHORIZED=1` 门 +
  root 脚本；停管清单与本机现役单元名逐条核对，241 现役名是 `ocx-stack-proxy.service`）。
- 引擎落树 = `~/wdev/proxy/releases/<id>/`（一次写入不可变），由 manager 拉起：`bin/ocx.mjs` Node shim 按
  包内布局解析捆绑 bun（override→bundled→PATH）后 exec；`{node}` 由 supervisor 解析 payload node 固定槽
  （regular+X_OK+ELF+`--version`≥22 四重验，缺省不回退系统 ABI，`node-unresolved-fail-closed`）。

旧 prod npm 全局通道（仅 235 现网形态，新装机不走）：`npm install -g --allow-scripts=bun <npm.tgz>`——
`--allow-scripts=bun` 必带，否则捆绑 bun 不落盘（`bin/ocx.mjs` 只剩占位 stub）、systemd 起服即败。

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
`undeclaredToolAllowlist` 键已删除（残留会让 provider PUT 400）；管理面 PUT/PATCH 支持字段热载不重启，
结构变更后的重启走托管事务（§6），不手工 systemctl。托管 opt-in：`wdevManager:{enabled:true, brand:"wdev-proxy"}`
（读-改-写保留其它键；属生产 mutation，cutover 由 root job 执行）。

两道认证门：

1. **进程内**：`/api/*` 一律要凭据，无 loopback 免认证分支。令牌优先级 env `OPENCODEX_ADMIN_AUTH_TOKEN` >
   文件 `~/.opencodex/admin-api-token`（文件态强制 `ocx_admin_` 前缀生成值，手写明文判非法→503）。令牌为部署时
   本地强随机（例 `openssl rand -hex 24`），只落该实例 env 与 authz 注入配置；文档/报告不携带值。
   非 loopback 绑定时数据面另需独立凭据（`OPENCODEX_API_AUTH_TOKEN` 或 `config.apiKeys`，不得与管理令牌同值；
   只用 `x-opencodex-api-key` 头提交）。
2. **authz 边缘注入**：`cc` 前缀域名绑定回源本机 proxy（235 绑定 id 7，`simulate_local=1`），
   `request_rewrite.headers` 覆盖式注入 `x-opencodex-api-key`——走 `cc-*` 入口免带令牌（覆盖发生在授权之后，
   绕不过门 1）。轮换 admin token 后必须同步绑定注入值，否则外部入口整体 401 而 127.0.0.1 正常。
   `simulate_local` 入口的 `/opencodex-session` 自铸会话有管理配置读面，按需把 `/api/*`、`/opencodex-session`
   排除出绑定（只放行 `/v1/*`、`/healthz`）。

```bash
TOKEN=$(sed -n 's/^OPENCODEX_ADMIN_AUTH_TOKEN=//p' ~/.wdev/proxy.env)
P=http://127.0.0.1:10100      # 端口按 inventory 实值（241=10101）
curl -s -H "x-opencodex-api-key: $TOKEN" $P/api/shadow-call-settings
```

## 6. wdev 托管合同（fence 与管理端点）

`wdev-proxy.service`：Type=notify，继承现网收敛语义 Restart=always+5s / KillMode=mixed / TimeoutStopSec=75 /
StartLimit 600x20 / WatchdogSec=120；token 不进单元。可执行坐标全部来自部署 env（请求体永远不能指定
二进制/目录/单元）：installer 追加 `WDEV_MANAGER_HOME`（root，消费方拼 `manager/wdev.py`）、`WDEV_DEPLOY_HOME`、
`WDEV_MANIFEST_ROOT`；`WDEV_MANAGER_PYTHON`（缺省 `/usr/bin/python3`）与 `WDEV_MAINTENANCE_FILE`（fence 文件，
布局派生）由 supervisor 注入。整块 `wdevManager` 缺失=关闭（路由 404 `wdev_disabled`、零 spawn、零 timer）。

- 端点：`GET /api/wdev/components`、`POST /api/wdev/operations`（202=**durable queued**，非成功）、
  `GET /api/wdev/operations[/{id}]`。三动作白名单 `restart/upgrade/configure`；`request-json` 字段白名单
  `{manifestPath, configPatch, expectedRevision, idempotencyKey, maxWait}`（route 预校验：configure 必带
  configPatch、restart 不带载荷、`expectedRevision` 非负整数、maxWait 钳 0-600s）。
- 幂等：同 key+同请求 → `replayed:true` 重放；同 key+异请求 → 409 `wdev_idempotency_conflict` 零副作用；
  202 之后永不补 409。GUI 在 dashboard `#wdev` 页。
- wdev 模式下 `POST /api/update/run` 恒 409（禁 npm 自更新覆盖托管树）；`SIBLING_REFUSED_MANAGEMENT_PATHS`
  禁止兄弟实例驱动本机 manager。
- **维护 fence**：supervisor 写 `WDEV_MAINTENANCE_FILE`（phase=draining/quiesced/expired）；生效期新生成请求
  503 `wdev_maintenance`（`Retry-After: 5`），draining 只放行带 lane 锚定的 tool 续传，quiesced/expired 全拒；
  `/healthz` 带 `maintenance:{active,operationId,phase,strict,fenceEpoch,ack:true}` 回执。fence **只由
  supervisor 经控制面确认释放，永不超时自解**；畸形/过期/不可读文件一律按围栏处理（fail-closed）。
  读面（`GET /v1/models`、`/healthz`、`/readyz`、`/api/*`、`count_tokens`）围栏期保持可答。
- liveness/readiness 分离：`/healthz status:"ok"` 只答进程活着；`/readyz` 在启动后 catalog/config 同步
  settle 且 `ok=true` 才 `status:"ready"`（降级 warning 关门不开）。wdev 事务的 ready 判据取 supervisor
  控制面 `ready:true && state=="ready"`（ipcReady/toolsReady 同源）。

## 7. 235.t 旧生产现状（只读参考，非新部署路径）

`opencodex-proxy.service`（systemd，enabled/active）：npm 全局树（`@bitkyc08/opencodex` 2.86.0，prefix nvm
node v24），`EnvironmentFile=/etc/opencodex-proxy.env`（仅 `OPENCODEX_ADMIN_AUTH_TOKEN` 一键），
`ExecStart=… bin/ocx start --port 10100`，Restart=always/5s、KillMode=mixed、TimeoutStopSec=75，仅绑
127.0.0.1。该通道日常升级走机器运维层脚本 `codex-proxy/script/upgrade-codex-proxy.sh`（不在 GitLab 源码
release；见 upgrade.md §2）。**235 生产面在托管验收窗口全程只读**：不重启、不停止、不杀。托管三件套上
235 的切换条件与边界见 wdev-app deploy.md §11（activate-235 `--apply` 恒拒绝；不存在一键切换）。

## 8. 验收（managed 安装后逐条跑）

```bash
systemctl is-active wdev-proxy.service
wdev-proxy doctor
P=http://127.0.0.1:10100; TOKEN=$(sed -n 's/^OPENCODEX_ADMIN_AUTH_TOKEN=//p' ~/.wdev/proxy.env)   # 端口按 inventory 实值
curl -s --noproxy '*' $P/healthz | head -c 400                  # status:"ok"（liveness）；fence 期带 maintenance.ack 回执
curl -s --noproxy '*' $P/readyz                                 # status:"ready"（readiness）
curl -s -o /dev/null -w '%{http_code}\n' $P/api/config          # 401（认证生效）
curl -s -o /dev/null -w '%{http_code}\n' -H "x-opencodex-api-key: $TOKEN" $P/api/config    # 200
curl -s -H "x-opencodex-api-key: $TOKEN" $P/api/wdev/components # 200 + components 结构
python3 ~/wdev/manager/wdev.py --home /home/aigc operation <uuid>   # 托管事务终态 succeeded
```

- 变更门族（241 已通过，可写为经验）：G5 components、G6 web restart、G6b 幂等重放/409、G7r configure
  CAS/白名单 502、G6p proxy restart（跨组件排空链 + 子 PID/MainPID 代际 + NRestarts=0）、G99 health/PID/
  NRestarts。harness = wdev-app `script/wdev-manager/accept-release-241.py`（235 拒跑；241 上 systemctl 变更
  一律走 manager 受管面）。**G80（云端 durable 三 agent）= BLOCKED**：需用户交互官方 ChatGPT 登录，禁止伪造。
- `/healthz` version 同号换树不构成升级证据；换树证据 = 逐文件 sha256 + 树内契约串 grep（见 upgrade.md）。
- ready 正向判据按目标机集成配置判定：`clientIntegrations.codex:false` 隔离 fixture 下 ready 已实证通过，
  不要求真实登录 websession 作 ready 前置；不宣称超出配置范围的 ready 结论。
- 已知测试基线：opencodex 全量测试有 15 个既有失败（browser-api 1、browser-hub 2、webtop-gateway-wiring 3、
  codex-browser-viewer 9；干净 worktree `c6c9d58a` 可复现），与本次改动无关——验收不记全绿、不计本轮红。

## 9. 交给 agent 的 Prompt（复制即用）

```text
部署 opencodex fork 代理（managed 发布线，Linux amd64，非生产验证包）：
1. 读 GitLab project 22 对应 managed Release（当前已验证坐标 managed.4；以最新 managed.N 的
   manifest.json/SHA256SUMS 为唯一权威，不写死文件名、不拼 latest、不用 SUPERSEDED 包），
   经 Generic Package Registry 下载到 /data/tmp 并 sha256sum -c 对账。
2. 过 CA 安装门（三条同时成立，禁 -k），按 wdev-app deploy.md 只读提取 + install.sh --apply apply
   （--engine-tgz 传 portable 离线包；fresh 先写自有 env 再显式传 --*-env-source），root 集成脚本先于 start；
   禁 dpkg -i 覆盖在跑生产；禁动 235 生产承载面（只读）。
3. 配置 ~/.wdev/proxy.env 注入 OPENAI_APIKEY_API_KEY（默认 API-key 登录，无 key 能起、上游 401）；
   需要改道配 shadowCallIntercept.modelMap+sourceModels；反代配 corsAllowOrigins；加 wdevManager:{enabled:true}；
   管理令牌本地强随机、authz 注入同步，两处一致；token 值不进报告。
4. 验收 §8 全跑 + 变更门族（G5/G6/G6b/G7r/G6p/G99；G80 BLOCKED 如实记）；无账号环境不宣称 ready passed。
5. 报告：版本、认证四态、fence/幂等证据；未跑项写未跑。
```

