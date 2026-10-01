import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.js';

const VALID = {
  startggEndpoint: 'https://api.start.gg/gql/alpha',
  token: 'tok-abc',
  tournament: 'tournament/sf-melee-discord-test',
  eventName: 'Melee Singles',
  streamName: 'SFMelee',
  weeklyNamePrefix: '',
  secret: 'abcd-EFGH_1234xy',
  streamStation: 1,
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

function expectProblems(contents: string, ...substrings: string[]): void {
  const path = writeConfig(contents);
  try {
    loadConfig(path);
    assert.fail('expected ConfigError');
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected ConfigError, got ${e}`);
    for (const s of substrings) {
      assert.ok(
        e.problems.some((p) => p.includes(s)),
        `expected a problem containing "${s}", got: ${JSON.stringify(e.problems)}`,
      );
    }
  }
}

test('valid config loads with every field intact', () => {
  const cfg = loadConfig(writeConfig(JSON.stringify(VALID)));
  assert.deepEqual(cfg, VALID);
});

test('missing file', () => {
  try {
    loadConfig(join(dir, 'does-not-exist.json'));
    assert.fail('expected ConfigError');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.ok(e.problems[0]!.includes('cannot read'));
  }
});

test('invalid JSON', () => {
  expectProblems('{ not json', 'not valid JSON');
});

test('non-object JSON', () => {
  expectProblems('[1,2,3]', 'must be a JSON object');
});

test('every missing field is reported at once', () => {
  expectProblems(
    '{}',
    'missing field "startggEndpoint"',
    'missing field "token"',
    'missing field "tournament"',
    'missing field "eventName"',
    'missing field "streamName"',
    'missing field "secret"',
    'missing field "streamStation"',
    'missing field "tcpPort"',
    'missing field "httpPort"',
    'missing field "auditDir"',
  );
});

test('unknown field is rejected', () => {
  expectProblems(JSON.stringify({ ...VALID, extra: 1 }), 'unknown field "extra"');
});

test('startggEndpoint must be an http(s) URL', () => {
  expectProblems(JSON.stringify({ ...VALID, startggEndpoint: '' }), 'startggEndpoint must be an http(s) URL');
  expectProblems(JSON.stringify({ ...VALID, startggEndpoint: 'api.start.gg/gql/alpha' }), 'startggEndpoint must be an http(s) URL');
  expectProblems(JSON.stringify({ ...VALID, startggEndpoint: 'ftp://api.start.gg/gql/alpha' }), 'startggEndpoint must be an http(s) URL');
  expectProblems(JSON.stringify({ ...VALID, startggEndpoint: 7 }), 'startggEndpoint must be an http(s) URL');
});

test('empty token', () => {
  expectProblems(JSON.stringify({ ...VALID, token: '' }), 'token must be a non-empty string');
});

test('tournament is a short URL or a full tournament slug, nothing else', () => {
  assert.equal(loadConfig(writeConfig(JSON.stringify({ ...VALID, tournament: 'abbey' }))).tournament, 'abbey');
  for (const bad of ['', 'https://start.gg/abbey', 'tournament/x/event/melee-singles', 'start.gg/abbey', 905882]) {
    expectProblems(JSON.stringify({ ...VALID, tournament: bad }), 'tournament must be a start.gg short URL');
  }
});

test('weeklyNamePrefix: a string, "" for none, and only with a short URL', () => {
  const withShort = { ...VALID, tournament: 'abbey', weeklyNamePrefix: 'Melee @ Abbey Tavern #' };
  assert.equal(loadConfig(writeConfig(JSON.stringify(withShort))).weeklyNamePrefix, 'Melee @ Abbey Tavern #');
  assert.equal(loadConfig(writeConfig(JSON.stringify({ ...VALID, tournament: 'abbey' }))).weeklyNamePrefix, '');
  expectProblems(JSON.stringify({ ...VALID, weeklyNamePrefix: 3 }), 'weeklyNamePrefix must be a string');
  expectProblems(JSON.stringify({ ...VALID, weeklyNamePrefix: 'Weekly #' }), 'weeklyNamePrefix only applies to a short URL');
});

test('secret is 8-16 letters, digits, - or _', () => {
  assert.equal(loadConfig(writeConfig(JSON.stringify({ ...VALID, secret: 'abcdefgh' }))).secret, 'abcdefgh');
  for (const bad of ['short', 'x'.repeat(17), 'has space here', 'semi;colon', 'equals=sign', 1234567890]) {
    expectProblems(JSON.stringify({ ...VALID, secret: bad }), 'secret must be 8-16 letters');
  }
});

test('eventName and streamName must be non-empty', () => {
  expectProblems(JSON.stringify({ ...VALID, eventName: '  ' }), 'eventName must be a non-empty string');
  expectProblems(JSON.stringify({ ...VALID, streamName: 1358079 }), 'streamName must be a non-empty string');
});

test('streamStation out of u16 range', () => {
  expectProblems(JSON.stringify({ ...VALID, streamStation: 65536 }), 'streamStation must be an integer in 1..65535');
  expectProblems(JSON.stringify({ ...VALID, streamStation: 0 }), 'streamStation must be an integer in 1..65535');
});

test('port out of range', () => {
  expectProblems(JSON.stringify({ ...VALID, tcpPort: 0 }), 'tcpPort must be an integer in 1..65535');
  expectProblems(JSON.stringify({ ...VALID, httpPort: 70000 }), 'httpPort must be an integer in 1..65535');
});

test('tcpPort and httpPort must differ', () => {
  expectProblems(JSON.stringify({ ...VALID, httpPort: VALID.tcpPort }), 'tcpPort and httpPort must differ');
});

test('empty auditDir', () => {
  expectProblems(JSON.stringify({ ...VALID, auditDir: '' }), 'auditDir must be a non-empty string');
});

// deploy/push.ps1 is what writes /etc/lazyto/config.json on the
// Pi (from .env). Its $config block must name exactly the fields config.ts
// validates, or the first push after a config change fails on the Pi instead
// of here.
test('deploy/push.ps1 writes exactly the validated fields', () => {
  const script = readFileSync(join(import.meta.dirname, '..', 'deploy', 'push.ps1'), 'utf8');
  const block = /\$config = \[ordered\]@\{([^}]*)\}/.exec(script);
  assert.ok(block, 'push.ps1 has no $config = [ordered]@{ ... } block');
  const written = [...block[1].matchAll(/^\s*([A-Za-z]+)\s*=/gm)].map((m) => m[1]);
  assert.deepEqual(written.sort(), Object.keys(VALID).sort());
});
