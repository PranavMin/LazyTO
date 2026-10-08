// The set archive (archive.ts): replays collected by the beamers' syncs
// (collect.ts, rawstore.ts, against test/fake-beamer.ts), bound to games by
// replay id on the beamer the game was reported through, and zipped once
// every game of a finished set has its replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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
import { BeamerRegistry, hexId } from '../src/beamer.js';
import { Collector } from '../src/collect.js';
import { RawStore } from '../src/rawstore.js';
import {
  SetArchive,
  hasRecord,
  fileStamp,
  replayStamp,
  type ArchiveEvent,
} from '../src/archive.js';
import type { CachedSet } from '../src/cache.js';
import {
  BEAMER_SYNC_VERSION,
  MAGIC_0,
  MAGIC_1,
  RelayCmd,
  RelayStatus,
  SyncAnswerKind,
  SyncKind,
  encodeRelayHdr,
  encodeRelayResp,
  type GameResult,
} from '../generated/wire.js';
import { FakeBeamer } from './fake-beamer.js';
import { makeSlp, displayNameAt } from './slp-fixture.js';
import { TEST_SECRET, game } from './wii-client.js';

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

test('slp: a finished replay is complete with its last stocks; an interrupted one is not', () => {
  const ports = [{ character: FOX, costume: 0 }, null, { character: MARTH, costume: 0 }, null];
  const done = parseSlp(makeSlp({ stage: BF, ports, stocks: [0, null, 2, null] }));
  assert.equal(done.complete, true);
  assert.deepEqual(done.stocks, [0, null, 2, null]);
  const cut = parseSlp(makeSlp({ stage: BF, ports, stocks: [4, null, 4, null], complete: false }));
  assert.equal(cut.complete, false, 'raw length 0 and no Game End');
  assert.deepEqual(cut.stocks, [4, null, 4, null], 'what it has is still read');
  const whole = makeSlp({ stage: BF, ports, stocks: [3, null, 3, null] });
  assert.equal(parseSlp(whole.subarray(0, whole.length - 40)).complete, false, 'cut short');
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
});

// ---- the archive against a fake beamer, without TCP ----

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

/** A sync reply as the relay frames it: relay_hdr (sync version) + relay_resp ST_OK + payload. */
function framed(payload: Uint8Array): Buffer {
  const resp = encodeRelayResp({ status: RelayStatus.ST_OK, msg: 'synced' });
  return Buffer.concat([
    encodeRelayHdr({
      magic: new Uint8Array([MAGIC_0, MAGIC_1]),
      version: BEAMER_SYNC_VERSION,
      cmd: RelayCmd.CMD_BEAMER_SYNC,
      station: 3,
      len: resp.length + payload.length,
    }),
    resp,
    payload,
  ]);
}

interface Env {
  dir: string;
  beamer: FakeBeamer;
  store: RawStore;
  archive: SetArchive;
  collector: Collector;
  audit: Record<string, unknown>[];
  sid: string;
  /** One sync of the beamer, its downloads finished. */
  sync(): Promise<ReturnType<FakeBeamer['apply']>>;
  /** Sync until nothing more is wanted. */
  collect(): Promise<void>;
  /** The archive over the same folder, as after a relay restart (optionally at another event). */
  restart(event?: ArchiveEvent): void;
}

async function setup(
  t: { after(fn: () => unknown): void },
  opts: { dir?: string } = {},
): Promise<Env> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'tr-archive-'));
  const beamer = new FakeBeamer(3, 3);
  await beamer.listen();
  const audit: Record<string, unknown>[] = [];
  const record = (e: Record<string, unknown>) => void audit.push(e);
  const make = (event: ArchiveEvent) => {
    const store = new RawStore(dir);
    const beamers = new BeamerRegistry();
    const archive = new SetArchive({
      dir,
      store,
      beamerAt: (a) => beamers.stationIdAt(a),
      setTemplate: '{tournament} - {round_short} - {p1} vs {p2}',
      gameTemplate: 'Game {game} - {p1} ({p1_char}) vs {p2} ({p2_char}) - {stage}',
      event,
      audit: { record },
    });
    const collector = new Collector({
      store,
      beamers,
      secret: TEST_SECRET,
      archive,
      audit: { record },
      stallMs: 2000,
    });
    return { store, archive, collector };
  };
  const env: Env = {
    dir,
    beamer,
    audit,
    sid: hexId(beamer.stationId),
    ...make(EVENT),
    async sync() {
      const req = beamer.syncRequest();
      const payload = await env.collector.sync(req, beamer.address);
      const r = beamer.apply(req, framed(payload));
      await env.collector.idle();
      return r;
    },
    async collect() {
      for (let i = 0; i < 6; i++) {
        const r = await env.sync();
        if (!r.answers.some((a) => a.answer === SyncAnswerKind.SA_WANTED)) return;
      }
      throw new Error('still collecting after 6 syncs');
    },
    restart(event = EVENT) {
      Object.assign(env, make(event));
    },
  };
  t.after(async () => {
    await beamer.close();
    if (!opts.dir) rmSync(dir, { recursive: true, force: true });
  });
  return env;
}

