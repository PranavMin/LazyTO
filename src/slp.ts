// slp.ts -- what the set archive (archive.ts) reads from a Slippi replay
// (.slp) and the two changes it makes to one, both as Replay Reporter for
// Slippi does when it copies a set (its src/main/replay.ts, getReplaysInDir
// and writeReplays, v2.7.0): the players' tags in the display-name fields,
// and metadata.startAt re-timed to the set's report.
//
// A .slp is UBJSON: {"raw": [bytes], "metadata": {...}}. The raw element
// starts at byte 15 ('{', 'U', 3, "raw", '[', '$', 'U', '#', 'l', u32 length;
// the length is 0 in a file whose writer never finished it). raw[0] is the
// Event Payloads command (0x35): raw[1] is its payload size, then one
// (command, u16 size) triple per event; the Game Start command (0x36)
// follows it. Offsets below are from the Game Start command byte, as in the
// Slippi spec (project-slippi/slippi-wiki, SPEC.md):
//   0x01 version (u32: major, minor, build, 0)   0x0D teams flag
//   0x13 stage (u16)                             0x65 + 0x24*i external character id
//   0x66 + 0x24*i player type (0 human, 1 CPU)  0x68 + 0x24*i costume index
//   0x6E + 0x24*i team id (teams only)          0x161 + 0x10*i nametag (Shift-JIS, 16)
//   0x1A5 + 0x1F*i display name (Shift-JIS, 31; empty in a Wii replay)
// A finished replay ends its raw element with the last frame's Frame
// Bookend (0x3C, the frame number at +1) and then Game End (0x39); its
// metadata carries startAt, which Nintendont writes without a time zone.
//
// Replay Reporter refuses replays older than Slippi 3.13.0, and so does this.
// It counts a CPU (player type 1) as a player everywhere, and so does this.

import { sjisCodes, sjisDecode } from './sjis.js';

export const RAW_OFFSET = 15;
const CMD_EVENT_PAYLOADS = 0x35;
const CMD_GAME_START = 0x36;
const CMD_POST_FRAME = 0x38;
const CMD_GAME_END = 0x39;
const CMD_FRAME_BOOKEND = 0x3c;
// Post-frame update: player index at 0x05, is-follower at 0x06, stocks remaining at 0x21.
const POST_PLAYER = 0x05;
const POST_FOLLOWER = 0x06;
const POST_STOCKS = 0x21;
const MIN_VERSION = 0x030d0000; // 3.13.0, Replay Reporter's floor (placements)
const NAMETAG_OFFSET = 0x161;
const NAMETAG_LEN = 16;
const DISPLAY_NAME_OFFSET = 0x1a5;
const DISPLAY_NAME_LEN = 31;
const DISPLAY_NAME_UNITS = 15; // Replay Reporter's cut: 15 UTF-16 units, the in-game limit

export interface SlpPort {
  port: number; // 0-3
  character: number; // external character id
  costume: number;
  type: number; // 0 human, 1 CPU, 2 demo, 3 empty
  teamId: number; // -1 unless a teams game
  nametag: string; // "" for none
  displayName: string; // "" for none (always, in a Wii replay)
}

export interface SlpInfo {
  version: [number, number, number];
  isTeams: boolean;
  stage: number; // Slippi's stage id (31 Battlefield, 32 Final Destination)
  ports: SlpPort[]; // all four, in port order
  /** The last Frame Bookend's frame number; null when the replay is not complete. */
  lastFrame: number | null;
  /** metadata.startAt as written (Nintendont: "2011-02-02T20:49:31", UTC without a zone); null when absent. */
  startAt: string | null;
  gameStartOffset: number; // byte offset of the Game Start command in the file
  gameStartSize: number; // payload size, without the command byte
  /**
   * Finished: the header's raw length is set and covered by the file, the
   * events end with the last frame's Frame Bookend and a Game End, and the
   * metadata has startAt. An interrupted recording (raw length 0, or cut
   * short) is not, and is no replay for Lucky Stats.
   */
  complete: boolean;
  /** Stocks remaining per port (0-3) at the last post-frame update; null for a port with none. */
  stocks: (number | null)[];
}

export class SlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlpError';
  }
}

const HEADER = Buffer.from([0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c]); // {U\x03raw[$U#l
const START_AT_TAG = Buffer.from([
  0x55, 0x07, 0x73, 0x74, 0x61, 0x72, 0x74, 0x41, 0x74, 0x53, 0x55,
]); // U\x07startAtSU, then a u8 length and the string

/** Shift-JIS text up to its first NUL, as Replay Reporter reads names. */
function sjisField(b: Uint8Array): string {
  return sjisDecode(b).split('\0')[0]!;
}

