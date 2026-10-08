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
 │   + lazyto_kiosk.bin, loaded at boot        │
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
| Kiosk module `lazyto_kiosk.bin` | fork of doldecomp/melee | the Wii's PowerPC, inside stock Melee 1.02 |
| LazyTO Nintendont | fork of project-slippi/Nintendont | the Wii's ARM core |
| Relay `lazyto-relay` | this repository | a Raspberry Pi |

### Kiosk module (lazyto_kiosk.bin)

Melee has no networking. The kiosk is a small position-fixed module, `lazyto_kiosk.bin` (about 81 KB), built from `kiosk/` in this repo by `kiosk/tools/build_module.py` against the unmodified Melee decompilation. The Wii runs the venue's stock Melee 1.02 disc image. At boot the loader copies the module to the top of MEM1 and applies a few dozen word patches (scene and menu table pointers, two branch hijacks, one hijacked menu row). Nothing else about the game changes, so Slippi recording, USB hotswap and the venue's own codesets (UCF, stage striking and so on) work exactly as on any Slippi Nintendont.

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
| Searching | Waits for the beamer and the relay, in this order: WAITING FOR THE BEAMER (the kernel's "starting"), THIS BEAMER HAS NO NUMBER (until its button is pressed), BEAMER JOINING THE WI-FI (up to 60 s), LOOKING FOR THE RELAY (up to 10 s, then BEAMER HEARS NO RELAY). Anything no wait cures is an error at once. |
| Loading | LOADING SETS, plus station number and the relay's address and port. |
| Set list | Two panes. Left: "tag VS tag" rows grouped under round names, earliest round first. Right: the highlighted set (round, tags, best of, A START or A RESUME). |
| Confirm | START THIS SET? A starts it and opens the CSS. B goes back. |
| Error | What is wrong, picked by code from the host's poll header ([kiosk.md](kiosk.md)): the beamer (none, its reason, no number, no secret, its Wi-Fi), the relay (not heard, no link, timeout), or the relay's own answer (RELAY SECRET MISMATCH, TWO BEAMERS ARE STATION n, THE RELAY SAID NO with its message). A retries. |

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

The score lives in the CSS's own rules banner, for example `MANGO P1  2 - 1  P3 ZAIN`. The banner is also the status: yellow digits, amber while a report is in flight, green after SCORE SENT, red after a failure (alternating with SEND FAILED - TELL THE TO). It alternates with WAITING FOR THE BEAMER while the beamer restarts, with REPLAYS NOT SAVING - TELL THE TO when the beamer's card is full or faulty, and until the players are placed with HOLD L+R IF YOU ARE &lt;name&gt;.

#### Auto-score

When a game ends by KO or time-out with exactly two players in it, both human, the module reads the match result after vanilla's VS exit: the winner the game itself decided (MatchEnd `winners[]` when `n_winners` is 1), each player's character, stocks left and costume, and the stage. It appends the game and sends REPORT_SCORE on the first CSS frame back.

The cards run Slippi's Gameplay: Both, which is LGL (UnclePunch's ledge-grab limit) plus the anti-wobbling code. On a time-out LGL takes the player ahead on stocks, then on lower percent. If that player is over the ledge-grab limit (more than 45 ledge grabs at 8:00; the limit scales with the time limit) and the other is not, the other player wins, whatever the stocks or percent. That includes an exact stock and percent tie with one player over. The banner then reads `GAME n TO <tag> - LGL`, and the game carries no stocks, so start.gg gets no per-game score for it (the loser may have more stocks left than the winner); characters, stage and costumes still go.

A tie goes to LGL's tiebreak game: 1 stock each at 0% for 3:00 (its own time-out uses a limit of 17 grabs), played in vanilla's Sudden Death scene. A tie is an exact stock and percent tie at a time-out with neither or both players over the limit, or a double KO on the last stocks. The tied game is not appended. The module also wraps the Sudden Death scene's exit (`ptr 0x803DA968`, vanilla `gm_Scene_Vs_OnExit`) and scores the tiebreak game like any other, so the set gets one game for the two. That game carries the tied game's replay and no stocks (its 1 and 0 would contradict that replay, whose stocks are tied), so start.gg gets no per-game score for it. A tiebreak that ties again goes to the results screen, not another tiebreak, and is left to the players (`TIE - SCORE IT MANUALLY`).

Also left to the players:

- a no-contest (`NO CONTEST - NOT SCORED`);
- no winner, when both players are over the limit and one is ahead (`BOTH OVER LGL - SCORE BY HAND`);
- a time-out tied on stocks but not on percent, which only a card with Gameplay Off or Wobbling produces (`LGL OFF - SCORE BY HAND`); vanilla Sudden Death follows and is not scored;
- a Team battle (`TEAMS ON - SCORE BY HAND`): the game decides it by team standings, which LGL does not touch;
- a game with a CPU or more than two players (`AUTO-SCORE NEEDS 2 PLAYERS`).

