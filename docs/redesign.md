# Redesign: a laptop and a beamer per station

Status: plan, 2026-10-07. Nothing in it has run on hardware. It builds on this branch's beamer
transport and set archive ([beamer.md](beamer.md)) and on the transport bench (branch `bench`,
`docs/bench.md`). When a part lands, [architecture.md](architecture.md) and
[decisions.md](decisions.md) take over from this file for that part.

## Summary

- The relay leaves the Raspberry Pi. It becomes a desktop app on the TO's laptop, for Windows and
  macOS.
- Each Wii reaches the laptop only through a LazyTO beamer in its USB port. LazyTO never uses the
  Wii's own network.
- The beamer holds the station number and the Wii secret. Every SD card is identical.
- The kiosk still pulls: it asks, the beamer forwards, the laptop answers.
- The laptop stays the only thing that writes to start.gg. Replay Reporter and Beamer Manager are
  not part of the night for LazyTO stations.
- The laptop keeps a copy of every replay and packages each finished set as a zip with a
  `context.json` for Lucky Stats.
- A beamer erases the replays the laptop has verified, at its next power-on.

```
Wii: kiosk ─EXI─► LazyTO Nintendont kernel          (Network off; LazyTO uses no IOS sockets)
        │ USB: one drive. .slp files on its FAT, and the RAM mailbox past the partition
Beamer: LazyTO firmware (fork PranavMin/slippi-beamer, LAZYTO = true)
        │   holds: station number (flash), secret (config.txt), Wi-Fi settings (config.txt)
        │ Wi-Fi, the TO's own router
Laptop: LazyTO app = Electron shell + the relay core (src/, unchanged in shape)
        ├─► start.gg: start, stream, per-game scores, end   (the only writer)
        ├─► Documents/LazyTO: raw replays, one zip per finished set
        └─► the TO drags the zips into Lucky Stats after the event
```

## Decisions (2026-10-07)

