# opencodex fork 代理部署合同（managed 发布线）

> **本文坐标**：managed 发布线的代理组件（`wdev-proxy.service`）。**最新发布 = GitLab tag
> `wdev-proxy-v2.87.0-managed.7`**（project 22 `yorkane/wdev-proxy`，sourceCommit `b9eb54e6f0`，
> ref `codex/wdev-manager-integration`），配对 web tag `v2026.10.19-managed.7`。
> **标签不代表已验证**：本次核对的 managed 发布清单为 `production:false`、`validatedOn:null`，
> 尚未获得正式升级准入。源码坐标取 Release manifest，不能由包文件名或哈希反推。
> managed.3 首包已标 **SUPERSEDED**，禁止在任何步骤指向它取包。
> **资产名与哈希一律以对应 Release 的 `manifest.json` / `SHA256SUMS` 为唯一权威**，
> 使用对应 Release 的明确包版本；Release latest permalink 不代表已验证版本。
> 升级合同见 [upgrade.md](upgrade.md)；共享事务合同在 wdev-app 仓库
> [upgrade.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-app/-/blob/codex/wdev-managed-upgrade/upgrade.md)
> （该组文档只在 `codex/wdev-managed-upgrade` ref 上，main/dev 不可达，引用必须带 ref）；
> 开发规范见仓内 [AGENTS.md](AGENTS.md)。**引擎不含托管集成模块**（wdevManager 配置块、/api/wdev
> 路由、维护 fence 消费方、GUI #wdev 页均已于 2026-10-21 移除，见 §6）。

## 1. 身份与边界

- 外部品牌 wdev 只落薄壳：单元名 `wdev-proxy.service`、CLI `wdev-proxy`（组件 id 固定 `llm-proxy`）、authz label。
- 内部身份**不改**：npm 包名 `@bitkyc08/opencodex`、bin `ocx`/`opencodex`、数据目录 `~/.opencodex`、
  `/healthz` 的 `service:"opencodex"`、注入头 `x-opencodex-api-key`、provider namespace、`OPENCODEX_*`/`OCX_*` env 前缀。
- 默认端口 **10100**、默认绑 `127.0.0.1`；**端口是装配期实例特定值**（241 装配为 10101），验收命令按 inventory 实值。
- 数据边界：`~/.opencodex`（config/history/spend-ledger/state-lock）、`~/.codex`、官方 userData（含旧
  `/var/lib/codex-desktop/*`）**原位不迁不删不改属主**；无 purge 路径。
- 235.t 已于 2026-10-20 完成 cutover（§7）：10100 由托管线承载，旧 npm 链退役。

## 2. 发布物与校验

| 形态 | 说明 |
|---|---|
| portable 离线包 `wdev-proxy_<ver>-wdev.<shortsha>_linux-amd64.tar.gz` | 包根=安装树平铺：`bin/ocx.mjs`（Node shim，0755）+ `node_modules/`（依赖整树物化，含真 ELF `node_modules/bun/bin/bun.exe`）+ payload node 固定槽 `gateway/node/bin/node`；全树仅 regular+dir 无 symlink（对齐 manager safe_extract_tar 合同）。**托管安装用这个** |
| npm 源包 `wdev-proxy-<ver>-fork-<shortsha>.npm.tgz` | `npm pack` 形态，只服务已退役的旧 prod npm 全局链（§7），托管线不用 |
| Release manifest.json（**schema=2**） | GitLab 发布索引（tag/sourceCommit/production/validatedOn/artifacts[]）。它是发布清单，**不是升级清单**——升级事务吃的是 schema=1 清单（upgrade.md §1，`artifacts.py` 强制 `schema==1`），两文件同名不同物，极易混 |

下载与校验（Generic Package Registry）。**URL 路径段是包版本 `2026.10.19-managed.N`，不是 git tag**
（实测：包版本 → 200；git tag `wdev-proxy-v2.87.0-managed.7` → 404）：

```bash
set -eu
V=2026.10.19-managed.7   # 示例包版本；从 Release 资产下载地址核对，不从 git tag 推导
mkdir -p /data/tmp/wdev-release-pull && cd /data/tmp/wdev-release-pull
for f in manifest.json SHA256SUMS; do
  curl -sfL --header "PRIVATE-TOKEN: $GLPAT" -O \
    "https://gitlab.ai-t.wtvdev.com/api/v4/projects/22/packages/generic/wdev-managed/$V/$f"
done
# 阅读 manifest.json，确认本次 portable 资产名后替换下方占位符
ASSET='<portable资产名>'
curl -sfL --header "PRIVATE-TOKEN: $GLPAT" -O \
  "https://gitlab.ai-t.wtvdev.com/api/v4/projects/22/packages/generic/wdev-managed/$V/$ASSET"
# SHA256SUMS 还可能包含未下载的资产，只校验本次 portable 包；必须精确命中一条
python3 -c 'import sys;rows=[l for l in open("SHA256SUMS") if len(l.split())==2 and l.split()[1].lstrip("*")==sys.argv[1]];assert len(rows)==1;open("portable.sha256","w").write(rows[0])' "$ASSET"
sha256sum -c portable.sha256      # 必须 OK 才继续
tar -tzf "$ASSET" | head   # 应见 bin/ocx.mjs、node_modules/bun/bin/bun.exe、gateway/node/bin/node
```

