# opencodex fork 代理部署合同（组件发布线 · 无托管）

> 组件发布线的代理组件 = 直启 `wdev-proxy.service`，无托管、无 manager 参与。
> **最新发布 = `wdev-proxy_2.91.0-wdev.fba4c449_linux-amd64.tar.gz`**：tar sha256
> `01572dcc41fbcca6a931841aed5ad5b50de6505819f5bf81260271212a99ed8b`，197,934,482 字节，6228 个 regular 成员，
> runtimeTreeHash `65a15b7f62e3e9e592f852a7a0c59d0b0cc5c8e8b9cf8c4dd2f0107c953c5777`，
> source commit `fba4c449e37608d780822aed0d378cf120eb898a`（main merge `91f8751ad70b4751aaefe7ac02d2fd0ff6741eb8`）。
> **发布通道 = 公共仓 `yorkane/wdev-suit`（project 23）Release 部署包直链**，坐标读该机读清单，文档不写死 latest。
> 安装部署合同与认证合同的公开权威版：
> [wdev-suit/wdev-proxy/wdev-deploy.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-suit/-/raw/main/wdev-proxy/wdev-deploy.md)、
> [loopback-management-auth.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-suit/-/raw/main/wdev-proxy/loopback-management-auth.md)。
> 升级/回滚细则见 [upgrade.md](upgrade.md)，运维经验清单见
> [`structure/ops/deployment-lessons.md`](structure/ops/deployment-lessons.md)。

## 1. 身份与边界

- 外部品牌只落薄壳：单元名 `wdev-proxy.service`、组件 id `llm-proxy`、authz label。内部身份不改：包名
  `@bitkyc08/opencodex`、bin `ocx`/`opencodex`、数据目录 `~/.opencodex`、`/healthz` 的 `service:"opencodex"`、
  注入头 `x-opencodex-api-key`、`OPENCODEX_*`/`OCX_*` env 前缀。
- 默认端口 **10100**、默认绑 `127.0.0.1`；**端口是装配期实例特定值**（241.t 装配 10101），验收按 inventory 实值。
- 数据边界 `~/.opencodex`、`~/.codex`、官方 userData **原位不迁不删不改属主**；无 purge 路径。
- 进程监督归部署层 systemd 单元，引擎不感知托管协议；`/api/wdev/*` 恒 404 Unknown endpoint（模块已删，§5）。
- **241.t 是测试环境**：新包在 241 的验收 = 直接替换其现役 10101 服务后按 §6 全表通过。只跑隔离 fixture
  演示、现役服务不换包，不构成发布准入。web 组件（3737）是独立组件：基线 unit 可能 inactive 而端口由别的
  listener 提供，验收按真实 PID + HTTP 比较，**禁止为让脚本变绿擅自起 web**。

## 2. 包身份：manifest 双键，不是 CLI 版本号

- 包身份 = runtime-manifest 的 `sourceCommit`/`runtimeSourceCommit` 双键 + `runtimeTreeHash`/count + tar sha256/size。
- 包内 `ocx --version` 对所有 2.91.0-wdev.* 构建恒输出 `2.91.0`；**任何按 `--version` grep `wdev.` SHA 的判据都是错的**。
- 换树/回滚证据 = release 目录逐文件 sha256 对账 + 单元 `ExecStart` 指向 + shim→worker 父子树；
  `/healthz` 的 version 单值在新旧同号时不构成身份判据。

## 3. 直启安装（四步）

1. 解包落**新** release 目录 `~/wdev/proxy/releases/engine-<ver>-wdev.<shortsha>/`（包根=安装树平铺：
   `bin/ocx.mjs` Node shim + `node_modules/` 整树含真 ELF bun + payload node 槽 `gateway/node/bin/node`，
   全树无 symlink）。目录一次写入不可变，覆盖在用目录 = 破坏回滚判据，禁止。
2. `~/.wdev/proxy.env`（0600）：`OPENCODEX_ADMIN_AUTH_TOKEN`（强随机，例 `openssl rand -hex 24`）、
   API-key 形态的 `OPENAI_APIKEY_API_KEY`（config 只存 `${OPENAI_APIKEY_API_KEY}` 引用，缺 key 服务照常起、
   上游返 401）。密钥值不进 unit/文档/argv/query/日志/发布目录。
3. 写直启 unit（235.t/241.t 现役形态，端口按装配实值）：

```ini
[Unit]
Description=wdev proxy service (direct start)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=20

[Service]
Type=simple
User=aigc
Group=aigc
EnvironmentFile=/home/aigc/.wdev/proxy.env
ExecStart=<release绝对路径>/gateway/node/bin/node <release绝对路径>/bin/ocx.mjs start --port 10100
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=75

[Install]
WantedBy=multi-user.target
```

   `Type=simple`：MainPID = ExecStart 的 node shim，**监听端口的是同 release 树里的 bun worker 子进程**，
   MainPID 不持监听端口属正常；`KillMode=mixed`+`TimeoutStopSec=75` 让 `systemctl restart` 的 SIGTERM
   在窗口内 drain 在途请求。`ExecStart` 用 payload node，不依赖系统 node。
