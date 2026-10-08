import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { parseSlp, withDisplayNames, displayNameBytes } from '../src/slp.js';
import { buildZip, crc32 } from '../src/zip.js';
import {
  fillName,
  safeFileName,
  tournamentNumber,
  unknownFields,
  SET_FIELDS,
} from '../src/names.js';
import { BeamerDirectory, stationNumber } from '../src/beamer.js';
import {
  SetArchive,
  hasRecord,
  fileStamp,
  replayStamp,
  type ArchiveEvent,
} from '../src/archive.js';
import type { CachedSet } from '../src/cache.js';
import type { GameResult } from '../generated/wire.js';
import { FakeBeamer, announceDatagram } from './fake-beamer.js';
import { makeSlp, displayNameAt } from './slp-fixture.js';
import { game } from './wii-client.js';

const FOX = 2;
const MARTH = 9;
const BF = 0x1f;
const FD = 0x20;

/** Read a zip back: name -> data, checking each CRC. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  const count = buf.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const data = inflateRawSync(
      buf.subarray(local + 30 + lNameLen + lExtra, local + 30 + lNameLen + lExtra + packed),
    );
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out.set(name, data);
    p += 46 + nameLen;
  }
  return out;
}

test('slp: ports, stage and length from a Wii-shaped replay; display names stamped', () => {
  const slp = makeSlp({
    stage: BF,
    ports: [{ character: FOX, costume: 1 }, null, { character: MARTH, costume: 0 }, null],
    lastFrame: 5000,
  });
  const info = parseSlp(slp);
  assert.deepEqual(info.version, [3, 13, 0]);
  assert.equal(info.stage, BF);
  assert.equal(info.lastFrame, 5000);
  assert.deepEqual(
    info.ports.map((p) => p.type),
    [0, 3, 0, 3],
  );
  assert.equal(info.ports[0]!.character, FOX);
  assert.equal(info.ports[0]!.costume, 1);

  const stamped = withDisplayNames(slp, ['Bravo', null, 'Alpha', null]);
  assert.equal(displayNameAt(stamped, 0), 'Bravo');
  assert.equal(displayNameAt(stamped, 2), 'Alpha');
  assert.equal(displayNameAt(stamped, 1), '');
  assert.equal(stamped.length, slp.length);
  assert.equal(displayNameAt(slp, 0), '', 'the original is untouched');
});

test('slp: punctuation goes full-width like Replay Reporter, non-ASCII becomes ?, 15 characters at most', () => {
  assert.deepEqual([...displayNameBytes('M2K!').subarray(0, 6)], [0x4d, 0x32, 0x4b, 0x81, 0x49, 0]);
  assert.deepEqual([...displayNameBytes('Zaín').subarray(0, 5)], [0x5a, 0x61, 0x3f, 0x6e, 0]);
  assert.equal(
    displayNameBytes('ABCDEFGHIJKLMNOPQRST').toString('latin1').split('\0')[0],
    'ABCDEFGHIJKLMNO',
  );
  assert.throws(() => parseSlp(Buffer.from('not a replay at all')), /not a .slp file/);
});

test('zip: entries come back intact with UTF-8 names', () => {
  const a = Buffer.from('hello '.repeat(1000));
  const b = makeSlp({
    stage: FD,
    ports: [{ character: FOX, costume: 0 }, { character: MARTH, costume: 0 }, null, null],
  });
  const files = unzip(
    buildZip([
      { name: 'context.json', data: a },
      { name: 'Game 1 - Zaín.slp', data: b },
    ]),
  );
  assert.deepEqual([...files.keys()], ['context.json', 'Game 1 - Zaín.slp']);
  assert.ok(files.get('context.json')!.equals(a));
  assert.ok(files.get('Game 1 - Zaín.slp')!.equals(b));
});

test('names: templates, the tournament number and file-name safety', () => {
  assert.equal(tournamentNumber('My Bar Weekly #60'), '60');
  assert.equal(tournamentNumber('Big Event 2026: Day 2'), '2');
  assert.equal(tournamentNumber('No Number'), '');
  assert.equal(
    fillName('My Bar {number} - {round_short} - {p1} vs {p2}', {
      number: '60',
      round_short: 'WSF',
      p1: 'Cody',
      p2: 'Zain',
    }),
    'My Bar 60 - WSF - Cody vs Zain',
  );
  assert.equal(safeFileName(' a/b\\c:d*e?"f<g>h|i. '), 'abcdefghi');
  assert.deepEqual(unknownFields('{p1} {nope} {round}', SET_FIELDS), ['nope']);
  assert.equal(stationNumber('Station 12'), 12);
  assert.equal(stationNumber('Beamer by the window'), null);
});

// ---- the archive end to end against a fake beamer ----

const EVENT: ArchiveEvent = {
  tournamentName: 'My Bar Weekly #60',
  tournamentLocation: '1 Main St',
  eventId: 1613010,
  eventName: 'Melee Singles',
  eventSlug: 'tournament/my-bar-weekly-60/event/melee-singles',
  eventHasSiblings: false,
  eventPhaseCount: 1,
};

function cachedSet(id: number): CachedSet {
  return {
    id,
    state: 1,
    round: 2,
    roundShort: 'WSF',
    roundName: 'WINNERS SEMI-FINAL',
    fullRoundText: 'Winners Semi-Final',
    bestOf: 3,
    autoBestOf: 3,
    bestOfOverridden: false,
    p1: { id: 9001, tag: 'Alpha' },
    p2: { id: 9002, tag: 'Bravo' },
    phaseGroup: {
      id: 77,
      displayIdentifier: 'A1',
      bracketType: 'DOUBLE_ELIMINATION',
      wave: null,
      phase: { id: 1700, name: 'Bracket', groupCount: 2, phaseOrder: 2 },
    },
  };
}

async function setup(
  t: { after(fn: () => unknown): void },
  opts: { finalizeTimeoutMs?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'tr-archive-'));
  const beamer = new FakeBeamer();
  await beamer.listen();
  const beamers = new BeamerDirectory({ port: 0, joinGroup: false });
  const audit: Record<string, unknown>[] = [];
  const archive = new SetArchive({
    dir,
    setTemplate: '{tournament} - {round_short} - {p1} vs {p2}',
    gameTemplate: 'Game {game} - {p1} ({p1_char}) vs {p2} ({p2_char}) - {stage}',
    beamerHttpPort: beamer.port(),
    beamers,
    event: EVENT,
    audit: { record: (e) => audit.push(e) },
    pollMs: 60_000, // the test calls tick() itself
    finalizeTimeoutMs: opts.finalizeTimeoutMs ?? 60_000,
  });
  t.after(async () => {
    await beamer.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // The beamer on "Station 3" announces itself from 127.0.0.1.
  beamers.onMessage(announceDatagram(3, 'game_finished', 'x.slp'), '127.0.0.1');
  return { dir, beamer, beamers, archive, audit };
}

// Entrant 1 (Alpha) on port 3 as Marth, entrant 2 (Bravo) on port 1 as Fox.
function replay(stage: number, lastFrame = 3600): Buffer {
  return makeSlp({
    stage,
    lastFrame,
    ports: [{ character: FOX, costume: 0 }, null, { character: MARTH, costume: 0 }, null],
  });
}

// A replay id is the match's gameStartTime in Unix seconds; the Wii names the
// file after it (protocol.yaml game_result.replay_id).
const T0 = Date.UTC(2026, 9, 7, 20, 15, 2) / 1000;
const MAC = '0017AB12CD34';
function replayName(id: number): string {
  return `Game_${MAC}_${replayStamp(id)}.slp`;
}

/** An auto-scored game as the kiosk reports it: ports from the L + R claim and the replay id. */
function played(winner: 1 | 2, replayId: number, stage = BF): GameResult {
  return game(winner, MARTH, FOX, stage, [0xff, 0xff], [0, 0], {
    p1_port: 2,
    p2_port: 0,
    replay_id: replayId,
  });
}

