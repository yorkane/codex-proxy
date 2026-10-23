# opencodex fork 代理升级合同（组件发布线 · 无托管）

> **本文坐标**：组件发布线（无托管）代理组件升级。**最新发布 =
> `wdev-proxy_2.91.0-wdev.fba4c449_linux-amd64.tar.gz`**（sha256
> `01572dcc41fbcca6a931841aed5ad5b50de6505819f5bf81260271212a99ed8b`，197,934,482 字节，
> 6228 regular 成员，源 commit `fba4c449e37608d780822aed0d378cf120eb898a`，2026-10-23 核对；
> 身份判据按包名/runtime-manifest 双键，见 deploy.md §2）。**当前最新与现役坐标以
> [deploy.md](deploy.md) 为首要指针**，本文只写升级流程；执行细则（自治脚本、排空、验收、
> 回滚、审计与卫生）见 [`structure/ops/deployment-lessons.md`](structure/ops/deployment-lessons.md)
> 与公共仓 `yorkane/wdev-suit` 的 `wdev-proxy/deployment-lessons.md`。
> 历史版本坐标（`2.89.0-wdev.7cf2a33c` 等）只作历史留档，不再当作 latest 依据。
> **发布通道 = GitLab 公共仓库 `yorkane/wdev-suit`（project 23）Release 部署包直链**；资产名与哈希
> 以该机读清单为唯一权威，不写死文件名、不拼 latest。
> **升级 = 部署层换包 + 重启单元**（§1）：引擎已删除托管集成模块（2026-10-21），无提交面、无
> 托管事务，直启单元 `systemctl restart` 即完成换树（历史注记见 deploy.md §5）。
> 部署见 [deploy.md](deploy.md)；235.t 旧 npm 固定链已退役（§2，只读历史）。235/241 现役坐标见
> deploy.md §6（工作区根 `wdev-proxy/deploy.md` 是部署层仓的镜像说明，不在本 git 树内）。

## 1. 升级 = 部署层换包 + 重启单元

引擎侧无任何升级提交面：`/api/wdev/*` 恒 404（Unknown endpoint），`POST /api/update/run` 会装上游
非 fork 包覆盖引擎树（**不要用**），`wdev-proxy` CLI 是部署层自带 shim、不由本仓库提供。升级全链路
都在部署层，六步：

