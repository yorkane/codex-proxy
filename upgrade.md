# opencodex fork 代理升级合同（managed 发布线）

> **本文坐标**：managed 发布线代理组件升级。**当前已验证坐标 = managed.4**：tag
> `wdev-proxy-v2.87.0-managed.4`（portable tar.gz sha256
> `3c30b15a5e02cd4151d618b0df55a87ea6c4e43bf51d3f659ced2a63de759254`，197,644,140 B；npm.tgz sha256
> `361f6b78a9e84f12a62945682f8dee40566d1b2aa8b06b102de78fc7ac8e6ecf`）。**managed.5 为事务修复与受控 fence
> 回收后的验收包，坐标未定**：下文以 `<managed.N>` 占位，**资产名与哈希以对应 Release 的
> `manifest.json` / `SHA256SUMS` 为唯一权威**。managed.3 首包已标 SUPERSEDED，禁止指向它取包。
> **主通道 = wdev manager 托管事务**（`wdev-proxy.service`，`wdev-proxy upgrade`）；共享事务合同（状态机、
> 失败与回退矩阵、fence 回收、跨组件排空链）以 wdev-app 仓库 [upgrade.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-app)
> §2-§8 为权威，本文不重复细则。部署见 [deploy.md](deploy.md)；235.t 旧 prod 固定发布链属机器运维层
> （`codex-proxy/script/` 不在 GitLab 源码 release 内），本文只列只读现状。

## 1. managed 托管升级（主通道）

```bash
wdev-proxy upgrade <manifest.json>                       # 受理面：exit 0 = durable queued（202+operationId），非成功
python3 ~/wdev/manager/wdev.py --home /home/aigc operation <uuid>    # 终态查询：phase=succeeded 才算完成
wdev-proxy restart                                       # 受控重启（统一排空 gate）
wdev-proxy doctor ; wdev-proxy status
```

入口三态（CLI/HTTP/GUI 同一事务面）：HTTP `POST /api/wdev/operations`（管理面鉴权 `x-opencodex-api-key` 或
等价头；token 值不进文档）与 GUI `#wdev` 页；三动作白名单 `restart/upgrade/configure`；字段白名单
`{manifestPath, configPatch, expectedRevision, idempotencyKey, maxWait}`（route 预校验 400；maxWait 钳 0-600s）。
幂等合同：同 key+同请求 → `replayed:true` 重放绑定 operation；同 key+异请求 → 409
`wdev_idempotency_conflict` 零副作用；202 之后永不补 409。wdev 模式下 `POST /api/update/run` 恒 409
（禁 npm 自更新覆盖托管树）。

manifest（schema=1，`wdev_manager/artifacts.py` 校验）关键字段与拒收条件：

| 项 | 合同 |
|---|---|
| `componentId`/`artifactType` | `llm-proxy` ↔ `engine`；跨类型拒收 |
| `sha256` | 64 hex；下载/落盘强校验，不符拒收 |
| `buildId`/`build` 五分量 | 全分量一致才算同一 release（no-op 判据）；仅 version+sha 相同**不构成** no-op |
| `url` | 仅 https 且 host 白名单**只有** `file-235.ai-t.wtvdev.com`；**GitLab Release 链接不可作 manifest url**（先下载+`sha256sum -c` 对账，落 trusted roots 用 `path` 提交） |
| `validatedOn` | 正式通道必须 `241.t`（`REQUIRED_VALIDATED_ON`）。引导/快照走公开 CLI `import-baseline`：**一次调用只导一类**（判序 deb→engine-tgz→engine-dir，`--deb` 命中即 return），deb 与 engine 拆两次独立调用，全局 `--apply` 前置子命令：`python3 install.py --engine-tgz wdev-proxy_<ver>-wdev.<short>_linux-amd64.tar.gz --apply import-baseline`（engine-only；web 侧对应 `--deb wdev_<ver>_amd64.deb --apply import-baseline`）。记 `validatedOn:"imported"`、`validated:false` |

