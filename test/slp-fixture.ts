// Synthetic .slp files for the archive tests: just enough of the format for
// src/slp.ts (Event Payloads, a 3.13-sized Game Start, post-frame updates
// with stocks, the last Frame Bookend, a Game End, metadata with startAt and
// lastFrame), shaped like a Wii (Nintendont) replay. The real Wii replays in
// test/rr-conformance/replays/ cover the rest.

const GAME_START_SIZE = 0x2bc; // payload bytes after the command byte, as Nintendont 3.13 writes
const POST_FRAME_SIZE = 0x34; // enough for stocks remaining at 0x21
const BOOKEND_SIZE = 8; // frame number, latest finalized frame

export interface FixturePort {
  character: number; // external id
  costume: number;
}

/**
 * ports: index = port 0-3; null = empty. stocks: each port's stocks at the
 * last frame (one post-frame update per port), none by default. complete
 * false: an interrupted recording (raw length 0, no Game End, no metadata).
 * startAt: metadata.startAt as Nintendont writes it (UTC, no zone).
 */
export function makeSlp(opts: {
  stage: number;
  ports: (FixturePort | null)[];
  lastFrame?: number;
  stocks?: (number | null)[];
  complete?: boolean;
  startAt?: string;
}): Buffer {
  const complete = opts.complete ?? true;
  const lastFrame = opts.lastFrame ?? 3600;
  const payloads = Buffer.from([
    0x35,
    1 + 3 * 4,
    0x36,
    GAME_START_SIZE >> 8,
    GAME_START_SIZE & 0xff,
    0x38,
    0x00,
    POST_FRAME_SIZE,
    0x39,
    0x00,
    0x02,
    0x3c,
    0x00,
    BOOKEND_SIZE,
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
  const frames = (opts.stocks ?? []).flatMap((s, port) => {
    if (s === null || s === undefined) return [];
    const f = Buffer.alloc(1 + POST_FRAME_SIZE);
    f[0] = 0x38;
    f.writeInt32BE(lastFrame, 1);
    f[5] = port;
    f[6] = 0; // not a follower
    f[0x21] = s;
    return [f];
  });
  const bookend = Buffer.alloc(1 + BOOKEND_SIZE);
  bookend[0] = 0x3c;
  bookend.writeInt32BE(lastFrame, 1);
  bookend.writeInt32BE(lastFrame, 5);
  const end = complete ? [bookend, Buffer.from([0x39, 2, 0])] : [];
  const raw = Buffer.concat([payloads, gs, ...frames, ...end]);
  const header = Buffer.alloc(15);
  Buffer.from([0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c]).copy(header);
  header.writeUInt32BE(complete ? raw.length : 0, 11);
  if (!complete) return Buffer.concat([header, raw]);
  const startAt = Buffer.from(opts.startAt ?? '2026-10-07T20:15:02', 'latin1');
  const lf = Buffer.alloc(4);
  lf.writeInt32BE(lastFrame);
  const meta = Buffer.concat([
    Buffer.from([0x55, 0x08, ...Buffer.from('metadata'), 0x7b]),
    Buffer.from([0x55, 0x07, ...Buffer.from('startAt'), 0x53, 0x55, startAt.length]),
    startAt,
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
