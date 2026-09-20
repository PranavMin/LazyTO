// sim-wii.ts -- load test (design.md section 9.2): 12 fake stations drive
// the full relay stack (fake start.gg, real client/cache/state/tcp/status)
// through list -> start -> score x3 -> end in a loop, paced like a venue
// (one button press every ~12 s per station). Asserts at the end:
//   - peak upstream call rate (any 60 s window, cache refreshes included)
//     stayed under 70/min,
//   - zero errors: every request answered ST_OK, with ST_SET_TAKEN counted
//     separately as benign contention (two stations racing for one set).
//
// Run: npm run sim            (10 minutes)
//      npm run sim -- --duration=60   (shorter, for development)

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayStatus } from '../generated/wire.js';
import { StartggClient } from '../src/startgg.js';
import { SetCache } from '../src/cache.js';
import { StationState } from '../src/state.js';
import { AuditLog, auditPath } from '../src/audit.js';
import { RelayTcpServer } from '../src/tcp.js';
import { StatusServer } from '../src/status.js';
import { FakeStartgg, FIXTURE_TOKEN, FIXTURE_EVENT_ID, entrant, type FakeSet } from '../test/fake-startgg.js';
import { WiiClient } from '../test/wii-client.js';

const STATIONS = 12;
const ACTION_DELAY_MS = 12_000; // one player action every ~12 s, +/- 25% jitter
const RATE_LIMIT_PER_MIN = 70;

const durationArg = process.argv.find((a) => a.startsWith('--duration='));
const DURATION_S = durationArg ? Number(durationArg.split('=')[1]) : 600;
if (!Number.isFinite(DURATION_S) || DURATION_S <= 0) {
  console.error('bad --duration');
  process.exit(1);
}

// Enough pending sets that 12 stations churning for 10 minutes never run dry.
function bigFixture(count: number): FakeSet[] {
  const sets: FakeSet[] = [];
  for (let i = 0; i < count; i++) {
    sets.push({
      id: 300_000 + i,
      state: 1,
      round: Math.floor(i / 64) + 1,
      fullRoundText: `Winners Round ${Math.floor(i / 64) + 1}`,
      totalGames: 3,
      slots: [entrant((i * 2) % 16 + 1), entrant((i * 2 + 1) % 16 + 1)],
      games: [],
      stream: null,
    });
  }
  return sets;
}

const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randChar = () => Math.floor(Math.random() * 26);

interface Tally {
  setsCompleted: number;
  requests: number;
  contention: number;
  errors: string[];
}

async function stationLoop(wii: WiiClient, deadline: number, tally: Tally): Promise<void> {
  const expect = async (label: string, p: Promise<{ resp: { status: number; msg: string } }>): Promise<boolean> => {
    tally.requests++;
    try {
      const r = await p;
      if (r.resp.status === RelayStatus.ST_OK) return true;
      if (r.resp.status === RelayStatus.ST_SET_TAKEN) {
        tally.contention++;
        return false;
      }
      tally.errors.push(`station ${wii.station}: ${label} -> ${RelayStatus[r.resp.status]} "${r.resp.msg}"`);
      return false;
    } catch (e) {
      tally.errors.push(`station ${wii.station}: ${label} threw ${String(e)}`);
      return false;
    }
  };

  while (Date.now() < deadline) {
    tally.requests++;
    let sets;
    try {
      ({ sets } = await wii.listSets());
    } catch (e) {
      tally.errors.push(`station ${wii.station}: LIST_SETS threw ${String(e)}`);
      break;
    }
    const open = sets.filter((s) => s.state === 0);
    if (open.length === 0) {
      tally.errors.push(`station ${wii.station}: set list ran dry`);
      break;
    }
    // Spread stations across the list to keep collisions rare (not zero:
    // ST_SET_TAKEN on a race is correct behavior and counted separately).
    const pick = open[(wii.station - 1) % open.length].set_id;

    await sleep(jitter(ACTION_DELAY_MS));
    if (Date.now() >= deadline) break;
    if (!(await expect('START_SET', wii.startSet(pick)))) continue;

    // A 2-1 set: winners of games 1 and 2 split, game 3 decides.
    const decider = (Math.random() < 0.5 ? 1 : 2) as 1 | 2;
    const games = [
      { winner_slot: decider, p1_char: randChar(), p2_char: randChar() },
      { winner_slot: (3 - decider) as 1 | 2, p1_char: randChar(), p2_char: randChar() },
      { winner_slot: decider, p1_char: randChar(), p2_char: randChar() },
    ];

    let dead = false;
    for (let n = 1; n <= 3; n++) {
      await sleep(jitter(ACTION_DELAY_MS));
      if (!(await expect(`REPORT_SCORE ${n}`, wii.reportScore(pick, games.slice(0, n))))) {
        dead = true;
        break;
      }
    }
    if (dead) continue;

    await sleep(jitter(ACTION_DELAY_MS));
    if (await expect('END_SET', wii.endSet(pick, games))) tally.setsCompleted++;
  }
}

