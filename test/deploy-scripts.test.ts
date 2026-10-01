// The operator scripts (scripts/sync-card.ts, push.ts, wiiload.ts) through
// their libraries: pure parts directly, sync-card end to end against a folder
// standing in for the card with a fake gh, push through --dry-run, wiiload
// against a fake Homebrew Channel socket. No network, no real card.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { parseDiskutilInfo, parseLsblk, parseWindowsVolumes } from '../scripts/lib/card.js';
import { loadDotEnv, ToolError, type Runner } from '../scripts/lib/cli.js';
import { newestLoaderBuild } from '../scripts/lib/loader.js';
import {
  describeLoaderConfig,
  NIN_CFG_AUTO_BOOT,
  NIN_CFG_LOG,
  NIN_CFG_MAGIC,
  NIN_CFG_NETWORK,
  patchLoaderConfig,
} from '../scripts/lib/nincfg.js';
import {
  describeRelayConfig,
  relayConfigFromEnv,
  remoteInstallCommand,
} from '../scripts/lib/pushconfig.js';
import { pushRelay } from '../scripts/lib/pushrelay.js';
import { checkDevSwitches } from '../scripts/lib/switches.js';
import { syncCard } from '../scripts/lib/synccard.js';
import {
  formatTournamentCfg,
  parseTournamentCfg,
  resolveStationStream,
  tournamentCfgMatches,
} from '../scripts/lib/tcfg.js';
import { parseWiiloadFrame, sendWiiload, wiiloadFrame } from '../scripts/lib/wiiload.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'lazyto-scripts-'));
const be32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const throwsTool = (fn: () => unknown, re: RegExp): void =>
  assert.throws(fn, (e: unknown) => e instanceof ToolError && re.test(e.message));

// ---------- .env
test('loadDotEnv: KEY=value, quotes dropped, other lines ignored, missing file is empty', () => {
  const d = tmp();
  writeFileSync(
    join(d, '.env'),
    '# c\nSTARTGG_TOKEN=abc \nRELAY_SECRET="s3cret-ok"\nlower=no\n\nTOURNAMENT=lazyto-weekly\n',
  );
  assert.deepEqual(loadDotEnv(join(d, '.env')), {
    STARTGG_TOKEN: 'abc',
    RELAY_SECRET: 's3cret-ok',
    TOURNAMENT: 'lazyto-weekly',
  });
  assert.deepEqual(loadDotEnv(join(d, 'none')), {});
});

// ---------- slippi_nincfg.bin
test('patchLoaderConfig ORs Network, Auto Boot and (unless asked) Log into the big-endian Config word only', () => {
  const file = Uint8Array.from([
    ...be32(NIN_CFG_MAGIC),
    ...be32(0xe),
    ...be32(0x00000400),
    9,
    9,
    9,
    9,
  ]);
  const p = patchLoaderConfig(file, { log: true });
  assert.equal(p.kind, 'patched');
  if (p.kind !== 'patched') return;
  assert.equal(p.oldWord, 0x400);
  assert.equal(p.newWord, 0x400 | NIN_CFG_NETWORK | NIN_CFG_AUTO_BOOT | NIN_CFG_LOG);
  assert.deepEqual([...p.bytes.subarray(8, 12)], be32(p.newWord));
  assert.deepEqual(
    [...p.bytes.subarray(0, 8)],
    [...file.subarray(0, 8)],
    'magic and version untouched',
  );
  assert.deepEqual([...p.bytes.subarray(12)], [9, 9, 9, 9], 'rest untouched');
  assert.deepEqual([...file.subarray(8, 12)], be32(0x400), 'input not mutated');
  const again = patchLoaderConfig(p.bytes, { log: true });
  assert.equal(again.kind, 'unchanged');
  const noLog = patchLoaderConfig(file, { log: false });
  assert.equal(noLog.kind, 'patched');
  if (noLog.kind === 'patched') assert.equal(noLog.newWord & NIN_CFG_LOG, 0);
  assert.match(
    describeLoaderConfig(p, { log: true }),
    /^loader config 00000400 -> 00002500: network on, auto boot on, log on$/,
  );
  assert.match(describeLoaderConfig(noLog, { log: false }), /log left as is$/);
});