4. `systemctl daemon-reload && systemctl enable --now wdev-proxy.service`，按 §6 验收。安装无 CA 前置
   （2026-10-22 用户定，旧「CA 信任门」作废），取包需常规网络可达，不宣称任意网络环境无前置可装。

## 4. 认证与 authz（2026-10-23 口径）

- **进程内**：`/api/*` 默认对**本机 loopback 匿名放行**（fork 定制 `loopbackManagementAuth` 缺省 `false`）。
  判定 = 可信 loopback listener + 真 socket peer `127.0.0.1/::1/::ffff:127.0.0.1` + 严格 Host/Origin，
  `X-Forwarded-*` 永不参与；principal `loopback-anonymous` 不冒充 `gui`，`session-only`/consent 路由仍拒。
  `true`（strict）恢复逐字节旧强制凭据行为；畸形值 fail-closed 按 `true`。**非 loopback peer 始终要凭据**；
  loopback 匿名也非无条件放行——它同样要过三件门（可信 loopback ingress + 真 socket peer + 严格 Host/Origin）
  与 strict 门。`hostname` 配置值不能替代 socket peer：把绑定值配成 `0.0.0.0` 之类不产生任何匿名准入，
  判据是真连接的内核 peer 地址。令牌优先级 env `OPENCODEX_ADMIN_AUTH_TOKEN` > 文件 `~/.opencodex/admin-api-token`
  （文件态强制 `ocx_admin_` 前缀，手写明文判非法→503）；env token 与账户池能力**保留**，服务 strict 与
  非 loopback 入口。非 loopback 绑定时数据面另需独立凭据（`OPENCODEX_API_AUTH_TOKEN` 或 `config.apiKeys`，
  不得与管理令牌同值，只用 `x-opencodex-api-key` 头提交）。
- **authz 边缘**：`cc` 前缀域名绑定回源本机 proxy（235 绑定 id 7、241 id 3；`simulate_local=1`），guest 策略
  只放行该 proxy 端口路径（本轮 = 完整 app 入口全方法，含写面）。同机 + host 网络时 kernel peer 即真
  `127.0.0.1`，匿名准入由上一条给出，`request_rewrite` 注入 `x-opencodex-api-key` **不再必须**，降级为
  strict / 非 loopback 形态的可选旧通道；移除时**只删该 header 单项、保留其余字段**，不发 `null`。
  移除后 authz 会把空 `headers` 规范化为 `request_rewrite=''`——这是合法无 rewrite 态，**按空值 `json.loads`
  判 FAIL 是假失败**；幂等重跑在 already-empty/no-token 时 skip，不重复 PATCH。
  strict / 有注入项形态下轮换 admin token 必须同事务同步绑定注入值，否则外部入口整体 401 而 127.0.0.1 正常；
  同步失败 fail-closed 恢复旧值，不得用关掉 proxy 鉴权兜底。
