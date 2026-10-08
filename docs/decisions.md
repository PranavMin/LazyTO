# Decisions

One entry per decision. Outcome first, then why. How the system works today is in [architecture.md](architecture.md). Dates are in [changelog.md](changelog.md).

## Design choices

### Relay on the LAN

**The Wii speaks a fixed-struct TCP protocol to a relay on a Pi. Only the relay speaks GraphQL/HTTPS to start.gg.**

start.gg is TLS-only, and neither Melee nor the Nintendont kernel has a TLS stack. Porting one into the kernel was the largest risk in the project, and it would have put an admin token on every SD card. A relay keeps the Wii side small and puts all start.gg state and rate limiting in one process. The cost is one more box, set up once.

### The relay owns all state

**The Wii holds only the current set and its games in RAM. Everything else lives in the relay.**

A rebooted Wii asks the relay, which offers its set first. No persistence code in the game or kernel.

### Every SD card is the same

**The station number and the secret live on the beamer: the number set with its button, the secret in its `CONFIG/config.txt`. The card has no station file.** (2026-10-07, redesign D3)

One zip for every Wii, and the station is the dongle at the table. The relay decides which sets go on stream by station (`streamStation`), so a card and the relay can never disagree about the stream. Until 2026-10-07 each card had `lazyto_station.txt` with `station=` and `secret=` (before 2026-10-02, `tournament.cfg` with a `stream=` line).

### Fixed-size big-endian structs

**Every message is a packed big-endian struct with a version byte. No JSON, no varints.**

The PowerPC is big-endian, so the Wii does no byte swapping and no parsing. Adding a field is a version bump, which is fine because every part ships together from `protocol.yaml`.

### Score is a list of games

**REPORT_SCORE and END_SET carry the full game list, not two integers.**

start.gg's `reportBracketSet` takes per-game data. A full list makes every report an idempotent overwrite, and undo is "drop the last game".

### No retries on the Wii

**The kernel makes one TCP attempt with a 3 s budget. A failure goes to the screen; the player presses A to retry.**

Retry loops in kernel code produce frozen consoles with no explanation. The only retry in LazyTO is the relay's, on a start.gg 5xx, at most twice.

### Stock Melee plus a module

**The kiosk is `lazyto_kiosk.bin`, a module loaded into stock Melee 1.02 at boot. It is not a rebuilt game executable.**

The earlier build appended a shifted decomp executable to a copy of the disc. Everything that assumes vanilla addresses broke on it: Slippi recording, and every venue codeset, which then had to be ported natively. A module keeps the game stock, so recording, hotswap and the venue's codes work unchanged, and an update is a 26 KB file instead of a 1.4 GB image. The native ports of UCF, neutral spawns, striking and audio defaults that the old build needed are retired. The kiosk still asserts tournament rules (4 stocks, 8:00, items off, everything unlocked) at boot, whatever the memory card says. (2026-09-24)

### Event found by name at startup

**The settings name the tournament, event and stream. The relay resolves the ids at startup.**

Ids change every week; names do not. A short URL that the TO moves weekly means nothing changes on the relay from week to week. The numbered-weekly fallback (`weeklyNamePrefix`) is a deliberate, opt-in exception to "no fallbacks" for a series whose short URL may not have moved yet. A full slug reaches unpublished tournaments.

### Set up from a browser

**The relay is set up and changed on its own web page. The TO's computer needs nothing beyond a browser and ssh for one install command.** (2026-10-02)

Before, a TO needed git, Node, the GitHub CLI, an ssh key and a hand-written `.env`, and pushed a build to the Pi only to write one settings file. The setup page asks for the token, lists the token's tournaments, events and streams, and checks the result against start.gg before saving. Two exceptions to fail-fast follow: a relay without settings serves only its setup page, and one whose event can't be found keeps its page up with the reason and retries, so the TO can recover from a phone. The first save needs a one-time setup code that the installer prints; later ones need the admin password, and every POST must come from the page itself, addressed to the relay (no DNS rebinding). Settings fields after the first five are optional with defaults, so no update ever finds the file unreadable.

### One bundle, two update channels

**Each commit builds one `lazyto.tgz`: the relay, the loader and `lazyto_kiosk.bin`. A Pi follows published releases by default, or every build of `main`.** (2026-10-02)

The relay and the Wii files can never come from different commits, and the loader is the pinned Nintendont commit built with the fork CI's own image, byte for byte the build proven on a Wii apart from its build time. A TO's Pi moves only when a release is published; a developer's follows `main` to test changes on the fly. Any differing VERSION installs, so switching channel or rolling back is the same step.

