#!/usr/bin/env bash
# 弈鉴信令服务 —— 在 VPS 上执行（需要 root/sudo）
#
# 用法（在服务器上，和 server.mjs 同一目录）：
#   STUN_HOST=stun:你的域名:3478 \
#   TURN_SECRET=一段随机串 PUBLIC_IP=你的公网IP \
#   ./deploy.sh
#
# 做三件事：拷文件、装 systemd 单元、起来并自检。
# 加 INSTALL_COTURN=1 时会额外渲染 /etc/turnserver.conf 并重启 coturn。
# 不装任何软件包，也不改防火墙 —— 端口放行请你自己确认。
#
# 环境变量：
#   PORT            信令端口，默认 8787
#   GAME_LIBRARY_SOURCE
#                   棋库生成目录；默认使用脚本旁的 data/game-library
#   INSTALL_NGINX=1 安装 c.syjnb.top 的 /api/games 反代配置
#   STUN_HOST       形如 stun:你的域名或IP:3478
#   PUBLIC_IP       TURN 的公网地址（coturn 的 external-ip，也是 TURN_URL 的默认主机）
#   TURN_SECRET     TURN 临时凭证密钥，必须与 coturn 的 static-auth-secret 一致
#   TURN_URL        可省略：给了 PUBLIC_IP + TURN_SECRET 时自动生成 udp+tcp 两条
#   TURN_TTL        凭证有效期（秒），默认 600
#   REALM           coturn realm，默认取 PUBLIC_IP
#   INSTALL_COTURN  设为 1 则同时写入 /etc/turnserver.conf 并重启 coturn
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/yijian}"
PORT="${PORT:-8787}"
STUN_HOST="${STUN_HOST:-}"
PUBLIC_IP="${PUBLIC_IP:-}"
TURN_SECRET="${TURN_SECRET:-}"
TURN_TTL="${TURN_TTL:-600}"
REALM="${REALM:-}"
TURN_URL="${TURN_URL:-}"

# 给了公网 IP 和 secret 但没写 TURN_URL 时，默认同时下发 udp 与 tcp 两条中继地址：
# UDP 更快，TCP 在 UDP 被封的网络里还能兜底。
if [ -z "$TURN_URL" ] && [ -n "$PUBLIC_IP" ] && [ -n "$TURN_SECRET" ]; then
  TURN_URL="turn:$PUBLIC_IP:3478?transport=udp,turn:$PUBLIC_IP:3478?transport=tcp"
fi

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
install -m 0644 "$SCRIPT_DIR/game-library.mjs" "$APP_DIR/game-library.mjs"

GAME_LIBRARY_SOURCE="${GAME_LIBRARY_SOURCE:-$SCRIPT_DIR/data/game-library}"
if [ -f "$GAME_LIBRARY_SOURCE/catalog.json" ] \
  && [ -f "$GAME_LIBRARY_SOURCE/games.ndjson" ] \
  && [ -f "$GAME_LIBRARY_SOURCE/manifest.json" ]; then
  echo "==> 安装在线棋库"
  install -d "$APP_DIR/data/game-library"
  install -m 0644 "$GAME_LIBRARY_SOURCE/catalog.json" "$APP_DIR/data/game-library/catalog.json"
  install -m 0644 "$GAME_LIBRARY_SOURCE/games.ndjson" "$APP_DIR/data/game-library/games.ndjson"
  install -m 0644 "$GAME_LIBRARY_SOURCE/manifest.json" "$APP_DIR/data/game-library/manifest.json"
else
  echo "==> 未提供在线棋库生成物，保留 $APP_DIR/data/game-library 现有数据"
fi

if [ "${INSTALL_COTURN:-0}" = "1" ]; then
  if [ -z "$PUBLIC_IP" ] || [ -z "$TURN_SECRET" ]; then
    echo "INSTALL_COTURN=1 需要同时设置 PUBLIC_IP 与 TURN_SECRET" >&2
    exit 1
  fi
  echo "==> 渲染 coturn 配置"
  if [ -f /etc/turnserver.conf ]; then
    cp -a /etc/turnserver.conf "/etc/turnserver.conf.bak.$(date +%s)"
  fi
  rendered="$(mktemp)"
  sed -e "s|__PUBLIC_IP__|$PUBLIC_IP|g" \
      -e "s|__TURN_SECRET__|$TURN_SECRET|g" \
      -e "s|__REALM__|${REALM:-$PUBLIC_IP}|g" \
      "$SCRIPT_DIR/coturn.conf" > "$rendered"
  install -m 0640 -o root -g turnserver "$rendered" /etc/turnserver.conf
  rm -f "$rendered"
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn
  echo "    coturn 已重启"
fi

echo "==> 写 systemd 单元"
ENV_LINES="Environment=PORT=$PORT
Environment=STUN_URL=$STUN_HOST
Environment=GAME_LIBRARY_DIR=$APP_DIR/data/game-library"
if [ -n "$TURN_URL" ] && [ -n "$TURN_SECRET" ]; then
  ENV_LINES="$ENV_LINES
Environment=TURN_URL=$TURN_URL
Environment=TURN_SECRET=$TURN_SECRET
Environment=TURN_TTL=$TURN_TTL"
fi
cat > /etc/systemd/system/yijian-signal.service <<EOF
[Unit]
Description=YiJian signalling server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$ENV_LINES
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

if [ "${INSTALL_NGINX:-0}" = "1" ]; then
  if [ ! -f "$SCRIPT_DIR/nginx-c.syjnb.top.conf" ]; then
    echo "INSTALL_NGINX=1 但缺少 nginx-c.syjnb.top.conf" >&2
    exit 1
  fi
  if [ -f /etc/nginx/conf.d/yijian.conf ]; then
    cp -a /etc/nginx/conf.d/yijian.conf "/etc/nginx/conf.d/yijian.conf.bak.$(date +%s)"
  fi
  install -m 0644 "$SCRIPT_DIR/nginx-c.syjnb.top.conf" /etc/nginx/conf.d/yijian.conf
  nginx -t
  systemctl reload nginx
fi

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
     如果启用了 TURN，还要放行中继端口段 49160-49200/udp
     （coturn.conf 里的 min-port / max-port，两端都在 CGNAT 后面时靠它中转）
     这台机器上跑着 Hysteria，注意别和它的 UDP 443 冲突。
  2) HTTPS/WSS：客户端从安全上下文发起 ws:// 会被拦，
     所以要让 Caddy/nginx 反代出 wss://你的域名/ws
  3) 客户端里填：连接方式=服务器，地址 = wss://你的域名/ws
     服务器会随 welcome 一起下发 TURN 临时凭证，客户端无需任何额外配置。

MSG
