// The Wii loader comes only from the Nintendont fork's GitHub CI ("CI Slippi
// Nintendont Builds", workflow build.yml, branch LazyTO): a locally built
// loader fails on hardware (Nintendont docs/build-windows.md). The newest
// successful run's release-* artifact is downloaded once into
// deploy/.cache/loader-<sha> and reused by sync-card and wiiload.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, type Runner } from './cli.js';
import { findDir, findFile } from './fsx.js';

export const LOADER_APP_NAME = 'LazyTO';
export const LOADER_BRANCH = 'LazyTO';

/** owner/Nintendont from .gitmodules, so a fork of the whole repo points at its own loader fork. */
export function nintendontRepo(repoRoot: string): string {
  const gm = readFileSync(join(repoRoot, '.gitmodules'), 'utf8');
  const m = /url = https:\/\/github\.com\/([^/\s]+\/Nintendont)(\.git)?/.exec(gm);
  if (!m) fail('cannot find the Nintendont submodule URL in .gitmodules; pass --repo owner/Nintendont');
  return m[1];
}

export interface LoaderBuild {
  runId: number;
  sha: string; // 7 chars
  createdAt: string;
  dir: string; // the cache folder holding the extracted artifact
}

/** gh is the command runner (tests pass a fake). Needs gh logged in. */
export function newestLoaderBuild(opts: { repo: string; branch: string; cacheDir: string; run: Runner }): LoaderBuild {
  const list = opts.run('gh', ['run', 'list', '-R', opts.repo, '--workflow', 'build.yml', '--branch', opts.branch, '--status', 'success', '-L', '1', '--json', 'databaseId,headSha,createdAt']);
  if (list.status !== 0) fail(`gh run list failed: ${(list.stderr || list.stdout).trim()}`);
  let runs: Array<{ databaseId: number; headSha: string; createdAt: string }>;
  try {
    runs = JSON.parse(list.stdout);
  } catch {
    fail(`gh run list returned no JSON: ${list.stdout.trim()}`);
  }
  if (!Array.isArray(runs) || runs.length === 0) fail(`no successful CI build of ${opts.repo} ${opts.branch} yet`);
  const run = runs[0];
  const sha = run.headSha.slice(0, 7);
  const dir = join(opts.cacheDir, `loader-${sha}`);
  const done = join(dir, 'done');
  if (!existsSync(done)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const dl = opts.run('gh', ['run', 'download', String(run.databaseId), '-R', opts.repo, '-D', dir, '-p', 'release-*']);
    if (dl.status !== 0) fail(`gh run download ${run.databaseId} failed: ${(dl.stderr || dl.stdout).trim()}`);
    writeFileSync(done, `${run.databaseId}\n`);
  }
  return { runId: run.databaseId, sha, createdAt: run.createdAt, dir };
}

/** The artifact's apps/<LOADER_APP_NAME> folder (boot.dol, icon.png, meta.xml). */
export function loaderAppDir(build: LoaderBuild): string {
  const d = findDir(build.dir, LOADER_APP_NAME);
  if (!d) fail(`the CI artifact has no apps/${LOADER_APP_NAME} folder (built before the rename?)`);
  return d;
}

export function loaderBootDol(build: LoaderBuild): string {
  const f = findFile(build.dir, (rel) => rel.endsWith('/boot.dol') && rel.includes(`${LOADER_APP_NAME}/`));
  if (!f) fail(`no ${LOADER_APP_NAME} boot.dol in the CI artifact`);
  return f;
}

export function describeLoaderBuild(b: LoaderBuild): string {
  return `loader : CI build ${b.runId} (commit ${b.sha}, ${b.createdAt})`;
}