test('patchLoaderConfig leaves an unknown file alone', () => {
  const p = patchLoaderConfig(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), {
    log: true,
  });
  assert.equal(p.kind, 'unrecognised');
  assert.match(
    describeLoaderConfig(p, { log: true }),
    /not recognised \(magic 01020304\); left alone/,
  );
  assert.equal(
    patchLoaderConfig(Uint8Array.from(be32(NIN_CFG_MAGIC)), { log: true }).kind,
    'unrecognised',
    'too short',
  );
  assert.match(describeLoaderConfig(null, { log: true }), /no slippi_nincfg.bin yet/);
});

// ---------- tournament.cfg
test('tournament.cfg: parse, defaults from the card, format, verify', () => {
  const old = parseTournamentCfg('station=3\r\nstream=1 \nsecret=abcdefgh\njunk\n');
  assert.deepEqual(old, { station: '3', stream: '1', secret: 'abcdefgh' });
  assert.deepEqual(resolveStationStream(old, -1, -1), { station: 3, stream: 1 });
  assert.deepEqual(resolveStationStream(old, 5, 0), { station: 5, stream: 0 });
  assert.deepEqual(resolveStationStream({}, 2, -1), { station: 2, stream: 0 });
  throwsTool(() => resolveStationStream({}, -1, -1), /no tournament.cfg yet: pass --station N/);
  const text = formatTournamentCfg({ station: 2, stream: 1, secret: 'kioskdev2026' });
  assert.equal(text, 'station=2\nstream=1\nsecret=kioskdev2026\n');
  assert.ok(tournamentCfgMatches(text, { station: 2, stream: 1, secret: 'kioskdev2026' }));
  assert.ok(!tournamentCfgMatches(text, { station: 12, stream: 1, secret: 'kioskdev2026' }));
  assert.ok(!tournamentCfgMatches(text, { station: 2, stream: 0, secret: 'kioskdev2026' }));
});

// ---------- dev switches
function fakeMeleeSrc(root: string, values: Record<string, string> = {}): string {
  const src = join(root, 'melee');
  mkdirSync(join(src, 'lb'), { recursive: true });
  mkdirSync(join(src, 'mn'), { recursive: true });
  writeFileSync(
    join(src, 'mn', 'mntourney.c'),
    `#define TM_DEMO_AUTOSTART ${values.TM_DEMO_AUTOSTART ?? '0'}\n`,
  );
  writeFileSync(
    join(src, 'lb', 'lbtourney.c'),
    `#define LB_TOURNEY_DEMO_CLAIM ${values.LB_TOURNEY_DEMO_CLAIM ?? '0'}\n#define LB_TOURNEY_TRIGGER_READOUT ${values.LB_TOURNEY_TRIGGER_READOUT ?? '0'}\n`,
  );
  return src;
}

