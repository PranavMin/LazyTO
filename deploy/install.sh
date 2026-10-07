#!/usr/bin/env bash
# install.sh -- install LazyTO on a Raspberry Pi, or reinstall it. On the Pi:
#
#   curl -fsSL https://github.com/PranavMin/LazyTO/releases/latest/download/install.sh | sudo bash
#
# then open the address it prints and finish on the setup page. Running it
# again is safe: it installs the newest build and keeps the settings.
#
# Options (piped: ... | sudo bash -s -- <options>):
#   --channel release|main|off   the builds this Pi follows from now on
#                                (deploy/update.sh). Default: what it follows
#                                already, else release. main: every change to
#                                LazyTO, for testing it.
#   --bundle FILE                install this lazyto.tgz instead of downloading
#                                one; updates are then off unless --channel
#                                says otherwise.
#
# Puts everything under /opt/node-<version> (and its /opt/node link),
# /opt/lazyto and /var/lib/lazyto, plus one system user "relay", one systemd
# unit and one NetworkManager setting; deploy/uninstall.sh removes exactly
# that. Runs next to other software on a shared Pi.
set -euo pipefail

REPO="PranavMin/LazyTO"
NODE_VERSION="v22.23.3"
APP=/opt/lazyto
DATA_DIR=/var/lib/lazyto
UNIT=lazyto-relay
PORT=29473

usage() {
  echo "usage: install.sh [--channel release|main|off] [--bundle lazyto.tgz]" >&2
  exit 2
}
channel=""
bundle=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) [[ $# -ge 2 ]] || usage; channel=$2; shift 2 ;;
    --bundle) [[ $# -ge 2 ]] || usage; bundle=$2; shift 2 ;;
    *) usage ;;
  esac
done
case "$channel" in
  release | main | off) ;;
  "")
    if [[ -n "$bundle" ]]; then
      channel=off
    else
      channel=$(tr -d '[:space:]' 2>/dev/null <"$DATA_DIR/update-channel" || true)
      [[ "$channel" == main || "$channel" == off ]] || channel=release
    fi
    ;;
  *) usage ;;
esac
[[ -z "$bundle" || -f "$bundle" ]] || { echo "install.sh: no file $bundle" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "install.sh: run it with sudo" >&2; exit 1; }

# --- Node: pinned official tarball at /opt/node-<ver>, linked from /opt/node.
#     64-bit Raspberry Pi OS is aarch64, 32-bit is armv7l (a shared Pi may run
#     either). Checksums from https://nodejs.org/dist/v22.23.3/SHASUMS256.txt ---
case "$(uname -m)" in
  aarch64) NODE_ARCH=arm64 NODE_SHA256="a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f" ;;
  armv7l) NODE_ARCH=armv7l NODE_SHA256="590a2768199bdd0b848648a81cd7f07f88a5ceb27949f0c70d5e6652c3eaca69" ;;
  *) echo "install.sh: unsupported architecture $(uname -m) (want aarch64 or armv7l)" >&2; exit 1 ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [[ "$(/opt/node/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]]; then
  echo "installing Node $NODE_VERSION"
  tarball="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${tarball}" -o "$tmp/$tarball"
  echo "$NODE_SHA256  $tmp/$tarball" | sha256sum -c - >/dev/null
  rm -rf "/opt/node-${NODE_VERSION}"
  mkdir -p "/opt/node-${NODE_VERSION}"
  tar -xJf "$tmp/$tarball" -C "/opt/node-${NODE_VERSION}" --strip-components=1
  ln -sfn "/opt/node-${NODE_VERSION}" /opt/node
  rm -f "$tmp/$tarball"
fi

# --- Wi-Fi power saving off: it adds lag spikes of hundreds of ms and drops
#     mDNS, and the Wiis give up on the relay after 3 s. Applies when a Wi-Fi
#     connection next comes up (at the latest, the next boot) ---
install -o root -g root -m 0644 /dev/stdin /etc/NetworkManager/conf.d/lazyto-wifi.conf <<'CONF'
[connection]
wifi.powersave = 2
CONF
systemctl reload NetworkManager

# --- the relay's user and data: settings, audit logs, update channel ---
if ! id -u relay >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin relay
fi
mkdir -p "$DATA_DIR"
chown relay:relay "$DATA_DIR"
chmod 750 "$DATA_DIR"
echo "$channel" >"$DATA_DIR/update-channel"
chown relay:relay "$DATA_DIR/update-channel"

# --- the bundle: the relay and the Wii files, from one build ---
if [[ -n "$bundle" ]]; then
  cp "$bundle" "$tmp/lazyto.tgz"
else
  if [[ "$channel" == main ]]; then
    base="https://github.com/$REPO/releases/download/main-build"
  else
    base="https://github.com/$REPO/releases/latest/download"
  fi
  echo "downloading $base/lazyto.tgz"
  status=$(curl -sSL --max-time 300 -o "$tmp/lazyto.tgz" -w '%{http_code}' "$base/lazyto.tgz" || true)
  if [[ "$status" == 404 && "$channel" != main ]]; then
    echo "install.sh: no LazyTO release is published yet. For the newest development build:" >&2
    echo "  curl -fsSL https://github.com/$REPO/releases/download/main-build/install.sh | sudo bash -s -- --channel main" >&2
    exit 1
  fi
  [[ "$status" == 200 ]] || { echo "install.sh: download failed (HTTP $status)" >&2; exit 1; }
  curl -fsSL "$base/lazyto.tgz.sha256" -o "$tmp/lazyto.tgz.sha256"
  (cd "$tmp" && sha256sum -c --quiet lazyto.tgz.sha256)
fi
mkdir "$tmp/bundle"
tar -xzf "$tmp/lazyto.tgz" -C "$tmp/bundle"
bash "$tmp/bundle/deploy/update.sh" --from "$tmp/bundle"
date +%s >"$DATA_DIR/update-check" # just installed: this start skips the check

systemctl enable "$UNIT" >/dev/null 2>&1
systemctl restart "$UNIT"

# --- wait for the page: 303 to /setup once the relay knows it is not set up
#     (it has written the setup code by then), 200 otherwise ---
page=""
for _ in $(seq 1 30); do
  status=$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  if [[ "$status" == 303 && -f "$DATA_DIR/setup-code" ]]; then page=setup && break; fi
  if [[ "$status" == 200 ]]; then page=status && break; fi
  sleep 1
done
if [[ -z "$page" ]]; then
  echo "FAILED: the relay did not start. Its last log lines:" >&2
  journalctl -u "$UNIT" --since "-60s" -o cat --no-pager | tail -20 >&2
  exit 1
fi

ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -m1 -E '^[0-9]+\.' || true)
echo
echo "LazyTO $(cat "$APP/VERSION") is installed. Updates: $channel."
if [[ "$page" == setup ]]; then
  code=$(cat "$DATA_DIR/setup-code")
  echo "Finish on the setup page, from a phone or computer on this Pi's network:"
  echo "  http://$(hostname).local:$PORT/setup"
  [[ -n "$ip" ]] && echo "  http://$ip:$PORT/setup   (if the first one does not open)"
  echo "Setup code: ${code:0:4}-${code:4}"
else
  echo "It kept its settings. Status page:"
  echo "  http://$(hostname).local:$PORT"
  [[ -n "$ip" ]] && echo "  http://$ip:$PORT   (if the first one does not open)"
fi
exit 0