### SD cards from the relay

**The status page makes the SD card as a zip: the bundle's Wii files and the loader's settings, with Slippi replays and Auto Boot on, Network off and the game on SD.** (2026-10-02; one zip for every Wii since 2026-10-07)

A card then needs only unzipping and the Melee image, and always matches the relay's version. Replays on with the game on SD is what starts USB, and with it the beamer, in the kernel. The loader keeps its settings in a file of its own, `lazyto_nincfg.bin`, so a venue's Slippi Nintendont on the same card (`slippi_nincfg.bin`) never reads or overwrites them, whatever version either writes.

### The protocol is MIT

**`protocol.yaml` and the files generated from it (`generated/wire.ts`, both `relay_proto.h`) are MIT. The rest of LazyTO stays GPL-2.0-only.** (2026-10-07, redesign D18)

The LazyTO beamer firmware is a fork of an MIT project built on Apache-2.0 ESP-IDF, and it compiles the generated header. A GPL header would have pulled the firmware under the GPL. `tools/gen_protocol.py` writes the SPDX line and the copyright into every generated file.

### What a beamer parses is frozen

**The beacon, `relay_auth`, `relay_hdr`, `relay_resp` and the beamer sync never change with `PROTO_VERSION`. A beamer checks the beacon by length and magic, never its version, and the sync carries its own version (`BEAMER_SYNC_VERSION`).** (2026-10-07, protocol v2)

Beamers have no over-the-air update. With a version check, every protocol bump would mean reflashing every dongle by hand. The mailbox between the Wii and the beamer is versioned instead (`BEAMER_MB_VERSION`) and changes only with a firmware update; the kernel names old and new firmware. `test/protocol-frozen.test.ts` pins the frozen bytes.

### Replays are named by the game

**Each reported game carries its replay's id, the match's Slippi `gameStartTime`, which names the file on the beamer. `CMD_GAME_START` and the content matcher are gone.** (2026-10-07, protocol v2)

The matcher bound each replay to the earliest game start with the same ports, characters, costumes and stage, and it needed a fire-and-forget request on every match's first frame. With only set games recorded, game 1's replay would have bound to an unrecorded handwarmer's game start. The kiosk learns the id from the record gate, a 64-byte slot it shares with the kernel ([protocol-v2.md](protocol-v2.md)). The content check stays, as a check that flags a mismatch.

### Replays are collected by the beamer's sync and kept on the laptop

**Each beamer syncs with the relay, which downloads every file it has and answers each one held, wanted or noted in a reply signed with the secret. Raw copies stay in the archive folder (`Documents/LazyTO` by default) until the TO deletes them; strays and incomplete recordings go to `unmatched/`.** (2026-10-07, redesign D15, D16)

A beamer erases only what the laptop holds, and the laptop can say "held" only while it has the file. A file nobody collects can never be erased, and a stray may be the only copy of a game. The signature keeps anyone else on the Wi-Fi from making a beamer erase replays nobody kept; a new archive folder has a new id, so the beamers drop their acks and collect again.

### A set with a missing replay gets no zip

**A finished set is zipped for Lucky Stats only when every game has a complete replay. Otherwise the status page lists it, and a replay that arrives later, even at a later event, zips it then.** (2026-10-07, redesign D12)

Lucky Stats probably rejects a set whose replays do not cover its games (`game_count_mismatch`).

### Two beamers on one number: the newcomer is refused

**When a second beamer uses a station number another beamer used in the last 15 s, its Wii gets `ST_DUP_STATION` and its telemetry is dropped. The beamer already holding the station keeps playing; the status page names both.** (2026-10-07, redesign D17)

A stray click renumbers a beamer. Refusing both would stop a set in progress; refusing only the newcomer keeps it going until the TO renumbers one.

### One LazyTO per network

**A relay that hears another relay's beacon does not start its event.** (2026-10-07)

A beamer follows the last beacon it heard, so two relays on one Wi-Fi would split the stations and both report to start.gg.

## Risks and questions (R1-R17)

### R1: assignStream

**Works on an in-progress set with no stream-queue precondition.** Probed against the real API. Re-assigning an already-assigned set is untested.

### R2: reportBracketSet without a winner

**Accepts game data alone; the set stays in progress, and a second report fully overwrites the first.** That is exactly what score updates need.

### R3: blocking in the kernel's EXI handler

**Not safe. The kernel uses a dedicated relay thread and the EXI handler never blocks.** EXI writes are serviced by the kernel's single main loop while the game waits, so any block freezes the console.

### R4: memory budget