test('checkDevSwitches: all zero passes, any non-zero or missing define refuses', () => {
  const d = tmp();
  assert.doesNotThrow(() => checkDevSwitches(fakeMeleeSrc(d)));
  throwsTool(
    () => checkDevSwitches(fakeMeleeSrc(tmp(), { LB_TOURNEY_DEMO_CLAIM: '1' })),
    /LB_TOURNEY_DEMO_CLAIM is 1 in lb\/lbtourney.c: set it to 0/,
  );
  const e = tmp();
  fakeMeleeSrc(e);
  writeFileSync(join(e, 'melee', 'mn', 'mntourney.c'), '// nothing\n');
  throwsTool(() => checkDevSwitches(join(e, 'melee')), /could not find #define TM_DEMO_AUTOSTART/);
  throwsTool(() => checkDevSwitches(join(e, 'nowhere')), /could not find mn\/mntourney.c/);
});

// ---------- card finders (parsers only)
test('card parsers: Windows Get-Volume JSON (one object or an array), lsblk, diskutil', () => {
  assert.deepEqual(parseWindowsVolumes('{"DriveLetter":"F","FileSystemLabel":"WII"}'), [
    { root: 'F:\\', label: 'WII' },
  ]);
  assert.deepEqual(
    parseWindowsVolumes(
      '[{"DriveLetter":"E","FileSystemLabel":""},{"DriveLetter":"F","FileSystemLabel":"X"}]',
    ).map((v) => v.root),
    ['E:\\', 'F:\\'],
  );
  assert.deepEqual(parseWindowsVolumes('  '), []);
  const lsblk = JSON.stringify({
    blockdevices: [
      {
        name: 'sda',
        path: '/dev/sda',
        rm: false,
        hotplug: false,
        fstype: null,
        mountpoint: null,
        children: [
          {
            name: 'sda1',
            path: '/dev/sda1',
            fstype: 'ext4',
            mountpoint: '/',
            rm: false,
            hotplug: false,
          },
        ],
      },
      {
        name: 'sdb',
        path: '/dev/sdb',
        rm: true,
        hotplug: true,
        fstype: null,
        mountpoint: null,
        children: [
          {
            name: 'sdb1',
            path: '/dev/sdb1',
            fstype: 'vfat',
            mountpoint: '/media/me/WII',
            label: 'WII',
            rm: '1',
          },
        ],
      },
    ],
  });
  assert.deepEqual(parseLsblk(lsblk), [
    { root: '/media/me/WII', label: 'WII', device: '/dev/sdb1' },
  ]);
  const du = parseDiskutilInfo(
    '   Device Identifier:         disk4s1\n   Device Node:               /dev/disk4s1\n   Volume Name:               WII\n   File System Personality:   MS-DOS FAT32\n   Removable Media:           Removable\n   Ejectable:                 Yes\n',
  );
  assert.deepEqual(du, { fat32: true, removable: true, device: '/dev/disk4s1', label: 'WII' });
  assert.equal(
    parseDiskutilInfo('   File System Personality:   APFS\n   Removable Media:           Fixed\n')
      .fat32,
    false,
  );
});

// ---------- CI loader cache
function fakeGh(artifactFiles: Record<string, string>, calls: string[][] = []): Runner {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'gh') return { status: 127, stdout: '', stderr: `${cmd}: not faked` };
    if (args[1] === 'list')
      return {
        status: 0,
        stdout: JSON.stringify([
          { databaseId: 123, headSha: 'abcdef0123456789', createdAt: '2026-10-01T00:00:00Z' },
        ]),
        stderr: '',
      };
    if (args[1] === 'download') {
      const dir = args[args.indexOf('-D') + 1];
      for (const [rel, content] of Object.entries(artifactFiles)) {
        mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true });
        writeFileSync(join(dir, ...rel.split('/')), content);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected gh call' };
  };
}

test('newestLoaderBuild downloads once per commit into deploy/.cache and reuses it', () => {
  const cache = tmp();
  const calls: string[][] = [];
  const run = fakeGh({ 'release-x/apps/LazyTO/boot.dol': 'DOL' }, calls);
  const b1 = newestLoaderBuild({ repo: 'o/Nintendont', branch: 'LazyTO', cacheDir: cache, run });
  assert.equal(b1.sha, 'abcdef0');
  assert.equal(b1.runId, 123);
  assert.equal(readFileSync(join(b1.dir, 'done'), 'utf8'), '123\n');
  const b2 = newestLoaderBuild({ repo: 'o/Nintendont', branch: 'LazyTO', cacheDir: cache, run });
  assert.equal(b2.dir, b1.dir);
  assert.equal(calls.filter((c) => c[2] === 'download').length, 1, 'second call served from cache');
  assert.equal(
    calls[0].slice(0, 4).join(' '),
    'gh run list -R',
    'asks gh for the newest successful run',
  );
  assert.ok(calls[0].includes('--branch') && calls[0].includes('LazyTO'));
});

test('newestLoaderBuild: gh failures and an empty run list are clear errors', () => {
  const failing: Runner = () => ({ status: 1, stdout: '', stderr: 'not logged in' });
  throwsTool(
    () => newestLoaderBuild({ repo: 'o/N', branch: 'b', cacheDir: tmp(), run: failing }),
    /gh run list failed: not logged in/,
  );
  const empty: Runner = () => ({ status: 0, stdout: '[]', stderr: '' });
  throwsTool(
    () => newestLoaderBuild({ repo: 'o/N', branch: 'b', cacheDir: tmp(), run: empty }),
    /no successful CI build of o\/N b yet/,
  );
});