export function parseSlp(buf: Buffer): SlpInfo {
  if (buf.length < RAW_OFFSET + 2 || !buf.subarray(0, HEADER.length).equals(HEADER)) {
    throw new SlpError('not a .slp file');
  }
  if (buf[RAW_OFFSET] !== CMD_EVENT_PAYLOADS) throw new SlpError('no Event Payloads command');
  const payloadsSize = buf[RAW_OFFSET + 1]!;
  const sizes = new Map<number, number>();
  for (let i = RAW_OFFSET + 2; i + 2 < RAW_OFFSET + 1 + payloadsSize; i += 3) {
    const size = buf.readUInt16BE(i + 1);
    if (size === 0) throw new SlpError('an event payload size is 0');
    sizes.set(buf[i]!, size);
  }
  const gameStartSize = sizes.get(CMD_GAME_START);
  const gs = RAW_OFFSET + 1 + payloadsSize;
  if (gameStartSize === undefined || buf[gs] !== CMD_GAME_START)
    throw new SlpError('no Game Start event');
  if (gs + 1 + gameStartSize > buf.length) throw new SlpError('Game Start cut short');
  const version = buf.readUInt32BE(gs + 1);
  if (version < MIN_VERSION || gameStartSize + 1 < DISPLAY_NAME_OFFSET + 4 * DISPLAY_NAME_LEN) {
    throw new SlpError(
      `replay version ${buf[gs + 1]}.${buf[gs + 2]}.${buf[gs + 3]} is older than 3.13.0`,
    );
  }
  const isTeams = buf[gs + 0x0d] === 1;
  const ports: SlpPort[] = [];
  for (let i = 0; i < 4; i++) {
    const tag = gs + NAMETAG_OFFSET + NAMETAG_LEN * i;
    const name = gs + DISPLAY_NAME_OFFSET + DISPLAY_NAME_LEN * i;
    ports.push({
      port: i,
      character: buf[gs + 0x65 + 0x24 * i]!,
      type: buf[gs + 0x66 + 0x24 * i]!,
      costume: buf[gs + 0x68 + 0x24 * i]!,
      teamId: isTeams ? buf[gs + 0x6e + 0x24 * i]! : -1,
      nametag: sjisField(buf.subarray(tag, tag + NAMETAG_LEN)),
      displayName: sjisField(buf.subarray(name, name + DISPLAY_NAME_LEN)),
    });
  }
  const end = lastFrameAndStartAt(buf, sizes);
  const events = walkEvents(buf, gs, sizes);
  return {
    version: [buf[gs + 1]!, buf[gs + 2]!, buf[gs + 3]!],
    isTeams,
    stage: buf.readUInt16BE(gs + 0x13),
    ports,
    lastFrame: end.lastFrame,
    startAt: end.startAt,
    gameStartOffset: gs,
    gameStartSize,
    complete: events.gameEnd && end.lastFrame !== null && end.startAt !== null,
    stocks: events.stocks,
  };
}

/**
 * Replay Reporter's way to the end of a finished replay: by offsets back from
 * the metadata, never by walking the events. Game End sits right before the
 * metadata and the last Frame Bookend right before Game End. Both null for a
 * file whose raw length is 0 or past its end, or that ends otherwise.
 */
function lastFrameAndStartAt(
  buf: Buffer,
  sizes: Map<number, number>,
): { lastFrame: number | null; startAt: string | null } {
  const rawLength = buf.readUInt32BE(RAW_OFFSET - 4);
  const metadataOffset = RAW_OFFSET + rawLength;
  const gameEndSize = sizes.get(CMD_GAME_END);
  const bookendSize = sizes.get(CMD_FRAME_BOOKEND);
  if (rawLength === 0 || metadataOffset > buf.length || !gameEndSize || !bookendSize) {
    return { lastFrame: null, startAt: null };
  }
  const gameEnd = metadataOffset - (gameEndSize + 1);
  const bookend = gameEnd - (bookendSize + 1);
  const finished =
    bookend > RAW_OFFSET && buf[gameEnd] === CMD_GAME_END && buf[bookend] === CMD_FRAME_BOOKEND;
  const meta = buf.subarray(metadataOffset);
  const tag = meta.indexOf(START_AT_TAG);
  const len = tag >= 0 ? meta[tag + START_AT_TAG.length] : undefined;
  const from = tag + START_AT_TAG.length + 1;
  return {
    lastFrame: finished ? buf.readInt32BE(bookend + 1) : null,
    startAt:
      len !== undefined && from + len <= meta.length
        ? meta.subarray(from, from + len).toString('latin1')
        : null,
  };
}

/**
 * Walk the raw element's events by the Event Payloads sizes: whether it ends
 * with a Game End inside a raw length the file covers, and each port's last
 * stock count (for the content check). Stops at an unknown command (a
 * cut-off file).
 */
function walkEvents(
  buf: Buffer,
  gs: number,
  sizes: Map<number, number>,
): { gameEnd: boolean; stocks: (number | null)[] } {
  const rawLength = buf.readUInt32BE(RAW_OFFSET - 4);
  const covered = rawLength > 0 && RAW_OFFSET + rawLength <= buf.length;
  const end = covered ? RAW_OFFSET + rawLength : buf.length;
  const stocks: (number | null)[] = [null, null, null, null];
  let last = -1;
  let pos = gs;
  while (pos < end) {
    const size = sizes.get(buf[pos]!);
    if (size === undefined || pos + 1 + size > end) break;
    last = buf[pos]!;
    if (last === CMD_POST_FRAME && size >= POST_STOCKS) {
      const port = buf[pos + POST_PLAYER]!;
      if (port < 4 && buf[pos + POST_FOLLOWER] === 0) stocks[port] = buf[pos + POST_STOCKS]!;
    }
    pos += 1 + size;
  }
  return { gameEnd: covered && pos === end && last === CMD_GAME_END, stocks };
}