Who is who comes from the L + R port claim (the player named first holds it on the CSS); a game played without one is left to be scored by hand. The module does not touch Melee's nametags. Hand-scored games (C-stick) carry the winner, the claim's ports when known, and the replay id below; no characters, stage, stocks or costumes.

#### Recording only set games

The module wraps the VS scene's on_enter (`ptr 0x803DA950`, vanilla `gm_Scene_Vs_OnEnter`, which sends Slippi's Game Start). For a game of the current set that is not a handwarmer, on a host with the gate (`host_build` 7 or later), it sets `record_gate.want` in MEM2 around the vanilla call, and the kernel records that match only. Friendlies, handwarmers, matches from the vanilla main menu (B from the set list clears the set) and LGL's tiebreak game leave no replay. Each game appended to the set gets the replay id of the set's last match if the kernel opened a file for it and no earlier game took it, else 0; so a tiebreak game reports its main game's replay. Dolphin has no gate and reports 0. Details: [kiosk.md](kiosk.md), The record gate.

#### EXI device contract

The module talks to a fake EXI device that the host implements.

| Item | Value |
|------|-------|
| Address | channel 1, device 0, frequency 4 |
| Request | command word `EXI_RELAY_REQ << 24`, then `relay_hdr` + payload |
| Poll | command word `EXI_RELAY_POLL << 24`, then a 4096-byte DMA read: `exi_poll_hdr`, `relay_hdr`, `relay_resp`, payload |
| Game timeout | 5 s; any poll state other than DONE or ERROR means "still waiting" |
| Record gate | `record_gate`, 64 bytes of MEM2 at PPC `0xD3003200`: line 0 (`want`) written by the module, line 1 (`start_seq`, `file_seq`, `file_id`) by the kernel; u32 accesses only, and only when `host_build` is at least 7 |

The game never blocks. It polls once per frame. All buffers are static. The command values (0xF0, 0xF1) sit clear of Slippi's EXI command space.

### LazyTO Nintendont

LazyTO Nintendont is Slippi Nintendont plus these additions in the kernel (protocol v2: [protocol-v2.md](protocol-v2.md), Kernel). Its loader is otherwise the venue's normal Slippi Nintendont. The kernel opens no IOS socket and reads no settings file of its own: the beamer is the Wii's only link, and the station number and the secret live on the beamer. Slippi's own network code (console mirroring) is untouched; the loader's Network option means mirroring only.

1. **The beamer.** USB is the replay drive only with Slippi replays on and the game on SD; the relay thread then reads the beamer's hello (the mailbox sector right after its replay partition) about once a second, and every poll's `exi_poll_hdr` carries what it says: no beamer and why (`no_beamer_reason`, "starting" for about 45 s after boot or a USB change), no station number, no secret, a stale beacon, the beamer's Wi-Fi and card. A hello below mailbox v2 or firmware build 2 is old firmware.
2. **Module loader.** For Melee NTSC 1.02 it loads `sd:/lazyto_kiosk.bin` after the Slippi core codes and before the game starts, with the guard and arena checks above. A missing file leaves a plain Slippi Nintendont.
3. **Relay EXI device.** On a request it copies the buffer, stamps the station number from the beamer's hello, and hands off to a dedicated kernel thread. That thread writes the request to the beamer's request sector (no `relay_auth`: the beamer puts its own in front) and polls the response sector, within a 3 s budget that includes the wait for the USB lock. Every failure is `RELAY_ERROR` with a code in `exi_poll_hdr.last_fail` (the beamer's `BR_*` or the kernel's `LF_*`), and the kiosk picks the words. The EXI handler never blocks, because the game is frozen until the kernel's main loop acks the transfer.
4. **Telemetry.** Once the beamer has a number, a secret and a relay, the kernel writes datagrams to the beamer's telemetry sector, which the beamer sends to UDP 29472: log lines (`TM_LOG`), a status record at least every 5 s (`TM_STATUS`: module load result, patch count, load address), and a crash report (`TM_CRASH`) when the game takes an unhandled exception.
5. **Record gate.** At each Slippi Game Start (inside the EXI DMA handler, no lock, no wait) the kernel reads the module's `want` word and keeps the choice. The replay writer opens a file only for a match the module asked for (every match when no module is loaded), drains a skipped match at once, and publishes which Game Start it opened a file for and that file's id. It syncs each recording once after its first data block, and a match that never sent Game End no longer costs the next one. `RELAY_HOST_BUILD` 7 has the gate.