// ---------- sync-card end to end on a folder
function fakeCard(root: string, opts: { cfg?: string; nincfg?: boolean } = {}): string {
  const card = join(root, 'card');
  mkdirSync(join(card, 'games', 'Super Smash Bros. Melee GALE01'), { recursive: true });
  writeFileSync(join(card, 'games', 'Super Smash Bros. Melee GALE01', 'game.iso'), 'iso');
  if (opts.cfg !== undefined) writeFileSync(join(card, 'tournament.cfg'), opts.cfg);
  if (opts.nincfg)
    writeFileSync(
      join(card, 'slippi_nincfg.bin'),
      Uint8Array.from([...be32(NIN_CFG_MAGIC), ...be32(0xe), ...be32(0), 0, 0, 0, 0]),
    );
  return card;
}

function syncOpts(
  root: string,
  over: Partial<Parameters<typeof syncCard>[0]> = {},
): Parameters<typeof syncCard>[0] {
  const module = join(root, 'tournament.bin');
  writeFileSync(module, Buffer.concat([Buffer.from('TMOD'), Buffer.alloc(60, 1)]));
  writeFileSync(join(root, '.env'), 'RELAY_SECRET=venue-secret1\n');
  return {
    station: -1,
    stream: -1,
    drive: join(root, 'card'),
    relayConfig: '',
    module,
    meleeSrc: fakeMeleeSrc(root),
    repo: 'o/Nintendont',
    branch: 'LazyTO',
    cacheDir: join(root, 'cache'),
    envFile: join(root, '.env'),
    eject: false,
    log: true,
    ...over,
  };
}

const ARTIFACT = {
  'release-x/apps/LazyTO/boot.dol': 'DOL-BYTES',
  'release-x/apps/LazyTO/icon.png': 'PNG',
  'release-x/apps/LazyTO/meta.xml': '<app/>',
};

