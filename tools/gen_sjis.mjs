#!/usr/bin/env node
// gen_sjis.mjs -- generate generated/sjis.ts, the Shift-JIS tables the set
// archive (src/sjis.ts) writes and reads replay display names with, from the
// iconv-lite 0.6.3 "Shift_JIS" codec Replay Reporter for Slippi uses
// (iconv.encode/decode in its src/main/replay.ts). The relay has no runtime
// dependencies, so the mapping is committed as a static table, generated
// here and never edited by hand.
//
// iconv-lite's Shift_JIS is the cp932 table (encodings/tables/shiftjis.json)
// with encodeAdd {U+00A5: 0x5C, U+203E: 0x7E} and the NEC-selected IBM
// extensions 0xED40-0xF940 skipped when encoding. It is not WHATWG's
// Shift_JIS (that one encodes U+2212 as 0x817C; iconv-lite has no mapping).
//
// Usage (iconv-lite is not a LazyTO dependency; install the exact version
// somewhere else, with its one dependency, safer-buffer):
//     npm install --no-save --prefix <temp folder> iconv-lite@0.6.3
//     node tools/gen_sjis.mjs <temp folder>/node_modules/iconv-lite
//
// The tables:
//   ENCODE  every BMP code point (surrogates aside) iconv-lite encodes to
//           something other than its "?" for an unmappable character, as
//           big-endian u16 pairs (code point, Shift-JIS code; a code below
//           0x100 is one byte), in code point order. U+003F itself is in it.
//   DECODE  iconv-lite's decode trie for Shift_JIS: 256 big-endian u16 for
//           the first byte (the character, 0xFFFF unassigned, 0xFFFE a lead
//           byte), then (code, character) u16 pairs for every assigned
//           two-byte code, in code order.
// Both are base64. The script checks the tables against iconv-lite itself
// (every BMP character encoded alone, every one- and two-byte sequence and a
// few thousand random strings decoded) before it writes anything.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'generated', 'sjis.ts');
const VERSION = '0.6.3';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/gen_sjis.mjs <iconv-lite 0.6.3 package folder>');
  process.exit(2);
}
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
if (pkg.name !== 'iconv-lite' || pkg.version !== VERSION) {
  console.error(`need iconv-lite ${VERSION}, found ${pkg.name} ${pkg.version}`);
  process.exit(2);
}
const iconv = createRequire(join(resolve(dir), 'package.json'))('./lib/index.js');

// ---- encode ----

const encodePairs = [];
for (let cp = 0; cp <= 0xffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const b = iconv.encode(String.fromCharCode(cp), 'Shift_JIS');
  if (b.length === 1 && b[0] === 0x3f && cp !== 0x3f) continue; // unmappable
  if (b.length !== 1 && b.length !== 2) throw new Error(`U+${cp.toString(16)}: ${b.length} bytes`);
  encodePairs.push([cp, b.length === 1 ? b[0] : (b[0] << 8) | b[1]]);
}

// ---- decode: iconv-lite's own trie for the codec ----

const codec = iconv.getCodec('Shift_JIS');
const tables = codec.decodeTables;
const UNASSIGNED = -1;
const NODE_START = -1000;
const first = [];
const second = [];
for (let b = 0; b < 256; b++) {
  const v = tables[0][b];
  if (v === UNASSIGNED) first.push(0xffff);
  else if (v <= NODE_START) {
    first.push(0xfffe);
    const node = tables[NODE_START - v];
    for (let t = 0; t < 256; t++) {
      const c = node[t];
      if (c === UNASSIGNED) continue;
      if (c < 0 || c > 0xfffd) throw new Error(`unexpected trie value ${c} at ${b}/${t}`);
      second.push([(b << 8) | t, c]);
    }
  } else if (v >= 0 && v <= 0xfffd) first.push(v);
  else throw new Error(`unexpected trie value ${v} at ${b}`);
}

// ---- the same algorithms src/sjis.ts uses, checked against iconv-lite ----