test('replay ids: the file-name stamp is the id read as UTC', () => {
  assert.equal(replayStamp(T0), '20261007T201502');
  assert.equal(fileStamp(replayName(T0)), '20261007T201502');
  assert.equal(fileStamp('Game_20261007T201502.slp'), '20261007T201502');
  assert.equal(fileStamp('notes.txt'), null);
});

test('a set of two games becomes one labelled zip; a replay no game names is left alone', async (t) => {
  const { dir, beamer, archive, audit } = await setup(t);

  beamer.add(replayName(T0 - 600), replay(BF)); // a friendly before the set
  archive.setStarted(3, cachedSet(500));
  beamer.add(replayName(T0), replay(BF));
  archive.scored(500, [played(1, T0)]);
  await archive.tick();
  beamer.add(replayName(T0 + 300), replay(FD, 4200));
  archive.setEnded(500, [played(1, T0), played(1, T0 + 300, FD)]);
  await archive.tick();

  const binds = audit.filter((e) => e.type === 'archive_bind').map((e) => [e.replay, e.game]);
  assert.deepEqual(binds, [
    [replayName(T0), 1],
    [replayName(T0 + 300), 2],
  ]);
  assert.equal(audit.filter((e) => e.type === 'archive_mismatch').length, 0);
  const fetched = beamer.requests;
  await archive.tick();
  assert.equal(beamer.requests, fetched, 'nothing left to fetch: the friendly is never downloaded');

  const zipName = 'My Bar Weekly #60 - WSF - Alpha vs Bravo.zip';
  assert.ok(existsSync(join(dir, zipName)), `zips: ${readdirSync(dir).join(', ')}`);
  const files = unzip(readFileSync(join(dir, zipName)));
  assert.deepEqual(
    [...files.keys()],
    [
      'context.json',
      'Game 1 - Alpha (Marth) vs Bravo (Fox) - BF.slp',
      'Game 2 - Alpha (Marth) vs Bravo (Fox) - FD.slp',
    ],
  );
  const g1 = files.get('Game 1 - Alpha (Marth) vs Bravo (Fox) - BF.slp')!;
  assert.equal(displayNameAt(g1, 2), 'Alpha');
  assert.equal(displayNameAt(g1, 0), 'Bravo');

  const ctx = JSON.parse(files.get('context.json')!.toString('utf8'));
  assert.equal(ctx.bestOf, 3);
  assert.equal(ctx.startgg.set.id, 500);
  assert.equal(ctx.startgg.set.fullRoundText, 'Winners Semi-Final');
  assert.equal(ctx.startgg.event.slug, EVENT.eventSlug);
  assert.equal(ctx.startgg.phaseGroup.name, 'A1');
  assert.equal(ctx.startgg.phaseGroup.bracketType, 2);
  assert.equal(ctx.startgg.phaseGroup.hasSiblings, true);
  // Slots in port order: Bravo (port 1) then Alpha (port 3); scores before each game.
  assert.deepEqual(
    ctx.scores[0].slots.map((s: { displayNames: string[]; ports: number[]; score: number }) => [
      s.displayNames[0],
      s.ports[0],
      s.score,
    ]),
    [
      ['Bravo', 1, 0],
      ['Alpha', 3, 0],
    ],
  );
  assert.deepEqual(
    ctx.scores[1].slots.map((s: { score: number }) => s.score),
    [0, 1],
  );
  assert.deepEqual(
    ctx.finalScore.slots.map((s: { score: number }) => s.score),
    [0, 2],
  );
  assert.deepEqual(ctx.players.entrant1, [{ name: 'Alpha', characters: ['Marth'] }]);
  assert.equal(ctx.durationMs, Math.ceil((3600 + 124) / 0.06) + Math.ceil((4200 + 124) / 0.06));

  assert.equal(hasRecord(dir, 500), false, 'the set record is gone once archived');
  assert.equal(existsSync(join(dir, '.raw', '500')), false, 'and its raw replays');
  assert.equal(archive.status().recent[0]!.games, 2);
});

