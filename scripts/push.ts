// push -- build the relay on this machine and install it on the Pi.
//
//   npm run push                       production: the tournament named by TOURNAMENT in .env
//   npm run push -- --test             testing: TEST_TOURNAMENT in .env instead
//   npm run push -- --dry-run          build the bundle, install nothing
//   npm run push -- --pi-host <name> --user <user>   a Pi with another name or user
//   npm run push -- --no-auto-update   keep THIS build: the Pi's auto-update stays off
//                                      until the next push without the flag
//
// Everything about your event comes from .env (see .env.example):
//   TOURNAMENT          your start.gg short URL (e.g. "mybar"). The relay finds
//                       the tournament it is on among your admin tournaments, so
//                       a weekly that moves its short URL needs no push per week.
//   WEEKLY_NAME_PREFIX  optional. With e.g. "My Bar Weekly #", a short URL
//                       not moved yet falls back to the tournament named that
//                       prefix plus a number, nearest to now (src/resolve.ts).
//   EVENT_NAME          picks the Melee singles event whose name contains it.
//   STREAM_NAME         the stream, by its exact name in the stream settings.
//   STREAM_STATION      optional, default 1: the station number of the stream Wii.
//   SET_FORMAT          optional, default startgg: startgg = each set's best-of as
//                       start.gg has it; top8q = Bo3, Bo5 from the top-8 qualifiers onward.
//   ARCHIVE_SET_NAME    optional: the file name of each set's replay zip, with
//                       {fields} (src/names.ts); default
//                       "{tournament} - {round_short} - {p1} vs {p2}".
//   ARCHIVE_GAME_NAME   optional: each replay's name inside the zip; default
//                       "Game {game} - {p1} ({p1_char}) vs {p2} ({p2_char}) - {stage}".
//   TEST_TOURNAMENT     for --test: a full slug, "tournament/<slug>" (an
//                       unpublished tournament is never listed, so it needs one).
// Switching modes is a push; the relay's first log line says which tournament it
// found and how.
//
// Steps: npm run build -> write config.json (all from .env; startggEndpoint is
// always the production URL) -> tar the bundle (dist/, deploy/, package.json,
// README.md, config.json) -> scp to the Pi -> run deploy/install.sh there over
// ssh. Needs ssh, scp and tar on PATH (Windows 10+, macOS and Linux all ship
// them) and an ssh key the Pi trusts (docs/pi-setup.md). The token and
// RELAY_SECRET are read from .env and never leave this machine except over ssh.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, loadDotEnv, runCommand, runMain } from './lib/cli.js';
import { pushRelay, requireEnvFile } from './lib/pushrelay.js';

const repoRoot = resolve(import.meta.dirname, '..');

await runMain('push', () => {
  const { values } = parseArgs({
    options: {
      'pi-host': { type: 'string', default: 'relay.local' },
      user: { type: 'string', default: 'pi' },
      test: { type: 'boolean', default: false },
      'tcp-port': { type: 'string', default: '29470' },
      'http-port': { type: 'string', default: '29473' },
      'dry-run': { type: 'boolean', default: false },
      'no-auto-update': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(
      'usage: npm run push -- [--test] [--dry-run] [--pi-host relay.local] [--user pi] [--tcp-port 29470] [--http-port 29473] [--no-auto-update]',
    );
    return;
  }
  const port = (name: 'tcp-port' | 'http-port'): number => {
    const n = Number.parseInt(values[name], 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      fail(`--${name} must be a port number, not '${values[name]}'`);
    return n;
  };
  const envPath = resolve(repoRoot, '.env');
  requireEnvFile(envPath);
  pushRelay(
    repoRoot,
    loadDotEnv(envPath),
    {
      piHost: values['pi-host'],
      user: values.user,
      test: values.test,
      tcpPort: port('tcp-port'),
      httpPort: port('http-port'),
      dryRun: values['dry-run'],
      noAutoUpdate: values['no-auto-update'],
    },
    { run: runCommand, out: (l) => console.log(l) },
  );
});
