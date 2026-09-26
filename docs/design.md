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
 │  Melee 1.02, stock ISO (PowerPC)          │
 │   + tournament.bin, injected at boot      │
 │   ├─ Tournament menu                      │
 │   ├─ CSS score / auto-score               │
 │   └─ lbrelayexi.c ──EXI──┐                │
 │                          ▼                │
 │  Nintendont kernel (ARM / Starlet)        │
 │   ├─ Patch.c: loads tournament.bin        │
 │   └─ RelayEXI.c ── TCP ──┼────────────────┼──┐
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
station=3
stream=1
secret=<RELAY_SECRET>
```

`secret` (since 2026-09-25, R16) is the relay's shared secret, the same on every card. No relay address (since 2026-09-25, R15): each station finds the relay from its UDP beacon, so every card is identical except the station number and the one `stream=1`, and the Pi's address may change freely.

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

### 4.7 Stock Melee ISO + a boot-time module, not a rebuilt DOL (2026-09-24)

Until 2026-09-24 the kiosk was a **shifted decomp DOL** appended to a copy of the ISO (`SmashTournament-vN.iso`, v1-v39). Everything vanilla-addressed then broke on it: Slippi's recording codes (no `.slp` on hardware or in Dolphin - R11/R12), Nintendont's venue codesets (UCF, neutral spawns, striking, stealth nametags, rumble toggle - re-ported natively, at real cost, twice), and every build meant copying 1.4 GB to each Wii. Now the Wiis run their **stock Melee 1.02** and the kiosk code is a **position-fixed module**, `tournament.bin` (~26 KB), that the loader copies to the top of MEM1 at boot and wires in with two dozen word patches (scene/menu-table pointers, two `b` hijacks, one hijacked menu row). Consequences: Slippi recording, USB hotswap and every venue gecko code behave exactly as on any other Slippi Nintendont; the venue's own mods are no longer ours to maintain (the native ports are retired); a kiosk update is a 26 KB file on the SD card; the same file loads in our Ishiiruka fork for the dev loop (§9.3). Details: §6.1 (module), §6.2 item 5 (kernel loader), melee `docs/tournament-module.md`. The shifted-DOL line is frozen at tag `shifted-dol-final` (branch `reporter`) in all four repos; the module work is on `vanilla-module`.

---

## 5. Wire protocol (Wii ↔ relay)

Transport: TCP, one connection per request, request then response, connection closed. Simplest possible thing for the kernel side; the request rate is far too low for connection reuse to matter.

**Shared secret (R16, 2026-09-25):** on the TCP connection the host (kernel, Dolphin forwarder) writes a 20-byte `relay_auth` {`'M','K'`, pad, `secret[16]`} before the game's `relay_hdr` + payload; the game never builds or sees it. The relay compares the secret in constant time and answers a wrong one (`"wrong relay secret"`) or a missing block (`"no relay secret sent"`, told apart by the first two bytes `'M','T'`) with `ST_BAD_SECRET`, echoing the request's `relay_hdr`, without acting. Responses are unchanged.

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
6. If `stream=1`: `assignStream(setId, streamId)` (the stream id resolved at startup from `config.streamName`, §6.3).
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

Relay behavior: translate slots → entrant ids, build `gameData` as `{gameNum, winnerId, stageId?, selections?}` per game, call `reportBracketSet(setId, gameData)` **without** `winnerId` (set-level). Full overwrite every time — idempotent. **Since 2026-09-22 (melee v38 / relay):** `p1_char`/`p2_char` (external CharacterKind of entrant 1/2) go out as `selections` via `chars.ts` and `stage` (Melee StKind) as `stageId` via `stages.ts`; a `0`/unmapped value is simply omitted, never a rejection — a hand-scored game carries the winner only. The Wii fills all three only on the auto-score path, where the match standings make them authoritative (R13).

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

**Files** (compiled only into the module by `tools/build_module.py`, never into a DOL; the `--non-matching` DOL build no longer carries them):
- `melee/mn/mntourney.c` — the Tournament menu: list, name filter, confirm screen, error screen, boot warm-up, `forceKioskDefaults` (rules/unlocks/stage mask asserted live).
- `melee/lb/lbtourney.c` — set state (current set, games[5]), CSS binds, nametag seeding and who-is-who, Z+X handwarmer, auto-score from `MatchEnd`, CSS/in-match overlays.
- `melee/lb/lbbuttonglyph.c` — button icons: four 32x32 I4 shapes in a module-owned SIS font slot (index 4, never used by the game), letters from the built-in font over them.
- `melee/lb/lbmodule_glue.c` — the vanilla statics the kiosk reads (`mnCharSel_*`), `tm_bootOnLoad`, `tm_menuLightColor`.
- `tools/module_hooks.txt` — the patch table (`ptr`/`branch`/`word` per line, vanilla addresses); `tools/build_module.py` — compiles the TUs with the DOL's MWCC flags plus `-sdata 0 -sdata2 0 -DTOURNAMENT_MODULE`, links them at `0x817E0000` against `config/GALE01/symbols.txt` (every vanilla external becomes an absolute `sym = 0xADDR` in a generated LCF), refuses any patch/blob address that a venue codeset (`Nintendont/kernel/gecko/*.bin`) also writes, and packs `build/GALE01/tournament.bin`: `"TMOD"`, version 1, load address, blob length, patch count, guard `{0x8016D800, 0x7C0802A6}`, patches `{addr, u32}`, blob (.text+.rodata+.data+zeroed .bss). Loaders refuse the file unless the guard word is in RAM (stock 1.02) and the arena top is still above the load address; after copying they write the load address to `0x80000034`, which Melee's `OSInit` adopts as arenaHi, so the module sits above the heap.
- `melee/lb/lbrelayexi.c` — EXI request/poll helpers. The decomp has **no Slippi code** (found 2026-09-19, session 5): this is a new EXI driver on the vanilla SDK API (`dolphin/os/OSExi`; template: `hio.c`), speaking the `exi_cmd` commands from `relay_proto.h` to the fake relay device that Slippi Dolphin (§9.3) and Nintendont (§6.2) implement.

**Menu flow** (set list redesigned 2026-09-25 after the design pitch, "Direction B" - https://claude.ai/artifact/G5rAMHpcbk9gUNdmR9ca5H):

```
Boot ─► Tournament (auto-entered; B from the list shows the vanilla main menu, Z re-enters)
          ├─ Searching  the host has not heard the relay's beacon yet (R15): LOOKING FOR THE
          │             RELAY + pulse, pane STATION n / SEARCHING; the first request waits
          │             for it (lbRelayExi_Peek reads exi_poll_hdr with nothing in flight).
          │             10 s without a beacon -> NO RELAY FOUND, "is this setup on the
          │             relay's network?"; A searches again, B backs out
          ├─ Loading    list area: LOADING SETS + a three-dot pulse; the pane shows
          │             STATION n / RELAY a.b.c.d / PORT p from exi_poll_hdr (host-filled
          │             from the beacon, so it shows even while the relay is silent)
          ├─ Set list   two panes inside the vanilla panel. Rows are "tag VS tag" on a
          │             fixed VS axis, grouped under round-name headers (WINNERS
          │             QUARTER-FINAL ...); the cursor row is yellow on a translucent bar.
          │             The pane on the right describes the highlighted set: round, both
          │             tags, BEST OF n, READY / PLAYING HERE, A START (A RESUME for the set
          │             this station is already playing, which sits under an amber PLAYING
          │             HERE header). Header: L ALL SETS R (or NAMES: X) and the position
          │             "10-17 OF 56" with an up cue once scrolled; "n MORE" under the last row.
          │             Up/down move, left/right page, L/R first-letter filter, X jumps to
          │             the set this station is playing, Y refreshes (cursor stays on the
          │             same set_id), Z friendlies, B main menu
          │    A ─► Confirm  same frame: the list dims, the pane asks START THIS SET? with
          │                  both tags; A ─► START_SET ─► OK ─► CSS; B back to the list
          └─ Error      same frame: NO LINK TO THE RELAY or THE RELAY SAID NO, the message,
                        YOUR LIST IS STILL HERE / NO SETS LOADED YET; A retries, B back
```

Sizes follow the TV floor: rows at SIS scale 0.70 (18 px cap), headers 0.55, hints 0.50, nothing that matters below 0.50; long tags share one shrunk scale (floor 0.58) then get cut with a `-` tail. The two panes are rounded translucent navy panels with a thin light-blue rim (three block pieces plus four quarter-disc glyphs that never overlap, the rim from quarter-ring glyphs, all stretched by per-entry x/y scale), and every line is drawn twice, a 2 px black shadow under the text, so the grid can show through without costing TV contrast - four text objects because glyph alpha is per `HSD_Text` (panel fill, shadow, cursor bar, opaque). Chosen 2026-09-25 from four rendered variants (`TM_LOOK` in mntourney.c; the pitch's flat near-black scrims are variant 0). The TOURNAMENT title is a **texture**, not text: a 256x48 IA8 wordmark carried in the module (`lbwordmark.c`, authored by `tools/gen_wordmark.py` from a system font) and drawn in the panel's title tab by the vanilla sprite helper `lb_800138EC` - the first textured object in the kiosk, and the proof that embedded art works on this route (pitch phase 2). Two facts about that helper that are not in its signature: its object is a camera on the "max" GX link, which is the frame's camera pass run in ascending priority (the kiosk text camera is 0x13, the wordmark 0x14; at 0 the menu background paints over it), and its alpha argument is inverted (the TEV computes `(1 - alpha) * texture alpha`, so 0 is opaque and 0xFF invisible). The menu scene's SIS text pool is raised from 18 KB to 30 KB by a hook on `preloadState`'s `li` immediate: the allocator panics with "Memory Empty" otherwise, and 30 KB is the largest size a single `li` can express. Rounds arrive as full names (`ROUND_LEN` 24) and the relay sends sets earliest round first, so equal names are adjacent and headers fall out of the order.

**CSS keybinds** (only active when a set is current):

| Input | Action |
|-------|--------|
| L + R (hold 1 s; each trigger at its click or any analog press) | Port claim: this port is the player named first on the set (entrant 1); the other human port is entrant 2. A hold from the other controller moves the claim (the undo) |
| L + R + B (hold 1 s) | Clear the claim |
| Z + C-stick left  | The player shown on the LEFT of the banner wins a game |
| Z + C-stick right | The player shown on the right wins a game |
| Z + C-stick down  | Undo last game |
| Z + C-stick up (hold 1 s) | End set (requires a decided score) |

Inputs are read from **any** controller — every port is scanned, and any port holding Z drives the set (in Dolphin only port 1 is emulated by default). Win/undo fire once per flick (edge into a cardinal); end is a sustained hold.

(Input history, 2026-09-20: End set was first `Z + Start` — but Start is Melee's native "advance to stage select" on the CSS and changes scene before a hold completes. Moved to the d-pad, then to the **C-stick**: the C-stick has no native CSS action, is reachable on standard *and* box controllers (a d-pad is not), and leaves the d-pad free for the venue's rumble-toggle code (R12).)

Each action sends `REPORT_SCORE` (or `END_SET`) immediately. **The score lives in the CSS's own rules banner** (2026-09-25, user request): the box that reads "4-man survival test!" in vanilla is an `HSD_Text` the CSS binds to premade string slot 0x4A of font 0 and renders from that byte buffer every frame, so the module points the slot and the text at a buffer of its own holding the vanilla leading opcodes plus the score as plain glyph codes (`MANGO P1  2 - 1  P3 ZAIN`; 0x2000 + atlas index, the text's own kerning). Box, position, centring and shrink-to-fit stay vanilla; the game's ASCII encoder was not used because its fixed-width digit run puts the dash in a full cell. The banner is also the status (design review round 2, 2026-09-25; the separate status line is retired): the digits are yellow, amber while a report is in flight, green for two seconds after SCORE SENT and red after a failure; the whole banner alternates every two seconds with `SEND FAILED - TELL THE TO` (red), reads `HANDWARMER - NOT SCORED` (amber) while the flag is armed, and shows the auto-score note (`GAME 2 TO MANGO`, amber) for five seconds. The one overlay line left is the handwarmer hint, top-right (`Z+X WARMUP` / `Z+X CANCELS`, kept short because the venue's `UCF 0.84` label shares that line); it and the in-match handwarmer clock carry the set list's 2 px drop shadow. **Who is who (user requirement, 2026-09-25):** tags are optional, because a tag cut to four characters can read badly or spell something unwanted. The player named first on the set (entrant 1) holds **L + R for one second** on their own controller and the other human port becomes entrant 2 (`ALPHA IS P3` in the banner for five seconds). **L + R + B** clears the claim (`PORTS CLEARED`) and a hold from the other controller moves it, which is the undo for the wrong player claiming. A claim overrides the tags for the banner, the auto-score and the C-stick binds, resets at START_SET and END_SET, and once both ports are known the banner puts the **lower port on the left** (`BRAVO P1  0 - 0  P3 ALPHA`), the C-left / C-right corrections following the displayed sides. Until someone is placed the banner alternates every two seconds with `HOLD L+R IF YOU ARE <name>`. L + R was chosen for friction: two triggers held for a second do not fire by accident, and neither trigger has a CSS action of its own. A trigger counts at its digital click or at any analog press (raw `analogL/R >= 49` of the game's 0-140 clamp; the user's light R press reads 50), because not every controller has a click and a light press must do (user, 2026-09-25); the friction is the two-trigger one-second hold, not the depth. Auto-scored games (v37+) carry the entrants' characters and the stage from the match standings; hand-scored corrections carry the winner only (R13). END_SET is gated on a clinched score (`wins >= best_of/2 + 1`).

**EXI usage:** `EXI_RELAY_REQ` (write request buffer) and `EXI_RELAY_POLL` (read `{state, response buffer}`) — command ids and poll states are defined in `protocol.yaml` (`exi_cmd`, `exi_poll_state`) so the game, the Dolphin forwarder, and the kernel can't drift; values (0xF0/0xF1) sit clear of Slippi's EXI command space, which extends to 0xE5. The game never blocks: the menu shows "Loading…" and polls once per frame. Response buffer is a static 4 KB region in `lbrelayexi.c`, `ATTRIBUTE_ALIGN(32)` as EXI DMA requires.

**EXI device contract** (as built in session 6; authoritative header `melee/src/melee/lb/lbrelayexi.h`, details in melee `docs/session6-report.md`) — what the Dolphin forwarder (§9.3) and Nintendont (§6.2) must implement:
- Address: **channel 1, device 0, frequency 4** (Slot B — the device Slippi Dolphin already exposes).
- REQ: 4-byte immediate command word (`EXI_RELAY_REQ << 24`), then `relay_hdr` + payload via EXIImmEx (8–36 bytes), one select window.
- POLL: immediate command word (`EXI_RELAY_POLL << 24`), then exactly 4096 bytes DMA-read by the game: byte 0 = `exi_poll_state`, 3 pad bytes, then `relay_hdr` (echoing the request's cmd), `relay_resp`, payload.
- The game treats any poll state other than DONE/ERROR (including the 0xFF an absent device reads) as "still waiting" and times out after **5 s** (the kernel's own budget is 3 s). On `RELAY_ERROR` the response buffer is zeroed.

**Menu route:** the Tournament menu lives in `GS_MENU` and **hijacks the main menu's Trophies row** (`MENU_KIND_TOY`, row 3 of `mn_803EB6B0`; the vanilla table cannot grow and a kiosk has no use for trophies). The module's patches: row 3's think/description/selection count; the main-menu think (auto-enters the set list on the first ready frame - power-on lands on the list); the `GS_MENU` on_exit and the `GS_VS`/`GS_CSS` frame/exit rows of the scene table; `bootOnLoad` (a `b` over its first instruction: straight to `GM_MENU`, no movie/title); the panel's per-kind animation rows for kind 3 (the plain frame the shifted build got by reading past the end of the table - frames 0-49 then 0-10 of the main-menu enter, no title); and the menu light colour for kind 3 (the colour function is inlined twice, so two jump-table entries plus the out-of-line copy - main-menu blue, not Trophies green). All screens are SIS text overlays on a 640x480 ortho canvas (the gmtitle build-timestamp pattern); no new assets on the disc. History: sessions 5-6 entered the menu by a Z press on the main menu with a grown table (kind 35) in the shifted DOL; R14 made it auto-enter.

**Constraints honored:** no malloc, no string parsing, all buffers static, all struct sizes asserted at compile time against the generated header.

### 6.2 Nintendont kernel (ARM, C)

**Files:** `kernel/RelayEXI.c` + `.h`.

Responsibilities, and nothing else:
1. Parse `tournament.cfg` at boot (station, stream; R15 took the relay address out) using the kernel-side FatFS pattern (`ConfigInit()` / `f_open_main_drive`). Missing or malformed file → set a flag; every relay command returns `ST_INTERNAL` with `msg="no tournament.cfg"`.
1b. **Find the relay from its beacon** (R15): while the relay thread is idle and the network is up, own a non-blocking UDP socket bound to `BEACON_PORT` and take the latest valid `relay_beacon`'s source address and `tcp_port` as the relay; fill `exi_poll_hdr.relay_ip`/`relay_port` from it (0 until heard) and answer requests with `ST_INTERNAL` `"no relay found yet"` until then.
2. **Stamp `hdr.station` (every request) and `start_set_req.stream` (START_SET) from `tournament.cfg`** — the game always sends 0 for both (§5.3).
3. On `EXI_RELAY_REQ`: copy the request buffer, set `RELAY_BUSY`, and hand off to a **dedicated kernel thread** that does socket → connect → send → recv → close with the 3 s budget enforced via the existing `poll()`-with-deadline pattern (SlippiNetwork.c). **The EXI handler itself must never block** (R3 resolved 2026-09-19): there is no EXI interrupt context — the game's EXI writes are serviced by the kernel's single main loop, and the game sits frozen inside the patched EXI transfer until that loop acks, so a block there freezes the console.
4. On `EXI_RELAY_POLL`: return `{state: RELAY_IDLE|BUSY|DONE|ERROR, buffer}` in the §6.1 poll layout (zeroed buffer on ERROR). The Slippi-era EXI path never DMAs data back to the game, so the poll response uses the memcard read-back pattern: write through the DMA pointer, then `sync_after_write`.
5. **Load `sd:/tournament.bin`** (`kernel/Patch.c LoadTournamentModule`, 2026-09-24): in the full-DOL patch pass, when the disc is `MELEE_VERSION_NTSC_2`, after the GCT/Slippi-core block and before `PatchState = PATCH_STATE_DONE` - header and guard check, arena check, `f_read` of the blob straight to MEM1, the patch words, then the load address into `0x80000034`. A missing file logs one line and leaves a plain Slippi Nintendont. Nothing Slippi is touched (core codes, MeleeCodes toggles, replays, hotswap): the DOL is stock, so the venue's codesets apply exactly as before. The 2026-09-22 version-gate bypass (`254853c`) is reverted.

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
| `chars.ts` | Melee external char id (`CharacterKind`) → start.gg character id table, used for `selections` since the auto-score path landed (R13). All 26 mappings verified live 2026-09-19. |
| `stages.ts` | Melee `StKind` → start.gg stage id table (29 stages; the API's `videogame(id: 1).stages`, read 2026-09-22 with `probe.ts --stages`). 0 / unused ids → no `stageId`. |

**Config** (`/etc/tournament-reporter/config.json`):

```json
{
  "startggEndpoint": "https://api.start.gg/gql/alpha",
  "token": "…",
  "tournament": "abbey",
  "eventName": "Melee Singles",
  "streamName": "SFMelee",
  "secret": "…",
  "streamStation": 1,
  "tcpPort": 7777,
  "httpPort": 8080,
  "auditDir": "/var/lib/tournament-reporter"
}
```

Startup validates every field and exits non-zero on any problem. No defaults — `auditDir` is explicit config rather than a hardcoded path (session 4: a hidden default, and it breaks Windows dev), and `startggEndpoint` is explicit for the same reason (2026-09-22: the built `dist/main.js` is rehearsed against `test/fake-startgg.ts` served by `npm run fake`, so the URL cannot be a constant). `deploy/push.ps1` writes the file; a test pins the fields it writes to `config.ts`.

**Tonight's event is found, not configured (2026-09-25).** The config names the tournament, event and stream; `src/resolve.ts` turns them into ids once at startup, because the ids change every week and the names do not. `tournament` is either a start.gg short URL (`abbey`) or a full slug (`tournament/<slug>`), told apart by shape, never by trying one and then the other:

- **Short URL** → found among the token owner's admin tournaments (`currentUser.tournaments(filter: {tournamentView: "admin"})`, paged). The Abbey TO moves `abbey` to each week's tournament and renames the old one (`abbey159`, ...), so the relay follows the series with no weekly push. The API's own `tournament(slug: "abbey")` returned null on 2026-09-25 while `abbey` pointed at the upcoming #160 (it did resolve `sfmeleetest`), so the admin list is the lookup that works. The relay needs admin rights to report anyway.
- **Abbey backup** (user, 2026-09-25, taken from matchcaller, the venue's start.gg/abbey monitor, whose resolver does the same after its own short-URL lookup): if no admin tournament carries the short URL `abbey`, the relay takes the admin tournament named `Melee @ Abbey Tavern #N` whose start is nearest to now, within 30 days, a future one winning a tie. It uses the admin list already fetched: no extra call, and no scraping the start.gg/abbey redirect, which is behind Cloudflare's bot challenge in matchcaller's experience. **A deliberate exception to "no fallbacks"**, scoped to the one short URL `abbey`; the startup log says which rule found the tournament (`by short URL` / `by nearest Abbey weekly`). It is only right on or near the night (run on 2026-09-25, two days after #159, it picks #159), so the short URL stays first, and the unit waits for `time-sync.target` so a Pi without a battery clock does not judge "nearest" by last week's time.
- **Full slug** → `tournament(slug)` directly. Needed for an unpublished tournament, which no list query returns under any filter (checked 2026-09-25 with `probe.ts --find-short`): the test tournament, `tournament/sf-melee-discord-test`.

Then the event is the one Melee (videogame 1) singles (type 1) event whose name contains `eventName` case-insensitively, and the stream is the one named `streamName`. Doubles is type 5, so it never matches; the waitlist and ladder are singles but lack "Melee Singles". Zero or several matches is a startup failure listing what was there. Verified against the real API with the relay's own code (`probe.ts --resolve`, 2026-09-25): the test tournament resolves to event 1613010 / stream 1358079 (the ids previously configured by hand), `abbey` to Melee @ Abbey Tavern #160, event 1717518 / stream 1420980. Resolution happens only at startup: the Pi is powered on at the venue each week, and a restart re-resolves. The status page header shows the tournament and event names so a stale week is visible.

**start.gg calls used:**

| Relay action | GraphQL |
|--------------|---------|
| startup (short URL) | `currentUser.tournaments(query: {page, perPage: 50, filter: {tournamentView: "admin"}})` → `{slug shortSlug}`, until the short URL is found |
| startup | `tournament(slug)` → `events {id name type videogame {id}}`, `streams {id streamName}` |
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

- Build the module (`python tools/build_module.py` in the melee fork) and boot the **stock** `Smash.iso` in our Ishiiruka fork with `SlippiTournamentModule = <path to tournament.bin>` and `HLE_BS2 = True` in `User/Config/Dolphin.ini`: `CBoot::EmulatedBS2_GC` (`Boot_BS2Emu.cpp LoadTournamentModule`) loads the file exactly as the kernel does, before the patch engine runs. Rebuild the module, restart the game - no ISO work.
- Gecko codes are **on**, and the list is ours: `Data/Sys/GameSettings/GALE01r2.ini` (and the `Binary/x64/Sys` copy) is generated by `Tools/make_venue_ini.py` - upstream Slippi's ini with `[Gecko_Enabled]` = `Required: Slippi Recording` plus the venue's Nintendont codesets converted byte-for-byte from `Nintendont/kernel/gecko/*.bin` (UCF 0.84, Tournament Mods on; Frozen Pokemon Stadium listed, off). Slippi's *General Codes* / *Slippi Online* stay off: they are the netplay experience (Salty Runback, the online CSS) and blank the kiosk text. Re-run the script whenever the venue's toggles change. (`[Gecko_Enabled]` names must not carry the `[creator]` suffix or they silently do nothing.)
- The Slippi EXI device forwards `EXI_RELAY_REQ`/`POLL` to the relay over TCP (`EXI_DeviceSlippi.cpp`), unchanged since session 7. End-to-end loop on one machine with a debugger and frame stepping.
- A game played here writes a `.slp` to `SlippiReplayDir` - the proof that recording survives the module. The menu UX iterates here; nothing UX-related needs a Wii.

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

**Wii (each station):** stock Melee 1.02 image on USB or SD, exactly as at any Slippi local, booted by **our Nintendont build** (the venue's Slippi Nintendont plus `RelayEXI.c` and the module loader; `loader/data/kernel.zip` is the whole difference). On the SD card root: `tournament.cfg` (station number and stream flag - per card; no relay address, R15) and `tournament.bin` (the kiosk module - the same file on every card). Updating the kiosk = replacing that one file. The venue's own Nintendont toggles (UCF 0.84, Tournament mods, stages, music/mono) stay whatever the venue runs. **Not yet run on a real Wii with the module (2026-09-24)** - the loader is built; the hardware test is the next step.

**Pi:** Raspberry Pi 5 (a 4 or Zero 2 W also works), Raspberry Pi OS Lite 64-bit, on the venue Wi-Fi (user, 2026-09-25; Ethernet works the same). Step-by-step in `docs/pi-setup.md`; the kit is `deploy/`:

| File | Role |
|------|------|
| `deploy/push.ps1` | Run on the Windows dev PC: `npm run build` (tsc → `dist/`, no runtime npm deps), writes `config.json` (token from `.env`; tournament `abbey` by default, `tournament/sf-melee-discord-test` with `-Test`; `-EventName`, `-StreamName`), scp's the bundle, runs the installer over ssh (`-PiHost`/`-User` for another Pi, e.g. the venue's matchcaller Pi). Needed only to update the relay or switch modes, not per tournament. |
| `deploy/uninstall.sh` | Removes exactly what install.sh added (unit, `relay` user, `/opt` Node + code, `/etc` config; audit logs kept unless `--purge`), for a shared Pi. |
| `deploy/install.sh` | Run on the Pi by push.ps1 (sudo): pinned official Node 22 tarball at `/opt/node`, Wi-Fi power saving off (NetworkManager `wifi.powersave = 2`: it causes latency spikes and mDNS drops, and a Wii gives up after 3 s), system user `relay`, code at `/opt/tournament-reporter`, config at `/etc/tournament-reporter/config.json` (root:relay 0640), unit installed and restarted, waits for `relay up:`. Idempotent. |
| `deploy/tournament-reporter.service` | systemd unit: `ExecStart=/opt/node/bin/node /opt/tournament-reporter/dist/main.js`, `Environment=CONFIG=…`, `Restart=on-failure`, runs as `relay`. |
| `deploy/add-wifi.sh` | Saves another Wi-Fi network (the venue's) with NetworkManager, from anywhere; the Pi joins whichever saved network is in range. Prompts for the password. |
| `scripts/smoke.ts` | From the PC: one LIST_SETS over the wire protocol plus a status-page fetch against the deployed relay. |

Logs to journald; audit log to `/var/lib/tournament-reporter/<eventId>.jsonl` (one file per tournament).

**Status 2026-09-24** — two kits were built independently (2026-09-22: clone-on-Pi, nvm, hand-edited `config.example.json`, unit run as `pi`; 2026-09-24: build-on-Windows, push over ssh) and reconciled to the second: the Pi never needs git, npm or a GitHub credential, and the config is generated from `.env`, so `config.example.json` is gone. Kept from the first: `npm run build` (`dist/main.js` entry via the root `main.ts`; `generated/wire.ts` compiled in place), `startggEndpoint` as an explicit required config field (push.ps1 writes the production URL; a rehearsal points it at `npm run fake -- --port=N`), `npm run sim -- --relay=host:port` to drive an external relay, the README's config table and night-of table. Rehearsed on the dev machine 2026-09-22: built relay against `npm run fake`, 600 s of `sim --relay`: 12 stations, 122 sets completed, 749 Wii requests (peak 80/min), 8 benign ST_SET_TAKEN races, **0 errors**; upstream 643 calls, **peak 67/min** against the 70/min guard (the sim paces one action every ~12 s per station — 5× the §6.3 estimate — a stress number, not the venue rate). Windows-side kit verified 2026-09-24 (dry-run bundle, generated config through `loadConfig`, `smoke.ts` against the fake stack). **Not yet run on a real Pi.**

**Per-tournament setup checklist** (this replaces nothing; it's added to the existing setup):
1. Power the Pi on at the venue (or restart the relay). It finds tonight's tournament from the short URL; nothing is pushed per tournament. Check the status page header names tonight's tournament and event and the footer shows the set count.
2. **Start all pools and phases on start.gg** (bracket page → every phase, later phases included). Any unstarted pool or phase has preview-id sets the relay drops (R8) — the live event showed 37 dropped across unstarted pool 2 plus the later phases; the status page warns until this is done.
3. Confirm each SD card's `tournament.cfg` station number matches the physical station label. Exactly one has `stream=1`. Every card carries the current `tournament.bin` (same file everywhere; the boot log prints its load address).
4. Boot one Wii, open Tournament menu, confirm the set list loads.

**Status: done 2026-09-22** — checklist is in README.md ("Per-tournament checklist"), with a "The night of" table keyed on what the status page shows. The status page (F7) now shows per station the set, score, last action with age and the status/msg the player saw, and every failed start.gg call with message and age (sticky until ack); footer has event id, cache size split selectable / on stations, cache age with a stale warning after 60 s, upstream rate, last refresh error, and the R8 preview warning. Server-rendered, no client JS beyond the 5 s meta refresh; phone-width layout checked.

**Network:** revised 2026-09-25: the Pi will most likely be on the venue Wi-Fi, and static IPs cannot be guaranteed. Wiis on Ethernet where possible (Wii Wi-Fi is 802.11g and unreliable on a busy venue network). The Wiis find the Pi from its UDP beacon (R15), so its address does not matter; the Pi, the Wiis and the TO's phone just have to share one network. Guest Wi-Fi with client isolation would block Wii→Pi traffic entirely: check once at the venue with `scripts/smoke.ts` from a laptop on the same Wi-Fi.

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
| R11 | **Slippi Dolphin's injected Melee patches crash the shifted DOL** (observed 2026-09-19: Gecko code handler at `0x80001f18` jumps to ~0 at boot — its hooks assume vanilla 1.02 addresses). Our fork inherits the same injection, so the §9.3 dev loop would crash before the forwarder ever runs. | **Resolved 2026-09-21 — root cause found, permanent answer = cheats off + every mod native (see end of cell; the 2026-09-20 note below was the partial understanding).** Originally: the injections come from `Sys/GameSettings/GALE01r2.ini` (`[Gecko_Enabled]`), not compiled code — all entries are disabled on the fork's `reporter` branch (Data + staged Binary copies) so the menu boots. This is a dev expedient, **not** the venue answer — it directly conflicts with R12. The forwarder is native EXI-device code and is unaffected. **Root cause nailed 2026-09-21 (debugger callstack):** it is not the `.ini` entries at all. With `EnableCheats = True`, Slippi Ishiiruka installs its **own** vanilla-addressed `Sys/bootloader.gct` into the codelist (`GeckoCode.cpp:171-191`) regardless of what `[Gecko_Enabled]` says, so the gecko handler (`0x80001f18`) patches vanilla 1.02 addresses into our shifted DOL and it dies in `mnMain_Scene_OnEnter` (`HSD_ObjAllocAddFree` reading a trashed free-list pointer, PC in heap `0x8133xxxx`) — every boot. Disabling entries was only ever "working" because cheats were off. **Consequence:** Gecko codes are unusable in Ishiiruka for this build, full stop; `EnableCheats` must stay OFF, and every venue mod is compiled into the DOL (see R12). **Closed by architecture 2026-09-24 (§4.7):** the DOL is stock again, so Slippi's bootloader and recording codes are correct by definition; `EnableCheats` is back on in Ishiiruka with a generated code list (§9.3). The cheats-off rule and the native ports are history (`reporter` branch). |
| R12 | **Gecko codes / UCF must keep working at the venue** (user requirement, 2026-09-20). The venue's code set, all applied by **Slippi Nintendont** (not a flashed `.gct`): UCF (built into Slippi Nintendont); stage striking; music volume 0 by default; audio mono by default; D-pad up/down toggles rumble. **Plus the tournament defaults the user wants baked into our build (2026-09-20):** all characters and stages unlocked automatically, and default match rules of **4 stocks, 8:00 timer, no items** (these correspond to the `Unlock All Characters and Stages`, `Stock Mode`, `4 Stocks`, `8 Minutes`, `No Items` codes seen disabled in `GALE01r2.ini`). Mechanism found in the Nintendont fork (`kernel/Patch.c`, `common/config/MeleeCodes.c`): Nintendont applies these as **address-based patches**, gated by `GetMeleeVersion()` — which keys **only on the disc header** (`GAME_ID` at 0x0, version byte at 0x7). Our patched `SmashTournament.iso` keeps those as vanilla GALE01 v1.02 (required to boot as Melee), so Nintendont will detect `MELEE_VERSION_NTSC_2` and apply **vanilla-1.02 addresses to our shifted decomp DOL** → the R11 crash, on hardware. So on real Wiis the codes don't just fail to help — they actively crash the boot unless handled. Blocks venue rollout, not the Dolphin dev loop. | **Decide before rollout; couple with session 8 (same repo).** The codes live in Nintendont, which we already fork, and are applied from source — so the fix is mechanical rather than a rewrite: (a) the pure-settings ones (music 0, mono, rumble-toggle, likely stage striking) become **default-value edits in the decomp source** — no code/address at all; the unlock-all and 4-stock/8-min/no-items defaults are the same shape — set them in the decomp's match-init / save-data defaults from source rather than as address patches (this is item 7 of the 2026-09-20 feature batch, folded here per the user); (b) UCF is the substantial one — it exists as decomp-integratable source and has been baked into shifted decomp builds before, so add it to the melee build from source (link-time addresses, no vanilla assumptions); (c) whatever remains as a genuine address-based patch gets its target **re-resolved against the decomp symbol map** (the shifted address is known at build time) and applied by Nintendont for our build — which also needs `GetMeleeVersion()` taught to tell our build apart from stock vanilla so it doesn't apply the wrong (vanilla-addressed) set. Needs a dedicated investigation session in the melee + Nintendont forks. **(Earlier D-pad collision now moot:** our binds moved to the C-stick (§6.1), so the venue's D-pad rumble-toggle no longer overlaps them.) **Progress 2026-09-20:** the unlock-all + rules defaults are **done** — forced live at boot from our code (`mntourney.c forceKioskDefaults`: Stock/4/8:00, items off, all characters/stages unlocked) per the investigation (`melee/docs/kiosk-and-defaults-investigation.md`), which beats save-data overrides and touches no matched function. **Two value-bugs found on test and fixed (`melee/docs/defaults-debug.md`):** "items off" is `item_freq = -1` (0xFF), not 0 (0 is the *lowest ON* setting); real stage unlock is `gm_8016468C()`, not `stage_mask` (which is only the per-match legal-stage toggle). Characters and stock/timer were already correct. Still open in R12: **UCF** and the venue's own codes (music 0, mono, rumble-toggle, stage striking). **UCF investigation done 2026-09-20** (`melee/docs/ucf-investigation.md`): UCF 0.8 is 3 functional fixes (dashback, shield-drop, wiggle-out-of-tumble) + a cosmetic CSS label — 4 Gecko C2 insert-asm hooks (`Nintendont/kernel/gecko/g_ucf.bin`). All three read `fp->active_timer.lstick.{x,y}` (fp+0x670, computed in `Fighter_Spaghetti_8006AD10`, fighter.c) and re-derive the stick-threshold crossing from the raw analog stick to catch inputs vanilla drops (it does **not** change threshold constants). Decomp hooks: dashback `ftCo_Turn_IASA` (ftCo_Turn.c:160), shield-drop `ftCo_80099894`/`inlineB0` (ftCo_Escape.c:198), tumble `ftCo_DamageFall_IASA` (ftCo_DamageFall.c:124). **Matched-safe plan:** new TU `src/melee/ft/ucf.c` with thin IASA wrappers that correct `active_timer.lstick` then tail-call the vanilla IASA, wired by swapping the IASA pointers in the source data table `ftData_MotionStateList` (ftmotionstates.c:133) — same data-table pattern as our other hooks, no matched bodies touched. **Scope: medium, correctness-critical.** **Chosen approach (user, 2026-09-20): re-address, don't reimplement.** UCF crashes only because its Gecko hook addresses are vanilla-1.02 and our DOL is shifted — the asm itself is fine. So keep UCF's exact bytes (`g_ucf.bin`) and remap every absolute address it references (the C2 insert points + any `lis/ori`-built data/function addresses inside each payload) to our shifted DOL, then apply it as ordinary Gecko codes exactly like vanilla. This is byte-for-byte faithful (zero re-derivation risk) and less work than a source port. Mechanism: each vanilla address → symbol via `config/GALE01/symbols.txt`, → shifted address via `build/GALE01/main.elf` (or a `--map` build); a script regenerates the codes each build (addresses shift when our code changes). Applied via `GALE01r2.ini` `[Gecko]` for the Dolphin dev loop; on hardware, Nintendont must be made to apply *our* re-addressed set instead of its built-in vanilla UCF (its `GetMeleeVersion` gates on the disc header we spoof — session 8 / R12 Nintendont work). **Superseded 2026-09-21 — everything goes native.** The re-addressed Gecko route is dead: (1) it can never apply in our dev emulator (R11 root cause — cheats-on installs Slippi's vanilla `bootloader.gct`), and (2) its r13-relative float constants (`un_804D6DC8/DD8/DAC`) re-resolve to soundtest `u8`/`s32` globals in our build, so even applied it would read garbage. Pivot (user decision, after analysis): compile every venue mod into the DOL as native source via data-table hooks — zero matched-function edits, works in any Dolphin and on hardware. **Done:** audio — mono (`OSSetSoundMode(0)`) + music-off (`sound_balance = 100`) asserted once when the set list is first up (`mntourney.c tm_audio_set`): a stable frame, after the memcard save-load (which overwrote the boot default), before any match. Forcing `sound_balance` live at menu-*enter* crashes the GX texture path mid scene-transition (bisected v12–v15) — never write audio-mix fields there. **Done:** neutral spawns — `lbneutralspawn.c`, a faithful transcription of the decoded `NeutralSpawn.asm` (6-stage table, FFA/teams layouts `pos[is_teams][order]`, the asm's slot ordering — Human slots 0–3 in order, then Cpu, then Demo — facing `x > 0 → -1`; stages outside the table keep vanilla spawns, never the case for the kiosk's six). **Delivered as a documented matched-function edit:** `lbNeutralSpawn_Override()` is called from `fn_8016E2BC` (gmvs.c) at the exact spot the asm's C2 hook inserts (`+0x254`) — right after `getSpawnPoint`, before `Player_80032768`/`Player_80031AD0` store the coordinate and spawn the fighter from it. Second such exception after `bootOnLoad` (user ruling 2026-09-21: the matched-function rule is decomp hygiene, not a correctness constraint; a documented edit is acceptable when it is the faithful port). **Why not a data hook (v18/v19, both failed identically):** `rules.on_match_start` fires *after* vanilla's placement loop has already spawned every fighter, so rewriting the slot's spawn pose there (`Player_80032768`) is inert, and even a live teleport (`cur_pos`/`coll_data`) did not take — fighters stayed at vanilla's `spawn_point` 2/3. Verified 2026-09-21: 2P Battlefield starts on the side platforms; FoD coordinates cross-checked byte-for-byte against the ini's original asm (P1 `-41.25,21` / P2 `41.25,27` — the venue's real values, on the side platforms). **Done 2026-09-21: UCF 0.8** — `lbucf.c`, an asm-faithful transcription of the three functional C2 payloads (dashback → `ucf_Turn_IASA`; wiggle-out-of-tumble → `ucf_DamageFall_IASA`; shield-drop → `ucf_DropGuardedIASA` around the Guard/GuardOn/GuardOff/GuardReflect/Wait/AppealS IASAs), delivered as thin wrappers installed by swapping `input_cb` pointers in `ftData_MotionStateList` (a data table — no matched edit), installed once from `lbTourney_CSSFrame`. Where the asm fakes a compare result inside a matched function, the wrapper instead sets the window constant that compare reads (`x214`/`x314`) for the duration of the call and restores it. The cosmetic "UCF 0.8" CSS label is not carried. Known gap (documented in lbucf.c): `ftCo_Wait_IASA`/`ftCo_DamageFall_IASA` are also called *directly* from other states, bypassing the table wrap; wrap those rows if it ever matters. Feel-tested green: dashback, shield-drop, tumble wiggle. **With this every venue mod is native in the DOL — zero gecko codes.** **Big consequence for hardware:** with the mods in the DOL, Nintendont no longer has to inject *anything* for our build — it only has to *not* apply its own vanilla set — so the session-8 "teach Nintendont to apply our re-addressed codes" task shrinks to a version-gate bypass. **Closed 2026-09-24 (§4.7):** with the stock DOL the venue's codesets apply unmodified on hardware (Nintendont injects only the module on top of them) and, converted verbatim from the same `.bin` files, in Dolphin. `lbucf.c`, `lbneutralspawn.c`, the striking/nametag edits and the audio defaults are retired - the venue's toggles own them. Verified in Dolphin 2026-09-24: UCF, neutral spawns, striking, Sheik tag hide, `.slp` written. Hardware test pending. |
| R13 | **Per-game character data is mapped by port order, which need not match entrant order** (user, 2026-09-20). The Wii read the first two human CSS ports as slot 1 / slot 2, but a set's entrant 1 / entrant 2 have no fixed relation to physical ports — a player may sit at port 3 while being entrant 1 — so characters were assigned to the wrong entrant whenever port order ≠ entrant order. The winner was always fine (human-mapped by reading the overlay names). A related hole: a game reported before both characters were locked sent `ChKind_None`, which the relay rejected outright. | **Resolved 2026-09-20: defer character data to v2 (option a).** v1 reports **winners only** — the Wii sends no character (`p1_char`/`p2_char` = 0) and the relay ignores those fields (no selections in `gameData`). Both the port-order and None problems vanish. Character data returns in v2 via the GAME_END hook (§12), where the engine knows winner, stage, and per-port character authoritatively and a port→entrant mapping captured once at set start makes it correct. Landed: melee `lbtourney.c` (dropped `readChars`), relay `tcp.ts`/`startgg.ts`/fake (winners-only, 92 tests green). **Characters and stage are back, correctly, 2026-09-22:** the auto-score path (§12) reads `MatchEnd.player_standings[].ckind` per slot and maps slots to entrants via the nametags, and the stage from the start rules; `game_result` gained a `stage` byte (the old pad, layout unchanged). Hand-scored games still send zeros = winner only. |
| R15 | **How a Wii finds the relay when the Pi's address is not fixed** (user, 2026-09-25: the Pi will most likely be on Wi-Fi, and static IPs cannot be guaranteed). Until then every SD card's `tournament.cfg` carried `relay_ip=`/`relay_port=`, so a changed Pi address broke every station until each card was edited. | **Decided 2026-09-25 (user): relay discovery, and built in all four repos the same night.** Options weighed: (a) DHCP reservation on the venue router, (b) a Pi-added fixed address on top of DHCP, (c) discovery, (d) bring our own network (travel router, or the Pi owning a wired Wii subnet). (c) won because it removes the only per-venue value from every card and survives any network where a Wii can reach the Pi at all. **Contract** (`protocol.yaml`): the relay broadcasts a 12-byte `relay_beacon` {magic `MT`, `PROTO_VERSION`, `tcp_port`, `event_id`} every `BEACON_INTERVAL_MS` (2000) to UDP `BEACON_PORT` (7778), to each IPv4 interface's directed broadcast address, recomputed every tick. A station takes the datagram's **source address** plus `tcp_port` as the relay; only an exact-size datagram with the right magic and version counts; the latest one wins, so a relay that changes address is followed. One relay per LAN. **Built:** relay `src/beacon.ts` (tournament-reporter dc6d08e; status page footer shows the targets and any send error); Nintendont `RelayEXI.c` `serviceBeacon()` on the idle relay thread with its own `recvfromAddr()`, because `net.c` `recvfrom()` cannot return the source address (Nintendont 66cf735); Ishiiruka forwarder listener thread, `SlippiRelayAddress` removed (a9e0901a1); melee header copy only (8926d0ef5), since `exi_poll_hdr.relay_ip`/`relay_port` are host-filled and read 0 until a beacon is heard. A request before any beacon answers `ST_INTERNAL` `"no relay found yet"`. `tournament.cfg` is now `station` + `stream` only; old `relay_ip`/`relay_port` lines are ignored. **Verified:** a station-style listener on this PC received the built relay's beacons with the right source address, port and event; the kernel and Dolphin build clean. **Verified in Dolphin 2026-09-25** (kiosk session): stock ISO + module with nothing configured found a built relay by its beacon and loaded the live list. The game no longer requests before the host knows the relay: melee 6704311fa peeks `exi_poll_hdr` (`lbRelayExi_Peek`) and shows LOOKING FOR THE RELAY until `relay_ip` is non-zero, NO RELAY FOUND after 10 s; the synthetic `"no relay found yet"` answer stays as a guard. **Not yet verified:** a real Wii receiving a beacon (the kernel's `recvfromAddr` uses libogc's `IOCTLV_SO_RECVFROM` vector layout, which nothing in this kernel used before; first suspect if `relay_ip` stays 0 on hardware). **Still true:** guest Wi-Fi with client isolation blocks Wii-to-Pi traffic whatever the addressing; check once at the venue. |
| R16 | **The relay is reachable by anyone on the venue Wi-Fi** (2026-09-25, a consequence of R15's Wi-Fi decision). The Wii protocol and the status page were designed for a private wired LAN and have no authentication; on guest Wi-Fi any phone could send START/REPORT/END with the TO's token behind them, and the beacon advertises where. | **Done 2026-09-25 (user asked): a shared secret**, the same value every week. `protocol.yaml` `relay_auth` (see §5); relay config `secret` (8-16 of `A-Z a-z 0-9 - _`, from `.env` `RELAY_SECRET` via `push.ps1`); Wii `tournament.cfg` `secret=`; Dolphin `SlippiRelaySecret`. Refusals are audited (`refused`, with source address and claimed station) and counted on the status page ("N request(s) refused: wrong relay secret — last … from … claiming station …"); an unauthenticated station number never creates a station row. **Limits, accepted:** the secret crosses the Wi-Fi in plain text, so it stops passers-by and scanners, not someone capturing the Wi-Fi traffic; the upgrade path is an HMAC over each request with a relay-issued nonce (needs SHA-256 in the ARM kernel). The status page's read-only view and its "ack" button stay open on the LAN: ack only hides a flag. Built: relay (tournament-reporter 8922bb6), Nintendont `RelayEXI.c` (52b5a23), Ishiiruka forwarder (b918db0b3); the game only gains the `ST_BAD_SECRET` value, worded on the kiosk as RELAY SECRET MISMATCH / CHECK THE SECRET ON THIS CARD (melee 441ec0130). **Verified 2026-09-25:** the built relay with the real secret served the smoke test and refused and counted a wrong secret; Dolphin with `SlippiRelaySecret` set found a relay by beacon and loaded the live list (kiosk session). **Not yet verified:** a real Wii sending the secret. |
| R14 | **Kiosk menu flow + CSS overlay polish** (user, 2026-09-20). The station should behave as a dedicated tournament machine, not Melee-with-a-menu: (1) **boot straight into the set-selection screen** instead of the intro/main menu; (2) **after a set is uploaded (END_SET ok), return to set selection** rather than sitting on the CSS (`lbtourney.c pollRelay` currently just clears `has_set`); (3) **B on the CSS returns to set selection** when the CSS was entered from it (today CSS-B follows vanilla). Plus overlay polish: (4) set-list text has no space between "START"/round and the "NAME VS NAME BOx" (spacing/format bug in `mntourney.c drawSetLine` / the `A START  B BACK` hint — needs the user's screenshot to fix the exact spot); (5) a clearer "score submitted" visual than the current `!`→clear / `X` (`lbtourney.c redraw`); (6) move the CSS score overlay from its current spot (24,24) to a more readable area. | **Done 2026-09-20** (`melee/docs/kiosk-and-defaults-investigation.md` mapped the matched-safe hooks). (1) `mnTourney_MainMenuThink` auto-enters the Tournament submenu on the first frame (no Z) + re-lists — boots into the set list. (2)/(3) END_SET and CSS-back both return to the set list via `gmMainLib_GetGameRules()->force_main_menu = 1` + `gm_ChangeGameModeAfterCurrentScene(GM_MENU)` (the pair vanilla CSS-back uses) — no matched-function edits. (4) confirm rewritten to "START THIS SET?" on its own line (the START-jam was a **stale `mntourney.o`** — a clean rebuild fixed it). (5) explicit `SENDING… / SCORE SENT / SEND FAILED` status line. (6) score moved to the bottom under the panels. **2026-09-20 additions:** intro movie + title now skipped — `bootOnLoad` (gmboot.c) points at `GM_MENU` (an intentional, documented matched-function edit — the boot target has no data-table lever; the venue wants power-on into the set list). **Friendlies mode:** Z on the set list enters the CSS with no set active (nothing reported); force_main_menu is now set on every kiosk CSS visit so B-back returns to the set list from friendlies too. |

---

## 12. What to revisit later

- **Tournament screen redesign (2026-09-25).** Phase 1 of the pitch (https://claude.ai/artifact/G5rAMHpcbk9gUNdmR9ca5H, "Direction B") shipped in the module: two-pane set list, grouped rows on a VS axis, cursor bar, detail pane, in-frame confirm/loading/error, the wire changes (full round names, `exi_poll_hdr`). Verified in Dolphin: list (5 sets and 56 sets with scroll cues), error view; the confirm/starting views are drawn by the same code but were not captured (no controller input in the headless dev loop) - check them on the first Wii run, along with the bar's translucency on a CRT. **Phase 2 shipped 2026-09-25** (melee `441ec0130`): the wordmark texture through `lb_800138EC`, 24 KB IA8 in the module; see §6.1 for the helper's two traps. Open: **phase 3** (a GET_ASSET relay-EXI command streaming a venue logo from the SD card, drawn by the same helper), the CSS overlay and in-match clock now share the set list's shadows and the score moved into the CSS's own banner (melee `bc04ef0f8`). Also open: a SIS text object's `bg_color` quad and independent x/y scale are the only two SIS features the pitch found unused; the bar uses the second, the first is still free.
- **Vanilla-module follow-ups (2026-09-24, §4.7).** (1) Hardware test of the loader: boot log shows `Patch:Apply Slippi core` *and* the module line, the set list comes up, `.slp` on USB, unplug/replug mid-session still records. (2) Behaviours the shifted build had from its own source that the venue codesets may not: the **SSS six-legal-stages-only filter** and the **Y un-strike** (`mnstagesel.c`, retired) and the **selection-hand shake** on the rumble toggle - check them on the venue Wii and edit the poster/checklist to whatever the venue code does. (3) Frozen Pokemon Stadium is listed but off in the Dolphin ini; keep it equal to the venue's Nintendont "stages" toggle. (4) `forceKioskDefaults` still pins rules/unlocks/stage mask live; if Slippi core's own default writes prove enough it can go. (5) A Tournament-menu redesign is being pitched (2026-09-24) - any new textures/models would ride in the module blob or be streamed over the relay EXI device from the SD card, never on the disc.
- **Auto score from game end.** ~~Deferred~~ **Shipped 2026-09-22 (melee v37).** `lbTourney_MatchExit` runs the vanilla GS_VS exit (which fills the scene's `MatchEnd`: outcome + per-slot type/nametag/stocks/percent) and decides the game from it - KO or time-out only (LRA+Start is `NO CONTEST`, not scored), exactly two human slots, winner = more stocks then less damage, exact tie left to the players. Who-is-who comes from the seeded nametags with the user's rule: one picked tag among two players identifies both, or, since 2026-09-25, from the L + R port claim, which overrides the tags (§6.1). The game is appended and REPORT_SCORE sent on the first CSS frame back; the status line says `GAME n TO <TAG>` or why nothing was scored. The C-stick binds are now the correction path (undo / re-score). Handwarmers are skipped by the flag. **v38 adds per-game characters and stage** from the same standings (R13 closed): `p1_char`/`p2_char` are the entrants' CharacterKind ids and `stage` the StKind; the relay maps them to start.gg `selections`/`stageId` (`chars.ts`, new `stages.ts`).
- **Friendlies / handwarmer modes** (user, 2026-09-20). **Both shipped game-side (v14 friendlies via Z on the set list; v24 handwarmer, 2026-09-22):** on the CSS, **Z + X** flags the next game as a handwarmer (and, when the CSS is ready, starts it at once on **Battlefield** with no stage select - user, 2026-09-25, a random legal stage before; the module's GS_SSS on_enter wrapper writes `force_stage_id = St_Kind_Battle` and the SSS skips itself) (top-of-screen hint flips to `HANDWARMER NEXT - NOT SCORED`), the in-match overlay draws a **count-up clock in the top-left that turns red past 1:00** beside the native HUD timer, and the flag **clears itself once that game is played**. A `NEXT: GAME n` line was tried in v24 and removed at the user's request (2026-09-22): a "which game is next" indicator only earns its place once the game **detects the winner automatically** (the auto-score item above) - do the two together. It is informational — the C-stick score binds remain the one source of score truth — but it's the flag a future auto-score hook (above) must gate on. Still open from the original note: telling the *relay* about handwarmers/friendlies, which only matters once the replay-sink / auto-upload work (§9 in the runbook) carries match lifecycle over the game↔relay channel. The native timer itself still counts down (replacing it is a bigger HUD edit than the overlay warrants).
- **Who is who (v24, 2026-09-22).** START_SET writes the set's two tags into persistent nametag slots 0/1 (4 chars, A-Z/0-9; the kiosk card is the venue's), so they top the CSS tag dropdown; the CSS score line shows the port that picked each (`MANGO P1  0 - 0  P3 ZAIN`). It is the port↔entrant mapping the auto-score hook uses. **Optional since 2026-09-25:** the L + R port claim (§6.1) is the tag-free way to say who is who, with L + R + B / a re-hold as the undo, and the banner shows the lower port on the left once both are known. Caveat baked in: once a tag is picked, Melee reads in-match rumble from the tag (`gm_RumbleEnabledForPlayer`), so the D-pad toggle and the tag pick keep the tag flag in step with the port.
- **Button glyphs in the kiosk overlays** (user, 2026-09-22). The CSS/set-list hints spell buttons out (`Z AND X`). **Answered 2026-09-22: the font has no button glyphs.** The one SIS font is `HSD_SisLib_FontAtlas` in the DOL (287 glyphs, 32x32 I4; rendered as a sheet from the ELF): digits, A-Z, a-z, hiragana, katakana, ~40 symbols, 24 kanji - nothing controller-shaped. Side find: the encoder (`hsd_3A64.c`) maps only a few ASCII bytes and treats the rest as Shift-JIS lead bytes, so `+ ( ) / ! ?` etc. are reachable as 2-byte SJIS escapes (`"{"` = `+`) - the checklist has the list. **Shipped 2026-09-22 (melee v35) a third way:** the atlas is C data in our build, so four button *shapes* were appended to it and drawn as coloured glyphs with the font's own letter overlaid (`lbbuttonglyph.c`, `#A`/`#Z` markers in overlay strings, GameCube colours) - inline with text, kerned, no textures or JObjs. Every texture Melee ships was dumped first (scratch `dump_dat_textures.py`, 11 archives, ~1,750 textures): the game has standalone A/B/Start/L-R art only (MnMaAll.usd #534/#535/#454-456/#337), Z only baked into `Z RETRY`/`Z SNAP PHOTO`, and no X/Y/C-stick at all. Had that failed, the next-best source is the game's own **pause-screen button icons** (user, 2026-09-22: they exist there, almost certainly as textures, not font glyphs) - the pause overlay lives in the interface archive `ifAll_GetArchive()` loads (`IfAll.usd`), so those TObjs can be borrowed and drawn as a small JObj/TObj overlay beside our SIS text without importing anything. User-supplied images are the last resort (texture insert into a DAT). Blocked on the font-sheet look, not on the user.
- **Kiosk poster** (`docs/kiosk-poster.html`, 2026-09-22). First pass at the printable one-page controls sheet for players (set list, CSS scoring binds, striking, status lines). Written blind the night v24 was built, before testing; the header comment in the file lists what to fix when coming back to it (re-verify binds against the shipped build, proof the print layout, a real visual pass, maybe a scoring-only quick card).
- **Station assignment.** If the event uses start.gg stations, `assignStation` on START_SET makes the bracket page show where sets are playing.
- **Phased / pooled bracket integration** (user, 2026-09-20). For now the test event runs as **one flat single-phase bracket** (no pools, no Top-cut phases) so the relay always has live sets to show. Revisit how the relay's `event.sets` query and set lifecycle behave across a **multi-phase** structure (pools → Top 24 → Top 8): confirm the `state: [1,2]` filter surfaces only the currently-playable phase, that preview/unassigned sets in not-yet-started phases are handled (R8 already drops preview sets), and that progression sets appear correctly as earlier phases complete. The 3-phase structure was reset to flat on the test tournament (`sf-melee-discord-test`, event `Melee Singles! (7:30 Start)`) — rebuild a phased copy when testing this.
- **Probe follow-ups.** Two datapoints `scripts/probe.ts` deliberately skipped: re-assigning an already-assigned set (the rest of R1), and whether a decided score without `winnerId` auto-completes the set. Neither blocks v1 — END_SET always sends `winnerId` — so they're cheap probe tweaks only if a future feature needs them. ~~Spot-check `chars.ts` against the real API~~ — done 2026-09-19: all 26 mappings verified against `videogame(id: 1).characters` (ids 1–26, alphabetical, exact match).
- ~~Session-4 follow-up run~~ — **done 2026-09-20**: full set lifecycle (list → start → score ×2 → end 3-1 → reset) against the live event, all ST_OK, audit log matches start.gg exactly, chars.ts selections verified on live game rows, R8 warning rendered. One divergence found (resetSet keeps stream assignments — see §5.6); uint32 headroom confirmed (entrant ids ~24.7M, set ids ~108M).
- ~~Relay repo follow-up~~ — **done 2026-09-20**: `test/fake-startgg.ts` aligned with reality — resetSet keeps the stream assignment, fixture updated to Bo5 / "Winners Quarter-Final", tests assert the stream survives a reset/abandon.
- **Second relay for redundancy.** Not now — one Pi, one path, and the manual start.gg workflow is the fallback.
- **Non-stream overlay data.** The relay already knows every station's set and score; a per-station overlay for a second stream is a status-page query away.