test('an undone game played again: the zip takes the replay the new report names', async (t) => {
  const { dir, beamer, archive } = await setup(t);
  archive.setStarted(3, cachedSet(501));
  beamer.add(replayName(T0), replay(BF, 1000));
  archive.scored(501, [played(2, T0)]);
  await archive.tick();
  beamer.add(replayName(T0 + 200), replay(BF, 2000)); // undone, played again
  archive.scored(501, [played(2, T0 + 200)]);
  await archive.tick();
  beamer.add(replayName(T0 + 400), replay(BF, 3000));
  archive.setEnded(501, [played(2, T0 + 200), played(2, T0 + 400)]);
  await archive.tick();
  const files = unzip(readFileSync(join(dir, 'My Bar Weekly #60 - WSF - Alpha vs Bravo.zip')));
  const g1 = files.get('Game 1 - Alpha (Marth) vs Bravo (Fox) - BF.slp')!;
  assert.equal(parseSlp(g1).lastFrame, 2000);
});

test('a game undone and scored again with the same replay keeps it, without a second download', async (t) => {
  const { dir, beamer, archive, audit } = await setup(t);
  archive.setStarted(3, cachedSet(508));
  beamer.add(replayName(T0), replay(BF, 1000));
  archive.scored(508, [played(1, T0)]);
  await archive.tick();
  archive.scored(508, []); // undo
  archive.scored(508, [played(2, T0)]); // scored again, the other way
  const fetched = beamer.requests;
  archive.setEnded(508, [played(2, T0)]);
  await archive.tick();
  assert.equal(beamer.requests, fetched, 'bound from the stored copy');
  assert.equal(audit.filter((e) => e.type === 'archive_bind').length, 2);
  const files = unzip(readFileSync(join(dir, 'My Bar Weekly #60 - WSF - Alpha vs Bravo.zip')));
  assert.equal(
    parseSlp(files.get('Game 1 - Alpha (Marth) vs Bravo (Fox) - BF.slp')!).lastFrame,
    1000,
  );
});

