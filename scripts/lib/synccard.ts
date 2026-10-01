// sync-card, as a function: everything scripts/sync-card.ts does, with the
// system touch points (command runner, output) passed in, so the test runs
// it against a folder standing in for the card and a fake gh.
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fail, green, yellow, type Runner } from './cli.js';
import { ejectCard, findCard, type Volume } from './card.js';
import { copyFlat, findFile, md5File } from './fsx.js';
import { describeLoaderBuild, loaderAppDir, LOADER_APP_NAME, newestLoaderBuild } from './loader.js';
import { describeLoaderConfig, patchLoaderConfig, type LoaderConfigPatch } from './nincfg.js';
import { checkDevSwitches, sourcesNewerThan } from './switches.js';
import {
  formatTournamentCfg,
  parseTournamentCfg,
  resolveStationStream,
  SECRET_RE,
  tournamentCfgMatches,
} from './tcfg.js';

export interface SyncCardOptions {
  station: number; // -1 = keep the card's
  stream: number; // -1 = keep the card's (0 if none)
  drive: string; // "" = find it
  relayConfig: string; // a relay config.json whose secret to use, or ""
  module: string; // tournament.bin
  meleeSrc: string; // kiosk/src/melee
  repo: string; // owner/Nintendont
  branch: string;
  cacheDir: string; // deploy/.cache
  envFile: string; // .env (RELAY_SECRET)
  eject: boolean;
  log: boolean;
}

export interface SyncCardDeps {
  run: Runner;
  out: (line: string) => void;
}

export interface SyncCardResult {
  card: Volume;
  station: number;
  stream: number;
  secretFrom: string;
  loaderFiles: string[];
  checks: Array<{ file: string; ok: boolean }>;
  ejected: boolean | null; // null = not asked
}

export function syncCard(o: SyncCardOptions, d: SyncCardDeps): SyncCardResult {
  // ---- 1. the card
  const card = findCard(o.drive, d.run);
  const melee = existsSync(join(card.root, 'games'))
    ? findFile(join(card.root, 'games'), (rel) => /GALE01[^/]*\/game\.iso$/.test(rel))
    : undefined;
  d.out(
    `card: ${card.root}  ${melee ? `(Melee image: ${relative(card.root, melee).split(sep).join('/')})` : `(${yellow('WARNING')}: no games/...GALE01/game.iso on this card)`}`,
  );

  // ---- 2. the loader: newest successful CI build
  const build = newestLoaderBuild({
    repo: o.repo,
    branch: o.branch,
    cacheDir: o.cacheDir,
    run: d.run,
  });
  const srcApp = loaderAppDir(build);
  const dstApp = join(card.root, 'apps', LOADER_APP_NAME);
  const loaderFiles = copyFlat(srcApp, dstApp);

  // ---- 3. the module, refused if a dev switch is on
  if (!existsSync(o.module))
    fail(`module not found: ${o.module} (build it: python kiosk/tools/build_module.py)`);
  const head = readFileSync(o.module).subarray(0, 4).toString('latin1');
  if (head !== 'TMOD') fail(`${o.module} is not a TMOD module`);
  checkDevSwitches(o.meleeSrc);
  const newer = sourcesNewerThan(o.meleeSrc, statSync(o.module).mtimeMs);
  if (newer.length > 0)
    d.out(
      yellow(
        `WARNING: module source is newer than tournament.bin (${newer.join(', ')}); rebuild if that edit should ship`,
      ),
    );
  copyFileSync(o.module, join(card.root, 'tournament.bin'));

  // ---- 4. tournament.cfg
  const cfgPath = join(card.root, 'tournament.cfg');
  const old = existsSync(cfgPath) ? parseTournamentCfg(readFileSync(cfgPath, 'utf8')) : {};
  const { station, stream } = resolveStationStream(old, o.station, o.stream);
  let secret: string;
  let secretFrom: string;
  if (o.relayConfig) {
    secret = String(
      (JSON.parse(readFileSync(o.relayConfig, 'utf8')) as { secret?: unknown }).secret ?? '',
    );
    secretFrom = `relay config ${o.relayConfig.split(/[\\/]/).pop()}`;
  } else {
    const line = existsSync(o.envFile)
      ? readFileSync(o.envFile, 'utf8')
          .split(/\r?\n/)
          .find((l) => l.startsWith('RELAY_SECRET='))
      : undefined;
    secret = line ? line.slice('RELAY_SECRET='.length).trim().replace(/^"|"$/g, '') : '';
    secretFrom = '.env RELAY_SECRET (venue relay)';
  }
  if (!SECRET_RE.test(secret)) fail(`no valid secret from ${secretFrom} (8-16 of A-Z a-z 0-9 - _)`);
  writeFileSync(cfgPath, formatTournamentCfg({ station, stream, secret }), { encoding: 'ascii' });

  // ---- 5. loader config bits: Network, Auto Boot, Log
  const ninCfg = join(card.root, 'slippi_nincfg.bin');
  let patch: LoaderConfigPatch | null = null;
  if (existsSync(ninCfg)) {
    patch = patchLoaderConfig(readFileSync(ninCfg), { log: o.log });
    if (patch.kind === 'patched') writeFileSync(ninCfg, patch.bytes);
  }

  // ---- 6. verify, report, eject
  const checks: Array<{ file: string; ok: boolean }> = loaderFiles.map((name) => ({
    file: `apps/${LOADER_APP_NAME}/${name}`,
    ok: md5File(join(srcApp, name)) === md5File(join(dstApp, name)),
  }));
  checks.push({
    file: 'tournament.bin',
    ok: md5File(o.module) === md5File(join(card.root, 'tournament.bin')),
  });
  checks.push({
    file: 'tournament.cfg',
    ok: tournamentCfgMatches(readFileSync(cfgPath, 'utf8'), { station, stream, secret }),
  });
  d.out('');
  for (const c of checks) d.out(`  ${c.file.padEnd(28)} ${c.ok ? green('ok') : red('MISMATCH')}`);
  d.out('');
  if (checks.some((c) => !c.ok))
    fail('a file on the card does not match its source; nothing ejected');
  d.out(describeLoaderBuild(build));
  d.out(`module : ${statSync(o.module).size} bytes, md5 ${md5File(o.module)}`);
  d.out(`config : station=${station} stream=${stream} secret from ${secretFrom}`);
  d.out(`loader : ${describeLoaderConfig(patch, { log: o.log })}`);

  let ejected: boolean | null = null;
  if (o.eject) {
    ejected = ejectCard(card, d.run);
    d.out(
      ejected
        ? green('ejected: the card is safe to remove')
        : yellow('card is still mounted; eject it from the OS before pulling it'),
    );
  }
  return { card, station, stream, secretFrom, loaderFiles, checks, ejected };
}

function red(s: string): string {
  return process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s;
}
