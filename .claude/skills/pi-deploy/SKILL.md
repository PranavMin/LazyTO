---
name: pi-deploy
description: Deploy or inspect the relay on the venue Raspberry Pi - npm run push, auto-update behaviour, config changes, health checks over ssh. Use when the user asks to push, update, check or debug the Pi relay.
---

# Deploy the relay to the Pi

Operator reference: `docs/pi-setup.md` (Day-to-day commands, Updates, Troubleshooting).

## How code reaches the Pi

- Every push to `main` makes `release.yml` run `npm test`, build, and republish the bundle on
  the moving `latest` prerelease.
- At every service start, `deploy/update.sh` fetches the newest `main` build (at most once per
  10 minutes), checks the Pi's `config.json` with the new build's `check-config.js`, and swaps
  it in. A refused build is remembered in `/var/lib/lazyto/update-bad`.
- `config.json` never travels by update. Only `npm run push` writes it, from `.env`.

So: code-only change = merge to `main` and restart the service. Config change (new or renamed
field in `src/config.ts`) = `npm run push` first, or every new build is refused.

## Push

Run `npm test` first. Then ask the user before pushing, because the Pi may be serving a live
event.

```bash
npm run push -- --test
```

- `--test` uses `TEST_TOURNAMENT` from `.env` instead of the real event.
- `--dry-run` builds the bundle and installs nothing.
- `--no-auto-update` keeps this exact build; the next plain push turns auto-update back on.
- `--pi-host <name> --user <user>` for another Pi.

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

Status page: `http://relay.local:29473`.

Ports: TCP 29470 Wii requests, UDP 29471 beacon, UDP 29472 Wii logs and beacon requests,
TCP 29473 status page. Older ports (7777-7780, 8080-8083) are stale.

## Cautions

- The Pi beacons on the LAN. Do not run a development relay on the same LAN at the same time.
- Restarts are paced by systemd (10 s rising to 2 min) so a failing start cannot hammer
  start.gg. A restart re-resolves this week's tournament.
- Never print `.env` values, the relay secret, or the start.gg token.
- The user's terminal is Windows PowerShell 5.1. Commands for them must be PowerShell-valid.
