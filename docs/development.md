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
| LazyTO (this repo) | `main` | the relay, the kiosk module (`kiosk/`), the protocol, the Pi's install and update scripts |
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
| `LAZYTO_DIR=<dir> npm start` | Runs the relay from source with its settings, audit log and setup code in `<dir>`. With no settings there it serves the setup page on port 29473. The fields are in [architecture.md](architecture.md#startup-and-event-discovery). |
| `npm run sim` | Load test: 12 simulated Wiis play sets for 10 minutes against an in-process relay and fake start.gg. Fails on any error or on 70 or more start.gg calls in a minute. For a shorter run: `npx tsx scripts/sim-wii.ts --duration=60`. |
| `npx tsx scripts/preview-status.ts` | The status page on fake data at `http://127.0.0.1:29480/` (three Wiis, a flagged station, telemetry), for checking its layout at phone width. TO password `to-pass-9876`. `--page=setup` and `--page=failed` show the setup wizard and the "Not running" page; `--wii=<dir>` (an unpacked bundle's `wii/`) makes the SD cards page serve real zips; `--network` makes it a relay on the LAN (beacon, telemetry, TCP 29470) that a development Dolphin can play against. |

**On Windows.** `python3` is often the Microsoft Store alias; the npm scripts call `python`.
npm drops some flags after `--` (`--duration`), so run `npx tsx scripts/<name>.ts` directly when
one is ignored. A relay started through `npx` leaves its `tsx` child running when the wrapper
stops; for long runs start one process, `node dist/main.js`. `tsx` takes over 3 s to start, so
poll the port rather than sleeping a fixed time.

## The protocol

`protocol.yaml` defines every message between the Wii and the relay. Never edit the generated
files by hand. After changing `protocol.yaml`:

1. Run `python tools/gen_protocol.py`. It writes `generated/wire.ts` and the C header in both
   places that build with it, `kiosk/include/relay_proto.h` and `Nintendont/kernel/relay_proto.h`.
   `npm test` fails if any of them drift.
2. Commit and push the header in the Nintendont submodule, then commit `generated/wire.ts`,
   `kiosk/include` and the new Nintendont position here.
3. Rebuild the module and the loader together. A Wii with a module and loader from different
   protocol versions shows `NO SETS LOADED YET`.

## The kiosk module

The kiosk's source is `kiosk/`. It builds against the decomp in the `melee/` submodule, which
needs its compilers fetched once (no Melee files needed): `pip install ninja`, then
`python kiosk/tools/fetch_decomp_tools.py`. Or skip building and take `lazyto_kiosk.bin` from
the `wii/` folder of the `main-build` bundle, `lazyto.tgz`. Then, from the repo root:

```
python kiosk/tools/build_module.py
```

writes `kiosk/build/lazyto_kiosk.bin`. The build runs on Windows only: the decomp's compilers are
`.exe` files. The module's sources, hooks, file format, developer flags and generated files are
described in [kiosk.md](kiosk.md). Walk through [kiosk-checklist.md](kiosk-checklist.md) for each new
build.

## The loader

The loader that runs on a Wii must come from a CI build. A locally built loader stops at
"Preparing IOS58 Kernel" on hardware. `release.yml` builds the one in the bundle from the
pinned `Nintendont/` commit with the fork CI's docker image, byte for byte the fork CI's build
apart from its build time. For a loader change before it is pinned, start the fork's own build:

```
gh workflow run build.yml -R PranavMin/Nintendont --ref LazyTO
```

The kernel itself builds locally for quick checks. See the Nintendont repo's
`docs/build-windows.md`.

## Testing on a Wii

A card for a module change: make the station's zip on a relay's SD cards page, unzip it onto the
card, then replace its `lazyto_kiosk.bin` with `kiosk/build/lazyto_kiosk.bin`. Never put a `--demo`
build on a card. A loader change needs a CI loader in `apps/LazyTO/` (above).

**Debugging on hardware.** Each Wii sends its kernel log and module status to the relay, so the
status page's **Wii consoles** table and `/log?station=N` are the first place to look. The relay
also saves each Wii's log as `wii-station-N.log` in its audit folder. If a Wii never reports,
turn on **Log** in the loader and read `slippi_ndebug.log` on the SD card. A crash line names an
address. `python kiosk/tools/resolve_crash.py <address>` turns it into a function name.

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
