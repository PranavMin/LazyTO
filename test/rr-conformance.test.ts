// The set archive against Replay Reporter for Slippi's own output
// (test/rr-conformance/, made by RR v2.7.0's code; BUNDLE.md). Every zip
// name, entry name, context.json and .slp byte is compared with RR's, and so
// are the zip's header fields, except where docs/redesign.md (The zip and
// Lucky Stats) decided LazyTO's value is right and RR's is a bug: there the
// test expects the corrected value, listed below per fixture, and checks
// that RR's golden really has the bug. Only what RR itself does not
// reproduce is left out: compressed bytes (its zlib) and the order of the
// .slp entries (async reads there; game order here).
process.env.TZ = 'UTC'; // the goldens' zone: zip entry times are local time

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { DECODE, ENCODE } from '../generated/sjis.js';
import { rrSanitize, rrFill, rrRoundShort, RR_CHARACTER, RR_STAGE } from '../src/names.js';
import { rrOrdinals, type RestPhaseGroup } from '../src/phasegroup.js';
import { rrEventCount } from '../src/resolve.js';
import { buildSetZip, retime } from '../src/setzip.js';
import { sjisCodes, sjisDecode, sjisEncode } from '../src/sjis.js';
import { parseSlp, withDisplayNames, withStartAt } from '../src/slp.js';
import { crc32 } from '../src/zip.js';
import type { RestTournament } from '../src/startgg.js';
import {
  BUNDLE,
  bundleFile,
  bundleJson,
  fixture,
  gameResult,
  replayId,
  rrReplay,
  setZipInput,
  type Fixture,
  type RrReplay,
} from './rr-adapter.js';

/**
 * ソラとヒカリのスーパーマリオブ (the first 15 characters of a fixture's tag) is
 * 30 bytes in Shift-JIS. RR remaps the trail bytes 5C, 5B and 7D of ソ, ー, ー
 * and マ, gets 34 and spills 49 83 75 into the next port's field.
 */
const SORA = '835c838982c68371834a838a82cc8358815b8370815b837d838a83498375';

// ---- the corrections: where LazyTO's value differs from RR's on purpose ----

/**
 * The running score per player (RR counts per port slot) and the set's own
 * best-of (RR derives it from the slot score). 02 and 03: the players swap
 * ports after game 1. 06r and 06z: two 0%-0% timeouts RR's replay parse calls
 * ties count for the player the TO scored them for (entrant 1), as LazyTO
 * reported them. Scores are per game, slots in port order, before the game.
 */
const PLAYER_SCORES: Record<string, { bestOf: number; scores: number[][]; final: number[] }> = {
  // Game 1 Quill P1, Hollow P2; then Hollow P1, Quill P2. Hollow wins 1 and 4, Quill 2, 3 and 5.
  '02-bo5-3-2-charswitch': {
    bestOf: 5,
    scores: [
      [0, 0],
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 2],
    ],
    final: [2, 3],
  },
  // Game 1 Juniper P1, Marlow P2; then Marlow P1, Juniper P2. Marlow wins 1 and 3.
  '03-bo3-port-swap': {
    bestOf: 3,
    scores: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
    final: [2, 1],
  },
  // Pebble P1, Saffron P2 throughout: Pebble (by hand) 1 and 3, Saffron 2.
  '06r-reported-ties': {
    bestOf: 3,
    scores: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
    final: [2, 1],
  },
  '06z-reported-no-completedat': {
    bestOf: 3,
    scores: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
    final: [2, 1],
  },
};

/** Tags taken literally: RR's String.replace turns "$$" into "$" and "$&" into the placeholder. */
const LITERAL_TAGS: Record<string, [string, string][]> = {
  '05-gfr-edge-names': [
    ['Ca$hMoney', 'Ca$$hMoney'],
    ['Ünïcødé {playersChars} 🦊', 'Ünïcødé $& 🦊'],
  ],
  '09-e2e-de4-gfr': [
    ['Ca$hMoney', 'Ca$$hMoney'],
    ['Ünïcødé {playersChars} 🦊', 'Ünïcødé $& 🦊'],
  ],
};

/** Display names in Shift-JIS without RR's corruption: 04's tag on port 2, and port 3 left empty. */
const DISPLAY_NAMES: Record<string, { port: number; hex: string }[]> = {
  '04-sjis-long-tags': [
    { port: 1, hex: SORA },
    { port: 2, hex: '' },
  ],
};

