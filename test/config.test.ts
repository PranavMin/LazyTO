import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultDataDir,
  loadConfig,
  newSecret,
  parseConfig,
  saveConfig,
  weeklyPrefixFrom,
  type Config,
} from '../src/config.js';

const VALID: Config = {
  token: 'tok-abc',
  tournament: 'tournament/lazyto-test',
  eventName: 'Melee Singles',
  secret: 'abcd-EFGH_1234xy',
  adminPassword: 'to-pass-9876',
  weeklyNamePrefix: '',
  streamName: 'LazyTOStream',
  streamStation: 1,
  setFormat: 'top8q',
  archiveDir: '',
};

// A settings file as the relay before config v2 wrote it (the shape a Pi set
// up with the old npm run push had on 2026-10-02, fake values). Every later build must
// keep accepting it: auto-update installs a build only if it does.
const V1_FILE = {
  startggEndpoint: 'https://api.start.gg/gql/alpha',
  token: 'tok-abc',
  tournament: 'lazyto-weekly',
  eventName: 'Melee Singles',
  streamName: 'LazyTOStream',
  weeklyNamePrefix: 'LazyTO Weekly #',
  secret: 'abcd-EFGH_1234xy',
  adminPassword: 'to-pass-9876',
  streamStation: 1,
  setFormat: 'top8q',
  tcpPort: 29470,
  httpPort: 29473,
  auditDir: '/var/lib/lazyto',
};

let dir: string;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), 'tr-config-'));
});
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function writeConfig(contents: string): string {
  const path = join(dir, `config-${n++}.json`);
  writeFileSync(path, contents);
  return path;
}

function problemsOf(value: unknown): string[] {
  const r = parseConfig(value);
  assert.ok(!r.ok, `expected problems, got a valid config`);
  return r.problems;
}

function expectProblems(value: unknown, ...substrings: string[]): void {
  const problems = problemsOf(value);
  for (const s of substrings) {
    assert.ok(
      problems.some((p) => p.includes(s)),
      `expected a problem containing "${s}", got: ${JSON.stringify(problems)}`,
    );
  }
}

function valid(value: unknown): Config {
  const r = parseConfig(value);
  assert.ok(r.ok, `expected valid, got ${JSON.stringify(r)}`);
  return r.config;
}

test('a valid file loads with every field intact', () => {
  const r = loadConfig(writeConfig(JSON.stringify(VALID)));
  assert.deepEqual(r, { kind: 'ok', config: VALID, ignored: [] });
});

test('a missing file is "missing", not an error: the relay starts in setup mode', () => {
  assert.deepEqual(loadConfig(join(dir, 'does-not-exist.json')), { kind: 'missing' });
});

test('broken JSON and a non-object are invalid', () => {
  const broken = loadConfig(writeConfig('{ not json'));
  assert.equal(broken.kind, 'invalid');
  assert.match(JSON.stringify(broken), /not valid JSON/);
  expectProblems([1, 2, 3], 'must hold a JSON object');
});

test('every missing required field is reported at once', () => {
  expectProblems(
    {},
    'missing field "token"',
    'missing field "tournament"',
    'missing field "eventName"',
    'missing field "secret"',
    'missing field "adminPassword"',
  );
  assert.equal(problemsOf({}).length, 5, 'optional fields are never "missing"');
});

test('optional fields take their defaults', () => {
  const { token, tournament, eventName, secret, adminPassword } = VALID;
  assert.deepEqual(valid({ token, tournament, eventName, secret, adminPassword }), {
    token,
    tournament,
    eventName,
    secret,
    adminPassword,
    weeklyNamePrefix: '',
    streamName: '',
    streamStation: 1,
    setFormat: 'startgg',
    archiveDir: '',
  });
});

test("the archive's old file-name templates load, ignored: the zips are named as Replay Reporter names them", () => {
  const r = parseConfig({
    ...VALID,
    archiveSetName: '{tournament} - {round_short} - {p1} vs {p2}',
    archiveGameName: 'Game {game} - {p1} ({p1_char}) vs {p2} ({p2_char}) - {stage}',
  });
  assert.ok(r.ok);
  assert.deepEqual(r.ignored.sort(), ['archiveGameName', 'archiveSetName']);
  assert.deepEqual(r.config, VALID);
});

test('unknown fields are ignored and reported, never fatal', () => {
  const r = parseConfig({ ...VALID, extra: 1, another: 'x' });
  assert.ok(r.ok);
  assert.deepEqual(r.ignored.sort(), ['another', 'extra']);
  assert.deepEqual(r.config, VALID);
});

test('a settings file from before config v2 still loads', () => {
  const r = loadConfig(writeConfig(JSON.stringify(V1_FILE)));
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.config.tournament, 'lazyto-weekly');
  assert.equal(r.config.weeklyNamePrefix, 'LazyTO Weekly #');
  assert.deepEqual(r.ignored.sort(), ['auditDir', 'httpPort', 'startggEndpoint', 'tcpPort']);
});

