// sync-card -- make one Wii SD card ready for the kiosk, in one command.
//
//   npm run sync-card -- --station 1 --stream 1
//   npm run sync-card -- --relay-config <dev relay config.json>
//   npm run sync-card -- --drive F            (Windows letter, or a mount path on macOS/Linux)
//
// What it does (docs/wii-setup.md section 1):
//   1. finds the card: the one removable FAT32 drive (or --drive)
//   2. loader: the newest successful GitHub build of the Nintendont fork's
//      LazyTO branch ("CI Slippi Nintendont Builds"), downloaded once into
//      deploy/.cache, copied to apps/LazyTO. Never a locally built loader:
//      those fail on hardware (Nintendont docs/build-windows.md).
//   3. module: kiosk/build/tournament.bin (or --module), refused if the kiosk
//      sources have a dev switch on (docs/kiosk.md)
//   4. tournament.cfg: station / stream / secret. Station and stream default to
//      what the card already has. The secret comes from --relay-config (a relay
//      config.json, e.g. a dev relay) or else .env RELAY_SECRET (the venue
//      relay); it is never printed.
//   5. loader config (slippi_nincfg.bin, written by the loader's own settings
//      menu): turns on Network, Auto Boot, and Log unless --no-log. Nothing
//      else in it changes.
//   6. checks every copied file by hash, then ejects the card (--no-eject to keep it).
//
// Needs: gh (logged in), and for a fresh card a Melee 1.02 image at
// games/GALE01/game.iso or games/<name> GALE01/game.iso (not copied by this script).
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, runCommand, runMain } from './lib/cli.js';
import { LOADER_BRANCH, nintendontRepo } from './lib/loader.js';
import { syncCard } from './lib/synccard.js';

const repoRoot = resolve(import.meta.dirname, '..');

await runMain('sync-card', () => {
  const { values } = parseArgs({
    options: {
      station: { type: 'string' },
      stream: { type: 'string' },
      drive: { type: 'string', default: '' },
      'relay-config': { type: 'string', default: '' },
      module: { type: 'string', default: resolve(repoRoot, 'kiosk', 'build', 'tournament.bin') },
      'melee-src': { type: 'string', default: resolve(repoRoot, 'kiosk', 'src', 'melee') },
      repo: { type: 'string', default: '' },
      branch: { type: 'string', default: LOADER_BRANCH },
      'no-eject': { type: 'boolean', default: false },
      'no-log': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(
      'usage: npm run sync-card -- [--station N] [--stream 0|1] [--drive X] [--relay-config file] [--module file] [--repo owner/Nintendont] [--branch name] [--no-eject] [--no-log]',
    );
    return;
  }
  const station = values.station === undefined ? -1 : Number.parseInt(values.station, 10);
  const stream = values.stream === undefined ? -1 : Number.parseInt(values.stream, 10);
  if (values.station !== undefined && (!Number.isInteger(station) || station < 0))
    fail(`--station must be a station number, not '${values.station}'`);
  if (values.stream !== undefined && stream !== 0 && stream !== 1)
    fail(`--stream must be 0 or 1, not '${values.stream}'`);
  syncCard(
    {
      station,
      stream,
      drive: values.drive,
      relayConfig: values['relay-config'],
      module: values.module,
      meleeSrc: values['melee-src'],
      repo: values.repo || nintendontRepo(repoRoot),
      branch: values.branch,
      cacheDir: resolve(repoRoot, 'deploy', '.cache'),
      envFile: resolve(repoRoot, '.env'),
      eject: !values['no-eject'],
      log: !values['no-log'],
    },
    { run: runCommand, out: (l) => console.log(l) },
  );
});
