// Synthetic .slp files for the archive tests: just enough of the format for
// src/slp.ts (Event Payloads, a 3.13-sized Game Start, a Game End, metadata
// with lastFrame), shaped like a Wii (Nintendont) replay.

const GAME_START_SIZE = 0x2bc; // payload bytes after the command byte, as Nintendont 3.13 writes

export interface FixturePort {
  character: number; // external id
  costume: number;
}

/** ports: index = port 0-3; null = empty. */
export function makeSlp(opts: {
  stage: number;
  ports: (FixturePort | null)[];
  lastFrame?: number;
}): Buffer {
  const payloads = Buffer.from([
    0x35,
    1 + 3 * 2,
    0x36,
    GAME_START_SIZE >> 8,
    GAME_START_SIZE & 0xff,
    0x39,
    0x00,
    0x02,
  ]);
  const gs = Buffer.alloc(1 + GAME_START_SIZE);
  gs[0] = 0x36;
  gs[1] = 3;
  gs[2] = 13;
  gs[3] = 0;
  gs.writeUInt16BE(opts.stage, 0x13);
  for (let i = 0; i < 4; i++) {
    const p = opts.ports[i];
    gs[0x65 + 0x24 * i] = p ? p.character : 0x1a;
    gs[0x66 + 0x24 * i] = p ? 0 : 3;
    gs[0x68 + 0x24 * i] = p ? p.costume : 0;
  }
  const gameEnd = Buffer.from([0x39, 2, 0]);
  const raw = Buffer.concat([payloads, gs, gameEnd]);
  const header = Buffer.alloc(15);
  Buffer.from([0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c]).copy(header);
  header.writeUInt32BE(raw.length, 11);
  const lf = Buffer.alloc(4);
  lf.writeInt32BE(opts.lastFrame ?? 3600);
  const meta = Buffer.concat([
    Buffer.from([0x55, 0x08, ...Buffer.from('metadata'), 0x7b]),
    Buffer.from([0x55, 0x09, ...Buffer.from('lastFrame'), 0x6c]),
    lf,
    Buffer.from([0x7d, 0x7d]),
  ]);
  return Buffer.concat([header, raw, meta]);
}

/** The display name stamped at a port, decoded as plain ASCII. */
export function displayNameAt(slp: Buffer, port: number): string {
  const gs = 15 + 1 + slp[16]!;
  const at = gs + 0x1a5 + 31 * port;
  return slp
    .subarray(at, at + 31)
    .toString('latin1')
    .split('\0')[0]!;
}
