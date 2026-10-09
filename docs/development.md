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
| LazyTO (this repo) | `main` | the relay, the desktop app (`desktop/`), the kiosk module (`kiosk/`), the protocol, the Pi's install and update scripts |
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
| `LAZYTO_DIR=<dir> npm start` | Runs the relay from source with its settings, audit log and setup code in `<dir>`. With no settings there it serves the setup page on port 29473. The fields are in [architecture.md](architecture.md#startup-and-event-discovery). Without `LAZYTO_DIR` the folder is `/var/lib/lazyto` on Linux and the desktop app's own folder on Windows and macOS (below). |
| `npm run sim` | Load test: 12 simulated Wiis play sets for 10 minutes against an in-process relay and fake start.gg. Fails on any error or on 70 or more start.gg calls in a minute. For a shorter run: `npx tsx scripts/sim-wii.ts --duration=60`. |
| `node tools/gen_sjis.mjs <iconv-lite folder>` | Regenerates `generated/sjis.ts`, the set archive's Shift-JIS tables, from iconv-lite 0.6.3 (install it outside the repo: `npm install --no-save --prefix <tmp> iconv-lite@0.6.3`). Never edit the file by hand. |
| `npx tsx scripts/preview-status.ts` | The status page on fake data at `http://127.0.0.1:29480/` (three Wiis, a flagged station, telemetry), for checking its layout at phone width. TO password `to-pass-9876`. `--page=setup` and `--page=failed` show the setup wizard and the "Not running" page; `--wii=<dir>` (an unpacked bundle's `wii/`) makes the SD cards page serve real zips; `--network` makes it a relay on the LAN (beacon, telemetry, TCP 29470) that a development Dolphin can play against; `--laptop` adds what the desktop app shows (a firewall note with its button, a newer release, no update channel in the settings). |

`test/rr-conformance/` holds Replay Reporter for Slippi's own output for a set of fixtures, made by
its code (`BUNDLE.md` there says how); `test/rr-conformance.test.ts` holds the set archive to it.
It is generated: never edit it by hand, and keep its bytes (`.gitattributes`, `.prettierignore`).

**On Windows.** `python3` is often the Microsoft Store alias; the npm scripts call `python`.
npm drops some flags after `--` (`--duration`), so run `npx tsx scripts/<name>.ts` directly when
one is ignored. A relay started through `npx` leaves its `tsx` child running when the wrapper
stops; for long runs start one process, `node dist/main.js`. `tsx` takes over 3 s to start, so
poll the port rather than sleeping a fixed time.

## The desktop app

`desktop/` is the LazyTO app for a TO's laptop ([laptop-setup.md](laptop-setup.md)): a thin
Electron shell that runs the relay core from `src/` in its main process, plus the Beamers window
(flashing with esptool-js, a beamer's `config.txt`). It has its own `package.json` and
dependencies (Electron, electron-builder, esptool-js); `src/` still has none at runtime. Needs
Node.js 24, the version Electron 44 embeds.

```
cd desktop
npm install      # also downloads Electron (postinstall: install-electron)
npm start        # compiles to desktop/dist/ and opens the app
```

| Command (in `desktop/`) | What it does |
|---|---|
| `npm start` | Builds and runs the app. Its settings are in Electron's userData for LazyTO (`%APPDATA%\LazyTO`, `~/Library/Application Support/LazyTO`), the same folder `npm start` at the root uses on those systems. `npx electron . --user-data-dir=<dir>` runs it on another folder. |
| `npm run build` | `tsc` twice: the main process with the relay core (`tsconfig.json`), and the Beamers page (`beamers/tsconfig.json`, DOM only). |
| `npm run smoke` | Starts the app on a fresh userData, checks that `GET /` on 29473 is the setup page, and quits. `npm run smoke -- <path to LazyTO.exe>` checks a packaged app. |
| `npx electron-builder --win --dir` | Packages into `desktop/release/win-unpacked/` without an installer; `npm run package` makes the installer (or the dmg, the AppImage) as CI does. |

- Only one LazyTO runs at a time, and port 29473 must be free: stop a relay started with `npm start`
  at the root first.
- `resources/wii/` and `resources/firmware/` are filled by CI. Copy a `main-build` bundle's `wii/`
  into `resources/wii/` for real SD-card zips, and put a `beamer.bin` with its `beamer.bin.sha256`
  and a `VERSION` into `resources/firmware/` to try the flasher. electron-builder leaves the
  folders' READMEs out.
- The pure parts of the shell (the flash layout, `config.txt`, the firewall verdict, the crash
  backoff) are tested by `npm test` at the root (`test/desktop.test.ts`).
- On macOS, packaging needs `pip install macholib` for the afterPack hook
  (`scripts/mach-o-uuid.cjs`), and the result is only signed ad hoc. Local Network permission is
  never asked of an app run from a terminal, so test it with the packaged app.
- The version comes from git: `npm run version-from-git` stamps `package.json` from the nearest
  `v*` tag (CI runs it before packaging; don't commit the result).
- The first launch of a new `electron.exe` or `LazyTO.exe` path on Windows brings up the firewall
  prompt, as it would for a TO.

## The protocol

`protocol.yaml` defines every message between the Wii and the relay. Never edit the generated
files by hand. After changing `protocol.yaml`:

1. Run `python tools/gen_protocol.py`. It writes `generated/wire.ts` and the C header in the
   three places that build with it, `kiosk/include/relay_proto.h`,
   `Nintendont/kernel/relay_proto.h` and
   `slippi-beamer/components/beamer_lazyto/include/relay_proto.h`. `npm test` fails if any of
   them drift.
2. Commit and push the header in the Nintendont and slippi-beamer submodules, then commit
   `generated/wire.ts`, `kiosk/include` and both new submodule positions here.
3. Rebuild the module, the loader and the beamer firmware together. A Wii with a module and
   loader from different protocol versions shows `NO SETS LOADED YET`.

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

**Debugging on hardware.** Each Wii sends its kernel log and module status to the relay through
its beamer, so the status page's **Wii consoles** table and `/log?station=N` are the first place
to look. The relay also saves each Wii's log as `wii-station-N.log` in its audit folder. A crash
line names an address. `python kiosk/tools/resolve_crash.py <address>` turns it into a function
name. If a Wii never reports, its screen says why (the beamer's own state). **Log** in the loader
writes `slippi_ndebug.log` on the SD card with the main thread's lines only: boot, the game path,
whether the module loaded. Only the kernel's main thread writes that file: a relay-thread write
during a game read froze Melee (2026-10-03), so the relay thread's `RelayEXI:` lines go to the
status page alone, and only once the beamer reaches the relay. The beamer keeps its own log on
its drive (`LOGS/debug_N.txt`, with `DEBUG=true` in its `config.txt`).

## Working in a submodule

`melee/` is never edited. `Nintendont/` is the loader fork and `slippi-beamer/` the beamer
firmware fork, both on their `LazyTO` branch. A submodule checkout starts on a fixed commit, not a
branch, so before changing the loader (or, the same way, the firmware):

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
