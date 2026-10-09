// The beamer sync (collect.ts, rawstore.ts) over TCP through the relay, with
// test/fake-beamer.ts checking every reply the way the firmware must:
// held, wanted and noted, the signature and archive_id (also when the archive
// folder is deleted mid-run), resumed downloads, a full disk, name
// collisions, and the stat and re-hash rules behind "held".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayStatus, SyncAnswerKind, SyncKind } from '../generated/wire.js';
import { hexId } from '../src/beamer.js';
import { REHASH_AFTER_MS, RawStore } from '../src/rawstore.js';
import { FakeBeamer } from './fake-beamer.js';
import { startHarness, type Harness, type HarnessOptions } from './harness.js';
import { makeSlp } from './slp-fixture.js';

const A = SyncAnswerKind;

function slp(lastFrame: number): Buffer {
  return makeSlp({
    stage: 0x1f,
    lastFrame,
    ports: [{ character: 2, costume: 0 }, null, { character: 9, costume: 0 }, null],
  });
}

async function setup(
  t: { after(fn: () => unknown): void },
  opts: HarnessOptions & { seed?: number; address?: string } = {},
): Promise<{
  h: Harness;
  beamer: FakeBeamer;
  dir: string;
  sid: string;
  sync: () => ReturnType<FakeBeamer['sync']>;
}> {
  const h = await startHarness(opts);
  const beamer = new FakeBeamer(opts.seed ?? 5, 5, opts.address);
  await beamer.listen();
  t.after(async () => {
    await beamer.close();
    await h.close();
  });
  const sync = async () => {
    const r = await beamer.sync(h.tcpPort);
    await h.ev.collector.idle();
    return r;
  };
  return { h, beamer, dir: join(h.dataDir, 'archive'), sid: hexId(beamer.stationId), sync };
}

const answers = (r: { answers: { name: string; answer: number }[] }) =>
  r.answers.map((a) => [a.name, a.answer]);

test('a sync is answered, signed with the secret, under the archive_id kept in archive.json', async (t) => {
  const { h, beamer, dir, sync } = await setup(t);
  const r = await sync();
  assert.equal(r.status, RelayStatus.ST_OK);
  assert.equal(r.verified, true);
  const json = JSON.parse(readFileSync(join(dir, 'archive.json'), 'utf8'));
  assert.match(json.archive_id, /^[0-9a-f]{32}$/);
  assert.equal(hexId(beamer.archiveId), json.archive_id, 'the beamer adopts the archive');
  const row = h.ev.beamers.list()[0]!;
  assert.equal(row.station, 5);
  assert.equal(row.address, '127.0.0.1');
  assert.equal(row.fwBuild, 2);
  assert.equal(h.ev.state.lastAction(5), undefined, 'a sync is no station action');
  // The same folder keeps its id across restarts.
  assert.deepEqual(new RawStore(dir).archiveId, beamer.archiveId);
});

test('wanted, downloaded, then held and acked; erased at a cold boot', async (t) => {
  const { beamer, dir, sid, sync } = await setup(t);
  beamer.add('Game_0017AB12CD34_20261007T201502.slp', slp(1000));
  beamer.add('Game_0017AB12CD34_20261007T202000.slp', slp(2000), SyncKind.SK_LIVE);
  const first = await sync();
  assert.deepEqual(answers(first), [
    ['Game_0017AB12CD34_20261007T201502.slp', A.SA_WANTED],
    ['Game_0017AB12CD34_20261007T202000.slp', A.SA_NOTED], // being recorded
  ]);
  assert.ok(existsSync(join(dir, 'unmatched', sid, 'Game_0017AB12CD34_20261007T201502.slp')));
  assert.deepEqual(
    beamer.gets.map((g) => [g.name, g.from, g.gzip, g.connection]),
    [['Game_0017AB12CD34_20261007T201502.slp', null, true, 'close']],
  );
  const second = await sync();
  assert.equal(second.answers[0]!.answer, A.SA_HELD);
  assert.deepEqual(second.acked, ['Game_0017AB12CD34_20261007T201502.slp']);
  assert.deepEqual(beamer.boot(), { erased: 1, empty: 0 });
  assert.deepEqual(answers(await sync()), [['Game_0017AB12CD34_20261007T202000.slp', A.SA_NOTED]]);
});

test('a file the laptop holds but the beamer did not serve this boot is wanted again, and stored once', async (t) => {
  const { beamer, dir, sid, sync } = await setup(t);
  beamer.add('Game_0017AB12CD34_20261007T201502.slp', slp(1000));
  await sync(); // downloaded
  beamer.boot(); // rebooted before its next sync: no ack, no hash
  assert.deepEqual(answers(await sync()), [['Game_0017AB12CD34_20261007T201502.slp', A.SA_WANTED]]);
  assert.equal(beamer.gets.length, 2, 'served again, so the beamer can hash it');
  assert.equal((await sync()).answers[0]!.answer, A.SA_HELD);
  assert.deepEqual(readdirSync(join(dir, 'unmatched', sid)), [
    'Game_0017AB12CD34_20261007T201502.slp',
  ]);
});

