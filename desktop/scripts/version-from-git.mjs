// version-from-git.mjs -- stamps desktop/package.json's version from the
// nearest v* tag before CI packages the app (release.yml), as Beamer Manager
// does (.erb/scripts/version-from-git.js there), so nobody bumps it by hand.
// On the tag itself it is the tag (v0.9.0 -> 0.9.0); N commits later it is
// the tag plus build metadata (0.9.0+3.gb4a17d7), which semver ranks equal to
// the tag, so a branch build never offers to "update" to the release it is
// built on. History with no v* tag yet counts from v0.0.0. Needs the full
// history (actions/checkout fetch-depth: 0).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const git = (...args) =>
  execFileSync('git', args, { cwd: import.meta.dirname, encoding: 'utf8' }).trim();

let tag = '0.0.0';
let commits = git('rev-list', '--count', 'HEAD');
const sha = `g${git('rev-parse', '--short=7', 'HEAD')}`;
if (git('tag', '--list', 'v[0-9]*', '--merged', 'HEAD') !== '') {
  const described = git('describe', '--tags', '--long', '--match', 'v[0-9]*');
  const m = /^v(.+)-(\d+)-g[0-9a-f]+$/.exec(described);
  if (!m) throw new Error(`git describe gave "${described}"`);
  [, tag, commits] = m;
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag))
  throw new Error(`Tag v${tag} isn't a semver version.`);
const version = commits === '0' ? tag : `${tag}+${commits}.${sha}`;

const file = join(import.meta.dirname, '..', 'package.json');
const json = JSON.parse(readFileSync(file, 'utf8'));
json.version = version;
writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
console.log(`LazyTO ${version}`);