// Entrant 1 (Alpha) on port 3 as Marth, entrant 2 (Bravo) on port 1 as Fox.
function replay(
  stage: number,
  lastFrame = 3600,
  more: { stocks?: (number | null)[]; complete?: boolean } = {},
): Buffer {
  return makeSlp({
    stage,
    lastFrame,
    ports: [{ character: FOX, costume: 0 }, null, { character: MARTH, costume: 0 }, null],
    ...more,
  });
}

// A replay id is the match's gameStartTime in Unix seconds; the Wii names the
// file after it (protocol.yaml game_result.replay_id).
const T0 = Date.UTC(2026, 9, 7, 20, 15, 2) / 1000;
const MAC = '0017AB12CD34';
function replayName(id: number): string {
  return `Game_${MAC}_${replayStamp(id)}.slp`;
}
/** Where the Wii's requests come from: its beamer's address. */
const FROM = '127.0.0.1';

/** An auto-scored game as the kiosk reports it: ports from the L + R claim and the replay id. */
function played(
  winner: 1 | 2,
  replayId: number,
  stage = BF,
  stocks: [number, number] = [0xff, 0xff],
): GameResult {
  return game(winner, MARTH, FOX, stage, stocks, [0, 0], {
    p1_port: 2,
    p2_port: 0,
    replay_id: replayId,
  });
}

const ZIP = 'My Bar Weekly #60 - WSF - Alpha vs Bravo.zip';

test('replay ids: the file-name stamp is the id read as UTC', () => {
  assert.equal(replayStamp(T0), '20261007T201502');
  assert.equal(fileStamp(replayName(T0)), '20261007T201502');
  assert.equal(fileStamp('Game_20261007T201502.slp'), '20261007T201502');
  assert.equal(fileStamp('notes.txt'), null);
});

test('a set of two games: collected, bound by id, zipped; the friendly is kept unmatched; all acked, then erased', async (t) => {
  const e = await setup(t);
  e.beamer.add(replayName(T0 - 600), replay(BF)); // a stray (an undone game) before the set
  e.archive.setStarted(3, cachedSet(500));
  e.beamer.add(replayName(T0), replay(BF));
  e.archive.scored(500, [played(1, T0)], FROM);
  await e.collect();
  e.beamer.add(replayName(T0 + 300), replay(FD, 4200));
  e.archive.setEnded(500, [played(1, T0), played(1, T0 + 300, FD)], FROM);
  await e.collect();

  const binds = e.audit.filter((a) => a.type === 'archive_bind').map((a) => [a.replay, a.game]);
  assert.deepEqual(binds, [
    [replayName(T0), 1],
    [replayName(T0 + 300), 2],
  ]);
  assert.equal(e.audit.filter((a) => a.type === 'archive_mismatch').length, 0);
  assert.ok(existsSync(join(e.dir, 'raw', e.sid, replayName(T0))));
  assert.ok(existsSync(join(e.dir, 'unmatched', e.sid, replayName(T0 - 600))), 'the stray');

  assert.ok(existsSync(join(e.dir, ZIP)), `zips: ${readdirSync(e.dir).join(', ')}`);
  const files = unzip(readFileSync(join(e.dir, ZIP)));
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
  assert.equal(e.archive.status().recent[0]!.games, 2);
  assert.equal(e.archive.status().unmatched, 1);

  // Everything collected was served this boot, so the last sync answered it held and the beamer acked it.
  assert.deepEqual([...e.beamer.acks.keys()].sort(), [
    replayName(T0 - 600),
    replayName(T0),
    replayName(T0 + 300),
  ]);
  assert.equal(e.beamer.syncRequest().to_collect, 0);
  assert.deepEqual(e.beamer.boot(), { erased: 3, empty: 0 }, 'erased at the next cold boot');
  assert.ok(existsSync(join(e.dir, 'raw', e.sid, replayName(T0))), 'the laptop keeps its copies');
  assert.ok(hasRecord(e.dir, 500), 'the set record stays, for a late replay');
});

