#!/usr/bin/env python3
"""Deploy / upgrade the SuperDemo shell on the fnOS NAS over password SSH.

    SD_SSH_PASSWORD=... python3 deploy/fnos-deploy.py         # incremental: image rebuilt only when deps changed
    FULL=1 SD_SSH_PASSWORD=... python3 deploy/fnos-deploy.py  # force image rebuild

Needs `paramiko` (pip install paramiko) and, when the image must be (re)built, a local Docker (e.g. `colima start`).
The SSH password is read from SD_SSH_PASSWORD (or asked for), also answers sudo on the NAS, and is never written to disk.
data/, projects/ and .env on the NAS are always preserved. The first deploy seeds data/settings.json (model + API key),
the usage log and projects/ from this Mac (node_modules excluded) — only if the NAS has no data yet; SEED=0 skips it.
"""
import getpass
import hashlib
import os
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request

import paramiko

HOST = os.environ.get("FNOS_HOST", "192.168.123.203")
USER = os.environ.get("FNOS_USER", "admin01")
PORT = int(os.environ.get("FNOS_SSH_PORT", "22"))
REMOTE_DIR = os.environ.get("REMOTE_DIR", "/vol1/1000/docker/superdemo")
HOST_PORT = os.environ.get("HOST_PORT", "18788")
IMAGE = "superdemo:latest"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ["docker-compose.yml", "Dockerfile", ".dockerignore", ".env.example", "package.json", "package-lock.json",
         "shell", "sdk", "templates", "deploy", "README.md", "LICENSE"]
DEP_FILES = ("package.json", "package-lock.json", "Dockerfile")


def step(msg):
    print(f"\n\033[1;34m==> {msg}\033[0m", flush=True)


def run(cmd, **kw):
    subprocess.run(cmd, cwd=ROOT, check=True, **kw)


def remote(ssh, cmd, password=None, stream=False):
    """Run on the NAS; with `password`, sudo prompts are answered from it. Returns (exit code, output)."""
    chan = ssh.get_transport().open_session()
    if password:
        chan.get_pty()  # sudo may prompt
    chan.exec_command(cmd)
    out = b""
    answered = 0
    while True:
        if chan.recv_ready():
            data = chan.recv(65536)
            out += data
            if stream:
                sys.stdout.write(data.decode("utf-8", "replace"))
                sys.stdout.flush()
            tail = out[-200:].decode("utf-8", "replace").lower()
            if password and answered < 3 and ("password for" in tail or "密码" in tail[-40:]) and tail.rstrip().endswith(":"):
                chan.send(password + "\n")
                answered += 1
        elif chan.exit_status_ready() and not chan.recv_ready():
            break
        else:
            time.sleep(0.05)
    return chan.recv_exit_status(), out.decode("utf-8", "replace")


def tar(dest, paths, excludes=()):
    args = ["tar", "czf", dest, "--no-xattrs", "--exclude=.DS_Store", "--exclude=__pycache__", *[f"--exclude={e}" for e in excludes], *paths]
    run(args, env={**os.environ, "COPYFILE_DISABLE": "1"})


