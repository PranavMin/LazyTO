# Protocol v2: the implementer's guide

Status: the contract, 2026-10-07 (branch `redesign-v2`). [`protocol.yaml`](../protocol.yaml) is the
source of truth and this page explains it for each part that builds against it: the relay, the
kiosk, the Nintendont kernel, the beamer firmware and the Dolphin forwarder. The why is in
[redesign.md](redesign.md). Nothing here has run on hardware.

`protocol.yaml`, `generated/wire.ts` and both `relay_proto.h` copies are MIT
(`SPDX-License-Identifier: MIT`, [LICENSE-MIT](../LICENSE-MIT)), so the firmware fork can compile
the header. The rest of LazyTO stays GPL-2.0-only.

## What changed from v1

| Part | v1 | v2 |
| --- | --- | --- |
| `PROTO_VERSION` | 1 | 2 |
| Where the station and the secret live | `lazyto_station.txt` on the SD card | the beamer: its button (saved in flash) and `LAZYTO-SECRET` in its `CONFIG/config.txt` |
| Who writes `relay_auth` | the kernel | the beamer, in front of every request and telemetry datagram it forwards |
| Mailbox (`BEAMER_MB_VERSION`) | 1 | 2: `beamer_hello` is 32 bytes; the request and telemetry sectors carry no `relay_auth` |
| `exi_poll_hdr` | 12 bytes | 16 bytes: `no_beamer_reason`, `beamer_wifi`, `beamer_storage`, `last_fail` |
| Poll flags | `PF_NO_NETWORK` 1, `PF_NO_CFG` 2, `PF_NO_SECRET` 4, `PF_NET_JOINING` 8, `PF_NO_BEAMER` 16 | 1, 2, 4 and 8 retired; `PF_NO_BEAMER` 16, `PF_NO_STATION` 32, `PF_NO_SECRET` 64 (the beamer's), `PF_RELAY_STALE` 128 |
| `game_result` | 8 bytes | 16 bytes: `p1_port`, `p2_port`, `replay_id` |
| `report_score_req`, `end_set_req` | 48 bytes | 88 bytes (`EXI_PAYLOAD_MAX`) |
| `CMD_GAME_START` (6), `game_start_req` | the kiosk sent one per match | retired; 6 is never reused |
| `CMD_BEAMER_SYNC` (8) | none | a beamer's own inventory and ack request, frozen under `BEAMER_SYNC_VERSION` 1 |
| Relay statuses | up to `ST_BAD_SECRET` 8 | `ST_DUP_STATION` 9 |
| Beamer results | up to `BR_BAD_REQ` 6 | `BR_NO_STATION` 7, `BR_NO_SECRET` 8 |
| Record gate | none | `record_gate`, 64 bytes at PPC `0xD3003200` / ARM `0x13003200` |
| `MAX_SETS` | 56 | 56: 4096 - 16 - 8 - 32 - 4 = 4036 bytes still hold 56 rows of 72 (4032) |

## Frozen: what a beamer parses

Dongles have no over-the-air update. These never change with `PROTO_VERSION`, and
`test/protocol-frozen.test.ts` pins their bytes:

- **`relay_beacon`** (12 bytes). A beamer accepts a datagram of exactly 12 bytes that starts
  `'M','T'` and has a nonzero `tcp_port`. It never reads `version`. The relay answers a beacon
  request (12 bytes, `'M','T'`, `tcp_port` 0) whatever its version.
- **`relay_auth`** (20 bytes): `'M','K'`, two zero bytes, the secret NUL-padded to 16.
- **`relay_hdr`** (8) and **`relay_resp`** (32).
- **`CMD_BEAMER_SYNC` = 8**, **`BEAMER_SYNC_VERSION` = 1**, and the four sync structs:
  `beamer_sync_req` (100 + 84 per file), `sync_file` (84), `beamer_sync_resp` (52 + 36 per answer),
  `sync_answer` (36).

A change to any of them is a new `BEAMER_SYNC_VERSION` or a new beacon, never an edit.

The mailbox itself is not frozen: it is versioned by `BEAMER_MB_VERSION`, and the kernel reports a
beamer on another version as old or new firmware. A firmware update changes it together with the
kernel.

## The paths

```
Wii request:  kiosk ─EXI─► kernel: beamer_req_hdr + relay_hdr + payload ─USB─► beamer
              beamer ─TCP─► relay: relay_auth + relay_hdr + payload
              relay ─TCP─► beamer: relay_hdr + relay_resp + payload  ─USB─► kernel ─EXI─► kiosk
Telemetry:    kernel ─USB─► beamer: beamer_tele_hdr + telemetry_hdr + payload
              beamer ─UDP 29472─► relay: relay_auth + telemetry_hdr + payload
Beacon:       relay ─UDP 29471 broadcast─► beamer: relay_beacon
Sync:         beamer ─TCP─► relay: relay_auth + relay_hdr(v=1, cmd=8) + beamer_sync_req
              relay ─TCP─► beamer: relay_hdr(v=1, cmd=8) + relay_resp + beamer_sync_resp
Downloads:    relay ─HTTP─► beamer: GET /SLIPPI/<name>, a file the sync answered SA_WANTED
Record gate:  kiosk ─MEM2 0xD3003200─► kernel (want); kernel ─► kiosk (start_seq, file_seq, file_id)
```

## Relay (`src/`)

Accept:

- **Framing.** `relay_auth` + `relay_hdr` + `len` bytes, one request per connection, as in v1. The
  secret is now the beamer's, so `ST_BAD_SECRET` means "this beamer's `LAZYTO-SECRET` is not the
  laptop's".
- **Versions.** `relay_hdr.version` must be `PROTO_VERSION` (2) for every command except
  `CMD_BEAMER_SYNC`, which carries `BEAMER_SYNC_VERSION` (1). The reply's `relay_hdr.version` is
  the same rule. Anything else gets `ST_BAD_VERSION`. Done in `src/tcp.ts`.
- **`relay_hdr.station`** is stamped by the kernel from the beamer's number. The connection's
  source address is the beamer's, not the Wii's.
- **Beacon requests** are answered by length, magic and `tcp_port` 0 only (`src/telemetry.ts`).
  The beacon the relay sends still carries `PROTO_VERSION`, for logs only.
- **Telemetry** is `relay_auth` + `telemetry_hdr` (version 2) from the beamer's address, as before.

Game results (`game_result`, 16 bytes):

- `p1_stocks` and `p2_stocks` both 0xFF: send no per-game score. That now also covers a game the
  ledge-grab limit decided and a game LGL's tiebreak decided.
- `p1_port` / `p2_port`: the CSS ports (0-3) of entrant 1 and 2, `NO_PORT` (0xFF) when unknown.
  They label the replay's display names and the zip's `context.json`.
- `replay_id`: 0 = no replay. Otherwise the replay is `Game_<Wii MAC>_<replay_id as UTC
  YYYYMMDDTHHMMSS>.slp` on the beamer the set was played through (`replayStamp()` in
  `src/archive.ts`; Nintendont formats it with `gmtime`).
- The content check (stage, characters and costumes on their ports) flags a mismatch and still
  binds: the id decides. Stocks are compared only when the game sent them.

`ST_DUP_STATION` (not built yet):

- Each beamer has its own address. The relay sees each Wii request and telemetry datagram arrive
  from a beamer's address, and the sync names the `station_id` behind each address.
- Two addresses (two `station_id`s) using one station number within about 15 s is a duplicate.
  The one that held the number first keeps it. The newcomer's Wii requests get `ST_DUP_STATION`
  with a `msg` naming the number, and its telemetry is dropped and counted, until one of them is
  renumbered. The status page names both beamers.
- A sync is never refused as a duplicate: collection goes on.

`CMD_BEAMER_SYNC` (built: the version rule, the signature in `src/sync.ts`; not built: everything
else, so `tcp.ts` answers `ST_INTERNAL` "beamer sync not handled yet" and no beamer acks
anything):

1. Check `relay_auth` like any request. A wrong secret gets `ST_BAD_SECRET` with no payload; the
   beamer acks nothing.
2. Decode `beamer_sync_req`. `file_count` is at most `SYNC_MAX_FILES` (16). It touches no set and
   no station row.
3. Record the beamer: `station_id`, its address and `http_port`, `station` (with
   `SF_STATION_SET`), `fw_build`, `uptime_s`, the counts, free and leaked space
   (`card_mb - free_mb - used_mb`), the erase report, `storage`, `rssi`, `last_result`.
4. Answer every file, `answers[i]` for `files[i]`, `answer_count = file_count`:
   - `SA_HELD` with the SHA-256 of the stored copy, only for a file the laptop has stored (temp
     file, fsync, rename, re-read, hash) and can still stat;
   - `SA_WANTED` for a file it will download now (one download at a time per beamer, resumed with
     `X-Replay-From`, after a free-disk check);
   - `SA_NOTED` otherwise (`SK_LIVE`, already downloading, the disk is full). A zero-filled answer
     is `SA_NOTED`.
5. Put the laptop's `archive_id` in the reply. It is random, 16 bytes, kept in `archive.json` in
   the archive folder, and never all zero.
6. Sign: `hmac` = HMAC-SHA256, keyed with the secret's 16 bytes as `relay_auth` carries them
   (NUL-padded), over the request's `nonce` (16 bytes), then the request's `station_id`
   (16 bytes), then the reply payload after `hmac` (`20 + 36 * answer_count` bytes).
   `signedSyncResp()` in `src/sync.ts` does it.
7. Reply `ST_OK` with the signed `beamer_sync_resp`. The reply's `relay_hdr.version` is
   `BEAMER_SYNC_VERSION`.

## Kiosk (`kiosk/`)

- **Request buffer.** `LB_RELAY_EXI_MAX_PAYLOAD` is `EXI_PAYLOAD_MAX` (88). The kernel's staging
  buffer uses the same constant.
- **Poll buffer.** `exi_poll_hdr` is 16 bytes, so `relay_hdr` is at 16, `relay_resp` at 24 and the
  payload at 56 of `lbRelayExi_PollBuf` (asserted in `lbrelayexi.h`). A reply is at most
  `RELAY_REPLY_MAX` (4080) bytes.
- **No `CMD_GAME_START`.** The kiosk sends nothing at match start.
- **`game_result`.** Fill `p1_port` / `p2_port` from the L + R claim (the standings slots of the
  game just played), `NO_PORT` when unknown; `replay_id` from the record gate (below). A game the
  ledge-grab limit decided, and a tiebreak game, send both stocks 0xFF; a tiebreak game reports
  its main game's number and `replay_id`. Clear the whole struct before filling it, so `_pad` is 0.
- **Record gate** (only when `exi_poll_hdr.host_build >= RECORD_GATE_HOST_BUILD`, 7; never in
  Dolphin, which sends 0). Use u32 loads and stores on the uncached address `RECORD_GATE_PPC`:
  1. In the VS scene's on_enter wrapper (`ptr 0x803DA950`, vanilla `gm_Scene_Vs_OnEnter`), when
     there is a current set and the game is not a handwarmer:
     `s0 = start_seq; want = RECORD_THIS_MATCH;` call vanilla, then `want = 0;`
     `match_seq = (start_seq == s0 + 1) ? start_seq : 0`. Otherwise `match_seq = 0` and `want`
     stays 0.
  2. At VS exit: `replay_id = (match_seq != 0 && file_seq == match_seq) ? file_id : 0`.
  3. A tiebreak game (Sudden Death scene) does not touch the gate; it reports the main game's
     `replay_id`.
  4. Hand scoring takes the id of the set's last match if it was recorded and its id is not used
     by an earlier game of the set; otherwise 0. Undo frees the id.
- **What the host says** (`exi_poll_hdr`; 0 everywhere in Dolphin). Check order on the search
  screen: no beamer, old or new firmware, no number, no secret, beamer off the Wi-Fi, no relay.

  | Field | Value | Meaning | Suggested text |
  | --- | --- | --- | --- |
  | `flags` | `PF_NO_BEAMER` | see `no_beamer_reason` | |
  | `no_beamer_reason` | `NB_REPLAYS_OFF` | replays off or the game not on SD | TURN ON REPLAYS IN THE LOADER |
  | | `NB_NO_DRIVE` | no USB drive | PLUG THE BEAMER INTO THIS WII |
  | | `NB_NOT_LAZYTO` | a plain stick, or `LAZYTO` off | NOT A LAZYTO BEAMER |
  | | `NB_OLD_FIRMWARE` | mailbox v1 or `fw_build < BEAMER_FW_MIN` | UPDATE THE BEAMER |
  | | `NB_NEW_FIRMWARE` | a newer mailbox than this loader | UPDATE THE SD CARD |
  | | `NB_STARTING` | no hello yet, within about 45 s of boot or a USB change | WAITING FOR THE BEAMER (a wait, not an error) |
  | `flags` | `PF_NO_STATION` | no number on the beamer; clears by itself | THIS BEAMER HAS NO STATION NUMBER, press its button (a wait) |
  | | `PF_NO_SECRET` | no `LAZYTO-SECRET` | THE BEAMER HAS NO SECRET |
  | | `PF_RELAY_STALE` | beacon older than `BEACON_STALE_S` (10 s) | BEAMER HEARS NO RELAY / IS THE LAPTOP ON THIS WI-FI? |
  | `beamer_wifi` | `WIFI_JOINING` | joining; keep the 60 s wait | JOINING THE WI-FI |
  | | `WIFI_NO_SSID`, `WIFI_CANT_JOIN`, `WIFI_NO_ADDRESS`, `WIFI_RADIO` | | NO SSID / CAN'T JOIN / NO ADDRESS / RADIO FAILED |
  | `relay_ip` | 0 | the beamer has heard no beacon | BEAMER HEARS NO RELAY |
  | `beamer_storage` | `STORE_FULL` (or a fault 1-4) | | REPLAYS NOT SAVING (a CSS warning) |
  | | `STORE_FILLING` | the TO's job | nothing |
  | `last_fail` (with `RELAY_ERROR`) | `BR_CONNECT` | laptop unreachable or firewalled | NO LINK TO THE RELAY |
  | | `BR_TIMEOUT`, `LF_NO_ANSWER` | no answer within 3 s | NO LINK TO THE RELAY |
  | | `LF_USB_WRITE`, `LF_USB_READ`, `LF_BEAMER_LOST` | the USB link | NO LINK TO THE BEAMER |
  | | `LF_USB_BUSY` | a USB cycle stalled (writer or SD card) | TIMEOUT, with the storage state |
  | | `BR_TOO_LARGE`, `BR_BAD_REQ`, `LF_BAD_REPLY`, `LF_BAD_REQUEST` | a bug | TELL THE TO |
  | `resp.status` | `ST_DUP_STATION` | | TWO BEAMERS ARE STATION n |
  | | `ST_BAD_SECRET` | | RELAY SECRET MISMATCH; the hint names the beamer |

  Text limits: `fail()` strings at most 30 characters, each line under 128 encoded bytes (a space
  after a letter costs 7), pane labels about 10 characters, no underscore in the font.

On this branch the kiosk only does what the contract forces: the new offsets, no
`CMD_GAME_START`, ports in auto-scored games, `replay_id` always 0, and the retired flags replaced
by `PF_NO_BEAMER` (with `NB_STARTING` as a wait), `PF_NO_STATION` / `PF_NO_SECRET` and
`WIFI_JOINING`. The record gate, the VS on_enter hook and the rest of the table are the kiosk's
next step.

## Kernel (`Nintendont/kernel`)

- **Header.** `relay_proto.h` is generated here; do not edit it. Set `RELAY_HOST_BUILD` to at least
  `RECORD_GATE_HOST_BUILD` (7) in the build that adds the gate.
- **EXI staging.** The game's request is at most `sizeof(relay_hdr) + EXI_PAYLOAD_MAX` (96) bytes;
  a longer one ends `RELAY_ERROR` with `LF_BAD_REQUEST`. The mailbox response body holds 4084
  bytes but a reply over `RELAY_REPLY_MAX` (4080) is `LF_BAD_REPLY` (so the v1 assert
  `beamer_resp_hdr + RELAY_RESP_MAX == sizeof(mb_buf)` becomes `<=`).
- **The hello.** Read sector `BEAMER_MB_HELLO` about once a second, also while a game is paused.
  - Magic `LAZYTOMB` and `version == BEAMER_MB_VERSION` (2) and `fw_build >= BEAMER_FW_MIN` (2):
    valid.
  - Magic with `version < 2`, or `fw_build < 2`: `PF_NO_BEAMER` + `NB_OLD_FIRMWARE`. `fw_build`
    is at offset 20 in both versions.
  - Magic with `version > 2`: `PF_NO_BEAMER` + `NB_NEW_FIRMWARE`.
  - No magic: `NB_NOT_LAZYTO`; no drive: `NB_NO_DRIVE`; replays off or the game not on SD (USB is
    never started): `NB_REPLAYS_OFF`. For about 45 s after kernel boot or a USB removal, report
    `NB_STARTING` instead of `NB_NO_DRIVE` or `NB_NOT_LAZYTO`.
- **`exi_poll_hdr` on every poll**, from the latest valid hello:
  - `flags`: `PF_NO_BEAMER` as above; `PF_NO_STATION` without `BF_STATION_SET`; `PF_NO_SECRET`
    without `BF_SECRET`; `PF_RELAY_STALE` with `BF_RELAY` and `beacon_age_s > BEACON_STALE_S`.
  - `station`: the hello's with `BF_STATION_SET`, else 0. `relay_ip` / `relay_port`: the hello's
    with `BF_RELAY`, else 0.
  - `host_opts`, `host_build` as in v1. `no_beamer_reason` with `PF_NO_BEAMER`, else 0.
  - `beamer_wifi` = hello `wifi`, `beamer_storage` = hello `storage`, copied as-is; 0 without a
    valid hello.
  - `last_fail`: the reason of the last `RELAY_ERROR`; 0 after a `RELAY_DONE`.
- **A request** from the game:
  - No valid hello: `RELAY_ERROR`, `LF_NO_BEAMER`. Without `BF_STATION_SET`: `RELAY_ERROR`,
    `BR_NO_STATION`, nothing written. Otherwise stamp `relay_hdr.station` from the hello and write
    `beamer_req_hdr` + `relay_hdr` + payload (no `relay_auth`) under the next seq. The beamer
    answers everything else (`BR_NO_SECRET`, `BR_NO_WIFI`, `BR_NO_RELAY`).
  - Poll the response sectors until `seq` matches, within the 3 s budget (`LF_NO_ANSWER`).
    `result != BR_OK`: `RELAY_ERROR` with that `BR_*` as `last_fail`. `BR_OK`: check `len <=
    RELAY_REPLY_MAX` and that `relay_hdr` echoes the request's magic and `cmd` (`LF_BAD_REPLY`),
    then `RELAY_DONE`.
  - USB failures: `LF_USB_WRITE`, `LF_USB_READ`; the USB lock not free within the request's
    remaining budget: `LF_USB_BUSY` (bound `__usb_lock`'s wait); the hello invalid mid-request:
    `LF_BEAMER_LOST`.
  - The kernel no longer synthesizes `ST_INTERNAL` replies with text: every failure is
    `RELAY_ERROR` + a code, and the kiosk picks the words.
- **Telemetry.** `beamer_tele_hdr` + `telemetry_hdr` + payload, no `relay_auth`;
  `telemetry_hdr.station` from the hello; nothing is written without `BF_STATION_SET`.
- **The record gate** (`RECORD_GATE_ARM`):
  - Zero both lines at boot, before the game runs.
  - In `SlippiMemoryWrite`'s RECEIVE_COMMANDS branch (Slippi's Game Start, the EXI DMA handler):
    `sync_before_read` line 0; `record = (module_state != MOD_LOADED) || want ==
    RECORD_THIS_MATCH`; `start_seq++`, written to line 1 and flushed (`sync_after_write`); store
    `{ring cursor, record, start_seq}` in a small table. No lock, no wait.
  - In `SlippiFileWriter.c`, on a new match: look up its cursor. Skip: no `f_open`, and drain the
    match in the same cycle. Record (or a cursor missing from the table, logged): open the file as
    now, then write `file_id = gameStartTime`, then `file_seq` = its seq, and flush line 1.
  - A match that never sent Game End: finish the open file and resume at the next match's start.
- **Early sync** (decided, not a wire change): one `f_sync` after the first data block of each
  recording, in every mode. Ship it with or after the beamer's scan fix.
- **Deleted** with the network path: `lazyto_station.txt` and its parser, the beacon listener and
  request, the UDP telemetry socket, `relay_auth` (`putAuth`), `PF_NO_NETWORK`, `PF_NO_CFG`,
  `PF_NET_JOINING`, the card's `PF_NO_SECRET`.

## Beamer firmware (`slippi-beamer`, `LAZYTO = true`)

- **Header.** Copy the generated `relay_proto.h` to `components/beamer_lazyto/include/`. Set
  `BEAMER_LAZYTO_FW_BUILD` to at least `BEAMER_FW_MIN` (2).
- **Hello** (sector 0, 32 bytes, rewritten whenever the state changes):

  | Field | Source |
  | --- | --- |
  | `magic`, `version` | `LAZYTOMB`, `BEAMER_MB_VERSION` (2) |
  | `flags` | `BF_WIFI` (exactly when `wifi` is `WIFI_UP`), `BF_RELAY` (a beacon heard), `BF_STATION_SET` (a number in NVS `jrnl`/`lazyto`), `BF_SECRET` (`LAZYTO-SECRET` present) |
  | `station` | the number on the screen; meaningful only with `BF_STATION_SET`. An unset beamer is never "Station 1" |
  | `relay_ip`, `relay_port` | the latest valid beacon's source address and `tcp_port` |
  | `wifi` | `WIFI_UP`; `WIFI_JOINING` while connecting or waiting for DHCP; `WIFI_NO_SSID` (no SSID in `config.txt`); `WIFI_CANT_JOIN` (WIFI ISSUE); `WIFI_NO_ADDRESS` (WIFI TOO FULL); `WIFI_RADIO` (RADIO FAILURE) |
  | `storage` | `STORE_OK`; `STORE_NO_CARD` (NO SD CARD); `STORE_UNREADABLE` (SD UNREADABLE, DRIVE FAILING); `STORE_WRITE_FAILED` (WRITE FAILED, CARD STUCK); `STORE_WRONG_FORMAT`; `STORE_FILLING` (384 files or under 1 GB free); `STORE_FULL` (under 64 MB free). The worst one wins |
  | `fw_build` | `BEAMER_LAZYTO_FW_BUILD` |
  | `last_result` | the last mailbox round trip's `beamer_result`; 0 before the first |
  | `beacon_age_s` | seconds since the last valid beacon, saturating at 0xFFFF |

- **Beacon.** Accept exactly 12 bytes, `'M','T'`, `tcp_port != 0`; never compare `version`. A
  beacon request may carry any version.
- **Requests** (sector 1): `beamer_req_hdr` (`'M','Q'`, `len <= 500`), then `relay_hdr` +
  payload. Once per seq: no number, `BR_NO_STATION`; no secret, `BR_NO_SECRET`; not on Wi-Fi,
  `BR_NO_WIFI`; no relay, `BR_NO_RELAY`; else connect to the relay, send `relay_auth` (its
  `LAZYTO-SECRET`, NUL-padded) + the `len` bytes, read the reply to EOF into the response body
  (over 4084 bytes: `BR_TOO_LARGE`). The outgoing buffer needs `relay_auth`'s 20 bytes in front
  of up to 500 request bytes or 1012 telemetry bytes.
- **Telemetry** (sectors 10-11): `beamer_tele_hdr` (`'M','E'`), then `telemetry_hdr` + payload.
  Dropped without a number or a secret; else one UDP datagram, `relay_auth` + the bytes, to the
  relay's address at `TELEMETRY_PORT`.
- **Never parse** `relay_hdr`, `telemetry_hdr` or the reply for a Wii request: the beamer is a
  pipe that adds `relay_auth`.
- **Sync** (`CMD_BEAMER_SYNC`), only when no mailbox request is pending: after each served file,
  when the inventory finds a new file, and every 30 s.
  - Send `relay_auth` + `relay_hdr` (`'M','T'`, version `BEAMER_SYNC_VERSION` 1, cmd 8, station
    or 0, `len = 100 + 84 * file_count`) + `beamer_sync_req` on a TCP connection to the relay's
    `tcp_port`.
  - `beamer_sync_req`: `station_id` (the 16-byte StationId), the ack table's `archive_id` (zero
    if none), a fresh random `nonce`, `fw_build`, `uptime_s`, space in MiB (`free_mb` from the FAT,
    not FSInfo; `card_mb`; `used_mb` by Game files), `station`, `http_port`, the counts
    (saturating), the erase report (`erased`, `erased_empty`, `erase_ms`, `erase_left`, 0 unless
    `SF_COLD_BOOT`), `flags`, `storage`, `last_result`, `rssi` (-dBm, 0 unknown), then up to 16
    `sync_file`s: files without an ack, hashed ones (served whole this boot) first, then
    `SK_FINISHED`, `SK_INCOMPLETE`, `SK_LIVE`, oldest modified time first; `SF_MORE` if some did
    not fit. A name over 40 bytes is never synced.
  - Accept the reply only if: `relay_hdr` magic, version 1 and cmd 8; `relay_resp.status ==
    ST_OK`; payload length `52 + 36 * n` with `n == file_count`; `archive_id` not all zero; and
    `hmac` verifies (constant-time compare) as HMAC-SHA256 keyed with the NUL-padded 16-byte
    secret over `nonce | station_id | payload[32..]`.
  - Then: if `archive_id` differs from the ack table's, drop every ack and adopt it. For each
    `SA_HELD` answer, ack `files[i]` only if its `sha256` equals the SHA-256 the beamer computed
    serving that file this boot. `SA_WANTED` and `SA_NOTED` need nothing.
