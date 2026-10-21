# opencodex fork 代理升级合同（组件发布线 · 无托管）

> **本文坐标**：组件发布线（无托管）代理组件升级。**最新发布 =
> `wdev-proxy_2.89.0-wdev.7cf2a33c_linux-amd64.tar.gz`**（sha256
> `7d4f4eb3b0a17d546f66b4f0dff24626f263ce1421600cd962914bcd5ee5ad68`，197,744,992 字节，
> 6174 regular 成员，源 commit `7cf2a33cc47ec46122934a7bce09c0272152f517`，2026-10-21 核对）。
> **发布通道 = GitLab 公共仓库 `yorkane/wdev-suit`（project 23）Release 部署包直链**；资产名与哈希
> 以该机读清单为唯一权威，不写死文件名、不拼 latest。
> **升级 = 部署层换包 + 重启单元**（§1）：引擎已删除托管集成模块（2026-10-21），无提交面、无
> 托管事务，直启单元 `systemctl restart` 即完成换树（历史注记见 deploy.md §6）。
> 部署见 [deploy.md](deploy.md)；235.t 旧 npm 固定链已退役（§2，只读现状）；235 现役坐标以
> 工作区根 [deploy.md](../deploy.md) 为权威。

## 1. 升级 = 部署层换包 + 重启单元

引擎侧无任何升级提交面：`/api/wdev/*` 恒 404（Unknown endpoint），`POST /api/update/run` 会装上游
非 fork 包覆盖引擎树（**不要用**），`wdev-proxy` CLI 是部署层自带 shim、不由本仓库提供。升级全链路
都在部署层，六步：

1. **取包对账**：按 deploy.md §2 从 wdev-suit Release 直链取包，`sha256sum -c` 必须 OK。
2. **落新 release 目录**：`mkdir -p ~/wdev/proxy/releases/<id>`（如 `engine-2.89.0+7cf2a33c`）后
   `tar -xzf` 解包进去。目录一次写入不可变；手工覆盖在用目录 = 破坏回滚判据，禁止。
3. **备份 unit**：`cp /etc/systemd/system/wdev-proxy.service /data/tmp/wdev-proxy.service.bak-<ts>`。
4. **改 ExecStart** 指向新 release 目录（payload node + `bin/ocx.mjs start --port <装配期实值>`，
   EnvironmentFile 不变）→ `systemctl daemon-reload`。
5. **摘流量后重启**：先停外部入口（authz 下线绑定或停止入口路由），再 `systemctl restart
   wdev-proxy.service`。
6. **验收**：deploy.md §8 全表（healthz ok / readyz ready / 认证 401+200 / 单元 active /
   NRestarts 不增）+ 换树证据 = 新树逐文件 sha256 与包内记录一致 + 树内契约串 grep。

**回滚** = 把 ExecStart 指回旧 release 目录 → `daemon-reload` → `restart`。旧目录因不可变约束原样
在位，回滚不需要重新取包。

历史注记：模块删除前 proxy 走共享托管事务（状态机、fence/快照/回退矩阵）；模块删除后引擎无 fence
消费方，依赖 fence ack 的托管事务对 proxy 组件 fail-closed（notwired）——该整条通道随模块删除作废，
细节与实证以 [deploy.md](deploy.md) §6 为准。

引擎自身的 liveness/readiness 语义不变：`/healthz status:"ok"` 只答进程活着；`/readyz` 在启动后
catalog/config 同步 settle 且 `ok=true` 才 `status:"ready"`（降级 warning 关门不开）。

## 2. 235.t 旧 npm 固定链（已退役，只读现状）

2026-10-20 切换后，旧 npm 升级脚本与 `/data/share/deb/codex-proxy-latest.json` 仅供历史对账：
脚本仍指向 masked 单元，清单缺少脚本依赖的 installed manifest 字段，当前不可执行。
禁止 unmask 旧单元或按旧文档换树；proxy 升级只走 §1 部署层换包。

## 3. portable 离线包解包验证（无外网机器）

```bash
STAGE=/data/tmp/wdev-release-pull   # fleet 规范：临时物放 /data/tmp
# 资产名从 wdev-suit 机读清单确认，替换占位符；不使用通配符混入多个版本
FLAT="$STAGE/wdev-proxy_2.89.0-wdev.7cf2a33c_linux-amd64.tar.gz"
sha256sum "$FLAT"   # 期望 7d4f4eb3b0a17d546f66b4f0dff24626f263ce1421600cd962914bcd5ee5ad68
tar -tzf "$FLAT" | head   # 应见 bin/ocx.mjs、node_modules/bun/bin/bun.exe、gateway/node/bin/node
```

该包的正式落点 = `~/wdev/proxy/releases/<id>/` 新目录（§1 第 2 步）；形状判据见 deploy.md §2。

## 4. 升级窗口纪律

- 235.t 生产承载面 = **现役三单元** `wdev.service`、`wdev-xvfb.service`、`wdev-proxy.service`（及依赖）：
  验证窗口内只读、不重启不杀掉；proxy 换树重启由部署层执行（摘流量→停→起；直启形态就是
  systemctl 直接操作，235 现役仍是旧托管形态，切流是单独受控动作，见 deploy.md §7）。旧三单元
  （`codex-desktop-gateway`、`codex-desktop-xvfb`、`opencodex-proxy`）已 masked，不再是可动面。
- 配置面热载（管理面 PUT/PATCH）不重启即生效；结构变更后的重启由部署层摘流量后 systemctl。
- 换树证据 = 逐文件 sha256 + 树内契约串 grep；`/healthz` 的 version 同号换树不构成证据（本 fork 常态）。
  restart 的代际证据 = 子进程新 PID + 单元 MainPID 代际 + NRestarts=0（直启口径，241.t 实测）。
- 托管门族随模块删除**作废**；proxy 验收 = deploy.md §8 本表（healthz/readyz + 认证判据 + 单元判据）。
  web 组件门族不受影响。成功**不代表三件套模型 E2E**——G80（云端 durable 三 agent）= **BLOCKED**：
  需用户交互官方 ChatGPT 登录（profile cookies=0 + network.block），禁止伪造 auth；
  CLI 直连 router 不算过门。

## 5. 跨机推广

逐机循环（无自动上线队列）：按 deploy.md §2 取包对账 → 落 `~/wdev/proxy/releases/<id>/` 新目录 →
直启 unit（首次部署写 §3 单元，已有则改 ExecStart）→ 按 deploy.md §8 验收。

- **241.t 七场景离线回归 ALL_DONE_PASS 先行**，再做其它机；241 全绿 ≠ 其它机就绪（env 真源、端口
  装配值、authz 绑定、官方数据形态逐机核对，env 用 `/proc/<pid>/environ` 实测）。
- 241.t 对 2.89.0 包的实测口径 = **七场景回归 + 直启验收通过**（直启单元 active、NRestarts=0、
  healthz ok 2.89.0、readyz ready、认证 401/200、`/api/wdev/components` 带 token 404），
  **不宣称过了 241 正式门/托管门族**。
- web 组件（gateway deb / 3737）的跨机推广与 fleet runbook 属 wdev-app manager 侧合同（ref
  `codex/wdev-managed-upgrade`），与 proxy 直启线无关。