test('a replay that never arrives: archived after the timeout without it', async (t) => {
  const { dir, beamer, archive } = await setup(t, { finalizeTimeoutMs: 0 });
  archive.setStarted(3, cachedSet(502));
  beamer.add(replayName(T0), replay(BF));
  archive.setEnded(502, [played(1, T0), played(1, T0 + 300)]);
  await archive.tick();
  const r = archive.status().recent[0]!;
  assert.deepEqual(r.missing, [2]);
  assert.match(r.note, /missing game 2/);
  const files = unzip(readFileSync(join(dir, 'My Bar Weekly #60 - WSF - Alpha vs Bravo.zip')));
  assert.equal(files.size, 2); // context.json + game 1
});

test('a game reported without a replay (replay_id 0) does not hold the set up', async (t) => {
  const { beamer, archive } = await setup(t);
  archive.setStarted(3, cachedSet(506));
  beamer.add(replayName(T0), replay(BF));
  archive.setEnded(506, [played(1, T0), played(1, 0)]);
  await archive.tick();
  const r = archive.status().recent[0]!;
  assert.equal(r.setId, 506, 'archived without waiting for the timeout');
  assert.deepEqual(r.missing, [2]);
});

test('no L + R claim: replays still archived, unlabelled, without context.json', async (t) => {
  const { dir, beamer, archive } = await setup(t);
  archive.setStarted(3, cachedSet(503));
  beamer.add(replayName(T0), replay(BF));
  archive.setEnded(503, [game(1, 0xff, 0xff, BF, [0xff, 0xff], [0xff, 0xff], { replay_id: T0 })]);
  await archive.tick();
  const files = unzip(readFileSync(join(dir, 'My Bar Weekly #60 - WSF - Alpha vs Bravo.zip')));
  assert.deepEqual([...files.keys()], ['Game 1 - Alpha () vs Bravo () - BF.slp']);
  assert.equal(displayNameAt(files.get('Game 1 - Alpha () vs Bravo () - BF.slp')!, 0), '');
  assert.match(archive.status().recent[0]!.note, /no context.json/);
});

test('a replay that disagrees with its report is still bound, and flagged', async (t) => {
  const { beamer, archive, audit } = await setup(t);
  archive.setStarted(3, cachedSet(507));
  beamer.add(replayName(T0), replay(BF));
  archive.setEnded(507, [played(1, T0, FD)]); // reported on FD, the replay is on BF
  await archive.tick();
  assert.deepEqual(
    audit.filter((e) => e.type === 'archive_mismatch').map((e) => [e.setId, e.game, e.replay]),
    [[507, 1, replayName(T0)]],
  );
  assert.equal(archive.status().recent[0]!.games, 1);
});