/** The fixtures LazyTO can be in. 06 is RR's Copy button on a preview set id: LazyTO always reports, and its set ids are numeric. */
const L2 = [
  '01-bo3-2-0',
  '02-bo5-3-2-charswitch',
  '03-bo3-port-swap',
  '04-sjis-long-tags',
  '05-gfr-edge-names',
  '06r-reported-ties',
  '06z-reported-no-completedat',
  '07-bo5-3-1-fixed-ports',
  '08-e2e-de4-wf',
  '09-e2e-de4-gfr',
];

// ---- what RR wrote ----

interface Expected {
  zipName: string;
  contextSha256: string;
  games: {
    file: string;
    replay: string;
    entry: string;
    startAt: string;
    outputSha256: string;
    replaySha256: string;
  }[];
  zip: {
    eocd: { entriesTotal: number; comment: string };
    zip64: boolean;
    entries: {
      name: string;
      flags: number;
      method: number;
      versionMadeBy: number;
      versionNeeded: number;
      localVersionNeeded: number;
      internalAttributes: number;
      externalAttributes: number;
      centralExtraHex: string;
      localExtraHex: string;
      comment: string;
      dataDescriptorHex: string | null;
      crc32: string;
      uncompressedSize: number;
      dosTime: number;
      dosDate: number;
    }[];
  };
}

function expected(name: string): Expected {
  return bundleJson<Expected>('golden', name, 'expected.json');
}

function literal(name: string, s: string): string {
  for (const [rr, ours] of LITERAL_TAGS[name] ?? []) s = s.split(rr).join(ours);
  return s;
}

/** The context.json LazyTO writes: RR's, with the per-player scores and the set's best-of where they differ. */
function wantContext(name: string): Buffer {
  const golden = bundleFile('golden', name, 'context.json');
  const fix = PLAYER_SCORES[name];
  if (!fix) return golden;
  const ctx = JSON.parse(golden.toString('utf8'));
  ctx.bestOf = fix.bestOf;
  ctx.scores.forEach((s: { slots: { score: number }[] }, i: number) =>
    s.slots.forEach((slot, j) => (slot.score = fix.scores[i]![j]!)),
  );
  ctx.finalScore.slots.forEach(
    (slot: { score: number }, j: number) => (slot.score = fix.final[j]!),
  );
  return Buffer.from(JSON.stringify(ctx));
}

function gameStart(slp: Buffer): number {
  return 16 + slp[16]!;
}

/** Game i's .slp as LazyTO writes it: RR's, with the display names fixed where RR corrupts them. */
function wantSlp(name: string, i: number): Buffer {
  const out = Buffer.from(bundleFile('golden', name, `game-${i + 1}.slp`));
  for (const { port, hex } of DISPLAY_NAMES[name] ?? []) {
    const field = Buffer.alloc(31);
    Buffer.from(hex, 'hex').copy(field);
    field.copy(out, gameStart(out) + 0x1a5 + 31 * port);
  }
  return out;
}

// ---- reading a zip, every header field ----

interface ZipEntryRead {
  name: string;
  flags: number;
  method: number;
  versionMadeBy: number;
  versionNeeded: number;
  localVersionNeeded: number;
  localFlags: number;
  localMethod: number;
  internalAttributes: number;
  externalAttributes: number;
  centralExtra: number;
  localExtra: number;
  comment: number;
  disk: number;
  crc32: number;
  localCrc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localUncompressedSize: number;
  dosTime: number;
  dosDate: number;
  localDosTime: number;
  localDosDate: number;
  data: Buffer;
}

