# Developing LazyTO

LazyTO is three repositories. Clone them side by side in one folder. The scripts here find the
others by relative path (`../melee`, `../Nintendont`).

| Repo | Branch | Builds |
|---|---|---|
| lazyto (this repo) | `main` | the relay, the protocol, the deploy scripts |
| [melee](https://github.com/PranavMin/melee) | `vanilla-module` | `tournament.bin`, the kiosk module |
| [Nintendont](https://github.com/PranavMin/Nintendont) | `vanilla-module` | the LazyTO loader |

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
| `npx tsx scripts/smoke.ts <host>` | Lists sets from a running relay over the Wii protocol and fetches its status page. |
| `npx tsx scripts/probe.ts` | The only script that calls the real start.gg API. It reads `.env` and changes one set on your test tournament (`STREAM_ID`, `TEST_SET_ID`), then resets it. `--resolve=<short URL>` and `--weekly` are read-only checks of how the relay finds your tournament. |

**Rehearsing the built relay without start.gg.** Run `npm run build` and `npm run fake -- --port=18081`.
Write a config with `"startggEndpoint": "http://127.0.0.1:18081/gql/alpha"`, `"token": "test-token"`,
`"tournament": "tournament/sf-melee-discord-test"`, `"eventName": "Melee Singles"`,
`"streamName": "SFMelee"`, `"weeklyNamePrefix": ""`, a secret, and free ports. Those are the
fake's fixture values. Then run `CONFIG=<that file> node dist/main.js`, and drive it with
`npx tsx scripts/sim-wii.ts --relay=127.0.0.1:<tcpPort> --secret=<secret>`.

## The protocol

`protocol.yaml` defines every message between the Wii and the relay. Never edit the files under
`generated/` by hand. After changing `protocol.yaml`:

1. Run `python tools/gen_protocol.py` and commit `generated/`.
2. Copy `generated/relay_proto.h` to `../melee/include/relay_proto.h` and
   `../Nintendont/kernel/relay_proto.h`.
3. Rebuild the module and the loader together. A Wii with a module and loader from different
   protocol versions shows `NO SETS LOADED YET`.

## The kiosk module

In the melee repo, once: `python configure.py --non-matching`. That sets up the compilers and
needs your own Melee 1.02 `main.dol` at `orig/GALE01/sys/main.dol`. Then:

```
python tools/build_module.py
```

writes `build/GALE01/tournament.bin`. The module's sources, hooks and file format are described
in the melee repo's `docs/tournament-module.md`. Walk through `docs/version-checklist.md` there
for each new build.

## The loader

The loader that runs on a Wii must come from the Nintendont repo's GitHub Actions build. A
locally built loader stops at "Preparing IOS58 Kernel" on hardware. Start a build with:

```
gh workflow run build.yml -R PranavMin/Nintendont --ref vanilla-module
```

The kernel itself builds locally for quick checks. See the Nintendont repo's
`docs/build-windows.md`.

## Testing on a Wii

`deploy/sync-card.ps1` prepares an SD card from your builds in one command. It finds the card,
downloads the newest successful CI loader, copies `../melee/build/GALE01/tournament.bin`, writes
`tournament.cfg` with the secret from `.env`, turns on the loader's Network, Auto Boot and Log
settings, checks every file by hash, and ejects the card. It refuses a module built with a debug
switch on. It needs the GitHub CLI, logged in.

```powershell
powershell -ExecutionPolicy Bypass -File deploy/sync-card.ps1 -Station 1 -Stream 0
```

Use `-RelayConfig <config.json>` to take the secret from a development relay's config instead.

`deploy/wiiload.ps1 -Wii <ip>` boots the newest CI loader over Wi-Fi while the Wii sits in the
Homebrew Channel. Its address is shown bottom left there. The card still supplies the module,
the config and the game.

**Debugging on hardware.** Each Wii sends its kernel log and module status to the relay, so the
status page's **Wii consoles** table and `/log?station=N` are the first place to look. The relay
also saves each Wii's log as `wii-station-N.log` in its audit folder. If a Wii never reports,
turn on **Log** in the loader and read `slippi_ndebug.log` on the SD card. A crash line names an
address. `tools/resolve_crash.py` in the melee repo turns it into a function name.

**Testing in Dolphin.** The module can also run in a patched Slippi Dolphin, kept as a separate
development setup. It is not part of LazyTO's public builds.

## Upstream changes

The melee and Nintendont forks merge their upstream projects from time to time. The procedure is
in [upstream-sync.md](upstream-sync.md).
