#!/usr/bin/env python3
"""wdev-proxy 发布构建器（stdlib；fork-local 工具，非 release 权威；无 publish/部署/全局改动）。

产物（默认 --out /home/aigc/ChatGPT/codex-proxy/build/wdev-release，外层共享 build 树，
可 --out /data/share/deb 落发布目录）：
 1) wdev-proxy-<ver>-fork-<short>.npm.tgz      —— npm pack 源包（内部名 @bitkyc08/opencodex 不变）
 2) wdev-proxy_<ver>-wdev.<short>_linux-amd64.tar.gz —— manager portable FLAT 包：
    成员 ./bin/... ./src/... ./node_modules/... ./gateway/node/bin/node 等，
    root 直铺（tar -C stage .），无 package/ 前缀、无顶层目录前缀。
 3) <name>.manifest.json + SHA256SUMS

合同：
- tar 成员只允许 REG/DIR（safe_extract_tar 合同）；全部 symlink/hardlink 物化 regular。
- 打包后逐字跑 installer 合同链自测：install.safe_extract_tgz -> find_engine_root 命中 flat 根
  -> gateway/node/bin/node 四重验 -> node bin/ocx.mjs --version -> 捆绑 bun --version。
- 构建尾把 work 目录移入 --trash（默认 /data/.trash），绝不 rm。
- 正式 core stage（artifacts.safe_extract_tar）已按 root 裁决修复：保 member 执行位并清 suid；
  本脚本用 installer 基线链（deploy.md --engine-tgz 主链）做验收判据。
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, tarfile, time
from datetime import datetime, timezone

USAGE = __doc__

def sh(cmd, cwd=None, env=None):
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True)
    out = p.stdout.decode("utf-8", "replace") + p.stderr.decode("utf-8", "replace")
    if p.returncode != 0:
        raise SystemExit("command failed: %s\n%s" % (" ".join(cmd), out[-3000:]))
    return out

def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()

def mkdirs(p):
    os.makedirs(p, exist_ok=True)

def audit_tree(root):
    bad = []
    for dp, dns, fns in os.walk(root):
        for n in dns + fns:
            p = os.path.join(dp, n)
            st = os.lstat(p)
            import stat as S
            if not S.S_ISDIR(st.st_mode) and not (S.S_ISREG(st.st_mode) and st.st_nlink == 1):
                bad.append(p)
    if bad:
        raise SystemExit("tree audit failed: %s" % bad[:8])
    return True

def materialize(stage, trash):
    """stage 内全部 symlink/hardlink/special 物化为 regular；原链入 trash。禁外部 symlink。"""
    import stat as S
    real_stage = os.path.realpath(stage)
    moved = 0
    for dp, dns, fns in os.walk(stage):
        for d in list(dns):
            p = os.path.join(dp, d)
            if os.path.islink(p):
                t = os.path.realpath(p)
                if not (t == real_stage or t.startswith(real_stage + os.sep)):
                    raise SystemExit("external symlink: %s -> %s" % (p, t))
                dst = os.path.join(trash, os.path.relpath(p, stage).replace("/", "_") + ".dir")
                shutil.move(p, dst)
                shutil.copytree(t, p, symlinks=False)
                moved += 1
        for f in fns:
            p = os.path.join(dp, f)
            st = os.lstat(p)
            mode = st.st_mode
            if os.path.islink(p):
                t = os.path.realpath(p)
                if not (t == real_stage or t.startswith(real_stage + os.sep)):
                    raise SystemExit("external symlink: %s -> %s" % (p, t))
                fmode = os.stat(t).st_mode
                shutil.move(p, os.path.join(trash, os.path.relpath(p, stage).replace("/", "_") + ".lnk"))
                shutil.copyfile(t, p)
                os.chmod(p, 0o755 if (fmode & 0o111) else 0o644)
                moved += 1
            elif not (S.S_ISREG(st.st_mode) or S.S_ISDIR(st.st_mode)):
                raise SystemExit("special file: %s" % p)
            elif st.st_nlink > 1:
                data = open(p, "rb").read()
                os.unlink(p)
                with open(p, "wb") as fh:
                    fh.write(data)
                os.chmod(p, 0o755 if (mode & 0o111) else 0o644)
                moved += 1
    return moved

def main():
    ap = argparse.ArgumentParser(add_help=True, description="wdev-proxy flat release builder (stdlib)")
    ap.add_argument("--out", default="/home/aigc/ChatGPT/codex-proxy/build/wdev-release")
    ap.add_argument("--work", default="")
    ap.add_argument("--trash", default="/data/.trash")
    ap.add_argument("--node-binary", default="/usr/bin/node")
    ap.add_argument("--bun-elf", default="")
    ap.add_argument("--bun-runtime", default="/home/aigc/.nvm/versions/node/v24.20.0/lib/node_modules/@bitkyc08/opencodex/node_modules/bun/bin/bun.exe")
    ap.add_argument("--npm-cli", default="/home/aigc/.nvm/versions/node/v24.20.0/lib/node_modules/npm/bin/npm-cli.js")
    ap.add_argument("--node", default="/usr/bin/node", help="跑 npm-cli 的 node")
    ap.add_argument("--validated-on", default=None)
    ap.add_argument("--prod", default="", help="复用已有 prod 安装树（含 node_modules/），跳过 pack/install")
    ap.add_argument("--skip-pack", action="store_true", help="跳过 prepare+npm pack（配合 --prod）")
    ap.add_argument("--npm-tgz", default="", help="--skip-pack 时提供已有 npm 源包路径（复制入 --out 并计入 manifest/SHA256SUMS）")
    ap.add_argument("--runtime-source-commit", default="",
                    help="runtime 树来源 commit（--skip-pack 复用旧 pack 时如实标注，如基线 a8aac20e…；"
                         "manifest.sourceCommit 恒为本次构建 HEAD，runtimeSourceCommit 记复用来源）")
    ap.add_argument("--reuse-note", default="",
                    help="provenance 备注（如 reuse npm bytes from a8aac20e；写入 manifest.reuseNote）")
    args = ap.parse_args()

    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    pkg = json.load(open(os.path.join(repo, "package.json"), encoding="utf-8"))
    version = pkg["version"]
    commit = sh(["git", "rev-parse", "HEAD"], cwd=repo).strip()
    short = commit[:8]
    name = "wdev-proxy_%s-wdev.%s_linux-amd64" % (version, short)
    npm_name = "wdev-proxy-%s-fork-%s.npm.tgz" % (version, short)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out_dir = os.path.abspath(args.out)
    work = os.path.abspath(args.work or os.path.join(out_dir, ".work-" + stamp))
    mkdirs(out_dir); mkdirs(work)
    work_trash = os.path.join(work, "trash"); mkdirs(work_trash)

    npm_tgz = None
    if not args.skip_pack:
        # [1] prepare：固定 Bun 1.4.2 绝对路径（compat manifest + modes）
        if not os.path.exists(args.bun_runtime):
            raise SystemExit("pinned bun not found: " + args.bun_runtime)
        sh([args.bun_runtime, "run", "prepare:package"], cwd=repo)
        # [2] pack：npm --json（stdout 纯净 JSON，stderr 独立），join(workDir, filename)
        env = dict(os.environ)
        p = subprocess.run([args.node, args.npm_cli, "pack", "--json", "--ignore-scripts",
                            "--pack-destination", work],
                           cwd=repo, capture_output=True, env=env)
        if p.returncode != 0:
            raise SystemExit("npm pack failed: " + p.stderr.decode()[-2000:])
        info = json.loads(p.stdout.decode())
        filename = (info[0] if isinstance(info, list) else info)["filename"]
        npm_tgz = os.path.join(work, filename)

    # [3] prod 安装树（联网构建阶段）
    if args.prod:
        install_nm = os.path.abspath(args.prod)
    else:
        pm = os.path.join(work, "prod")
        mkdirs(os.path.join(pm, "node_modules"))
        with open(os.path.join(pm, "package.json"), "w") as fh:
            fh.write(json.dumps({"name": "wdev-proxy-build", "version": "1.0.0", "private": True}))
        sh([args.node, args.npm_cli, "install", "--ignore-scripts", "--omit=dev", npm_tgz], cwd=pm)
        install_nm = os.path.join(pm, "node_modules")
    install_root = os.path.join(install_nm, "@bitkyc08", "opencodex")
    if not os.path.isfile(os.path.join(install_root, "bin", "ocx.mjs")):
        raise SystemExit("install root missing bin/ocx.mjs: " + install_root)

    # [4] stage 平铺（root 直铺安装形态 + 全量 prod node_modules）
    stage = os.path.join(work, "stage", name)
    mkdirs(stage)
    sh(["cp", "-a", install_root + "/.", stage + "/"])
    nm = os.path.join(stage, "node_modules")
    mkdirs(nm)
    sh(["cp", "-a", install_nm + "/.", nm + "/"])

    # [5] 物化全部链接（在移除嵌套 @bitkyc08 之前：.bin shim realpath 依赖它）
    moved = materialize(stage, work_trash)
    nested = os.path.join(nm, "@bitkyc08")
    if os.path.exists(nested):
        shutil.move(nested, os.path.join(work_trash, "nested-bitkyc08"))
    print("MATERIALIZED", moved)

    # [6] runtime 槽
    bun_slot = os.path.join(nm, "bun", "bin", "bun.exe")
    bun_src = args.bun_elf or os.path.join(nm, "@oven", "bun-linux-x64", "bin", "bun")
    if not os.path.isfile(bun_src):
        raise SystemExit("no Bun ELF source; pass --bun-elf (placeholder stub not acceptable)")
    if os.path.getsize(bun_slot) < 1_000_000:
        shutil.copyfile(bun_src, bun_slot)
    os.chmod(bun_slot, 0o755)
    bunx_slot = os.path.join(nm, "bun", "bin", "bunx.exe")
    if os.path.exists(bunx_slot) and os.path.getsize(bunx_slot) < 1_000_000:
        shutil.copyfile(bun_src, bunx_slot)
    os.chmod(bunx_slot, 0o755)
    node_slot = os.path.join(stage, "gateway", "node", "bin", "node")
    mkdirs(os.path.dirname(node_slot))
    shutil.copyfile(args.node_binary, node_slot)
    os.chmod(node_slot, 0o755)
    node_version = sh([node_slot, "--version"]).strip()
    major = int(node_version.lstrip("v").split(".")[0])
    if major < 22:
        raise SystemExit("payload node < 22: " + node_version)
    os.chmod(os.path.join(stage, "bin", "ocx.mjs"), 0o755)
    bun_version = sh([bun_slot, "--version"]).strip()

    # [7] audit（REG nlink=1 / DIR only）
    audit_tree(stage)

    # [8] 文件清单 + runtimeTreeHash
    rows = []
    for dp, dns, fns in os.walk(stage):
        for f in fns:
            p = os.path.join(dp, f)
            rows.append({"path": os.path.relpath(p, stage), "sha256": sha256_file(p)})
    rows.sort(key=lambda r: r["path"])
    tree = hashlib.sha256()
    for r in rows:
        tree.update(("%s\0%s\n" % (r["path"], r["sha256"])).encode())

    # [9] FLAT tar：-C stage .（成员 ./...），root/uid=0 固定归属 + 确定性（mtime epoch、排序）
    tar_path = os.path.join(out_dir, name + ".tar.gz")
    # gzip 头带时间戳 -> 先裸 tar 再 gzip -n（去 gzip mtime），字节级可复现。
    raw_tar = tar_path + ".raw"
    sh(["tar", "--owner=0", "--group=0", "--numeric-owner",
        "--sort=name", "--mtime=@0", "--clamp-mtime",
        "-C", stage, "-cf", raw_tar, "."])
    gz = subprocess.run(["gzip", "-n", "-9", "-c", raw_tar], capture_output=True)
    if gz.returncode != 0:
        raise SystemExit("gzip -n failed: " + gz.stderr.decode()[-500:])
    with open(tar_path, "wb") as fh:
        fh.write(gz.stdout)
    os.unlink(raw_tar)
    with tarfile.open(tar_path, "r:gz") as tf:
        types = {}
        for m in tf.getmembers():
            k = "REG" if m.isreg() else ("DIR" if m.isdir() else "OTHER")
            types[k] = types.get(k, 0) + 1
            if k != "REG" and k != "DIR":
                raise SystemExit("non-REG/DIR member: %s" % m.name)
        names = tf.getnames()
    if not any(n.lstrip("./") == "bin/ocx.mjs" for n in names):
        raise SystemExit("flat root contract: bin/ocx.mjs not at tar root")
    print("TAR_MEMBERS", types)

    # [10] installer 合同链自测（deploy.md --engine-tgz 主链，逐字 audit 给的链）
    tmp = os.path.join(work, "contract-extract")
    mkdirs(tmp)
    code = ";".join([
        "import sys, os, tarfile",
        "tmp=%r" % tmp,
        "tf=tarfile.open(%r,'r:gz')",
        "members=tf.getmembers()",
        "assert all(m.isreg() or m.isdir() for m in members), 'non-REG/DIR member'",
        "tf.extractall(tmp)",
        "root=os.path.realpath(tmp)",
        "assert os.path.isfile(os.path.join(root,'package.json')) and os.path.isfile(os.path.join(root,'bin','ocx.mjs')), root",
        "assert os.path.isfile(os.path.join(root,'package.json')) and os.path.isfile(os.path.join(root,'bin','ocx.mjs')), root",
        "node=os.path.realpath(os.path.join(root,'gateway','node','bin','node'))",
        "assert os.path.isabs(node) and os.access(node, os.X_OK), node",
        "assert open(node,'rb').read(4)==bytes.fromhex('7f454c46')",
        "import subprocess",
        "r=subprocess.run([node,os.path.join(root,'bin','ocx.mjs'),'--version'],capture_output=True,text=True,timeout=30)",
        "assert r.returncode==0 and 'opencodex' in r.stdout, r.stdout+ r.stderr",
        "b=os.path.join(root,'node_modules','bun','bin','bun.exe')",
        "rb=subprocess.run([b,'--version'],capture_output=True,text=True,timeout=30)",
        "assert rb.returncode==0 and rb.stdout.strip()=='1.4.2', rb.stdout",
        "print('CONTRACT_CHAIN_OK engine_root=' + ('' if os.path.realpath(root)==os.path.realpath(tmp) else os.path.relpath(root,tmp)))",
    ])
    chain_out = sh([sys.executable, "-c", code])
    print(chain_out.strip())

    # [11] npm 外名 + manifest + SHA256SUMS
    npm_out = os.path.join(out_dir, npm_name)
    npm_src = npm_tgz or (args.npm_tgz if args.skip_pack else "")
    if npm_src:
        if os.path.abspath(npm_src) != os.path.abspath(npm_out):
            shutil.copyfile(npm_src, npm_out)
    if not os.path.isfile(npm_out):
        raise SystemExit("npm tgz missing in --out; pass --npm-tgz when using --skip-pack")
    npm_sha = sha256_file(os.path.join(out_dir, npm_name))
    manifest = {
        "schema": "wdev-proxy-release/1",
        "externalName": name,
        "internalPackage": "%s@%s" % (pkg["name"], version),
        "sourceCommit": commit,
        "runtimeSourceCommit": args.runtime_source_commit or commit,
        "reuseNote": args.reuse_note or None,
        "runtimeTreeHash": tree.hexdigest(),
        "runtimeFileCount": len(rows),
        "platforms": ["linux-amd64"],
        "glibc": {"required": ">=2.28",
                  "note": "payload node 符号峰值 GLIBC_2.28；bun 峰值 GLIBC_2.17；Ubuntu 22.04 glibc 2.35 构建验证"},
        "bunRuntime": {"path": "node_modules/bun/bin/bun.exe", "version": bun_version, "sha256": sha256_file(bun_slot)},
        "payloadNode": {"path": "gateway/node/bin/node", "version": node_version, "sha256": sha256_file(node_slot)},
        "npmTarball": {"name": npm_name, "sha256": npm_sha},
        "portableTar": {"name": name + ".tar.gz", "sha256": sha256_file(tar_path)},
        "validatedOn": args.validated_on,
        "builtAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    manifest_name = name + ".manifest.json"
    with open(os.path.join(out_dir, manifest_name), "w") as fh:
        fh.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    sums = "".join("%s  %s\n" % (sha256_file(os.path.join(out_dir, n)), n)
                   for n in [name + ".tar.gz", npm_name, manifest_name])
    with open(os.path.join(out_dir, "SHA256SUMS"), "w") as fh:
        fh.write(sums)
    print(json.dumps(manifest, indent=2, sort_keys=True))

    # [12] work 移入 trash（不删除）
    dest = os.path.join(args.trash, "wdev-proxy-build-" + stamp)
    mkdirs(args.trash)
    shutil.move(work, dest)
    print("BUILD_OK work_trashed=" + dest)

if __name__ == "__main__":
    main()
