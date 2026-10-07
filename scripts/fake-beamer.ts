// fake-beamer.ts -- stand in for a station's Slippi Beamer on a dev machine,
// so the set archive (src/archive.ts) can be exercised with Dolphin before
// any beamer hardware exists. It serves the replays in a folder (Dolphin's
// Slippi replay folder) with the beamer's HTTP API and announces itself the
// way a beamer does, as "Station <n>", whenever a finished replay appears.
//
//   npx tsx scripts/fake-beamer.ts --dir "%USERPROFILE%\Documents\Slippi" --station 0 --port 8085
//
// Then run the relay with beamerHttpPort 8085 (test/harness.ts). Dolphin is station 0 (its
// forwarder stamps no station number), so the default is --station 0.
// Only finished replays are listed (a .slp whose raw length is still 0 is
// being written), newest 10, like a beamer's NUM-REPLAYS-SERVED.

import { createSocket } from 'node:dgram';
import { openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FakeBeamer, announceDatagram } from '../test/fake-beamer.js';
import { ANNOUNCE_GROUP, ANNOUNCE_PORT } from '../src/beamer.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

const dir = arg('dir');
const station = Number(arg('station', '0'));
const port = Number(arg('port', '8085'));
const to = arg('to', ANNOUNCE_GROUP); // 127.0.0.1 if multicast does not loop back here
const SERVED = 10;

/** The raw element's length is written when the replay is finished. */
function finished(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(15);
    return readSync(fd, b, 0, 15, 0) === 15 && b.readUInt32BE(11) !== 0;
  } finally {
    closeSync(fd);
  }
}

const beamer = new FakeBeamer();
await beamer.listen(port, '0.0.0.0');
const sock = createSocket('udp4');
const announced = new Set<string>();

function scan(): void {
  const files = readdirSync(dir)
    .filter((f) => /^[A-Za-z0-9_.-]+\.slp$/.test(f))
    .map((f) => ({ f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .filter((x) => finished(x.path))
    .sort((a, b) => a.mtime - b.mtime)
    .slice(-SERVED);
  beamer.files.length = 0;
  for (const x of files) {
    beamer.files.push({ name: x.f, read: () => readFileSync(x.path) });
    if (!announced.has(x.f)) {
      announced.add(x.f);
      sock.send(announceDatagram(station, 'game_finished', x.f), ANNOUNCE_PORT, to);
      console.log(`announced ${x.f}`);
    }
  }
}

// Everything already in the folder counts as announced: the relay learns
// this beamer's address from the keepalive below.
for (const f of readdirSync(dir)) announced.add(f);
scan();
setInterval(scan, 2000);
// A real beamer only announces on game events; this one also says hello every
// 10 s so a relay started later learns where it is.
setInterval(
  () => sock.send(announceDatagram(station, 'game_started', 'hello.slp'), ANNOUNCE_PORT, to),
  10_000,
);
sock.send(announceDatagram(station, 'game_started', 'hello.slp'), ANNOUNCE_PORT, to);
console.log(
  `fake beamer "Station ${station}" serving ${dir} on http://0.0.0.0:${port}/SLIPPI/, announcing to ${to}:${ANNOUNCE_PORT}`,
);
