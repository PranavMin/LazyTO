// push -- install the relay built in this clone on the Pi, to try a change
// before it is merged. Takes the newest main build from GitHub (main-build,
// for its loader and tournament.bin), puts this clone's dist/ and deploy/ in
// it, and installs that with the Pi's own installer (deploy/install.sh
// --bundle). The Pi keeps its settings; its updates turn off so the build
// stays until you pick Updates on its settings page.
//
//   npm run push                                   build, bundle, install on pi@relay.local
//   npm run push -- --dry-run                      build the bundle, install nothing
//   npm run push -- --pi-host <name> --user <user> a Pi with another name or user
//
// Needs curl, ssh, scp and tar on PATH (Windows 10+, macOS and Linux all ship
// them) and ssh access to the Pi.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runCommand, runMain } from './lib/cli.js';
import { pushRelay } from './lib/pushrelay.js';

const repoRoot = resolve(import.meta.dirname, '..');

await runMain('push', () => {
  const { values } = parseArgs({
    options: {
      'pi-host': { type: 'string', default: 'relay.local' },
      user: { type: 'string', default: 'pi' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('usage: npm run push -- [--dry-run] [--pi-host relay.local] [--user pi]');
    return;
  }
  pushRelay(
    repoRoot,
    { piHost: values['pi-host'], user: values.user, dryRun: values['dry-run'] },
    { run: runCommand, out: (l) => console.log(l) },
  );
});