| # | Decision | Why |
|---|----------|-----|
| D1 | The Pi is retired. LazyTO is a desktop app for Windows and macOS. | A TO already brings a laptop; a Pi is one more box to set up, power and update. |
| D2 | The Wii's only link is the beamer. LazyTO deletes every IOS-socket path from the kernel. | Wii Wi-Fi is 802.11g. One boot in four failed to join in the first hardware test, and every Wii needs a System Menu profile or a LAN adapter. The beamer is already on the Wi-Fi for replays. |
| D3 | The station number lives on the beamer. SD cards carry no station file and no secret, so every card is identical. | One card zip for every Wii. The station is the dongle at the table. |
| D4 | The kiosk keeps pulling. | The laptop stays the one claim authority, so a set appears on only one station (F6). The beamer opens no new endpoint, and the kiosk's request flow does not change. |
| D5 | LazyTO stays the only start.gg writer for its stations. Replay Reporter is not used for them. | Replay Reporter cannot report on its own: a person picks the set, drags each port and confirms. Its winner is whoever won more than half the selected replays, with no best-of check. On a set already completed it falls back to `updateBracketSet` and overwrites the games. It sends no per-game score without a winner, so N1 would be lost. |
| D6 | The laptop writes the per-set zips (Replay Reporter's format) for Lucky Stats. | This is the set archive already on this branch. |
| D7 | A beamer erases replays once the laptop has verified them. It does that at its next cold boot, never while a Wii holds the drive. | See [Self-erase](#self-erase). |
| D8 | The work happens in the fork `PranavMin/slippi-beamer`, behind `LAZYTO = true`, and is kept upstreamable. A combined suite with jendotpg (Beamer Manager) is possible later. | Upstream has one author and has never had a pull request. A thin, opt-in fork merges cheaply. |
| D9 | Melee singles only. The stream station uses a capture card. Slippi console mirroring stays possible but optional. | Mirroring is independent of LazyTO's code (see [The Wii side](#the-wii-side)). |

## The Wii side

### What goes

LazyTO stops using the Wii's network. From `kernel/RelayEXI.c` (Nintendont branch `beamer`):

- the TCP round trip, the beacon listener and beacon request, and the UDP telemetry socket;
- the `transport=` key, every `cfg.beamer ?` branch and the `NetworkStarted` dependencies;
- `lazyto_station.txt` and its parser. After this the kernel parses no strings at all.

The poll flags `PF_NO_NETWORK`, `PF_NO_CFG`, `PF_NO_SECRET` and `PF_NET_JOINING` are retired from
`protocol.yaml`. The kiosk drops `TM_JOIN_FRAMES`, `hostNoNetwork`, `hostNetJoining`, `hostNoCard`
and their texts.

The mailbox path stays as it is: the EXI hooks, `beamerMailbox`, `serviceBeamer`,
`beamerRoundTrip`, the USB lock and mount id, mailbox telemetry and the crash mailbox.

### What stays, for Slippi

`net.c NetworkInitAsync` and Slippi's own threads stay untouched. Slippi's console mirroring
server (`SlippiNetwork.c`, TCP 51441) shares only `top_fd` and `NetworkStarted` with `net.c`, and
the beamer path never reads either one. So the loader's Network option now means "Slippi mirroring"
and nothing else. It defaults to off. A venue that wants mirroring turns it on in the loader menu,
on the Wii's Wi-Fi or with a LAN adapter in the second USB port. The kernel's storage probe skips
the AX88772 LAN adapter, so that layout is supported. It is untested with a beamer.

Removing `NetworkInitAsync` would bring back the boot hang at "Slippi network init" on any Wii with
Network on. Keep it.

### The SD card

One zip for every Wii (`src/cards.ts`): `apps/LazyTO`, `lazyto_kiosk.bin`, `lazyto_nincfg.bin` and
the READMEs. No `lazyto_station.txt`.

The loader settings change from `NIN_CFG_NETWORK | NIN_CFG_AUTO_BOOT` to
`NIN_CFG_SLIPPI_REPLAYS | NIN_CFG_AUTO_BOOT`, with UseUSB 0 and the game on SD:

- USB, the hotswap re-probe and `RelayEXIInit`'s mailbox all start only with replays on and the
  game on SD (`kernel/main.c:193-203`, `RelayEXI.c:1262`).
- Today's cards set Network and not replays, so they record nothing and cannot use a beamer.

Rule for the venue: exactly one mass-storage device per Wii, the beamer. With two, IOS enumeration
order decides which one gets the replays and the mailbox, and the kiosk shows "no beamer".

## The Wii-beamer protocol (mailbox v2)

The mailbox on this branch has four parts: a `beamer_hello` the beamer writes, a request sector,
response sectors and a telemetry sector. It works, but none of the beamer's state reaches the
kiosk. The kiosk never reads `PF_NO_BEAMER` and the kernel never passes on `BF_WIFI`, so a missing
beamer or a beamer off the Wi-Fi shows "NO RELAY FOUND". Version 2 fixes that and moves the
station and secret.

### `beamer_hello` v2 (24 to 32 bytes, still one sector)

| Field | Meaning |
|-------|---------|
| flags | `BF_WIFI`, `BF_RELAY` (as now), `BF_STATION_SET`, `BF_SECRET` |
| station | the number saved on the beamer; meaningful only with `BF_STATION_SET` |
| wifi | `UP`, `JOINING`, `NO_SSID`, `CANT_JOIN`, `NO_ADDRESS`, `RADIO`, from the firmware's Wi-Fi states |
| storage | `OK`, `NO_CARD`, `UNREADABLE`, `WRITE_FAILED`, `WRONG_FORMAT`, `FILLING`, `FULL`, from its error and warning labels |
| last_result | the last round trip's `beamer_result` |
| beacon_age_s | seconds since the relay's beacon was last heard |
| fw_build | the LazyTO firmware build, so a new kernel can say "update the beamer" |

Every new field reads 0 as "fine or unknown", so the Dolphin development forwarder keeps working
with zeros.

### Station and secret

- **Station.** The kernel stamps `relay_hdr.station` and `telemetry_hdr.station` from the latest
  valid hello, as it stamps them from the card file today. Without `BF_STATION_SET` it sets
  `PF_NO_STATION` and sends nothing. "Unset" is a flag, not station 0, because Dolphin is
  legitimately station 0 (R10).
- **Secret.** It moves to the beamer's `CONFIG/config.txt` (`LAZYTO-SECRET`, next to `SSID`,
  `PASSWORD` and `LAZYTO`). The beamer puts `relay_auth` in front of each request and telemetry
  datagram it forwards. The Wii never holds it, so `beamer_req_hdr` and `beamer_tele_hdr` are
  followed by `relay_hdr` with no auth in front. No HTTP route serves config files, and `/status`
  must not show the secret.
- **Who stamps what.** The kernel owns the protocol bytes; the beamer adds only the 20-byte
  `relay_auth`. The beamer needs to know nothing else about LazyTO's protocol beyond the beacon.

### The beamer stays a pipe

- The fork's `relay.rs` rejects any beacon whose version is not `RELAY_PROTO_VERSION`. Dongles have
  no over-the-air update, so every protocol bump would mean re-flashing every dongle by hand. The
  beacon check becomes magic and length only. Only `relay_auth`'s layout and the beacon stay frozen.
- The kernel gates on `fw_build` for anything the firmware must support.

### What the kiosk shows

The kernel copies the hello's enums into `exi_poll_hdr` on every poll, together with a `last_fail`
code: its own USB failures, or the `BR_*` result passed through. Today every one of those collapses
into `RELAY_ERROR` with a zeroed buffer. The kiosk picks a literal by code; nothing is parsed.

| Kiosk today | New cause |
|-------------|-----------|
| NETWORK IS OFF IN THE LOADER | `PF_NO_BEAMER` with a reason: replays off in the loader, no drive, not a LazyTO beamer (plain stick or `LAZYTO` off), old firmware |
| JOINING THE WI-FI / THIS WII COULD NOT JOIN THE WI-FI | the beamer's `wifi`: joining (keep the 60 s wait), no SSID, can't join, no address, radio |
| NO STATION FILE ON THE CARD / NO SECRET IN THE STATION FILE / THIS CARD IS NOT SET UP | `PF_NO_STATION` (THIS BEAMER HAS NO STATION NUMBER, press its button; a wait that clears by itself) and `PF_NO_SECRET` (the beamer's `config.txt` has no secret) |
| LOOKING FOR THE RELAY / NO RELAY FOUND | beamer on Wi-Fi without `BF_RELAY`, or a stale beacon: BEAMER HEARS NO RELAY / IS THE LAPTOP ON THIS WI-FI? |
| NO LINK TO THE RELAY | `last_fail`: USB read or write failed, no answer within 3 s, `BR_CONNECT` (laptop unreachable or firewalled), `BR_TIMEOUT`; `BR_TOO_LARGE`/`BR_BAD_REQ` mean a bug: TELL THE TO |
| TIMEOUT - RELAY NOT ANSWERING | a USB cycle stalled (writer or SD card); shown with the storage state |
| RELAY SECRET MISMATCH | unchanged (`ST_BAD_SECRET`); the hint names the beamer |
| THE RELAY SAID NO | unchanged, plus a new relay status `ST_DUP_STATION`: TWO BEAMERS ARE STATION n |
| new | a CSS warning when the beamer's storage is faulty or full: REPLAYS NOT SAVING |

Check order on the search screen: no beamer, old firmware, no number, no secret, beamer off the
Wi-Fi, no relay.

Kiosk text limits apply: `fail()` strings are at most 30 characters, each line must encode in
under 128 bytes for `HSD_SisLib` (a space after a letter costs 7), pane labels about 10
characters, no underscore in the font. Merge `main` first: this branch still has the four
overlong hints that c08fe9f fixed.

`exi_poll_hdr` grows (these fields plus the replay fields under [Replays](#replays-and-the-set-archive)),
so `MAX_SETS` drops from 56 to 55. Use the protocol-change skill.

### Other mailbox fixes

- **Bound the kernel's USB lock wait.** `__usb_lock` waits forever today, and a beamer can hold one
  host write for up to 30 s while it recovers an SD card. The relay thread must give up within the
  request's remaining budget.
- **Keep a TCP slot for the kiosk.** The beamer has two active TCP connections (`LWIP_MAX_ACTIVE_TCP
  = 2`). Replay downloads can hold both exactly when the kiosk sends the score at game end
  (`BR_CONNECT`). In LazyTO mode, cap the beamer's HTTP server at one socket.
- **Refuse `POST /reset-beamer` in LazyTO mode.** It withdraws the medium under a mounted Wii (see
  [Self-erase](#self-erase)), and it has no authentication.

## Station identity on the beamer

- **Storage.** The number is saved in the beamer's flash, in NVS, and set with its button. Today it
  lives only in RAM and resets to 1 at every boot (`src/name.rs`, `boot.rs:72`). A write happens
  2-3 s after the last button press, only if the number changed. `config.txt` is not an option:
  the firmware may not write the FAT while a Wii holds the drive.
- **Unset.** A new or wiped beamer starts unset, never at 1. Otherwise every fresh beamer is
  "Station 1" and they collide. The screen says "No station", requests are refused locally with a
  new `BR_NO_STATION`, and telemetry is dropped. The first press sets 1.
- **Reflashing.** The merged `beamer.bin` written at 0x0 probably erases NVS at 0x9000 (inferred).
  The app's flasher writes the bootloader, partition table and app separately, so the number and
  the acks survive a firmware update.
- **Stray presses.** Once the number is the station's identity, one stray press renumbers it. In
  LazyTO mode a press only shows the number; holding the button edits it.
- **Duplicates.** The relay sees every request and telemetry datagram arrive from the beamer's IP,
  and each beamer's `station_id` (from its MAC) in its announces and `/status`. Two `station_id`s
  on one number within about 15 s is a duplicate. The status page names both beamers, and the
  newcomer's kiosk gets `ST_DUP_STATION` until one is renumbered. The beamer already holding the
  station's set keeps playing.
- **Moves and swaps.** The station follows the beamer, by design. A beamer replaced mid-event starts
  unset; once the TO sets its number, the status page notes the change. The relay records which
  `station_id` recorded each set and game, and fetches replays from that beamer, never from
  "whoever is station N now".

Upstream (jendotpg) moved the number from `config.txt` to the button on 2026-09-17 so dongles are
interchangeable per-table labels. Persisting it stays LazyTO-mode-only unless upstream wants an
opt-in.

## Replays and the set archive

### Collection

The relay pulls replays from each beamer over HTTP, as it does on this branch. Beamer Manager is
not run. Changes:

- **Download every replay.** That includes friendlies, handwarmers and unmatched games. Raw
  originals go to the archive folder. Today the archive keeps only set-bound replays and drops the
  `.raw` copies; self-erase needs a verified copy of everything.
- **Serve any file.** The beamer must serve any finished file by name. Today it serves only this
  boot's newest 16 or fewer, so older replays could never be fetched, acknowledged or erased.
- **Bind beamers by `station_id`.** Today the binding comes from the announced "Station N" name,
  which breaks after a power blip. The persisted number fixes the name; `station_id` makes it
  exact.

### Matching a replay to its game

The bench archive matches each replay to the earliest unmatched `CMD_GAME_START` with the same
ports, characters, costumes and stage. Replace that with the replay's own id:

- The kernel names every replay `Game_<MAC>_<start time>.slp` from one variable, `gameStartTime`
  (`SlippiFileWriter.c`). It publishes that value and a counter of files opened in `exi_poll_hdr`.
- The kiosk reads the counter when it leaves the CSS and again on its first frame back. If the
  counter moved by one, that match's replay id is the start time; otherwise 0 means "not recorded".
- Hand scoring and undo:
  - A hand-scored game takes the newest unused, non-handwarmer match of the set.
  - Undo frees it again.
- `game_result` grows from 8 to 16 bytes, adding both ports and `replay_id`. `PROTO_VERSION` goes
  to 2.

Results:

- `CMD_GAME_START` goes away, and with it the fire-and-forget request that can make the kernel drop
  the next score report on a very short game.
- Handwarmers and friendlies never appear in a game list, so their files are never referenced.
- A grand final and its reset with the same characters on the same stage are no longer ambiguous.
- A game reported with `replay_id` 0 is flagged on the status page while the players are still at
  the setup.
- The content check (stage, characters, costumes, stocks) stays, as a check that flags mismatches,
  not a second matcher.

### The zip and Lucky Stats

- **The zip.** The archive already writes Replay Reporter's layout: a flat zip with `context.json`
  first, then `<n> - <players and characters> - <stage>.slp`, with the tags written into each
  replay's display-name fields. Its `context.json` already carries Replay Reporter's keys. Known
  differences: `bestOf` comes from the set (Replay Reporter derives it from the winner's game
  count), and `prefixes`, `pronouns`, `ordinal` and `stream` are blank.
- **Where zips go.** A visible folder the TO chooses (default `Documents/LazyTO`). Never Replay
  Reporter's copy folder, which treats every zip there as a set it reported.
- **Upload.** Lucky Stats (luckystats.gg) takes uploads only in its web page, "Import Tournament Game
  Data". The uploader logs in with start.gg OAuth and must be an admin of the tournament. Lucky
  Stats must already have imported the tournament; it imports on a schedule, and "Submit
  Tournaments" runs every 6 hours. There is no API.
- **Server rules.** They are not public. The client shows three errors: `set_not_found`,
  `context_event_mismatch` and `game_count_mismatch`. The last means a set with a hand-scored game
  that has no replay will probably be rejected.
- **Before relying on it:** upload one archive zip as a test, or ask Lucky 7s which fields they
  read.

## Self-erase

### When the beamer may write its card

- **Two sanctioned moments.** Upstream writes the FAT only at boot, before the USB bind, and after
  a host ejects the drive. The Wii never ejects.
- **`/reset-beamer` is unsafe under a Wii.** It withdraws the medium for the wipe. The LazyTO
  kernel never notices a withdrawal, because no device-change event fires. Its FatFs cache goes
  stale, the replay being written is lost, and a stale FAT sector can be written back over the
  beamer's changes. The mailbox is down for the whole wipe.

### What it does

1. **At a cold boot only, before the USB bind.** That is the first boot since power was applied.
   Warm restarts (reload, panic, watchdog) can happen while a Wii is mounted, so they never erase.
2. **Only files the beamer itself has checked.** The laptop stores each original: temp file,
   fsync, rename, re-read, SHA-256. The beamer re-hashes its own copy in idle time with the
   ESP32-S3's SHA hardware, and records an ack only if both hashes match. Before deleting, it
   re-checks size and modified time. A file still being written has size 0 in its directory entry
   (Nintendont never syncs it), so it can never match.
3. **The beamer pulls the acks.** While its station is idle, it sends a sync request over its
   existing outbound connection to the relay: its `station_id` and a page of (name, size, modified
   time) for unverified files. The relay answers each entry with "held" plus the SHA-256, or
   "wanted", and then downloads the file. The request carries the secret like any other. The beamer
   opens no new endpoint, and the same request carries the beamer's status to the laptop.
4. **Acks are stored in NVS.** They use their own namespace in the 64 KB `jrnl` partition (worst
   case 512 records), not the shared 24 KB one.
5. **Erasing has a time budget.** It is estimated at 50-150 ms per file, about 2-12 s for a night.
   Budget about 10 s per boot, show ERASING on the screen, and carry the rest to the next cold
   boot.

### Capacity

Replays run about 4-7 MB per singles game. `REPLAY-CAP` (at most 512) binds before the 4 GB
partition does. A night is roughly 30-80 replays, so with erase at the next power-on the card holds
about one night.

## The laptop app

### Shape

- **A thin Electron shell around the relay core.** The core stays in `src/` with no framework and no
  runtime dependencies, and `npm test` stays as it is. The shell lives in `desktop/` with its own
  `package.json` and holds no relay logic.
- **Why Electron.** A future suite with Beamer Manager (also Electron) stays a merge, not a rewrite.
  A Node single executable needs an outside supervisor, and flashing would then need Chrome.
- **The core.** It runs in an Electron `utilityProcess` through the existing seam: `new App({dataDir,
  …})`. If it exits, the shell restarts it with the systemd unit's backoff, and claims come back
  from the audit log.
- **The window.** A `BrowserWindow` shows the existing pages on `http://localhost:29473`. The shell
  handles the `login` event for the status page's Basic auth, and shows the first-run setup code,
  which today only goes to the console.
- **One copy.** A single-instance lock keeps two copies from fighting over the ports.
- **One LazyTO per network.** The relay listens for other relays' beacons and refuses to start its
  event if it hears one. Two relays would split the stations, because each station follows the
  last beacon it heard.

### Platform work

- **Data.** Settings and audit logs go in `userData` (`%APPDATA%\LazyTO`,
  `~/Library/Application Support/LazyTO`). Archives and raw replays go in the visible folder.
- **Windows firewall.**
  - The first listen prompts. A non-admin user gets block rules, and the allow may cover only
    Private networks, while Windows 11 puts a new network in Public.
  - The installer (or a one-time elevated button) adds a rule for the app's exe: `profile=any`,
    `remoteip=localsubnet`.
  - The status page warns when beacons go out but no station has made contact.
- **macOS Local Network privacy.**
  - Sending the beacon, receiving beacon requests and announces, and pulling replays all need the
    permission. Listening for TCP does not.
  - Running from Terminal is exempt, so test the packaged app.
  - The permission is tracked by code signature, so the app needs a proper signature.
  - The shell triggers the prompt during setup, not at the venue.
- **Keep-awake.** `powerSaveBlocker` with `prevent-display-sleep` while an event runs. Nothing stops
  lid-close or power-button sleep, so the night-of rule is: AC power, lid open, wired to the router.
- **Multicast.** Join the beamer group once per interface. Without one, the OS may pick a Hyper-V,
  WSL or VPN adapter.
- **Updates.**
  - electron-updater replaces `deploy/update.sh` and keeps the same channels: release, main (semver
    prereleases such as `0.9.1-main.N`) and off.
  - It downloads in the background and installs only from "Restart to update", which is refused
    while any station is mid-set.
  - The optional-settings-field rule replaces `check-config.js`.
  - macOS auto-update needs a signed app.
- **Signing.**
  - macOS: Apple Developer Program, 99 USD a year (Developer ID and notarization).
  - Windows: Azure Artifact Signing (9.99 USD a month, individuals in the US and Canada), or accept
    SmartScreen's "Run anyway" at first.
- **Shipped files.**
  - The Wii files (`wii/**`) and the pinned beamer firmware go in `extraResources`. The firmware is
    pinned in `release.yml` with its SHA-256, like Nintendont.
  - The app flashes beamers with esptool-js over Web Serial: hold the button while plugging in.
  - Plugged into the laptop, a beamer is a drive, so the app writes its `CONFIG/config.txt` (SSID,
    PASSWORD, `LAZYTO = true`, the secret) with no native code.
- **CI.** Windows and macOS builds, copying Beamer Manager's matrix. Tests run on the Node version
  Electron ships (Electron 44 ships Node 24.20), not only Node 22.

### What it replaces

`deploy/` (install, update, systemd unit, add-wifi, uninstall), `docs/pi-setup.md`, the pi-deploy
skill, the install.sh release asset and the shellcheck step. `CLAUDE.md`'s "Node 22, TypeScript,
no framework" becomes: relay core with no framework and no runtime dependencies, plus a thin
Electron shell in `desktop/`. "Never stalls a Pi" becomes "a laptop".

## Status page additions

- **Beamers.** One row per beamer:
  - `station_id`, number, firmware build;
  - Wi-Fi state and signal;
  - storage state;
  - replays held, verified and waiting to erase;
  - last round-trip result;
  - the duplicate banner.
  This arrives in the beamer's sync request, so no polling is needed.
- **Missing replays.** A per-set line listing reported games without a replay.
- **Network.** The OS network profile and a "no station has made contact" warning.

## Fixes found along the way

These hold whatever happens to the redesign:

- **Cards record no replays.** `src/cards.ts:47` does not turn on Slippi replays. Recording with the
  kiosk module loaded has also never run on hardware.
- **A Wii reboot mid-set loses games (N3).** The kiosk resumes at 0-0, and its next report
  overwrites the earlier games on start.gg. The resume reply should return the claim's games.
- **Stale docs.** `docs/architecture.md` still describes `CMD_ABANDON_SET`, which the relay no
  longer handles.
- **Licence.** The firmware fork (MIT, built with Apache-2.0 ESP-IDF) contains the generated
  `relay_proto.h`, and this repo is GPL-2.0-only. The generated protocol headers need an MIT or
  dual licence before fork binaries ship or anything goes upstream.
- **CSW status ignored.** Nintendont's USB driver ignores the CSW status byte and detects only
  stalls. It's upstream code; noted.

## Plan

Each phase leaves a working system. Phases 2 and 3 do not depend on each other.

1. **One-beamer bench (now: one beamer in hand).**
   - Merge `main` into this branch.
   - Flash the fork and run `tools/lazyto_host.py`.
   - Then on a Wii, with a card that has replays on and the game on SD:
     - list, a full set, 20 games;
     - power cycles;
     - a score sent while a replay is downloading.
   - Measure:
     - round-trip p95 and `BR_CONNECT` at game end;
     - replay integrity;
     - the beamer's boot time and erase time per file;
     - whether the Wii cuts USB power on reboot, IOS reload, standby and off.
   - This also proves .slp recording with the module loaded.
2. **Beamer-only Wii.**
   - Mailbox v2: the status record, station and secret on the beamer, NVS, `PF_NO_STATION` and
     `PF_NO_SECRET`, `last_fail`.
   - Firmware: the beacon check decoupled from `PROTO_VERSION`, HTTP capped at one socket in LazyTO
     mode, `/reset-beamer` refused, the button guard.
   - Kernel: delete the network path; bound the USB lock.
   - Kiosk: the texts above. One identical card zip.
3. **The laptop app.** `desktop/` shell, data folder, firewall, Local Network, keep-awake, updater,
   flashing and beamer provisioning. Then retire the Pi.
4. **Replays.** Replay ids instead of `CMD_GAME_START`, a raw copy of every replay, ack sync and
   cold-boot erase, the N3 resume fix, a test upload to Lucky Stats.
5. **A full night.** When more beamers arrive: duplicate detection, a 12-station load run
   (`scripts/sim-wii.ts` against a beamer impersonator), the router setup in `night-of.md`.

## Open questions

1. **Apple Developer Program (99 USD/yr) for macOS?** Without it, there is no macOS auto-update,
   Local Network permission is unreliable, and every TO goes through Privacy & Security > Open
   Anyway.
2. **Windows signing.** Azure Artifact Signing, or accept SmartScreen at first? May the installer
   ask for admin once for the firewall rule?
3. **Erasing at the next power-on.** Is that acceptable? Same-night erase needs a kernel handshake
   on the replay path. Do the event Wiis keep USB powered between events (WiiConnect24 standby)?
   If so, a beamer never cold-boots and never erases.
4. **Raw replays.** How long does the laptop keep raw copies of every replay, once verified and
   erased from the beamer?
5. **Missing replays.** A set with a reported game that has no replay: zip it anyway, or skip it
   for Lucky Stats?
6. **Duplicate station numbers.** Refuse only the newcomer (proposed), or both?
7. **The button.** In LazyTO mode, hold to edit and a press only shows the number?
8. **Licence.** Relicense the generated protocol headers as MIT or dual?
9. **Upstream.** Persist the number only in LazyTO mode, or offer jendotpg an opt-in key?
10. **Minimum OS versions and builds.** macOS 13+ or 15+? Windows 10 and 11, or 11 only?
    Universal (arm64 + x64) mac builds?
11. **Update channels.** Keep a `main` channel in the app for testing builds?

## Docs to revise as parts land

- `decisions.md`:
  - Relay on the LAN; Set up from a browser; One bundle, two update channels; One config file per
    Wii; SD cards from the relay.
  - R9 (moot without the Wii's sockets), R15 (the beacon's consumer is the beamer), R16 (the secret
    lives on the beamer).
  - A new entry on matching replays by their own id.
- `architecture.md`: components, EXI contract, deployment, network, error table.
- `night-of.md`: the router, laptop rules, beamer numbering.
- `wii-setup.md`: replays on, game on SD, one card for every Wii.
- `beamer.md`: folds into `architecture.md`.
- `pi-setup.md`: deleted.
- `CLAUDE.md`, as above.