**No issue.** The arena is about 18 MiB. The module's statics are small; the 4 KB EXI buffer needs 32-byte alignment.

### R5: players racing requests

**One request in flight per station; the relay applies last write wins.** Full overwrite makes this safe.

### R6: the TO reports a set by hand while a station has it

**The station's next report gets a 4xx and "ask TO". The station clears on its next list.**

### R7: several events in one tournament

**Out of scope: one event per relay.** A second event would need a second relay instance.

### R8: preview set ids

**The relay starts a pool on start.gg as soon as one of its preview sets has both entrants.** Unstarted pools have string ids that do not fit the protocol's 32-bit set id, so those sets are never listed. Any mutation on a preview id starts the whole pool. The first ruling (2026-09-19) left starting to the TO, but a weekly's top 8 phase is never started before doors, so its ready sets never reached the kiosk. Starting it locks that pool's seeding, which is what a web report in it does too. One start per pool per run; a refusal is a status page warning, never a retry.

### R9: kernel connect() has no timeout

**Open.** An unreachable relay can hold the relay thread inside `connect()` past 3 s. The game is unaffected (it sees BUSY). If it hurts on hardware: a non-blocking socket plus `poll` with the same deadline.

### R10: station number in a development setup

**A development emulator reports station 0.** Station 0 just must not be a real station number. One fewer config knob.

### R13: per-game characters

**Auto-scored games carry each player's character, stage, stocks and costume from the match standings. Hand-scored games carry the winner only.**

Characters were first read from CSS port order, which need not match entrant order, so they went to the wrong player. The match standings plus a port-to-entrant mapping (the L + R port claim; seeded nametags were the other source until 2026-09-30, when writing them was found to crash the CSS Name Entry screen and was removed) make them correct. Stocks and costume go to start.gg as `(costume + 1) * 100 + stocks` in the per-game score fields, because start.gg has no colour field.

### R14: kiosk flow

**The Wii boots straight into the set list. END_SET and B on the CSS both return to it. Z on the list enters friendlies.**

The station should behave as a tournament machine, not Melee with an extra menu.

### R15: finding the relay

**The relay broadcasts a UDP beacon. Stations take its source address as the relay. A station that hears nothing sends a beacon request and gets a unicast answer.**

The Pi is usually on Wi-Fi with no guaranteed address. Alternatives were a DHCP reservation, a fixed extra address, or bringing our own network. Discovery won because it removes the only per-venue value from every card and works on any network where a Wii can reach the Pi. The request path exists because some access points do not deliver broadcasts to power-saving clients.

### R16: anyone on the Wi-Fi can reach the relay

**A shared secret, the same on every card, sent by the host before every request and telemetry datagram.**

Refusals are logged and counted on the status page. It stops passers-by, not someone capturing Wi-Fi traffic. The upgrade path is an HMAC over each request with a relay-issued nonce. Reading the status page needs nothing; its actions, the settings and the SD-card zips need the admin password. A new secret is one tick on the settings page, after which every card needs its zip again.

### R17: who won a time-out

**The game decides each game, and the kiosk reports that decision. Cards run Slippi's Gameplay: Both (LGL and anti-wobbling).** (2026-10-07)

The ruleset has the ledge-grab limit: on a time-out, more stocks wins, then lower percent, and a player with more than 45 ledge grabs at 8:00 loses. Slippi's Gameplay: LGL (UnclePunch's code) applies the limit inside the game, before vanilla builds the result. If the player ahead on stocks, then percent, is over the limit and the other is not, the other wins. If both are over and one is ahead, nobody wins, and the game is scored by hand. "Both" is the same LGL code followed by the anti-wobbling code, which touches no result. Until now the cards turned it off and the kiosk recomputed stocks then percent itself, so an LGL loss was reported as a win, and a double KO could be scored by percent while the game played Sudden Death. Reading the game's own `winners[]` keeps the results screen, the replay's placements and start.gg in agreement, without re-implementing a codeset. It is fixed in the cards rather than a setting, so there is one path: a card with Gameplay off still runs, and says `LGL OFF - SCORE BY HAND` when it matters.

A game LGL decides is sent without stocks, so start.gg shows no per-game score for it rather than the loser with more stock icons than the winner. A tie (an exact stock and percent tie, or a double KO on the last stocks) is played off in LGL's tiebreak game (1 stock, 0%, 3:00). The kiosk scores that game in place of the tied one, through a second scene hook on the Sudden Death exit. This replaces the plan to turn every tie into a no-contest (the redesign's D13): the tiebreak is the ruleset's own, and the results screen then names the same winner.
