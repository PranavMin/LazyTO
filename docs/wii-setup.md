# Setting up the Wiis

Each Wii needs an SD card with the LazyTO loader, the kiosk module, two small settings files and
a stock Melee image. The relay makes one zip per station with everything but the Melee image.

## What you need

- Wiis with the Homebrew Channel. Any Wii that runs Slippi Nintendont is ready.
- One SD card per Wii, formatted FAT32.
- A stock NTSC 1.02 Melee image (`GALE01`).
- Your relay, set up ([pi-setup.md](pi-setup.md)).

## 1. The SD card

On the relay's status page, open **SD cards** and enter your admin password. For each Wii:

1. Download its station's zip. The station number is the one on its label at the venue.
2. Unzip everything onto the root of its SD card.
3. Copy your Melee image onto the card as `games/GALE01/game.iso`.

That is the whole card:

| Path on the card | What |
|---|---|
| `apps/LazyTO/` | the LazyTO loader (`boot.dol`, `meta.xml`, `icon.png`) |
| `tournament.bin` | the kiosk module, the same file on every card |
| `tournament.cfg` | this Wii's station number and the relay's Wii secret, below |
| `slippi_nincfg.bin` | the loader's settings: Network and Auto Boot on, UCF on, the game at `games/GALE01/game.iso` |
| `games/GALE01/game.iso` | your Melee 1.02 image |

The loader appears in the Homebrew Channel as **LazyTO**. Your usual Slippi Nintendont can stay
installed beside it, but both use `slippi_nincfg.bin`: the zip's replaces the one on the card.
The zips carry the Wii files of the relay's version; the set list's top right shows the module
and loader versions a Wii runs.

`tournament.cfg` is a plain text file with one `key=value` per line and no spaces:

```
station=3
stream=0
secret=<the relay's Wii secret>
```

| Key | Value |
|---|---|
| `station` | the number on this Wii's station label |
| `stream` | `1` on the stream station, `0` on every other. The relay decides the stream by station number, so this value is informational, but the line must be there. |
| `secret` | the relay's Wii secret, as on its settings page |

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

The zip's `slippi_nincfg.bin` turns on what LazyTO needs, so there is nothing to set. For
reference, hold B while the loader starts to reach its menu:

| Setting | Value |
|---|---|
| Network | **On**. Without it the kiosk says `NETWORK IS OFF IN THE LOADER`. |
| Auto Boot | On, to start Melee straight away. |
| Melee Music, Melee Audio | your choice. Unless set to On and Stereo, the kiosk turns music off and uses mono. |
| Everything else | as your venue normally runs Slippi Nintendont |

**Don't save settings from the loader's menu for now.** A bug in the loader forgets saved
settings at the next boot, Network included. If it happened, copy `slippi_nincfg.bin` from the
station's zip onto the card again.

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
| `NETWORK IS OFF IN THE LOADER` | The loader's settings lost Network, for example after a save in its menu | Copy `slippi_nincfg.bin` from the station's zip onto the card again. |
| `THIS CARD IS NOT SET UP` | `tournament.cfg` is missing, or has no `secret=` | Unzip the station's zip onto the card again. |
| `NO RELAY FOUND` | The Wii heard nothing from the relay | Is the relay running? Are the Wii and the Pi on the same network? A guest network may isolate them. |
| `RELAY SECRET MISMATCH` | The card's secret differs from the relay's, for example after a new Wii secret | Download the station's zip again and copy its `tournament.cfg` onto the card. |
| `NO LINK TO THE RELAY` with an address shown | The Wii found the relay but can't connect to it | A loader older than Nintendont `c4e972a` (2026-10-01) fails every connect to a relay that doesn't answer within the same millisecond (the Wii log says `connect() ... returned -26`); use the current loader. Otherwise a firewall between them is blocking TCP 29470. |
| `no tournament.cfg` on every action | The card isn't being read | Boot the game from the SD card. Check `station=`, `stream=` and `secret=` are all present. |
| Wii Settings connection test: error 51330 | The Wii can't join the Wi-Fi | Set the router's 2.4 GHz mode to b/g/n. |
| Loader: `Failed to load IOS58 from NAND` | The loader can't start | Use the loader from the station's zip. A loader you build yourself fails here. |
| Boots to the character select instead of the Tournament screen | An old `tournament.bin` | Copy the one from the station's zip onto the card. |

If a Wii never appears on the status page, turn on **Log** in the loader's menu, boot once, and
read `slippi_ndebug.log` on the SD card. Then copy `slippi_nincfg.bin` from the zip again.
