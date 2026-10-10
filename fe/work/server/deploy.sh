#!/usr/bin/env bash
# 弈鉴信令服务 —— 在 VPS 上执行（需要 root/sudo）
#
# 用法（在服务器上，和 server.mjs 同一目录）：
#   STUN_HOST=stun:你的域名:3478 ./deploy.sh
#
# 只做三件事：拷文件、装 systemd 单元、起来并自检。不装任何软件包，
# 不改防火墙 —— 端口放行请你自己确认（这台机器上还跑着 Hysteria）。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/yijian}"
PORT="${PORT:-8787}"
STUN_HOST="${STUN_HOST:-}"

# 以脚本自身所在目录为准，这样从任何 cwd 运行都能找到 server.mjs
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" != "0" ]; then
  echo "请用 root 运行（或 sudo ./deploy.sh）" >&2
  exit 1
fi

echo "==> 检查 Node"
if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'MSG'
没有找到 node。先装 Node 20+（Debian/Ubuntu）：
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
然后重新运行本脚本。
MSG
  exit 1
fi
node -v

if [ -z "$STUN_HOST" ]; then
  echo "警告：没有设置 STUN_HOST。" >&2
  echo "      没有 STUN 的话公网连不上（本机候选是 mDNS 名字，对端解析不了）。" >&2
  echo "      确认要这样跑，就设 STUN_HOST=skip 再执行。" >&2
  [ "${STUN_HOST:-}" = "skip" ] || exit 1
fi

echo "==> 检查端口占用"
if command -v ss >/dev/null 2>&1; then
  ss -lntup 2>/dev/null | grep -E ":(8787|3478|443)\b" || echo "  （8787/3478/443 当前未见占用）"
fi

echo "==> 安装到 $APP_DIR"
install -d "$APP_DIR"
install -m 0644 "$SCRIPT_DIR/server.mjs" "$APP_DIR/server.mjs"

echo "==> 写 systemd 单元"
cat > /etc/systemd/system/yijian-signal.service <<EOF
[Unit]
Description=YiJian signalling server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PORT=$PORT
Environment=STUN_URL=$STUN_HOST
ExecStart=$(command -v node) $APP_DIR/server.mjs
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable yijian-signal >/dev/null
systemctl restart yijian-signal
sleep 1

echo "==> 自检"
if curl -fsS "http://127.0.0.1:$PORT/health"; then
  echo
  echo "服务已启动。"
else
  echo "健康检查失败，看日志：" >&2
  journalctl -u yijian-signal -n 30 --no-pager >&2
  exit 1
fi

cat <<MSG

接下来（这些需要你自己确认，脚本不动防火墙也不签证书）：

  1) 放行端口：$PORT/tcp（或交给 Caddy 反代）、3478/udp+tcp（STUN）
     这台机器上跑着 Hysteria，注意别和它的 UDP 443 冲突。
  2) HTTPS/WSS：客户端从安全上下文发起 ws:// 会被拦，
     所以要让 Caddy/nginx 反代出 wss://你的域名/ws
  3) 客户端里填：连接方式=服务器，地址 = wss://你的域名/ws

MSG