test('an undone game played again: the zip takes the replay the new report names', async (t) => {
  const e = await setup(t);
  e.archive.setStarted(3, cachedSet(501));
  e.beamer.add(replayName(T0), replay(BF, 1000));
  e.archive.scored(501, [played(2, T0)], FROM);
  await e.collect();
  e.beamer.add(replayName(T0 + 200), replay(BF, 2000)); // undone, played again
  e.archive.scored(501, [played(2, T0 + 200)], FROM);
  await e.collect();
  e.beamer.add(replayName(T0 + 400), replay(BF, 3000));
  e.archive.setEnded(501, [played(2, T0 + 200), played(2, T0 + 400)], FROM);
  await e.collect();
  const files = unzip(readFileSync(join(e.dir, ZIP)));
  const g1 = files.get('Game 1 - Alpha (Marth) vs Bravo (Fox) - BF.slp')!;
  assert.equal(parseSlp(g1).lastFrame, 2000);
});

test('a game undone and scored again with the same replay keeps it, without a second download', async (t) => {
  const e = await setup(t);
  e.archive.setStarted(3, cachedSet(508));
  e.beamer.add(replayName(T0), replay(BF, 1000));
  e.archive.scored(508, [played(1, T0)], FROM);
  await e.collect();
  const fetched = e.beamer.gets.length;
  e.archive.scored(508, [], FROM); // undo
  e.archive.scored(508, [played(2, T0)], FROM); // scored again, the other way
  e.archive.setEnded(508, [played(2, T0)], FROM);
  await e.collect();
  assert.equal(e.beamer.gets.length, fetched, 'bound from the stored copy');
  assert.equal(e.audit.filter((a) => a.type === 'archive_bind').length, 2);
  const files = unzip(readFileSync(join(e.dir, ZIP)));
  assert.equal(
    parseSlp(files.get('Game 1 - Alpha (Marth) vs Bravo (Fox) - BF.slp')!).lastFrame,
    1000,
  );
});

test('a game reported without a replay (replay_id 0): no zip for Lucky Stats, listed with why', async (t) => {
  const e = await setup(t);
  e.archive.setStarted(3, cachedSet(506));
  e.beamer.add(replayName(T0), replay(BF));
  e.archive.scored(506, [played(1, T0), played(1, 0)], FROM);
  assert.deepEqual(
    e.archive.status().flagged.map((f) => [f.station, f.game, f.why]),
    [[3, 2, 'not recorded']],
    'flagged while the players are still at the setup',
  );
  e.archive.setEnded(506, [played(1, T0), played(1, 0)], FROM);
  await e.collect();
  assert.equal(existsSync(join(e.dir, ZIP)), false);
  const s = e.archive.status().skipped;
  assert.deepEqual(
    s.map((x) => [x.setId, x.label, x.missing]),
    [[506, 'WSF Alpha vs Bravo', [{ game: 2, why: 'not recorded' }]]],
  );
  assert.ok(
    existsSync(join(e.dir, 'raw', e.sid, replayName(T0))),
    'its replays stay on the laptop',
  );
});