test('a busy beamer is retried after Retry-After; a relay restart mid-set picks the record back up', async (t) => {
  const { dir, beamer, beamers, archive } = await setup(t);
  archive.setStarted(3, cachedSet(504));
  beamer.busy = true;
  beamer.add(replayName(T0), replay(BF));
  archive.scored(504, [played(1, T0)]);
  await archive.tick();
  assert.equal(archive.status().inProgress[0]!.bound, 0);

  // "Restart": a new archive over the same directory, beamer reachable again.
  beamer.busy = false;
  const again = new SetArchive({
    dir,
    setTemplate: '{p1} vs {p2}',
    gameTemplate: 'Game {game}',
    beamerHttpPort: beamer.port(),
    beamers,
    event: EVENT,
    audit: { record: () => {} },
    pollMs: 60_000,
  });
  await again.tick();
  assert.equal(again.status().inProgress[0]!.bound, 1);
  again.setEnded(504, [played(1, T0)]);
  await again.tick();
  assert.ok(existsSync(join(dir, 'Alpha vs Bravo.zip')));
});

test('an abandoned set leaves nothing behind', async (t) => {
  const { dir, archive } = await setup(t);
  archive.setStarted(3, cachedSet(505));
  archive.scored(505, [played(1, T0)]);
  archive.setAbandoned(505);
  assert.equal(hasRecord(dir, 505), false);
  assert.equal(archive.status().inProgress.length, 0);
});

// ---- the whole relay: a Wii plays a set over TCP, the archive pulls from a fake beamer ----

test('end to end: START_SET, reports with replay ids and END_SET over TCP produce the zip', async (t) => {
  const { RelayTcpServer } = await import('../src/tcp.js');
  const { SetCache } = await import('../src/cache.js');
  const { StationState } = await import('../src/state.js');
  const { StartggClient } = await import('../src/startgg.js');
  const { makeFake, FIXTURE_TOKEN, FIXTURE_EVENT_ID } = await import('./fake-startgg.js');
  const { WiiClient } = await import('./wii-client.js');
  const { RelayStatus } = await import('../generated/wire.js');

  const { dir, beamer, beamers } = await setup(t);
  const fake = makeFake();
  await fake.start();
  const startgg = new StartggClient({
    endpoint: fake.url,
    token: FIXTURE_TOKEN,
    retryDelaysMs: [0, 0],
  });
  const cache = new SetCache(startgg, FIXTURE_EVENT_ID, 'startgg');
  await cache.refresh();
  const audit = { record: () => {} };
  const archive = new SetArchive({
    dir,
    setTemplate: '{round_short} - {p1} vs {p2} ({score})',
    gameTemplate: '{round_short} G{game} {p1} vs {p2} {stage}',
    beamerHttpPort: beamer.port(),
    beamers,
    event: EVENT,
    audit,
    pollMs: 60_000,
  });
  const server = new RelayTcpServer({
    cache,
    state: new StationState(),
    startgg,
    audit,
    archive,
    stream: { station: 1, streamId: 1358079 },
    secret: 'test-secret-1234',
  });
  await server.listen(0, '127.0.0.1');
  t.after(async () => {
    await server.close();
    await fake.close();
  });
  const wii = new WiiClient(server.address().port, 3);
  const SET = 107949994; // Alpha vs Bravo, Winners Quarter-Final, bo5

  assert.equal((await wii.startSet(SET)).resp.status, RelayStatus.ST_OK);
  await archive.tick();
  for (let n = 1; n <= 3; n++) {
    beamer.add(replayName(T0 + 300 * n), replay(BF, 1000 * n));
    const games = Array.from({ length: n }, (_, i) => played(1, T0 + 300 * (i + 1)));
    if (n < 3) assert.equal((await wii.reportScore(SET, games)).resp.status, RelayStatus.ST_OK);
    else assert.equal((await wii.endSet(SET, games)).resp.status, RelayStatus.ST_OK);
    await archive.tick();
  }
  const zip = join(dir, 'WQF - Alpha vs Bravo (3-0).zip');
  assert.ok(existsSync(zip), `zips: ${readdirSync(dir).join(', ')}`);
  const files = unzip(readFileSync(zip));
  assert.deepEqual(
    [...files.keys()],
    [
      'context.json',
      'WQF G1 Alpha vs Bravo BF.slp',
      'WQF G2 Alpha vs Bravo BF.slp',
      'WQF G3 Alpha vs Bravo BF.slp',
    ],
  );
  assert.equal(JSON.parse(files.get('context.json')!.toString()).startgg.set.id, SET);
});
