# Changelog

Dated progress, newest first. How things work now is in [architecture.md](architecture.md); why, in [decisions.md](decisions.md).

## [Unreleased]: 0.9.0-beta.1

The first public beta. Everything below is the work leading up to it, by date.

## 2026-10-07

- **Fixes from the redesign's review** (not yet run on hardware). `relay_auth` now carries a key derived from the secret, never the secret: a beamer sends it to whoever sent the last beacon, and the secret signs the sync replies that let a beamer erase, so one forged beacon could have erased replays nobody kept. It needs the matching beamer firmware, and the Dolphin forwarder must derive the key too. The beamer holding a station keeps it across a relay restart, so the newcomer of two beamers on one number can no longer take its set by speaking first. An archive error (a full or vanished disk, a deleted `.sets`, a rename OneDrive refuses) no longer fails a Wii request that start.gg already took; before, a failed `END_SET` left the station stuck on a finished set. Such errors now show on the status page.
- **Replays are kept the way a beamer may trust them.** Deleting the archive folder while LazyTO runs starts a new archive at once, so the beamers drop their acks instead of erasing replays the laptop no longer has. A replay downloaded again replaces a stored copy that changed in place, instead of being acked against it. A stored copy, its rename and its index line are on disk (fsynced) before the beamer can be told it is held. The loader writes a match cut off in its first 4 KB without Game End to its own file, not into the previous one, and `WAITING FOR THE BEAMER` ends after 45 s even when the USB link is stuck: the kiosk then says `NO LINK TO THE BEAMER`.
- **Only set games are recorded, and each game names its replay** (redesign, kiosk and loader; not yet run on hardware). The kiosk asks the loader to record a match only when it is a game of the current set and not a handwarmer, so friendlies, handwarmers, LGL's tiebreak game and matches from the vanilla main menu leave no replay; B from the set list to the main menu now leaves the set. Each reported game carries its replay's id, and the relay finds the file by it on the beamer. The loader reaches the relay only through the beamer: the Wii's own network, `lazyto_station.txt` and the secret on the card are gone, and the set list and the character select say what is wrong with the beamer (no number, no secret, off the Wi-Fi, no relay, `REPLAYS NOT SAVING`). The loader syncs each replay once after its first data block, so an interrupted game no longer leaks card space. Needs beamer firmware build 2.
- **The relay collects every replay from the beamers** (redesign, relay side; not yet run on hardware). Each beamer syncs with the relay, which answers each of its files held, wanted or noted in a reply signed with the secret, downloads what it wants (resumable, one at a time per beamer, after a free-disk check), and keeps the raw copies in the archive folder, `Documents/LazyTO` by default: `raw/` for set replays, `unmatched/` for strays and incomplete recordings. A beamer acks what the laptop holds and erases it at its next power-on. Replays are matched to games by their id on the beamer the game was played through; a set is zipped for Lucky Stats only when every game has its replay, and a replay that comes later zips it then. The multicast announces and the 5 s index poll are gone.
- **Two beamers on one station number:** the newcomer's Wii gets `TWO BEAMERS ARE STATION n` (`ST_DUP_STATION`) and the station already playing keeps playing; the status page names both. **One LazyTO per network:** a relay that hears another relay's beacon does not start its event.
- **Status page:** a row per beamer (number, firmware, signal, card, replays to collect and to erase, not unplugged since, last erase), "All replays collected: safe to unplug beamers", games without a replay, sets skipped for Lucky Stats, and network warnings (no beamer has reached the relay, macOS Local Network).
- **One SD card for every Wii.** The zip has no `lazyto_station.txt`; its loader settings turn Slippi replays on and Network off, with the game on SD.
- **A rebooted Wii keeps its set's games** (protocol v2, relay side). The relay's answer to resuming a set now carries the games it holds for it, with their replay ids, so the kiosk goes on at 1-1 instead of 0-0; before, its next report overwrote the earlier games on start.gg. The kiosk takes them as its game list. LGL's tiebreak game is now sent without stocks, like a game the limit decided: it carries the tied game's replay, whose stocks are tied.
- **Time-outs follow the ledge-grab limit.** Station cards now turn on Slippi's Gameplay: Both (LGL, the ledge-grab limit, and anti-wobbling), and the kiosk reports the winner the game decided instead of working it out from stocks and percent. A player over the limit (more than 45 ledge grabs at 8:00) whose opponent is not now loses the time-out on start.gg too, even with more stocks. The banner says `GAME n TO <tag> - LGL`, and that game is sent without stocks, so start.gg shows no per-game score for it. Both players over the limit with one ahead shows `BOTH OVER LGL - SCORE BY HAND`. A double KO on the last stocks is no longer scored by percent: like an exact tie, it goes to LGL's tiebreak game (1 stock, 0%, 3:00), and the kiosk scores that game instead, as one game. A tiebreak that ties again says `TIE - SCORE IT MANUALLY`. A Team battle says `TEAMS ON - SCORE BY HAND`, and a game with a CPU `AUTO-SCORE NEEDS 2 PLAYERS`. Existing cards keep Gameplay off until their `lazyto_nincfg.bin` is copied again from a new station zip; such a card says `LGL OFF - SCORE BY HAND` after a time-out tied on stocks but not on percent.
- **Protocol v2, the contract for the beamer-only redesign** (branch `redesign-v2`; [protocol-v2.md](protocol-v2.md)). The station number and the secret move to the beamer, which writes `relay_auth` itself; mailbox v2 with a 32-byte hello (Wi-Fi and storage state, beacon age); a 16-byte poll header that says why there is no beamer and why the last request failed; 16-byte game results with the entrants' ports and the replay's id, and `CMD_GAME_START` gone; the record gate the kiosk and kernel will share; `ST_DUP_STATION`; and the beamer sync (`CMD_BEAMER_SYNC`), whose signed reply will let a beamer erase replays the laptop holds. What a beamer parses is frozen, and the relay answers beacon requests whatever their version. The protocol files are MIT. The set archive now binds replays by id; the kiosk still sends id 0, so it binds none until the record gate lands, and the relay does not answer syncs yet.
- **The set list no longer freezes when scrolled.** Melee's text buffers grow 128 bytes at a time, each step a new block, and its allocator never merges freed memory: the first draw of a full list took 23 KB of the menu's 30 KB pool, and each scroll step re-made every text from scratch, so a few seconds of scrolling a long list (16 sets at a venue on 2026-10-06; reproduced in Dolphin with 20) ran the pool out and halted the game ("Memory Empty", no crash report). The list's texts now get their full-size buffers once and are emptied in place on every redraw, so the pool stays flat; the character select and in-match overlays also keep their texts.
- **Tags without sponsors.** Stations show a player's gamerTag ("Mang0"), not start.gg's display name with the sponsor prefix ("C9 | Mang0"). A team keeps its name.
- Four error-screen hints were too long for Melee's 128-byte text buffer and could crash those screens; they are shorter now (`POWER CYCLE, CHECK THE ROUTER`, `TURN ON NETWORK IN THE LOADER`, `UNZIP THE STATION ZIP AGAIN`, `IS THE RELAY ON THIS WI-FI?`).
- Developer: `build_module.py --demo scroll` scrolls the set list by itself, for a scroll soak run in Dolphin; `scripts/preview-status.ts --entrants=<file>` serves a list built from an entrant file.