test('sync-card: fresh card needs --station; then writes loader, module, cfg, patches the loader config, verifies', () => {
  const root = tmp();
  const card = fakeCard(root, { nincfg: true });
  const lines: string[] = [];
  const deps = { run: fakeGh(ARTIFACT), out: (l: string) => lines.push(l) };
  throwsTool(() => syncCard(syncOpts(root), deps), /no tournament.cfg yet: pass --station N/);
  const r = syncCard(syncOpts(root, { station: 2, stream: 1 }), deps);
  assert.deepEqual(r.loaderFiles, ['boot.dol', 'icon.png', 'meta.xml']);
  assert.equal(readFileSync(join(card, 'apps', 'LazyTO', 'boot.dol'), 'utf8'), 'DOL-BYTES');
  assert.equal(readFileSync(join(card, 'tournament.bin')).subarray(0, 4).toString(), 'TMOD');
  assert.equal(
    readFileSync(join(card, 'tournament.cfg'), 'utf8'),
    'station=2\nstream=1\nsecret=venue-secret1\n',
  );
  assert.deepEqual(
    [...readFileSync(join(card, 'slippi_nincfg.bin')).subarray(8, 12)],
    be32(NIN_CFG_NETWORK | NIN_CFG_AUTO_BOOT | NIN_CFG_LOG),
  );
  assert.ok(
    r.checks.every((c) => c.ok),
    JSON.stringify(r.checks),
  );
  assert.equal(r.ejected, null);
  assert.equal(r.secretFrom, '.env RELAY_SECRET (venue relay)');
  assert.ok(
    lines.some((l) => l.includes('Melee image: ') && l.includes('game.iso')),
    'reports the Melee image',
  );
  assert.ok(lines.some((l) => /^loader : CI build 123 \(commit abcdef0/.test(l)));
  assert.ok(lines.some((l) => /^module : 64 bytes, md5 [0-9A-F]{32}$/.test(l)));
  assert.ok(
    lines.some(
      (l) => l === 'config : station=2 stream=1 secret from .env RELAY_SECRET (venue relay)',
    ),
  );
  assert.ok(
    lines.some((l) =>
      l.includes('loader config 00000000 -> 00002500: network on, auto boot on, log on'),
    ),
  );
  assert.ok(!lines.some((l) => l.includes('venue-secret1')), 'the secret is never printed');
});

test('sync-card: a synced card keeps its station/stream; --relay-config supplies the secret; --no-log leaves Log alone', () => {
  const root = tmp();
  const card = fakeCard(root, { cfg: 'station=4\nstream=0\nsecret=oldsecret1\n', nincfg: true });
  writeFileSync(join(root, 'dev.json'), JSON.stringify({ secret: 'kioskdev2026', tcpPort: 1 }));
  const deps = { run: fakeGh(ARTIFACT), out: () => {} };
  const r = syncCard(syncOpts(root, { relayConfig: join(root, 'dev.json'), log: false }), deps);
  assert.equal(r.station, 4);
  assert.equal(r.stream, 0);
  assert.equal(r.secretFrom, 'relay config dev.json');
  assert.equal(
    readFileSync(join(card, 'tournament.cfg'), 'utf8'),
    'station=4\nstream=0\nsecret=kioskdev2026\n',
  );
  assert.deepEqual(
    [...readFileSync(join(card, 'slippi_nincfg.bin')).subarray(8, 12)],
    be32(NIN_CFG_NETWORK | NIN_CFG_AUTO_BOOT),
  );
});

test('sync-card refuses: bad secret, non-TMOD module, missing module, dev switch on, missing drive', () => {
  const root = tmp();
  fakeCard(root, { cfg: 'station=1\n' });
  const deps = { run: fakeGh(ARTIFACT), out: () => {} };
  const bad = syncOpts(root);
  writeFileSync(bad.envFile, 'RELAY_SECRET=short\n');
  throwsTool(() => syncCard(bad, deps), /no valid secret from \.env RELAY_SECRET/);
  const o = syncOpts(root);
  writeFileSync(o.module, 'not a module at all');
  throwsTool(() => syncCard(o, deps), /is not a TMOD module/);
  throwsTool(
    () => syncCard(syncOpts(root, { module: join(root, 'missing.bin') }), deps),
    /module not found: .*build it: python kiosk\/tools\/build_module.py/,
  );
  throwsTool(
    () =>
      syncCard(syncOpts(root, { meleeSrc: fakeMeleeSrc(tmp(), { TM_DEMO_AUTOSTART: '1' }) }), deps),
    /TM_DEMO_AUTOSTART is 1/,
  );
  throwsTool(() => syncCard(syncOpts(root, { drive: join(root, 'nope') }), deps), /is not ready/);
});

test('sync-card warns when kiosk sources are newer than the module, and when the artifact lacks apps/LazyTO', () => {
  const root = tmp();
  fakeCard(root, { cfg: 'station=1\n' });
  const o = syncOpts(root);
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(o.meleeSrc, 'lb', 'lbtourney.c'), future, future);
  const lines: string[] = [];
  syncCard(o, { run: fakeGh(ARTIFACT), out: (l) => lines.push(l) });
  assert.ok(
    lines.some((l) => /module source is newer than tournament\.bin \([^)]*lbtourney\.c/.test(l)),
    lines.join(' | '),
  );
  assert.ok(
    lines.some((l) => l.includes('Melee image: games')),
    'image path shown relative to the card root',
  );
  const root2 = tmp();
  fakeCard(root2);
  throwsTool(
    () =>
      syncCard(syncOpts(root2, { station: 1 }), {
        run: fakeGh({ 'release-x/apps/Nintendont/boot.dol': 'x' }),
        out: () => {},
      }),
    /no apps\/LazyTO folder/,
  );
});

// ---------- push: config from .env and the dry run
const ENV = {
  STARTGG_TOKEN: 'tok-1234567',
  RELAY_SECRET: 'venue-secret1',
  TOURNAMENT: 'lazyto-weekly',
  WEEKLY_NAME_PREFIX: 'LazyTO Weekly #',
  EVENT_NAME: 'Melee Singles',
  STREAM_NAME: 'LazyTOStream',
  TEST_TOURNAMENT: 'tournament/lazyto-test',
};
const PO = { test: false, tcpPort: 29470, httpPort: 29473 };

