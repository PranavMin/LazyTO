// sim-wii.ts -- load test (architecture.md "Development and testing"): 12 fake stations drive
// the relay through list -> start -> score x3 -> end in a loop, paced like a
// venue (one button press every ~12 s per station), against the real relay
// stack (test/harness.ts) and the in-process fake start.gg. Asserts at the end:
//   - peak upstream call rate (any 60 s window, cache refreshes included)
//     stayed under 70/min,
//   - zero errors: every request answered ST_OK, with ST_SET_TAKEN counted
//     separately as benign contention (two stations racing for one set).
//
//   npm run sim                                   10 minutes
//   npx tsx scripts/sim-wii.ts --duration=60      npm swallows unknown flags unless
//                                                 they follow `--`; this avoids it

import { RelayStatus } from '../generated/wire.js';
import { loadFixture, peakPerMinute } from '../test/fake-startgg.js';
import { game, type WiiClient } from '../test/wii-client.js';
import { startHarness } from '../test/harness.js';

const STATIONS = 12;
const ACTION_DELAY_MS = 12_000; // one player action every ~12 s, +/- 25% jitter
const RATE_LIMIT_PER_MIN = 70;

const durationArg = process.argv.find((a) => a.startsWith('--duration='));
const DURATION_S = Number(durationArg?.slice('--duration='.length) ?? 600);
if (!Number.isFinite(DURATION_S) || DURATION_S <= 0) {
  console.error('bad --duration');
  process.exit(1);
}

const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randChar = () => Math.floor(Math.random() * 26);

interface Tally {
  setsCompleted: number;
  requests: number;
  requestTimes: number[];
  contention: number;
  errors: string[];
}

async function stationLoop(wii: WiiClient, deadline: number, tally: Tally): Promise<void> {
  const count = () => {
    tally.requests++;
    tally.requestTimes.push(Date.now());
  };
  const expect = async (
    label: string,
    p: Promise<{ resp: { status: number; msg: string } }>,
  ): Promise<boolean> => {
    count();
    try {
      const r = await p;
      if (r.resp.status === RelayStatus.ST_OK) return true;
      if (r.resp.status === RelayStatus.ST_SET_TAKEN) {
        tally.contention++;
        return false;
      }
      tally.errors.push(
        `station ${wii.station}: ${label} -> ${RelayStatus[r.resp.status]} "${r.resp.msg}"`,
      );
      return false;
    } catch (e) {
      tally.errors.push(`station ${wii.station}: ${label} threw ${String(e)}`);
      return false;
    }
  };

  while (Date.now() < deadline) {
    count();
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
    const games = [decider, (3 - decider) as 1 | 2, decider].map((w) =>
      game(w, randChar(), randChar(), 0x1f),
    );

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

async function main(): Promise<void> {
  const tally: Tally = {
    setsCompleted: 0,
    requests: 0,
    requestTimes: [],
    contention: 0,
    errors: [],
  };
  const h = await startHarness({ sets: loadFixture(400), eventLabel: 'sim fixture' });
  console.log(`status page: ${h.statusUrl}/`);
  console.log(`audit log:   ${h.ev.audit.path}`);

  const deadline = Date.now() + DURATION_S * 1000;
  console.log(`sim-wii: ${STATIONS} stations for ${DURATION_S} s`);

  const progress = setInterval(() => {
    console.log(
      `  t+${Math.round((Date.now() - (deadline - DURATION_S * 1000)) / 1000)}s: ` +
        `${tally.setsCompleted} sets done, ${tally.requests} requests, ` +
        `${h.startgg.callsInWindow()} upstream calls last 60s, ${tally.errors.length} errors`,
    );
  }, 30_000);
  progress.unref();

  await Promise.all(
    Array.from({ length: STATIONS }, (_, i) => stationLoop(h.wii(i + 1), deadline, tally)),
  );

  clearInterval(progress);
  const upstreamTimes = h.fake.calls.map((c) => c.at);
  const refreshErrors = h.auditEvents().filter((e) => e.type === 'refresh_error');
  for (const e of refreshErrors) tally.errors.push(`cache refresh failed: ${String(e.error)}`);
  await h.close();

  const peakUpstream = peakPerMinute(upstreamTimes);
  console.log('\n=== sim-wii results ===');
  console.log(`duration:            ${DURATION_S} s`);
  console.log(`sets completed:      ${tally.setsCompleted}`);
  console.log(
    `wii requests:        ${tally.requests} total, peak ${peakPerMinute(tally.requestTimes)}/min`,
  );
  console.log(`benign contention:   ${tally.contention} (ST_SET_TAKEN races)`);
  console.log(
    `upstream calls:      ${upstreamTimes.length} total, peak ${peakUpstream}/min (limit ${RATE_LIMIT_PER_MIN})`,
  );
  console.log(`errors:              ${tally.errors.length}`);
  for (const e of tally.errors.slice(0, 20)) console.log(`  ${e}`);

  let failed = false;
  if (peakUpstream >= RATE_LIMIT_PER_MIN) {
    console.error(`FAIL: peak upstream rate ${peakUpstream}/min >= ${RATE_LIMIT_PER_MIN}/min`);
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
