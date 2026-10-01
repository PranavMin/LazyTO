// wiiload -- boot a loader on the Wii over Wi-Fi, no SD card trip.
//
//   npm run wiiload -- --wii 192.168.1.80
//   npm run wiiload -- --wii 192.168.1.80 --file path/to/boot.dol
//
// The Wii must be sitting on the Homebrew Channel (it shows its IP bottom-left
// when it is online). Sends the newest successful GitHub build of the fork's
// LazyTO loader (same cache as sync-card) unless --file is given. The card
// still provides tournament.bin, tournament.cfg and the game; this only
// replaces the "launch LazyTO" step. The Wii's IP can also come from the
// environment: WII_IP, or the devkitPro form WIILOAD=tcp:IP.
//
// Speaks the Homebrew Channel's protocol itself (scripts/lib/wiiload.ts), so
// nothing but Node is needed. gh (logged in) only when fetching the CI loader.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, green, runCommand, runMain } from './lib/cli.js';
import { describeLoaderBuild, LOADER_BRANCH, loaderBootDol, newestLoaderBuild, nintendontRepo } from './lib/loader.js';
import { sendWiiload } from './lib/wiiload.js';

const repoRoot = resolve(import.meta.dirname, '..');

await runMain('wiiload', async () => {
  const { values } = parseArgs({
    options: {
      wii: { type: 'string', default: '' },
      file: { type: 'string', default: '' },
      repo: { type: 'string', default: '' },
      branch: { type: 'string', default: LOADER_BRANCH },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('usage: npm run wiiload -- --wii <ip> [--file boot.dol] [--repo owner/Nintendont] [--branch name]');
    return;
  }
  let wii = values.wii;
  if (!wii) {
    const m = /^tcp:(.+)$/.exec(process.env.WIILOAD ?? '');
    wii = process.env.WII_IP || (m ? m[1] : '');
    if (!wii) fail('pass --wii <ip> (the Homebrew Channel shows it bottom-left), or set WII_IP');
  }
  let file = values.file;
  if (!file) {
    const build = newestLoaderBuild({ repo: values.repo || nintendontRepo(repoRoot), branch: values.branch, cacheDir: resolve(repoRoot, 'deploy', '.cache'), run: runCommand });
    file = loaderBootDol(build);
    console.log(describeLoaderBuild(build));
  }
  if (!existsSync(file)) fail(`file not found: ${file}`);
  console.log(`sending ${basename(file)} (${statSync(file).size.toLocaleString()} bytes) to the Wii at ${wii} ...`);
  try {
    await sendWiiload(wii, basename(file), readFileSync(file));
  } catch (e) {
    fail(`${e instanceof Error ? e.message : String(e)}. Is the Wii on the Homebrew Channel, on the same network, and is that its IP?`);
  }
  console.log(green('sent: the Wii is booting it now'));
});