test('relayConfigFromEnv: production vs --test, defaults, and the same errors push.ps1 gave', () => {
  const prod = relayConfigFromEnv(ENV, PO);
  assert.deepEqual(prod, {
    startggEndpoint: 'https://api.start.gg/gql/alpha',
    token: 'tok-1234567',
    tournament: 'lazyto-weekly',
    eventName: 'Melee Singles',
    streamName: 'LazyTOStream',
    weeklyNamePrefix: 'LazyTO Weekly #',
    secret: 'venue-secret1',
    streamStation: 1,
    setFormat: 'startgg',
    tcpPort: 29470,
    httpPort: 29473,
    auditDir: '/var/lib/lazyto',
  });
  const t = relayConfigFromEnv(
    { ...ENV, STREAM_STATION: '3', SET_FORMAT: 'top8q' },
    { ...PO, test: true },
  );
  assert.equal(t.tournament, 'tournament/lazyto-test');
  assert.equal(t.weeklyNamePrefix, '', 'no weekly fallback for a test slug');
  assert.equal(t.streamStation, 3);
  assert.equal(t.setFormat, 'top8q');
  assert.equal(
    relayConfigFromEnv({ ...ENV, TOURNAMENT: 'tournament/full-slug' }, PO).weeklyNamePrefix,
    '',
    'a full slug needs no prefix',
  );
  assert.equal(
    describeRelayConfig(t, { ...PO, test: true }),
    "config: tournament/lazyto-test (TEST), event ~ 'Melee Singles', stream 'LazyTOStream', stream station 3, format top8q, tcp 29470, http 29473, token tok-...",
  );
  throwsTool(
    () => relayConfigFromEnv({ ...ENV, STARTGG_TOKEN: '' }, PO),
    /STARTGG_TOKEN missing from \.env/,
  );
  throwsTool(
    () => relayConfigFromEnv({ ...ENV, RELAY_SECRET: 'bad secret!' }, PO),
    /RELAY_SECRET in \.env must be 8-16 letters/,
  );
  throwsTool(
    () => relayConfigFromEnv({ ...ENV, EVENT_NAME: '' }, PO),
    /EVENT_NAME missing from \.env \(see \.env\.example\)/,
  );
  throwsTool(
    () => relayConfigFromEnv({ ...ENV, SET_FORMAT: 'bo5' }, PO),
    /SET_FORMAT in \.env must be startgg or top8q, not 'bo5'/,
  );
  throwsTool(
    () => relayConfigFromEnv({ ...ENV, TEST_TOURNAMENT: 'lazyto-test' }, { ...PO, test: true }),
    /TEST_TOURNAMENT must be a full slug/,
  );
  throwsTool(
    () => relayConfigFromEnv({ ...ENV, TOURNAMENT: '' }, PO),
    /TOURNAMENT missing from \.env/,
  );
  throwsTool(
    () => relayConfigFromEnv({ ...ENV, STREAM_STATION: 'x' }, PO),
    /STREAM_STATION in \.env must be a station number/,
  );
});

test('remoteInstallCommand: install.sh then the auto-update marker', () => {
  assert.match(
    remoteInstallCommand(false),
    /sudo bash \/tmp\/tr\/deploy\/install.sh \/tmp\/tr && sudo rm -f \/etc\/lazyto\/no-auto-update && rm -rf/,
  );
  assert.match(remoteInstallCommand(true), /&& sudo touch \/etc\/lazyto\/no-auto-update &&/);
});

