#!/usr/bin/env bash
# install.sh -- Pi-side installer for the Tournament Reporter relay.
# Run as root on the Pi from an extracted bundle made by deploy/push.ps1:
#   sudo bash /tmp/tr/deploy/install.sh /tmp/tr
# The bundle holds dist/ (compiled relay), deploy/ (this dir) and config.json.
# Idempotent: re-running upgrades the relay and config and restarts it.
set -euo pipefail

BUNDLE="${1:?usage: install.sh <bundle dir>}"
NODE_VERSION="v22.23.3"
NODE_SHA256="a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f"
NODE_TARBALL="node-${NODE_VERSION}-linux-arm64.tar.xz"
APP=/opt/tournament-reporter
CONF_DIR=/etc/tournament-reporter
DATA_DIR=/var/lib/tournament-reporter
UNIT=tournament-reporter

[[ $EUID -eq 0 ]] || { echo "install.sh: run with sudo" >&2; exit 1; }
[[ -f "$BUNDLE/dist/src/main.js" ]] || { echo "install.sh: $BUNDLE/dist/src/main.js missing (bundle not built?)" >&2; exit 1; }
[[ -f "$BUNDLE/config.json" ]] || { echo "install.sh: $BUNDLE/config.json missing" >&2; exit 1; }
[[ "$(uname -m)" == "aarch64" ]] || { echo "install.sh: expected a 64-bit OS (aarch64), got $(uname -m)" >&2; exit 1; }

# --- Node: pinned official tarball at /opt/node-<ver>, symlinked to /opt/node ---
if [[ "$(/opt/node/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]]; then
  echo "installing Node $NODE_VERSION"
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}" -o "$tmp/$NODE_TARBALL"
  echo "$NODE_SHA256  $tmp/$NODE_TARBALL" | sha256sum -c - >/dev/null
  rm -rf "/opt/node-${NODE_VERSION}"
  mkdir -p "/opt/node-${NODE_VERSION}"
  tar -xJf "$tmp/$NODE_TARBALL" -C "/opt/node-${NODE_VERSION}" --strip-components=1
  ln -sfn "/opt/node-${NODE_VERSION}" /opt/node
  rm -rf "$tmp"
fi
echo "node $(/opt/node/bin/node --version) at /opt/node"

# --- service user and directories ---
if ! id -u relay >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin relay
fi
mkdir -p "$APP" "$CONF_DIR" "$DATA_DIR"
chown relay:relay "$DATA_DIR"
chmod 750 "$DATA_DIR"

# --- relay code (replaced wholesale) and the deploy scripts for later use ---
rm -rf "$APP/dist" "$APP/deploy"
cp -r "$BUNDLE/dist" "$APP/dist"
cp -r "$BUNDLE/deploy" "$APP/deploy"
chown -R root:root "$APP"

# --- config: holds the start.gg token, so root-owned and readable by relay only ---
install -o root -g relay -m 0640 "$BUNDLE/config.json" "$CONF_DIR/config.json"

# --- unit ---
install -o root -g root -m 0644 "$BUNDLE/deploy/$UNIT.service" "/etc/systemd/system/$UNIT.service"
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
systemctl restart "$UNIT"

# --- wait for the fail-fast startup to settle, then report ---
up() { journalctl -u "$UNIT" --since "-30s" -o cat --no-pager | grep -q "^relay up:"; }
for _ in $(seq 1 20); do
  sleep 1
  if up; then break; fi
  if ! systemctl is-active --quiet "$UNIT"; then break; fi
done
echo
if systemctl is-active --quiet "$UNIT" && up; then
  journalctl -u "$UNIT" --since "-30s" -o cat --no-pager | grep "^relay up:" | tail -1
  http_port=$(sed -n 's/.*"httpPort": *\([0-9]*\).*/\1/p' "$CONF_DIR/config.json")
  echo "OK: $UNIT is running. Status page: http://$(hostname).local:${http_port}"
else
  echo "FAILED: $UNIT is not up. Last log lines:" >&2
  journalctl -u "$UNIT" --since "-60s" -o cat --no-pager | tail -20 >&2
  exit 1
fi
