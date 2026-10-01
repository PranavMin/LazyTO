// slp.ts -- the little of a Slippi replay (.slp) the set archive needs
// (archive.ts): who played on which port with what, the stage, the length,
// and writing the players' tags into the replay's display-name fields.
//
// A .slp is UBJSON: {"raw": [bytes], "metadata": {...}}. The raw element
// starts at byte 15 ('{', 'U', 3, "raw", '[', '$', 'U', '#', 'l', u32 length;
// the length is 0 in a file whose writer never finished it). raw[0] is the
// Event Payloads command (0x35): raw[1] is its payload size, then one
// (command, u16 size) triple per event; the Game Start command (0x36)
// follows it. Offsets below are from the Game Start command byte, as in the
// Slippi spec (project-slippi/slippi-wiki, SPEC.md):
//   0x01 version (major, minor, build)      0x13 stage (u16, internal StKind)
//   0x65 + 0x24*i external character id     0x66 + 0x24*i player type (0 human)
//   0x68 + 0x24*i costume index             0x161 + 0x10*i nametag
//   0x1A5 + 0x1F*i display name (3.9.0+, Shift-JIS, 31 bytes)
// Replay Reporter for Slippi stamps display names the same way when it copies
// a set (src/main/replay.ts writeReplays); Wii replays carry them empty.

export const RAW_OFFSET = 15;
const CMD_EVENT_PAYLOADS = 0x35;
const CMD_GAME_START = 0x36;
const DISPLAY_NAME_OFFSET = 0x1a5;
const DISPLAY_NAME_LEN = 31;
const DISPLAY_NAME_CHARS = 15; // the in-game limit; full-width characters take 2 bytes each

export interface SlpPort {
  port: number; // 0-3
  character: number; // external character id
  costume: number;
  type: number; // 0 human, 1 CPU, 2 demo, 3 empty
}

export interface SlpInfo {
  version: [number, number, number];
  stage: number; // internal StKind
  ports: SlpPort[]; // all four, in port order
  lastFrame: number | null; // from the metadata; null when the file has none
  gameStartOffset: number; // byte offset of the Game Start command in the file
  gameStartSize: number; // payload size, without the command byte
}

export class SlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlpError';
  }
}

const HEADER = Buffer.from([0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c]); // {U\x03raw[$U#l
const LAST_FRAME_KEY = Buffer.from([
  0x55, 0x09, 0x6c, 0x61, 0x73, 0x74, 0x46, 0x72, 0x61, 0x6d, 0x65, 0x6c,
]); // U\x09lastFramel

export function parseSlp(buf: Buffer): SlpInfo {
  if (buf.length < RAW_OFFSET + 2 || !buf.subarray(0, HEADER.length).equals(HEADER)) {
    throw new SlpError('not a .slp file');
  }
  if (buf[RAW_OFFSET] !== CMD_EVENT_PAYLOADS) throw new SlpError('no Event Payloads command');
  const payloadsSize = buf[RAW_OFFSET + 1]!;
  let gameStartSize: number | undefined;
  for (let i = RAW_OFFSET + 2; i + 2 < RAW_OFFSET + 1 + payloadsSize; i += 3) {
    if (buf[i] === CMD_GAME_START) gameStartSize = buf.readUInt16BE(i + 1);
  }
  const gs = RAW_OFFSET + 1 + payloadsSize;
  if (gameStartSize === undefined || buf[gs] !== CMD_GAME_START)
    throw new SlpError('no Game Start event');
  if (
    gameStartSize + 1 < DISPLAY_NAME_OFFSET + 4 * DISPLAY_NAME_LEN ||
    gs + 1 + gameStartSize > buf.length
  ) {
    throw new SlpError(
      `Game Start too short (${gameStartSize} bytes; replays older than 3.9.0 are not supported)`,
    );
  }
  const ports: SlpPort[] = [];
  for (let i = 0; i < 4; i++) {
    ports.push({
      port: i,
      character: buf[gs + 0x65 + 0x24 * i]!,
      type: buf[gs + 0x66 + 0x24 * i]!,
      costume: buf[gs + 0x68 + 0x24 * i]!,
    });
  }
  const lf = buf.lastIndexOf(LAST_FRAME_KEY);
  return {
    version: [buf[gs + 1]!, buf[gs + 2]!, buf[gs + 3]!],
    stage: buf.readUInt16BE(gs + 0x13),
    ports,
    lastFrame:
      lf >= 0 && lf + LAST_FRAME_KEY.length + 4 <= buf.length
        ? buf.readInt32BE(lf + LAST_FRAME_KEY.length)
        : null,
    gameStartOffset: gs,
    gameStartSize,
  };
}

/** Human ports (player type 0), in port order. */
export function humanPorts(info: SlpInfo): SlpPort[] {
  return info.ports.filter((p) => p.type === 0);
}

// Replay Reporter's narrowSpecialChars: these ASCII punctuation bytes become
// their full-width Shift-JIS forms in display names (the game's font draws
// the half-width ones wrong or not at all).
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
 * A tag as a 31-byte Shift-JIS display name. Letters, digits and spaces stay
 * single-byte, the punctuation above goes full-width; Node has no Shift-JIS
 * encoder, so anything outside ASCII becomes '?'.
 */
export function displayNameBytes(tag: string): Buffer {
  const out: number[] = [];
  for (const ch of [...tag].slice(0, DISPLAY_NAME_CHARS)) {
    const c = ch.codePointAt(0)!;
    const wide = FULL_WIDTH.get(c);
    if (wide) out.push(...wide);
    else if (c >= 0x20 && c < 0x7f) out.push(c);
    else out.push(0x3f);
  }
  const b = Buffer.alloc(DISPLAY_NAME_LEN);
  Buffer.from(out.slice(0, DISPLAY_NAME_LEN - 1)).copy(b);
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
