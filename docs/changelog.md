# Changelog

Dated progress, newest first. How things work now is in [architecture.md](architecture.md); why, in [decisions.md](decisions.md).

## [Unreleased]: 0.9.0-beta.1

The first public beta. Everything below is the work leading up to it, by date.

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
