#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SERVICE_NAME="${SAFEHARBOR_SERVICE_NAME:-safeharbor-hub}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
RUN_USER="${SAFEHARBOR_USER:-$(id -un)}"
RUN_GROUP="${SAFEHARBOR_GROUP:-$(id -gn)}"
DATA_DIR="${SAFEHARBOR_HOME:-/var/lib/safeharbor}"
BIND_HOST="${SAFEHARBOR_HOST:-0.0.0.0}"
BIND_PORT="${PORT:-43718}"
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || true)
fi

if [ "${1:-}" = "-Uninstall" ] || [ "${1:-}" = "--uninstall" ]; then
  sudo systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  sudo rm -f "$SERVICE_FILE"
  sudo systemctl daemon-reload
  printf '%s uninstalled. Data was left in %s.\n' "$SERVICE_NAME" "$DATA_DIR"
  exit 0
fi

if [ "$(uname -s)" != "Linux" ]; then
  printf 'This installer is intended for Raspberry Pi OS or another systemd-based Linux host.\n' >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  printf 'systemctl was not found. Install manually or use a systemd-based Raspberry Pi OS image.\n' >&2
  exit 1
fi

if [ -z "$NODE_BIN" ]; then
  printf 'node was not found. Install Node.js 20 LTS or newer first.\n' >&2
  exit 1
fi

NODE_MAJOR=$("$NODE_BIN" -p "Number(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  printf 'Node.js 20 LTS or newer is required. Found: %s\n' "$("$NODE_BIN" -v)" >&2
  exit 1
fi

if [ -f "$ROOT_DIR/package-lock.json" ]; then
  npm --prefix "$ROOT_DIR" ci
else
  npm --prefix "$ROOT_DIR" install
fi

sudo mkdir -p "$DATA_DIR"
sudo chown "$RUN_USER:$RUN_GROUP" "$DATA_DIR"

sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=SafeHarbor home hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$ROOT_DIR
Environment=SAFEHARBOR_HOME=$DATA_DIR
Environment=SAFEHARBOR_HOST=$BIND_HOST
Environment=PORT=$BIND_PORT
ExecStart=$NODE_BIN server/safeharbor-server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"

HEALTH_HOST="$BIND_HOST"
if [ "$HEALTH_HOST" = "0.0.0.0" ]; then
  HEALTH_HOST="127.0.0.1"
fi
HEALTH_URL="http://${HEALTH_HOST}:${BIND_PORT}/health"
if command -v curl >/dev/null 2>&1; then
  i=0
  while [ "$i" -lt 20 ]; do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$i" -ge 20 ]; then
    printf 'SafeHarbor service did not pass health check at %s.\n' "$HEALTH_URL" >&2
    sudo journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
    exit 1
  fi
else
  printf 'curl was not found; skipping post-install health check.\n'
fi

printf 'SafeHarbor hub installed as %s.\n' "$SERVICE_NAME"
printf 'Listening on %s:%s with data in %s.\n' "$BIND_HOST" "$BIND_PORT" "$DATA_DIR"
printf 'Print the parent dashboard token with:\n'
printf '  sudo -u %s env SAFEHARBOR_HOME=%s %s %s/server/safeharbor-server.js --show-token\n' "$RUN_USER" "$DATA_DIR" "$NODE_BIN" "$ROOT_DIR"
printf 'Print the legacy local-device token for smoke tests with:\n'
printf '  sudo -u %s env SAFEHARBOR_HOME=%s %s %s/server/safeharbor-server.js --show-device-token\n' "$RUN_USER" "$DATA_DIR" "$NODE_BIN" "$ROOT_DIR"
