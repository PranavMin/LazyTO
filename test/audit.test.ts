// audit.ts tests, including the last section 8 row: a relay restart
// rebuilds the station map by replaying the audit log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayStatus } from '../generated/wire.js';
import { AuditLog, auditPath, replayClaims } from '../src/audit.js';
import { RelayTcpServer } from '../src/tcp.js';
import { SetCache } from '../src/cache.js';
import { StationState } from '../src/state.js';
import { StartggClient } from '../src/startgg.js';
import { makeFake, FIXTURE_TOKEN, FIXTURE_EVENT_ID } from './fake-startgg.js';
import { WiiClient, game } from './wii-client.js';

let dir: string;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), 'tr-audit-'));
});
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('auditPath names the log after the event', () => {
  assert.match(auditPath('/var/lib/tr', 1613010), /1613010\.jsonl$/);
});

test('record appends one timestamped JSON line per event', () => {
  const path = join(dir, 'basic.jsonl');
  const log = new AuditLog(path);
  log.record({ type: 'request', station: 3, cmd: 'CMD_LIST_SETS' });
  log.record({ type: 'response', station: 3, status: 'ST_OK' });
  log.close();

  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]!);
  assert.equal(first.type, 'request');
  assert.ok(!Number.isNaN(Date.parse(first.ts)), 'ts is a parseable timestamp');
});

test('replayClaims on a missing file is an empty map', () => {
  assert.equal(replayClaims(join(dir, 'nope.jsonl')).size, 0);
});

test('replayClaims tolerates a torn final line but not a corrupt middle line', () => {
  const torn = join(dir, 'torn.jsonl');
  writeFileSync(
    torn,
    JSON.stringify({ type: 'claim', station: 3, setId: 1, p1Id: 10, p2Id: 20, bestOf: 3, games: [] }) +
      '\n{"type":"resp',
  );
  assert.equal(replayClaims(torn).get(3)!.setId, 1);

  const corrupt = join(dir, 'corrupt.jsonl');
  writeFileSync(corrupt, '{"broken\n' + JSON.stringify({ type: 'release', station: 3 }) + '\n');
  assert.throws(() => replayClaims(corrupt), /corrupt audit line 1/);
});

test('relay restart rebuilds claims from the audit log (section 8 last row)', async (t) => {
  const fake = makeFake();
  await fake.start();
  t.after(() => fake.close());
  const startgg = new StartggClient({ endpoint: fake.url, token: FIXTURE_TOKEN, retryDelaysMs: [0, 0] });
  const path = auditPath(dir, FIXTURE_EVENT_ID);

  const SET_A = 107949994; // station 3: in progress at 2-0 when the relay dies
  const SET_B = 107949995; // station 4: completed before the relay dies

  // ---- first relay process ----
  {
    const cache = new SetCache(startgg, FIXTURE_EVENT_ID);
    await cache.refresh();
    const state = new StationState();
    const audit = new AuditLog(path);
    const server = new RelayTcpServer({ cache, state, startgg, audit, streamStation: 1, streamId: 1358079 });
    await server.listen(0, '127.0.0.1');
    const port = server.address().port;

    const wii3 = new WiiClient(port, 3);
    await wii3.startSet(SET_A);
    await wii3.reportScore(SET_A, [game(1), game(1)]);
    const wii4 = new WiiClient(port, 4);
    await wii4.startSet(SET_B);
    await wii4.endSet(SET_B, [game(2), game(2)]);

    await server.close();
    audit.close();
  }

  // ---- restarted relay process: fresh state, same audit file ----
  const claims = replayClaims(path);
  assert.equal(claims.size, 1, 'only the unfinished set survives replay');
  const claim = claims.get(3)!;
  assert.equal(claim.setId, SET_A);
  assert.equal(claim.games.length, 2);
  assert.equal(claim.games[0]!.winner_slot, 1);

  {
    const cache = new SetCache(startgg, FIXTURE_EVENT_ID);
    await cache.refresh();
    const state = new StationState();
    for (const [station, c] of claims) if (cache.get(c.setId)) state.claim(station, c);

    const audit = new AuditLog(path);
    const server = new RelayTcpServer({ cache, state, startgg, audit, streamStation: 1, streamId: 1358079 });
    await server.listen(0, '127.0.0.1');
    const port = server.address().port;
    const wii3 = new WiiClient(port, 3);

    // Station 3 continues its set as if nothing happened.
    const { sets } = await wii3.listSets();
    assert.equal(sets[0]!.set_id, SET_A);
    assert.equal(sets[0]!.state, 1);
    const finish = await wii3.endSet(SET_A, [game(1), game(1)]);
    assert.equal(finish.resp.status, RelayStatus.ST_OK);
    assert.equal(fake.getSet(SET_A).state, 3);

    await server.close();
    audit.close();
  }
});

test('a replayed claim whose set is gone from the cache is dropped by the boot filter', async (t) => {
  const fake = makeFake();
  await fake.start();
  t.after(() => fake.close());
  const startgg = new StartggClient({ endpoint: fake.url, token: FIXTURE_TOKEN, retryDelaysMs: [0, 0] });

  const path = join(dir, 'stale.jsonl');
  appendFileSync(
    path,
    JSON.stringify({ type: 'claim', station: 5, setId: 999999, p1Id: 1, p2Id: 2, bestOf: 3, games: [] }) + '\n',
  );

  const cache = new SetCache(startgg, FIXTURE_EVENT_ID);
  await cache.refresh();
  const state = new StationState();
  for (const [station, c] of replayClaims(path)) if (cache.get(c.setId)) state.claim(station, c);
  assert.equal(state.get(5), undefined);
});
