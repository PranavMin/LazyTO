# Developing LazyTO

This repo holds the relay and the kiosk module's source (`kiosk/`). Two git submodules supply the
rest: `melee/`, the unmodified Melee decompilation the kiosk builds against, and `Nintendont/`,
the LazyTO loader fork. Each is pinned to the commit that goes with this repo's commit. Clone
everything at once:

```
git clone --recursive https://github.com/PranavMin/LazyTO.git
```

In an existing clone, run `git submodule update --init`. CI checks out the submodules too.

| Repo | Branch | Builds |
|---|---|---|
| LazyTO (this repo) | `main` | the relay, the kiosk module (`kiosk/`), the protocol, the deploy scripts |
| [doldecomp/melee](https://github.com/doldecomp/melee) | `master`, pinned | nothing itself; the kiosk builds against it, unmodified |
| [Nintendont](https://github.com/PranavMin/Nintendont) | `LazyTO` | the LazyTO loader |

How the parts fit together is in [architecture.md](architecture.md). Why they are built that way
is in [decisions.md](decisions.md).

## The relay

Needs Node.js 22 or newer, and Python 3 with PyYAML (`pip install pyyaml`) for the protocol
check.

| Command | What it does |
|---|---|
| `npm test` | The gate, also run by CI: checks `generated/` matches `protocol.yaml`, type-checks, and runs every test. Integration tests use the fake start.gg in `test/fake-startgg.ts`, never the real API. |
| `npm run build` | Compiles to `dist/`. The Pi runs `dist/main.js`. |
| `CONFIG=<config.json> npm start` | Runs the relay from source with a config file. The fields are in [pi-setup.md](pi-setup.md#relay-settings-reference). |
| `npm run fake -- --port=18081` | Serves the fake start.gg on its own: token `test-token`, 400 pending sets. |
| `npm run sim` | Load test: 12 simulated Wiis play sets for 10 minutes against an in-process relay and fake start.gg. Fails on any error or on 70 or more start.gg calls in a minute. For a shorter run: `npx tsx scripts/sim-wii.ts --duration=60`. |
| `npx tsx scripts/preview-status.ts` | The status page on fake data at `http://127.0.0.1:29480/` (three Wiis, a flagged station, telemetry), for checking its layout at phone width. TO password `preview-pass`. |
| `npx tsx scripts/smoke.ts <host>` | Lists sets from a running relay over the Wii protocol and fetches its status page. |
| `npx tsx scripts/probe.ts --mine` | Read-only lookups on the real start.gg API with the token in `.env`: `--mine` lists your tournaments and short URLs, `--tournament=<slug>` lists a tournament's events and streams (to pick `EVENT_NAME` and `STREAM_NAME`), `--resolve=<tournament>` shows what the relay would pick at startup, `--weekly` shows the weekly fallback's pick. |
| `npx tsx scripts/reset-bracket.ts` | Lists every set of the event `EVENT_ID` in `.env`; with `--yes` resets them all on start.gg so a test bracket can be played again. Only ever point it at a test event. |

**On Windows.** `python3` is often the Microsoft Store alias; the npm scripts call `python`.
npm drops some flags after `--` (`--duration`), so run `npx tsx scripts/<name>.ts` directly when
one is ignored. A relay started through `npx` leaves its `tsx` child running when the wrapper
stops; for long runs start one process, `node dist/main.js`. `tsx` takes over 3 s to start, so
poll the port rather than sleeping a fixed time.

**Resetting the test bracket.** On start.gg, `markSetInProgress` on any `preview_*` set id
starts the whole pool: every set gets a real numeric id. This is asynchronous; query again
after a few seconds. `resetSet` on one started set leaves the pool started, so to get a pristine
started bracket, start one set and reset it. `resetSet` keeps a set's stream assignment.

**Rehearsing the built relay without start.gg.** Run `npm run build` and `npm run fake -- --port=18081`.
Write a config with `"startggEndpoint": "http://127.0.0.1:18081/gql/alpha"`, `"token": "test-token"`,
`"tournament": "tournament/lazyto-test"`, `"eventName": "Melee Singles"`,
`"streamName": "LazyTOStream"`, `"weeklyNamePrefix": ""`, a secret, and free ports. Those are the
fake's fixture values. Then run `CONFIG=<that file> node dist/main.js`, and drive it with
`npx tsx scripts/sim-wii.ts --relay=127.0.0.1:<tcpPort> --secret=<secret>`.

## The protocol

`protocol.yaml` defines every message between the Wii and the relay. Never edit the files under
`generated/` by hand. After changing `protocol.yaml`:

1. Run `python tools/gen_protocol.py`. It writes `generated/` and the header copies in both
   copies, `kiosk/include/relay_proto.h` and `Nintendont/kernel/relay_proto.h`.
   `npm test` fails if any of them drift.
2. Commit and push the header in the Nintendont submodule, then commit `generated/`,
   `kiosk/include` and the new Nintendont position here.
3. Rebuild the module and the loader together. A Wii with a module and loader from different
   protocol versions shows `NO SETS LOADED YET`.

## The kiosk module

The kiosk's source is `kiosk/`. It builds against the decomp in the `melee/` submodule, which
needs its compilers fetched once (no Melee files needed): `pip install ninja`, then
`python kiosk/tools/fetch_decomp_tools.py`. Or skip building and download `tournament.bin` from
the `kiosk` workflow's `tournament-bin` artifact. Then, from the repo root:

```
python kiosk/tools/build_module.py
```

writes `kiosk/build/tournament.bin`. The build runs on Windows only: the decomp's compilers are
`.exe` files. The module's sources, hooks, file format, developer flags and generated files are
described in [kiosk.md](kiosk.md). Walk through [kiosk-checklist.md](kiosk-checklist.md) for each new
build.

## The loader

The loader that runs on a Wii must come from the Nintendont repo's GitHub Actions build. A
locally built loader stops at "Preparing IOS58 Kernel" on hardware. Start a build with:

```
gh workflow run build.yml -R PranavMin/Nintendont --ref LazyTO
```

The kernel itself builds locally for quick checks. See the Nintendont repo's
`docs/build-windows.md`.

## Testing on a Wii

`npm run sync-card` prepares an SD card from your builds in one command (`scripts/sync-card.ts`;
Windows, macOS and Linux). It finds the card (the one removable FAT32 volume, or `--drive F` /
`--drive /Volumes/NO NAME`), downloads the newest successful CI loader, copies
`kiosk/build/tournament.bin` (`--module` for another file), writes `tournament.cfg` with the
secret from `.env`, turns on the loader's Network, Auto Boot and Log settings, checks every file
by hash, and ejects the card. It refuses a module built with a debug switch on. It needs the
GitHub CLI, logged in.

```bash
npm run sync-card -- --station 1 --stream 0
```

Use `--relay-config <config.json>` to take the secret from a development relay's config instead.

`npm run wiiload -- --wii <ip>` boots the newest CI loader over Wi-Fi while the Wii sits in the
Homebrew Channel. Its address is shown bottom left there. It speaks the Homebrew Channel's
protocol itself, so no devkitPro `wiiload` tool is needed. The card still supplies the module,
the config and the game.

The `deploy/*.ps1` files are shims that forward the old `-Flag` spelling to these scripts and
will go away; `npm test` covers the scripts (`test/deploy-scripts.test.ts`).

**Debugging on hardware.** Each Wii sends its kernel log and module status to the relay, so the
status page's **Wii consoles** table and `/log?station=N` are the first place to look. The relay
also saves each Wii's log as `wii-station-N.log` in its audit folder. If a Wii never reports,
turn on **Log** in the loader and read `slippi_ndebug.log` on the SD card. A crash line names an
address. `python kiosk/tools/resolve_crash.py <address>` turns it into a function name.

**Testing in Dolphin.** The module can also run without a Wii, in a Slippi Dolphin with a relay
forwarder: [PranavMin/Ishiiruka](https://github.com/PranavMin/Ishiiruka), branch `LazyTO`. It
is a development setup, not something a venue installs. Its README covers the build and the
Dolphin settings; the developer flags in [kiosk.md](kiosk.md) exist for runs there with no
controller. Dolphin rewrites `Dolphin.ini` from memory when it exits, so edit the file only
while Dolphin is closed. Dolphin finds a relay by its beacon like a Wii does: with a Pi relay
up on the same network, it may pair with the Pi instead of your development relay.

## Working in a submodule

`melee/` is never edited. `Nintendont/` is the loader fork. A submodule checkout starts on a
fixed commit, not a branch, so before changing the loader:

```
cd Nintendont
git switch LazyTO
git pull
```

Commit and push inside the submodule first, then commit its new position in this repo with
`git add Nintendont`.

## Upstream changes

Moving the decomp forward and merging upstream Nintendont are described in
[upstream-sync.md](upstream-sync.md).