function readZip(buf: Buffer): {
  entries: ZipEntryRead[];
  count: number;
  comment: number;
  zip64: boolean;
} {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'an end of central directory');
  const count = buf.readUInt16LE(end + 10);
  assert.equal(buf.readUInt16LE(end + 8), count);
  let p = buf.readUInt32LE(end + 16);
  const entries: ZipEntryRead[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const nameLen = buf.readUInt16LE(p + 28);
    const centralExtra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const lNameLen = buf.readUInt16LE(local + 26);
    const localExtra = buf.readUInt16LE(local + 28);
    const compressedSize = buf.readUInt32LE(p + 20);
    const dataAt = local + 30 + lNameLen + localExtra;
    entries.push({
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
      versionMadeBy: buf.readUInt16LE(p + 4),
      versionNeeded: buf.readUInt16LE(p + 6),
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      dosTime: buf.readUInt16LE(p + 12),
      dosDate: buf.readUInt16LE(p + 14),
      crc32: buf.readUInt32LE(p + 16),
      compressedSize,
      uncompressedSize: buf.readUInt32LE(p + 24),
      centralExtra,
      comment,
      disk: buf.readUInt16LE(p + 34),
      internalAttributes: buf.readUInt16LE(p + 36),
      externalAttributes: buf.readUInt32LE(p + 38),
      localVersionNeeded: buf.readUInt16LE(local + 4),
      localFlags: buf.readUInt16LE(local + 6),
      localMethod: buf.readUInt16LE(local + 8),
      localDosTime: buf.readUInt16LE(local + 10),
      localDosDate: buf.readUInt16LE(local + 12),
      localCrc32: buf.readUInt32LE(local + 14),
      localUncompressedSize: buf.readUInt32LE(local + 22),
      localExtra,
      data: inflateRawSync(buf.subarray(dataAt, dataAt + compressedSize)),
    });
    p += 46 + nameLen + centralExtra + comment;
  }
  return {
    entries,
    count,
    comment: buf.readUInt16LE(end + 20),
    zip64: buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])),
  };
}

/** yazl's DOS time and date of a moment, in local time (RR's zip writer). */
function yazlDos(d: Date): { dosTime: number; dosDate: number } {
  return {
    dosDate:
      (d.getDate() & 0x1f) |
      (((d.getMonth() + 1) & 0xf) << 5) |
      (((d.getFullYear() - 1980) & 0x7f) << 9),
    dosTime:
      Math.floor(d.getSeconds() / 2) |
      ((d.getMinutes() & 0x3f) << 5) |
      ((d.getHours() & 0x1f) << 11),
  };
}

/** The first JSON path where two values differ, for a readable failure. */
function jsonDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (
    typeof a !== typeof b ||
    Array.isArray(a) !== Array.isArray(b) ||
    (a === null) !== (b === null)
  ) {
    return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  if (typeof a !== 'object' || a === null) {
    return Object.is(a, b) || a === b
      ? null
      : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.join() !== kb.join()) return `${path}: keys ${ka.join(',')} vs ${kb.join(',')}`;
  for (const k of ka) {
    const d = jsonDiff(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      `${path}.${k}`,
    );
    if (d) return d;
  }
  return null;
}

/** The byte ranges where two buffers differ, labelled by Game Start offset, for a readable failure. */
function byteDiff(a: Buffer, b: Buffer): string {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  const gs = gameStart(b);
  const out: string[] = [];
  for (let i = 0; i < a.length && out.length < 8; i++) {
    if (a[i] === b[i]) continue;
    let j = i;
    while (j < a.length && a[j] !== b[j]) j++;
    out.push(
      `${i}-${j - 1} (Game Start +0x${(i - gs).toString(16)}): ${a.subarray(i, j).toString('hex')} vs ${b.subarray(i, j).toString('hex')}`,
    );
    i = j;
  }
  return out.join('; ');
}