1. **取包对账**：从 wdev-suit Release 直链取包（坐标读机读清单，见 deploy.md 首段与
   [§3](deploy.md#3-直启安装四步)），`sha256sum -c` 必须 OK。
2. **落新 release 目录**：`mkdir -p ~/wdev/proxy/releases/<id>`（如 `engine-2.91.0-wdev.fba4c449`）后
   `tar -xzf` 解包进去。目录一次写入不可变；手工覆盖在用目录 = 破坏回滚判据，禁止。
3. **备份 unit**：`cp /etc/systemd/system/wdev-proxy.service /data/tmp/wdev-proxy.service.bak-<ts>`。
4. **改 ExecStart** 指向新 release 目录（payload node + `bin/ocx.mjs start --port <装配期实值>`，
   EnvironmentFile 不变）→ `systemctl daemon-reload`。落位用同目录 `install` + `mv` 原子改名，
   不做跨目录覆盖。
5. **重启应用 drain**：在明确的部署授权窗口内直接 `systemctl restart wdev-proxy.service`，由
   `KillMode=mixed` + `TimeoutStopSec=75` 让引擎自己排空在途请求。流量观测取**有界**窗口，到点即推进；
   无限等「连续两次为 0」只会停在「已 stage 未部署」。日志如实记录在途请求数，**不承诺零中断**。
6. **验收**：deploy.md §6 全表（healthz ok + readyz ready 有界轮询 / 认证判据 / SSE 真流 / 单元 active /
   NRestarts delta 0）+ 换树证据 = 新树逐文件 sha256 与包内记录一致 + `ExecStart` 指向 + release 父子树。

第 3–6 步连同**失败自动回滚**必须在**一个自治脚本**里跑完，经
`systemd-run --uid=<运行用户> --gid=<组> /bin/bash /abs/script` 起独立瞬态单元执行（解释器写绝对路径，
脚本文件本身可不带执行位；发起前 root 侧先排空本轮在途 agent）：被升级的 proxy 可能就是操作者的通信
通道，停服后不能再依赖它继续思考。任何错误路径都要 restore 旧 unit（本轮改过 authz 时一并 restore）、
等 health/ready、校验旧 release 身份；回滚判据在版本同号时看 `ExecStart`/tree，不看 version 单值。
禁止在 failure trap 之外手写 `exit` 绕过回滚。细则见
[`structure/ops/deployment-lessons.md`](structure/ops/deployment-lessons.md)。

**回滚** = 把 ExecStart 指回旧 release 目录 → `daemon-reload` → `restart`。旧目录因不可变约束原样
在位，回滚不需要重新取包。首选已发布且验证健康的版本作回滚目标；轮内失败时恢复本轮升级前的在用
release 也属合法处置（恢复服务连续性），但该基线若带已知缺陷，必须记为**临时恢复**并如实标注其缺陷面，
不得宣称验收通过。

历史注记：模块删除前 proxy 走共享托管事务（状态机、fence/快照/回退矩阵）；模块删除后引擎无 fence
消费方，依赖 fence ack 的托管事务对 proxy 组件 fail-closed（notwired）——该整条通道随模块删除作废，
细节与实证以 [deploy.md](deploy.md) §5 为准。

引擎自身的 liveness/readiness 语义不变：`/healthz status:"ok"` 只答进程活着；`/readyz` 在启动后
catalog/config 同步 settle 且 `ok=true` 才 `status:"ready"`（降级 warning 关门不开）。

## 2. 旧 npm 固定链（脚本与单元已退役）与现行 latest 清单

两条现状要分开说清，不是一句「全部历史留档」：

- **旧 npm 升级脚本与 masked 旧单元已退役**：脚本的 `UNIT` 指向 masked 单元，禁止 unmask 旧单元或
  按旧 npm 文档执行换树；proxy 升级只走 §1 部署层换包。
- **`/data/share/deb/codex-proxy-latest.json` 是现行发布/实装记录**（2026-10-23 起已补齐
  `installedManifestPath`/`installedManifestSha256` 两键并指向当前发布轮），它反映当前最新与已装坐标，
  **不是恢复旧脚本执行链的依据**——读它是为了对账当前实装身份（§2 部署合同），不是 `jq` 后喂给旧脚本。

## 3. portable 离线包取包与解包验证（公共 GitLab 可达即可）

```bash
# 公共取包器不在本仓，从 suit 仓库 raw 取到 /data/tmp 后按绝对路径运行（脚本自校验=三重：
# 内置钉值 + release.json 交叉绑定 + PACKAGES.sha256 逐资产命中；坐标发布时冻结于脚本内）：
mkdir -p /data/tmp/wdev-release-pull
curl -sfL -o /data/tmp/wdev-release-pull/wdev-fetch-proxy-release.sh \
  https://gitlab.ai-t.wtvdev.com/yorkane/wdev-suit/-/raw/main/wdev-proxy/scripts/wdev-fetch-proxy-release.sh
bash /data/tmp/wdev-release-pull/wdev-fetch-proxy-release.sh --dest /data/tmp/wdev-release-pull
# 落包后仅做形状抽查（sha 对账已由取包器三重完成，不在此重复单值宣称）：
tar -tzf "/data/tmp/wdev-release-pull/<portable包名>" | head
#   应见 bin/ocx.mjs、node_modules/bun/bin/bun.exe、gateway/node/bin/node
```

落点 = `~/wdev/proxy/releases/<id>/` 新目录（§1 第 2 步）；包形状见 deploy.md §3，身份判据见 §2。

## 4. 升级窗口纪律

- 235.t 生产承载面 = **现役三单元** `wdev.service`、`wdev-xvfb.service`、`wdev-proxy.service`（及依赖）：
  验证窗口内只读、不重启不杀掉；proxy 换树重启由部署层执行（授权窗口内直接 `systemctl restart`，由
  `KillMode=mixed` + `TimeoutStopSec=75` 应用 drain）。235 已于 2026-10-21 切直启、2026-10-23 换包至
  2.91.0-wdev.fba4c449（现役坐标见 deploy.md §6；旧托管形态是历史）。旧三单元
  （`codex-desktop-gateway`、`codex-desktop-xvfb`、`opencodex-proxy`）已 masked，不再是可动面。
- 配置面热载（管理面 PUT/PATCH）不重启即生效；结构变更后的重启由部署层摘流量后 systemctl。
- 换树证据 = 逐文件 sha256 + 单元 `ExecStart` 指向 + release 父子树；`/healthz` 的 version 同号换树不构成
  证据（本 fork 常态，见 deploy.md §2）。restart 的代际证据 = 子进程新 PID + 单元 MainPID 代际 +
  NRestarts delta 0（直启口径，235/241 实测）。
- 托管门族随模块删除**作废**；proxy 验收 = deploy.md §6 本表（healthz/readyz + 认证判据 + SSE 真流 + 单元判据）。
  web 组件门族不受影响。成功**不代表三件套模型 E2E**——G80（云端 durable 三 agent）= **BLOCKED**：
  需用户交互官方 ChatGPT 登录（profile cookies=0 + network.block），禁止伪造 auth；
  CLI 直连 router 不算过门。

## 5. 跨机推广

逐机循环（无自动上线队列）：取包对账 → 落 `~/wdev/proxy/releases/<id>/` 新目录 →
直启 unit（首次部署写 deploy.md §3 单元，已有则改 ExecStart）→ 按 deploy.md §6 验收。

- **241.t（测试环境）先行**：其验收 = 就地替换该机现役 proxy 后七场景 `ALL_DONE_PASS` + 直启验收通过，
  再做其它机；241 全绿 ≠ 其它机就绪（env 真源、端口
  装配值、authz 绑定、官方数据形态逐机核对，env 用 `/proc/<pid>/environ` 实测）。
- 历史口径留档：241.t 对 2.89.0 包的实测口径 = **七场景回归 + 直启验收通过**（直启单元 active、NRestarts=0、
  healthz ok 2.89.0、readyz ready、认证 401/200、`/api/wdev/components` 带 token 404），
  **不宣称过了 241 正式门/托管门族**。
- web 组件（gateway deb / 3737）是**独立发布线**：其安装与跨机推广合同以公共仓
  [wdev-proxy/wdev-deploy.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-suit/-/raw/main/wdev-proxy/wdev-deploy.md)
  的 web 章节（§7 web 安装 / §8 验收）为当前权威（2026-10-22 起组件独立发布）；本文不定义 web
  生命周期，proxy 直启线与它互不牵连。
