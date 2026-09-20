# Design: Console-Side Set Selection and Score Reporting for Melee Locals

**Status:** Draft v0.1 — September 2026
**Project:** Tournament Reporter — repos: `tournament-reporter` (relay + this doc + protocol), forks of `doldecomp/melee`, `project-slippi/Nintendont`, `project-slippi/Ishiiruka` on branch `reporter`
**Scope:** Melee decomp build + Nintendont kernel extension + LAN relay on Raspberry Pi
**Audience:** The people writing the three components; future-you at 11pm before a local

---

## 1. Context and goals

Today a set moves through start.gg only when a TO touches it: call the set, assign it to the stream, report the score. Players sit at the Wii and wait, and the overlay (TSH) only updates when the TO catches up. This system moves that work to the players, at the console, without a TO in the loop for the happy path.

### Goals

1. Two players sit at any Wii, pick their set from a list, and start it. start.gg marks it in progress; on the stream station it is also assigned to the stream so TSH picks up the names.
2. Players update the score from the character select screen (CSS). start.gg reflects the score within seconds.
3. Runs on the venue's existing hardware: 10–12 internet-connected Wiis, one Raspberry Pi, the TSH laptop.
4. Fails loudly and locally. A player always sees why something didn't work and can retry. No hidden retries, no silent desync.

### Non-goals

- Replacing TSH, start.gg, or the bracket. TSH stays the overlay; start.gg stays the source of truth.
- Handling doubles, round robin pools with odd formats, or non-Melee events (v1 is 1v1 Melee brackets).
- Running without a network. If the relay is unreachable the menu says so and the TO falls back to normal start.gg operation.
- TLS on the Wii. See §4.1.

---

## 2. Requirements

### Functional

| ID | Requirement |
|----|-------------|
| F1 | List all sets in the event that are not started and have both entrants known, filterable by player name. |
| F2 | Select a set and start it. start.gg set state → in progress. |
| F3 | If the console is the stream station, also assign the set to the configured stream. |
| F4 | From CSS: increment/decrement P1 or P2 score. Each increment reports a game with that entrant as winner; decrement removes the last game. |
| F5 | End the set: report winner, set completes in start.gg. Console returns to set list. |
| F6 | Every console shows the same set list; a set started on one console disappears from the others within one refresh interval. |
| F7 | TO can see all stations, their current set, last action, and any failed start.gg call on a single page. |

### Non-functional

| ID | Requirement |
|----|-------------|
| N1 | Score update visible in start.gg within 5 s of the button press under normal conditions. |
| N2 | Total start.gg request rate stays under the API limit (80 requests / 60 s per token) with 12 stations active. |
| N3 | A station reboot mid-set loses nothing; the set can be resumed from the list. |
| N4 | The start.gg API token never leaves the Pi. |
| N5 | Wii-side code has no dynamic allocation, no JSON, no string parsing beyond fixed-width fields. |

### Constraints

- Melee has no networking; all network I/O is done by the Nintendont kernel on the Wii's ARM core, reached via a fake EXI device (implemented by Nintendont on hardware, by Slippi Dolphin's forwarder in development).
- PowerPC is big-endian, 32-bit, ~24 MB usable RAM shared with the game. Menu code must be small.
- Nintendont kernel iteration is slow (SD swap + reboot). Minimize kernel surface area.
- Single developer, evenings and weekends. Simple beats complete.

---

## 3. High-level design

```
 ┌──────────────── Wii (×12) ────────────────┐
 │  Melee (decomp build, PowerPC)            │
 │   ├─ Tournament menu                      │
 │   ├─ CSS score keybinds                   │
 │   └─ exi_relay.c  ──EXI──┐                │
 │                          ▼                │
 │  Nintendont kernel (ARM / Starlet)        │
 │   └─ relay_exi.c ── TCP ─┼────────────────┼──┐
 └──────────────────────────┼────────────────┘  │
                            │  LAN (wired)       │
                            ▼                    │
 ┌──────── Raspberry Pi ────────────────┐        │
 │  relay (Node/TS, systemd)            │◄───────┘
 │   ├─ TCP server  :7777  (Wii proto)  │
 │   ├─ set cache   (refresh every 20 s)│
 │   ├─ startgg client (GraphQL/HTTPS)  │────► api.start.gg
 │   ├─ audit log   (JSONL, append-only)│
 │   └─ status page :8080 (HTML)        │◄──── TO's phone / laptop
 └──────────────────────────────────────┘

 TSH laptop ──► api.start.gg  (unchanged; polls sets assigned to stream)
```

### Data flow: start a set on the stream station

```
Player     Melee            Nintendont        Relay                   start.gg
  │  A on set │                │               │                        │
  │──────────►│ START_SET      │               │                        │
  │           │──EXI write────►│  TCP send     │                        │
  │           │                │──────────────►│ markSetInProgress      │
  │           │                │               │───────────────────────►│
  │           │                │               │ assignStream (stream   │
  │           │                │               │  station only)         │
  │           │                │               │───────────────────────►│
  │           │ poll EXI       │  TCP reply    │                        │
  │           │◄──────────────│◄──────────────│ OK / ERR               │
  │◄──────────│ CSS opens     │               │                        │
```

TSH sees the set on its next poll and updates the overlay. No change to TSH.

### Data flow: score update

```
Player: R+D-pad-right on CSS  →  REPORT_SCORE{set, games[]}  →  relay
relay: reportBracketSet(setId, gameData: games)   [no winnerId → set stays in progress]
```

The Wii sends the **full game list** every time (idempotent). The relay never has to reconcile partial updates.

---

## 4. Key decisions

