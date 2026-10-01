# LazyTO

LazyTO lets players at a Melee tournament run their own start.gg sets from the Wii. They pick
their set from a list on the console, play, and each game's result reaches start.gg as the game
ends. The TO steps in only when something goes wrong.

**Status: beta in preparation.** It runs end to end in development and has booted on a real Wii.
It has not run a full night at a venue yet.

## How it works

- **The Wiis** run a stock Melee 1.02 image through the LazyTO loader, a build of Slippi
  Nintendont. At boot the loader copies a small kiosk module, `tournament.bin`, from the SD card
  into the game. The module adds the set list, the score banner on the character select screen,
  and automatic scoring. Your venue's usual Slippi settings and codes (UCF, stage striking and so
  on) keep working.
- **The relay** runs on a Raspberry Pi on the venue network. The Wiis find it on their own, send
  it each button press, and it makes the matching start.gg call: start the set, put it on stream,
  report each game, end the set.
- **start.gg stays the source of truth.** Anything the relay can't do, the TO does on start.gg
  as usual. A stream overlay that reads start.gg keeps working unchanged.

## What you need

- A Raspberry Pi (a Pi 5, or any Pi that runs 64-bit or 32-bit Raspberry Pi OS) and a PC with Node 22 (Windows, macOS or Linux)
  to set it up from.
- Wiis with the Homebrew Channel, one SD card each, and a stock NTSC 1.02 Melee image.
- A Wi-Fi network the Wiis and the Pi share, where devices can reach each other. Guest networks
  often block that.
- A start.gg account that is an admin of your tournament, and a start.gg API token for it.

## Guides

| Guide | For |
|---|---|
| [docs/pi-setup.md](docs/pi-setup.md) | Setting up the relay on a Pi, and the relay's settings |
| [docs/wii-setup.md](docs/wii-setup.md) | Preparing SD cards and Wiis |
| [docs/night-of.md](docs/night-of.md) | Running a tournament: the checklist, the status page, and troubleshooting |
| [docs/development.md](docs/development.md) | Building and testing LazyTO from source |
| [docs/architecture.md](docs/architecture.md) | How it works inside |
| [docs/decisions.md](docs/decisions.md) | Why it works that way |

## Repositories

The kiosk's source is in [kiosk/](kiosk/). It builds against the unmodified Melee decompilation, a git submodule at `melee/`. The loader is the Nintendont fork, a submodule at `Nintendont/`. Clone with `git clone --recursive`.

| Repo | What it builds |
|---|---|
| **LazyTO** (this repo) | The relay, the kiosk module `tournament.bin`, the Wii-to-relay protocol ([protocol.yaml](protocol.yaml)), the deploy scripts and the docs |
| [doldecomp/melee](https://github.com/doldecomp/melee) | The Melee decompilation, unmodified. The kiosk builds against its headers, compilers and symbol map. |
| [Nintendont](https://github.com/PranavMin/Nintendont) | The LazyTO loader for the Wii |

## Licence

Copyright (C) 2026 Kegstand Jesus (PranavMin). LazyTO is free software under the GNU General Public License, version 2: see [LICENSE](LICENSE). The LazyTO loader is a fork of Slippi Nintendont and stays under its GPLv2.
