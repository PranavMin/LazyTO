// push, as a function: build, stage the bundle with config.json from .env,
// tar, scp to the Pi, run deploy/install.sh there over ssh. The runner is
// passed in so the test drives it through --dry-run and a fake ssh/scp.
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail, type Runner } from './cli.js';
import {
  describeRelayConfig,
  relayConfigFromEnv,
  remoteInstallCommand,
  stageBundle,
  type PushOptions,
} from './pushconfig.js';

export interface PushRelayOptions extends PushOptions {
  piHost: string;
  user: string;
  dryRun: boolean;
  noAutoUpdate: boolean;
  skipBuild?: boolean; // tests: dist/ already there
}

export interface PushRelayDeps {
  run: Runner;
  out: (line: string) => void;
  tmp?: string; // where the bundle is staged; default the OS temp dir
}

export function pushRelay(
  repoRoot: string,
  env: Record<string, string>,
  o: PushRelayOptions,
  d: PushRelayDeps,
): { tgz: string; stage: string } {
  const config = relayConfigFromEnv(env, o);

  // --- build ---
  if (!o.skipBuild) {
    const b = d.run('npm', ['run', 'build'], { cwd: repoRoot, inherit: true });
    if (b.status !== 0) fail('npm run build failed');
  }

  // --- bundle ---
  const tmp = d.tmp ?? tmpdir();
  const stage = join(tmp, 'lazyto-bundle');
  const tgz = join(tmp, 'lazyto.tgz');
  stageBundle(repoRoot, stage, config);
  rmSync(tgz, { force: true });
  // Relative paths from the temp dir: GNU tar (Git for Windows puts one on
  // PATH) reads "C:\..." as a remote host; bsdtar and GNU tar both take this.
  const t = d.run('tar', ['-czf', 'lazyto.tgz', '-C', 'lazyto-bundle', '.'], { cwd: tmp });
  if (t.status !== 0) fail(`tar failed: ${t.stderr.trim()}`);

  d.out(`bundle: ${tgz}`);
  d.out(describeRelayConfig(config, o));
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
  const ssh = d.run('ssh', ['-t', target, remoteInstallCommand(o.noAutoUpdate)], { inherit: true });
  if (ssh.status !== 0) fail('install on the Pi failed (see output above)');
  // The bundle carries the token; don't leave it lying in the temp dir.
  rmSync(stage, { recursive: true, force: true });
  rmSync(tgz, { force: true });
  if (o.noAutoUpdate)
    d.out(
      'auto-update OFF on the Pi (this build stays); push again without --no-auto-update to turn it back on',
    );
  d.out(
    `done. status page: http://${o.piHost}:29473   smoke test: npx tsx scripts/smoke.ts ${o.piHost}`,
  );
  return { tgz, stage };
}

export function requireEnvFile(path: string): void {
  if (!existsSync(path)) fail(`.env not found at ${path}`);
}