/** Every check against the golden: names, context.json, each .slp, the header fields. */
function checkZip(name: string, zipName: string, zip: Buffer, now: Date): void {
  const exp = expected(name);
  assert.equal(zipName, literal(name, exp.zipName), `${name}: zip name`);
  const read = readZip(zip);
  assert.equal(read.count, exp.zip.eocd.entriesTotal, `${name}: entries`);
  assert.equal(read.comment, 0);
  assert.equal(read.zip64, false);
  assert.deepEqual(
    read.entries.map((e) => e.name),
    ['context.json', ...exp.games.map((g) => literal(name, g.entry))],
    `${name}: context.json first, then the games in order`,
  );
  const ctx = wantContext(name);
  const got = read.entries[0]!.data;
  assert.ok(
    got.equals(ctx),
    `${name}: context.json differs at ${jsonDiff(JSON.parse(got.toString()), JSON.parse(ctx.toString()))}`,
  );
  exp.games.forEach((g, i) => {
    const want = wantSlp(name, i);
    const data = read.entries[i + 1]!.data;
    assert.ok(data.equals(want), `${name} game ${i + 1}: ${byteDiff(data, want)}`);
  });
  const dos = yazlDos(now);
  read.entries.forEach((e, i) => {
    const rr = exp.zip.entries.find(
      (x) => x.name === (i === 0 ? 'context.json' : exp.games[i - 1]!.entry),
    )!;
    const what = `${name} ${e.name}`;
    assert.equal(e.flags, rr.flags, `${what}: flags`);
    assert.equal(e.localFlags, rr.flags, `${what}: local flags (no data descriptor)`);
    assert.equal(rr.dataDescriptorHex, null);
    assert.equal(e.method, rr.method, `${what}: method`);
    assert.equal(e.localMethod, rr.method);
    assert.equal(e.versionMadeBy, rr.versionMadeBy, `${what}: version made by`);
    assert.equal(e.versionNeeded, rr.versionNeeded);
    assert.equal(e.localVersionNeeded, rr.localVersionNeeded);
    assert.equal(e.internalAttributes, rr.internalAttributes);
    assert.equal(e.externalAttributes, rr.externalAttributes, `${what}: external attributes`);
    assert.equal(e.centralExtra, rr.centralExtraHex.length / 2);
    assert.equal(e.localExtra, rr.localExtraHex.length / 2);
    assert.equal(e.comment, rr.comment.length);
    assert.equal(e.disk, 0);
    assert.equal(e.crc32, crc32(e.data), `${what}: crc`);
    assert.equal(e.localCrc32, e.crc32);
    assert.equal(e.uncompressedSize, e.data.length);
    assert.equal(e.localUncompressedSize, e.data.length);
    const corrected = i === 0 ? PLAYER_SCORES[name] : DISPLAY_NAMES[name];
    if (!corrected) {
      assert.equal(e.crc32.toString(16).padStart(8, '0'), rr.crc32, `${what}: RR's crc`);
      assert.equal(e.uncompressedSize, rr.uncompressedSize);
    }
    assert.deepEqual({ dosTime: e.dosTime, dosDate: e.dosDate }, dos, `${what}: entry time`);
    assert.deepEqual({ dosTime: e.localDosTime, dosDate: e.localDosDate }, dos);
    if (process.env.TZ === 'UTC') {
      assert.deepEqual(
        { dosTime: e.dosTime, dosDate: e.dosDate },
        { dosTime: rr.dosTime, dosDate: rr.dosDate },
      );
    }
  });
}

function build(name: string): { zipName: string; zip: Buffer; now: Date } {
  const now = new Date(fixture(name).clock);
  const built = buildSetZip(setZipInput(fixture(name)), now);
  return { zipName: `${built.name}.zip`, zip: built.zip, now };
}

// ---- guards ----

test('the bundle is what RR made: its commit, and every replay and output hash', () => {
  assert.match(
    readFileSync(join(BUNDLE, 'BUNDLE.md'), 'utf8'),
    /708b9c912ba92d46aa52e59cc8d91cd6d97a5d2c/,
  );
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const golden = readdirSync(join(BUNDLE, 'golden'));
  assert.deepEqual(golden.sort(), [...L2, '06-copy-button-preview-ties'].sort());
  for (const name of golden) {
    const exp = expected(name);
    assert.equal(sha(bundleFile('golden', name, 'context.json')), exp.contextSha256, name);
    exp.games.forEach((g, i) => {
      assert.equal(sha(bundleFile('replays', g.replay)), g.replaySha256, `${name} ${g.replay}`);
      assert.equal(
        sha(bundleFile('golden', name, `game-${i + 1}.slp`)),
        g.outputSha256,
        `${name} game ${i + 1}`,
      );
    });
    // The corrections rewrite RR's context.json through JSON.parse/stringify: that alone changes no byte.
    const ctx = bundleFile('golden', name, 'context.json');
    assert.ok(Buffer.from(JSON.stringify(JSON.parse(ctx.toString('utf8')))).equals(ctx), name);
  }
});

test("each correction is one RR's golden really needs", () => {
  for (const [name, fix] of Object.entries(PLAYER_SCORES)) {
    const ctx = JSON.parse(bundleFile('golden', name, 'context.json').toString());
    assert.notEqual(
      JSON.stringify([
        ctx.bestOf,
        ctx.scores.map((s: any) => s.slots.map((x: any) => x.score)),
        ctx.finalScore.slots.map((x: any) => x.score),
      ]),
      JSON.stringify([fix.bestOf, fix.scores, fix.final]),
      name,
    );
  }
  for (const [name, fixes] of Object.entries(LITERAL_TAGS)) {
    for (const [rr] of fixes) assert.ok(expected(name).zipName.includes(rr), `${name}: ${rr}`);
  }
  for (const [name, fixes] of Object.entries(DISPLAY_NAMES)) {
    expected(name).games.forEach((_, i) => {
      const slp = bundleFile('golden', name, `game-${i + 1}.slp`);
      assert.ok(
        fixes.some(({ port, hex }) => {
          const at = gameStart(slp) + 0x1a5 + 31 * port;
          const field = Buffer.alloc(31);
          Buffer.from(hex, 'hex').copy(field);
          return !slp.subarray(at, at + 31).equals(field);
        }),
        `${name} game ${i + 1}`,
      );
    });
  }
});

