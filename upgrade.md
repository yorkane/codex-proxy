# opencodex fork 代理升级合同（managed 发布线，2026-10-19）

> **主通道 = wdev manager 托管事务**（`wdev-proxy.service`，`wdev-proxy upgrade`）。
> 235.t 旧 prod 的固定发布链脚本属机器运维层（`codex-proxy/script/` 不在 GitLab 源码 release 内），
> 本文只列只读现状，不作为操作指引。部署见 [deploy.md](deploy.md)；manager 事务共享合同见 wdev-app 仓库
> upgrade.md（GitLab：https://gitlab.ai-t.wtvdev.com/yorkane/wdev-app ）。

## 1. managed 托管升级（主通道）

```bash
wdev-proxy upgrade <manifest.json>                       # 受理面：exit 0 = durable queued（202+operationId），非成功
python3 ~/wdev/manager/wdev.py operation <uuid>          # 终态查询：phase=succeeded 才算升级完成
wdev-proxy doctor; wdev-proxy status
```

manifest（schema=1，`wdev_manager/artifacts.py` 校验）关键字段与拒收条件：

| 项 | 合同 |
|---|---|
| `componentId`/`artifactType` | `llm-proxy` ↔ `engine`；跨类型拒收 |
| `sha256` | 64 hex；下载/落盘强校验，不符拒收 |
| `buildId`/`build` 五分量 | 全分量一致才算同一 release（no-op 判据）；仅 version+sha 相同**不构成** no-op |
| `url` | 只允许 https 且 host 白名单**仅** `file-235.ai-t.wtvdev.com`；**GitLab Release 链接不可作为 manifest url**（GitLab 仅作 provenance/下载入口：先下载+对账 sha256，再落 trusted roots 用 `path` 提交） |
| `validatedOn` | 正式通道必须 `241.t`（`REQUIRED_VALIDATED_ON`）；引导/快照走公开 CLI `import-baseline`，**一次调用只导一类**（判序 deb→engine-tgz→engine-dir，`args.deb` 命中即 return，同传只导 web、engine 静默跳过），拆两次独立调用、全局 `--apply` 前置子命令：`python3 install.py --engine-tgz wdev-proxy_<ver>-wdev.<short>_linux-amd64.tar.gz --apply import-baseline`（engine-only；web 侧对应 `--deb wdev_<ver>_amd64.deb --apply import-baseline`）。记 `validatedOn:"imported"`、`validated:false` |

**两条真实边界（并列，不得绕过）**：

1. **裸官方 deb 不能直接 stage**：payload 合同要求含 gateway 的适配合并包（判据见 wdev-app upgrade.md §2）。
2. **本轮新产物（portable 包 / npm tgz / deb）只做过本机 smoke**：`validatedOn` 不得填 `241.t`、不得冒用既往记录——
   manager 直接拒收未验证包；要上生产托管面，先补 241 验收再出带 `validatedOn: "241.t"` 的新清单。

事务状态机：`queued → preflight → wait_idle → stage → quiesce → snapshot → candidate_start → verify → commit → succeeded`，
终态 `succeeded/rolled_back/failed/protected`。要点：fence 走控制 socket（缺 ack=`notwired`，无 fallback；idle 未知视作 busy，
超时 FAIL 不 force；动 proxy 先 fence web）；**precommit 全 dataRoots 冷快照可回滚**（commit 前失败且证明无新真实写入 →
同原路径冷还原 + last-good → `rolled_back`；有写/无法证明 → `protected` 封存现场保持 fence）；**commit 后绝不快照回退**，
回代码保最新数据仅当 241 兼容矩阵实证命中，否则 protected 向前修复；quarantine 命中的 buildId 拒自动重试。
细则（含 RPO/属主恢复语义）见 wdev-app upgrade.md §4-§5。

## 2. 235.t 旧 prod 固定发布链（只读现状，非操作指引）

235 现网代理升级的历史通道 = 机器运维层脚本 `codex-proxy/script/upgrade-codex-proxy.sh`（**不在 GitLab 源码 release**，
仓库内无此脚本）。现状要点（读源码归纳，供对账，不在此给可执行序列）：安装源固定为
`/data/share/deb/codex-proxy-latest.json`（preflight 硬门：`validatedOn=="241.t"` + `validatedKitPass>=23` +
产物路径前缀 `/data/share/deb/` + 包/清单 sha256 对账 + 包内 package.json name/version 断言）；阶段序
preflight→wait_idle→backup→install(npm 全局换树)→health→逐文件哈希→隔离 kit(23)→真实烟测→preservation；
失败 trap 自动回滚（坏树移 `/data/.trash/`，现场在 `/data/tmp/codex-proxy-upgrade/<run>/`，`flock` 单任务）；
同包幂等=`same_package=1` 只验收不重启。已知坑：现版 latest.json 缺 `installedManifestPath/installedManifestSha256`
两键（脚本 `jq -er` 硬依赖），发布轮必须补齐。**managed 三件套上 235 后此通道退役**；切换边界见 wdev-app deploy.md §8。

## 3. portable 离线包的解包验证（无外网机器）

portable 离线包（真实 basename `wdev-proxy_<ver>-wdev.<shortsha>_linux-amd64.tar.gz`，`<ver>`/`<shortsha>` 从 Release manifest.json 动态取；
包根=安装树平铺：`bin/ocx.mjs` Node shim ＋ `node_modules/` 依赖整树含捆绑真 ELF `node_modules/bun/bin/bun.exe`
＋ payload node 固定槽 `gateway/node/bin/node`；全树仅 regular+dir 无 symlink）：

```bash
STAGE=/data/tmp/wdev-release-pull   # fleet 规范：临时物放 /data/tmp
FLAT=$(ls $STAGE/wdev-proxy_*_linux-amd64.tar.gz)               # 资产名以 Release manifest.json 为准
sha256sum "$FLAT"                   # 与 manifest.json / SHA256SUMS 对账
tar -tzf "$FLAT" | head             # 应见 bin/ocx.mjs、node_modules/bun/bin/bun.exe、gateway/node/bin/node
```

- 该包的正式落树 = 作为 `--engine-tgz` 输入走 wdev 托管事务（`wdev-proxy upgrade`，stage→…→commit）；
  release 目录一次写入不可变，手工覆盖在用目录=破坏 no-op/回滚判据，禁止。
- 235.t 旧 prod 通道（npm 固定链）的换树输入是 npm 源包（`--allow-scripts=bun` 必带，原因见 deploy.md §2 尾注）。
- 241 `ocx-stack-proxy` 在用的旧 prefix tar（`ocx-*-proxy.tar.gz`，bin+lib 整树）为历史通道，按目标机 ExecStart 形态与 portable 包二选一。

## 4. 升级窗口纪律

- 235.t 生产承载面（`codex-desktop-gateway`、3737、`opencodex-proxy`、10100 及依赖）**只读**：验证窗口内不重启不杀掉；
  托管升级由 manager 事务动 proxy 自身单元（fence→重启链），不触旧 prod 面。
- 配置面热载（管理面 PUT/PATCH）不重启即生效；结构变更后的重启走托管事务，不手工 systemctl。
- 换树证据 = 逐文件 sha256 ＋树内契约串 grep；`/healthz` 的 version 同号换树时不构成证据（本 fork 常态）。
- 241 隔离验收（G21/G22/G70）成功**不代表三件套模型 E2E**（G80=CLI 直连 router 口径），不代表本轮未验新包可用。
