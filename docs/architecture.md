# LazyTO architecture

This document describes how LazyTO works today. Why it works this way is in [decisions.md](decisions.md). What changed and when is in [changelog.md](changelog.md).

## Overview

At a Melee local, a set moves through start.gg only when a TO touches it: call it, put it on stream, report the score. LazyTO moves that work to the players at the console.

- Two players sit at any Wii, pick their set from a list and start it. start.gg marks it in progress. On the stream station it is also assigned to the stream, so the overlay (for example TSH) picks up the names.
- Games are scored automatically at game end. Players correct or end the set from the character select screen (CSS). start.gg shows the score within seconds.
- The TO watches every station on one status page and only steps in when a row is flagged.

It runs on the venue's existing hardware: internet-connected Wiis, one Raspberry Pi, and whatever already runs the stream overlay.

### Goals

| ID | Goal |
|----|------|
| F1 | List every set in the event that is not started and has both entrants known, filterable by player name. |
| F2 | Select a set and start it. start.gg marks it in progress. |
| F3 | On the stream station, also assign the set to the configured stream. |
| F4 | Each game reports a winner (and characters, stage, stocks and colour when scored automatically). Undo removes the last game. |
| F5 | Ending the set reports the winner and completes it on start.gg. The console returns to the set list. |
| F6 | Every console shows the same list. A set started on one console disappears from the others on the next refresh. |
| F7 | The TO sees all stations, their sets, last actions and failed start.gg calls on one page. |
| N1 | A score is visible on start.gg within 5 s of the game ending or the button press. |
| N2 | start.gg traffic stays under the API limit (80 requests per 60 s per token) with 12 stations. |
| N3 | A station reboot mid-set loses nothing. The set is offered first in the list. |
| N4 | The start.gg token never leaves the Pi. |
| N5 | Wii-side code has no dynamic allocation, no JSON and no string parsing beyond fixed-width fields. |

### Non-goals

