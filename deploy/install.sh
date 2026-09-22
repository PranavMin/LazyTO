#!/usr/bin/env bash
# deploy/install.sh -- install or update the Tournament Reporter relay on a
# Raspberry Pi (docs/design.md section 10). Idempotent: run it again after
# `git pull` to redeploy; run it again after editing the config to (re)start.
#
# One path, no auto-detection:
#   - runs as user "pi" (the unit runs as pi; nvm lives in /home/pi/.nvm),
#     with sudo for the root-owned parts;
#   - Node 22 via nvm, the exact resolved binary written into the unit;
#   - dist/ + package.json  -> /opt/tournament-reporter
#     config.json           -> /etc/tournament-reporter  (token lives ONLY here)
#     audit log             -> /var/lib/tournament-reporter/<eventId>.jsonl
#   - systemd unit enabled and (re)started; the service's own startup
#     validation is the last word on the config (bad token / event id ->
#     exit 1 -> unit ends up "failed", and this script says so).
#
# Anything unexpected stops the script with a message. Nothing is guessed.

set -euo pipefail

SERVICE_USER=pi
SERVICE=tournament-reporter
NODE_MAJOR=22
NVM_VERSION=v0.40.3
NVM_DIR="/home/${SERVICE_USER}/.nvm"
APP_DIR=/opt/tournament-reporter
CONF_DIR=/etc/tournament-reporter
DATA_DIR=/var/lib/tournament-reporter
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "install.sh: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

# ---- preconditions ----------------------------------------------------------
[ "$(uname -s)" = Linux ] || die "this installs onto a Linux Pi, not $(uname -s)"
[ "$(id -un)" = "$SERVICE_USER" ] || die "run as user $SERVICE_USER (the service user), not $(id -un)"
command -v sudo >/dev/null || die "sudo is required"
command -v systemctl >/dev/null || die "systemd is required"
command -v curl >/dev/null || die "curl is required (apt install curl)"
[ -f "$REPO_DIR/package.json" ] || die "no package.json in $REPO_DIR; run from a checkout of the relay repo"
[ -f "$REPO_DIR/deploy/${SERVICE}.service" ] || die "missing $REPO_DIR/deploy/${SERVICE}.service"

# ---- Node 22 via nvm --------------------------------------------------------
step "Node ${NODE_MAJOR} via nvm (${NVM_DIR})"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "installing nvm ${NVM_VERSION}"
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | PROFILE=/dev/null NVM_DIR="$NVM_DIR" bash
fi
export NVM_DIR
# nvm is a shell function that is not clean under `set -u`.
set +u
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_MAJOR" >/dev/null
nvm use "$NODE_MAJOR" >/dev/null
NODE_BIN="$(nvm which "$NODE_MAJOR")"
set -u
[ -x "$NODE_BIN" ] || die "nvm which ${NODE_MAJOR} gave '${NODE_BIN}', not an executable"
case "$NODE_BIN" in
  "$NVM_DIR"/versions/node/v${NODE_MAJOR}.*/bin/node) ;;
  *) die "unexpected node path ${NODE_BIN} (want ${NVM_DIR}/versions/node/v${NODE_MAJOR}.x/bin/node)" ;;
esac
echo "node: $NODE_BIN ($("$NODE_BIN" --version))"

# ---- build ------------------------------------------------------------------
step "build (${REPO_DIR})"
cd "$REPO_DIR"
npm ci --no-audit --no-fund
rm -rf dist
npm run build
[ -f dist/main.js ] || die "build produced no dist/main.js"

# ---- /opt: code -------------------------------------------------------------
step "install code to ${APP_DIR}"
sudo mkdir -p "$APP_DIR"
sudo rm -rf "$APP_DIR/dist"
sudo cp -r dist "$APP_DIR/dist"
sudo cp package.json README.md "$APP_DIR/"   # package.json: "type": "module" for dist/*.js
sudo chown -R root:root "$APP_DIR"

# ---- /etc: config -----------------------------------------------------------
step "config in ${CONF_DIR}"
sudo mkdir -p "$CONF_DIR"
if [ ! -f "$CONF_DIR/config.json" ]; then
  sudo install -m 0600 -o "$SERVICE_USER" -g "$SERVICE_USER" deploy/config.example.json "$CONF_DIR/config.json"
  cat >&2 <<MSG

install.sh: installed the example config at ${CONF_DIR}/config.json.
Edit it (token, eventId, streamId -- see README.md "Config"), then run
this script again to start the service. Nothing has been started.
MSG
  exit 1
fi
if sudo grep -q REPLACE_ME "$CONF_DIR/config.json"; then
  die "${CONF_DIR}/config.json still contains the REPLACE_ME token placeholder; edit it and re-run"
fi
sudo chown "$SERVICE_USER:$SERVICE_USER" "$CONF_DIR/config.json"
sudo chmod 0600 "$CONF_DIR/config.json"

# ---- /var/lib: audit log ----------------------------------------------------
step "audit dir ${DATA_DIR}"
sudo mkdir -p "$DATA_DIR"
sudo chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# ---- systemd ----------------------------------------------------------------
step "systemd unit ${SERVICE}.service"
UNIT_TMP="$(mktemp)"
sed "s|@NODE@|${NODE_BIN}|" "deploy/${SERVICE}.service" > "$UNIT_TMP"
if grep -q '@NODE@' "$UNIT_TMP"; then die "unit still has the @NODE@ placeholder after rendering"; fi
sudo install -m 0644 -o root -g root "$UNIT_TMP" "/etc/systemd/system/${SERVICE}.service"
rm -f "$UNIT_TMP"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null
sudo systemctl restart "$SERVICE"

# The relay validates the config and does one start.gg refresh before it
# listens; give it a moment, then report what systemd sees. A bad token or
# event id shows up here as "failed" with the reason in the journal.
sleep 3
if sudo systemctl is-active --quiet "$SERVICE"; then
  HTTP_PORT="$(sudo "$NODE_BIN" -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).httpPort))' "$CONF_DIR/config.json")"
  echo
  echo "${SERVICE} is running. Status page: http://$(hostname -I | awk '{print $1}'):${HTTP_PORT}/"
  echo "Logs: journalctl -u ${SERVICE} -f"
else
  echo >&2
  sudo systemctl --no-pager --full status "$SERVICE" >&2 || true
  echo >&2
  sudo journalctl -u "$SERVICE" -n 20 --no-pager >&2 || true
  die "${SERVICE} is not running; see the journal output above (bad config? start.gg unreachable?)"
fi