def main():
    password = os.environ.get("SD_SSH_PASSWORD") or getpass.getpass(f"{USER}@{HOST} 的 SSH 密码：")

    step("打包代码（不含 data/ projects/ node_modules .env）")
    pkg = tempfile.mktemp(suffix=".tgz")
    tar(pkg, [f for f in FILES if os.path.exists(os.path.join(ROOT, f))])
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    print(f"包：{os.path.getsize(pkg) // 1024} KB，提交 {commit}")
    h = hashlib.sha1()
    for f in DEP_FILES:
        h.update(open(os.path.join(ROOT, f), "rb").read())
    image_hash = h.hexdigest()[:16]

    seed = None
    if os.environ.get("SEED", "1") == "1":
        paths = [p for p in ("data/settings.json", "data/usage-log.jsonl", "projects") if os.path.exists(os.path.join(ROOT, p))]
        if paths:
            seed = tempfile.mktemp(suffix=".tgz")
            # node_modules may hold macOS binaries; projects reinstall on the NAS when needed
            tar(seed, paths, excludes=("node_modules", "*.db-shm", "*.db-wal", "run.log.1"))

    step(f"连接 {USER}@{HOST}")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=PORT, username=USER, password=password, look_for_keys=False, allow_agent=False, timeout=15)
    _, info = remote(ssh, f"echo ARCH=$(uname -m); echo HASH=$(cat '{REMOTE_DIR}/.image-hash' 2>/dev/null || echo none); "
                          f"(docker image inspect {IMAGE} >/dev/null 2>&1 || sudo -n docker image inspect {IMAGE} >/dev/null 2>&1) "
                          "&& echo IMG=image-present || echo IMG=image-missing")
    kv = dict(l.strip().split("=", 1) for l in info.replace("\r", "").split("\n") if "=" in l)
    arch, rhash, rimg = kv.get("ARCH", ""), kv.get("HASH", "none"), kv.get("IMG", "image-missing")
    print(f"已连接：{HOST} ({arch}) · 远端镜像：{rimg} · 依赖哈希 本地 {image_hash} / 远端 {rhash}")

    need_image = os.environ.get("FULL") == "1" or rimg == "image-missing" or rhash != image_hash
    img = None
    if need_image:
        step("本地构建镜像并导出（首次 / 依赖或 Dockerfile 有变化）")
        want = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(arch, arch)
        run(["docker", "build", "--platform", f"linux/{want}", "-t", IMAGE, "."])
        got = subprocess.run(["docker", "image", "inspect", "--format", "{{.Architecture}}", IMAGE],
                             capture_output=True, text=True, check=True).stdout.strip()
        if got != want:
            sys.exit(f"本机镜像架构 {got} 与 NAS ({want}) 不一致")
        img = tempfile.mktemp(suffix=".tgz")
        run(f"docker save {IMAGE} | gzip -1 > '{img}'", shell=True)
        print(f"镜像：{os.path.getsize(img) // (1024 * 1024)} MB，{got}")
    else:
        print("依赖未变化，跳过镜像：只同步代码并重启容器")

    step("上传")
    sftp = ssh.open_sftp()
    sftp.put(pkg, "/tmp/sd-release.tgz")
    sftp.put(os.path.join(ROOT, "deploy", "fnos-remote.sh"), "/tmp/sd-remote.sh")
    if seed:
        sftp.put(seed, "/tmp/sd-seed.tgz")
        os.remove(seed)
    if img:
        last = [0.0]

        def progress(done, total):
            if time.time() - last[0] > 3 or done == total:
                last[0] = time.time()
                print(f"  镜像上传 {done * 100 // max(total, 1)}%", flush=True)

        sftp.put(img, "/tmp/sd-image.tgz", callback=progress)
        os.remove(img)
    sftp.close()
    os.remove(pkg)

    step("在 NAS 上更新并重启")
    access = secrets.token_urlsafe(12)  # used only when the NAS has no .env yet
    code, _ = remote(ssh, f"bash /tmp/sd-remote.sh '{REMOTE_DIR}' '{HOST_PORT}' '{access}' '{image_hash}' '{1 if need_image else 0}'",
                     password=password, stream=True)
    ssh.close()
    if code != 0:
        sys.exit(f"远端脚本失败（退出码 {code}）")

    step("从本机验证")
    url = f"http://{HOST}:{HOST_PORT}/api/health"
    try:
        with urllib.request.urlopen(url, timeout=8) as r:
            print(f"本机可访问：http://{HOST}:{HOST_PORT}  ({r.status})")
    except Exception as e:  # noqa: BLE001
        print(f"本机暂时访问不到 {url}：{e}（端口若被自动改过，以上面 NAS 输出的地址为准）")


if __name__ == "__main__":
    main()