### 4.1 Relay on the LAN instead of HTTPS from the Wii

**Decision:** The Wii speaks a fixed-struct TCP protocol to a relay. The relay speaks GraphQL/HTTPS to start.gg.

**Why:** api.start.gg is TLS-only. Neither Melee nor the Nintendont kernel has a TLS stack. Porting mbedTLS into the kernel is possible but is the largest single risk in the project, and it would put an admin-scoped token on an SD card at the venue (violates N4). A relay makes the Wii side trivial and centralizes all start.gg state and rate limiting in one process.

**Trade-off:** One more box to set up. Mitigated: the Pi is a fixed appliance (flash once, plug in), and the TSH laptop already has to be on this LAN.

### 4.2 Relay owns all state; Wii is stateless between reboots

**Decision:** The Wii holds only "current set id + game list" in RAM. On boot it asks the relay for the set list; a set already in progress on this station is offered first.

**Why:** N3. Also keeps kernel and game code free of persistence logic.

### 4.3 One config per Wii, on the SD card

`sd:/tournament.cfg` (plain text, fixed keys):

```
relay_ip=192.168.1.10
relay_port=7777
station=3
stream=1
```

`stream=1` on exactly one Wii. The relay refuses `START_SET` with `stream=1` from a station that doesn't match its configured stream station, so a mis-copied SD card can't hijack the stream.

### 4.4 Fixed-size big-endian structs on the wire

**Decision:** Every message is a fixed-size packed struct, big-endian, with a version byte. No JSON, no varints, no strings longer than their field.

**Why:** N5. PowerPC is big-endian so the Wii does zero byte-swapping. The relay does the swapping in TS (`DataView` with `littleEndian=false`).

**Trade-off:** Adding a field is a version bump. Acceptable — the protocol is tiny and both ends ship together.

### 4.5 Score = list of games, not two integers

**Decision:** `REPORT_SCORE` carries `games[5]` where each game is `{winner_slot, p1_char, p2_char}`. Score is derived.

**Why:** start.gg's `reportBracketSet` takes per-game data (`gameNum`, `winnerId`, optional selections). Sending games means we get character data on start.gg for free from CSS, and "undo" is just "pop the last game" — no ambiguity about which game to remove.

### 4.6 No retries on the Wii

**Decision:** The kernel does one TCP attempt with a 3 s timeout. Any failure surfaces to the menu as an error code + short text. The player presses A to retry.

**Why:** Fail fast. Retry loops in kernel code are how you get a frozen console with no indication of why. The relay is the only place with retry logic (for start.gg 5xx).

---

## 5. Wire protocol (Wii ↔ relay)

Transport: TCP, one connection per request, request then response, connection closed. Simplest possible thing for the kernel side; the request rate is far too low for connection reuse to matter.

All integers big-endian. All strings ASCII, NUL-padded, not NUL-terminated if full.

### 5.1 Header (every message)

```c
struct relay_hdr {
    uint8_t  magic[2];   // 'M','T'
    uint8_t  version;    // PROTO_VERSION = 1
    uint8_t  cmd;        // enum relay_cmd
    uint16_t station;    // from tournament.cfg
    uint16_t len;        // payload bytes following the header
};  // 8 bytes
```

```c
enum relay_cmd {
    CMD_LIST_SETS    = 1,
    CMD_START_SET    = 2,
    CMD_REPORT_SCORE = 3,
    CMD_END_SET      = 4,
    CMD_ABANDON_SET  = 5,   // player-initiated "wrong set"; relay resets it
};

enum relay_status {
    ST_OK              = 0,
    ST_BAD_VERSION     = 1,
    ST_SET_NOT_FOUND   = 2,
    ST_SET_TAKEN       = 3,   // started on another station
    ST_NOT_STREAM      = 4,   // stream flag from non-stream station
    ST_STARTGG_ERROR   = 5,   // upstream rejected; see status page
    ST_RATE_LIMITED    = 6,
    ST_INTERNAL        = 7,
};
```

Every response begins with `relay_hdr` (same cmd) followed by:

```c
struct relay_resp {
    uint8_t  status;      // enum relay_status
    uint8_t  _pad;
    char     msg[30];     // short human text for the menu
};  // 32 bytes
```

### 5.2 CMD_LIST_SETS

Request payload: none.

Response payload after `relay_resp`:

```c
struct set_entry {
    uint32_t set_id;
    uint32_t p1_entrant_id;
    uint32_t p2_entrant_id;
    char     round[16];      // "WR2", "LF", "GF"
    char     p1_tag[16];
    char     p2_tag[16];
    uint8_t  best_of;        // 3 or 5
    uint8_t  state;          // 0 = pending, 1 = in progress (this station)
    uint8_t  _pad[2];
};  // 64 bytes

struct list_sets_resp {
    uint16_t count;          // ≤ MAX_SETS = 63
    uint16_t _pad;
    struct set_entry sets[]; // count entries
};
```

Cap of **63** entries — the exact fit for the game's 4096-byte poll buffer once the framing is counted: 4 (poll state word) + 8 (`relay_hdr`) + 32 (`relay_resp`) + 4 (`list_sets_resp` fixed part) leaves 4048 bytes = 63 × 64-byte rows (found in session 6; the original "64 (4 KB)" predated the poll framing). A local with 12 stations never has 63 *pending, both-entrants-known* sets at once; if it does, the relay returns the 63 with the lowest round number and the menu's name filter finds the rest on the next refresh.

### 5.3 CMD_START_SET

```c
struct start_set_req {
    uint32_t set_id;
    uint8_t  stream;         // from tournament.cfg — stamped by the kernel, see below
    uint8_t  _pad[3];
};
```

