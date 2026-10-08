// sjis.ts -- Shift-JIS exactly as Replay Reporter for Slippi encodes and
// decodes replay display names and nametags (iconv-lite 0.6.3, "Shift_JIS",
// the cp932 table), from the static tables tools/gen_sjis.mjs generates into
// generated/sjis.ts. Node has no Shift-JIS codec and the relay has no
// dependencies.
//
// Encoding works per UTF-16 unit like iconv-lite: a character the table
// lacks, an astral character (a surrogate pair) and a lone surrogate each
// become one "?" (0x3F); control characters and DEL pass through. Decoding
// follows iconv-lite's trie: an unassigned byte, or a lead byte whose pair is
// unassigned, is U+FFFD, and the byte after such a lead byte is read again
// on its own.

import { DECODE, ENCODE } from '../generated/sjis.js';

const UNMAPPED = -1;

/** Code point -> Shift-JIS code (one byte below 0x100), or UNMAPPED. */
const encodeTable = (() => {
  const t = new Int32Array(0x10000).fill(UNMAPPED);
  const b = Buffer.from(ENCODE, 'base64');
  for (let i = 0; i < b.length; i += 4) t[b.readUInt16BE(i)] = b.readUInt16BE(i + 2);
  return t;
})();

const LEAD = 0xfffe;
const UNASSIGNED = 0xffff;

/** First byte -> character, LEAD or UNASSIGNED; two-byte code -> character or UNMAPPED. */
const [firstByte, twoBytes] = (() => {
  const b = Buffer.from(DECODE, 'base64');
  const first = new Uint16Array(256);
  for (let i = 0; i < 256; i++) first[i] = b.readUInt16BE(i * 2);
  const pairs = new Int32Array(0x10000).fill(UNMAPPED);
  for (let i = 512; i < b.length; i += 4) pairs[b.readUInt16BE(i)] = b.readUInt16BE(i + 2);
  return [first, pairs];
})();

/** One Shift-JIS code per character of s (below 0x100: one byte, else two); "?" (0x3F) for what has none. */
export function sjisCodes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      // A pair is one astral character, which no table entry covers: one "?".
      const next = s.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) i++;
      out.push(0x3f);
      continue;
    }
    const code = encodeTable[c]!;
    out.push(code === UNMAPPED ? 0x3f : code);
  }
  return out;
}

/** s in Shift-JIS bytes, as iconv-lite's encode(s, 'Shift_JIS'). */
export function sjisEncode(s: string): Buffer {
  return Buffer.from(sjisCodes(s).flatMap((c) => (c < 0x100 ? [c] : [c >> 8, c & 0xff])));
}

/** Shift-JIS bytes as text, as iconv-lite's decode(buf, 'Shift_JIS'). */
export function sjisDecode(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    const v = firstByte[buf[i]!]!;
    if (v === LEAD) {
      const c = i + 1 < buf.length ? twoBytes[(buf[i]! << 8) | buf[i + 1]!]! : UNMAPPED;
      if (c === UNMAPPED) {
        s += '�'; // the next byte is read again on its own
      } else {
        s += String.fromCharCode(c);
        i++;
      }
    } else {
      s += v === UNASSIGNED ? '�' : String.fromCharCode(v);
    }
  }
  return s;
}
