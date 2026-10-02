#!/usr/bin/env bash
# uninstall.sh -- remove everything install.sh put on a Pi, and nothing else.
# For a shared Pi (one that also runs a bracket display): leaves the other software,
# its user and its files alone.
#
#   ssh -t <user>@<pi> sudo bash /opt/lazyto/deploy/uninstall.sh
#
# Removes the settings (the start.gg token, the Wii secret, the admin
# password). Keeps the audit logs, /var/lib/lazyto/*.jsonl, unless --purge
# is given.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "uninstall.sh: run it with sudo" >&2; exit 1; }
PURGE="${1:-}"

systemctl disable --now lazyto-relay >/dev/null 2>&1 || true
rm -f /etc/systemd/system/lazyto-relay.service
systemctl daemon-reload
rm -f /etc/NetworkManager/conf.d/lazyto-wifi.conf
systemctl reload NetworkManager 2>/dev/null || true
# Node: only the version directory our /opt/node link points at (install.sh
# made both); another Node on a shared Pi is left alone.
if [[ -L /opt/node ]]; then
  node_dir=$(readlink -f /opt/node)
  [[ "$node_dir" == /opt/node-v* ]] && rm -rf "$node_dir"
  rm -f /opt/node
fi
rm -rf /opt/lazyto
if [[ "$PURGE" == "--purge" ]]; then
  rm -rf /var/lib/lazyto
  echo "settings and audit logs removed"
elif [[ -d /var/lib/lazyto ]]; then
  find /var/lib/lazyto -mindepth 1 ! -name '*.jsonl' -delete
  echo "settings removed; audit logs kept in /var/lib/lazyto (run again with --purge to remove them)"
fi
id -u relay >/dev/null 2>&1 && userdel relay
echo "LazyTO removed"
