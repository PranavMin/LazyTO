// zip.ts -- a minimal ZIP writer for the SD-card zips (cards.ts) and the set
// archives (archive.ts): deflated entries, UTF-8 names, no ZIP64 (a card's
// files or a set's replays are a few MB). The relay has no dependencies beyond
// Node, and Node has deflate but no zip.
// Format: PKWARE APPNOTE.TXT sections 4.3.7 (local header), 4.3.12 (central
// directory header) and 4.3.16 (end of central directory). The header fields
// are the ones yazl 2.5.1 writes, the zip library Replay Reporter for Slippi
// builds its set zips with, so a set archive's headers equal Replay
// Reporter's: version made by 3.63 (Unix), mode 0664 regular file, no data
// descriptors, extras or comments, and its DOS time and date (local time).

import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
  date?: Date; // modification time; defaults to now
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** yazl's dateToDosDateTime: local time, 2-second resolution, each field masked to its bits. */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time:
      ((d.getHours() & 0x1f) << 11) |
      ((d.getMinutes() & 0x3f) << 5) |
      Math.floor(d.getSeconds() / 2),
    date:
      (((d.getFullYear() - 1980) & 0x7f) << 9) |
      (((d.getMonth() + 1) & 0xf) << 5) |
      (d.getDate() & 0x1f),
  };
}

const FLAG_UTF8 = 0x0800;
const METHOD_DEFLATE = 8;
const VERSION_MADE_BY = (3 << 8) | 63; // Unix, spec 6.3
const VERSION_NEEDED = 20; // 2.0: deflate
const EXTERNAL_ATTRIBUTES = (0o100664 << 16) >>> 0; // a regular file, rw-rw-r--

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const packed = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const { time, date } = dosTime(e.date ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    parts.push(local, name, packed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(VERSION_MADE_BY, 4);
    cd.writeUInt16LE(VERSION_NEEDED, 6);
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(METHOD_DEFLATE, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    // extra, comment, disk start, internal attributes: 0
    cd.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + packed.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
