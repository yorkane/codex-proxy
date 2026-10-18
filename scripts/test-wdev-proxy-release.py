#!/usr/bin/env python3
"""build-wdev-proxy-release.py 的构建器合同测试（小 fixture，无完整重 build）。

覆盖：
 1) materialize：嵌套 symlink 目录/文件物化为 regular，外部 symlink 拒收；
 2) audit_tree：hardlink/special 拒收，纯 REG(nlink=1)/DIR 通过；
 3) FLAT tar：成员 ./bin/ocx.mjs 直铺 root（无顶层前缀）；
 4) manifest JSON 嵌套对象序列化（replacer 陷阱回归）。
跑法：python3 scripts/test-wdev-proxy-release.py（全过打印 TESTS_OK，失败非零退出）。
"""
import json, os, shutil, subprocess, sys, tarfile, tempfile, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bld", os.path.join(HERE, "build-wdev-proxy-release.py"))
bld = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bld)

def make_tree(root):
    os.makedirs(os.path.join(root, "real/sub"))
    with open(os.path.join(root, "real/file.txt"), "w") as fh:
        fh.write("payload")
    os.symlink("real", os.path.join(root, "linkdir"))
    os.symlink("real/file.txt", os.path.join(root, "linkfile"))
    with open(os.path.join(root, "bin-ocx"), "w") as fh:
        fh.write("#!/bin/sh\n")
    os.chmod(os.path.join(root, "bin-ocx"), 0o755)

def test_materialize(tmp):
    stage = os.path.join(tmp, "stage"); trash = os.path.join(tmp, "trash")
    os.makedirs(stage); os.makedirs(trash)
    make_tree(stage)
    moved = bld.materialize(stage, trash)
    assert moved == 2, "expected 2 links materialized, got %d" % moved
    assert os.path.isdir(os.path.join(stage, "linkdir")) and not os.path.islink(os.path.join(stage, "linkdir"))
    with open(os.path.join(stage, "linkdir/file.txt")) as fh:
        assert fh.read() == "payload"
    assert not os.path.islink(os.path.join(stage, "linkfile"))
    bld.audit_tree(stage)
    ext = os.path.join(tmp, "outside")
    os.makedirs(ext)
    os.symlink("/etc/passwd", os.path.join(stage, "evil"))
    try:
        bld.materialize(stage, trash)
        raise AssertionError("external symlink must be rejected")
    except SystemExit:
        pass

def test_audit_hardlink(tmp):
    stage = os.path.join(tmp, "hard"); os.makedirs(stage)
    src = os.path.join(stage, "a"); dst = os.path.join(stage, "b")
    open(src, "w").write("x"); os.link(src, dst)
    try:
        bld.audit_tree(stage)
        raise AssertionError("hardlink must be rejected")
    except SystemExit:
        pass

def test_flat_tar(tmp):
    stage = os.path.join(tmp, "flat"); os.makedirs(os.path.join(stage, "bin"))
    with open(os.path.join(stage, "bin", "ocx.mjs"), "w") as fh:
        fh.write("//x\n")
    with open(os.path.join(stage, "package.json"), "w") as fh:
        fh.write("{}\n")
    tar = os.path.join(tmp, "flat.tar.gz")
    raw = tar + ".raw"
    bld.sh(["tar", "--owner=0", "--group=0", "--numeric-owner", "--sort=name",
            "--mtime=@0", "--clamp-mtime", "-C", stage, "-cf", raw, "."])
    gz = subprocess.run(["gzip", "-n", "-9", "-c", raw], capture_output=True)
    assert gz.returncode == 0
    open(tar, "wb").write(gz.stdout)
    with tarfile.open(tar, "r:gz") as tf:
        names = [m.name.lstrip("./") for m in tf.getmembers()]
        assert all(m.isreg() or m.isdir() for m in tf.getmembers())
    assert "bin/ocx.mjs" in names, names[:6]
    assert not any(n.startswith("flat/") for n in names)

def test_manifest_replacer(tmp):
    m = {"schema": "wdev-proxy-release/1",
         "bunRuntime": {"path": "node_modules/bun/bin/bun.exe", "version": "1.4.2"},
         "platforms": ["linux-amd64"], "validatedOn": None}
    doc = json.loads(json.dumps(m, indent=2, sort_keys=True))
    assert doc["bunRuntime"]["version"] == "1.4.2", "nested object lost"
    assert doc["validatedOn"] is None

def main():
    tmp = tempfile.mkdtemp(prefix="wdev-builder-test-")
    try:
        for t in (test_materialize, test_audit_hardlink, test_flat_tar, test_manifest_replacer):
            sub = os.path.join(tmp, t.__name__)
            os.makedirs(sub)
            t(sub)
            print("PASS", t.__name__)
    finally:
        shutil.move(tmp, os.path.join("/data/.trash", "wdev-builder-test-" + os.path.basename(tmp)))
    print("TESTS_OK")

if __name__ == "__main__":
    main()