/** Ports with a player on them (human or CPU), in port order. */
export function playerPorts(info: SlpInfo): SlpPort[] {
  return info.ports.filter((p) => p.type === 0 || p.type === 1);
}

// Replay Reporter's narrowSpecialChars: these ASCII punctuation characters
// become their full-width Shift-JIS forms in display names (the game's font
// draws the half-width ones wrong or not at all).
const FULL_WIDTH = new Map<number, [number, number]>([
  [0x21, [0x81, 0x49]],
  [0x22, [0x81, 0x68]],
  [0x23, [0x81, 0x94]],
  [0x24, [0x81, 0x90]],
  [0x25, [0x81, 0x93]],
  [0x26, [0x81, 0x95]],
  [0x27, [0x81, 0x66]],
  [0x28, [0x81, 0x69]],
  [0x29, [0x81, 0x6a]],
  [0x2a, [0x81, 0x96]],
  [0x2b, [0x81, 0x7b]],
  [0x2c, [0x81, 0x43]],
  [0x2d, [0x81, 0x7c]],
  [0x2e, [0x81, 0x44]],
  [0x2f, [0x81, 0x5e]],
  [0x3a, [0x81, 0x46]],
  [0x3b, [0x81, 0x47]],
  [0x3c, [0x81, 0x83]],
  [0x3d, [0x81, 0x81]],
  [0x3e, [0x81, 0x84]],
  [0x3f, [0x81, 0x48]],
  [0x40, [0x81, 0x97]],
  [0x5b, [0x81, 0x6d]],
  [0x5c, [0x81, 0x5f]],
  [0x5d, [0x81, 0x6e]],
  [0x5e, [0x81, 0x4f]],
  [0x5f, [0x81, 0x51]],
  [0x60, [0x81, 0x4d]],
  [0x7b, [0x81, 0x6f]],
  [0x7c, [0x81, 0x62]],
  [0x7d, [0x81, 0x70]],
  [0x7e, [0x81, 0x60]],
]);

/**
 * A tag as a 31-byte display name, the way Replay Reporter writes it: the
 * first 15 UTF-16 units, Shift-JIS (iconv-lite's cp932: "?" for what it
 * cannot encode), ASCII punctuation full-width, zero-padded.
 *
 * Two of Replay Reporter's bugs are left out (docs/redesign.md, The zip and
 * Lucky Stats): it maps every byte through the full-width table, so the
 * second byte of a double-byte character in the punctuation range is
 * rewritten too (ソ 83 5C becomes 83 81 5F) and the name is corrupted; here
 * only a single-byte character is. And it writes the name whatever its
 * length, into the next port's field; here it is cut between characters to
 * fit its own 31 bytes (15 units of two bytes at most fill 30 of them).
 */
export function displayNameBytes(tag: string): Buffer {
  const out: number[] = [];
  for (const code of sjisCodes(tag.slice(0, DISPLAY_NAME_UNITS))) {
    const bytes = code < 0x100 ? (FULL_WIDTH.get(code) ?? [code]) : [code >> 8, code & 0xff];
    if (out.length + bytes.length > DISPLAY_NAME_LEN) break;
    out.push(...bytes);
  }
  const b = Buffer.alloc(DISPLAY_NAME_LEN);
  Buffer.from(out).copy(b);
  return b;
}

/** A copy of the replay with display names written per port (null leaves a port as it is). */
export function withDisplayNames(buf: Buffer, names: readonly (string | null)[]): Buffer {
  const info = parseSlp(buf);
  const out = Buffer.from(buf);
  for (let i = 0; i < 4; i++) {
    const name = names[i];
    if (name)
      displayNameBytes(name).copy(
        out,
        info.gameStartOffset + DISPLAY_NAME_OFFSET + DISPLAY_NAME_LEN * i,
      );
  }
  return out;
}

/**
 * A copy of the replay with metadata.startAt replaced by `iso` (Replay
 * Reporter's re-timed start, 24 characters): its length byte and string, the
 * rest byte for byte, so the file grows by 24 - the old length (5 for
 * Nintendont's). A replay without startAt is never complete, so never here.
 */
export function withStartAt(buf: Buffer, iso: string): Buffer {
  const metadataOffset = RAW_OFFSET + buf.readUInt32BE(RAW_OFFSET - 4);
  const tag = buf.indexOf(START_AT_TAG, metadataOffset);
  if (tag < 0) throw new SlpError('no metadata.startAt');
  const lengthAt = tag + START_AT_TAG.length;
  const oldLength = buf[lengthAt]!;
  return Buffer.concat([
    buf.subarray(0, lengthAt),
    Buffer.from([iso.length]),
    Buffer.from(iso, 'latin1'),
    buf.subarray(lengthAt + 1 + oldLength),
  ]);
}
