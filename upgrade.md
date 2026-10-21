# opencodex fork 代理升级合同（managed 发布线）

> **本文坐标**：managed 发布线代理组件升级。**最新发布 = tag `wdev-proxy-v2.87.0-managed.7`
> （`production:false`、`validatedOn:null`；sourceCommit `b9eb54e6f0`，2026-10-21 核对），尚未获得
> 正式升级准入。源码坐标取 Release manifest，不能由包文件名或哈希反推。
> **资产名与哈希以对应 Release 的 `manifest.json` / `SHA256SUMS` 为唯一权威**，不写死文件名、
> 不拼 latest。
> **主通道 = 部署层换树**：新包落 `~/wdev/proxy/releases/<id>/` 后由部署层重启单元。**引擎已删除
> 托管集成模块**（2026-10-21）：无 `/api/wdev` 提交面、无 fence 消费方，依赖 fence ack 的托管升级
> 事务对 proxy 组件将 fail-closed（notwired）——共享事务合同（状态机、失败与回退矩阵、跨组件排空链）
> 中凡涉及 proxy fence 的条款以 wdev-app
> [upgrade.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-app/-/blob/codex/wdev-managed-upgrade/upgrade.md)
> 的当前版为准，本文只保留引擎侧事实。
> 部署见 [deploy.md](deploy.md)；235.t 旧 npm 固定链已退役（§2，只读现状）。

## 1. proxy 升级：部署层换树（引擎侧无提交面）

模块删除后引擎侧只剩这些面：`POST /api/update/run`（npm 自更新入口，托管树机器**不要**用它——它会装
上游非 fork 包覆盖引擎树）、管理面重启类端点（走部署层 gate 语义）、以及 `wdev-proxy` CLI
（部署层自带 shim，直连 manager，不读 proxy config，其可用性由部署层合同定义）。历史 HTTP/GUI 提交面
（`POST /api/wdev/operations`、`#wdev` 页）恒 404，不再提供。

升级 manifest（**schema=1**，`wdev_manager/artifacts.py` 校验；GitLab Release 附带的 manifest.json 是
**schema=2 发布索引，不能直接提交**——先按 deploy.md §2 取资产，自落 trusted roots 后按 schema=1 组清单）。
关键字段与拒收条件：

| 项 | 合同 |
|---|---|
| `componentId`/`artifactType` | `llm-proxy` ↔ `engine`；跨类型拒收 |
| `sha256` | 64 hex；下载/落盘强校验，不符拒收 |
| `buildId`/`build` 五分量 | 全分量一致才算同一 release（no-op 判据）；仅 version+sha 相同**不构成** no-op |
| `url` 或 `path` | **二选一**（都填或都空拒收）。`url`：仅 https 且 host 白名单**只有** `file-235.ai-t.wtvdev.com`（`URL_ALLOWLIST`）；**GitLab Release 链接不可作 manifest url**（先下载+`sha256sum -c` 对账，cp 到 `~/wdev/artifacts/` 后用 `path` 提交）。`path`：绝对路径、无 .. 段、realpath 落在 trusted_roots（`~/wdev`、`~/.wdev`）内——**`/data/share/deb` 不是可信根，指向即拒收** |
| `validatedOn` | 正式通道必须 `"241.t"`（`REQUIRED_VALIDATED_ON`）。引导/快照走公开 CLI `import-baseline`（内部 `allow_unvalidated`）：**一次调用只导一类**（判序 deb→engine-tgz→engine-dir，`--deb` 命中即 return），deb 与 engine 拆两次独立调用，全局 `--apply` 前置子命令：`python3 install.py --engine-tgz wdev-proxy_<ver>-wdev.<short>_linux-amd64.tar.gz --apply import-baseline`（engine-only；web 侧对应 `--deb wdev_<ver>_amd64.deb --apply import-baseline`）。记 `validatedOn:"imported"`、`validated:false` |

**两条真实边界（并列，不得绕过）**：

1. **裸官方 deb 不能直接 stage**：payload 合同要求含 gateway 的适配合并包（判据见 wdev-app upgrade.md §2）。
2. **未过 241 门的新包不得填 `validatedOn:"241.t"`**：Release manifest 的 `validatedOn=null` 表示
   本机验包+门级证据，不等于正式 stage 准入。**实测现状：engine/proxy 侧至今没有任何
   `validatedOn:"241.t"` 的清单**（managed.1–7 全部 null + `production:false`）；两条 241.t 证据
   （web sealed manifest、241 的 `m7-web-upgrade.json`）都是 **web 组件**，不构成引擎侧准入。
   引擎侧正式 stage 准入 = 尚未达成；要上生产托管面，先逐机 241 验收再出带 `validatedOn:"241.t"`
   的新清单。