// ---- L1: units against RR-made vectors ----

test("L1-a: the replay reader agrees with RR's parse of every replay", () => {
  const { replays } = bundleJson<{ replays: RrReplay[] }>('parse.json');
  assert.equal(replays.length, 7);
  for (const rr of replays) {
    const info = parseSlp(bundleFile('replays', rr.fileName));
    const what = rr.fileName;
    assert.equal(info.complete, true, what);
    assert.equal(info.lastFrame, rr.lastFrame, `${what}: lastFrame (the last Frame Bookend)`);
    assert.equal(info.stage, rr.stageId, what);
    assert.equal(info.isTeams, rr.isTeams, what);
    // Nintendont's startAt is UTC without a zone: the replay_id its file is named after.
    assert.equal(new Date(`${info.startAt}Z`).toISOString(), rr.startAt, what);
    assert.equal(Date.parse(rr.startAt), replayId(rr.fileName) * 1000, what);
    info.ports.forEach((p, i) => {
      const q = rr.players[i]!;
      assert.equal(p.type, q.playerType, `${what} port ${i + 1}`);
      if (q.playerType === 0 || q.playerType === 1) {
        assert.equal(p.character, q.externalCharacterId);
        assert.equal(p.costume, q.costumeIndex);
      }
      assert.equal(p.teamId, q.teamId);
      assert.equal(p.nametag, q.nametag);
      assert.equal(p.displayName, q.displayName);
    });
  }
});

/** The display names LazyTO writes where RR corrupts them (vectors/display-names.json, by case). */
const VECTOR_FIXES: Record<number, string[]> = {
  3: ['835c8389', '8371834a838a', '93fa967b8cea', 'b1b2b3b4b5'], // ソ 835C, 本 967B kept whole
  4: ['955c945c8f5c', '815b837d', '835c', ''], // 表 能 十 ー マ ソ kept whole
  5: ['815f81608160', '8740fbfc815d', '814881488148', '5a6181486e'], // ～ 8160, ① 8740, ‐ 815D kept whole
  8: ['835c'.repeat(10) + '61', '', '', ''], // 21 bytes, not 31
  9: ['', SORA, '', ''], // 30 bytes in its own field
  10: ['', SORA, '5033', ''],
  11: ['', '', '', '835c'.repeat(15)], // 30 bytes: the connect codes stay untouched
  12: ['835c'.repeat(15), '', '43', '44'],
};

test('L1-b: display names as RR writes them, without its trail-byte remap or overflow', () => {
  const v = bundleJson<{
    replay: string;
    cases: { why: string; names: string[]; gameStartBytes0x1A5to0x249: string }[];
  }>('vectors', 'display-names.json');
  const replay = bundleFile('replays', v.replay);
  const gs = gameStart(replay);
  assert.equal(v.cases.length, 13);
  v.cases.forEach((c, i) => {
    const out = withDisplayNames(
      replay,
      c.names.map((n) => n || null),
    );
    const got = out.subarray(gs + 0x1a5, gs + 0x249).toString('hex');
    const fix = VECTOR_FIXES[i];
    const want = fix
      ? fix.map((h) => h.padEnd(62, '0')).join('') + '00'.repeat(40)
      : c.gameStartBytes0x1A5to0x249;
    assert.equal(got, want, `case ${i}: ${c.why}`);
    if (fix)
      assert.notEqual(c.gameStartBytes0x1A5to0x249, want, `case ${i} differs from RR on purpose`);
    assert.ok(out.subarray(0, gs + 0x1a5).equals(replay.subarray(0, gs + 0x1a5)), 'nothing before');
    assert.ok(out.subarray(gs + 0x249).equals(replay.subarray(gs + 0x249)), 'nothing after');
  });
});

