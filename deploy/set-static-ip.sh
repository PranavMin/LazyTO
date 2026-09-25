#!/usr/bin/env bash
# set-static-ip.sh -- give the Pi a fixed address for the Wiis'
# tournament.cfg (relay_ip=...), on top of DHCP, on one interface (wlan0 for
# Wi-Fi, eth0 for a cable). On Wi-Fi the address belongs to the network the
# Pi is on when you run it: run it once at the venue, on the venue's Wi-Fi.
#   sudo bash /opt/tournament-reporter/deploy/set-static-ip.sh 192.168.1.10/24 wlan0
# Keeps DHCP (so ssh pi@relay.local keeps working on any network, home or
# venue) and adds the fixed address as a second address on the same
# interface. Pick an address inside the venue's subnet but outside its DHCP
# pool. Re-run with a new address to change it; run with "none" to remove it.
set -euo pipefail

ADDR="${1:?usage: set-static-ip.sh <ip/prefix | none> <wlan0 | eth0>}"
IFACE="${2:?usage: set-static-ip.sh <ip/prefix | none> <wlan0 | eth0>}"

[[ $EUID -eq 0 ]] || { echo "set-static-ip.sh: run with sudo" >&2; exit 1; }
CON=$(nmcli -g GENERAL.CONNECTION device show "$IFACE" 2>/dev/null || true)
[[ -n "$CON" && "$CON" != "--" ]] || { echo "set-static-ip.sh: no active connection on $IFACE (not joined to Wi-Fi / no cable?)" >&2; exit 1; }

if [[ "$ADDR" == "none" ]]; then
  nmcli connection modify "$CON" ipv4.method auto ipv4.addresses ""
else
  [[ "$ADDR" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || { echo "set-static-ip.sh: address must look like 192.168.1.10/24" >&2; exit 1; }
  nmcli connection modify "$CON" ipv4.method auto ipv4.addresses "$ADDR"
fi
# Re-activating may drop an ssh session for a second; it comes back.
nmcli connection up "$CON" >/dev/null
echo "addresses on $IFACE now:"
nmcli -g IP4.ADDRESS device show "$IFACE" | tr '|' '\n'