- authz 审计读库**只用 SQLite `mode=ro` 的 backup API 做在线一致 snapshot**；禁止 `cp` 活 db、禁止忽略 WAL 的
  `immutable` 打开。控制面写入形状与 13 字段全量重写等细则见公开部署合同 [wdev-suit wdev-proxy/wdev-deploy.md](https://gitlab.ai-t.wtvdev.com/yorkane/wdev-suit/-/raw/main/wdev-proxy/wdev-deploy.md) §8.1。

## 5. 引擎不含托管集成（2026-10-21 移除）

`wdevManager` 配置块、`/api/wdev/*` 路由、GUI `#wdev` 页、fence 消费方、update 409 门已整体删除
（`codex/remove-wdev-module`，HEAD `7cf2a33cc4`）：`/api/wdev/*` 恒 404 属预期；引擎不读任何 `WDEV_*` env，
fence 文件无消费方，依赖 fence ack 的托管升级事务对 proxy fail-closed（notwired）。**部署 proxy 不需要 manager**。
liveness/readiness 分离保留：`/healthz status:"ok"` 只答进程活着；`/readyz` 在 catalog/config 同步 settle 且
`ok=true` 才 `status:"ready"`（降级 warning 关门不开）。**readyz 启动后 2–6 秒可能 pending：验收必须
health AND ready 有界轮询，不单采一次。**

## 6. 验收（直启部署后逐条跑）

```bash
systemctl is-active wdev-proxy.service                    # active
systemctl show -p NRestarts --value wdev-proxy.service    # delta 0（只记 systemd 自动重启；手工 restart 不计数）
P=http://127.0.0.1:10100                                  # 端口按 inventory 实值（241=10101）
ok=0
for i in $(seq 1 15); do
  curl -sf --max-time 3 --noproxy '*' $P/healthz | grep -q '"status":"ok"' \
    && curl -sf --max-time 3 --noproxy '*' $P/readyz | grep -q '"status":"ready"' && { ok=1; break; }
  sleep 2
done
[ "$ok" = 1 ] || { echo 'FAIL: health/ready not both green in window' >&2; exit 1; }   # 无断言的循环会假绿
curl -s -o /dev/null -w '%{http_code}\n' $P/api/config     # 默认 200（本机匿名放行）；strict=true 时 401
# SSE 真流判据：长驻流必须带 --max-time；set -e 下 rc28 会中断，显式收 rc 只容 0|28
sse_rc=0
curl -Ns --max-time 3 --noproxy '*' -D /data/tmp/sse.head -o /data/tmp/sse.raw \
  $P/api/accounts/events || sse_rc=$?
case "$sse_rc" in
  0|28) ;;   # 28 = 有界读取到帧后超时，正常终止
  *) echo "SSE_FAIL: curl rc=$sse_rc" >&2; exit 1;;
esac
grep -qi '^HTTP/[0-9.]* 200' /data/tmp/sse.head \
  && grep -qi '^content-type: text/event-stream' /data/tmp/sse.head \
  && grep -q '^event: ready' /data/tmp/sse.raw \
  && echo SSE_PASS || { echo 'SSE_FAIL: 200/CT/event ready 断言未过' >&2; exit 1; }
```

- **SSE 判据必须验真流**：`GET /api/accounts/events`（路径含 `/api`；`/accounts/events` 会命中 SPA 返回
  200 HTML，是假绿）响应 200 + `Content-Type: text/event-stream` + 首帧 `event: ready`。长驻流用
  `--max-time` 有界读取并显式收 rc（只容 0/28，其它 rc 判 FAIL），状态行/Content-Type/首帧三条硬断言缺一不可。
  匿名 SSE 每帧用同一 admission leaf 对着内核观测快照复验，strict 热翻即断流。浏览器面复验用 playwright-cli
  全新匿名 profile、零注入，15–20 秒网络零 401；重试 UI 默认 3、范围 0..5。`/api/config` 200 单独不构成验收。
- 离线回归（241.t `/home/aigc/ocx-test/`）：先起 `mock-upstream.py:9099` 再跑 `run-test.sh`，七场景 A–G
  判据 `ALL_DONE_PASS`；脚本自管 10999 与测试 `OPENCODEX_HOME`，不需停生产服务。口径是
  **七场景回归 + 直启验收通过**，不宣称「过了 241 正式门」（托管门族已作废）。
- 235.t/241.t 现役坐标（2026-10-23 实测，均 `2.91.0-wdev.fba4c449`）：235 release
  `engine-2.91.0-wdev.fba4c449`、10100、MainPID shim + Bun worker、NRestarts 0、绑定 id 7
  （`upstream_host=127.0.0.1` + `origin_mode=remove`）、canonical `cc-235`、guard `codex-235`；
  241 release `engine-2.91.0-wdev.fba4c449-sse241`、10101、绑定 id 3（auto）、canonical `cc-241`、
  guard `wdev-241`（**`codex-241` 不存在**，其 404 不得冒充 login 判定）。两台 authz 的 `request_rewrite`
  注入项在 loopback 轮已删除（该轮做过 PATCH），SSE 轮保持空态、零 PATCH。
  首选回滚通道 = 已发布且验证健康的 `2.91.0-wdev.ff6d1444`。轮内失败时把 `ExecStart` 恢复成本轮升级前的
  在用 release（SSE 轮的基线是 `engine-2.91.0-wdev.8d767f6d`）也是合法处置：它恢复服务连续性，但该基线
  带已知 SSE 401 回归且从未公开，**记为临时恢复、不得宣称 SSE 通过**。回滚目标与认证策略成对选定：
  旧 release 无 loopback 匿名定制时属强制认证形态，裸调 401 是正确判据，须同步恢复匹配的 authz 注入并以
  带令牌 200 验收，验收矩阵按 `--loopback-management-auth required` 传参——细则见公共经验页 §11（wdev-suit
  `wdev-proxy/deployment-lessons.md`）。
  fleet 其它机器（166/167/170）本轮未升级，不得声称已升级。

## 7. 升级与回滚（自治脚本，指针）

升级从停服到启动/验收/回滚必须是**一个自治脚本**，经
`systemd-run --uid=aigc --gid=aigc ... /bin/bash /abs/script` 在独立 runner 里跑（脚本可不带 +x；
root 侧先排空本轮在途 agent）。理由：被升级的 proxy 不能是执行升级的那个进程，也不能停服后依赖它继续思考。
序列 = stage 新不可变目录 → 预检 → 备份完整旧 unit → 原子换 `ExecStart`（同目录 install/mv）→
`systemctl restart` 应用 drain → health AND ready 有界轮询 + §6 身份对账 → **任何错误自动 restore**
unit（本轮改过 authz 时一并 restore）+ 健康 ready + 旧 release 身份验证。回滚判据在版本号同号时必须核
`ExecStart`/tree，不看 version 单值。禁止在 `trap` 之外手写 `exit` 绕过回滚。

流量观测取**有界**窗口：不得被「连续 2 次观测为 0」这类无限等待拦成只 stage 不升级。明确部署授权窗口内
直接用 `systemctl restart` 的 SIGTERM + `KillMode=mixed`/`TimeoutStopSec=75` 应用 drain，日志如实记录在途
请求数，**不承诺零中断**。完整经验清单见 [`structure/ops/deployment-lessons.md`](structure/ops/deployment-lessons.md)。