**提交给 manager 的落点合同（trusted roots）**：升级 manifest 的 `path` 受可信根约束（wdev-app
`wdev_manager/artifacts.py` + `transactions.py`：trusted_roots 默认 = `<deploy home>/wdev` 与
`<deploy home>/.wdev`，要求绝对路径、无 .. 段、realpath containment；`path` 与 `url` 必须二选一）。
`/data/share/deb` **不是**可信根，`path` 指向它会以「artifact path 不在可信根内」拒收。正确序列 =
下载 → `sha256sum -c` 对账 → 包 `cp` 到 `~/wdev/artifacts/`、清单落 `~/wdev/manifests/` → 以 `path` 提交
（241 的 `~/wdev/manifests/m7-web-upgrade.json` → `path: ~/wdev/artifacts/….deb` 即实测样本形态）。
`url` 字段 host 白名单**只有** `file-235.ai-t.wtvdev.com`（`URL_ALLOWLIST`），GitLab 域名直接拒收；
`/data/share/deb/` 的匿名镜像（`https://file-235.ai-t.wtvdev.com/share/deb/<file>`）可达，用于历史对账与发布留档。

安装门（先门后装）：fleet 根 CA 三条同时成立（导入公钥 + `update-ca-certificates` → 按 SHA-256 指纹锚定位 +
`openssl verify` → 无 `-k` 实探测 22700 落 200/401/403 且 `ssl_verify=0`）。完整命令与指纹见 wdev-app
[deploy.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-app/-/blob/codex/wdev-managed-upgrade/deploy.md) §3.1。

## 3. 安装（托管通道 = wdev 安装器一次 apply）

代理作为 wdev 托管组件安装，就是 wdev-app deploy.md §4.3 的同一次 apply（`--engine-tgz` 传 portable 包）：

