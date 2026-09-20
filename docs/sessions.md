# Runbook: Claude Code sessions for Tournament Reporter

Each session is one repo, one goal, one definition of done. Run them in the order listed. Anything a session learns that changes the design comes back to chat and into `design.md` before the next session starts.

Prompts are meant to be pasted as the first message of a fresh session. Replace `YOU` with your GitHub user.

---

## 0. Bootstrap

Only four things need a human. Everything else in setup is one Claude Code session.

**By hand, once:**
1. Install `gh` (cli.github.com) and run `gh auth login`. Install the Claude Code desktop app and sign in.
2. On start.gg: create an unpublished test tournament with one Melee singles event, ~16 fake entrants, a stream under Streams. Generate a developer API token. Note the event ID, stream ID, and any pending set ID.
3. Copy the session-1 output files (protocol.yaml, gen_protocol.py, check_protocol.py, relay_proto.h, wire.ts, design.md, and this runbook) into `P:\Projects\Automated Tournament Reporter\incoming\`.
4. Later, for session 8: a dev Wii with Slippi Nintendont, a USB LAN adapter, on the same switch as your dev machine.

**Claude Code session — open in `P:\Projects\Automated Tournament Reporter`:**

> This folder is the root of the Tournament Reporter project. `incoming\` holds files to place. Read `incoming\design.md` and `incoming\claude-code-sessions.md` first, then do the following and stop after each numbered step to show me the result:
> 1. Rename the GitHub repo `setcall-relay` to `tournament-reporter` (`gh repo rename`), clone it here if not present, and lay it out: `protocol.yaml` at root, `docs\design.md`, `docs\sessions.md` (the runbook), `tools\gen_protocol.py`, `tools\check_protocol.py`, `generated\relay_proto.h`, `generated\wire.ts`, empty `src\ test\ scripts\`. `.gitignore` with `.env`, `node_modules/`, `__pycache__/`, `dist/`. Run `python tools\check_protocol.py` and show me it passes.
> 2. Write `tournament-reporter\CLAUDE.md` with the content from the runbook's session 2. Create `.env` with placeholder keys STARTGG_TOKEN, EVENT_ID, STREAM_ID, TEST_SET_ID (I'll fill it).
> 3. `gh repo fork doldecomp/melee --clone` and `gh repo fork project-slippi/Nintendont --clone` into this folder; create branch `reporter` in each; write each fork's `CLAUDE.md` from the runbook (sessions 5 and 3); copy `generated\relay_proto.h` into `melee\include\`.
> 4. Commit and push `tournament-reporter` (main) and both forks (branch `reporter`).
> 5. Follow the doldecomp/melee README to set up the Windows build toolchain and run `ninja` in `melee\`. Tell me exactly what you need from me (downloads, licensed tools) rather than working around it. The build must produce a matching DOL before we continue.
> Delete `incoming\` when everything is placed.

**Done when:** `tools\check_protocol.py` passes, all three repos are pushed, `ninja` builds a matching DOL, and you've filled `.env`.

---

## 1. Relay repo — protocol source of truth

**Repo:** `tournament-reporter`
**Status: done.** Output landed as `protocol.yaml` (repo root), `tools/gen_protocol.py`, `tools/check_protocol.py`, `generated/relay_proto.h`, `generated/wire.ts`. These paths are canonical from here on.

**First message:**

> Read docs/design.md fully. Then:
> 1. Create `protocol.yaml` encoding every struct and enum in §5 exactly — field name, type, size, byte offset, and any pad. Big-endian. Include PROTO_VERSION=1.
> 2. Write `gen/gen.py` (stdlib only) that emits `gen/relay_proto.h` (packed C structs with `_Static_assert` on every sizeof) and `src/wire.ts` (encode/decode using DataView, big-endian) from protocol.yaml.
> 3. Write `tools/check_protocol.py` that regenerates both and fails if they differ from the committed versions.
> Commit the generated files. Don't add anything not in §5.

**Done when:** `tools/check_protocol.py` passes, and you've read `relay_proto.h` and it matches §5 byte for byte.

**Back to chat:** any place the YAML forced a decision §5 left ambiguous.

---

## 2. Relay — start.gg probe (R1 / R2)

**Repo:** `tournament-reporter`
**Status: done 2026-09-19.** R1/R2 resolved (see design.md §11); `scripts/probe.ts` committed. Two skipped datapoints recorded in design.md §12.
**Prep:** `.env` filled in (bootstrap created it). `CLAUDE.md` already written by bootstrap; contents for reference:

```
This is the Tournament Reporter LAN relay from docs/design.md §6.3.
Node 22, TypeScript, no framework. generated/wire.ts is GENERATED from protocol.yaml by tools/gen_protocol.py — import it from src/, never copy or hand-edit it.
Principles: one path, no fallbacks, fail fast at startup on bad config, no retries except start.gg 5xx (max 2).
npm test must pass. Integration tests use test/fake-startgg.ts, never the real API.
The real API is touched only by scripts/probe.ts using .env (gitignored).
```

**First message:**

> Read CLAUDE.md and docs/design.md §5, §6.3, §11 (R1, R2). Write `scripts/probe.ts` only. It should, against the test tournament in .env, in order:
> 1. `markSetInProgress(TEST_SET_ID)`
> 2. `assignStream(TEST_SET_ID, STREAM_ID)`
> 3. `reportBracketSet` with gameData for one game (winner = entrant 1) and NO winnerId
> 4. Query the set back and print state, stream, and games
> 5. `reportBracketSet` again with two games and NO winnerId, query again
> 6. `resetSet(TEST_SET_ID)`
> Print every raw GraphQL response. If any mutation doesn't exist in the schema, introspect and print the closest candidates instead of guessing. Do not write any other code.

**Done when:** you've run it and can answer, from output: does `assignStream` exist and work as designed; does partial `reportBracketSet` overwrite game data without completing the set.

**Back to chat:** the answers. If either is "no," the design changes before session 4.

---

## 3. Nintendont — read-only investigation (R3)

**Repo:** `Nintendont` (your fork, branch `reporter`)
**Status: done 2026-09-19.** R3 resolved: blocking is unsafe; §6.2 is the dedicated-thread state machine. Output: `docs/relay-exi-investigation.md` in the fork. New R9 (connect() timeout) for session 8.
**Prep:** none; `CLAUDE.md` written by bootstrap:

```
Fork of Slippi Nintendont, branch reporter, for RelayEXI. Design: ../tournament-reporter/docs/design.md §6.2.
ARM kernel code; cannot be built or run here.
New code goes only in kernel/RelayEXI.c and kernel/RelayEXI.h.
Every claim about EXI handler context, blocking, sockets, or memory must cite file:line.
Do not write code unless the prompt asks for it.
```

**First message:**

> Read CLAUDE.md and ../tournament-reporter/docs/design.md §6.2 and R3. Investigation only, no code. Answer with file:line citations:
> 1. Where does the Slippi EXI device handle writes from the game, and in what execution context (interrupt, thread, main loop)?
> 2. How does the Slippi broadcast feature open its socket and send data? Which network API, which thread?
> 3. Is it safe to perform a blocking TCP connect/send/recv with a 3 s timeout from the place EXI writes are handled? If not, describe the minimal state machine that is safe, still using one code path.
> 4. Can a second TCP socket coexist with the broadcast socket, and what are the memory limits on buffers in the kernel?
> 5. How is the Slippi config / nickname read from SD at boot? I'll reuse that pattern for tournament.cfg.
> Write the answers to docs/relay-exi-investigation.md.

**Done when:** you've read the doc and spot-checked at least two citations yourself.

**Back to chat:** question 3's answer. It decides whether §6.2 is "blocking request" or "state machine."

---

## 4. Relay — build

**Repo:** `tournament-reporter`
**Status: done 2026-09-19.** 91 tests green, sim-wii passes (peak 66/70 per min, 0 errors), status page verified. R8 implemented as option (a). Follow-up run against the live test tournament still pending (design.md §12).
**Prep:** if session 2 changed anything in the design, update `docs/design.md` and `protocol.yaml` and regenerate first.

**First message:**

> Read CLAUDE.md and docs/design.md §5–§9. Build the relay per §6.3 with these modules: tcp.ts, cache.ts, startgg.ts, state.ts, audit.ts, status.ts, chars.ts, config.ts, main.ts. src/wire.ts is provided; use it, don't modify it.
> Work in this order, committing after each: (a) config.ts with fail-fast validation and tests; (b) test/fake-startgg.ts serving fixtures recorded from scripts/probe.ts output; (c) startgg.ts with the rate limiter and 5xx retry, tested against the fake; (d) cache.ts; (e) tcp.ts + state.ts handling all five commands with every row of the §8 table covered by a test; (f) audit.ts; (g) status.ts; (h) scripts/sim-wii.ts driving 12 fake stations for 10 minutes and asserting upstream call rate < 70/min and zero errors.
> Stop and ask before adding any dependency beyond typescript, tsx, and a test runner.

**Done when:** `npm test` green, `sim-wii.ts` passes, status page renders in a browser with the 12 simulated stations.

**Follow-up sessions in this repo:** "Run probe against the real test tournament through the relay's tcp port using sim-wii for one station; compare the audit log to the start.gg set page."

---

## 5. Melee decomp — read-only orientation

**Repo:** `melee` (your fork, branch `reporter`)
**Status: done 2026-09-19.** Output: `docs/menu-orientation.md` in the fork. Key findings folded into design.md: no Slippi code in the decomp, external CharacterKind ids, R4 resolved.
**Prep:** none; `CLAUDE.md` written by bootstrap:

```
Fork of doldecomp/melee, branch reporter, for the tournament menu. Design: ../tournament-reporter/docs/design.md §6.1.
New code lives only in melee/mn/mntourney.c, melee/lb/lbtourney.c, melee/lb/lbrelayexi.c.
Never modify a matched function. The DOL is shifted; matching is not required for new files.
Include relay_proto.h copied from ../tournament-reporter/generated/ into include/; never redefine structs.
No malloc, no string parsing, all buffers static. Follow existing menu file patterns.
Build with ninja. If the build breaks, fix the cause, don't work around it.
```

**First message:**

> Read CLAUDE.md and ../tournament-reporter/docs/design.md §6.1. Investigation only, no code. Write docs/menu-orientation.md answering with file:line:
> 1. How is a menu screen registered, drawn, and given input in this codebase? Use the sound test or debug menu as the worked example.
> 2. How does the game currently issue EXI reads/writes to the Slippi device? Which functions, which buffer sizes?
> 3. Where in the CSS code can I read each port's currently selected character id, and where does the CSS run its per-frame input handling?
> 4. Where does the game-end sequence run, and what struct holds winner, stage, and per-port character at that point? (For the v2 GAME_END hook.)
> 5. How much free RAM does the current build report, and where are static buffers typically declared?

**Done when:** you've read it and it matches your own understanding of the codebase.

---

## 6. Melee decomp — menu and CSS keybinds

**Repo:** `melee` (branch `reporter`)
**Status: built 2026-09-19, awaiting the user's Dolphin test.** Three commits + `docs/session6-report.md` in the fork (EXI device contract, deviations folded into design.md §6.1). Expected in Dolphin: Z on main menu → LOADING → 5 s timeout; empty memcard Slot B first.
**Prep:** `cp ../tournament-reporter/generated/relay_proto.h include/`. Have Slippi Dolphin ready to run the built DOL.

**First message:**

> Read CLAUDE.md, docs/menu-orientation.md, and ../tournament-reporter/docs/design.md §6.1. Implement in three commits:
> 1. lbrelayexi.c: EXI_RELAY_REQ / EXI_RELAY_POLL helpers per §6.1, static 4 KB response buffer, one request in flight at a time, `_Static_assert` on all struct sizes.
> 2. mntourney.c: the Tournament menu per the §6.1 flow — loading, list with L/R first-letter filter, confirm, error screen with A=retry B=back. Register it on the main menu.
> 3. lbtourney.c: set state and the CSS keybinds table from §6.1, score drawn in the CSS corner with `!` in flight and `✗` on failure. Ignore inputs while a request is in flight.
> Build with ninja after each commit. I'll test in Dolphin and report back; don't guess at visual results.

**Done when:** menu appears in Dolphin. (EXI won't return anything yet — that's session 7. The "Loading…" screen with a timeout error is the expected end state.)

---

## 7. Slippi Dolphin — EXI forwarder

**Repo:** `Ishiiruka` (fork, branch `reporter`)
**Status: implemented 2026-09-19, uncommitted, not yet build-verified** (no C++ toolchain on the dev box at the time). Forwarder in EXI_DeviceSlippi + SlippiRelayAddress config field. Open: build it, commit, and R10 (station stamping) in design.md §11.
**Prep:** `gh repo fork project-slippi/Ishiiruka --clone && cd Ishiiruka && git checkout -b reporter`, inside `P:\\Projects\\Automated Tournament Reporter\\`. Confirm you can build Slippi Dolphin locally first.

**First message:**

> Read ../tournament-reporter/docs/design.md §6.1 and §9.3. In the Slippi EXI device implementation, add handling for EXI_RELAY_REQ and EXI_RELAY_POLL (command ids from ../tournament-reporter/generated/relay_proto.h): on REQ, open a TCP connection to the relay address from a new Slippi config field, send the buffer, receive the response into a buffer with a 3 s timeout, and expose state + buffer on POLL. One code path, no retries. Cite where you found the existing EXI command dispatch.

**Done when:** in Dolphin, with the relay running, the Tournament menu lists sets from the test tournament and starting one shows up in start.gg. Then iterate on menu UX in session 6's repo until it feels right at a venue.

---

## 8. Nintendont — RelayEXI implementation

**Repo:** `Nintendont` (branch `reporter`)
**Prep:** dev Wii on the switch, relay running on your dev machine, `sd:/tournament.cfg` written by hand.

**First message:**

> Read CLAUDE.md, docs/relay-exi-investigation.md, and ../tournament-reporter/docs/design.md §6.2. Implement kernel/RelayEXI.c per the investigation's answer to question 3 (blocking or state machine — whichever it concluded). Read tournament.cfg at boot using the same pattern as the Slippi nickname; missing or malformed file makes every relay command return ST_INTERNAL with msg "no tournament.cfg". Log every request and response (cmd, len, status, elapsed ms) to the network log. Wire the two EXI commands into the existing Slippi EXI dispatch. One commit.

**Done when:** the dev Wii shows the set list, starts a set, reports a score, and the network log shows each round trip under 500 ms. Then the bench test from §9.6 step 1 with two Wiis.

---

## 9. Replay sink (v2, after a clean tournament)

**Repo:** `tournament-reporter` (new package `replay-sink/`, separate process)

**First message:**

> Read docs/design.md §13. Write replay-sink as a separate Node process: a TCP server speaking the Slippi Nintendont broadcast protocol (read Slippi Launcher's spectate client to learn it — cite the source), writing complete .slp files to `<eventId>/<setId>-g<n>.slp`. Station identity from the Nintendont nickname; set and game number from the relay's state via a local HTTP call to the status server. Unknown station → write to `unassigned/` and log a warning; never drop data.

(Add §13 to docs/design.md before this session: the correlation scheme from chat, the socket-coexistence answer from session 3, and the storage/sync plan.)

---

## Habits for every session

- Start every session with "Read CLAUDE.md." It's cheap and it stops drift.
- One repo per session. Don't open the decomp and the relay in the same session even when the bug spans both; fix the contract in `tournament-reporter/protocol.yaml`, regenerate, and copy `relay_proto.h` into the fork.
- When it asserts something about hardware or the codebase, ask for the file:line before accepting it.
- When it wants to add a retry, a fallback, or a second config path, say no and point at CLAUDE.md.
- End each session by asking it to summarize what changed and what it's unsure about; paste that summary into chat if it touches the design.