**Station/stream stamping** (session 6): the game has no access to `tournament.cfg`, so it always sends `hdr.station = 0` and `start_set_req.stream = 0`. The Nintendont kernel (and the Dolphin forwarder in dev) stamps both from its config before forwarding. The relay treats the values it receives as authoritative.

Relay behavior:
1. If set not in cache → `ST_SET_NOT_FOUND`.
2. If set already claimed by another station → `ST_SET_TAKEN`. Also applies when the set is in progress *upstream* but claimed by no station (the TO started it by hand on start.gg): `ST_SET_TAKEN` with `msg = "in progress on start.gg"` (session 4).
3. If the requesting station already holds a *different* set → `ST_INTERNAL` with `msg = "finish current set first"` — auto-releasing would orphan an in-progress set upstream (session 4).
4. If `stream=1` and `station != config.streamStation` → `ST_NOT_STREAM`.
5. `markSetInProgress(setId)`.
6. If `stream=1`: `assignStream(setId, config.streamId)`.
7. Record `station → set_id` in memory and audit log. Return `ST_OK`.

Steps 5–6 are not atomic in start.gg. If 6 fails after 5 succeeds, the relay returns `ST_STARTGG_ERROR`, the set stays in progress and unassigned, and the status page flags it. The TO assigns the stream by hand. This is the one known partial-failure case and it degrades to today's workflow.

### 5.4 CMD_REPORT_SCORE

```c
struct game_result {
    uint8_t winner_slot;     // 1 or 2
    uint8_t p1_char;         // Melee external character id (CharacterKind — the CSS ckind value)
    uint8_t p2_char;
    uint8_t _pad;
};

struct report_score_req {
    uint32_t set_id;
    uint8_t  game_count;     // 0–5
    uint8_t  _pad[3];
    struct game_result games[5];
};
```

Relay behavior: translate slots → entrant ids, build `gameData` as `{gameNum, winnerId}` per game, call `reportBracketSet(setId, gameData)` **without** `winnerId` (set-level). Full overwrite every time — idempotent. **v1 ignores the `p1_char`/`p2_char` fields** — no character selections are sent (R13). The wire struct still carries them (the Wii sends `0`); v2's GAME_END hook is where character data is translated via `chars.ts` and reported.

### 5.5 CMD_END_SET

```c
struct end_set_req {
    uint32_t set_id;
    uint8_t  game_count;
    uint8_t  _pad[3];
    struct game_result games[5];
};
```

Relay derives winner from the game list (more wins), refuses with `ST_INTERNAL` if the game list doesn't produce a winner for `best_of`, then calls `reportBracketSet(setId, winnerId, gameData)`. Clears the station's current set.

### 5.6 CMD_ABANDON_SET

Payload: `uint32_t set_id`. Relay calls `resetSet(setId)` and clears the station's claim. Only valid if the set has no reported games; otherwise `ST_INTERNAL` with `msg = "ask TO"`. Undoing a set with games is a TO decision.

**Verified live 2026-09-20:** `resetSet` does **not** clear a stream assignment on start.gg. An abandon (or TO reset) of a stream-station set leaves it stream-assigned upstream, so TSH keeps it on the overlay's radar until the TO clears the assignment by hand. The relay itself never reads `Set.stream`, so this is an operational note, not a code path.

---

## 6. Components

### 6.1 Melee (decomp, C)

**Files (new):**
- `melee/mn/mntourney.c` — the Tournament menu: list, name filter, confirm screen, error screen.
- `melee/lb/lbtourney.c` — set state (current set, games[5]), CSS keybind handler.
- `melee/lb/lbrelayexi.c` — EXI request/poll helpers. The decomp has **no Slippi code** (found 2026-09-19, session 5): this is a new EXI driver on the vanilla SDK API (`dolphin/os/OSExi`; template: `hio.c`), speaking the `exi_cmd` commands from `relay_proto.h` to the fake relay device that Slippi Dolphin (§9.3) and Nintendont (§6.2) implement.

**Menu flow:**

```
Main menu ─► Tournament
              ├─ [Loading…]  (LIST_SETS in flight)
              ├─ Set list (scrollable; L/R filters by first letter of tag)
              │    A ─► Confirm "WR2  Mango vs Zain — Bo3   START?"
              │            A ─► START_SET ─► OK ─► CSS
              │                              ERR ─► error screen, A retries, B back
              └─ B ─► Main menu
```

**CSS keybinds** (only active when a set is current):

| Input | Action |
|-------|--------|
| Z + C-stick left  | P1 wins a game (append game, winner_slot=1) |
| Z + C-stick right | P2 wins a game |
| Z + C-stick down  | Undo last game |
| Z + C-stick up (hold 1 s) | End set (requires a decided score) |

Inputs are read from **any** controller — every port is scanned, and any port holding Z drives the set (in Dolphin only port 1 is emulated by default). Win/undo fire once per flick (edge into a cardinal); end is a sustained hold.

(Input history, 2026-09-20: End set was first `Z + Start` — but Start is Melee's native "advance to stage select" on the CSS and changes scene before a hold completes. Moved to the d-pad, then to the **C-stick**: the C-stick has no native CSS action, is reachable on standard *and* box controllers (a d-pad is not), and leaves the d-pad free for the venue's rumble-toggle code (R12).)

Each action sends `REPORT_SCORE` (or `END_SET`) immediately. The score is drawn in the CSS corner as `MANGO 2 - 1 ZAIN`, with a small `!` while a request is in flight and `X` if the last one failed (the SIS printf path is ASCII-only, so no `✗`/`–` glyphs). **v1 reports winners only** — no per-game character data is read or sent (R13); per-game characters return in v2 via the GAME_END hook. END_SET is gated on a clinched score (`wins >= best_of/2 + 1`).

