# Decisions

One entry per decision. Outcome first, then why. How the system works today is in [architecture.md](architecture.md). Dates are in [changelog.md](changelog.md).

## Design choices

### Relay on the LAN

**The Wii speaks a fixed-struct TCP protocol to a relay on a Pi. Only the relay speaks GraphQL/HTTPS to start.gg.**

start.gg is TLS-only, and neither Melee nor the Nintendont kernel has a TLS stack. Porting one into the kernel was the largest risk in the project, and it would have put an admin token on every SD card. A relay keeps the Wii side small and puts all start.gg state and rate limiting in one process. The cost is one more box, set up once.

### The relay owns all state

**The Wii holds only the current set and its games in RAM. Everything else lives in the relay.**

A rebooted Wii asks the relay, which offers its set first. No persistence code in the game or kernel.

### One config file per Wii

**`sd:/tournament.cfg` has `station`, `stream` and `secret`. Nothing else.**

Every card is identical apart from the station number. The relay decides which sets go on stream by station (`streamStation`), not by the card's `stream=` value, so a card and the relay can never disagree about the stream. The kernel still requires the `stream=` line.

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

**The kiosk is `tournament.bin`, a module loaded into stock Melee 1.02 at boot. It is not a rebuilt game executable.**

The earlier build appended a shifted decomp executable to a copy of the disc. Everything that assumes vanilla addresses broke on it: Slippi recording, and every venue codeset, which then had to be ported natively. A module keeps the game stock, so recording, hotswap and the venue's codes work unchanged, and an update is a 26 KB file instead of a 1.4 GB image. The native ports of UCF, neutral spawns, striking and audio defaults that the old build needed are retired. The kiosk still asserts tournament rules (4 stocks, 8:00, items off, everything unlocked) at boot, whatever the memory card says. (2026-09-24)

### Event found by name at startup

**The settings name the tournament, event and stream. The relay resolves the ids at startup.**

Ids change every week; names do not. A short URL that the TO moves weekly means nothing changes on the relay from week to week. The numbered-weekly fallback (`weeklyNamePrefix`) is a deliberate, opt-in exception to "no fallbacks" for a series whose short URL may not have moved yet. A full slug reaches unpublished tournaments.

### Set up from a browser

**The relay is set up and changed on its own web page. The TO's computer needs nothing beyond a browser and ssh for one install command.** (2026-10-02)

Before, a TO needed git, Node, the GitHub CLI, an ssh key and a hand-written `.env`, and pushed a build to the Pi only to write one settings file. The setup page asks for the token, lists the token's tournaments, events and streams, and checks the result against start.gg before saving. Two exceptions to fail-fast follow: a relay without settings serves only its setup page, and one whose event can't be found keeps its page up with the reason and retries, so the TO can recover from a phone. The first save needs a one-time setup code that the installer prints; later ones need the admin password, and every POST must come from the page itself, addressed to the relay (no DNS rebinding). Settings fields after the first five are optional with defaults, so no update ever finds the file unreadable.

### One bundle, two update channels

**Each commit builds one `lazyto.tgz`: the relay, the loader and `tournament.bin`. A Pi follows published releases by default, or every build of `main`.** (2026-10-02)

The relay and the Wii files can never come from different commits, and the loader is the pinned Nintendont commit built with the fork CI's own image, byte for byte the build proven on a Wii apart from its build time. A TO's Pi moves only when a release is published; a developer's follows `main` to test changes on the fly. Any differing VERSION installs, so switching channel or rolling back is the same step.

### SD cards from the relay

**The status page makes each station's SD card as a zip: the bundle's Wii files, the card's `tournament.cfg` and the loader's settings.** (2026-10-02)

A card then needs only unzipping and the Melee image, and always matches the relay's version and Wii secret. The loader settings file is written as version 0xD because the loader drops the 0xE files it saves itself.

## Risks and questions (R1-R16)

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

**The cache drops sets with string preview ids, and the status page warns until every pool is started.** Unstarted pools have ids that do not fit the protocol's 32-bit set id. Any mutation on a preview id starts the whole pool, so the relay never does that on its own.

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