test('push --dry-run stages dist, deploy (no .cache), package.json, README and config.json, tars it, never calls ssh', () => {
  const repo = tmp();
  mkdirSync(join(repo, 'dist', 'src'), { recursive: true });
  writeFileSync(join(repo, 'dist', 'main.js'), 'main');
  writeFileSync(join(repo, 'dist', 'src', 'x.js'), 'x');
  mkdirSync(join(repo, 'deploy', '.cache', 'loader-abc'), { recursive: true });
  writeFileSync(join(repo, 'deploy', 'install.sh'), 'sh');
  writeFileSync(join(repo, 'deploy', '.cache', 'loader-abc', 'big'), 'no');
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}');
  writeFileSync(join(repo, 'README.md'), 'r');
  const calls: string[][] = [];
  const run: Runner = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tar') {
      assert.ok(
        !/^[A-Za-z]:/.test(args[1]),
        'tar gets a relative archive path (GNU tar reads C: as a host)',
      );
      writeFileSync(join(opts?.cwd ?? '.', args[1]), 'tgz');
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'not expected' };
  };
  const lines: string[] = [];
  const out = tmp();
  const r = pushRelay(
    repo,
    ENV,
    {
      ...PO,
      piHost: 'relay.local',
      user: 'pi',
      dryRun: true,
      noAutoUpdate: false,
      skipBuild: true,
    },
    { run, out: (l) => lines.push(l), tmp: out },
  );
  assert.equal(r.stage, join(out, 'lazyto-bundle'));
  assert.equal(readFileSync(join(r.stage, 'dist', 'src', 'x.js'), 'utf8'), 'x');
  assert.equal(readFileSync(join(r.stage, 'deploy', 'install.sh'), 'utf8'), 'sh');
  assert.throws(
    () => readFileSync(join(r.stage, 'deploy', '.cache', 'loader-abc', 'big')),
    'the loader cache is not shipped',
  );
  const cfg = JSON.parse(readFileSync(join(r.stage, 'config.json'), 'utf8'));
  assert.equal(cfg.token, 'tok-1234567');
  assert.equal(cfg.setFormat, 'startgg');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['tar'],
    'dry run: tar only, no scp/ssh/npm',
  );
  assert.ok(lines.includes('dry run: not pushing'));
  assert.ok(
    lines.some((l) => l.startsWith("config: lazyto-weekly (production), event ~ 'Melee Singles'")),
  );
  assert.ok(!lines.some((l) => l.includes('tok-1234567')), 'full token never printed');
});

test('push: a failing scp or ssh is a clear error and the bundle is not deleted silently', () => {
  const repo = tmp();
  mkdirSync(join(repo, 'dist'));
  writeFileSync(join(repo, 'dist', 'main.js'), 'main');
  mkdirSync(join(repo, 'deploy'));
  writeFileSync(join(repo, 'package.json'), '{}');
  const run: Runner = (cmd) =>
    cmd === 'tar'
      ? { status: 0, stdout: '', stderr: '' }
      : cmd === 'scp'
        ? { status: 1, stdout: '', stderr: '' }
        : { status: 0, stdout: '', stderr: '' };
  throwsTool(
    () =>
      pushRelay(
        repo,
        ENV,
        {
          ...PO,
          piHost: 'relay.local',
          user: 'pi',
          dryRun: false,
          noAutoUpdate: false,
          skipBuild: true,
        },
        { run, out: () => {}, tmp: tmp() },
      ),
    /scp to pi@relay.local failed/,
  );
});

// ---------- wiiload
test('wiiloadFrame: HAXX 0.5, args length, sizes, zlib payload that inflates back, file name argument', () => {
  const data = Buffer.alloc(10_000, 7);
  const f = parseWiiloadFrame(wiiloadFrame('boot.dol', data));
  assert.equal(f.fileName, 'boot.dol');
  assert.equal(f.length, 10_000);
  assert.ok(f.compressedLength < 10_000);
  assert.deepEqual(inflateSync(f.payload), data);
  assert.throws(() => parseWiiloadFrame(Buffer.from('nope')), /not a wiiload frame/);
});

test('sendWiiload streams one frame to the Homebrew Channel port and closes', async () => {
  const chunks: Buffer[] = [];
  const server = createServer((s) => s.on('data', (c) => chunks.push(c as Buffer)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const data = Buffer.from('a dol'.repeat(2000));
    await sendWiiload('127.0.0.1', 'boot.dol', data, { port });
    await new Promise((r) => setTimeout(r, 50));
    const f = parseWiiloadFrame(Buffer.concat(chunks));
    assert.equal(f.fileName, 'boot.dol');
    assert.deepEqual(inflateSync(f.payload), data);
  } finally {
    server.close();
  }
  await assert.rejects(
    sendWiiload('127.0.0.1', 'boot.dol', Buffer.from('x'), { port, timeoutMs: 500 }),
    /ECONNREFUSED|timeout/,
  );
});
