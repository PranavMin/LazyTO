import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.js';

const VALID = {
  startggEndpoint: 'https://api.start.gg/gql/alpha',
  token: 'tok-abc',
  eventId: 1613010,
  streamId: 1358079,
  streamStation: 1,
  tcpPort: 7777,
  httpPort: 8080,
  auditDir: '/var/lib/tournament-reporter',
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
    'missing field "eventId"',
    'missing field "streamId"',
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

test('non-integer eventId', () => {
  expectProblems(JSON.stringify({ ...VALID, eventId: '1613010' }), 'eventId must be a positive integer');
  expectProblems(JSON.stringify({ ...VALID, eventId: 1.5 }), 'eventId must be a positive integer');
});

test('zero streamId', () => {
  expectProblems(JSON.stringify({ ...VALID, streamId: 0 }), 'streamId must be a positive integer');
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

// deploy/config.example.json is the file install.sh copies to
// /etc/tournament-reporter/config.json. It must document exactly the fields
// config.ts validates, and its only placeholders are the three the TO has
// to fill in (token, eventId, streamId); everything else must pass as-is.
test('deploy/config.example.json matches the validated fields', () => {
  const examplePath = join(import.meta.dirname, '..', 'deploy', 'config.example.json');
  const example = JSON.parse(readFileSync(examplePath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(example).sort(), Object.keys(VALID).sort());
  assert.equal(example.token, 'REPLACE_ME');
  try {
    loadConfig(examplePath);
    assert.fail('the unedited example must not load (eventId/streamId are placeholders)');
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected ConfigError, got ${e}`);
    assert.deepEqual(e.problems, ['eventId must be a positive integer', 'streamId must be a positive integer']);
  }
  // With the three placeholders filled in, the example is a complete config.
  const filled = { ...example, token: 'tok', eventId: 1613010, streamId: 1358079 };
  assert.deepEqual(loadConfig(writeConfig(JSON.stringify(filled))), filled);
});
