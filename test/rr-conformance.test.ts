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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECODE, ENCODE } from '../generated/sjis.js';
import { sjisCodes, sjisDecode, sjisEncode } from '../src/sjis.js';
import { parseSlp, withDisplayNames } from '../src/slp.js';
import { BUNDLE, bundleFile, bundleJson, replayId, type RrReplay } from './rr-adapter.js';

/**
 * ソラとヒカリのスーパーマリオブ (the first 15 characters of a fixture's tag) is
 * 30 bytes in Shift-JIS. RR remaps the trail bytes 5C, 5B and 7D of ソ, ー, ー
 * and マ, gets 34 and spills 49 83 75 into the next port's field.
 */
const SORA = '835c838982c68371834a838a82cc8358815b8370815b837d838a83498375';

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

function gameStart(slp: Buffer): number {
  return 16 + slp[16]!;
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
