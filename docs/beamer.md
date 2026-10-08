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
record gate, it reports `replay_id` 0 for every game, and the archive binds no replay.

1. **The game names its replay.** Each `game_result` in a score report carries the entrants' CSS
   ports (from the L + R claim) and `replay_id`, the match's Slippi `gameStartTime`. The
   replay is `Game_<Wii MAC>_<replay_id as UTC YYYYMMDDTHHMMSS>.slp`. `CMD_GAME_START` is gone.
2. **Finding the beamers.** A beamer multicasts a short JSON message on every game start and end,
   naming itself "Station N" (set with its button). The relay takes the station's beamer address
   from that message (`src/beamer.ts`). The beamer sync (protocol v2) will replace this.
3. **Pulling replays.** While a station has a set, the relay polls its beamer's `GET /SLIPPI/`
   every 5 s and downloads the file of each reported game it has no replay for yet. Other files
   are left alone.
4. **Matching.** By `replay_id` only. The replay's stage, characters and costumes are checked
   against the report, and a mismatch is logged (`archive_mismatch`) but still bound
   (`src/archive.ts`).
5. **Writing the zip.** At `CMD_END_SET` the relay waits until every scored game with a replay id
   has its replay, or 3 minutes have passed. Then it writes `<dataDir>/archive/<archiveSetName>.zip`, which contains:
   - `context.json`, written only when every game had an L + R claim;
   - one `<archiveGameName>.slp` per game, with the tags in the replay's display-name fields.
     Replay Reporter and Slippi Launcher show those names.

Notes:

- **Name templates** are the settings file's optional `archiveSetName` and `archiveGameName`
  (defaults in `src/config.ts`, fields in `src/names.ts`). They are not on the setup page; edit
  `config.json` and the setup page keeps them. An unknown field is a settings error.
  Example: `My Bar {number} - {round_short} - {p1} vs {p2}` gives
  `My Bar 60 - WSF - Cody vs Zain.zip`.
- **A game played again after an undo** replaces the first try in the zip: the new report
  carries the new match's id.
- **The status page** has a "Beamers and set archives" section showing each beamer, the sets in
  progress, and the zips written.
- **State survives a relay restart.** It lives in `<dataDir>/archive/.sets` and `.raw`.

### Trying it without a beamer (Dolphin)

Dolphin has no record gate, so under protocol v2 its games report `replay_id` 0 and this run
writes no zip. The steps below are the v1 procedure, kept for when the Dolphin forwarder learns
replay ids.

1. Build the kiosk on this branch (`python kiosk/tools/build_module.py`) and run it in the
   Dolphin development setup (docs/development.md).
2. Run a fake beamer over Dolphin's replay folder:

   ```
   npx tsx scripts/fake-beamer.ts --dir "%USERPROFILE%\Documents\Slippi" --station 0 --port 8085
   ```

   Dolphin is station 0. If multicast does not loop back on your machine, add `--to 127.0.0.1`.
3. Run the relay against the fake start.gg with the network side on and the fake beamer's
   port: `startHarness({ network: true, beamerHttpPort: 8085 })` (`test/harness.ts`).
4. Play a set: claim with L + R, play, end it. The zip appears in `<dataDir>/archive`.

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