## 2026-10-03

- **Music off works from boot.** With the loader's Music option off, the kiosk now silences music as soon as the set list is up; before, it only set the preference, and music kept playing until the Options page was visited.

## 2026-10-02

- **Top 8 reaches the kiosk without the TO starting it.** A set in an unstarted pool or phase used to be dropped (preview id). Now the relay starts that pool on start.gg as soon as one of its sets has both players, and the set is on every Wii within 20 s (decisions.md R8).
- **Set up from a browser.** The relay serves a setup page: paste the start.gg token, pick the tournament (follow its short URL each week, one tournament, or a pasted link), the event, the stream, the format and an admin password. The Wii secret is generated. Settings live in `/var/lib/lazyto/config.json`; later changes go through the same page. A relay whose event can't be found shows why, with Retry, and retries by itself.
- **One install command:** `curl -fsSL .../releases/latest/download/install.sh | sudo bash` installs Node, the relay and the Wii files and prints the setup page's address and code. Nothing else is needed on the TO's computer.
- **One bundle per commit, two update channels.** `lazyto.tgz` holds the relay, the loader (built from the pinned Nintendont commit) and `tournament.bin`. Pis follow published releases by default, or `main-build`; the settings page switches.
- **SD-card zips** on the status page: each station's card is one unzip plus the Melee image, with Network, Auto Boot and UCF on in the loader's settings.
- **Stream decided by station:** the card's `stream=` no longer matters to the relay; "No stream" is an option. ack takes the admin password like the other actions.
- Removed: `npm run push` writing settings from `.env`, the rehearsal against the fake start.gg, probe's research flags, the never-sent abandon command, the cached per-game data, the third protocol header copy.
- **Card files renamed:** `tournament.bin` is now `lazyto_kiosk.bin` and `tournament.cfg` is `lazyto_station.txt`, which has no `stream=` line. Cards made before this need their station zip again. The loader's menu settings are saved only when the game is started with B and A, not after Home (upstream behaviour, now in wii-setup.md).
- The loader's per-request network traces and module watch are gone, so the Wii log keeps the lines that matter.