**两条真实边界（并列，不得绕过）**：

1. **裸官方 deb 不能直接 stage**：payload 合同要求含 gateway 的适配合并包（判据见 wdev-app upgrade.md §2）。
2. **未过 241 门的新包不得填 `validatedOn:"241.t"`**：Release manifest 的 `validatedOn=null`（managed.4 实测
   字段值）表示本机验包+门级证据，不等于正式 stage 准入；要上生产托管面，先逐机 241 验收再出带
   `validatedOn:"241.t"` 的新清单。

事务状态机：`queued → preflight → wait_idle → stage → quiesce → snapshot → candidate_start → verify → commit →
succeeded`，终态 `succeeded/rolled_back/failed/protected`。代理侧要点：

- fence 走 supervisor 控制 socket（缺 ack=`notwired`，无 fallback）；idle 未知视作 busy；maxWait 超时 FAIL
  不 force；**动 proxy 必先 fence web**（跨组件排空链：web acquire/quiesce → proxy acquire/quiesce →
  active 归零 hard fence）。
- fence 生效期新生成请求 503 `wdev_maintenance`（`Retry-After: 5`）；draining 只放行带 lane 锚定的 tool
  续传（无 lane 头的第二腿、gzip 续传腿拒，重试即可）；quiesced/expired 全拒生成工作；读面可答；
  `/healthz` 带 `maintenance.ack:true` 回执。**fence 永不超时自解**。
- precommit 全 dataRoots 冷快照可回滚：commit 前失败且证明无新真实写入 → 同原路径冷还原 + last-good →
  `rolled_back`（RPO=0）；有写/无法证明 → `protected` 封存现场保持 fence。**commit 后绝不快照回退**；
  回代码保最新数据仅当 241 兼容矩阵实证命中，否则 protected 向前修复。quarantine 命中 buildId 拒自动重试。
- restart 的失败出口（managed.5 收紧，**待 241 门验证**）：有界重试启动 last-good（≤5 次/约 10s，含控制
  socket 瞬时拒绝）→ 健康校验（unit active + ready/ipcReady/toolsReady + fence 仍归本 op）→ 先落
  `rolled_back` 再释放 fence；不就绪 => `protected` 且 fence 保持。终态残留 fence 的受控回收入口见
  wdev-app upgrade.md §5（**待 241 门验证**；禁止手删 `~/wdev/state/maintenance-*.json`）。
- ready 判据 = supervisor 控制面 `ready:true && state=="ready"`；`/healthz status:"ok"` 只是 liveness，
  `/readyz` 在启动后 catalog 同步 settle 后才 ready（降级 warning 关门不开）。两者都不参与 ready 判定链。

## 2. 235.t 旧 prod 固定发布链（只读现状，非操作指引）

235 现网代理升级的历史通道 = 机器运维层脚本 `codex-proxy/script/upgrade-codex-proxy.sh`（**不在 GitLab
源码 release**，仓库内无此脚本）。现状要点（供对账，不给可执行序列）：安装源固定
`/data/share/deb/codex-proxy-latest.json`（preflight 硬门：`validatedOn=="241.t"` + `validatedKitPass>=23` +
产物路径前缀 `/data/share/deb/` + 包/清单 sha256 对账 + 包内 package.json name/version 断言）；阶段序
preflight→wait_idle→backup→install(npm 全局换树)→health→逐文件哈希→隔离 kit(23)→真实烟测→preservation；
失败 trap 自动回滚（坏树移 `/data/.trash/`，现场目录，`flock` 单任务）；同包幂等=`same_package=1` 只验收
不重启。已知坑：现版 latest.json 缺 `installedManifestPath/installedManifestSha256` 两键（脚本 `jq -er` 硬
依赖），发布轮必须补齐。**managed 三件套上 235 后此通道退役**；与托管面并存期间以 inventory 托管组件为
唯一写者，勿双跑。切换边界见 wdev-app deploy.md §11。