**EXI usage:** `EXI_RELAY_REQ` (write request buffer) and `EXI_RELAY_POLL` (read `{state, response buffer}`) — command ids and poll states are defined in `protocol.yaml` (`exi_cmd`, `exi_poll_state`) so the game, the Dolphin forwarder, and the kernel can't drift; values (0xF0/0xF1) sit clear of Slippi's EXI command space, which extends to 0xE5. The game never blocks: the menu shows "Loading…" and polls once per frame. Response buffer is a static 4 KB region in `lbrelayexi.c`, `ATTRIBUTE_ALIGN(32)` as EXI DMA requires.

**EXI device contract** (as built in session 6; authoritative header `melee/src/melee/lb/lbrelayexi.h`, details in melee `docs/session6-report.md`) — what the Dolphin forwarder (§9.3) and Nintendont (§6.2) must implement:
- Address: **channel 1, device 0, frequency 4** (Slot B — the device Slippi Dolphin already exposes).
- REQ: 4-byte immediate command word (`EXI_RELAY_REQ << 24`), then `relay_hdr` + payload via EXIImmEx (8–36 bytes), one select window.
- POLL: immediate command word (`EXI_RELAY_POLL << 24`), then exactly 4096 bytes DMA-read by the game: byte 0 = `exi_poll_state`, 3 pad bytes, then `relay_hdr` (echoing the request's cmd), `relay_resp`, payload.
- The game treats any poll state other than DONE/ERROR (including the 0xFF an absent device reads) as "still waiting" and times out after **5 s** (the kernel's own budget is 3 s). On `RELAY_ERROR` the response buffer is zeroed.

**Menu route** (session 5, built in session 6): the Tournament menu lives in `GS_MENU`, entered by a **Z press on the main menu** — a visible "Tournament" menu item would need a modified SdMenu.dat asset, which is asset work, not code. All screens are SIS text overlays on a 640×480 ortho canvas (the gmtitle build-timestamp pattern); no models, no new assets. Every hook is a data-table or declaration edit (never a matched-function edit): main-menu think wrap, `GS_CSS` scene-row wraps, menu table grown to id 35 (`MENU_KIND_TOURNAMENT`). Memory is a non-issue — the arena is ~18 MiB and the tournament statics are ~8 KB (R4 resolved).

**Constraints honored:** no malloc, no string parsing, all buffers static, all struct sizes asserted at compile time against the generated header.

### 6.2 Nintendont kernel (ARM, C)

**Files:** `kernel/RelayEXI.c` + `.h`.

Responsibilities, and nothing else:
1. Parse `tournament.cfg` at boot (relay IP/port, station, stream) using the kernel-side FatFS pattern (`ConfigInit()` / `f_open_main_drive`). Missing or malformed file → set a flag; every relay command returns `ST_INTERNAL` with `msg="no tournament.cfg"`.
2. **Stamp `hdr.station` (every request) and `start_set_req.stream` (START_SET) from `tournament.cfg`** — the game always sends 0 for both (§5.3).
3. On `EXI_RELAY_REQ`: copy the request buffer, set `RELAY_BUSY`, and hand off to a **dedicated kernel thread** that does socket → connect → send → recv → close with the 3 s budget enforced via the existing `poll()`-with-deadline pattern (SlippiNetwork.c). **The EXI handler itself must never block** (R3 resolved 2026-09-19): there is no EXI interrupt context — the game's EXI writes are serviced by the kernel's single main loop, and the game sits frozen inside the patched EXI transfer until that loop acks, so a block there freezes the console.
4. On `EXI_RELAY_POLL`: return `{state: RELAY_IDLE|BUSY|DONE|ERROR, buffer}` in the §6.1 poll layout (zeroed buffer on ERROR). The Slippi-era EXI path never DMAs data back to the game, so the poll response uses the memcard read-back pattern: write through the DMA pointer, then `sync_after_write`.

The kernel does not interpret payloads beyond the header length. Still one code path: one buffer, one thread (own 0x2000 stack added to the kernel.ld stack chain), four states, no retries. Template: Slippi Nintendont's broadcast networking thread.

### 6.3 Relay (Node 22 / TypeScript, on the Pi)

**Modules:**

| Module | Responsibility |
|--------|----------------|
| `wire.ts` | Struct encode/decode. Generated from `protocol.yaml`. |
| `tcp.ts` | TCP server; one request per connection; dispatches by cmd. |
| `cache.ts` | Pending-set cache. Refreshes every 20 s via one `event.sets` query. |
| `startgg.ts` | GraphQL client, token, rate limiter (token bucket, 70/60 s), retry on 5xx only (max 2, backoff 1 s/3 s). |
| `state.ts` | In-memory `Map<station, {setId, games}>`. |
| `audit.ts` | Append-only JSONL: every request, response, and upstream call with timestamps. |
| `status.ts` | HTTP server-rendered status page on :8080. |
| `chars.ts` | Melee external char id (`CharacterKind`) → start.gg character id table. **Unused in v1** (winners only, R13); kept for the v2 GAME_END hook. All 26 mappings verified live 2026-09-19. |

**Config** (`/etc/tournament-reporter/config.json`):

```json
{
  "token": "…",
  "eventId": 123456,
  "streamId": 7890,
  "streamStation": 1,
  "tcpPort": 7777,
  "httpPort": 8080,
  "auditDir": "/var/lib/tournament-reporter"
}
```

Startup validates every field and exits non-zero on any problem. No defaults — `auditDir` is explicit config rather than a hardcoded path (session 4: a hidden default, and it breaks Windows dev).

**start.gg calls used:**

| Relay action | GraphQL |
|--------------|---------|
| cache refresh | `event(id).sets(filters: {state: [1,2]}, perPage: 100)` with slots/entrants |
| START_SET | `markSetInProgress(setId)` then, if stream, `assignStream(setId, streamId)` |
| REPORT_SCORE | `reportBracketSet(setId, gameData)` (no winnerId) |
| END_SET | `reportBracketSet(setId, winnerId, gameData)` |
| ABANDON_SET | `resetSet(setId)` |

Schema gotcha (verified 2026-09-19 by `scripts/probe.ts`): the `Game` *output* type exposes `orderNum`, not `gameNum` — `gameNum` exists only on the `BracketSetGameDataInput` input type. The cache's set query must select `games { orderNum winnerId }` when reloading games after a Wii reboot.

**Load:** 12 stations × ~1 request/min + 3 cache refreshes/min ≈ 15 upstream calls/min worst case. Well under the 80/60 s limit; the limiter is a guard, not a throttle.

**Status page** (read-only, no auth on the LAN — same trust boundary as the TSH laptop):

```
Station  Set                          Score   Last action        Status
   1 ★   WR2  Mango vs Zain (Bo3)     2–1     REPORT_SCORE 12s   OK
   2     LR1  Plup vs Cody (Bo3)      —       START_SET 4m       OK
   3     —                            —       LIST_SETS 30s      OK
   4     WR1  Hbox vs Axe (Bo3)       1–0     START_SET 6m       ✗ assignStream 403 — assign by hand

Cache: 41 pending sets, refreshed 8s ago.   Upstream: 14 calls last 60s.
```

Rows with ✗ stay until the TO clicks "ack". That's the only interactive element.

---

## 7. State machines

### 7.1 Station (relay's view)

```
        LIST_SETS            START_SET ok
 IDLE ─────────────► IDLE ──────────────► IN_SET
   ▲                                        │
   │       END_SET ok / ABANDON_SET ok      │
   └────────────────────────────────────────┘
```

A station in `IN_SET` that sends `LIST_SETS` (i.e. rebooted) gets its own set back with `state=1` at the top of the list; selecting it sends `START_SET`, which the relay treats as a no-op resume (no upstream call) and returns `ST_OK`.

### 7.2 Set (start.gg)

start.gg states: `1` not started → `2` in progress → `3` complete. The relay only ever moves a set forward, plus `resetSet` for abandon-before-any-games.

---

## 8. Error handling

| Failure | Where seen | Behavior |
|---------|------------|----------|
| No `tournament.cfg` | Wii menu | "no tournament.cfg" — station unusable until fixed. |
| Relay unreachable | Wii menu | "relay timeout" after 3 s. A retries. TO checks Pi/LAN. |
| Set taken | Wii menu | "started on station N". Player picks again. |
| assignStream fails after markSetInProgress | Wii menu + status page | Set is in progress; TO assigns stream by hand; ack on status page. |
| reportBracketSet 5xx | Relay | Retry ×2. Then `ST_STARTGG_ERROR` to Wii; row flagged. Player retries later; full overwrite makes this safe. |
| reportBracketSet 4xx (e.g. set already complete by TO) | Wii menu | "start.gg rejected — ask TO". No retry. |
| Rate limited | Relay | Request waits up to 2 s for a token, else `ST_RATE_LIMITED`. Should never happen at this scale; if it does, the status page shows the call rate. |
| Wii reboot mid-set | — | Set list offers current set first; resume is a no-op START_SET. The relay and start.gg keep the score, but `set_entry` carries no games, so the CSS overlay restarts at a displayed 0–0 — the player re-enters the score and full overwrite makes that safe (session 4; a protocol design limit, not a bug). |
| Relay restart | — | Audit-log replay on boot, only: claim/score/release events replayed, filtered against the live cache (a replayed set no longer pending is dropped). The `assignStation` variant §8 originally offered was not built (session 4). |

---

## 9. Development and test strategy

### 9.1 Protocol first

- `protocol.yaml` is the single source of truth. A Python script generates `relay_proto.h` (packed structs, `_Static_assert` on sizes) and `wire.ts` (encode/decode).
- A relay test builds a tiny C program from the generated header, dumps `sizeof`/`offsetof` for every struct, and compares against the TS encoder. Any drift fails CI.

### 9.2 Relay

- **Unit:** wire codec round-trips; char id table covers all 26 Melee ids.
- **Integration:** a fake start.gg GraphQL server serves recorded fixtures (captured once from a real test tournament). Tests cover every row of the §8 table.
- **Load:** `sim-wii.ts` drives 12 fake stations through list→start→score×3→end in a loop for 10 minutes; asserts upstream call rate and zero errors.
- **Real:** an unpublished start.gg test tournament with fake entrants. Run the full flow once per release.

### 9.3 Melee side — Dolphin before Wii

- Build the menu and keybinds in the decomp; test in Slippi Dolphin.
- Patch Slippi Dolphin's EXI device to forward `EXI_RELAY_REQ`/`POLL` to the relay over TCP. End-to-end loop on one machine with a debugger and frame stepping.
- The menu UX iterates here; nothing UX-related needs a Wii.

### 9.4 Nintendont — one dedicated dev Wii

- Permanent desk setup: Wii + SD + USB LAN adapter + relay on the dev machine.
- Nintendont's network log is the debugger. Log every EXI request/response with lengths and status.
- Only start this once §9.2 and §9.3 are green; kernel iteration is the slow loop.

### 9.5 CI

- GitHub Actions: build the DOL (decomp CI already does this), run relay tests, run the struct-drift check. A PR that touches `protocol.yaml` must regenerate both outputs (CI diffs them).

### 9.6 Rollout

1. **Bench:** 2 Wiis + Pi + test tournament. Full bracket run by one person.
2. **Shadow mode at one local:** stream station only. Players use it; TO verifies every start.gg change against the audit log before trusting it. TSH still driven normally as backup.
3. **All stations at one local**, TO spot-checks.
4. **Default workflow.** TO only touches start.gg for ✗ rows.

---

## 10. Deployment

**Pi:** Raspberry Pi 4 (or Zero 2 W), wired Ethernet, static IP. Node 22 via `nvm` pinned in a systemd unit:

```
[Service]
ExecStart=/home/pi/.nvm/versions/node/v22.x/bin/node /opt/tournament-reporter/dist/main.js
Restart=on-failure
Environment=CONFIG=/etc/tournament-reporter/config.json
```

Logs to journald; audit log to `/var/lib/tournament-reporter/audit.jsonl` (rotated per tournament by naming it `<eventId>.jsonl`).

**Per-tournament setup checklist** (this replaces nothing; it's added to the existing setup):
1. Edit `config.json`: `eventId`, `streamId`. Restart service. Check status page shows the set count.
2. **Start all pools and phases on start.gg** (bracket page → every phase, later phases included). Any unstarted pool or phase has preview-id sets the relay drops (R8) — the live event showed 37 dropped across unstarted pool 2 plus the later phases; the status page warns until this is done.
3. Confirm each SD card's `tournament.cfg` station number matches the physical station label. Exactly one has `stream=1`.
4. Boot one Wii, open Tournament menu, confirm the set list loads.

**Network:** Pi and stream Wii on Ethernet, mandatory. Other Wiis on Ethernet where possible; Wii WiFi is 802.11g and unreliable on a busy venue network. A single unmanaged switch under the stream table covers it.

---

## 11. Risks and open questions

| # | Risk / question | Plan |
|---|-----------------|------|
| R1 | `assignStream` mutation semantics (does it require the stream to belong to the tournament's stream queue? does re-assign work?) | **Resolved 2026-09-19** (`scripts/probe.ts`): `assignStream(setId, streamId)` exists and works on an in-progress set with no stream-queue precondition surfacing; start.gg updates its own `stationQueueItem`. Re-assign untested — see §12. |
| R2 | `reportBracketSet` without `winnerId` — confirm it accepts partial game data on an in-progress set and doesn't require `entrant1Score/entrant2Score`. | **Resolved 2026-09-19** (`scripts/probe.ts`): accepts `gameData` alone — no `winnerId`, no entrant scores — and the set stays state 2. A second report is a full overwrite (old game rows deleted, new ones created), exactly what §5.4 needs. |
| R3 | Nintendont kernel networking availability during GC-mode game execution — Slippi Nintendont proves it works for broadcast; confirm a *blocking receive* is fine from the EXI handler context. | **Resolved 2026-09-19** (Nintendont `docs/relay-exi-investigation.md`): blocking is NOT safe — the fallback clause is the design. No EXI interrupt context exists; EXI writes are polled by the kernel's single main loop and the game is frozen until the ack. §6.2 now specifies the dedicated-thread state machine. A second TCP socket coexists fine (three already run across two threads). |
| R4 | Menu memory budget in the decomp build. | **Resolved 2026-09-19** (melee `docs/menu-orientation.md`): arena is ~18 MiB (`__ArenaHi = 0x81700000`); ~8 KB of statics is negligible. EXI DMA needs the 4 KB buffer `ATTRIBUTE_ALIGN(32)`. |
| R5 | Players spamming Z+D-pad and racing requests. | Game side: one request in flight at a time; inputs ignored while `!` is showing. Relay side: last write wins, full overwrite makes this safe. |
| R6 | A set the TO reports by hand while a station has it open. | Wii's next REPORT_SCORE gets 4xx → "ask TO". Station clears on next LIST_SETS (set no longer pending). |
| R7 | Multiple events (e.g. singles + doubles) in one tournament. | Out of scope for v1: one `eventId` per relay config. Second event = second relay port + a per-Wii cfg line. Revisit if it hurts. |
| R8 | **Preview set ids** (found 2026-09-19 during bootstrap): sets in a pool that hasn't been started have *string* ids (`preview_<poolId>_<round>_<n>`), not numeric — they cannot be represented in the protocol's `uint32 set_id`. Confirmed behavior: calling any set mutation (e.g. `markSetInProgress`) with a preview id starts the pool and materializes numeric ids for **all** its sets; the preview ids then stop existing. | **Resolved 2026-09-19** (session 4): option (a) built — the cache drops preview-id sets and the status page warns "start all pools on start.gg"; §10's checklist gained the step. The test tournament deliberately keeps pool 2 (`3292311`) unstarted to exercise this against the real event. |
| R9 | Kernel `connect()` has no timeout and nothing in Nintendont does outbound TCP today (session 3). An unreachable relay pins the RelayEXI thread inside `connect()` for IOS's internal timeout — the game is fine (it just sees `RELAY_BUSY`), but the station can't retry until `connect()` returns. | Measure on hardware in session 8. If it hurts: `IOCTL_SO_FCNTL` non-blocking socket + `poll(POLLOUT)` with the 3 s deadline, same as the recv path. |
| R10 | The Dolphin forwarder does not stamp `hdr.station`/`stream` (session 7) — the relay sees station 0 from Dolphin, while the kernel stamps real values (§5.3/§6.2). | Decide: accept station 0 as the §9.3 dev-loop convention (relay config gains nothing; station 0 just must not collide with a real station number), or add a `SlippiRelayStation` Dolphin config field + stamping. Lean: accept station 0 for dev — one fewer config knob; revisit only if two Dolphins ever need to hit one relay. |
| R11 | **Slippi Dolphin's injected Melee patches crash the shifted DOL** (observed 2026-09-19: Gecko code handler at `0x80001f18` jumps to ~0 at boot — its hooks assume vanilla 1.02 addresses). Our fork inherits the same injection, so the §9.3 dev loop would crash before the forwarder ever runs. | **Resolved for the dev loop ONLY, 2026-09-20:** the injections come from `Sys/GameSettings/GALE01r2.ini` (`[Gecko_Enabled]`), not compiled code — all entries are disabled on the fork's `reporter` branch (Data + staged Binary copies) so the menu boots. This is a dev expedient, **not** the venue answer — it directly conflicts with R12. The forwarder is native EXI-device code and is unaffected. |
| R12 | **Gecko codes / UCF must keep working at the venue** (user requirement, 2026-09-20). The venue's code set, all applied by **Slippi Nintendont** (not a flashed `.gct`): UCF (built into Slippi Nintendont); stage striking; music volume 0 by default; audio mono by default; D-pad up/down toggles rumble. **Plus the tournament defaults the user wants baked into our build (2026-09-20):** all characters and stages unlocked automatically, and default match rules of **4 stocks, 8:00 timer, no items** (these correspond to the `Unlock All Characters and Stages`, `Stock Mode`, `4 Stocks`, `8 Minutes`, `No Items` codes seen disabled in `GALE01r2.ini`). Mechanism found in the Nintendont fork (`kernel/Patch.c`, `common/config/MeleeCodes.c`): Nintendont applies these as **address-based patches**, gated by `GetMeleeVersion()` — which keys **only on the disc header** (`GAME_ID` at 0x0, version byte at 0x7). Our patched `SmashTournament.iso` keeps those as vanilla GALE01 v1.02 (required to boot as Melee), so Nintendont will detect `MELEE_VERSION_NTSC_2` and apply **vanilla-1.02 addresses to our shifted decomp DOL** → the R11 crash, on hardware. So on real Wiis the codes don't just fail to help — they actively crash the boot unless handled. Blocks venue rollout, not the Dolphin dev loop. | **Decide before rollout; couple with session 8 (same repo).** The codes live in Nintendont, which we already fork, and are applied from source — so the fix is mechanical rather than a rewrite: (a) the pure-settings ones (music 0, mono, rumble-toggle, likely stage striking) become **default-value edits in the decomp source** — no code/address at all; the unlock-all and 4-stock/8-min/no-items defaults are the same shape — set them in the decomp's match-init / save-data defaults from source rather than as address patches (this is item 7 of the 2026-09-20 feature batch, folded here per the user); (b) UCF is the substantial one — it exists as decomp-integratable source and has been baked into shifted decomp builds before, so add it to the melee build from source (link-time addresses, no vanilla assumptions); (c) whatever remains as a genuine address-based patch gets its target **re-resolved against the decomp symbol map** (the shifted address is known at build time) and applied by Nintendont for our build — which also needs `GetMeleeVersion()` taught to tell our build apart from stock vanilla so it doesn't apply the wrong (vanilla-addressed) set. Needs a dedicated investigation session in the melee + Nintendont forks. **(Earlier D-pad collision now moot:** our binds moved to the C-stick (§6.1), so the venue's D-pad rumble-toggle no longer overlaps them.) **Progress 2026-09-20:** the unlock-all + rules defaults are **done** — forced live at boot from our code (`mntourney.c forceKioskDefaults`: Stock/4/8:00, items off, all characters/stages unlocked) per the investigation (`melee/docs/kiosk-and-defaults-investigation.md`), which beats save-data overrides and touches no matched function. Still open in R12: **UCF** and the venue's own codes (music 0, mono, rumble-toggle, stage striking). **UCF investigation done 2026-09-20** (`melee/docs/ucf-investigation.md`): UCF 0.8 is 3 functional fixes (dashback, shield-drop, wiggle-out-of-tumble) + a cosmetic CSS label — 4 Gecko C2 insert-asm hooks (`Nintendont/kernel/gecko/g_ucf.bin`). All three read `fp->active_timer.lstick.{x,y}` (fp+0x670, computed in `Fighter_Spaghetti_8006AD10`, fighter.c) and re-derive the stick-threshold crossing from the raw analog stick to catch inputs vanilla drops (it does **not** change threshold constants). Decomp hooks: dashback `ftCo_Turn_IASA` (ftCo_Turn.c:160), shield-drop `ftCo_80099894`/`inlineB0` (ftCo_Escape.c:198), tumble `ftCo_DamageFall_IASA` (ftCo_DamageFall.c:124). **Matched-safe plan:** new TU `src/melee/ft/ucf.c` with thin IASA wrappers that correct `active_timer.lstick` then tail-call the vanilla IASA, wired by swapping the IASA pointers in the source data table `ftData_MotionStateList` (ftmotionstates.c:133) — same data-table pattern as our other hooks, no matched bodies touched. **Scope: medium, correctness-critical.** **Chosen approach (user, 2026-09-20): re-address, don't reimplement.** UCF crashes only because its Gecko hook addresses are vanilla-1.02 and our DOL is shifted — the asm itself is fine. So keep UCF's exact bytes (`g_ucf.bin`) and remap every absolute address it references (the C2 insert points + any `lis/ori`-built data/function addresses inside each payload) to our shifted DOL, then apply it as ordinary Gecko codes exactly like vanilla. This is byte-for-byte faithful (zero re-derivation risk) and less work than a source port. Mechanism: each vanilla address → symbol via `config/GALE01/symbols.txt`, → shifted address via `build/GALE01/main.elf` (or a `--map` build); a script regenerates the codes each build (addresses shift when our code changes). Applied via `GALE01r2.ini` `[Gecko]` for the Dolphin dev loop; on hardware, Nintendont must be made to apply *our* re-addressed set instead of its built-in vanilla UCF (its `GetMeleeVersion` gates on the disc header we spoof — session 8 / R12 Nintendont work). |
| R13 | **Per-game character data is mapped by port order, which need not match entrant order** (user, 2026-09-20). The Wii read the first two human CSS ports as slot 1 / slot 2, but a set's entrant 1 / entrant 2 have no fixed relation to physical ports — a player may sit at port 3 while being entrant 1 — so characters were assigned to the wrong entrant whenever port order ≠ entrant order. The winner was always fine (human-mapped by reading the overlay names). A related hole: a game reported before both characters were locked sent `ChKind_None`, which the relay rejected outright. | **Resolved 2026-09-20: defer character data to v2 (option a).** v1 reports **winners only** — the Wii sends no character (`p1_char`/`p2_char` = 0) and the relay ignores those fields (no selections in `gameData`). Both the port-order and None problems vanish. Character data returns in v2 via the GAME_END hook (§12), where the engine knows winner, stage, and per-port character authoritatively and a port→entrant mapping captured once at set start makes it correct. Landed: melee `lbtourney.c` (dropped `readChars`), relay `tcp.ts`/`startgg.ts`/fake (winners-only, 92 tests green). |
| R14 | **Kiosk menu flow + CSS overlay polish** (user, 2026-09-20). The station should behave as a dedicated tournament machine, not Melee-with-a-menu: (1) **boot straight into the set-selection screen** instead of the intro/main menu; (2) **after a set is uploaded (END_SET ok), return to set selection** rather than sitting on the CSS (`lbtourney.c pollRelay` currently just clears `has_set`); (3) **B on the CSS returns to set selection** when the CSS was entered from it (today CSS-B follows vanilla). Plus overlay polish: (4) set-list text has no space between "START"/round and the "NAME VS NAME BOx" (spacing/format bug in `mntourney.c drawSetLine` / the `A START  B BACK` hint — needs the user's screenshot to fix the exact spot); (5) a clearer "score submitted" visual than the current `!`→clear / `X` (`lbtourney.c redraw`); (6) move the CSS score overlay from its current spot (24,24) to a more readable area. | **Done 2026-09-20** (`melee/docs/kiosk-and-defaults-investigation.md` mapped the matched-safe hooks). (1) `mnTourney_MainMenuThink` auto-enters the Tournament submenu on the first frame (no Z) + re-lists — boots into the set list. (2)/(3) END_SET and CSS-back both return to the set list via `gmMainLib_GetGameRules()->force_main_menu = 1` + `gm_ChangeGameModeAfterCurrentScene(GM_MENU)` (the pair vanilla CSS-back uses) — no matched-function edits. (4) confirm rewritten to "START THIS SET?" on its own line (the START-jam was a **stale `mntourney.o`** — a clean rebuild fixed it). (5) explicit `SENDING… / SCORE SENT / SEND FAILED` status line. (6) score moved to the bottom under the panels. Not done: skipping the intro movie (would need one matched edit in `bootOnLoad`; deferred). |

---

## 12. What to revisit later

- **Auto score from game end.** The game knows who won; a `GAME_END` hook could append the game automatically, with CSS keybinds only for corrections. Deferred so v1 has exactly one source of score truth (the player). This is also where per-game character data returns (R13).
- **Friendlies / handwarmer modes** (user, 2026-09-20; do alongside automatic Slippi-file upload to the relay). Beyond the bracket-set flow, add two non-reporting modes selectable from the menu: **friendlies** (play without touching start.gg) and **handwarmer**. In handwarmer, the match timer **counts up** (rather than down) and **turns red once it crosses 1:00**. These pair with the replay-sink work (§9 in the runbook / auto-upload), since that's when the game↔relay channel carries match lifecycle beyond set reporting.
- **Station assignment.** If the event uses start.gg stations, `assignStation` on START_SET makes the bracket page show where sets are playing.
- **Probe follow-ups.** Two datapoints `scripts/probe.ts` deliberately skipped: re-assigning an already-assigned set (the rest of R1), and whether a decided score without `winnerId` auto-completes the set. Neither blocks v1 — END_SET always sends `winnerId` — so they're cheap probe tweaks only if a future feature needs them. ~~Spot-check `chars.ts` against the real API~~ — done 2026-09-19: all 26 mappings verified against `videogame(id: 1).characters` (ids 1–26, alphabetical, exact match).
- ~~Session-4 follow-up run~~ — **done 2026-09-20**: full set lifecycle (list → start → score ×2 → end 3-1 → reset) against the live event, all ST_OK, audit log matches start.gg exactly, chars.ts selections verified on live game rows, R8 warning rendered. One divergence found (resetSet keeps stream assignments — see §5.6); uint32 headroom confirmed (entrant ids ~24.7M, set ids ~108M).
- ~~Relay repo follow-up~~ — **done 2026-09-20**: `test/fake-startgg.ts` aligned with reality — resetSet keeps the stream assignment, fixture updated to Bo5 / "Winners Quarter-Final", tests assert the stream survives a reset/abandon.
- **Second relay for redundancy.** Not now — one Pi, one path, and the manual start.gg workflow is the fallback.
- **Non-stream overlay data.** The relay already knows every station's set and score; a per-station overlay for a second stream is a status-page query away.