test('a replay that arrives late zips the set then, even at the next event after a restart', async (t) => {
  const e = await setup(t);
  e.archive.setStarted(3, cachedSet(502));
  e.beamer.add(replayName(T0), replay(BF));
  e.archive.setEnded(502, [played(1, T0), played(1, T0 + 300)], FROM);
  await e.collect();
  assert.deepEqual(e.archive.status().skipped[0]!.missing, [{ game: 2, why: 'not collected yet' }]);
  assert.equal(existsSync(join(e.dir, ZIP)), false);

  // Next week: a new relay run for another event, the same archive folder.
  const nextWeek = { ...EVENT, eventId: 1700000, tournamentName: 'My Bar Weekly #61' };
  e.restart(nextWeek);
  assert.equal(e.archive.status().skipped.length, 0, "last week's sets are not this event's list");
  e.beamer.add(replayName(T0 + 300), replay(BF, 5000)); // the beamer was finally plugged in again
  await e.collect();
  assert.ok(existsSync(join(e.dir, ZIP)), `zips: ${readdirSync(e.dir).join(', ')}`);
  const files = unzip(readFileSync(join(e.dir, ZIP)));
  const ctx = JSON.parse(files.get('context.json')!.toString('utf8'));
  assert.equal(ctx.startgg.event.id, EVENT.eventId, 'the set keeps its own event');
  assert.equal(files.size, 3);
});

test('no L + R claim: the replays are still zipped, unlabelled, without context.json', async (t) => {
  const e = await setup(t);
  e.archive.setStarted(3, cachedSet(503));
  e.beamer.add(replayName(T0), replay(BF));
  e.archive.setEnded(
    503,
    [game(1, 0xff, 0xff, BF, [0xff, 0xff], [0xff, 0xff], { replay_id: T0 })],
    FROM,
  );
  await e.collect();
  const files = unzip(readFileSync(join(e.dir, ZIP)));
  assert.deepEqual([...files.keys()], ['Game 1 - Alpha () vs Bravo () - BF.slp']);
  assert.equal(displayNameAt(files.get('Game 1 - Alpha () vs Bravo () - BF.slp')!, 0), '');
  assert.match(e.archive.status().recent[0]!.note, /no context.json/);
});

test('the content check flags a mismatch and still binds; stocks are compared only when the game sent them', async (t) => {
  const e = await setup(t);
  e.archive.setStarted(3, cachedSet(507));
  // Alpha (port 3) ends with 2 stocks, Bravo (port 1) with 0.
  const stocks = [0, null, 2, null];
  e.beamer.add(replayName(T0), replay(BF, 3600, { stocks }));
  e.beamer.add(replayName(T0 + 300), replay(BF, 3600, { stocks }));
  e.beamer.add(replayName(T0 + 600), replay(BF, 3600, { stocks }));
  e.archive.scored(
    507,
    [
      played(1, T0, FD, [2, 0]), // reported on FD, the replay is on BF
      played(1, T0 + 300, BF, [3, 0]), // one stock too many
      played(1, T0 + 600, BF, [0xff, 0xff]), // the ledge-grab limit decided it: no stocks sent
    ],
    FROM,
  );
  await e.collect();
  assert.deepEqual(
    e.audit.filter((a) => a.type === 'archive_mismatch').map((a) => [a.game, a.mismatch]),
    [
      [1, `stage ${BF}, reported ${FD}`],
      [2, 'port 3 ended with 2 stock(s), reported 3'],
    ],
  );
  assert.deepEqual(
    e.archive.status().flagged.map((f) => f.game),
    [1, 2],
  );
  assert.equal(e.archive.status().inProgress[0]!.bound, 3, 'all three bound: the id decides');
});

test('an incomplete recording is kept in unmatched/, and its set gets no zip', async (t) => {
  const e = await setup(t);
  e.archive.setStarted(3, cachedSet(509));
  // The beamer was unplugged mid-game: the file stops part way (raw length 0, no Game End).
  e.beamer.add(replayName(T0), replay(BF, 3600, { complete: false }), SyncKind.SK_INCOMPLETE);
  e.archive.setEnded(509, [played(1, T0)], FROM);
  await e.collect();
  assert.ok(existsSync(join(e.dir, 'unmatched', e.sid, replayName(T0))));
  assert.deepEqual(e.archive.status().skipped[0]!.missing, [
    { game: 1, why: 'incomplete recording' },
  ]);
  assert.equal(existsSync(join(e.dir, ZIP)), false);
  assert.deepEqual([...e.beamer.acks.keys()], [replayName(T0)], 'held and acked like any file');
});

