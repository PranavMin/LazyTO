// smoke.mjs -- does the app start? Launches LazyTO with a fresh userData
// (--user-data-dir), waits until GET / on port 29473 answers 200 (a new
// install: the setup page) and the setup code is in that userData, then
// kills it. CI runs it on each packaged app (release.yml); in development,
// with no argument, it runs `electron .` from desktop/.
//
//   node scripts/smoke.mjs [path to LazyTO.exe or LazyTO.app/Contents/MacOS/LazyTO]

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const URL = 'http://127.0.0.1:29473/';
const TIMEOUT_MS = 90_000;

const packaged = process.argv[2];
const electron = createRequire(import.meta.url)('electron'); // the binary's path
const exe = packaged ?? electron;
const userData = mkdtempSync(join(tmpdir(), 'lazyto-smoke-'));
const windows = process.platform === 'win32';
// A Linux CI runner withholds the user namespaces Chromium's sandbox needs.
const noSandbox = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];
const args = [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`, ...noSandbox];

const child = spawn(exe, args, {
  cwd: join(import.meta.dirname, '..'),
  detached: !windows,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let exited = null;
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));
child.on('exit', (code) => (exited = code ?? 'signal'));

function stop() {
  if (exited !== null) return;
  if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    if (exited !== null) throw new Error(`LazyTO exited (${exited}) before serving ${URL}`);
    if (Date.now() > deadline) throw new Error(`no answer on ${URL} within ${TIMEOUT_MS / 1000} s`);
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(5_000) });
      const html = await res.text();
      if (res.status !== 200) throw new Error(`GET / answered ${res.status}`);
      if (!/Set up LazyTO/.test(html))
        throw new Error('GET / is not the setup page of a new install');
      if (!existsSync(join(userData, 'setup-code')))
        throw new Error('no setup-code in --user-data-dir');
      console.log(`smoke: GET / -> 200, the setup page; userData ${userData}`);
      return;
    } catch (e) {
      if (e instanceof Error && /answered|setup page|setup-code/.test(e.message)) throw e;
      await delay(500); // not listening yet
    }
  }
}

main()
  .catch((e) => {
    console.error(`smoke: ${e.message}\n--- app output ---\n${output}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    stop();
    await delay(1000);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