test("L1-c: the Shift-JIS table is iconv-lite 0.6.3's, as generated", () => {
  const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'base64')).digest('hex');
  assert.equal(sha(ENCODE), '8ea86cb1ca04027e84332611c743bfe889e5dff21460720506d3dda1c8ec3c95');
  assert.equal(sha(DECODE), '7d85f264be9a2bd8d311b5b8da8ba8ba68165be9c10a6bbb68fcd4704810491a');
  assert.equal(Buffer.from(ENCODE, 'base64').length / 4, 7520, 'mappable BMP code points');
  const hex = (s: string) => sjisEncode(s).toString('hex');
  assert.equal(hex('¥'), '5c');
  assert.equal(hex('‾'), '7e');
  assert.equal(hex('～'), '8160');
  assert.equal(hex('①'), '8740');
  assert.equal(hex('髙'), 'fbfc', 'the IBM extension, not the NEC-selected one');
  assert.equal(hex('−€ü'), '3f3f3f', "U+2212 has no code (WHATWG's Shift_JIS would give 817C)");
  assert.equal(hex('a\tb\x7f'), '6109627f');
  assert.equal(hex('🦊x\ud83d'), '3f783f', 'an astral character and a lone surrogate: one ? each');
  assert.deepEqual(sjisCodes('ｱA'), [0xb1, 0x41]);
  assert.equal(sjisDecode(Buffer.from('835c8389', 'hex')), 'ソラ');
  assert.equal(
    sjisDecode(Buffer.from('8320ff41', 'hex')),
    '� �A',
    'a bad pair: U+FFFD, then the byte again',
  );
});

test('L1-d: sanitize-filename 1.6.3', () => {
  const v = bundleJson<{ cases: { input: string; output: string }[] }>('vectors', 'sanitize.json');
  assert.equal(v.cases.length, 31);
  for (const c of v.cases) assert.equal(rrSanitize(c.input), c.output, JSON.stringify(c.input));
});

test("L1-e: RR's round letters, character and stage names; placeholders filled once, literally", () => {
  const rounds = L2.map((n) => fixture(n).selectedSet.fullRoundText);
  assert.deepEqual(rounds.map(rrRoundShort), [
    'WSF',
    'LF',
    'WR1',
    'WF',
    'GFR',
    'R1',
    'R1',
    'F',
    'WF',
    'GFR',
  ]);
  assert.equal(rrRoundShort('Losers Top 8'), 'LT8');
  assert.equal(rrRoundShort('Round 1'), 'R1');
  assert.equal(RR_CHARACTER.get(3), 'GW');
  assert.equal(RR_CHARACTER.get(21), 'YL');
  assert.equal(RR_CHARACTER.get(26), undefined);
  assert.equal(RR_STAGE.get(29), "Yoshi's Island N64");
  assert.equal(RR_STAGE.get(3), 'Pokémon Stadium');
  assert.equal(rrFill('{p} - {p}', [['{p}', "Ca$$h $& $` $'"]]), "Ca$$h $& $` $' - {p}");
  // A value holding a later placeholder is filled too: RR fills the text so far.
  assert.equal(
    rrFill('{a} {b}', [
      ['{a}', '{b}!'],
      ['{b}', 'B'],
    ]),
    'B! {b}',
  );
});

test("L1-f: the re-time gives RR's start times; startAt is rewritten in place, 5 bytes longer", () => {
  for (const name of [...L2, '06-copy-button-preview-ties']) {
    const f = fixture(name);
    const exp = expected(name);
    const games = f.games.map((g) => ({
      startMs: replayId(g.replay) * 1000,
      lastFrame: rrReplay(g.replay).lastFrame,
    }));
    const completed = f.report?.updatedSetFields.completedAtMs || Date.parse(f.clock);
    const { startTimes, startMs } = retime(games, completed);
    assert.deepEqual(
      startTimes,
      exp.games.map((g) => g.startAt),
      name,
    );
    assert.equal(
      startMs,
      JSON.parse(bundleFile('golden', name, 'context.json').toString()).startMs,
      name,
    );
  }
  const replay = bundleFile('replays', 'Game_001FC5FE0637_20110202T204931.slp');
  const out = withStartAt(replay, '2026-10-03T18:53:05.631Z');
  assert.equal(out.length, replay.length + 5);
  assert.equal(parseSlp(out).startAt, '2026-10-03T18:53:05.631Z');
});

