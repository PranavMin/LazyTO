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
- Only set games are recorded. Friendlies and handwarmers leave no replay.
- The laptop collects every recorded replay and packages each finished set as a zip with a
  `context.json` for Lucky Stats. A set with a game that has no replay is skipped.
- A beamer erases the replays the laptop has verified, at its next power-on.
- The app is built and shipped like Replay Reporter: Electron, no paid signing.

```
Wii: kiosk ─EXI─► LazyTO Nintendont kernel          (Network off; LazyTO uses no IOS sockets)
        │ USB: one drive. .slp files on its FAT, and the RAM mailbox past the partition
Beamer: LazyTO firmware (fork PranavMin/slippi-beamer, LAZYTO = true)
        │   holds: station number (flash), secret (config.txt), Wi-Fi settings (config.txt)
        │ Wi-Fi, the TO's own router
Laptop: LazyTO app = Electron shell + the relay core (src/, unchanged in shape)
        ├─► start.gg: start, stream, per-game scores, end   (the only writer)
        ├─► the archive folder: raw replays, one zip per finished set
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
| D10 | Only set games are recorded. Friendlies, handwarmers and anything outside a set leave no replay. | Only set replays are wanted, and the card holds less. See [Recording only set games](#recording-only-set-games). |
| D11 | The app follows Replay Reporter and Beamer Manager: Electron, electron-builder, no paid signing, an update check that links to the release page. | One familiar way to install for TOs, no yearly cost, a possible merge with Beamer Manager later. |
| D12 | A set with a reported game that has no replay gets no Lucky Stats zip. | Lucky Stats probably rejects it (`game_count_mismatch`). |

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
characters, no underscore in the font.

`exi_poll_hdr` grows by these fields, so `MAX_SETS` drops from 56 to 55. The replay id does not
travel here; it comes from the record gate (see [Recording only set games](#recording-only-set-games)).
Use the protocol-change skill.

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

- **Storage.** The number is set with the button and saved in the beamer's flash: the `lazyto`
  namespace of the `jrnl` NVS partition, next to the acks (see [Self-erase](#self-erase)). Today it
  lives only in RAM and resets to 1 at every boot (`src/name.rs`, `boot.rs:72`). A write happens
  2-3 s after the last button press, only if the number changed. `config.txt` is not an option:
  the firmware may not write the FAT while a Wii holds the drive.
- **Unset.** A new or wiped beamer starts unset, never at 1. Otherwise every fresh beamer is
  "Station 1" and they collide. The screen says "No station", requests are refused locally with a
  new `BR_NO_STATION`, and telemetry is dropped. The first press sets 1.
- **Reflashing.** The merged `beamer.bin` written at 0x0 probably pads over the default NVS at
  0x9000 (inferred), which is why the number lives in `jrnl`. The app's flasher also writes around
  NVS and never erases the whole chip, so the number and the acks survive a firmware update.
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

## Recording only set games

Only a match the kiosk starts as a game of the current set is recorded. Friendlies, handwarmers,
Sudden Death, training, 1P modes, title demos and anything played from the vanilla main menu leave
no file on the beamer. Slippi's memory ring and console mirroring are untouched: a mirroring PC
still receives every match.

- **When the kiosk decides.** A new hook on the VS scene's on_enter (`ptr 0x803DA950
  lbTourney_MatchEnter`, wrapping vanilla `gm_Scene_Vs_OnEnter`).
  - Slippi's Game Start is sent from inside that function (`StartMelee`, the `g_core.bin`
    injection at 0x8016E74C). The PPC waits until the kernel has taken the transfer, so the choice
    is in place at exactly that moment.
  - CSS exit is too early (it also fires on B), and the first VS frame is too late.
  - It records when there is a current set, the game is not a handwarmer, and the loader supports
    the gate (`host_build`).
  - To record, it sets `want = RECORD_THIS_MATCH` in the shared slot, calls the vanilla on_enter,
    then clears `want`. The word matters only at the instant of the Game Start transfer, so it is
    safe to change at any other time.
- **The shared slot** (`protocol.yaml` `record_gate`): 64 bytes of MEM2 at PPC 0xD3003200 (ARM
  0x13003200). It is free as far as the code shows; confirm on hardware.
  - Line 0, written by the PPC: `want`.
  - Line 1, written by the kernel:
    - `start_seq`: Game Starts since boot;
    - `file_seq`: the `start_seq` of the last match a file was opened for;
    - `file_id`: that file's `gameStartTime`.
  - A PPC-written field and a kernel-written field never share a 32-byte cache line. The kernel
    reads with `sync_before_read`, and the kiosk uses u32 loads and stores only.
- **The kernel holds the choice at Game Start.**
  - In `SlippiMemoryWrite`'s RECEIVE_COMMANDS branch (the EXI DMA handler), it stores `{ring
    cursor, record, seq}` in a small table. That costs one cache-line read and a few stores, with no
    lock and no wait.
  - `record` is true when the kiosk asked, or when no kiosk module is loaded. Plain Slippi
    Nintendont records everything, as today.
- **The writer** (`SlippiFileWriter.c`):
  - On a new match, it looks up the stored choice for that cursor.
    - Skip: no `f_open`.
    - Record: it opens the file as now, then publishes `(seq, gameStartTime)` to line 1.
    - A cursor missing from the table records, and logs it.
  - Skipped matches drain in the same cycle. Today the skip path moves one 4 KB chunk per 100 ms. A
    long 4-player friendly could overflow the ring, and the recovery jumps past the start of the
    next set game.
  - A match that never sent Game End (a soft reset, training): finish the open file and resume at
    the next match's start. Today every such error jumps to the write cursor and loses the next
    match too.
- **The kiosk gets the replay id directly.**
  - It keeps `match_seq` from VS enter. At VS exit, `replay_id = (file_seq == match_seq) ? file_id :
    0`.
  - 0 means no file was opened: no beamer, replays off, or a stalled writer.
- **Leaving the set list leaves the set.** `exitToMainMenu` calls `lbTourney_ClearCurrent()`. Today
  a VS match started from the vanilla main menu after B is auto-scored into the set, and would be
  recorded.
- **Dolphin** has no MEM2 gate. `host_build` is 0 there, so the kiosk never touches 0xD3xxxxxx, and
  development runs get `replay_id` 0.

## Replays and the set archive

### Matching a replay to its game

The bench archive matches each replay to the earliest unmatched `CMD_GAME_START` with the same
ports, characters, costumes and stage. The replay id replaces that:

- `game_result` grows from 8 to 16 bytes, adding both ports and `replay_id`. `PROTO_VERSION` goes
  to 2.
- The relay finds the file as `Game_<Wii MAC>_<replay_id as UTC YYYYMMDDTHHMMSS>.slp` on the beamer
  (`station_id`) the set was played through.
- Hand scoring takes the id of the set's last match, if that match was recorded and its id is
  unused; otherwise 0. Undo frees the id. A handwarmer that turned into a real game has no file,
  so it gets 0, never an older no-contest's replay.

Results:

- `CMD_GAME_START` goes away, and with it the fire-and-forget request that can make the kernel drop
  the next score report on a very short game.
- A game reported with `replay_id` 0 is flagged on the status page while the players are still at
  the setup.
- The content check (stage, characters, costumes, stocks) stays, as a check that flags mismatches.
- Gating ships together with replay ids. On its own it would break today's matcher: game 1's
  replay would bind to the unrecorded handwarmer's game start.

### Collection

The relay collects replays from each beamer over HTTP. Beamer Manager is not run.

- **Collect every file on the card.** With set-only recording that means set games, plus rare
  strays (an undone game, a no-contest). A file nobody collects can never be erased.
- **Downloads follow the beamer's sync** (see [Self-erase](#self-erase)).
  - The relay downloads the files the sync lists as wanted: one at a time per beamer, resumed with
    `X-Replay-From`, after a free-disk check.
  - That replaces the archive's 5 s index poll and the multicast announces. The relay learns each
    beamer's address from its sync.
- **The beamer serves any file by name.** Today it serves only this boot's newest 16 or fewer.
- **Raw store.** `<archive>/raw/<station_id>/<name>`.
  - A second file with the same name and a different hash is stored as `<stem>~<sha8>.slp`.
  - `archive.json` (a random `archive_id`) and `index.jsonl` live in the archive folder, so a
    reinstalled app finds them.
  - The archive stops deleting raw files when it finalizes a set.
- **Late arrivals.** A replay that arrives later, even at the next event, regenerates its set's zip.

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
- **Sets with a missing replay are skipped.** A set with a reported game that has no replay gets no
  zip; the status page lists it. Its raw replays stay on the laptop.
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

1. **Only at a cold boot, before the USB bind.**
   - Cold means a power-on reset and the first boot since power was applied.
   - Panic, watchdog, brownout, reload and post-flash resets never erase.
   - If the erase itself crashes, the next boot is warm and binds normally.
2. **What it deletes.**
   - 0-byte `Game_*.slp` entries, without an ack. At a cold boot no file can be open, and such an
     entry holds no data (an abandoned recording).
   - Files with a matching ack. The name hash, size, FAT modified time and a CRC32 of the first 1 KB
     are all re-checked, so a reused name (a Wii clock set back) never matches.
3. **How a file gets an ack.**
   - The laptop stores each original: temp file, fsync, rename, re-read, SHA-256.
   - The beamer computes SHA-256 while serving the file. It uses the hardware SHA on the raw bytes
     before gzip, and a resumed request hashes the skipped prefix first. Nothing is re-read at boot
     or when idle.
   - The beamer acks only when the laptop's hash equals its own.
4. **The beamer pulls acks.**
   - When it sends one: when its station has no request pending, after each served file, when it
     finds a new file, and every 30 s.
   - The sync request travels on its relay link and carries:
     - its `station_id`, firmware build, uptime and the cold-boot erase report;
     - counts (on card, waiting to collect, waiting to erase, empty, incomplete) and free space;
     - up to 16 entries (name, size, modified time, class, hash if served this boot);
     - the table's `archive_id` and a random nonce.
   - The reply answers each entry "held" (with the laptop's hash), "wanted" or "noted". It is signed
     with HMAC-SHA256, keyed by the secret, over the nonce, `station_id` and body. Without the
     signature, anyone on the Wi-Fi could download a file, answer "held" with its hash, and make the
     beamer erase replays nobody kept.
   - A different `archive_id` (another laptop, a deleted archive folder) drops every ack, so the
     files are collected again while the beamers are still powered.
   - The sync layout has its own version byte and stays frozen, like the beacon. Dongles have no
     over-the-air update.
5. **Storage on the beamer.**
   - Acks (up to 1024 records) and the station number live in a `lazyto` namespace of the 64 KB
     `jrnl` NVS partition. They do not use the default `nvs` at 0x9000, which a merged-image flash
     pads over.
   - The ack header holds the card id (FAT volume serial and SD CID). A swapped card drops the
     table.
6. **Budget.**
   - About 10 s per cold boot. 0-byte entries go first, and files are unlinked in batches of 8.
   - The LCD shows ERASING n.
   - What doesn't fit waits for the next cold boot.

### Firmware and kernel fixes it needs

- **Live detection.**
  - Nintendont never syncs a file it is writing, so the directory entry stays at size 0 and the
    beamer cannot see a Wii game as live.
  - A file closed with raw length 0 is then treated as live forever, and it freezes the beamer's
    replay scan.
  - In LazyTO mode, live means raw length 0, the newest file, and a host write in the last 30 s.
    Anything else is "incomplete": it is served and synced, and the laptop keeps it as partial.
- **One `f_sync` after the first data block of each recording** (kernel).
  - An interrupted recording then owns its clusters, and the normal erase frees them. Today they
    leak, up to about 7 MB per interrupted game.
  - The scan fix must land first or together.
- **Uncapped inventory.**
  - The beamer counts every file, not just up to `REPLAY-CAP`.
  - FULL means less than 64 MB free, so the next game would fail. FILLING means 384 files or less
    than 1 GB free, with the reason "replug to erase collected replays".
- **WAITING FOR THE BEAMER.** For about 45 s after kernel boot or a USB removal, the kernel reports
  "starting" instead of "no drive". A beamer that is erasing or joining the Wi-Fi then doesn't show
  as missing.

### Edge cases

| Case | What happens |
| --- | --- |
| The TO forgets to unplug; Wii standby keeps the beamer powered | No erase. The next event's status page says "Beamer N not unplugged since \<date\>: X collected replays wait to be erased; replug it between sets". Later FILLING, and at FULL the kiosk shows REPLAYS NOT SAVING. |
| A Wii power cycle mid-event cuts USB power (to be measured) | The beamer erases that day's acked files (up to 10 s) while the Wii reboots, which takes longer. |
| Only the beamer loses power mid-set (bumped, replugged) | The open replay is lost, and a game started during boot and erase is not recorded. The status page flags the missing replay, and that set is skipped for Lucky Stats. The kiosk shows WAITING FOR THE BEAMER without blocking play. |
| Plugged into the laptop to provision or flash | A cold boot erases only acked files. Download mode runs no firmware, and the reset after flashing is not a power-on. |
| Reflashing | The app's flasher writes around NVS and never erases the whole chip, so the station number and acks survive. |
| A different laptop, or a deleted archive folder | New `archive_id`: the acks drop, and files are collected again while the beamers are powered. Files already erased were held by the old laptop. |
| The laptop's disk fails after an ack | The replays are lost after the beamer's next cold boot, like any single copy. Upload the zips soon after the event. |
| A beamer from another venue (another secret) | Its syncs are refused, so nothing new is acked; the status page names it. Once re-provisioned, its old files are collected as unmatched. |
| Erase interrupted by an unplug | Idempotent: the next cold boot carries on. At worst some clusters leak. |
| Unplugged before every replay is collected | Uncollected files have no ack and survive. The next sync collects them and regenerates the zips. |
| The laptop's disk is full, or storing fails | Nothing is held, so nothing is acked or erased. |
| The card is swapped or reformatted | The card id differs, so the acks drop. |

### Night-of

- **Setup:** plug the beamers in, then turn on the Wiis.
- **During the event:** replug a beamer only between sets.
- **End of night:**
  1. Turn the Wiis off. Standby keeps the beamers collecting.
  2. Wait for "All replays collected: safe to unplug beamers" on the status page.
  3. Unplug every beamer, or switch off the Wiis' power strip. That power loss is what makes the next
     power-on erase.

### Later, if needed

- **Same-night erase.** A soft USB detach looks like an unplug to the Wii, which remounts cleanly.
  It is safe only with no replay file open, so it needs a lease from the kernel through the
  mailbox.
- **Erase while the Wii is in standby,** if the bench shows that the USB bus is suspended then.

## The laptop app

It is built and shipped the way Replay Reporter and Beamer Manager are: Electron, electron-builder,
no paid signing.

### What Replay Reporter and Beamer Manager do

- **Builds.** electron-builder makes a universal dmg, a one-click per-user NSIS installer and an
  AppImage.
  - Replay Reporter: Electron 27, 81 MB for Windows, 176 MB for the dmg.
  - Beamer Manager: Electron 44, 114 MB and 231 MB.
- **No paid signing.**
  - macOS: `identity: null`. An `afterPack` script gives the main executable a random Mach-O UUID
    and signs it ad hoc, so macOS's Local Network permission tracks the app.
    `NSLocalNetworkUsageDescription` is set.
  - No notarization, and no Windows signing.
- **Updates.** No auto-update. The app checks GitHub's `releases/latest` and offers a button that
  opens the release page.

### The LazyTO app

- **No template.** The relay core serves its own pages, so there is no React and no bundler.
  - `desktop/` holds one `package.json` (electron 44, electron-builder 26, esptool-js), a `main.ts`
    of about 150 lines, and the flasher page.
  - No native modules.
- **Beamer Manager's electron-builder block, copied**, including the UUID script.
  - `productName: LazyTO`, and an `appId` that never changes.
  - `extraResources`: `wii/**` and the pinned beamer firmware with its SHA-256.
  - The version comes from git tags, as in Beamer Manager.
- **The core runs in the main process**, through the existing seam (`new App({dataDir: userData,
  wiiDir, …})`).
  - That is where Replay Reporter and Beamer Manager do their networking, and the only layout proven
    with the UUID trick. A helper process would carry a different identity on macOS.
  - On an uncaught exception, the app relaunches with the systemd unit's backoff, and claims come
    back from the audit log.
  - If port 29473 is taken, it shows "Another LazyTO, or a Pi relay, is running" and quits.
- **Window.**
  - A sandboxed `BrowserWindow` on `http://127.0.0.1:29473/`.
  - A `login` handler answers the status page's Basic auth, for that origin only.
  - Before setup, the app opens the setup page with the setup code.
  - Closing the window during an event asks first.
- **One copy, one LazyTO per network.** A single-instance lock, and the relay refuses to start its
  event when it hears another relay's beacon.
- **Keep-awake.** `prevent-display-sleep` while an event runs. Closing the lid or pressing the power
  button still sleeps the laptop, so the rule is: AC power, lid open, wired to the router.
- **Updates.**
  - At start and every 6 h, the app checks `releases/latest`.
  - The status page shows "LazyTO vX is out" with a link, disabled while any station holds a set.
    The app never quits on its own.
  - No channels: test builds are CI artifacts.
  - The optional-settings-field rule replaces `check-config.js`.
- **Data.**
  - Settings and audit logs go in `userData`.
  - The archive (zips, raw files, `archive.json`) goes in a folder the TO picks. The default is one
    that is not synced to OneDrive or iCloud: raw files run about 3 GB per event for 12 stations.
- **The beacon** still goes to every interface's broadcast address. Multicast is no longer needed:
  the relay finds beamers by their sync.
- **Flashing and provisioning.**
  - Flashing uses esptool-js over Web Serial in an app window: hold the beamer's button while
    plugging it in. It writes the image around NVS.
  - Plugged in normally, a beamer is a drive, so the app writes its `CONFIG/config.txt`: SSID,
    PASSWORD, `LAZYTO = true`, `LAZYTO-SECRET`.
- **CI.**
  - `release.yml` gains Windows and macOS jobs after the tests, module and loader: package,
    smoke-test (`GET /` on 29473), and a draft release on `v*` tags.
  - Tests also run on Node 24, the version Electron 44 ships.
- **Size.** About 110 MB for Windows and 230 MB for the universal dmg; LazyTO's own part is about
  3 MB. It is lightweight in code and dependencies, not in download size.

### What a TO clicks the first time

- **Windows.**
  - SmartScreen: "Windows protected your PC" → More info → Run anyway.
  - Firewall, on the first launch: tick Private and Public, then Allow access (an admin approves).
    Cancel creates block rules that never prompt again.
  - The status page reads the network profile and LazyTO's firewall rules. When a rule blocks
    LazyTO, it offers "Allow LazyTO through the firewall" (one admin prompt).
  - It also says "No beamer has reached this laptop" when beacons go out and nothing comes back for
    2 minutes.
  - Smart App Control blocks unsigned apps outright; the docs say how to turn it off.
- **macOS.**
  - Gatekeeper: "LazyTO Not Opened" → System Settings > Privacy & Security > Open Anyway. This
    repeats after every update.
  - Local Network: Allow. The app triggers that alert on the first launch of each version, so it
    comes up at home, not at the venue.
  - If it was denied, sending the beacon fails with `EHOSTUNREACH`. The status page then says "macOS
    is blocking LazyTO from your network: System Settings > Privacy & Security > Local Network".
    The next beacon after allowing works.
  - **Untested, and Phase 3 depends on it:** raw UDP broadcast and multicast from an ad-hoc-signed
    app.
    - Replay Reporter's raw broadcast discovery failed when packaged on macOS (#187), before the
      UUID trick existed, and it moved to Bonjour.
    - Test a packaged dmg on a macOS 15+ Mac first. If it fails, advertise LazyTO over Bonjour as
      Replay Reporter does.

### What it replaces

`deploy/` (install, update, systemd unit, add-wifi, uninstall), `docs/pi-setup.md`, the pi-deploy
skill, the install.sh release asset and the shellcheck step. `CLAUDE.md`'s "Node 22, TypeScript,
no framework" becomes: relay core with no framework and no runtime dependencies, plus a thin
Electron shell in `desktop/`. "Never stalls a Pi" becomes "a laptop".

## Status page additions

- **Beamers.** One row per beamer, from its sync:
  - `station_id`, number, firmware build, uptime ("not unplugged since");
  - Wi-Fi state and signal, storage state and free space;
  - replays on the card, waiting to collect, waiting to erase, empty or incomplete;
  - the last erase report and round-trip result;
  - the duplicate and wrong-secret banners.
- **"All replays collected: safe to unplug beamers"**, for the end of the night.
- **Missing replays.** Reported games without a replay, and the sets skipped for Lucky Stats.
- **Network.** Firewall and Local Network state, and "No beamer has reached this laptop".
- **Updates.** "LazyTO vX is out".

## Fixes found along the way

These hold whatever happens to the redesign:

- **Cards record no replays.** `src/cards.ts:47` does not turn on Slippi replays. Recording itself
  works with the kiosk module loaded: the maintainer checked it on a Wii with the previous build.
- **A Wii reboot mid-set loses games (N3).** The kiosk resumes at 0-0, and its next report
  overwrites the earlier games on start.gg. The resume reply should return the claim's games.
- **Stale docs.** `docs/architecture.md` still describes `CMD_ABANDON_SET`, which the relay no
  longer handles.
- **Licence.** The firmware fork (MIT, built with Apache-2.0 ESP-IDF) contains the generated
  `relay_proto.h`, and this repo is GPL-2.0-only. The generated protocol headers need an MIT or
  dual licence before fork binaries ship or anything goes upstream.
- **B from the set list keeps the set.** The kiosk's current set survives `exitToMainMenu`, so a VS
  match started from the vanilla main menu shows the set's overlay and is auto-scored into it.
- **A match without Game End costs the next replay.** After a soft reset, Slippi's writer jumps to
  the write cursor and skips the following match too. Upstream code, fixed in the fork as part of
  [Recording only set games](#recording-only-set-games).
- **CSW status ignored.** Nintendont's USB driver ignores the CSW status byte and detects only
  stalls. It's upstream code; noted.

## Plan

Each phase leaves a working system. Phases 2 and 3 do not depend on each other.

1. **One-beamer bench (now: one beamer in hand).**
   - Flash the fork and run `tools/lazyto_host.py`.
   - Then on a Wii, with a card that has replays on and the game on SD:
     - list, a full set, 20 games;
     - power cycles;
     - a score sent while a replay is downloading.
   - Measure:
     - round-trip p95 and `BR_CONNECT` at game end;
     - replay integrity;
     - the beamer's boot-to-bind time, erase time per file and SHA-256 rate;
     - whether the Wii cuts USB power on reset, IOS reload, standby and off, and what the beamer
       sees on the bus in standby;
     - that MEM2 0x13003200-0x1300323F is free (a kernel log after boot and a match).
2. **Beamer-only Wii.**
   - Mailbox v2: the status record, station and secret on the beamer, NVS in `jrnl`,
     `PF_NO_STATION` and `PF_NO_SECRET`, `last_fail`, the "starting" reason.
   - Firmware: the beacon check decoupled from `PROTO_VERSION`, HTTP capped at one socket in LazyTO
     mode, `/reset-beamer` refused, the button guard.
   - Kernel: delete the network path; bound the USB lock.
   - Kiosk: the texts above. One identical card zip.
3. **The laptop app.**
   - First, test a packaged dmg on a macOS 15+ Mac: Open Anyway, the Local Network alert, and a
     beacon reaching a beamer.
   - Then `desktop/`, the firewall and Local Network detection, keep-awake, the update check,
     flashing and beamer provisioning.
   - Then retire the Pi.
4. **Replays.**
   - Set-only recording and replay ids, together.
   - Collection driven by the sync, acks with HMAC, the cold-boot erase.
   - The scan fix and the kernel's early `f_sync`.
   - The N3 resume fix, and a test upload to Lucky Stats.
5. **A full night.** When more beamers arrive: duplicate detection, a 12-station load run
   (`scripts/sim-wii.ts` against a beamer impersonator), the router and the end-of-night steps in
   `night-of.md`.

## Open questions

1. **A Mac for testing.** Is there a macOS 15+ Mac (ideally Apple silicon) to test the packaged dmg
   on? It gates Phase 3.
2. **The firewall button.** May the status page offer "Allow LazyTO through the firewall", which
   raises one admin prompt?
3. **The erase budget.** 10 s per power-on, or 3-5 s so a beamer bumped mid-set misses less, at the
   cost of more power-ons to clear a backlog?
4. **The kernel's early `f_sync`.** May the fork sync each recording once after its first data
   block? It touches Slippi's writer path.
5. **Raw retention.** Keep raw files until the TO deletes the event? The laptop can only answer
   "held" while a raw file exists.
6. **The archive folder's default.** Documents is often synced to OneDrive or iCloud. Use a
   non-synced default, or warn?
7. **Sudden Death.** Leave it unrecorded (the game is scored from the main portion), or record it
   as a second file?
8. **Strays.** Keep stray and incomplete recordings in an unmatched folder, or discard them once
   acked?
9. **Duplicate station numbers.** Refuse only the newcomer (proposed), or both?
10. **The button.** In LazyTO mode, hold to edit, and a press only shows the number?
11. **Licence.** Relicense the generated protocol headers as MIT or dual?
12. **Upstream.** Persist the number only in LazyTO mode, or offer jendotpg an opt-in key?
13. **Builds.**
    - A universal dmg (about 230 MB) or one per architecture?
    - A Linux AppImage too? It's free in the same CI.
    - The final `productName` and `appId`?
    - Electron 44 means macOS 12+ and Windows 10+. Is that the floor?

## Docs to revise as parts land

- `decisions.md`:
  - Relay on the LAN; Set up from a browser; One bundle, two update channels; One config file per
    Wii; SD cards from the relay.
  - R9 (moot without the Wii's sockets), R15 (the beacon's consumer is the beamer), R16 (the secret
    lives on the beamer).
  - New entries: recording only set games, matching replays by their own id, the beamer's
    self-erase, the app built like Replay Reporter.
- `architecture.md`: components, EXI contract, deployment, network, error table.
- `night-of.md`: the router, laptop rules, beamer numbering.
- `wii-setup.md`: replays on, game on SD, one card for every Wii.
- `kiosk.md`: the VS on_enter hook and the record gate.
- `beamer.md`: folds into `architecture.md`.
- `pi-setup.md`: deleted.
- `CLAUDE.md`, as above.
