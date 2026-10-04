#!/usr/bin/env bash
# Runs ON the NAS (uploaded by fnos-deploy.py).
# Args: <dir> <host_port> <access_password> <image_hash> <need_image 0|1>
set -euo pipefail
DIR="$1"; PORT="$2"; ACCESS_PASSWORD="$3"; IMAGE_HASH="${4:-}"; NEED_IMAGE="${5:-0}"
PKG=/tmp/sd-release.tgz
SEED=/tmp/sd-seed.tgz

say() { printf '\033[1;32m[nas]\033[0m %s\n' "$*"; }

# docker without sudo when possible.
SUDO=""
if ! docker ps >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null || sudo -v; then SUDO="sudo"; else
    echo "当前用户既不能直接用 docker，也没有 sudo 权限。请把 $(whoami) 加入 docker 组或用管理员账号部署。" >&2; exit 1
  fi
fi
DOCKER="$SUDO docker"
$DOCKER compose version >/dev/null 2>&1 || { echo "NAS 上没有 docker compose 插件" >&2; exit 1; }

say "目录 $DIR"
$SUDO mkdir -p "$DIR/data" "$DIR/projects" "$DIR/.home"
$SUDO chown "$(id -u):$(id -g)" "$DIR" "$DIR/.home" 2>/dev/null || true
cd "$DIR"
# fnOS accounts may have no Linux home directory; docker needs a writable one for its client config.
if [ ! -d "${HOME:-/nonexistent}" ] || [ ! -w "${HOME:-/nonexistent}" ]; then
  export HOME="$DIR/.home"
fi
export DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
mkdir -p "$DOCKER_CONFIG"

say "解包代码（保留 data/ projects/ .env）"
find . -mindepth 1 -maxdepth 1 ! -name data ! -name projects ! -name .env ! -name .home ! -name .image-hash -exec $SUDO rm -rf {} +
tar xzf "$PKG" -C "$DIR"
rm -f "$PKG"

# First deploy only: seed settings (model / API key) and projects from the Mac. Never overwrites NAS data.
if [ -f "$SEED" ]; then
  if [ -z "$(ls -A data 2>/dev/null)" ] && [ -z "$(ls -A projects 2>/dev/null)" ]; then
    say "首次部署：导入本机的模型设置与项目"
    $SUDO tar xzf "$SEED" -C "$DIR"
  else
    say "NAS 上已有数据，跳过导入（不覆盖）"
  fi
  rm -f "$SEED"
fi

port_busy() { (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}' | grep -qE "[:.]$1\$"; }
if [ -f .env ] && grep -q '^HOST_PORT=' .env; then
  PORT="$(sed -n 's/^HOST_PORT=//p' .env)"
fi
if [ ! -f .env ]; then
  while port_busy "$PORT" && ! $DOCKER ps --format '{{.Ports}}' | grep -q ":$PORT->"; do
    say "端口 $PORT 已被占用，尝试 $((PORT+1))"; PORT=$((PORT+1))
  done
  umask 077
  printf 'HOST_PORT=%s\nSUPERDEMO_PASSWORD=%s\n' "$PORT" "$ACCESS_PASSWORD" > .env
  say "已生成 .env（访问口令见最后输出）"
else
  say "沿用已有 .env（端口 ${PORT}，访问口令不变）"
fi
# demo port (previews + share links on their own origin): next to the shell's port unless taken
if ! grep -q '^DEMO_HOST_PORT=' .env; then
  DPORT=$((PORT+1))
  while port_busy "$DPORT" && ! $DOCKER ps --format '{{.Ports}}' | grep -q ":$DPORT->"; do DPORT=$((DPORT+1)); done
  printf 'DEMO_HOST_PORT=%s\n' "$DPORT" >> .env
  say "Demo 端口：${DPORT}（预览和分享链接，和 SuperDemo 隔离）"
fi
DEMO_PORT_OUT="$(sed -n 's/^DEMO_HOST_PORT=//p' .env)"

if [ -f /tmp/sd-image.tgz ]; then
  say "载入本机构建的镜像"
  $DOCKER load < /tmp/sd-image.tgz
  rm -f /tmp/sd-image.tgz
  [ -n "$IMAGE_HASH" ] && printf '%s\n' "$IMAGE_HASH" > .image-hash
  say "重建容器"
  $DOCKER compose up -d --no-build --remove-orphans --force-recreate
elif $DOCKER image inspect superdemo:latest >/dev/null 2>&1 && [ "$NEED_IMAGE" != 1 ]; then
  say "镜像未变：应用新代码并重启容器（shell/ sdk/ templates/ 为挂载目录）"
  $DOCKER compose up -d --no-build --remove-orphans
  $DOCKER compose restart
else
  echo "NAS 上没有 superdemo 镜像，请用 FULL=1 重新部署" >&2; exit 1
fi

say "等待服务就绪"
READY=0
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || wget -qO- "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
if [ "$READY" != 1 ]; then
  echo "服务未在 80 秒内就绪，最近日志：" >&2; $DOCKER compose logs --tail=40 >&2; exit 1
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="$(ip -4 route get 1 2>/dev/null | awk '{print $7; exit}')"
AP="$(sed -n 's/^SUPERDEMO_PASSWORD=//p' .env)"

echo
echo "=================================================="
echo "  部署完成  $(date '+%m-%d %H:%M')"
echo "  地址：     http://$IP:$PORT"
echo "  Demo 端口：$DEMO_PORT_OUT（预览/分享链接；用域名访问时在设置里填「Demo 地址」）"
echo "  访问口令： $AP   （浏览器弹出登录框，用户名随意）"
echo "  目录：     $DIR   （data/ 设置与 Key，projects/ 项目与数据，.env 含口令，勿删）"
echo "=================================================="