- Replacing the overlay, start.gg or the bracket. start.gg stays the source of truth.
- Doubles, round robin formats, or games other than Melee. LazyTO handles 1v1 Melee brackets.
- Running without a network. If the relay is unreachable the kiosk says so and the TO runs start.gg by hand.
- TLS on the Wii. See [decisions.md](decisions.md#relay-on-the-lan).

## Components

```
 ┌──────────────── Wii (one per station) ────┐
 │  Melee 1.02, stock disc image (PowerPC)   │
 │   + tournament.bin, loaded at boot        │
 │   ├─ set list menu                        │
 │   ├─ CSS score banner, auto-score         │
 │   └─ lbrelayexi.c ──EXI──┐                │
 │                          ▼                │
 │  LazyTO Nintendont kernel (ARM)           │
 │   ├─ module loader                        │
 │   ├─ discovery, telemetry                 │
 │   └─ RelayEXI ──── TCP ──┼────────────────┼──┐
 └──────────────────────────┼────────────────┘  │
                            │  venue network     │
                            │  (Pi on Wi-Fi)     │
                            ▼                    │
 ┌──────── Raspberry Pi ────────────────┐        │
 │  lazyto-relay (Node 22, systemd)     │◄───────┘
 │   ├─ TCP server     :29470           │
 │   ├─ beacon         UDP :29471       │
 │   ├─ telemetry      UDP :29472       │
 │   ├─ set cache      (every 20 s)     │
 │   ├─ start.gg client (GraphQL/HTTPS) │────► api.start.gg
 │   ├─ audit log      (JSONL)          │
 │   └─ status page    :29473           │◄──── TO's phone or laptop
 └──────────────────────────────────────┘

 Stream overlay ──► api.start.gg  (unchanged; reads the set assigned to the stream)
```

LazyTO has three parts, each in its own repository:

| Part | Repository | Runs on |
|------|------------|---------|
| Kiosk module `tournament.bin` | fork of doldecomp/melee | the Wii's PowerPC, inside stock Melee 1.02 |
| LazyTO Nintendont | fork of project-slippi/Nintendont | the Wii's ARM core |
| Relay `lazyto-relay` | this repository | a Raspberry Pi |

### Kiosk module (tournament.bin)

Melee has no networking. The kiosk is a small position-fixed module, `tournament.bin` (about 81 KB), built from `kiosk/` in this repo by `kiosk/tools/build_module.py` against the unmodified Melee decompilation. The Wii runs the venue's stock Melee 1.02 disc image. At boot the loader copies the module to the top of MEM1 and applies a few dozen word patches (scene and menu table pointers, two branch hijacks, one hijacked menu row). Nothing else about the game changes, so Slippi recording, USB hotswap and the venue's own codesets (UCF, stage striking and so on) work exactly as on any Slippi Nintendont.

The module file format:

| Field | Meaning |
|-------|---------|
| `"TMOD"`, version 1 | magic |
| load address | `0x817E0000` |
| blob length, patch count | sizes |
| guard `{0x8016D800, 0x7C0802A6}` | a word that is only there in stock 1.02 |
| patches `{addr, u32}` | the hook table (`kiosk/tools/module_hooks.txt`) |
| blob | `.text`, `.rodata`, `.data`, zeroed `.bss` |

A loader refuses the file unless the guard word is in RAM and the arena top is above the load address. After copying it writes the load address to `0x80000034`, which Melee's `OSInit` adopts as the arena top, so the module sits above the heap. The build refuses any patch address that a venue codeset also writes.

Source files, under `kiosk/src/`:

| File | Role |
|------|------|
| `melee/mn/mntourney.c` | the set list menu, name filter, confirm and error views, kiosk defaults (rules, unlocks, legal stages) |
| `melee/lb/lbtourney.c` | the current set and its games, CSS binds, port claim, handwarmer, auto-score, CSS and in-match overlays |
| `melee/lb/lbbuttonglyph.c` | button icons drawn as glyphs in a module-owned font slot |
| `melee/lb/lbwordmark.c` | the LazyTO wordmark texture |
| `melee/lb/lbmodule_glue.c` | vanilla statics the module reads, boot hook, menu colour |
| `melee/lb/lbrelayexi.c` | the EXI driver that talks to the relay device |

#### Menu flow

The Wii boots straight into the set list. The menu hijacks the main menu's Trophies row, and B from the list shows the vanilla main menu.

| View | What it shows |
|------|---------------|
| Searching | LOOKING FOR THE RELAY until the host has heard a beacon. After 10 s: NO RELAY FOUND. A searches again. |
| Loading | LOADING SETS, plus station number and the relay's address and port. |
| Set list | Two panes. Left: "tag VS tag" rows grouped under round names, earliest round first. Right: the highlighted set (round, tags, best of, A START or A RESUME). |
| Confirm | START THIS SET? A starts it and opens the CSS. B goes back. |
| Error | NO LINK TO THE RELAY or THE RELAY SAID NO, the relay's message, A retries. |

Set list controls: up/down move, left/right page, L/R first-letter filter, X jumps to this station's set, Y refreshes, Z enters friendlies (CSS with no set), B goes to the main menu.

#### CSS controls (when a set is current)

| Input | Action |
|-------|--------|
| L + R, hold 1 s | Port claim: "I am the player named first on the set". The other human port becomes the second player. A hold from the other controller moves the claim. |
| L + R + B, hold 1 s | Clear the claim |
| Z + C-stick left | The player shown on the left wins a game |
| Z + C-stick right | The player shown on the right wins a game |
| Z + C-stick down | Undo the last game |
| Z + C-stick up, hold 1 s | End the set (needs a decided score) |
| Z + X | Next game is a handwarmer (not scored); starts on Battlefield |

Any controller port can drive these. A trigger counts at its click or any analog press.

The score lives in the CSS's own rules banner, for example `MANGO P1  2 - 1  P3 ZAIN`. The banner is also the status: yellow digits, amber while a report is in flight, green after SCORE SENT, red after a failure (alternating with SEND FAILED - TELL THE TO). Until the players are placed it alternates with HOLD L+R IF YOU ARE &lt;name&gt;.

#### Auto-score

When a game ends by KO or time-out with exactly two human players, the module reads the match standings: winner (more stocks, then less damage), each player's character, stocks left and costume, and the stage. It appends the game and sends REPORT_SCORE on the first CSS frame back. An exact tie or a no-contest is left to the players. Who is who comes from the L + R port claim (the player named first holds it on the CSS); a game played without one is left to be scored by hand. The module does not touch Melee's nametags. Hand-scored games (C-stick) carry the winner only.

#### EXI device contract

The module talks to a fake EXI device that the host implements.

| Item | Value |
|------|-------|
| Address | channel 1, device 0, frequency 4 |
| Request | command word `EXI_RELAY_REQ << 24`, then `relay_hdr` + payload |
| Poll | command word `EXI_RELAY_POLL << 24`, then a 4096-byte DMA read: `exi_poll_hdr`, `relay_hdr`, `relay_resp`, payload |
| Game timeout | 5 s; any poll state other than DONE or ERROR means "still waiting" |

The game never blocks. It polls once per frame. All buffers are static. The command values (0xF0, 0xF1) sit clear of Slippi's EXI command space.

### LazyTO Nintendont

LazyTO Nintendont is Slippi Nintendont plus four additions in the kernel. Its loader is otherwise the venue's normal Slippi Nintendont.

1. **Config.** At boot it reads `sd:/tournament.cfg` (see [Deployment](#deployment)). A missing or bad file sets a poll flag and every request answers `ST_INTERNAL` "no tournament.cfg".
2. **Module loader.** For Melee NTSC 1.02 it loads `sd:/tournament.bin` after the Slippi core codes and before the game starts, with the guard and arena checks above. A missing file leaves a plain Slippi Nintendont.
3. **Relay EXI device.** On a request it copies the buffer, stamps the station number (and the stream flag on START_SET) from `tournament.cfg`, writes `relay_auth` with the secret, and hands off to a dedicated kernel thread. That thread does connect, send, receive and close with a 3 s budget. The EXI handler never blocks, because the game is frozen until the kernel's main loop acks the transfer.
4. **Discovery.** While idle, the relay thread listens on UDP 29471 for the relay's beacon and takes the source address plus the advertised TCP port. If it hears nothing it sends a beacon request to UDP 29472 and gets a unicast beacon back.
5. **Telemetry.** Once it knows the relay, the kernel sends UDP datagrams to port 29472: log lines (`TM_LOG`), a status record at least every 5 s (`TM_STATUS`: module load result, patch count, load address), and a crash report (`TM_CRASH`) when the game takes an unhandled exception.

The kernel interprets nothing beyond the header length. One buffer, one thread, four states, no retries.

### Relay

The relay is a Node 22 / TypeScript service on the Pi, `lazyto-relay`. It holds all state and is the only thing that talks to start.gg.

| Module | Responsibility |
|--------|----------------|
| `generated/wire.ts` | Struct encode/decode, generated from `protocol.yaml` |
| `tcp.ts` | TCP server on 29470, one request per connection, dispatch by command |
| `beacon.ts` | Discovery beacon on UDP 29471 |
| `telemetry.ts` | Station telemetry and beacon requests on UDP 29472 |
| `resolve.ts` | Finds the tournament, event and stream ids at startup |
| `cache.ts` | Pending-set cache, one `event.sets` query every 20 s |
| `startgg.ts` | GraphQL client, rate limiter, retry on 5xx only |
| `state.ts` | In-memory station to set map |
| `audit.ts` | Append-only JSONL log |
| `status.ts` | Status page on 29473 |
| `admin.ts` | The status page's TO actions: free a station, per-set best-of |
| `chars.ts` | Melee character id to start.gg character id |
| `stages.ts` | Melee stage id to start.gg stage id |
| `config.ts` | Loads and validates the config |

## Wire protocol

[`protocol.yaml`](../protocol.yaml) is the source of truth. `tools/gen_protocol.py` generates `generated/wire.ts` (for the relay) and the C header `relay_proto.h` in two copies, `kiosk/include/` for the module and `Nintendont/kernel/` for the kernel, and CI fails on drift. This section is a summary.

- TCP, one connection per request: request, response, close.
- All integers big-endian. Strings are ASCII, NUL-padded, not terminated when full.
- Every message is a fixed-size struct with a version byte. No JSON, no varints.
- The host writes a 20-byte `relay_auth` (`'M','K'`, pad, 16-byte secret) before each request. The game never sees it. A missing or wrong secret gets `ST_BAD_SECRET` and nothing happens.
- Every request and response starts with an 8-byte `relay_hdr` (`'M','T'`, version, command, station, length). Every response then has a 32-byte `relay_resp` (status, 30-character message for the menu).

| Command | Request | Relay does |
|---------|---------|------------|
| `CMD_LIST_SETS` | nothing | Returns up to 56 `set_entry` rows (72 bytes each), this station's set first, then earliest round first |
| `CMD_START_SET` | set id, stream flag | Checks, then `markSetInProgress`, then `assignStream` if stream |
| `CMD_REPORT_SCORE` | set id, game list | `reportBracketSet` with game data and no winner. Full overwrite every time |
| `CMD_END_SET` | set id, game list | Derives the winner, `reportBracketSet` with winner, clears the station |
| `CMD_ABANDON_SET` | set id | `resetSet` if no games are reported, else "ask TO" |

The game list is up to five 8-byte `game_result` records: winner slot, both characters, stage, and each player's stocks and costume. Sending the whole list every time makes reports idempotent and makes undo trivial. Zero or unknown values are left out of the start.gg call, never rejected.

The game always sends station 0 and stream 0. The host stamps both from `tournament.cfg`, and the relay trusts what it receives.

UDP messages (not on the TCP wire):

| Message | Port | Direction |
|---------|------|-----------|
| `relay_beacon` (12 bytes) | 29471 | relay broadcasts every 2 s to each interface's directed broadcast address |
| beacon request (a `relay_beacon` with zero port and event) | 29472 | station to relay; the relay answers with a unicast beacon |
| `relay_auth` + `telemetry_hdr` + payload | 29472 | station to relay; never answered |

### Status codes

| Status | Meaning |
|--------|---------|
| `ST_OK` | Done |
| `ST_BAD_VERSION` | Protocol version mismatch |
| `ST_SET_NOT_FOUND` | Not in the cache |
| `ST_SET_TAKEN` | Claimed by another station, or started by hand on start.gg |
| `ST_NOT_STREAM` | Stream flag from a station that is not the stream station |
| `ST_STARTGG_ERROR` | start.gg refused or failed; see the status page |
| `ST_RATE_LIMITED` | No rate-limit token within 2 s |
| `ST_INTERNAL` | Anything else, with a message ("finish current set first", "ask TO", "no tournament.cfg") |
| `ST_BAD_SECRET` | `relay_auth` missing or wrong |

## Relay internals

### Startup and event discovery

Startup validates every config field and exits non-zero on any problem. There are no defaults.

| Field | Meaning |
|-------|---------|
| `startggEndpoint` | GraphQL URL (the real API, or `test/fake-startgg.ts` in a rehearsal) |
| `token` | start.gg token with admin rights on the tournament |
| `tournament` | a start.gg short URL, or a full slug `tournament/<slug>` |
| `eventName` | matched case-insensitively against the tournament's Melee singles events |
| `streamName` | the stream to assign the stream station's sets to |
| `weeklyNamePrefix` | `""` for none; otherwise the numbered-weekly fallback below |
| `secret` | shared secret, 8 to 16 of `A-Z a-z 0-9 - _` |
| `adminPassword` | the TO's password for the status page's actions, 8 to 64 printable characters, never the same as `secret` |
| `streamStation` | the station number of the stream setup |
| `setFormat` | `startgg`: each set's best-of as start.gg has it; `top8q`: Bo3, then Bo5 from the top-8 qualifiers (Winners Quarter-Final and the losers round two before Losers Quarter-Final) onward, worked out from the bracket's round numbers per phase: with a Top 8 phase, the last winners and losers rounds of the phase before it are the qualifiers. In-person events have no per-round setting on start.gg, so every set there says 5. |
| `tcpPort`, `httpPort` | 29470, 29473 |
| `auditDir` | where audit logs go |

`npm run push` (`scripts/push.ts`) writes the file from `.env`. The relay turns names into ids once at startup, because ids change every week and names do not.

- **Short URL:** found among the token owner's admin tournaments. A TO who moves the short URL to each week's tournament needs no weekly push.
- **Numbered-weekly fallback:** if `weeklyNamePrefix` is set and no admin tournament carries the short URL, the relay takes the admin tournament named `<prefix><number>` whose start is nearest to now, within 30 days (for example a weekly named "LazyTO Weekly #N"). The startup log says which rule matched.
- **Full slug:** looked up directly. This is the only way to reach an unpublished tournament.

The event is the one Melee singles event whose name contains `eventName`. The stream is the one named `streamName`. Zero or several matches is a startup failure that lists what was found. A restart re-resolves. The status page header names the tournament and event, so a stale week is visible.

### Set cache

The cache refreshes every 20 s with one `event.sets(filters: {state: [1,2]})` query. Sets in an unstarted pool have string "preview" ids that do not fit the protocol's 32-bit set id, so the cache drops them and the status page warns "start all pools on start.gg".

### Station state

```
        LIST_SETS            START_SET ok
 IDLE ─────────────► IDLE ──────────────► IN_SET
   ▲                                        │
   │       END_SET ok / ABANDON_SET ok      │
   └────────────────────────────────────────┘
```

A station in `IN_SET` that lists again (after a reboot) gets its own set first with state 1. Selecting it is a no-op resume. The relay only moves a start.gg set forward (1 not started, 2 in progress, 3 complete), plus `resetSet` for an abandon before any games.

### start.gg calls

| Relay action | GraphQL |
|--------------|---------|
| startup (short URL) | `currentUser.tournaments(filter: {tournamentView: "admin"})`, paged |
| startup | `tournament(slug)` → events, streams |
| cache refresh | `event(id).sets(filters: {state: [1,2]}, perPage: 100)` |
| START_SET | `markSetInProgress`, then `assignStream` on the stream station |
| REPORT_SCORE | `reportBracketSet(setId, gameData)` |
| END_SET | `reportBracketSet(setId, winnerId, gameData)` |
| ABANDON_SET | `resetSet(setId)` |

Per game, characters go out as `selections` and the stage as `stageId`. Stocks and costume go out as `entrant1Score`/`entrant2Score` = `(costume + 1) * 100 + stocks`, which start.gg shows as stocks and set pages render as colour plus stock icons.

`resetSet` does not clear a stream assignment. After an abandon on the stream station, the TO clears the assignment by hand.

### Rate limit and retries

A token bucket allows 70 calls per 60 s, under start.gg's 80. A request waits up to 2 s for a token, else `ST_RATE_LIMITED`. 12 stations need about 15 calls per minute, so the limiter is a guard, not a throttle. A start.gg 5xx is retried twice (1 s, then 3 s). Nothing else retries anywhere.

### Audit log

Every request, response, refusal and upstream call is appended as one JSON line to `<auditDir>/<eventId>.jsonl`. On restart the relay replays claim, score and release events against the live cache, so stations keep their sets.

### Status page

A server-rendered page on port 29473, refreshed every 5 s, readable on a phone. No client script. Anyone on the network can view it; its actions need `adminPassword` (HTTP Basic auth, any user name), and a POST from another site is refused.

- Per station: set, score, last action and its age, the status the player saw, and the station's telemetry (module state, recent log lines, last crash).
- Every failed start.gg call with its message, until the TO clicks "ack". Ack only hides the flag.
- **Free a station** (`src/admin.ts`). A Wii that died mid-set keeps its claim, and the set stays in progress on start.gg, where no other Wii may take it. Free asks first, naming the set and the score it discards, then resets the set on start.gg (the call a Wii's abandon makes) and drops the claim: the set is back on every Wii's list at 0-0. The score cannot move with it, because the protocol never sends a Wii earlier games.
- **Waiting sets** with their best-of and a button to switch Bo3/Bo5 or go back to `setFormat`'s answer. Only for sets no station holds, since a Wii learns best-of when it starts a set. Overrides are `bestof` events in the audit log and replay at startup.
- Footer: event, cache size, cache age (warns after 60 s), upstream call rate, last refresh error, the preview-set warning, beacon targets and send errors, and refused requests (wrong secret, source address, claimed station).

## Error handling

| Failure | Where seen | Behaviour |
|---------|------------|-----------|
| No `tournament.cfg` | Wii | "no tournament.cfg". Station unusable until fixed. |
| Wrong or missing secret | Wii + status page | RELAY SECRET MISMATCH. Counted on the status page. |
| No beacon heard | Wii | NO RELAY FOUND after 10 s. A searches again. |
| Relay unreachable | Wii | Times out after 3 s. A retries. TO checks the Pi and network. |
| Set taken | Wii | "started on station N". Player picks again. |
| `assignStream` fails after `markSetInProgress` | Wii + status page | Set is in progress but not on stream. TO assigns it by hand and acks. |
| start.gg 5xx | Relay | Retry twice, then `ST_STARTGG_ERROR`; row flagged. Retrying later is safe. |
| start.gg 4xx (for example the TO already reported the set) | Wii | "start.gg rejected - ask TO". No retry. The station clears on the next list. |
| Rate limited | Relay | `ST_RATE_LIMITED` after 2 s. |
| Wii reboot mid-set | Wii | The set is offered first; resume is a no-op. The CSS shows 0-0 until the next report, which overwrites in full. |
| Relay restart | Relay | Audit log replay; sets no longer pending are dropped. |
| Game crash | Status page | The kernel sends a crash report with registers and a short stack. |

## Deployment

### Wii (each station)

- The stock Melee 1.02 disc image on USB or SD, as at any Slippi local.
- LazyTO Nintendont as the loader. The venue's own Nintendont settings (UCF, tournament codes, stages, audio) stay as they are.
- On the SD card root:
  - `tournament.bin`: the kiosk module, the same file on every card. Updating the kiosk means replacing this file.
  - `tournament.cfg`: per card.

```
station=3
stream=0
secret=<the relay's secret>
```

`stream=1` goes on exactly one card. The relay refuses a stream START_SET from any station other than `streamStation`, so a mis-copied card cannot take over the stream. There is no relay address: stations find the relay by its beacon. Step by step: [wii-setup.md](wii-setup.md).

### Pi

A Raspberry Pi (5, 4 or Zero 2 W) on Raspberry Pi OS Lite 64-bit, on the venue Wi-Fi (Ethernet works the same). Step by step: [pi-setup.md](pi-setup.md).

| File | Role |
|------|------|
| `scripts/push.ts` (`npm run push`) | Run from a clone on any OS with Node 22 and ssh: builds, writes `config.json` from `.env`, copies the bundle, runs the installer over ssh. Only needed to change the config or push a dev build; code updates itself (deploy/update.sh). |
| `deploy/install.sh` | On the Pi: pinned Node 22 in `/opt/node`, Wi-Fi power saving off, system user `relay`, code in `/opt/lazyto`, config in `/etc/lazyto/config.json`, installs and restarts the unit. Idempotent. |
| `deploy/lazyto-relay.service` | systemd unit, runs as `relay`, restarts on failure, waits for time sync. |
| `deploy/uninstall.sh` | Removes what install.sh added; audit logs are kept unless `--purge`. |
| `deploy/add-wifi.sh` | Saves another Wi-Fi network. |
| `scripts/smoke.ts` | One LIST_SETS and a status page fetch against a running relay. |

Logs go to journald. Audit logs go to `/var/lib/lazyto/<eventId>.jsonl`.

### Network

The Pi, the Wiis and the TO's phone must share one network. Addresses do not matter, because stations find the relay by its beacon. Wiis should use Ethernet where possible (Wii Wi-Fi is 802.11g). A guest Wi-Fi with client isolation blocks Wii-to-Pi traffic: check once with `scripts/smoke.ts` from a laptop on the same network.

The secret travels in plain text. It keeps passers-by out, not someone capturing the Wi-Fi traffic.

### Per-tournament checklist

1. Power on the Pi (or restart the relay). Check the status page header names tonight's tournament and event.
2. Start every pool and phase on start.gg. Unstarted pools have preview sets the relay cannot show; the status page warns until this is done.
3. Check each card's station number matches the station label, and exactly one card has `stream=1`.
4. Boot one Wii and confirm the set list loads.

## Development and testing

- **Protocol first.** Change `protocol.yaml` and run `python tools/gen_protocol.py`, which writes `generated/wire.ts` and both header copies. `tools/check_protocol.py` regenerates them in memory and fails on any difference; the generator itself refuses implicit padding and any size that disagrees with `protocol.yaml`.
- **Relay tests.** `npm test`: codec round-trips, the character and stage tables, and integration tests against `test/fake-startgg.ts` covering every row of the error table. Tests never touch the real API.
- **Load.** `scripts/sim-wii.ts` drives 12 fake stations through list, start, score and end for 10 minutes and checks the upstream call rate.
- **Real API.** Only `scripts/probe.ts` (read-only) and `scripts/reset-bracket.ts` (the test event only) touch start.gg, using `.env`.
- **Kiosk.** A development setup can load `tournament.bin` into an emulator that implements the same EXI device, so menu work does not need a Wii. Hardware is the final check.
- **CI.** GitHub Actions runs `npm test` and the build on every push to main and on pull requests.

## Status

As of 2026-09-30 a real Wii has booted the module, found the relay by beacon (including the beacon-request path), sent the secret and loaded the set list. Not yet run on hardware: the full set lifecycle, `.slp` recording alongside the module, and venue stage-striking behaviour. See [changelog.md](changelog.md).
