// push, as a function: build, take the newest main build's bundle (for its Wii
// files), put this clone's relay in it, tar, scp to the Pi, and run the
// bundle's deploy/install.sh --bundle there over ssh. The runner is passed in
// so the test drives it with a fake curl, tar, scp and ssh.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail, type Runner } from './cli.js';

export const MAIN_BUILD_URL =
  'https://github.com/PranavMin/LazyTO/releases/download/main-build/lazyto.tgz';

export interface PushRelayOptions {
  piHost: string;
  user: string;
  dryRun: boolean;
  skipBuild?: boolean; // tests: dist/ already there
}

export interface PushRelayDeps {
  run: Runner;
  out: (line: string) => void;
  tmp?: string; // where the bundle is staged; default the OS temp dir
  now?: Date;
}

/**
 * This clone's dist/, deploy/ and package.json over the unpacked main build
 * in stageDir, which keeps its wii/ folder, with VERSION set to `version`.
 */
export function overlayBundle(repoRoot: string, stageDir: string, version: string): void {
  if (!existsSync(join(repoRoot, 'dist', 'main.js'))) fail('build produced no dist/main.js');
  if (!existsSync(join(stageDir, 'wii'))) fail('the main build has no wii/ folder');
  for (const d of ['dist', 'deploy']) rmSync(join(stageDir, d), { recursive: true, force: true });
  cpSync(join(repoRoot, 'dist'), join(stageDir, 'dist'), { recursive: true });
  cpSync(join(repoRoot, 'deploy'), join(stageDir, 'deploy'), {
    recursive: true,
    filter: (src) => !/[\\/]\.cache([\\/]|$)/.test(src),
  });
  cpSync(join(repoRoot, 'package.json'), join(stageDir, 'package.json'));
  writeFileSync(join(stageDir, 'VERSION'), `${version}\n`);
}

/** What runs on the Pi: the pushed bundle's own installer, which turns the Pi's updates off. */
export function remoteInstallCommand(): string {
  return (
    'rm -rf /tmp/lazyto-push && mkdir -p /tmp/lazyto-push && tar -xzf /tmp/lazyto.tgz -C /tmp/lazyto-push ' +
    '&& sudo bash /tmp/lazyto-push/deploy/install.sh --bundle /tmp/lazyto.tgz; ' +
    's=$?; rm -rf /tmp/lazyto-push /tmp/lazyto.tgz; exit $s'
  );
}

/** local-YYYYMMDD-HHMMSS, in UTC. */
function localVersion(now: Date): string {
  const t = now.toISOString().replace(/[-:]/g, '');
  return `local-${t.slice(0, 8)}-${t.slice(9, 15)}`;
}

export function pushRelay(
  repoRoot: string,
  o: PushRelayOptions,
  d: PushRelayDeps,
): { tgz: string; stage: string } {
  // --- build ---
  if (!o.skipBuild) {
    const b = d.run('npm', ['run', 'build'], { cwd: repoRoot, inherit: true });
    if (b.status !== 0) fail('npm run build failed');
  }

  // --- bundle: the main build with this clone's relay in it ---
  const tmp = d.tmp ?? tmpdir();
  const stage = join(tmp, 'lazyto-bundle');
  const tgz = join(tmp, 'lazyto.tgz');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  d.out('fetching the newest main build (for its Wii files) ...');
  // Relative paths from the temp dir: GNU tar (Git for Windows puts one on
  // PATH) reads "C:\..." as a remote host; bsdtar and GNU tar both take this.
  const c = d.run('curl', ['-fsSL', '-o', 'main-build.tgz', MAIN_BUILD_URL], { cwd: tmp });
  if (c.status !== 0) fail(`downloading ${MAIN_BUILD_URL} failed: ${c.stderr.trim()}`);
  const x = d.run('tar', ['-xzf', 'main-build.tgz', '-C', 'lazyto-bundle'], { cwd: tmp });
  if (x.status !== 0) fail(`unpacking the main build failed: ${x.stderr.trim()}`);
  const version = localVersion(d.now ?? new Date());
  overlayBundle(repoRoot, stage, version);
  rmSync(tgz, { force: true });
  const t = d.run('tar', ['-czf', 'lazyto.tgz', '-C', 'lazyto-bundle', '.'], { cwd: tmp });
  if (t.status !== 0) fail(`tar failed: ${t.stderr.trim()}`);

  d.out(`bundle: ${tgz} (${version}: this clone's relay, main's Wii files)`);
  if (o.dryRun) {
    d.out('dry run: not pushing');
    return { tgz, stage };
  }

  // --- push and install ---
  const target = `${o.user}@${o.piHost}`;
  d.out(`copying to ${target} ...`);
  const scp = d.run('scp', ['-q', tgz, `${target}:/tmp/lazyto.tgz`], { inherit: true });
  if (scp.status !== 0) fail(`scp to ${target} failed`);
  d.out('installing (sudo on the Pi) ...');
  const ssh = d.run('ssh', ['-t', target, remoteInstallCommand()], { inherit: true });
  if (ssh.status !== 0) fail('install on the Pi failed (see output above)');
  d.out(
    `done. Updates are off on the Pi, so this build stays; turn them back on from its ` +
      `settings page (Updates). Status page: http://${o.piHost}:29473`,
  );
  return { tgz, stage };
}
