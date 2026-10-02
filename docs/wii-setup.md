# Setting up the Wiis

Each Wii needs an SD card with the LazyTO loader, the kiosk module, a small config file and a
stock Melee image. Every card is the same except for its config file.

## What you need

- Wiis with the Homebrew Channel. Any Wii that runs Slippi Nintendont is ready.
- One SD card per Wii, formatted FAT32.
- A stock NTSC 1.02 Melee image (`GALE01`).
- The LazyTO loader (the `apps/LazyTO` folder) and the kiosk module (`tournament.bin`). Both
  are in the `wii/` folder of `lazyto.tgz` on the newest
  [release](https://github.com/PranavMin/LazyTO/releases), or on the `main-build` prerelease
  until the first release. `npm run sync-card` fetches the loader from the newest successful CI
  build of the [Nintendont fork](https://github.com/PranavMin/Nintendont); pass the bundle's
  `tournament.bin` with `--module`. Never use a loader you built yourself: it fails on a real
  Wii.
- For `npm run sync-card`: a clone of this repo with Node 22, and the GitHub CLI
  ([`gh`](https://cli.github.com/)) installed and logged in (`gh auth login`). It uses `gh` to
  download the loader.
- Your relay's Wii secret, shown on its settings page (the **settings** link at the top of the
  status page). `npm run sync-card` reads it from `RELAY_SECRET` in `.env`.

## 1. The SD card

| Path on the card | What |
|---|---|
| `apps/LazyTO/` | the LazyTO loader (`boot.dol`, `meta.xml`, `icon.png`) |
| `tournament.bin` | the kiosk module, the same file on every card |
| `tournament.cfg` | this Wii's settings, below |
| `games/GALE01/game.iso` | your Melee 1.02 image |

The loader appears in the Homebrew Channel as **LazyTO**. Your usual Slippi Nintendont can stay
installed beside it.

From a clone of the repo, one command writes all of this except the game image and checks it:
`npm run sync-card -- --station 3` (`--stream 1` on the stream Wii; Windows, macOS or Linux; see
[development.md](development.md)). The rest of this section is what it does, for doing it by hand.

`tournament.cfg` is a plain text file with one `key=value` per line and no spaces:

```
station=3
stream=0
secret=<the relay's Wii secret>
```

| Key | Value |
|---|---|
| `station` | the number on this Wii's station label |
| `stream` | `1` on the Wii that is on stream, `0` on every other. The relay decides the stream by station number (`STREAM_STATION`), so this value is informational, but the line must be there. |
| `secret` | the relay's Wii secret, exactly as on its settings page |

There is no relay address. The Wii finds the relay by itself.

## 2. The Wii's internet connection

The loader uses the Wii's own saved connection. Set it up once in **Wii Settings, Internet**,
which needs a Wii Remote, and run the connection test.

- **Use the 2.4 GHz band, with 802.11b and g allowed.** Many routers default to "g/n" or "n"
  only, and the Wii then fails with error 51330 even with the right password. Set the 2.4 GHz
  mode to "b/g/n". Giving the 2.4 GHz band its own network name can also help.
- **Avoid guest networks.** They usually stop devices reaching each other, so the Wii can't
  reach the relay.
- The Wii and the relay must be on the same network.

## 3. Loader settings

Start **LazyTO** from the Homebrew Channel. In its settings:

| Setting | Value |
|---|---|
| Network | **On**. Without it the kiosk says `NETWORK IS OFF IN THE LOADER`. |
| Auto Boot | On, to start Melee straight away. Hold B while the loader starts to reach its menu. |
| Melee Music, Melee Audio | your choice. Unless set to On and Stereo, the kiosk turns music off and uses mono. |
| Everything else | as your venue normally runs Slippi Nintendont |

Slippi Nintendont's options, such as UCF, stage striking and stage lists, work as usual. LazyTO
adds nothing to them.

Boot the game from the SD card. The loader only reads `tournament.cfg` from the card when the
game starts from it.

## 4. Check one Wii

With the relay running, power on one Wii and start LazyTO.

1. Melee starts and opens the **Tournament** screen. It shows `LOOKING FOR THE RELAY`, then
   `LOADING SETS`, then the set list, within a few seconds. While the Wii is still joining the
   Wi-Fi it shows `JOINING THE WI-FI`, which can take 15 seconds.
2. The set list shows sets whose players are both known. The Wii also appears in the **Wii
   consoles** table on the relay's status page.
3. The set list's top right shows the module and loader versions.

How players use the kiosk is on the printable controls poster, [kiosk-poster.html](kiosk-poster.html).

## If a Wii does not work

Look at the relay's status page first, at http://relay.local:29473. Each Wii sends its own log
to the relay, so the **Wii consoles** table shows whether the module loaded, any crash, and the
last log lines. A Wii appears there once it has found the relay and has the right secret.

| The Wii shows | Meaning | Do |
|---|---|---|
| `JOINING THE WI-FI`, then `THIS WII COULD NOT JOIN THE WI-FI` after 60 s | The Wii can't connect | Power cycle. Check the Wii's connection test and the router's 2.4 GHz mode. |
| `NETWORK IS OFF IN THE LOADER` | The loader's Network setting is off | Turn it on. |
| `THIS CARD IS NOT SET UP` | `tournament.cfg` is missing, or has no `secret=` | Fix the card. |
| `NO RELAY FOUND` | The Wii heard nothing from the relay | Is the relay running? Are the Wii and the Pi on the same network? A guest network may isolate them. |
| `RELAY SECRET MISMATCH` | The card's secret differs from the relay's | Copy the Wii secret from the relay's settings page exactly. |
| `NO LINK TO THE RELAY` with an address shown | The Wii found the relay but can't connect to it | A loader older than Nintendont `c4e972a` (2026-10-01) fails every connect to a relay that doesn't answer within the same millisecond (the Wii log says `connect() ... returned -26`); use the current loader. Otherwise a firewall between them is blocking TCP 29470. |
| `no tournament.cfg` on every action | The card isn't being read | Boot the game from the SD card. Check `station=`, `stream=` and `secret=` are all present. |
| Wii Settings connection test: error 51330 | The Wii can't join the Wi-Fi | Set the router's 2.4 GHz mode to b/g/n. |
| Loader: `Failed to load IOS58 from NAND` | The loader can't start | Use the CI loader that `npm run sync-card` downloads. A loader you build yourself fails here. |
| Boots to the character select instead of the Tournament screen | An old `tournament.bin` | Copy the current one to the card. |

If a Wii never appears on the status page, turn on **Log** in the loader's settings, boot once,
and read `slippi_ndebug.log` on the SD card.
