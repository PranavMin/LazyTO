#!/usr/bin/env bash
# uninstall.sh -- remove everything install.sh put on a Pi, and nothing else.
# For a shared Pi (the venue's matchcaller one): leaves the other software,
# its user and its files alone.
#
#   ssh -t <user>@<pi> sudo bash /opt/tournament-reporter/deploy/uninstall.sh
#
# Keeps the audit logs in /var/lib/tournament-reporter unless --purge is given.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "uninstall.sh: run with sudo" >&2; exit 1; }
PURGE="${1:-}"

systemctl disable --now tournament-reporter >/dev/null 2>&1 || true
rm -f /etc/systemd/system/tournament-reporter.service
systemctl daemon-reload
rm -f /etc/NetworkManager/conf.d/tournament-reporter-wifi.conf
systemctl reload NetworkManager 2>/dev/null || true
rm -rf /etc/tournament-reporter            # the config holds the start.gg token
# Node: only the version directory our /opt/node link points at (install.sh
# made both); another Node on a shared Pi is left alone.
if [[ -L /opt/node ]]; then
  node_dir=$(readlink -f /opt/node)
  [[ "$node_dir" == /opt/node-v* ]] && rm -rf "$node_dir"
  rm -f /opt/node
fi
rm -rf /opt/tournament-reporter
if [[ "$PURGE" == "--purge" ]]; then
  rm -rf /var/lib/tournament-reporter
  echo "audit logs removed"
else
  echo "audit logs kept in /var/lib/tournament-reporter (re-run with --purge to remove)"
fi
id -u relay >/dev/null 2>&1 && userdel relay
# systemd-time-wait-sync stays enabled: harmless, and other software may rely on it.
echo "relay removed"