const encodeMap = new Map(encodePairs);
function encode(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++; // an astral character: one "?"
    }
    const code = c >= 0xd800 && c <= 0xdfff ? undefined : encodeMap.get(c);
    if (code === undefined) out.push(0x3f);
    else if (code < 0x100) out.push(code);
    else out.push(code >> 8, code & 0xff);
  }
  return Buffer.from(out);
}
const pairMap = new Map(second);
function decode(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    const v = first[buf[i]];
    if (v === 0xfffe) {
      const c = i + 1 < buf.length ? pairMap.get((buf[i] << 8) | buf[i + 1]) : undefined;
      if (c === undefined)
        s += '�'; // the next byte is read again on its own
      else {
        s += String.fromCharCode(c);
        i++;
      }
    } else s += v === 0xffff ? '�' : String.fromCharCode(v);
  }
  return s;
}

let checked = 0;
for (let cp = 0; cp <= 0xffff; cp++) {
  const s = String.fromCharCode(cp);
  if (!encode(s).equals(iconv.encode(s, 'Shift_JIS')))
    throw new Error(`encode U+${cp.toString(16)}`);
  checked++;
}
for (let a = 0; a < 256; a++) {
  if (decode(Buffer.from([a])) !== iconv.decode(Buffer.from([a]), 'Shift_JIS')) {
    throw new Error(`decode ${a.toString(16)}`);
  }
  for (let b = 0; b < 256; b++) {
    const buf = Buffer.from([a, b]);
    if (decode(buf) !== iconv.decode(buf, 'Shift_JIS'))
      throw new Error(`decode ${buf.toString('hex')}`);
    checked++;
  }
}
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) / 65536;
for (let n = 0; n < 4000; n++) {
  const len = 1 + Math.floor(rand() * 20);
  const units = [];
  for (let k = 0; k < len; k++) {
    const pick = rand();
    units.push(
      pick < 0.3
        ? 0x20 + Math.floor(rand() * 0x60)
        : pick < 0.5
          ? 0xd800 + Math.floor(rand() * 0x800) // surrogates, paired or not
          : Math.floor(rand() * 0x10000),
    );
  }
  const s = String.fromCharCode(...units);
  if (!encode(s).equals(iconv.encode(s, 'Shift_JIS')))
    throw new Error(`encode ${JSON.stringify(s)}`);
  const bytes = Buffer.from(Array.from({ length: len }, () => Math.floor(rand() * 256)));
  if (decode(bytes) !== iconv.decode(bytes, 'Shift_JIS')) {
    throw new Error(`decode ${bytes.toString('hex')}`);
  }
  checked += 2;
}

// ---- write ----

function u16(values) {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeUInt16BE(v, i * 2));
  return b;
}
const encodeBin = u16(encodePairs.flat());
const decodeBin = Buffer.concat([u16(first), u16(second.flat())]);
const lines = (b) =>
  b
    .toString('base64')
    .match(/.{1,100}/g)
    .map((l) => `  '${l}'`)
    .join(' +\n');
const sha = (b) => createHash('sha256').update(b).digest('hex');

writeFileSync(
  OUT,
  `// GENERATED by tools/gen_sjis.mjs from iconv-lite ${VERSION} (MIT) -- DO NOT EDIT.
// The Shift_JIS mapping Replay Reporter for Slippi writes and reads replay
// display names with; src/sjis.ts uses it. Formats: tools/gen_sjis.mjs.
// ${encodePairs.length} encodable BMP code points, ${second.length} two-byte codes.
// sha256 of the decoded tables: ENCODE ${sha(encodeBin)}, DECODE ${sha(decodeBin)}

export const ENCODE =
${lines(encodeBin)};

export const DECODE =
${lines(decodeBin)};
`,
);
console.log(
  `wrote ${OUT}: ${encodePairs.length} encodable code points, ${second.length} two-byte codes; ` +
    `${checked} checks against iconv-lite ${VERSION} passed`,
);
console.log(`ENCODE sha256 ${sha(encodeBin)}`);
console.log(`DECODE sha256 ${sha(decodeBin)}`);
