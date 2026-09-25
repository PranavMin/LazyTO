// smoke.ts -- prove a deployed relay works from this machine, no Wii needed.
// Sends one LIST_SETS over the real TCP wire protocol (as station 999, which
// shows up as a row on the status page until the next restart) and fetches
// the status page. Read-only: nothing is started or reported.
//
// Run: npx tsx scripts/smoke.ts relay.local          (ports 7777 / 8080)
//      npx tsx scripts/smoke.ts 192.168.1.10 7777 8080
// Sends RELAY_SECRET from .env as its relay_auth, like a Wii (design R16).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RelayCmd, RelayStatus, decodeListSetsResp } from '../generated/wire.js';
import { rawRequest } from '../test/wii-client.js';

function relaySecret(): string {
  const text = readFileSync(resolve(import.meta.dirname, '..', '.env'), 'utf8');
  const m = /^RELAY_SECRET=(.*)$/m.exec(text);
  if (!m || !m[1]!.trim()) throw new Error('RELAY_SECRET missing from .env');
  return m[1]!.trim();
}

const host = process.argv[2] ?? 'relay.local';
const tcpPort = Number(process.argv[3] ?? 7777);
const httpPort = Number(process.argv[4] ?? 8080);
const STATION = 999;

async function main(): Promise<void> {
  const reply = await rawRequest(tcpPort, STATION, RelayCmd.CMD_LIST_SETS, undefined, { host, secret: relaySecret() });
  const status = RelayStatus[reply.resp.status] ?? String(reply.resp.status);
  if (reply.resp.status !== RelayStatus.ST_OK) {
    throw new Error(`LIST_SETS -> ${status} "${reply.resp.msg}"`);
  }
  const { sets } = decodeListSetsResp(reply.payload);
  console.log(`tcp ${host}:${tcpPort}  LIST_SETS -> ${status}, ${sets.length} pending sets`);
  for (const s of sets.slice(0, 5)) console.log(`  ${s.round.padEnd(6)} ${s.p1_tag} vs ${s.p2_tag}`);
  if (sets.length > 5) console.log(`  ... ${sets.length - 5} more`);

  const res = await fetch(`http://${host}:${httpPort}/`);
  if (!res.ok) throw new Error(`status page -> HTTP ${res.status}`);
  const html = await res.text();
  const cacheLine = /Cache:[^<]*/.exec(html)?.[0] ?? '(no cache line found)';
  console.log(`http ${host}:${httpPort}  ${cacheLine.trim()}`);
  console.log('OK (station 999 is this test; it disappears on the next relay restart)');
}

main().catch((e) => {
  console.error(`smoke: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