test('L1-g: ordinals as RR computes them from the REST phase group', () => {
  const dir = join(BUNDLE, 'ordinals');
  const inputs = readdirSync(dir).filter((f) => f.endsWith('.input.json'));
  assert.equal(inputs.length, 4);
  for (const f of inputs) {
    const got = rrOrdinals(bundleJson<RestPhaseGroup>('ordinals', f));
    const want = bundleJson<{ ordinals: Record<string, { ordinal: number | null }> }>(
      'ordinals',
      f.replace('.input.', '.expected.'),
    ).ordinals;
    assert.equal(
      JSON.stringify(Object.fromEntries([...got].map(([id, o]) => [id, o]))),
      JSON.stringify(Object.fromEntries(Object.entries(want).map(([id, w]) => [id, w.ordinal]))),
      f,
    );
  }
  // rr.json lists the sets RR made Set objects of (both entrants known); the
  // others have an ordinal too.
  for (const c of ['08-e2e-de4-wf', '09-e2e-de4-gfr']) {
    const pg = readdirSync(join(BUNDLE, 'rest', c)).find((f) => f.startsWith('phase_group-'))!;
    const got = rrOrdinals(bundleJson<RestPhaseGroup>('rest', c, pg));
    const rr = bundleJson<{
      ordinals: Record<string, number>;
      selectedSet: { id: number; ordinal: number };
    }>('rest', c, 'rr.json');
    for (const [id, ordinal] of Object.entries(rr.ordinals)) {
      assert.equal(JSON.stringify(got.get(Number(id))), JSON.stringify(ordinal), `${c} set ${id}`);
    }
    assert.equal(
      JSON.stringify(got.get(rr.selectedSet.id)),
      JSON.stringify(rr.selectedSet.ordinal),
      c,
    );
  }
});

test("L1-h: the REST tournament's location and event count", () => {
  for (const c of ['08-e2e-de4-wf', '09-e2e-de4-gfr']) {
    const t = bundleJson<RestTournament>('rest', c, 'tournament.json');
    const rr = bundleJson<{
      startggTournament: { location: string };
      selectedSetChain: { event: { hasSiblings: boolean } };
    }>('rest', c, 'rr.json');
    assert.equal(t.entities.tournament.locationDisplayName, rr.startggTournament.location, c);
    assert.equal(rrEventCount(t) > 1, rr.selectedSetChain.event.hasSiblings, c);
  }
});

// ---- L2: the archive's zip for every fixture ----

for (const name of L2) {
  test(`L2 ${name}: RR's zip with LazyTO's values`, () => {
    const { zipName, zip, now } = build(name);
    checkZip(name, zipName, zip, now);
  });
}

test('L2 covers every fixture LazyTO can be in', () => {
  const all = readdirSync(join(BUNDLE, 'fixtures')).map((f) => f.replace(/\.json$/, ''));
  assert.deepEqual([...L2, '06-copy-button-preview-ties'].sort(), all.sort());
});

test('L2 in two other time zones: the same zips, entry times in local time', () => {
  for (const tz of ['Asia/Tokyo', 'America/Los_Angeles']) {
    process.env.TZ = tz;
    try {
      assert.notEqual(new Date(0).getHours(), 0, `${tz} is in effect`);
      for (const name of L2) {
        const { zipName, zip, now } = build(name);
        checkZip(name, zipName, zip, now);
      }
    } finally {
      process.env.TZ = 'UTC';
    }
  }
});

// ---- L3: end to end over TCP, with the fake start.gg serving RR's REST files ----

