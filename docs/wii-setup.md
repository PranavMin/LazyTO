# Setting up the Wiis

Each Wii needs an SD card with the LazyTO loader, the kiosk module, the loader's settings and a
stock Melee image, and a LazyTO beamer in its USB port. Every card is the same: the relay makes one
zip with everything but the Melee image. The station number and the Wii secret live on the beamer.

## What you need

- Wiis with the Homebrew Channel. Any Wii that runs Slippi Nintendont is ready.
- One SD card per Wii, formatted FAT32.
- One LazyTO beamer per Wii, with the venue's Wi-Fi and the relay's Wii secret in its
  `CONFIG/config.txt` (the LazyTO app writes it) and its station number set with its button.
- A stock NTSC 1.02 Melee image (`GALE01`).
- Your relay, set up ([pi-setup.md](pi-setup.md)).

## 1. The SD card

On the relay's status page, open **SD cards** and enter your admin password. Download the zip
once; then for each Wii:

1. Unzip everything onto the root of its SD card.
2. Copy your Melee image onto the card as `games/GALE01/game.iso`.
3. Plug the station's beamer into the Wii's USB port. It must be the only USB drive on that Wii.

That is the whole card:

| Path on the card | What |
|---|---|
| `apps/LazyTO/` | the LazyTO loader (`boot.dol`, `meta.xml`, `icon.png`) |
| `lazyto_kiosk.bin` | the kiosk module |
| `lazyto_nincfg.bin` | the loader's settings: Slippi replays and Auto Boot on, Network off, UCF on, Gameplay Both (LGL and anti-wobbling), the game at `games/GALE01/game.iso` on the SD card |
| `games/GALE01/game.iso` | your Melee 1.02 image |

The loader appears in the Homebrew Channel as **LazyTO**. Your usual Slippi Nintendont can stay
installed beside it. Each keeps its own settings: LazyTO's in `lazyto_nincfg.bin`, Slippi
Nintendont's in `slippi_nincfg.bin`.
The zip carries the Wii files of the relay's version; the set list's top right shows the module
and loader versions a Wii runs.

There is no station file, no secret and no relay address on the card. The station number is the
one on the beamer's screen, and the beamer finds the relay by itself.

## 2. The network

LazyTO never uses the Wii's own network: the beamer carries the Wii's link to the relay over the
venue Wi-Fi. The Wii needs no internet connection.

- **Avoid guest networks.** They usually stop devices reaching each other, so a beamer can't
  reach the relay.
- The beamers and the relay must be on the same network.

## 3. Loader settings

The zip's `lazyto_nincfg.bin` turns on what LazyTO needs, so there is nothing to set. To change
something, hold B while the loader starts to reach its menu:

| Setting | Value |
|---|---|
| Slippi Replays | **On**, with the game on the SD card. The beamer records the replays and is the Wii's only link to the relay; with replays off the Wii never talks to its beamer. |
| Network | Off. It is only Slippi's console mirroring; LazyTO does not use it. |
| Auto Boot | On, to start Melee straight away. |
| Melee Music, Melee Audio | your choice. Unless set to On and Stereo, the kiosk turns music off and uses mono. |
| Gameplay | **Both**: LGL, the ledge-grab limit, and anti-wobbling. On a time-out the game takes the player ahead on stocks, then on lower percent, unless that player is over the limit (more than 45 ledge grabs at 8:00) and the other is not; then the other player wins. An exact tie, or a double KO on the last stocks, goes to a 1-stock, 0%, 3:00 tiebreak game. The kiosk reports what the game decided, including the tiebreak. With Off or Wobbling there is no limit: a time-out tied on stocks but not on percent goes to vanilla Sudden Death and the kiosk says `LGL OFF - SCORE BY HAND`. |
| Everything else | as your venue normally runs Slippi Nintendont |

Slippi Nintendont's options, such as UCF, stage striking and stage lists, work as usual. LazyTO
turns on Gameplay: Both and adds no code of its own to them. Cards made before 2026-10-07 have
Gameplay off: copy `lazyto_nincfg.bin` from a new zip onto the card, or set Gameplay in the
loader's menu.

Changes are saved only when you start the game from the menu. From the settings, press B to
return to the game list, then A on the game. Home ("Go Back") returns to the SD/USB screen and
drops unsaved changes: they apply to that one boot and are gone after a restart.

Boot the game from the SD card. With the game on USB, the beamer is not used.

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
| `TURN ON REPLAYS IN THE LOADER` | The loader's Slippi Replays setting is off, or the game is not on the SD card | Turn replays on in the loader's menu (hold B as it starts), or copy `lazyto_nincfg.bin` from the zip onto the card again. |
| `NO RELAY FOUND` | The Wii heard nothing from the relay | Is the relay running? Are the Wii and the Pi on the same network? A guest network may isolate them. |
| `RELAY SECRET MISMATCH` | The beamer's secret differs from the relay's, for example after a new Wii secret | Write the beamer's `CONFIG/config.txt` again from the LazyTO app. |
| `NO LINK TO THE RELAY` with an address shown | The Wii found the relay but can't connect to it | A loader older than Nintendont `c4e972a` (2026-10-01) fails every connect to a relay that doesn't answer within the same millisecond (the Wii log says `connect() ... returned -26`); use the current loader. Otherwise a firewall between them is blocking TCP 29470. |
| `LGL OFF - SCORE BY HAND` after a time-out | That card's Gameplay setting is Off or Wobbling, so the game went to Sudden Death instead of deciding by percent | Score that game by hand. Then copy `lazyto_nincfg.bin` from the zip onto the card, or set Gameplay to Both in the loader's menu (hold B as it starts). |
| Wii Settings connection test: error 51330 | The Wii can't join the Wi-Fi | Set the router's 2.4 GHz mode to b/g/n. |
| Loader: `Failed to load IOS58 from NAND` | The loader can't start | Use the loader from the zip. A loader you build yourself fails here. |
| Boots to the character select instead of the Tournament screen | An old `lazyto_kiosk.bin`, or a card made before 2026-10-02 (its files were `tournament.bin` and `tournament.cfg`) | Unzip the zip onto the card again. |

If a Wii never appears on the status page, turn on **Log** in the loader's menu, boot once, and
read `slippi_ndebug.log` on the SD card. Then turn Log off again.
