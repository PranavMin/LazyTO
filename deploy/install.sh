#!/usr/bin/env bash
# install.sh -- Pi-side installer for the LazyTO relay.
# Run as root on the Pi from an extracted bundle made by deploy/push.ps1:
#   sudo bash /tmp/tr/deploy/install.sh /tmp/tr
# The bundle holds dist/ (compiled relay), package.json ("type": "module",
# which dist/*.js needs beside it), deploy/ (this dir) and config.json.
# Idempotent: re-running upgrades the relay and config and restarts it.
#
# Runs on a Pi of its own or next to other software on a shared one (the
# venue's matchcaller Pi Zero 2 W): everything lives under /opt/node*,
# /opt/lazyto, /etc/lazyto, /var/lib/lazyto,
# one system user "relay" and one unit; deploy/uninstall.sh removes exactly that.
set -euo pipefail

BUNDLE="${1:?usage: install.sh <bundle dir>}"
NODE_VERSION="v22.23.3"
# Official tarball for the OS's architecture: 64-bit Raspberry Pi OS is
# aarch64, 32-bit is armv7l (a shared Pi may run either). Checksums from
# https://nodejs.org/dist/v22.23.3/SHASUMS256.txt.
case "$(uname -m)" in
  aarch64) NODE_ARCH=arm64;  NODE_SHA256="a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f" ;;
  armv7l)  NODE_ARCH=armv7l; NODE_SHA256="590a2768199bdd0b848648a81cd7f07f88a5ceb27949f0c70d5e6652c3eaca69" ;;
  *) echo "install.sh: unsupported architecture $(uname -m) (want aarch64 or armv7l)" >&2; exit 1 ;;
esac
NODE_TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
APP=/opt/lazyto
CONF_DIR=/etc/lazyto
DATA_DIR=/var/lib/lazyto
UNIT=lazyto-relay

[[ $EUID -eq 0 ]] || { echo "install.sh: run with sudo" >&2; exit 1; }

# --- one-time migration from the pre-rename install ("tournament-reporter",
#     renamed to LazyTO 2026-09-30): stop and remove the old unit, carry the
#     audit logs over (a mid-tournament push must keep its claims), drop the
#     old code, config and NetworkManager drop-in. No-op on a fresh Pi. ---
if [[ -f /etc/systemd/system/tournament-reporter.service ]]; then
  echo "migrating from the tournament-reporter install"
  systemctl disable --now tournament-reporter >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/tournament-reporter.service
  systemctl daemon-reload
fi
if [[ -d /var/lib/tournament-reporter ]]; then
  mkdir -p "$DATA_DIR"
  cp -an /var/lib/tournament-reporter/. "$DATA_DIR"/
  rm -rf /var/lib/tournament-reporter
fi
rm -rf /opt/tournament-reporter /etc/tournament-reporter
rm -f /etc/NetworkManager/conf.d/tournament-reporter-wifi.conf
for f in dist/main.js package.json config.json deploy/$UNIT.service; do
  [[ -f "$BUNDLE/$f" ]] || { echo "install.sh: $BUNDLE/$f missing (bundle not built by push.ps1?)" >&2; exit 1; }
done

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

# --- Wi-Fi power saving off: it adds latency spikes of hundreds of ms and
#     drops mDNS, and the Wiis give up on the relay after 3 s ---
install -o root -g root -m 0644 /dev/stdin /etc/NetworkManager/conf.d/lazyto-wifi.conf <<'CONF'
[connection]
wifi.powersave = 2
CONF
# Takes effect when a Wi-Fi connection next comes up (at the latest, the next boot).
systemctl reload NetworkManager

# --- wait for a synced clock before the relay starts: a Pi without a battery
#     RTC boots with last shutdown's time, and the Abbey fallback picks the
#     weekly nearest to "now" (src/resolve.ts). The unit orders after
#     time-sync.target; this service is what makes that target wait. ---
systemctl enable systemd-time-wait-sync.service >/dev/null 2>&1 \
  || echo "install.sh: note: systemd-time-wait-sync not available; the relay may start before the clock syncs"

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
cp "$BUNDLE/package.json" "$APP/package.json"
[[ -f "$BUNDLE/README.md" ]] && cp "$BUNDLE/README.md" "$APP/README.md"
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