The kernel interprets nothing beyond the header length. One buffer, one thread, four states, no retries.

### Relay

The relay is a Node 22 / TypeScript service on the Pi, `lazyto-relay`. It holds all state and is the only thing that talks to start.gg.

| Module | Responsibility |
|--------|----------------|
| `app.ts` | The process: web server first, then the night's event by mode (setup, starting, failed, running) |
| `web.ts` | The web server on 29473: routing, password and same-site checks, the shared page style |
| `setup.ts` | Setup wizard and settings page |
| `relay.ts` | The night's relay for one event: cache, state, audit replay, TCP, beacon, telemetry, the beamers, the archive |
| `guard.ts` | One LazyTO per network: another relay's beacon keeps the event from starting |
| `cards.ts` | The SD-card zip, the same for every Wii: the bundle's Wii files plus the loader's settings (`zip.ts` writes it) |
| `generated/wire.ts` | Struct encode/decode, generated from `protocol.yaml` |
| `generated/sjis.ts` | iconv-lite 0.6.3's Shift-JIS tables, generated by `tools/gen_sjis.mjs` for the set archive's display names |
| `tcp.ts` | TCP server on 29470, one request per connection, dispatch by command |
| `beacon.ts` | Discovery beacon on UDP 29471 |
| `telemetry.ts` | Station telemetry and beacon requests on UDP 29472 |
| `resolve.ts` | Finds the tournament, event and stream ids at startup |
| `cache.ts` | Pending-set cache, one `event.sets` query every 20 s |
| `startgg.ts` | GraphQL client, rate limiter, retry on 5xx only; the set archive's two REST reads |
| `state.ts` | In-memory station to set map |
| `audit.ts` | Append-only JSONL log |
| `status.ts` | The status page and the TO's actions on it |
| `admin.ts` | The status page's TO actions: free a station, per-set best-of |
| `chars.ts` | Melee character id to start.gg character id |
| `stages.ts` | Melee stage id to start.gg stage id |
| `config.ts` | The settings file: one field table, strict values, optional fields with defaults |
| `format.ts` | Best-of per set (`setFormat`) |
| `beamer.ts` | Each beamer from its syncs; who holds which station number (duplicates); replay downloads over HTTP |
| `collect.ts` | `CMD_BEAMER_SYNC`: answers each file held, wanted or noted, signs the reply (`sync.ts`), downloads what it wants |
| `rawstore.ts` | The archive folder's replays: `archive.json`, `index.jsonl`, `raw/`, `unmatched/`, resumable parts |
| `archive.ts` | Binds replays to games by replay id and writes one zip per finished set whose games all have one |
| `setzip.ts` | The set zip in Replay Reporter's format, with the values LazyTO reported |
| `slp.ts`, `sjis.ts` | Replay parsing; display names and `startAt` written as Replay Reporter writes them, in its Shift-JIS |
| `names.ts`, `phasegroup.ts` | Replay Reporter's names (templates, characters, stages, sanitize-filename); its phase group facts and set ordinals |

## Wire protocol

[`protocol.yaml`](../protocol.yaml) is the source of truth (version 2, MIT). `tools/gen_protocol.py` generates `generated/wire.ts` (for the relay) and the C header `relay_proto.h` in two copies, `kiosk/include/` for the module and `Nintendont/kernel/` for the kernel, and CI fails on drift. This section is a summary; [protocol-v2.md](protocol-v2.md) is the implementer's guide for each part, the beamer firmware included.

- TCP, one connection per request: request, response, close.
- All integers big-endian. Strings are ASCII, NUL-padded, not terminated when full.
- Every message is a fixed-size struct with a version byte. No JSON, no varints.
- The beamer writes a 20-byte `relay_auth` (`'M','K'`, pad, a 16-byte key derived from the secret in its `CONFIG/config.txt`) before each request it forwards and before its own sync. The key is HMAC-SHA256 keyed with the secret over `LazyTO relay_auth`, cut to 16 bytes: the secret itself never travels, because it signs the sync replies that let a beamer erase (`src/sync.ts`). The Wii never holds the secret. A missing or wrong key gets `ST_BAD_SECRET` and nothing happens.
- Every request and response starts with an 8-byte `relay_hdr` (`'M','T'`, version, command, station, length). Every response then has a 32-byte `relay_resp` (status, 30-character message for the menu).

