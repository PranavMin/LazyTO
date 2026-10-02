#!/usr/bin/env bash
# update.sh -- keeps the LazyTO relay on the newest build of the channel it
# follows. systemd runs it as root before every relay start (ExecStartPre in
# lazyto-relay.service): at boot, after a crash, after a restart. Updates
# happen only then, never while the relay runs, so a night runs on one
# version and a Pi switched on before a tournament comes up on the newest.
#
#   update.sh              check the channel; install its build if it differs
#   update.sh --from DIR   install the unpacked bundle in DIR now (install.sh)
#
# The channel is the word in /var/lib/lazyto/update-channel, written by
# install.sh and by the settings page:
#   release   the newest published LazyTO release (the default)
#   main      the newest build of main, on the moving prerelease main-build
#   off       no updates
# Any build whose VERSION differs from the installed one is installed, so
# switching channels and rolling back both work.
#
# A check happens at most every 10 minutes: the unit restarts a crashed relay
# within seconds, and GitHub allows 60 anonymous requests an hour. A new build
# must accept the relay's settings (its own dist/src/check-config.js), else it
# is skipped and remembered in update-bad until the channel moves on. Without
# --from, every failure logs one line and exits 0, so the relay starts with
# what is installed. Logs: journalctl -u lazyto-relay | grep update:
set -uo pipefail

REPO="PranavMin/LazyTO"
APP=/opt/lazyto
DATA_DIR=/var/lib/lazyto
UNIT=lazyto-relay
CHECK_INTERVAL=600
STAMP="$DATA_DIR/update-check"
BAD="$DATA_DIR/update-bad"
CURL=(curl -fsSL --max-time 60 --retry 1)

log() { echo "update: $*"; }

# Put the unpacked bundle in $1 in place of /opt/lazyto, and its unit file in
# place of the installed one. Safe while this script runs from /opt/lazyto:
# bash keeps reading the file it opened.
install_from() {
  local src=$1 f
  for f in VERSION package.json dist/main.js deploy/update.sh "deploy/$UNIT.service" \
    wii/tournament.bin wii/apps/LazyTO/boot.dol; do
    if [[ ! -f "$src/$f" ]]; then
      log "the bundle has no $f"
      return 1
    fi
  done
  rm -rf "$APP.new" "$APP.old"
  cp -r "$src" "$APP.new" || return 1
  chmod 0755 "$APP.new"/deploy/*.sh
  chown -R root:root "$APP.new"
  if [[ -d "$APP" ]]; then mv "$APP" "$APP.old" || return 1; fi
  if ! mv "$APP.new" "$APP"; then
    [[ -d "$APP.old" ]] && mv "$APP.old" "$APP"
    return 1
  fi
  rm -rf "$APP.old" "$BAD"
  if ! cmp -s "$APP/deploy/$UNIT.service" "/etc/systemd/system/$UNIT.service"; then
    install -o root -g root -m 0644 "$APP/deploy/$UNIT.service" "/etc/systemd/system/$UNIT.service"
    systemctl daemon-reload
    log "unit file updated; it applies from the next start"
  fi
  log "installed $(cat "$APP/VERSION")"
}

if [[ "${1:-}" == "--from" ]]; then
  [[ -d "${2:-}" ]] || { echo "usage: update.sh --from <unpacked bundle dir>" >&2; exit 2; }
  install_from "$2" || exit 1
  exit 0
fi

channel=$(tr -d '[:space:]' 2>/dev/null <"$DATA_DIR/update-channel")
channel=${channel:-release}
case "$channel" in
  release) base="https://github.com/$REPO/releases/latest/download" ;;
  main) base="https://github.com/$REPO/releases/download/main-build" ;;
  off)
    log "off (update channel)"
    exit 0
    ;;
  *)
    log "update channel \"$channel\" is not release, main or off; not updating"
    exit 0
    ;;
esac

now=$(date +%s)
last=$(cat "$STAMP" 2>/dev/null || echo 0)
if ((now - last < CHECK_INTERVAL)); then
  log "skipped: checked $((now - last)) s ago"
  exit 0
fi
echo "$now" >"$STAMP"

installed=$(cat "$APP/VERSION" 2>/dev/null || echo none)
remote=$("${CURL[@]}" "$base/VERSION" 2>/dev/null | head -1 | tr -d '[:space:]')
if [[ -z "$remote" ]]; then
  log "no VERSION at $base (offline, or nothing published yet); keeping $installed"
  exit 0
fi
if [[ "$remote" == "$installed" ]]; then
  log "up to date ($installed, $channel)"
  exit 0
fi
if [[ "$remote" == "$(cat "$BAD" 2>/dev/null)" ]]; then
  log "$remote still rejects the settings (see earlier); keeping $installed"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if ! "${CURL[@]}" "$base/lazyto.tgz" -o "$tmp/lazyto.tgz" ||
  ! "${CURL[@]}" "$base/lazyto.tgz.sha256" -o "$tmp/lazyto.tgz.sha256"; then
  log "download failed; keeping $installed"
  exit 0
fi
if ! (cd "$tmp" && sha256sum -c --quiet lazyto.tgz.sha256 >/dev/null 2>&1); then
  log "checksum mismatch on lazyto.tgz; keeping $installed"
  exit 0
fi
mkdir "$tmp/bundle"
if ! tar -xzf "$tmp/lazyto.tgz" -C "$tmp/bundle"; then
  log "unpack failed; keeping $installed"
  exit 0
fi

# The new build must accept the settings the relay has now (no settings file
# is fine: the relay then shows its setup page).
if ! reason=$(cd "$tmp/bundle" && /opt/node/bin/node dist/src/check-config.js "$DATA_DIR/config.json" 2>&1); then
  log "$remote rejects the settings (${reason:0:300}); keeping $installed"
  echo "$remote" >"$BAD"
  exit 0
fi

if ! install_from "$tmp/bundle"; then
  log "install failed; keeping $installed"
fi
exit 0
