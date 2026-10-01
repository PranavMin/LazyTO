# Beamer transport and set archive (experimental)

This branch (`beamer`) adds two features. Both are built but not yet tried on hardware.

1. **Set archive.** Each finished set becomes one zip of its replays. The zip has a name you
   choose, the players' tags written into each replay, and a `context.json` that links it to the
   start.gg set. That is the format Replay Reporter for Slippi writes and Lucky Stats imports.
   The replays come from each station's
   [Slippi Beamer](https://github.com/jendotpg/slippi-beamer), a USB stick that records them and
   serves them over Wi-Fi.
2. **Beamer transport.** The Wii sends its relay requests through a LazyTO beamer (a beamer with
   the firmware on the `LazyTO` branch of
   [PranavMin/slippi-beamer](https://github.com/PranavMin/slippi-beamer)) instead of its own
   network.

The set archive works with either transport, as long as each station has a beamer.

## Set archive

1. **Game start.** On the first frame of every match, the kiosk sends `CMD_GAME_START`
   (protocol.yaml `game_start_req`). It carries:
   - the set and game number, and whether it is a handwarmer;
   - the stage;
   - per port, the character and costume;
   - which ports entrant 1 and entrant 2 are on, from the L + R claim.

   It is fire and forget: the kiosk never shows the answer.
2. **Finding the beamers.** A beamer multicasts a short JSON message on every game start and end,
   naming itself "Station N" (set with its button). The relay takes the station's beamer address
   from that message (`src/beamer.ts`).
3. **Pulling replays.** While a station has a set, the relay polls its beamer's `GET /SLIPPI/`
   every 5 s and downloads each new replay.
4. **Matching.** Each replay is bound to the earliest unmatched game start of that station that
   came before it and has the same ports, characters, costumes and stage. Handwarmers are
   matched too, so they cannot be taken for the next game, but they never go in the zip
   (`src/archive.ts`).
5. **Writing the zip.** At `CMD_END_SET` the relay waits until every scored game has its replay,
   or 3 minutes have passed. Then it writes `<archiveDir>/<ARCHIVE_SET_NAME>.zip`, which contains:
   - `context.json`, written only when every game had an L + R claim;
   - one `<ARCHIVE_GAME_NAME>.slp` per game, with the tags in the replay's display-name fields.
     Replay Reporter and Slippi Launcher show those names.

Notes:

- **Name templates** are set in `.env` (`ARCHIVE_SET_NAME`, `ARCHIVE_GAME_NAME`; the list of
  fields is in `.env.example` and `src/names.ts`). An unknown field stops the relay at startup.
  Example: `My Bar {number} - {round_short} - {p1} vs {p2}` gives
  `My Bar 60 - WSF - Cody vs Zain.zip`.
- **A game played again after an undo** replaces the first try in the zip.
- **The status page** has a "Beamers and set archives" section showing each beamer, the sets in
  progress, and the zips written.
- **State survives a relay restart.** It lives in `<archiveDir>/.sets` and `.raw`.

### Trying it without a beamer (Dolphin)

1. Build the kiosk on this branch (`python kiosk/tools/build_module.py`) and run it in the
   Dolphin development setup (docs/development.md).
2. Run a fake beamer over Dolphin's replay folder:

   ```
   npx tsx scripts/fake-beamer.ts --dir "%USERPROFILE%\Documents\Slippi" --station 0 --port 8085
   ```

   Dolphin is station 0. If multicast does not loop back on your machine, add `--to 127.0.0.1`.
3. Run the relay with `"beamerHttpPort": 8085` and an `archiveDir`.
4. Play a set: claim with L + R, play, end it. The zip appears in `archiveDir`.

## Beamer transport

- **Where the beamer lives.** The beamer is the Wii's USB drive, and the game boots from SD with
  Slippi replays on. Its firmware serves a 16-sector mailbox from RAM, just past the end of its
  replay partition. No filesystem covers those sectors on either side.
- **What the Wii does.** The kernel writes each request into the mailbox. That is the same bytes
  it would send over TCP, `relay_auth` included. It then polls for the beamer's answer. The
  beamer forwards the bytes to the relay over Wi-Fi and finds the relay by its beacon, as a Wii
  does. The relay does not change at all.
- **Setup.** Put `transport=beamer` in `tournament.cfg`, turn the loader's Network option off,
  and turn Slippi replays on with the game on SD.
- **Kiosk messages.** The kiosk shows `PF_NO_BEAMER` when no LazyTO beamer answers.

Layout and rules: protocol.yaml `beamer_hello`, `beamer_req_hdr`, `beamer_resp_hdr`,
`beamer_tele_hdr` and the `BEAMER_*` constants.

Kernel side (Nintendont branch `beamer`):

- **USB lock.** Two threads now use USB, the Slippi file writer and the relay thread, so USB
  transfers run under a one-token message-queue lock.
- **Mailbox address.** The kernel finds the mailbox from the drive's MBR: the end of the first
  FAT32 partition.
- **Request numbering.** Each request carries a number (`seq`). The beamer stays powered while the
  Wii restarts and keeps its last answer, so on finding the beamer the kernel starts one past
  the number in that answer.

## First hardware test (when the beamers arrive)

1. **Beamer firmware alone.** Flash the `LazyTO` firmware and set `LAZYTO = true` in the beamer's
   `CONFIG/config.txt`. Plug it into a Linux machine. Run `tools/lazyto_host.py` from the
   firmware repo against a dev relay: HELLO, then a LIST_SETS round trip.
2. **On a Wii.** Use a CI-built LazyTO loader from Nintendont branch `beamer`, a card with
   `transport=beamer`, Network off, and replays on. Check:
   - the set list loads;
   - a full set plays through;
   - the zip appears on the Pi.
3. **Before trusting it at an event, play 20 games.** Report each score while the beamer is
   still serving the previous replay, and check no replay is lost.