| Command | Request | Relay does |
|---------|---------|------------|
| `CMD_LIST_SETS` | nothing | Returns up to 56 `set_entry` rows (72 bytes each), this station's set first, then earliest round first |
| `CMD_START_SET` | set id, an unused stream byte | Checks, then `markSetInProgress`, then `assignStream` on the stream station. The reply carries the games the relay holds for the set: none for a new set, the claim's games on a resume after a reboot |
| `CMD_REPORT_SCORE` | set id, game list | `reportBracketSet` with game data and no winner. Full overwrite every time |
| `CMD_END_SET` | set id, game list | Derives the winner, `reportBracketSet` with winner, clears the station |
| `CMD_ABANDON_SET` | set id | `resetSet` if no games are reported, else "ask TO" |
| `CMD_BEAMER_SYNC` | a beamer's inventory and ack questions (frozen layout, its own version 1) | Records the beamer, answers each listed file held, wanted or noted, signs the reply with the secret, and downloads what it wants (see [Replays](#replays)) |

Command 6 (`CMD_GAME_START`, v1) is retired.

The game list is up to five 16-byte `game_result` records: winner slot, both characters, stage, each player's stocks and costume, both entrants' CSS ports and the replay id (the match's Slippi `gameStartTime`, 0 = no replay). Sending the whole list every time makes reports idempotent and makes undo trivial. Zero or unknown values are left out of the start.gg call, never rejected; both stocks 0xFF send no per-game score.

The game always sends station 0. The kernel stamps it from the beamer's number (its hello), and the relay trusts what it receives.

UDP messages (not on the TCP wire):

| Message | Port | Direction |
|---------|------|-----------|
| `relay_beacon` (12 bytes) | 29471 | relay broadcasts every 2 s to each interface's directed broadcast address |
| beacon request (a `relay_beacon` with zero port and event) | 29472 | beamer to relay; the relay answers with a unicast beacon, whatever the request's version |
| `relay_auth` + `telemetry_hdr` + payload | 29472 | beamer to relay, for its Wii; never answered |

The beacon, `relay_auth`, `relay_hdr`, `relay_resp` and the sync are frozen: beamers check the beacon by length and magic only, never by version.

### Status codes

| Status | Meaning |
|--------|---------|
| `ST_OK` | Done |
| `ST_BAD_VERSION` | Protocol version mismatch |
| `ST_SET_NOT_FOUND` | Not in the cache |
| `ST_SET_TAKEN` | Claimed by another station, or started by hand on start.gg |
| `ST_NOT_STREAM` | Not sent any more: the relay decides the stream by station (kept in the protocol) |
| `ST_STARTGG_ERROR` | start.gg refused or failed; see the status page |
| `ST_RATE_LIMITED` | No rate-limit token within 2 s |
| `ST_INTERNAL` | Anything else, with a message ("finish current set first", "ask TO", "no station file") |
| `ST_BAD_SECRET` | `relay_auth` missing or wrong |
| `ST_DUP_STATION` | Another beamer already plays as this station number: this one, the newcomer, is refused |

## Relay internals

### Startup and event discovery

The web server on 29473 starts first and stays up (`src/app.ts`). The relay is then in one of four modes:

| Mode | When | The page shows |
|------|------|----------------|
| setup | no valid settings yet | the setup wizard, guarded by a one-time setup code |
| starting | settings saved | "finding tonight's event" |
| failed | the event couldn't be found or started: bad token, a short URL on no tournament, start.gg or the internet down, the clock not set yet, another LazyTO relay on the network | the reason, with Retry; it also retries after 30 s, 60 s, then every 2 min |
| running | the event resolved and the cache loaded | the status page; TCP, beacon and telemetry are up |

The settings live in `/var/lib/lazyto/config.json` (`src/config.ts`), written by the setup page:

| Field | Meaning |
|-------|---------|
| `token` | start.gg token with admin rights on the tournament |
| `tournament` | a start.gg short URL, or a full slug `tournament/<slug>` |
| `eventName` | matched case-insensitively against the tournament's Melee singles events |
| `secret` | the Wii secret, 8 to 16 of `A-Z a-z 0-9 - _`, generated on the first save |
| `adminPassword` | the TO's password for the settings and the status page's actions, 8 to 64 printable characters, never the same as `secret` |
| `weeklyNamePrefix` | optional, `""`: the numbered-weekly fallback below, derived from the chosen tournament's name |
| `streamName` | optional, `""` for no stream: the stream the stream station's sets go on |
| `streamStation` | optional, 1: the station number of the stream setup |
| `setFormat` | optional, `startgg`: each set's best-of as start.gg has it; `top8q`: Bo3, then Bo5 from the top-8 qualifiers (Winners Quarter-Final and the losers round two before Losers Quarter-Final) onward, worked out from the bracket's round numbers per phase: with a Top 8 phase, the last winners and losers rounds of the phase before it are the qualifiers. In-person events have no per-round setting on start.gg, so every set there says 5. |

Values are checked strictly. Every field beyond the first five is optional with a default, and unknown fields are ignored, so a newer or older build always accepts the file and an auto-update never stalls a Pi. The ports (29470, 29473) and paths are fixed. The relay turns names into ids at each start, because ids change every week and names do not.

- **Short URL:** found among the token owner's admin tournaments. A TO who moves the short URL to each week's tournament changes nothing on the relay.
- **Numbered-weekly fallback:** if `weeklyNamePrefix` is set and no admin tournament carries the short URL, the relay takes the admin tournament named `<prefix><number>` whose start is nearest to now, within 30 days (for example a weekly named "LazyTO Weekly #N"). The startup log says which rule matched.
- **Full slug:** looked up directly. This is the only way to reach an unpublished tournament; the setup page takes its link.

The event is the one Melee singles event whose name contains `eventName`. The stream is the one named `streamName`. Zero or several matches is a failed start that lists what was found. Saving settings applies them in place: the event stops and starts again, and claims come back from the audit log. The status page header names the tournament and event, so a stale week is visible.

### Set cache

The cache refreshes every 20 s with one `event.sets(filters: {state: [1,2]})` query. Sets in an unstarted pool have string "preview" ids that do not fit the protocol's 32-bit set id, so the cache never lists them. When a preview set has both entrants (typically a top 8 phase nobody started), the cache starts its pool on start.gg, once per pool per run; the pool's sets come back with numeric ids on the next refresh. If start.gg refuses, the status page warns "start it on start.gg" and the relay does not try again.

### Station state

```
        LIST_SETS            START_SET ok
 IDLE ─────────────► IDLE ──────────────► IN_SET
   ▲                                        │
   │       END_SET ok / ABANDON_SET ok      │
   └────────────────────────────────────────┘
```

A station in `IN_SET` that lists again (after a reboot) gets its own set first with state 1. Selecting it is a resume with no upstream call, and the reply hands the Wii the set's games as last reported, so it carries on from them. The relay only moves a start.gg set forward (1 not started, 2 in progress, 3 complete), plus `resetSet` for an abandon before any games.

### start.gg calls

| Relay action | start.gg |
|--------------|----------|
| startup (short URL) | `currentUser.tournaments(filter: {tournamentView: "admin"})`, paged |
| startup | `tournament(slug)` → events, streams |
| startup | REST `GET /tournament/<slug>?expand[]=event` → `locationDisplayName`, the events (for the set archive) |
| cache refresh | `event(id).sets(filters: {state: [1,2]}, perPage: 100)` |
| cache refresh, ready preview set | `markSetInProgress(previewId)`, then `resetSet(realId)`: starts the pool |
| START_SET | `markSetInProgress` → the entrants and their participants (`id gamerTag prefix player { user { genderPronoun } }`), then `assignStream` on the stream station |
| START_SET, after the claim | REST `GET /phase_group/<id>?expand[]=sets&expand[]=entrants&expand[]=seeds&bustCache=true` (for the set archive; the Wii does not wait for it) |
| REPORT_SCORE | `reportBracketSet(setId, gameData)` |
| END_SET | `reportBracketSet(setId, winnerId, gameData)` → the set's `completedAt` and `stream { id streamName streamSource }` |
| ABANDON_SET | `resetSet(setId)` |

The two REST reads are the requests Replay Reporter for Slippi makes, without the token, to the
origin of the GraphQL endpoint (`https://api.start.gg`): GraphQL has none of what they give the set
archive ([redesign.md](redesign.md#the-zip-and-lucky-stats)). They are undocumented, and whether
they answer for an unpublished tournament has not been checked yet.

Per game, characters go out as `selections` and the stage as `stageId`. Stocks and costume go out as `entrant1Score`/`entrant2Score` = `(costume + 1) * 100 + stocks`, which start.gg shows as stocks and set pages render as colour plus stock icons.

`markSetInProgress` on a preview id starts the whole pool and answers with the set's new numeric id; the pool's rounds are renumbered from 1. `resetSet` answers "Set not found" for a preview id (probe, 2026-10-02).

`resetSet` does not clear a stream assignment. After an abandon on the stream station, the TO clears the assignment by hand.

### Rate limit and retries

A token bucket allows 70 GraphQL calls per 60 s, under start.gg's 80. A request waits up to 2 s for a token, else `ST_RATE_LIMITED`. 12 stations need about 15 calls per minute, so the limiter is a guard, not a throttle. The REST reads (one per START_SET) take no token. A start.gg 5xx, GraphQL or REST, is retried twice (1 s, then 3 s). Nothing else retries anywhere.

### Audit log

Every request, response, refusal and upstream call is appended as one JSON line to `<auditDir>/<eventId>.jsonl`. On restart the relay replays claim, score and release events against the live cache, so stations keep their sets.

### Beamers

Every Wii request and telemetry datagram arrives from its beamer's address, and each beamer's own
sync says which beamer (its `station_id`, from its MAC) is at that address (`src/beamer.ts`).
There is no beamer configuration and no announce.

- **Duplicates.** The relay remembers which beamer last used each station number. Another beamer
  using the same number within 15 s is the newcomer: its Wii's requests get `ST_DUP_STATION`
  ("two beamers are station n") and its telemetry is dropped and counted, until one is renumbered
  or the holder falls silent. The station already playing keeps playing. Two addresses whose syncs
  name one `station_id` are one beamer. A sync is never refused. A number another beamer takes
  over after its holder fell silent (a beamer replaced mid-event) is noted on the status page for
  10 minutes; each game's replay is still fetched from the beamer it was played through.
- **One LazyTO per network** (`src/guard.ts`). Beamers follow the last beacon they heard, so the
  relay listens on the beacon port for any other relay's beacon. It does not start its event while
  one was heard in the last 10 s (the failed page says where), and a running relay shows the other
  one on its status page.

### Replays

The beamers record only set games, and the relay collects every file they have
(`src/collect.ts`, `src/rawstore.ts`, `src/archive.ts`; why: [redesign.md](redesign.md)).

- **The sync.** A beamer syncs when it has no Wii request pending: after each file it served, when
  it finds a new file, and every 30 s. For each listed file the relay answers:
  - `SA_HELD` with the stored copy's SHA-256, when the beamer served it whole this boot and its
    hash equals the laptop's copy. The beamer acks it and erases it at its next cold boot.
  - `SA_WANTED` to download it now: not stored yet, stored but not hashed by the beamer this boot
    (served again so the beamer can hash it), or stored with another hash.
  - `SA_NOTED`: being recorded, downloading right now, a name that is not a plain `.slp`, or too
    little free disk.

  The reply carries the archive's `archive_id` and an HMAC-SHA256 over the beamer's nonce, its
  `station_id` and the reply, keyed by the secret, so nobody else on the Wi-Fi can make a beamer
  erase.
- **Downloads.** One at a time per beamer, from the address it synced from, after a free-disk check
  (256 MB must stay free), resumed with `X-Replay-From`. A failure is not retried: the next sync
  asks again.
- **The archive folder** (`AppOptions.archiveDir`, `Documents/LazyTO` by default): `archive.json`
  (the random `archive_id`), `index.jsonl`, `raw/<station_id>/<name>`,
  `unmatched/<station_id>/<name>`, `.sets/` and the zips. A copy is stored through a part file:
  fsync, rename, read back, hash. The same name with other content is `<stem>~<sha8>.slp`. "Held"
  needs the copy to stat at its size, and a re-hash when its last check is over 24 h old. Raw
  copies stay until the TO deletes them; a new archive folder has a new `archive_id`, so the
  beamers drop their acks and everything is collected again.
- **Matching.** A game's replay is `Game_<Wii MAC>_<replay_id as UTC>.slp` on the beamer the game
  was reported through, whichever arrives first. Finished replays a game names go to `raw/`;
  strays and incomplete recordings go to `unmatched/` (moved to `raw/` if a later report names
  them). The content check (stage, characters, costumes, and stocks only when the game sent them)
  flags a mismatch and still binds.
- **Zips.** A finished set is zipped once every game has a complete replay and start.gg's phase
  group lookup has answered. A set with a game without one gets no zip and is listed on the status
  page with the reason; a replay that arrives later, even at a later event, zips it then.
- **The zip is Replay Reporter's** (`src/setzip.ts`; why: [redesign.md](redesign.md#the-zip-and-lucky-stats),
  D21). It is what Replay Reporter for Slippi v2.7.0 writes when it reports and copies a set,
  compared byte for byte with its own output by `npm test` (`test/rr-conformance/`), with the
  values LazyTO reported where Replay Reporter's are wrong.
  - The zip is named `<phase, or the event> <round letters> - <entrant 1 (characters)> vs
    <entrant 2 (characters)>.zip` after sanitize-filename, with ` 2`, ` 3` on a clash. It holds
    `context.json` first, then `<n> - <players in port order, each with this game's character> -
    <stage>.slp` per game.
  - `context.json` (minified, only when every player of every game has a name): `bestOf` (the
    set's), `durationMs`, `scores` (two slots per game in port order: names, 1-based ports,
    prefixes, pronouns, and the player's games won before it), `finalScore`, `players` (each
    entrant's name and characters in order of first use), `startMs`, and `startgg` (the
    tournament's name and location; the event; the phase; the phase group with its bracket type,
    wave and winners target phase; the set's id, round text, ordinal, round and stream).
  - Every replay is re-timed so the last game ends at the set's `completedAt` (`startMs`, and each
    replay's `metadata.startAt`). The players' tags go into its display-name fields in Replay
    Reporter's Shift-JIS, without its byte remap of double-byte characters and never into the
    next port's field.
  - The entries carry the zip's writing time; the headers are yazl's (version made by 3.63, mode
    0664).
  - A game with no L + R claim gives no `context.json`, and its players are named by character.

### Status page

A server-rendered page on port 29473, refreshed every 5 s, readable on a phone. No client script. Anyone on the network can view it; its actions need `adminPassword` (HTTP Basic auth, any user name), and a POST from another site is refused.

- Per station: set, score, last action and its age, the status the player saw, and the station's telemetry (module state, recent log lines, last crash).
- Every failed start.gg call with its message, until the TO clicks "ack". Ack only hides the flag.
- **Free a station** (`src/admin.ts`). A Wii that died mid-set keeps its claim, and the set stays in progress on start.gg, where no other Wii may take it. Free asks first, naming the set and the score it discards, then resets the set on start.gg (the call a Wii's abandon makes) and drops the claim: the set is back on every Wii's list at 0-0. The score cannot move with it: only the station's own resume gets the set's games back.
- **Waiting sets** with their best-of and a button to switch Bo3/Bo5 or go back to `setFormat`'s answer. Only for sets no station holds, since a Wii learns best-of when it starts a set. Overrides are `bestof` events in the audit log and replay at startup.
- **Beamers**: one row per beamer from its syncs: number (or none), address, firmware, Wi-Fi signal, free space and space lost to interrupted recordings, replays on the card (to collect, to erase, empty, incomplete), up since ("not unplugged since"), the last erase, downloads and the last Wii round trip. Warnings for a full or faulty card, old firmware, a beamer never unplugged after an event, a full laptop disk. Above them, "All replays collected: safe to unplug beamers" once no beamer has anything left to collect.
- **Replays**: games reported without a replay flagged on their station, finished sets skipped for Lucky Stats with the reason per game, the zips written, the strays kept, the archive folder and its free space.
- At the top: another LazyTO relay on the network, two beamers on one station number, a beamer with another secret, macOS blocking the beacon (Local Network), and "No beamer has reached this relay" after 2 minutes of unanswered beacons.
- Footer: event, cache size, cache age (warns after 60 s), upstream call rate, last refresh error, a pool the relay could not start, beacon targets and send errors, and refused requests (wrong secret, source address, claimed station).

## Error handling

| Failure | Where seen | Behaviour |
|---------|------------|-----------|
| No beamer, or not a LazyTO one | Wii | `NO BEAMER ON THIS WII`, `NOT A LAZYTO BEAMER` or `UPDATE THE BEAMER`; `WAITING FOR THE BEAMER` while it starts. |
| Beamer without a number | Wii | `THIS BEAMER HAS NO NUMBER`, a wait that clears at the first button click. |
| Wrong or missing secret | Wii + status page | RELAY SECRET MISMATCH. Counted on the status page. |
| No beacon heard | Wii | BEAMER HEARS NO RELAY after 10 s. A searches again. |
| Relay unreachable | Wii | The beamer's connect fails (`BR_CONNECT`) or no answer comes within 3 s: `NO LINK TO THE RELAY`. A retries. TO checks the relay's firewall and the network. |
| Set taken | Wii | "started on station N". Player picks again. |
| `assignStream` fails after `markSetInProgress` | Wii + status page | Set is in progress but not on stream. TO assigns it by hand and acks. |
| start.gg 5xx | Relay | Retry twice, then `ST_STARTGG_ERROR`; row flagged. Retrying later is safe. |
| start.gg 4xx (for example the TO already reported the set) | Wii | "start.gg rejected - ask TO". No retry. The station clears on the next list. |
| Rate limited | Relay | `ST_RATE_LIMITED` after 2 s. |
| Wii reboot mid-set | Wii | The set is offered first; the resume's reply carries the set's games, so the kiosk goes on from them. |
| Two beamers on one station number | Wii + status page | The newcomer's Wii gets `ST_DUP_STATION`; the station already playing keeps playing. The status page names both. |
| Another LazyTO relay on the network | Status page | This relay does not start its event; one already running says so. |
| A game without its replay | Status page | Flagged on the station; the set gets no Lucky Stats zip until the replay arrives. |
| Relay restart | Relay | Audit log replay; sets no longer pending are dropped. |
| Game crash | Status page | The kernel sends a crash report with registers and a short stack. |

## Deployment

### Wii (each station)

- The stock Melee 1.02 disc image on the SD card: with the game on USB, the beamer is not used.
- LazyTO Nintendont as the loader. The venue's own Nintendont settings (UCF, tournament codes, stages, audio) stay as they are.
- On the SD card root, all from the one SD-card zip on the status page (`src/cards.ts`, from the bundle's `wii/` folder). Every card is the same:
  - `apps/LazyTO/`: the loader.
  - `lazyto_kiosk.bin`: the kiosk module. Updating the kiosk means replacing this file.
  - `lazyto_nincfg.bin`: the loader's settings: Slippi replays and Auto Boot on, Network off, the game on SD (UseUSB 0), Gameplay: Both. The kernel starts USB, and with it the beamer's mailbox, only with replays on and the game on SD. A file of its own, apart from Slippi Nintendont's `slippi_nincfg.bin`, so a venue's Slippi Nintendont on the same card never reads or overwrites it.
- A LazyTO beamer in the Wii's USB port, its only USB drive. It holds the station number (its button) and the secret (`LAZYTO-SECRET` in its `CONFIG/config.txt`).

The relay decides the stream by station number (`streamStation`), so no card says it is the stream station. There is no relay address: beamers find the relay by its beacon. Step by step: [wii-setup.md](wii-setup.md).

### Pi

A Raspberry Pi (5, 4 or Zero 2 W) on Raspberry Pi OS Lite 64-bit, on the venue Wi-Fi (Ethernet works the same). Step by step: [pi-setup.md](pi-setup.md).

Everything a Pi runs comes from one bundle per commit, `lazyto.tgz` (`.github/workflows/release.yml`): the relay (`dist/`, `deploy/`) and the Wii files (`wii/apps/LazyTO/`, the loader built from the pinned Nintendont commit, and `wii/lazyto_kiosk.bin`). Every push to `main` republishes it on the moving prerelease `main-build`; a `v*` tag drafts a release with it. Each Pi follows one update channel, `/var/lib/lazyto/update-channel`: `release` (the newest full release, the default), `main` (`main-build`) or `off`.

| File | Role |
|------|------|
| `deploy/install.sh` | The install command, also a release asset: pinned Node 22 in `/opt/node`, Wi-Fi power saving off, system user `relay`, the update channel (`--channel`), the bundle into `/opt/lazyto` (downloaded, or `--bundle <file>`), then starts the unit and prints the setup page's address and setup code. Running it again keeps the settings. |
| `deploy/update.sh` | Before every relay start: the channel's bundle when its VERSION differs from the installed one, verified by SHA-256 and checked against the settings by the new build's `check-config.js`, then swapped in. `--from <dir>` is the swap alone, which install.sh uses. |
| `deploy/lazyto-relay.service` | systemd unit, runs as `relay`, restarts on failure. |
| `deploy/uninstall.sh` | Removes what install.sh added, settings included; audit logs are kept unless `--purge`. |
| `deploy/add-wifi.sh` | Saves another Wi-Fi network. |

Logs go to journald. Settings and audit logs go to `/var/lib/lazyto`.

### Network

The relay's computer, the beamers and the TO's phone must share one network. Addresses do not matter, because beamers find the relay by its beacon. The Wiis use no network: each reaches the relay through its beamer. A guest Wi-Fi with client isolation blocks beamer-to-relay traffic: check once by opening the status page from a phone on the venue Wi-Fi.

The secret travels in plain text. It keeps passers-by out, not someone capturing the Wi-Fi traffic.

The checklist for each tournament night is in [night-of.md](night-of.md).

## Development and testing

- **Protocol first.** Change `protocol.yaml` and run `python tools/gen_protocol.py`, which writes `generated/wire.ts` and both header copies. `tools/check_protocol.py` regenerates them in memory and fails on any difference; the generator itself refuses implicit padding and any size that disagrees with `protocol.yaml`.
- **Relay tests.** `npm test`: codec round-trips, the character and stage tables, and integration tests against `test/fake-startgg.ts` covering every row of the error table. Tests never touch the real API.
- **Load.** `scripts/sim-wii.ts` drives 12 fake stations through list, start, score and end for 10 minutes and checks the upstream call rate.
- **Kiosk.** A development setup can load `lazyto_kiosk.bin` into an emulator that implements the same EXI device, so menu work does not need a Wii. Hardware is the final check.
- **CI.** `test.yml` (format, shellcheck, `npm test`, build) and `kiosk.yml` (the module, when kiosk files change) run on pull requests. `release.yml` runs on every push to main and every `v*` tag: the tests, the module, the loader, the bundle, then `main-build` or a draft release.

## Status

As of 2026-09-30 a real Wii has booted the module, found the relay by beacon (including the beacon-request path), sent the secret and loaded the set list. Not yet run on hardware: the full set lifecycle, `.slp` recording alongside the module, and venue stage-striking behaviour. See [changelog.md](changelog.md).