async function endToEnd(t: { after(fn: () => unknown): void }, name: string): Promise<void> {
  const { FakeStartgg, FIXTURE_TOKEN, restPhaseGroupPath, restTournamentPath } =
    await import('./fake-startgg.js');
  const { startHarness } = await import('./harness.js');
  const { FakeBeamer } = await import('./fake-beamer.js');
  const { RelayStatus } = await import('../generated/wire.js');
  const f: Fixture = fixture(name);
  const chain = f.selectedSetChain;
  const s = f.selectedSet;
  const rest = (file: string) => bundleJson('rest', name, file);
  const tournament = rest('tournament.json') as RestTournament & {
    entities: { tournament: { id: number } };
  };
  const phases = (rest(`event-${chain.event.id}.json`) as { entities: { phase: { id: number }[] } })
    .entities.phase;
  const slug = f.startggTournament.slug;
  const updated = f.report!.updatedSetFields;
  const entrant = (id: number, p: Fixture['selectedSet']['entrant1Participants'][number]) => ({
    id,
    name: p.prefix ? `${p.prefix} | ${p.displayName}` : p.displayName,
    participants: [
      { id: p.id, gamerTag: p.displayName, prefix: p.prefix || null, pronouns: p.pronouns || null },
    ],
  });
  const fake = new FakeStartgg(
    FIXTURE_TOKEN,
    chain.event.id,
    [
      {
        id: s.id,
        state: 1,
        round: s.fullRoundText === 'Grand Final Reset' ? s.round - 1 : s.round, // start.gg's own
        fullRoundText: s.fullRoundText,
        totalGames: 3,
        slots: [
          entrant(s.entrant1Id, s.entrant1Participants[0]!),
          entrant(s.entrant2Id, s.entrant2Participants[0]!),
        ],
        games: [],
        stream: updated.stream
          ? {
              id: updated.stream.id,
              streamName: updated.stream.path,
              streamSource: updated.stream.domain.toUpperCase(),
            }
          : null,
        completedAt: updated.completedAtMs / 1000,
        phaseGroup: {
          id: chain.phaseGroup.id,
          displayIdentifier: chain.phaseGroup.name,
          bracketType: 'DOUBLE_ELIMINATION',
          wave: null,
          phase: {
            id: chain.phase.id,
            name: chain.phase.name,
            groupCount: chain.phaseGroup.hasSiblings ? 2 : 1,
            phaseOrder: 1,
          },
        },
      },
    ],
    [
      {
        slug: `tournament/${slug}`,
        shortSlug: null,
        published: false,
        startAt: null,
        id: tournament.entities.tournament.id,
        name: f.startggTournament.name,
        events: tournament.entities.event.map((e) => ({
          id: e.id,
          name: e.name,
          slug: e.slug,
          type: e.teamRosterSize === null ? 1 : 5,
          videogame: { id: e.videogameId },
          phases: e.id === chain.event.id ? phases.map((p) => ({ id: p.id })) : [{ id: 1 }],
        })),
        streams: [],
      },
    ],
  );
  const pg = readdirSync(join(BUNDLE, 'rest', name)).find((x) => x.startsWith('phase_group-'))!;
  fake.setRest(restPhaseGroupPath(chain.phaseGroup.id), rest(pg));
  fake.setRest(restTournamentPath(slug), tournament);
  await fake.start();
  const h = await startHarness({
    fake,
    tournament: `tournament/${slug}`,
    eventName: chain.event.name,
    stream: false,
    archiveClock: () => Date.parse(f.clock),
  });
  t.after(async () => {
    await h.close();
    await fake.close();
  });
  const beamer = new FakeBeamer(3, 3);
  await beamer.listen();
  t.after(() => beamer.close());
  const sync = async () => {
    await beamer.sync(h.tcpPort);
    await h.ev.collector.idle();
  };

  const wii = h.wii(3);
  const setId = s.id as number;
  assert.equal((await wii.startSet(setId)).resp.status, RelayStatus.ST_OK);
  const games = f.games.map((_, i) => gameResult(f, i));
  for (let n = 1; n <= games.length; n++) {
    beamer.add(f.games[n - 1]!.replay, bundleFile('replays', f.games[n - 1]!.replay));
    const reply =
      n < games.length
        ? await wii.reportScore(setId, games.slice(0, n))
        : await wii.endSet(setId, games.slice(0, n));
    assert.equal(reply.resp.status, RelayStatus.ST_OK, reply.resp.msg);
    await sync();
  }
  await h.ev.archive.idle();
  await sync();

  const dir = join(h.dataDir, 'archive');
  const zips = readdirSync(dir).filter((x) => x.endsWith('.zip'));
  assert.equal(zips.length, 1, `zips: ${zips.join(', ')}`);
  assert.ok(existsSync(join(dir, zips[0]!)));
  checkZip(name, zips[0]!, readFileSync(join(dir, zips[0]!)), new Date(f.clock));
  const audit = h.auditEvents();
  assert.deepEqual(
    audit.filter((a) => a.type === 'archive_mismatch'),
    [],
    'the reports agree with the replays',
  );
  assert.deepEqual(
    audit.filter((a) => a.call === 'phase_group').map((a) => [a.phaseGroupId, a.ok]),
    [[chain.phaseGroup.id, true]],
  );
  // RR's REST requests, less the event and phase reads LazyTO answers from GraphQL.
  const rr = rest('rr.json') as { requests: string[] };
  assert.deepEqual(
    fake.restCalls.map((c) => c.path),
    rr.requests
      .filter((r) => r.startsWith('GET ') && !/\/(event|phase)\//.test(r))
      .map((r) => r.slice('GET https://api.start.gg'.length)),
  );
}

test('L3 08-e2e-de4-wf: START_SET, reports and END_SET over TCP, REST from the fake, the zip as RR wrote it', async (t) => {
  await endToEnd(t, '08-e2e-de4-wf');
});

test('L3 09-e2e-de4-gfr: the grand final reset on stream, with its ordinal, round and literal tags', async (t) => {
  await endToEnd(t, '09-e2e-de4-gfr');
});