test('a download cut off part way resumes with X-Replay-From', async (t) => {
  const { h, beamer, sync } = await setup(t);
  const data = Buffer.concat([slp(1000), Buffer.alloc(50_000, 1)]);
  beamer.add('Game_0017AB12CD34_20261007T201502.slp', data);
  beamer.cutAfter = 20_000;
  await sync();
  assert.match(
    h.ev.collector.status()[0]!.lastError ?? '',
    /Game_0017AB12CD34_20261007T201502\.slp/,
  );
  assert.equal((await sync()).answers[0]!.answer, A.SA_WANTED, 'asked for again at the next sync');
  assert.deepEqual(
    beamer.gets.map((g) => g.from),
    [null, 20_000],
    'the second request starts where the first stopped',
  );
  const held = await sync();
  assert.equal(held.answers[0]!.answer, A.SA_HELD);
  assert.deepEqual(
    held.acked,
    ['Game_0017AB12CD34_20261007T201502.slp'],
    'the assembled copy hashes like the original',
  );
});

test('a full disk: nothing is wanted, and the status page says so', async (t) => {
  const { h, beamer, sync } = await setup(t, { freeBytes: () => 100 * 1024 * 1024 });
  beamer.add('Game_0017AB12CD34_20261007T201502.slp', slp(1000));
  assert.deepEqual(answers(await sync()), [['Game_0017AB12CD34_20261007T201502.slp', A.SA_NOTED]]);
  assert.equal(beamer.gets.length, 0);
  assert.match(await (await fetch(h.statusUrl)).text(), /disk is too full to collect its replays/);
});

test('the same name with other content (the Wii clock set back) is stored beside the first as ~sha8', async (t) => {
  const { beamer, dir, sid, sync } = await setup(t);
  const name = 'Game_0017AB12CD34_20261007T201502.slp';
  beamer.add(name, slp(1000));
  await sync();
  await sync(); // held, acked
  beamer.boot(); // erased
  beamer.add(name, slp(2000)); // the same name, another game
  await sync();
  assert.equal((await sync()).answers[0]!.answer, A.SA_HELD);
  const files = readdirSync(join(dir, 'unmatched', sid)).sort();
  assert.equal(files.length, 2);
  assert.equal(files[0], name);
  assert.match(files[1]!, /^Game_0017AB12CD34_20261007T201502~[0-9a-f]{8}\.slp$/);
});

test('held only while the copy stats at its size, and re-hashed after a day', async (t) => {
  const { h, beamer, dir, sid, sync } = await setup(t);
  const name = 'Game_0017AB12CD34_20261007T201502.slp';
  beamer.add(name, slp(1000));
  beamer.files[0]!.kind = SyncKind.SK_FINISHED;
  await sync(); // downloaded; the beamer now has its hash
  const path = join(dir, 'unmatched', sid, name);
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('x')])); // the copy changed size
  const req = beamer.syncRequest();
  assert.equal(req.files[0]!.hashed, 1);
  const [stored] = await h.ev.store.held(sid, req.files[0]!);
  assert.equal(stored, undefined, 'a copy that does not stat at its size is not held');
  assert.equal((await sync()).answers[0]!.answer, A.SA_WANTED, 'so it is downloaded again');
  // Same size, other bytes: only the daily re-hash notices.
  const f = beamer.syncRequest().files[0]!;
  const [copy] = await h.ev.store.held(sid, f);
  const copyPath = h.ev.store.absolute(copy!);
  const bad = readFileSync(copyPath);
  bad[bad.length - 1] ^= 0xff;
  writeFileSync(copyPath, bad);
  assert.equal((await h.ev.store.held(sid, f)).length, 1, 'within a day the stat is enough');
  const later = Date.now() + REHASH_AFTER_MS + 60_000;
  assert.equal((await h.ev.store.held(sid, f, later)).length, 0, 'after a day it is hashed again');
});

test('a beamer with another secret: refused, nothing acked, and the status page names it', async (t) => {
  const { h, beamer } = await setup(t);
  beamer.secret = 'another-venue-1';
  beamer.add('Game_0017AB12CD34_20261007T201502.slp', slp(1000));
  const r = await beamer.sync(h.tcpPort);
  assert.equal(r.status, RelayStatus.ST_BAD_SECRET);
  assert.equal(r.verified, false);
  assert.equal(beamer.acks.size, 0);
  assert.equal(h.ev.beamers.list().length, 0);
  assert.match(
    await (await fetch(h.statusUrl)).text(),
    /The beamer at 127\.0\.0\.1 has another secret: its syncs are refused/,
  );
});

