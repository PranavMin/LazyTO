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

Protocol v2 ([protocol-v2.md](protocol-v2.md)) names each game's replay. The kiosk reads the id
from the record gate, which needs the v2 loader (`host_build` 7). In Dolphin every game reports
`replay_id` 0, and the archive binds no replay. How the relay collects and matches replays is in
[architecture.md](architecture.md#replays).

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
   writes the zip Replay Reporter for Slippi would have written for the set
   ([architecture.md](architecture.md#replays), `src/setzip.ts`), for example
   `<archive folder>/Melee Singles WSF - Kestrel (Fox, ICs) vs Ember (Falco).zip`, which contains:
   - `context.json`, written only when every game had an L + R claim;
   - one `<n> - <players and characters> - <stage>.slp` per game, re-timed to the report, with
     the tags in the replay's display-name fields. Replay Reporter and Slippi Launcher show those
     names.
   A set with a game that has no replay gets no zip until the replay arrives.

Notes:

- **Names** are Replay Reporter's (`src/names.ts`), not settings. The earlier settings
  `archiveSetName` and `archiveGameName` are ignored if a settings file still has them.
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
- **What the Wii does.** The kernel writes each request into the mailbox, stamped with the
  station number from the beamer's hello and without `relay_auth`, then polls for the beamer's
  answer. The beamer puts its own `relay_auth` (a key derived from its `LAZYTO-SECRET`, never the
  secret) in front, forwards the bytes
  to the relay over Wi-Fi and finds the relay by its beacon. Mailbox v2:
  [protocol-v2.md](protocol-v2.md).
- **Setup.** Every SD card is the same (`src/cards.ts`): Slippi replays on, Network off, the game
  on SD. The beamer holds the station number (its button) and the secret (`CONFIG/config.txt`).
- **Kiosk messages.** The kiosk says what is wrong with the beamer in its own words: no beamer and
  why, no number, no secret, its Wi-Fi, no relay, its card ([protocol-v2.md](protocol-v2.md),
  Kiosk).

Layout and rules: protocol.yaml `beamer_hello`, `beamer_req_hdr`, `beamer_resp_hdr`,
`beamer_tele_hdr` and the `BEAMER_*` constants.

Kernel side (Nintendont branch `redesign`, the pinned commit):

- **USB lock.** Two threads now use USB, the Slippi file writer and the relay thread, so USB
  transfers run under a one-token message-queue lock. The relay thread waits for it at most what
  is left of the request's 3 s budget.
- **Mailbox address.** The kernel finds the mailbox from the drive's MBR: the end of the first
  FAT32 partition.
- **Request numbering.** Each request carries a number (`seq`). The beamer stays powered while the
  Wii restarts and keeps its last answer, so on finding the beamer the kernel starts one past
  the number in that answer.

## First hardware test (when the beamers arrive)

1. **Beamer firmware alone.** Flash the fork's v2 firmware (branch `lazyto-redesign`, build 2),
   set `LAZYTO = true` and `LAZYTO-SECRET` in the beamer's `CONFIG/config.txt`, and give it a
   number with its button. Plug it into a Linux machine. Run `tools/lazyto_host.py` from the
   firmware repo against a dev relay: HELLO, then a LIST_SETS round trip.
2. **On a Wii.** Use a CI-built LazyTO loader from the pinned Nintendont commit (branch
   `redesign`) and a card from this relay's SD-card zip. Check:
   - the set list loads;
   - a full set plays through;
   - the zip appears in the relay's archive folder.
3. **Before trusting it at an event, play 20 games.** Report each score while the beamer is
   still serving the previous replay, and check no replay is lost.