## 2026-10-01

- **Operator scripts run everywhere**: `sync-card`, `push` and `wiiload` are Node/TypeScript (`scripts/*.ts`, `npm run sync-card|push|wiiload`), tested in `test/deploy-scripts.test.ts`; wiiload speaks the Homebrew Channel protocol itself. The `deploy/*.ps1` files are shims onto them for one release.
- **The Pi updates itself** at every relay start from the `latest` prerelease that every push to `main` publishes (`deploy/update.sh`); a build whose config schema disagrees with the installed `config.json` is refused. `npm run push -- --no-auto-update` keeps a dev build.
- Set format override: `SET_FORMAT=top8q` makes Bo3 into Bo5 from the top-8 qualifiers.

## 2026-09-30

- **Nametag seeding removed** (melee v41): writing the set's tags into persistent nametag slots 0/1 at START_SET crashed the CSS Name Entry screen when a player added a custom tag. The L + R port claim is the only who-is-who; the module no longer touches nametags.
- Renamed to LazyTO: repository `LazyTO`, service `lazyto-relay`, paths `/opt/lazyto`, `/etc/lazyto`, `/var/lib/lazyto`. The kiosk title is now a LazyTO wordmark.
- Ports moved to 29470 (Wii TCP), 29471 (beacon), 29472 (telemetry and beacon requests), 29473 (status page).
- No venue is hardcoded. `weeklyNamePrefix` replaces the built-in weekly fallback; `deploy/push.ps1` reads the event values from `.env`.
- Beacon request: a station that hears no broadcast asks on UDP 29472 and gets a unicast beacon.
- Station telemetry: kernel log lines, a status record (module load result) and crash reports go to the relay and show on the status page.
- `game_result` is 8 bytes: stocks left and costume per player. The relay sends them as `(costume + 1) * 100 + stocks` per game (R13). Costume reading fixed after the first Wii set reported every costume as 0.
- CI runs `npm test` and the build on pushes to main and on pull requests.
- **First real Wii run.** The module booted in stock Melee, the kernel heard the beacon (and the beacon-request path), sent the secret, and LIST_SETS worked. Not yet on hardware: the full set lifecycle, `.slp` recording, venue striking behaviour.
- Upstream merged into both forks (melee from doldecomp `master`, Nintendont from Slippi Nintendont v1.13.1). See [upstream-sync.md](upstream-sync.md) for the procedure.