/** Peak calls in any sliding 60 s window over the recorded upstream calls. */
function peakPerMinute(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let peak = 0;
  for (let lo = 0, hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] > 60_000) lo++;
    peak = Math.max(peak, hi - lo + 1);
  }
  return peak;
}

async function main(): Promise<void> {
  const fake = new FakeStartgg(FIXTURE_TOKEN, FIXTURE_EVENT_ID, bigFixture(400));
  await fake.start();

  const startgg = new StartggClient({ endpoint: fake.url, token: FIXTURE_TOKEN });
  const audit = new AuditLog(auditPath(mkdtempSync(join(tmpdir(), 'tr-sim-')), FIXTURE_EVENT_ID));
  const cache = new SetCache(startgg, FIXTURE_EVENT_ID, (e) => {
    tally.errors.push(`cache refresh failed: ${String(e)}`);
  });
  await cache.refresh();
  const state = new StationState();
  const tcp = new RelayTcpServer({ cache, state, startgg, audit, streamStation: 1, streamId: 1358079 });
  await tcp.listen(0, '127.0.0.1');
  const status = new StatusServer({ state, cache, startgg, streamStation: 1 });
  await status.listen(0, '127.0.0.1');
  cache.start();

  const tally: Tally = { setsCompleted: 0, requests: 0, contention: 0, errors: [] };
  const deadline = Date.now() + DURATION_S * 1000;

  console.log(`sim-wii: ${STATIONS} stations for ${DURATION_S} s`);
  console.log(`status page: http://127.0.0.1:${status.address().port}/`);
  console.log(`audit log:   ${audit.path}`);

  const progress = setInterval(() => {
    console.log(
      `  t+${Math.round((Date.now() - (deadline - DURATION_S * 1000)) / 1000)}s: ` +
        `${tally.setsCompleted} sets done, ${tally.requests} requests, ` +
        `${startgg.callsInWindow()} upstream calls last 60s, ${tally.errors.length} errors`,
    );
  }, 30_000);
  progress.unref();

  await Promise.all(
    Array.from({ length: STATIONS }, (_, i) => stationLoop(new WiiClient(tcp.address().port, i + 1), deadline, tally)),
  );

  clearInterval(progress);
  cache.stop();
  await tcp.close();
  await status.close();
  await fake.close();
  audit.close();

  const peak = peakPerMinute(fake.calls.map((c) => c.at));
  console.log('\n=== sim-wii results ===');
  console.log(`duration:            ${DURATION_S} s`);
  console.log(`sets completed:      ${tally.setsCompleted}`);
  console.log(`wii requests:        ${tally.requests}`);
  console.log(`benign contention:   ${tally.contention} (ST_SET_TAKEN races)`);
  console.log(`upstream calls:      ${fake.calls.length} total, peak ${peak}/min (limit ${RATE_LIMIT_PER_MIN})`);
  console.log(`errors:              ${tally.errors.length}`);
  for (const e of tally.errors.slice(0, 20)) console.log(`  ${e}`);

  let failed = false;
  if (peak >= RATE_LIMIT_PER_MIN) {
    console.error(`FAIL: peak upstream rate ${peak}/min >= ${RATE_LIMIT_PER_MIN}/min`);
    failed = true;
  }
  if (tally.errors.length > 0) {
    console.error(`FAIL: ${tally.errors.length} errors`);
    failed = true;
  }
  if (tally.setsCompleted === 0) {
    console.error('FAIL: no sets completed');
    failed = true;
  }
  console.log(failed ? 'sim-wii: FAIL' : 'sim-wii: PASS');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
