---
name: pi-deploy
description: Deploy or inspect the relay on the venue Raspberry Pi - update channels, npm run push for an unmerged build, reinstalling, health checks over ssh. Use when the user asks to push, update, check or debug the Pi relay.
---

# Deploy the relay to the Pi

Operator reference: `docs/pi-setup.md` (Day-to-day commands, Updates, Troubleshooting).

## How code reaches the Pi

- Every push to `main` makes `release.yml` test, build the one bundle `lazyto.tgz` (relay,
  loader, `tournament.bin`) and republish it on the moving prerelease `main-build`. A `v*` tag
  drafts a release with the same assets.
- At every service start, `deploy/update.sh` checks the Pi's update channel
  (`/var/lib/lazyto/update-channel`: `release`, `main` or `off`; the settings page sets it), at
  most once per 10 minutes. A bundle whose VERSION differs is verified, checked against the
  settings with the new build's `check-config.js`, and swapped in. A refused build is remembered
  in `/var/lib/lazyto/update-bad`.
- The settings (`/var/lib/lazyto/config.json`) never travel by update. The setup page writes
  them. A new field in `src/config.ts` must be optional with a default (CLAUDE.md), or every
  Pi refuses the build.

So on a Pi following `main`: merge, wait for `release.yml` to finish, restart the service.

## Push an unmerged build

Run `npm test` first. Then ask the user before pushing, because the Pi may be serving a live
event.

```bash
npm run push
```

It downloads `main-build`, puts this clone's `dist/` and `deploy/` in it, and installs it with
`install.sh --bundle`, which sets the Pi's update channel to `off` so the build stays. Pick
Development builds on the settings page (or reinstall with `--channel main`) to follow `main`
again.

- `--dry-run` builds the bundle and installs nothing.
- `--pi-host <name> --user <user>` for another Pi.

## Reinstall

On the Pi (asks for its password over ssh); it keeps the settings:

```bash
ssh -t pi@relay.local "curl -fsSL https://github.com/PranavMin/LazyTO/releases/download/main-build/install.sh | sudo bash -s -- --channel main"
```

## Health checks (read-only, no confirmation needed)

```bash
ssh pi@relay.local systemctl status lazyto-relay
```

```bash
ssh pi@relay.local journalctl -u lazyto-relay -n 80 --no-pager
```

```bash
npx tsx scripts/smoke.ts relay.local
```

Status page: `http://relay.local:29473`. Its footer shows the installed VERSION.

Ports: TCP 29470 Wii requests, UDP 29471 beacon, UDP 29472 Wii logs and beacon requests,
TCP 29473 setup and status pages. Older ports (7777-7780, 8080-8083) are stale.

## Cautions

- The Pi beacons on the LAN. Do not run a development relay on the same LAN at the same time.
- A relay that can't start its event keeps its page up and retries by itself (30 s, 60 s, then
  every 2 min); systemd restarts only a crash. A restart re-resolves this week's tournament.
- Never print `.env` values, the settings file, the relay secret, or the start.gg token.
- The user's terminal is Windows PowerShell 5.1. Commands for them must be PowerShell-valid.
