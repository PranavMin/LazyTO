---
name: wii-test
description: Get a kiosk or loader build onto a real Wii and debug it there - CI loader, SD card sync, wiiload over Wi-Fi, and the order to read logs in. Use for hardware tests and any "works in Dolphin, not on the Wii" report.
---

# Test on a real Wii

Every hardware trip costs the user a card shuffle. Read logs before theorising, and batch
changes so one card carries them.

## Before the test

1. Build the module with the `kiosk-build` skill, without `--demo`; `sync-card` refuses a
   `DEMO` module.
2. If the kernel or loader changed, start a CI loader build. A locally built loader fails on
   hardware at "Preparing IOS58 Kernel".
   ```bash
   gh workflow run build.yml -R PranavMin/Nintendont --ref LazyTO
   ```
   Wait for it with `gh run list -R PranavMin/Nintendont --branch LazyTO --limit 1`.
3. Decide which relay the Wii should find. The Pi beacons on the LAN on UDP 29471. Never run a
   development relay on the same LAN at the same time, or the Wii may pair with either.

## Put the build on the Wii

SD card (the user inserts it; ask first):

```bash
npm run sync-card -- --station 1 --stream 0
```

Flags: `--drive F` (or a mount path), `--relay-config <config.json>` to take the secret from a
dev relay, `--module <file>`, `--no-eject`, `--no-log`. It downloads the newest successful CI
loader, copies the module, writes `tournament.cfg` with the secret from `.env`, hash-checks,
and ejects. Never print the secret.

Loader only, over Wi-Fi, while the Wii sits in the Homebrew Channel:

```bash
npm run wiiload -- --wii <ip>
```

The card still supplies the module, config and game.

## Debug order

1. Relay status page, **Wii consoles** table (`http://relay.local:29473` for the Pi).
2. `/log?station=N` on the status page, or `wii-station-N.log` in the relay's audit folder.
3. Only if the Wii never reports: `slippi_ndebug.log` on the SD card (Log on in the loader).
4. Crash address: `python kiosk/tools/resolve_crash.py <address>`.

For "works in Dolphin, not on the Wii", suspect a boot-environment difference first (low
memory words such as BootInfo `0x80000034`, Slippi core gecko codes, cache coherency between
the ARM kernel and the PPC) before game logic.

Known hardware-only failures, so you do not rediscover them:

- No relay found on Wi-Fi: some routers drop broadcasts to the Wii. The kernel's beacon
  request leg (UDP 29472) covers it. One boot in four the Wii's Wi-Fi never associates;
  a power cycle fixes it.
- Auto Boot black screen: FatFS reentrancy from kernel logging. Never add a waiting lock in
  `kernel/vsprintf.c`; a dropped SD log line is acceptable.

## After the test

Add a row to `docs/kiosk-checklist.md` for every new hardware bug found and fixed.