## 3. portable 离线包解包验证（无外网机器）

```bash
STAGE=/data/tmp/wdev-release-pull   # fleet 规范：临时物放 /data/tmp
FLAT=$(ls $STAGE/wdev-proxy_*_linux-amd64.tar.gz)   # 资产名以 Release manifest.json 为准
sha256sum "$FLAT"                                   # 与 manifest.json / SHA256SUMS 对账
tar -tzf "$FLAT" | head                             # 应见 bin/ocx.mjs、node_modules/bun/bin/bun.exe、gateway/node/bin/node
```

- 该包的正式落树 = `--engine-tgz` 输入（首装 apply 或托管事务 `wdev-proxy upgrade`）；release 目录一次写入
  不可变，手工覆盖在用目录 = 破坏 no-op/回滚判据，禁止。
- 235 旧 prod npm 通道的换树输入是 npm 源包（`--allow-scripts=bun` 必带，原因见 deploy.md §3 尾注）。
- 241 在用的旧 prefix tar（`ocx-*-proxy.tar.gz`）为历史通道，与 portable 包按目标机 ExecStart 形态二选一。

## 4. 升级窗口纪律

- 235.t 生产承载面（`codex-desktop-gateway`、3737、`opencodex-proxy`、10100 及依赖）**只读**：验证窗口内
  不重启不杀掉；托管升级由 manager 事务动 proxy 自身单元（fence→停→起链），不触旧 prod 面。
- 配置面热载（管理面 PUT/PATCH）不重启即生效；结构变更后的重启走托管事务，不手工 systemctl；
  241.t 上不能直接 systemctl 变更，必须走 manager 受管面（`~/wdev/manager/wdev.py --home /home/aigc`）。
- 换树证据 = 逐文件 sha256 + 树内契约串 grep；`/healthz` 的 version 同号换树不构成证据（本 fork 常态）。
  proxy restart 的代际证据 = 子进程新 PID + systemd MainPID 代际 + NRestarts=0（241 G6p 口径）。
- cutover 后首升级选 idle 窗：真官方数据在跑时坏候选可正当收口 protected（241 实录），fixture RPO0 与真
  数据面 NOTRUN 两口径不互冒。
- 241 门族 G5/G6/G6b/G7r/G6p/G99 已 PASS（全只读/受管面判据，harness 235 拒跑）；成功**不代表三件套模型
  E2E**——G80（云端 durable 三 agent）= **BLOCKED**：需用户交互官方 ChatGPT 登录（profile cookies=0 +
  network.block），禁止伪造 auth；CLI 直连 router 不算过门。
- 已知测试基线：opencodex 全量测试 15 个既有失败（browser-api 1、browser-hub 2、webtop-gateway-wiring 3、
  codex-browser-viewer 9；干净 worktree `c6c9d58a` 可复现），与本次改动无关——验收按族分列，不当本轮红、
  不写全绿。

## 5. 跨机推广

- 流程与逐机坑以 wdev-app [doc/WDEV-FLEET-UPGRADE-RUNBOOK.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-app) 为操作手册：
  盘点（`/proc/<pid>/environ` 实测 env 真源；现役单元名逐条核对）→ CA 门 → plan 干跑 → apply → root 集成
  → 排空 admission（legacy 无 fence 实证门）→ 冷 census+冷快照 → cutover（root 独立 job）→ 装配覆盖（端口
  保号四处一致）→ 验收 → root 冻结 + validatedOn seal（独立 job）。
- manager 自升级 = 重跑 apply 后**必重跑** `install-root-integration.sh`（trustedSha256 对齐，否则 dispatch rc=2）。
- 241 全绿 ≠ 235 就绪；`activate-235.py --apply` 恒 fail-closed；无自动上线队列。