test('a new archive folder (another laptop): the beamer drops its acks and the files are collected again', async (t) => {
  const { beamer, sync } = await setup(t);
  beamer.add('Game_0017AB12CD34_20261007T201502.slp', slp(1000));
  await sync();
  await sync();
  assert.equal(beamer.acks.size, 1);
  // Another laptop, before the beamer was power-cycled.
  const other = await setup(t, { seed: 5 });
  other.beamer.files.push(...beamer.files);
  other.beamer.archiveId = beamer.archiveId;
  for (const [k, v] of beamer.acks) other.beamer.acks.set(k, v);
  const r = await other.sync();
  assert.equal(r.verified, true);
  assert.deepEqual(r.answers, [], 'an acked file is not listed');
  assert.equal(other.beamer.acks.size, 0, 'another archive_id drops every ack');
  assert.deepEqual(answers(await other.sync()), [
    ['Game_0017AB12CD34_20261007T201502.slp', A.SA_WANTED],
  ]);
  assert.deepEqual((await other.sync()).acked, ['Game_0017AB12CD34_20261007T201502.slp']);
});

test('names that are not a plain .slp are never downloaded', async (t) => {
  const { beamer, sync } = await setup(t);
  beamer.add('../../evil.slp', slp(1000));
  beamer.add('Game_x.txt', slp(1000));
  const r = await sync();
  assert.deepEqual(
    r.answers.map((a) => a.answer),
    [A.SA_NOTED, A.SA_NOTED],
  );
  assert.equal(beamer.gets.length, 0);
});

test('the archive folder deleted while LazyTO runs: a new archive_id, so the beamer drops its acks and the files are collected again', async (t) => {
  const { h, beamer, dir, sid, sync } = await setup(t);
  const name = 'Game_0017AB12CD34_20261007T201502.slp';
  beamer.add(name, slp(1000));
  await sync(); // downloaded
  assert.deepEqual((await sync()).acked, [name]);
  const before = hexId(beamer.archiveId);
  // The TO deletes Documents/LazyTO with the app open, before the beamer's power-on erase.
  rmSync(dir, { recursive: true, force: true });
  const r = await sync();
  assert.equal(r.verified, true);
  const after = JSON.parse(readFileSync(join(dir, 'archive.json'), 'utf8')).archive_id;
  assert.notEqual(after, before, 'a new archive, under a new id');
  assert.equal(hexId(beamer.archiveId), after);
  assert.equal(beamer.acks.size, 0, 'the beamer dropped the ack for the replay that was deleted');
  assert.deepEqual(beamer.boot(), { erased: 0, empty: 0 }, 'so a power-on erases nothing');
  assert.deepEqual(answers(await sync()), [[name, A.SA_WANTED]]);
  assert.ok(existsSync(join(dir, 'unmatched', sid, name)), 'collected again');
  assert.deepEqual((await sync()).acked, [name]);
  assert.ok(
    h.auditEvents().some((e) => e.type === 'archive_reset' && e.from === before && e.to === after),
  );
});

test('a repeat download is checked against the stored copy: one changed in place at its size is replaced, never acked', async (t) => {
  const { h, beamer, dir, sid, sync } = await setup(t);
  const name = 'Game_0017AB12CD34_20261007T201502.slp';
  const good = slp(1000);
  beamer.add(name, good);
  await sync(); // downloaded
  beamer.boot(); // rebooted before its next sync: served again so it can hash it
  // Meanwhile the stored copy is damaged in place, same size (a sync tool, the disk).
  const path = join(dir, 'unmatched', sid, name);
  const bad = Buffer.from(good);
  bad[bad.length - 1] ^= 0xff;
  writeFileSync(path, bad);
  assert.deepEqual(answers(await sync()), [[name, A.SA_WANTED]]);
  assert.deepEqual(readFileSync(path), good, 'the fresh download replaced the damaged copy');
  assert.equal(h.ev.store.all().length, 1, 'still one copy');
  assert.deepEqual(
    (await sync()).acked,
    [name],
    'acked only once the laptop holds the right bytes',
  );
});

test('a stored copy can be answered "held" only once its index line is written', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lazyto-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RawStore(dir);
  const sid = '00'.repeat(16);
  const data = slp(1000);
  const f = { name: 'Game_0017AB12CD34_20261007T201502.slp', bytes: data.length, mtime: 7 };
  // The index cannot be appended to (here a folder stands in its place).
  mkdirSync(join(dir, 'index.jsonl'));
  const part = store.part(sid, f);
  writeFileSync(part.path, data);
  assert.throws(() => store.commit(sid, f, part.path, 'raw', SyncKind.SK_FINISHED, true));
  assert.equal(store.all().length, 0, 'no record without its index line');
  assert.deepEqual(await store.held(sid, f), []);
});
