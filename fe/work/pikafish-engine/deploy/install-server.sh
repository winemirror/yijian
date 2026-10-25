#!/bin/sh
set -eu

APP_ROOT=/opt/yijian-pikafish
STATE_ROOT=/var/lib/yijian-pikafish
LOG_ROOT=/var/log/yijian-pikafish
STAGE_ROOT=/root/yijian-pikafish-deploy
SERVICE_USER=yijian-pikafish

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

for file in \
  "$STAGE_ROOT/node.tar.xz" \
  "$STAGE_ROOT/engine-service.mjs" \
  "$STAGE_ROOT/Pikafish-Linux-x86-64-universal" \
  "$STAGE_ROOT/pikafish.nnue" \
  "$STAGE_ROOT/Copying.txt" \
  "$STAGE_ROOT/NNUE-License.md" \
  "$STAGE_ROOT/yijian-pikafish.service"; do
  test -f "$file" || {
    echo "missing: $file" >&2
    exit 1
  }
done

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -m 0755 -o root -g root "$APP_ROOT"
install -d -m 0755 -o root -g root "$APP_ROOT/pikafish"
install -d -m 0755 -o root -g root "$APP_ROOT/licenses"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_ROOT"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$LOG_ROOT"

rm -rf "$APP_ROOT/node.new"
install -d -m 0755 "$APP_ROOT/node.new"
tar -xJf "$STAGE_ROOT/node.tar.xz" -C "$APP_ROOT/node.new" --strip-components=1
rm -rf "$APP_ROOT/node"
mv "$APP_ROOT/node.new" "$APP_ROOT/node"

install -m 0755 "$STAGE_ROOT/engine-service.mjs" "$APP_ROOT/engine-service.mjs"
install -m 0755 "$STAGE_ROOT/Pikafish-Linux-x86-64-universal" \
  "$APP_ROOT/pikafish/Pikafish-Linux-x86-64-universal"
install -m 0644 "$STAGE_ROOT/pikafish.nnue" "$APP_ROOT/pikafish/pikafish.nnue"
install -m 0644 "$STAGE_ROOT/Copying.txt" "$APP_ROOT/licenses/Copying.txt"
install -m 0644 "$STAGE_ROOT/NNUE-License.md" "$APP_ROOT/licenses/NNUE-License.md"

(
  cd "$APP_ROOT/pikafish"
  /usr/sbin/runuser -u "$SERVICE_USER" -- \
    env HOME="$STATE_ROOT" \
    ./Pikafish-Linux-x86-64-universal bench 2>/dev/null | tail -n 1
) > "$LOG_ROOT/install-bench.txt"

install -m 0644 "$STAGE_ROOT/yijian-pikafish.service" \
  /etc/systemd/system/yijian-pikafish.service
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/yijian-pikafish.service
systemctl enable yijian-pikafish.service

echo "installed"
echo "service=yijian-pikafish"
echo "bench=$(cat "$LOG_ROOT/install-bench.txt")"
