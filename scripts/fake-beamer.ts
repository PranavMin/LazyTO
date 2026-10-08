// fake-beamer.ts -- stand in for a station's LazyTO beamer on a dev machine,
// so the relay's collection (src/collect.ts, src/rawstore.ts, the set
// archive) can be exercised with Dolphin before beamer hardware: it syncs
// with the relay every 10 s the way the firmware does (CMD_BEAMER_SYNC,
// signed reply checked, acks kept in memory) and serves the replays in a
// folder (Dolphin's Slippi replay folder) over the beamer's HTTP API.
//
//   npx tsx scripts/fake-beamer.ts --dir "%USERPROFILE%\Documents\Slippi" --address 192.168.1.67
//
// --address is this machine's LAN address, the one the development Dolphin's
// requests reach the relay from: the relay ties a Wii's reports to the
// beamer that syncs from the same address. --relay (default the same
// address) and --relay-port (29470) are where the relay listens; --secret
// is the relay's Wii secret (default the test secret); --station 0 is
// Dolphin's (its forwarder stamps no number). Nothing is ever erased from
// the folder: the acks only show what a beamer would delete at its next
// cold boot. Dolphin sends replay_id 0, so nothing binds to a set; replays
// land in the archive folder's unmatched/.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SyncAnswerKind, SyncKind } from '../generated/wire.js';
import { localAddresses } from '../src/beacon.js';
import { FakeBeamer } from '../test/fake-beamer.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

const dir = arg('dir');
const address = arg('address', localAddresses()[0]);
const relay = arg('relay', address);
const relayPort = Number(arg('relay-port', '29470'));
const station = Number(arg('station', '0'));

/** A replay's raw length is written when it is finished; 0 means Dolphin is still recording it. */
function kind(data: Buffer): SyncKind {
  return data.length >= 15 && data.readUInt32BE(11) !== 0 ? SyncKind.SK_FINISHED : SyncKind.SK_LIVE;
}

const beamer = new FakeBeamer(Number(arg('seed', '1')), station, address);
beamer.secret = arg('secret', beamer.secret);
await beamer.listen();

function scan(): void {
  for (const f of readdirSync(dir).filter((n) => /^[A-Za-z0-9_-]+\.slp$/.test(n))) {
    const data = readFileSync(join(dir, f));
    const known = beamer.files.find((x) => x.name === f);
    if (!known || known.data.length !== data.length) beamer.add(f, data, kind(data));
  }
}

async function tick(): Promise<void> {
  scan();
  try {
    const r = await beamer.sync(relayPort, relay);
    const wanted = r.answers.filter((a) => a.answer === SyncAnswerKind.SA_WANTED).length;
    console.log(
      `sync: ${r.verified ? 'verified' : `NOT verified (status ${r.status} ${r.msg})`}, ` +
        `${r.answers.length} listed, ${wanted} wanted, ${r.acked.length} acked, ${beamer.acks.size} acked in all`,
    );
  } catch (e) {
    console.log(`sync failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(
  `fake beamer, station ${station}, serving ${dir} on http://${address}:${beamer.httpPort()}/SLIPPI/, syncing with ${relay}:${relayPort}`,
);
await tick();
setInterval(() => void tick(), 10_000);
