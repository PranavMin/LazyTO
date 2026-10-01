#!/usr/bin/env bash
# add-wifi.sh -- teach the Pi another Wi-Fi network (the venue's), so it joins
# it on its own when it boots there. Works while that network is out of range:
# NetworkManager keeps every saved network and connects to whichever is
# present, so the Pi still joins your home Wi-Fi at home.
#
#   ssh -t pi@relay.local sudo bash /opt/lazyto/deploy/add-wifi.sh "Venue Guest"
#
# Prompts for the password (not echoed, not in shell history). An open network:
# press Enter at the prompt. Re-running with the same name replaces it.
set -euo pipefail

SSID="${1:?usage: add-wifi.sh <network name>}"
[[ $EUID -eq 0 ]] || { echo "add-wifi.sh: run with sudo" >&2; exit 1; }
IFACE=$(nmcli -t -f DEVICE,TYPE device | awk -F: '$2 == "wifi" { print $1; exit }')
[[ -n "$IFACE" ]] || { echo "add-wifi.sh: no Wi-Fi device found" >&2; exit 1; }

read -r -s -p "Password for \"$SSID\" (Enter for an open network): " PSK
echo

nmcli connection delete "$SSID" >/dev/null 2>&1 || true
if [[ -z "$PSK" ]]; then
  nmcli connection add type wifi con-name "$SSID" ifname "$IFACE" ssid "$SSID" \
    connection.autoconnect yes >/dev/null
else
  [[ ${#PSK} -ge 8 ]] || { echo "add-wifi.sh: a WPA password has at least 8 characters" >&2; exit 1; }
  nmcli connection add type wifi con-name "$SSID" ifname "$IFACE" ssid "$SSID" \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PSK" connection.autoconnect yes >/dev/null
fi
echo "saved \"$SSID\" on $IFACE. Saved Wi-Fi networks:"
nmcli -t -f NAME,TYPE connection show | awk -F: '$2 == "802-11-wireless" { print "  " $1 }'