- **Serving** for the sync: any file by name (not only this boot's newest 16), SHA-256 over the
  raw bytes before gzip while serving, the skipped prefix hashed first on a resumed request; one
  HTTP socket in LazyTO mode; refuse `POST /reset-beamer` in LazyTO mode.

## Dolphin forwarder (PranavMin/Ishiiruka, `LazyTO`)

It compiles its own copy of `relay_proto.h`: copy the new one and rebuild.

- Fill the 16-byte `exi_poll_hdr` with zeros in the four new fields (and `host_build` 0, so the
  kiosk never touches the record gate).
- Accept beacons by length and magic only.
- It still writes `relay_auth` itself (`SlippiRelaySecret`) and stamps station 0.
- Requests are length-driven; the 88-byte reports need no other change.

## Test vector: the sync signature

`test/protocol-frozen.test.ts` checks it; the firmware's tests should check the same bytes.

- Secret `venue-secret` (key: those 12 bytes and 4 NULs).
- `nonce` = 00 01 02 .. 0f; `station_id` = 10 11 12 .. 1f.
- Reply: `archive_id` = a0 a1 .. af; `answer_count` 3; answers `SA_HELD` with SHA-256("replay")
  (`ac203c9843b5bd8c883e07039ff82820c94422010be6108bb82403ca25376a22`), `SA_WANTED`, `SA_NOTED`
  (zero hashes).
- Payload: 160 bytes. `hmac` =
  `dff09c43e230fa9913e545f4df881b9f78dbc9046530bfe3654b6583e988e48b`.

Beacon bytes for `tcp_port` 29470, event 1613010, version 2: `4d540200731e000000189cd2`.

## Shipping

Everything in v2 ships together: the relay, the loader, `lazyto_kiosk.bin` and the beamer
firmware. Mixed versions fail visibly:

- a v1 kiosk or loader with a v2 relay: `ST_BAD_VERSION`; a v1 kiosk misreads the 16-byte poll
  header;
- v1 beamer firmware with a v2 kernel: `NB_OLD_FIRMWARE`; v2 firmware with a v1 kernel: "no
  beamer";
- v1 beamer firmware never accepts a v2 relay's beacon (it compares the version), so it shows no
  relay until it is reflashed. From v2 on, firmware ignores the version.

Until the kiosk fills `replay_id` from the record gate, every game reports 0 and the set archive
binds no replay.