历史事务状态机（`queued → … → succeeded`，含 fence/快照/回退矩阵）属 wdev-app 部署层合同，本文不再
展开。**proxy 组件现状**：引擎无 fence 消费方（`WDEV_MAINTENANCE_FILE` 不读，`/healthz` 无
`maintenance.ack` 回执），supervisor 对 proxy 的 acquire 拿不到 ack=`notwired` → 事务 fail-closed。
引擎自身的 liveness/readiness 语义保留：`/healthz status:"ok"` 只答进程活着；`/readyz` 在启动后
catalog/config 同步 settle 且 `ok=true` 才 `status:"ready"`（降级 warning 关门不开）。


## 2. 235.t 旧 npm 固定链（已退役，只读现状）

2026-10-20 切换后，旧 npm 升级脚本与 `/data/share/deb/codex-proxy-latest.json` 仅供历史对账：
脚本仍指向 masked 单元，清单缺少脚本依赖的 installed manifest 字段，当前不可执行。
禁止 unmask 旧单元或按旧文档换树；proxy 升级只走 §1 部署层换树。

## 3. portable 离线包解包验证（无外网机器）

```bash
STAGE=/data/tmp/wdev-release-pull   # fleet 规范：临时物放 /data/tmp
# 从 Release manifest 确认单个资产名，替换占位符；不使用通配符混入多个版本
FLAT="$STAGE/<portable资产名>"
sha256sum "$FLAT"                                   # 与 manifest.json / SHA256SUMS 对账
tar -tzf "$FLAT" | head                             # 应见 bin/ocx.mjs、node_modules/bun/bin/bun.exe、gateway/node/bin/node
```

- 该包的正式落树 = `--engine-tgz` 输入（首装 apply）；后续换树由部署层落 `~/wdev/proxy/releases/<id>/`
  新目录后重启单元；release 目录一次写入不可变，手工覆盖在用目录 = 破坏 no-op/回滚判据，禁止。

## 4. 升级窗口纪律

- 235.t 生产承载面 = **现役三单元** `wdev.service`、`wdev-xvfb.service`、`wdev-proxy.service`（及依赖）：
  验证窗口内只读、不重启不杀掉；proxy 换树重启由部署层执行（摘流量→停→起）。旧三单元
  （`codex-desktop-gateway`、`codex-desktop-xvfb`、`opencodex-proxy`）已 masked，不再是可动面。
- 配置面热载（管理面 PUT/PATCH）不重启即生效；结构变更后的重启由部署层摘流量后 systemctl。
- 换树证据 = 逐文件 sha256 + 树内契约串 grep；`/healthz` 的 version 同号换树不构成证据（本 fork 常态）。
  proxy restart 的代际证据 = 子进程新 PID + systemd MainPID 代际 + NRestarts=0（241 G6p 口径）。
- cutover 后首升级选 idle 窗：真官方数据在跑时坏候选可正当收口 protected（241 实录），fixture RPO0 与真
  数据面 NOTRUN 两口径不互冒。
- 历史门族 G5/G6b/G7r/G6p（依赖引擎侧 /api/wdev 面）随模块删除不可再跑；proxy 验收 = healthz/readyz
  + 认证判据 + 部署层单元判据。web 组件门族（G6 等）不受影响。成功**不代表三件套模型 E2E**——
  G80（云端 durable 三 agent）= **BLOCKED**：需用户交互官方 ChatGPT 登录（profile cookies=0 +
  network.block），禁止伪造 auth；CLI 直连 router 不算过门。

## 5. 跨机推广

- 流程与逐机坑以 wdev-app
  [doc/WDEV-FLEET-UPGRADE-RUNBOOK.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-app/-/blob/codex/wdev-managed-upgrade/doc/WDEV-FLEET-UPGRADE-RUNBOOK.md)
  为操作手册：盘点（`/proc/<pid>/environ` 实测 env 真源；现役单元名逐条核对）→ CA 门 → plan 干跑
  → apply → root 集成 → 排空 admission（legacy 无 fence 实证门）→ 冷 census+冷快照 → cutover（root 独立
  job）→ 装配覆盖（端口保号四处一致）→ 验收 → root 冻结 + validatedOn seal（独立 job）。
- manager 自升级 = 重跑 apply 后**必重跑** `install-root-integration.sh`（trustedSha256 对齐，否则 dispatch rc=2）。
- 241 全绿 ≠ 其它机就绪；`activate-235.py --apply` 恒 fail-closed（235 实际切换走 root cutover job，
  见 deploy.md §7）；无自动上线队列。