test('a replay that comes before its report goes to unmatched/, and moves to raw/ when the report names it', async (t) => {
  const e = await setup(t);
  e.archive.setStarted(3, cachedSet(510));
  e.beamer.add(replayName(T0), replay(BF));
  await e.collect(); // the beamer found the file before the kiosk's report arrived
  assert.ok(existsSync(join(e.dir, 'unmatched', e.sid, replayName(T0))));
  e.archive.setEnded(510, [played(1, T0)], FROM);
  assert.ok(existsSync(join(e.dir, 'raw', e.sid, replayName(T0))));
  assert.ok(existsSync(join(e.dir, ZIP)));
  // The beamer still has its ack: the stored copy moved, its hash did not.
  assert.equal((await e.sync()).answers.length, 0);
});

test('a set record an older relay wrote is reported at start, never used', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-archive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const e = await setup(t, { dir });
  // The first v2 archive kept no event and bound replays by file in .raw/<setId>/.
  writeFileSync(
    join(dir, '.sets', '511.json'),
    JSON.stringify({
      setId: 511,
      station: 3,
      set: cachedSet(511),
      startedAt: 0,
      games: [{ at: 0, result: played(1, T0), replay: { file: 'x.slp', lastFrame: 1 } }],
      endedAt: null,
    }),
  );
  e.audit.length = 0;
  e.restart();
  assert.deepEqual(
    e.audit.map((a) => [a.type, a.file]),
    [['archive_error', '511.json']],
  );
  assert.match(String(e.audit[0]!.error), /not a set record of this relay version/);
  assert.equal(e.archive.status().inProgress.length, 0);
});

test('an abandoned set: its record goes and its replays become strays', async (t) => {
  const e = await setup(t);
  e.archive.setStarted(3, cachedSet(505));
  e.beamer.add(replayName(T0), replay(BF));
  e.archive.scored(505, [played(1, T0)], FROM);
  await e.collect();
  assert.ok(existsSync(join(e.dir, 'raw', e.sid, replayName(T0))));
  e.archive.setAbandoned(505);
  assert.equal(hasRecord(e.dir, 505), false);
  assert.equal(e.archive.status().inProgress.length, 0);
  assert.ok(existsSync(join(e.dir, 'unmatched', e.sid, replayName(T0))));
});

// ---- the whole relay: a Wii plays a set over TCP, its beamer syncs over TCP ----

test('end to end: START_SET, reports with replay ids and END_SET, the beamer syncs, the zip is written', async (t) => {
  const { startHarness } = await import('./harness.js');
  const h = await startHarness();
  t.after(h.close);
  const beamer = new FakeBeamer(3, 3);
  await beamer.listen();
  t.after(() => beamer.close());
  const wii = h.wii(3);
  const SET = 107949994; // Alpha vs Bravo, Winners Quarter-Final, bo5
  const sync = async () => {
    const r = await beamer.sync(h.tcpPort);
    assert.equal(r.verified, true, 'the reply is signed with the secret');
    await h.ev.collector.idle();
    return r;
  };

  assert.equal((await wii.startSet(SET)).resp.status, RelayStatus.ST_OK);
  await sync();
  for (let n = 1; n <= 3; n++) {
    beamer.add(replayName(T0 + 300 * n), replay(BF, 1000 * n));
    const games = Array.from({ length: n }, (_, i) => played(1, T0 + 300 * (i + 1)));
    if (n < 3) assert.equal((await wii.reportScore(SET, games)).resp.status, RelayStatus.ST_OK);
    else assert.equal((await wii.endSet(SET, games)).resp.status, RelayStatus.ST_OK);
    await sync();
  }
  await sync(); // the served files come back hashed: held, acked
  await sync(); // and the beamer's next sync counts nothing left to collect
  const dir = join(h.dataDir, 'archive');
  const zip = join(dir, 'LazyTO Test Tournament - WQF - Alpha vs Bravo.zip');
  assert.ok(existsSync(zip), `zips: ${readdirSync(dir).join(', ')}`);
  const files = unzip(readFileSync(zip));
  assert.equal(files.size, 4);
  assert.equal(JSON.parse(files.get('context.json')!.toString()).startgg.set.id, SET);
  assert.equal(beamer.acks.size, 3);
  const html = await (await fetch(h.statusUrl)).text();
  assert.match(html, /All replays collected: safe to unplug beamers/);
});
