#!/usr/bin/env bash
# update.sh -- Pi-side auto-update for the LazyTO relay, run by systemd as
# ExecStartPre of lazyto-relay.service (as root, see the unit) every time the
# relay starts: at boot, after a crash, after `systemctl restart lazyto-relay`.
#
# Same shape as matchcaller's start script (update at start, never while
# running): the relay only ever runs one version for a whole night, and a Pi
# that is power-cycled before a tournament comes up on the newest main.
#
# What it does, in order; any failure logs one line and exits 0 so the relay
# starts with what is installed:
#   1. Skip if /etc/lazyto/no-auto-update exists (a dev build from push.ps1
#      you want to keep), or if the last check was less than CHECK_INTERVAL
#      ago (the unit restarts every 10 s to 2 min while the network or
#      start.gg is down, and GitHub allows 60 anonymous requests an hour).
#   2. Fetch VERSION from the `latest` prerelease that release.yml publishes
#      on every push to main. Same as /opt/lazyto/VERSION: nothing to do.
#   3. Download lazyto-relay-main.tgz and its .sha256, verify, unpack to a
#      temp dir, check it is a relay bundle, and run the NEW build's
#      dist/src/check-config.js against /etc/lazyto/config.json: a build
#      whose config schema does not match the installed config is refused
#      (and remembered in /var/lib/lazyto/update-bad), because it would
#      install fine and then die at startup. Config changes travel with
#      push.ps1, never with this script.
#   4. Swap dist/, deploy/, package.json, README.md, LICENSE, VERSION under
#      /opt/lazyto (config in /etc/lazyto is never touched), install the
#      bundle's unit file if it changed and daemon-reload (takes effect at the
#      next start; this start continues with the unit systemd already loaded).
#
# Logs to the journal of lazyto-relay (journalctl -u lazyto-relay | grep update).
set -uo pipefail

REPO="PranavMin/LazyTO"
CHANNEL="latest"                      # the moving prerelease tag release.yml maintains
ASSET="lazyto-relay-main.tgz"
BASE="https://github.com/${REPO}/releases/download/${CHANNEL}"
APP=/opt/lazyto
CONF_DIR=/etc/lazyto
DATA_DIR=/var/lib/lazyto
UNIT=lazyto-relay
CHECK_INTERVAL=600                    # seconds between checks
STAMP="$DATA_DIR/update-check"
BAD="$DATA_DIR/update-bad"            # a remote version this config.json rejected
CURL=(curl -fsSL --max-time 60 --retry 1)

log() { echo "update: $*"; }

if [[ -e "$CONF_DIR/no-auto-update" ]]; then
  log "skipped: $CONF_DIR/no-auto-update exists"
  exit 0
fi
now=$(date +%s)
if [[ -f "$STAMP" ]]; then
  last=$(cat "$STAMP" 2>/dev/null || echo 0)
  if (( now - last < CHECK_INTERVAL )); then
    log "skipped: checked $(( now - last )) s ago"
    exit 0
  fi
fi
echo "$now" > "$STAMP"

installed=$(cat "$APP/VERSION" 2>/dev/null || echo "none")
remote=$("${CURL[@]}" "$BASE/VERSION" 2>/dev/null | head -1 | tr -d '[:space:]')
if [[ -z "$remote" ]]; then
  log "no VERSION at $BASE (offline, or no release yet); keeping $installed"
  exit 0
fi
if [[ "$remote" == "$installed" ]]; then
  log "up to date ($installed)"
  exit 0
fi
if [[ -f "$BAD" && "$remote" == "$(cat "$BAD")" ]]; then
  log "$remote still rejects this config.json (see earlier); keeping $installed"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if ! "${CURL[@]}" "$BASE/$ASSET" -o "$tmp/$ASSET" || ! "${CURL[@]}" "$BASE/$ASSET.sha256" -o "$tmp/$ASSET.sha256"; then
  log "download failed; keeping $installed"
  exit 0
fi
if ! (cd "$tmp" && sha256sum -c --quiet "$ASSET.sha256" 2>/dev/null); then
  log "checksum mismatch on $ASSET; keeping $installed"
  exit 0
fi
mkdir -p "$tmp/bundle"
if ! tar -xzf "$tmp/$ASSET" -C "$tmp/bundle"; then
  log "unpack failed; keeping $installed"
  exit 0
fi
for f in dist/main.js package.json deploy/$UNIT.service deploy/update.sh VERSION; do
  if [[ ! -f "$tmp/bundle/$f" ]]; then
    log "bundle has no $f; keeping $installed"
    exit 0
  fi
done
bundle_ver=$(head -1 "$tmp/bundle/VERSION" | tr -d '[:space:]')

# --- the new build must accept the installed config.json. loadConfig rejects
#     unknown and missing fields with no defaults, so a build from before or
#     after a config-schema change would be swapped in fine and then die at
#     startup. Refuse it and remember it, so the next checks are one request
#     each until main moves on (or push.ps1 rewrites the config). ---
if [[ ! -f "$tmp/bundle/dist/src/check-config.js" ]]; then
  log "bundle $bundle_ver has no config check (older than the updater); keeping $installed"
  echo "$bundle_ver" > "$BAD"
  exit 0
fi
reason=$(cd "$tmp/bundle" && CONFIG="$CONF_DIR/config.json" /opt/node/bin/node dist/src/check-config.js 2>&1 >/dev/null | paste -sd' ' | cut -c1-300)
if [[ -n "$reason" ]]; then
  log "bundle $bundle_ver rejects $CONF_DIR/config.json ($reason); keeping $installed. Push the config with push.ps1, or wait for main to move on"
  echo "$bundle_ver" > "$BAD"
  exit 0
fi

# --- swap: the relay is not running during ExecStartPre, so this is safe ---
rm -rf "$APP/dist.new" "$APP/deploy.new"
cp -r "$tmp/bundle/dist" "$APP/dist.new"
cp -r "$tmp/bundle/deploy" "$APP/deploy.new"
chmod 0755 "$APP/deploy.new"/*.sh 2>/dev/null || true
rm -rf "$APP/dist" "$APP/deploy"
mv "$APP/dist.new" "$APP/dist"
mv "$APP/deploy.new" "$APP/deploy"
cp "$tmp/bundle/package.json" "$APP/package.json"
for f in README.md LICENSE; do
  [[ -f "$tmp/bundle/$f" ]] && cp "$tmp/bundle/$f" "$APP/$f"
done
echo "$bundle_ver" > "$APP/VERSION"
chown -R root:root "$APP"

if ! cmp -s "$tmp/bundle/deploy/$UNIT.service" "/etc/systemd/system/$UNIT.service"; then
  install -o root -g root -m 0644 "$tmp/bundle/deploy/$UNIT.service" "/etc/systemd/system/$UNIT.service"
  systemctl daemon-reload
  log "unit file updated; applies at the next start"
fi
log "installed $bundle_ver (was $installed)"
exit 0