test('tournament is a short URL or a full tournament slug, nothing else', () => {
  assert.equal(valid({ ...VALID, tournament: 'lazyto-weekly' }).tournament, 'lazyto-weekly');
  for (const bad of [
    '',
    'https://start.gg/lazyto-weekly',
    'tournament/x/event/melee-singles',
    'start.gg/lazyto-weekly',
    905882,
  ]) {
    expectProblems({ ...VALID, tournament: bad }, 'tournament must be a start.gg short URL');
  }
});

test('weeklyNamePrefix: a string, "" for none, and only with a short URL', () => {
  const withShort = { ...VALID, tournament: 'lazyto-weekly', weeklyNamePrefix: 'LazyTO Weekly #' };
  assert.equal(valid(withShort).weeklyNamePrefix, 'LazyTO Weekly #');
  expectProblems({ ...VALID, weeklyNamePrefix: 3 }, 'weeklyNamePrefix must be a string');
  expectProblems(
    { ...VALID, weeklyNamePrefix: 'Weekly #' },
    'weeklyNamePrefix only applies to a short URL',
  );
});

test('secret is 8-16 letters, digits, - or _', () => {
  assert.equal(valid({ ...VALID, secret: 'abcdefgh' }).secret, 'abcdefgh');
  for (const bad of [
    'short',
    'x'.repeat(17),
    'has space here',
    'semi;colon',
    'equals=sign',
    1234,
  ]) {
    expectProblems({ ...VALID, secret: bad }, 'secret must be 8-16 letters');
  }
});

test('eventName must be non-empty; streamName may be "" for no stream', () => {
  expectProblems({ ...VALID, eventName: '  ' }, 'eventName must be a non-empty string');
  expectProblems(
    { ...VALID, streamName: 1358079 },
    'streamName must be a string ("" for no stream)',
  );
  assert.equal(valid({ ...VALID, streamName: '' }).streamName, '');
});

test('adminPassword: printable, 8-64, not the secret', () => {
  for (const bad of ['short', 'has space in it', 'x'.repeat(65), 5]) {
    expectProblems(
      { ...VALID, adminPassword: bad },
      'adminPassword must be 8-64 printable characters, no spaces',
    );
  }
  expectProblems(
    { ...VALID, adminPassword: VALID.secret },
    'adminPassword must differ from secret (the secret is on every beamer)',
  );
});

test('setFormat and streamStation are checked', () => {
  expectProblems({ ...VALID, setFormat: 'bo5' }, 'setFormat must be one of "startgg", "top8q"');
  expectProblems(
    { ...VALID, streamStation: 65536 },
    'streamStation must be an integer in 1..65535',
  );
  expectProblems({ ...VALID, streamStation: 0 }, 'streamStation must be an integer in 1..65535');
});

test('saveConfig writes what loadConfig reads, readable by its owner only', () => {
  const path = join(dir, 'saved.json');
  saveConfig(path, VALID);
  assert.deepEqual(loadConfig(path), { kind: 'ok', config: VALID, ignored: [] });
  assert.ok(readFileSync(path, 'utf8').endsWith('\n'));
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('newSecret fits the secret rule and differs every time', () => {
  const a = newSecret();
  assert.match(a, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(a, newSecret());
  assert.equal(valid({ ...VALID, secret: a }).secret, a);
});

test('weeklyPrefixFrom strips the trailing number', () => {
  assert.equal(weeklyPrefixFrom('LazyTO Weekly #160'), 'LazyTO Weekly #');
  assert.equal(weeklyPrefixFrom('Melee @ Abbey Tavern #161'), 'Melee @ Abbey Tavern #');
  assert.equal(weeklyPrefixFrom('Smash Weekly 42'), 'Smash Weekly ');
  assert.equal(weeklyPrefixFrom('GENESIS: BLACK'), '');
  assert.equal(weeklyPrefixFrom('2026'), '');
});

test('archiveDir: "" for the default folder, or a full path on this machine', () => {
  const here = join(tmpdir(), 'LazyTO archive');
  assert.equal(valid({ ...VALID, archiveDir: here }).archiveDir, here);
  assert.equal(valid({ ...VALID, archiveDir: '' }).archiveDir, '');
  expectProblems({ ...VALID, archiveDir: 'LazyTO' }, 'archiveDir must be "" (the default folder)');
  expectProblems({ ...VALID, archiveDir: 3 }, 'archiveDir must be');
});

test("the data folder: the Pi's on Linux, the desktop app's elsewhere, LAZYTO_DIR first", () => {
  assert.equal(defaultDataDir('linux', {}, '/home/pi'), '/var/lib/lazyto');
  assert.equal(
    defaultDataDir('win32', { APPDATA: 'C:\\Users\\to\\AppData\\Roaming' }, 'C:\\Users\\to'),
    'C:\\Users\\to\\AppData\\Roaming\\LazyTO',
  );
  assert.equal(
    defaultDataDir('darwin', {}, '/Users/to'),
    '/Users/to/Library/Application Support/LazyTO',
  );
  assert.equal(defaultDataDir('darwin', { LAZYTO_DIR: '/tmp/x' }, '/Users/to'), '/tmp/x');
  assert.equal(defaultDataDir('linux', { LAZYTO_DIR: '/tmp/y' }, '/home/pi'), '/tmp/y');
});
