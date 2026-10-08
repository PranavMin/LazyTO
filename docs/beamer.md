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

Protocol v2 ([protocol-v2.md](protocol-v2.md)) names each game's replay. Until the kiosk reads the
record gate, it reports `replay_id` 0 for every game, and the archive binds no replay. How the
relay collects and matches replays is in [architecture.md](architecture.md#replays).

1. **The game names its replay.** Each `game_result` in a score report carries the entrants' CSS
   ports (from the L + R claim) and `replay_id`, the match's Slippi `gameStartTime`. The
   replay is `Game_<Wii MAC>_<replay_id as UTC YYYYMMDDTHHMMSS>.slp`. `CMD_GAME_START` is gone.
2. **Collecting.** Each beamer syncs with the relay (`CMD_BEAMER_SYNC`), and the relay downloads
   every file it has, whatever set it belongs to, into the archive folder (`Documents/LazyTO` by
   default): `raw/<station_id>/` for replays a game names, `unmatched/<station_id>/` for the rest.
   The multicast announces and the 5 s index poll are gone.
3. **Matching.** By `replay_id` on the beamer the game was reported through. The replay's stage,
   characters, costumes and (when the game sent them) stocks are checked against the report, and
   a mismatch is flagged (`archive_mismatch`) but still bound (`src/archive.ts`).
4. **Writing the zip.** Once a set has ended and every game has a complete replay, the relay
   writes `<archive folder>/<archiveSetName>.zip`, which contains:
   - `context.json`, written only when every game had an L + R claim;
   - one `<archiveGameName>.slp` per game, with the tags in the replay's display-name fields.
     Replay Reporter and Slippi Launcher show those names.
   A set with a game that has no replay gets no zip until the replay arrives.

Notes:

- **Name templates** are the settings file's optional `archiveSetName` and `archiveGameName`
  (defaults in `src/config.ts`, fields in `src/names.ts`). They are not on the setup page; edit
  `config.json` and the setup page keeps them. An unknown field is a settings error.
  Example: `My Bar {number} - {round_short} - {p1} vs {p2}` gives
  `My Bar 60 - WSF - Cody vs Zain.zip`.
- **A game played again after an undo** replaces the first try in the zip: the new report
  carries the new match's id.
- **The status page** has a "Beamers" section (one row per beamer, and "All replays collected:
  safe to unplug beamers") and a "Replays" section (sets skipped for Lucky Stats, zips written).
- **State survives a relay restart.** It lives in the archive folder: `.sets/`, `index.jsonl`,
  `raw/`, `unmatched/`.

### Trying it without a beamer (Dolphin)

Dolphin has no record gate, so under protocol v2 its games report `replay_id` 0 and no zip is
written. Collection itself can be tried:

1. Run the relay against the fake start.gg with the network side on
   (`npx tsx scripts/preview-status.ts --network`) and the development Dolphin against it
   (docs/development.md).
2. Run a fake beamer over Dolphin's replay folder, from this machine's LAN address (the one
   Dolphin's requests come from):

   ```
   npx tsx scripts/fake-beamer.ts --dir "%USERPROFILE%\Documents\Slippi" --address 192.168.1.67
   ```

3. Play. Each finished replay is downloaded, answered held and acked on the next sync, and lands
   in the archive folder's `unmatched/`; the status page shows the beamer's row.

## Beamer transport

- **Where the beamer lives.** The beamer is the Wii's USB drive, and the game boots from SD with
  Slippi replays on. Its firmware serves a 16-sector mailbox from RAM, just past the end of its
  replay partition. No filesystem covers those sectors on either side.
- **What the Wii does.** The kernel writes each request into the mailbox. That is the same bytes
  it would send over TCP, `relay_auth` included. It then polls for the beamer's answer. The
  beamer forwards the bytes to the relay over Wi-Fi and finds the relay by its beacon, as a Wii
  does. The relay does not change at all. (Mailbox v1. In v2 the beamer holds the station number
  and the secret and writes `relay_auth` itself: [protocol-v2.md](protocol-v2.md).)
- **Setup.** Put `transport=beamer` in `lazyto_station.txt`, turn the loader's Network option off,
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