## 2026-09-25

- **Set list redesign, phase 1 and 2.** Two-pane list grouped by round on a VS axis, cursor bar, detail pane, in-frame confirm, loading and error views, full round names (`ROUND_LEN` 24), `exi_poll_hdr` with station and relay address. Phase 2: the wordmark is the kiosk's first texture.
- **Relay discovery (R15)** built in every part. `tournament.cfg` lost its relay address. The kiosk shows LOOKING FOR THE RELAY until a beacon is heard. Verified in a development setup.
- **Shared secret (R16)** built in every part. Refusals are audited and counted. Verified in a development setup.
- **Event found by name** at startup (`src/resolve.ts`): short URL via the admin tournament list, or a full slug. Verified against the real API.
- Score moved into the CSS's own rules banner, which is also the status. Port claim (L + R) added as the tag-free way to say who is who. Handwarmers start on Battlefield.
- Pi expected on the venue Wi-Fi; Wiis on Ethernet where possible.

## 2026-09-24

- **Stock Melee plus a module.** The kiosk became `tournament.bin`, loaded by LazyTO Nintendont into stock Melee 1.02. The shifted-executable line is frozen at tag `shifted-dol-final`. Native venue-mod ports retired (R11, R12 superseded). Verified in a development setup: UCF, neutral spawns, striking, `.slp` written.
- Pi deployment kits reconciled: build on the PC, push over ssh, config generated from `.env`. Windows side verified against the fake stack.

## 2026-09-22

- **Auto-score shipped** (melee v37): game end decides the winner from the match standings. v38 adds characters and stage (R13 closed); the relay maps them with `chars.ts` and the new `stages.ts`.
- Handwarmer mode (Z + X, count-up clock). Seeded nametags for who is who shipped here too and were removed on 2026-09-30 (see above).
- Button glyphs in overlays (melee v35), drawn as coloured shapes with the font's letters.
- Status page complete (F7): per-station rows, sticky failures with ack, cache and rate footer, preview warning. Per-tournament checklist written.
- `startggEndpoint` became a required config field so a built relay can be rehearsed against the fake.
- Rehearsal: 600 s of `sim-wii` against the built relay: 12 stations, 122 sets, 0 errors, upstream peak 67 per minute against the 70 guard.
- First draft of the player poster.

## 2026-09-21

- Root cause of the emulator boot crash found (Slippi's own vanilla-addressed codes hit the shifted executable). Native UCF and neutral spawns ported. All superseded on 2026-09-24.

## 2026-09-20

- Kiosk flow (R14): boot straight to the set list, return to it after END_SET and on CSS B, friendlies via Z. Intro skipped.
- Kiosk defaults forced at boot: 4 stocks, 8:00, items off, everything unlocked.
- CSS binds moved to the C-stick (Start changes scene; the d-pad is the venue's rumble toggle).
- Characters deferred to winners-only (R13), later restored on 2026-09-22.
- Full set lifecycle against the live event: all OK, audit log matches start.gg. Found that `resetSet` keeps stream assignments; the fake now does the same.
- Test event reset to one flat bracket.

## 2026-09-19

- Protocol and generator in place. Relay built (tcp, cache, startgg, state, audit, status, chars, config): 91 tests, `sim-wii` peak 66 of 70 per minute, 0 errors.
- start.gg probes: R1 and R2 resolved; all 26 character mappings verified. Preview set ids found (R8) and dropped by the cache.
- Nintendont investigation: blocking in the EXI handler is unsafe (R3); relay thread design.
- Melee investigation: the decomp has no Slippi code; a new EXI driver was written. Memory budget fine (R4).
- `MAX_SETS` set by the poll buffer framing (now 56 rows of 72 bytes).