```bash
EX=/data/tmp/wdev-extract/opt/codex-desktop/wdev-deploy     # deb 只读提取（dpkg-deb --extract，零 maintainer）
bash $EX/script/wdev-manager/install.sh \
  --with-bin \
  --deb <发布物目录>/wdev_<ver>_amd64.deb \
  --engine-tgz ~/wdev/artifacts/wdev-proxy_<ver>-wdev.<shortsha>_linux-amd64.tar.gz \
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
  root 脚本；停管清单必须按目标机 inventory 与监听进程核对，不沿用旧单元名；235 实录见 §7）。
- 引擎落树 = `~/wdev/proxy/releases/<id>/`（一次写入不可变），由 manager 拉起：`bin/ocx.mjs` Node shim 按
  包内布局解析捆绑 bun（override→bundled→PATH）后 exec；`{node}` 由 supervisor 解析 payload node 固定槽
  （regular+X_OK+ELF+`--version`≥22 四重验，缺省不回退系统 ABI，`node-unresolved-fail-closed`）。

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
结构变更后的重启由部署层执行（对 wdev-proxy.service 直接 systemctl，或由部署层的单元操作）。

引擎侧无托管集成面：没有 wdevManager 配置块，没有 /api/wdev 路由，没有维护 fence 消费方。
部署层（wdev-app manager）与引擎的交互只剩两条通道——systemd 单元生命周期与 EnvironmentFile 注入的
配置；`wdev-proxy` CLI 是部署层自带的 shim，不由本仓库提供。

两道认证门：

1. **进程内**：`/api/*` 一律要凭据，无 loopback 免认证分支。令牌优先级 env `OPENCODEX_ADMIN_AUTH_TOKEN` >
   文件 `~/.opencodex/admin-api-token`（文件态强制 `ocx_admin_` 前缀生成值，手写明文判非法→503；cutover 后
   真源是 env，文件仅作回落）。令牌为部署时本地强随机（例 `openssl rand -hex 24`），只落该实例 env 与 authz
   注入配置；文档/报告不携带值。非 loopback 绑定时数据面另需独立凭据（`OPENCODEX_API_AUTH_TOKEN` 或
   `config.apiKeys`，不得与管理令牌同值；只用 `x-opencodex-api-key` 头提交）。
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

## 6. 引擎不提供托管集成（2026-10-21 移除）

本仓库曾提供 opt-in 的托管集成模块（config 块 `wdevManager`、`/api/wdev/components` 与
`/api/wdev/operations` 路由、维护 fence 消费方、`POST /api/update/run` 的 409 门、GUI `#wdev`
页，注册依赖 `wdevManager` 块与部署 env）。该模块已整体删除，引擎侧对应语义全部不存在：

- 配置里的 `wdevManager` 块是未知键（schema 无此条目）；请求 `/api/wdev/*` 不再命中任何路由。
- 引擎**不读** `WDEV_MAINTENANCE_FILE` 等任何 `WDEV_*` env；supervisor 写下的 fence 文件没有消费方，
  `/healthz` 永不携带 `maintenance.ack` 回执。
- 因此**依赖 fence ack 的托管升级事务对 proxy 组件将 fail-closed（notwired）**：supervisor 无法从
  引擎侧收到排空确认，动 proxy 的事务在 fence 步失败。
- proxy 的受控重启只剩部署层语义：先摘流量（authz 下线或停止入口路由），再 `systemctl restart
  wdev-proxy.service`；`Restart=always` 的收敛语义（KillMode=mixed / TimeoutStopSec=75 / StartLimit
  600x20 / WatchdogSec=120）由单元文件定义，属部署层合同，细节见 wdev-app deploy.md。

liveness/readiness 分离保留：`/healthz status:"ok"` 只答进程活着；`/readyz` 在启动后 catalog/config
同步 settle 且 `ok=true` 才 `status:"ready"`（降级 warning 关门不开）。

## 7. 235.t 现状：cutover 已完成（2026-10-20），npm 链退役

托管三件套 2026-10-20 01:51 UTC 接管 235：`wdev-proxy.service` enabled+active（10100，进程链 supervisor →
payload node → 捆绑 bun.exe 监听，`MainPID ≠ 端口属主 PID 是正常稳态`）、`wdev.service`（3737）、
`wdev-xvfb.service` active。切换 = 独立排空 root cutover job
（`~/wdev/operations/cutover-20261020T012833Z.tsv` 逐行 rc0），**不是** activate-235 脚本——该脚本
`--apply` 恒 fail-closed（理由 legacy-admission-unavailable，见 wdev-app deploy.md §11），两者不矛盾：
一键切换从来不存在。旧面全部退役：`opencodex-proxy.service`、`codex-desktop-gateway.service`、
`codex-desktop-xvfb.service` 及 watchdog/reaper 等 timer **masked**（单元文件移入 `/data/.trash/`，
`is-enabled` 报 masked）。npm 全局树残留（`@bitkyc08/opencodex` 2.86.0）不承载任何端口；
`/etc/opencodex-proxy.env` 为历史文件，现役单元不读（现役 EnvironmentFile = `~/.wdev/proxy.env`）。
**禁动清单随之换名**：现役承载面 = `wdev.service` / `wdev-xvfb.service` / `wdev-proxy.service`。

现役引擎树 = `~/wdev/proxy/releases/engine-2.87.0+3c30b15a5e02`（唯一 release 目录），性质 =
**import-baseline**（`~/wdev/manifests/engine-latest.json`：`validatedOn:"imported"`、`validated:false`、
note 明记「未经 241 验收，不得晋升 active」）——当前生产跑的是基线导入包，**不是已验证发布**。

npm 固定链（机器运维层脚本 `wdev-proxy/script/upgrade-codex-proxy.sh`，不在 GitLab 源码 release；发布清单
`/data/share/deb/codex-proxy-latest.json`）**已退役且当前不可执行**：脚本 `UNIT` 指向 masked 的
`opencodex-proxy.service`；latest 清单缺 `installedManifestPath`/`installedManifestSha256` 两键（脚本 `jq -er`
硬依赖，2.87/2.88/2.89 三轮均未补）。脚本与归档产物只读保留历史，**禁止按旧文档执行 npm 换树升级**
（细节 upgrade.md §2）。


## 8. 验收（managed 安装后逐条跑）

```bash
systemctl is-active wdev-proxy.service
wdev-proxy doctor    # CLI 面（不依赖 opt-in）：layout/activation/disk-budget/control-socket-web/control-socket-llm-proxy
P=http://127.0.0.1:10100; TOKEN=$(sed -n 's/^OPENCODEX_ADMIN_AUTH_TOKEN=//p' ~/.wdev/proxy.env)
curl -s --noproxy '*' $P/healthz | head -c 400    # status:"ok"（liveness）
curl -s --noproxy '*' $P/readyz                   # status:"ready"（readiness）
curl -s -o /dev/null -w '%{http_code}\n' $P/api/config                               # 401（认证生效）
curl -s -o /dev/null -w '%{http_code}\n' -H "x-opencodex-api-key: $TOKEN" $P/api/config  # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "x-opencodex-api-key: $TOKEN" $P/api/wdev/components
#   恒 404（路由已随模块删除，任何机器都是 404 —— 这是预期，不是故障）
```

- 历史门族 G5/G6b/G7r/G6p（依赖引擎侧 /api/wdev 面）随模块删除**不可再跑**；proxy 验收只剩上表
  的 healthz/readyz/认证判据 + 部署层单元判据（unit active、子进程 PID 代际、NRestarts）。
  web 组件门族不受影响（manager 侧直操作）。验收窗口内 235 现役三单元只读。
- `/healthz` version 同号换树不构成升级证据；换树证据 = 逐文件 sha256 + 树内契约串 grep（见 upgrade.md）。
- ready 正向判据按目标机集成配置判定：`clientIntegrations.codex:false` 隔离 fixture 下 ready 已实证通过，
  不要求真实登录 websession 作 ready 前置；不宣称超出配置范围的 ready 结论。

## 9. 操作索引

按 §2 取包并核验，按 §3 安装，按 §8 验收；事务与回滚细节见 [upgrade.md](upgrade.md)。

