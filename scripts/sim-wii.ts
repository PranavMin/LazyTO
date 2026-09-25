// sim-wii.ts -- load test (design.md section 9.2): 12 fake stations drive
// the relay through list -> start -> score x3 -> end in a loop, paced like a
// venue (one button press every ~12 s per station). Asserts at the end:
//   - peak upstream call rate (any 60 s window, cache refreshes included)
//     stayed under 70/min,
//   - zero errors: every request answered ST_OK, with ST_SET_TAKEN counted
//     separately as benign contention (two stations racing for one set).
//
// Two modes:
//   npm run sim                          in-process: fake start.gg + the real
//                                        client/cache/state/tcp/status stack
//   npx tsx scripts/sim-wii.ts --relay=127.0.0.1:7777 --secret=<relay's secret>
//                                        external: drive an already-running
//                                        relay (e.g. `node dist/main.js`
//                                        pointed at `npm run fake`). The
//                                        upstream rate is then reported by
//                                        scripts/serve-fake.ts, not here.
// Either mode takes --duration=<seconds> (default 600). npm swallows
// unknown flags unless they follow `--`; `npx tsx scripts/sim-wii.ts
// --duration=60` avoids the issue.

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
import { FakeStartgg, FIXTURE_TOKEN, FIXTURE_EVENT_ID, loadFixture, peakPerMinute } from '../test/fake-startgg.js';
import { WiiClient, TEST_SECRET } from '../test/wii-client.js';

const STATIONS = 12;
const ACTION_DELAY_MS = 12_000; // one player action every ~12 s, +/- 25% jitter
const RATE_LIMIT_PER_MIN = 70;

function flag(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

const DURATION_S = Number(flag('duration') ?? 600);
if (!Number.isFinite(DURATION_S) || DURATION_S <= 0) {
  console.error('bad --duration');
  process.exit(1);
}

// --secret=: the external relay's secret (its config.json); in-process uses TEST_SECRET.
const SECRET = flag('secret') ?? TEST_SECRET;

const relayArg = flag('relay');
let external: { host: string; port: number } | null = null;
if (relayArg !== undefined) {
  const m = /^([^:]+):(\d+)$/.exec(relayArg);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) {
    console.error('bad --relay (want host:port)');
    process.exit(1);
  }
  external = { host: m[1], port: Number(m[2]) };
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
  const expect = async (label: string, p: Promise<{ resp: { status: number; msg: string } }>): Promise<boolean> => {
    count();
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
    const games = [
      { winner_slot: decider, p1_char: randChar(), p2_char: randChar(), stage: 0x1f },
      { winner_slot: (3 - decider) as 1 | 2, p1_char: randChar(), p2_char: randChar(), stage: 0x1f },
      { winner_slot: decider, p1_char: randChar(), p2_char: randChar(), stage: 0x1f },
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

interface Stack {
  host: string;
  port: number;
  upstreamCalls: () => number | null; // null: not observable (external relay)
  upstreamTimes: () => number[] | null;
  stop: () => Promise<void>;
}

async function inProcessStack(tally: Tally): Promise<Stack> {
  const fake = new FakeStartgg(FIXTURE_TOKEN, FIXTURE_EVENT_ID, loadFixture(400));
  await fake.start();

  const startgg = new StartggClient({ endpoint: fake.url, token: FIXTURE_TOKEN });
  const audit = new AuditLog(auditPath(mkdtempSync(join(tmpdir(), 'tr-sim-')), FIXTURE_EVENT_ID));
  const cache = new SetCache(startgg, FIXTURE_EVENT_ID, (e) => {
    tally.errors.push(`cache refresh failed: ${String(e)}`);
  });
  await cache.refresh();
  const state = new StationState();
  const tcp = new RelayTcpServer({ cache, state, startgg, audit, streamStation: 1, streamId: 1358079, secret: TEST_SECRET });
  await tcp.listen(0, '127.0.0.1');
  const status = new StatusServer({ state, cache, startgg, streamStation: 1, eventLabel: `sim fixture (${FIXTURE_EVENT_ID})`, beacon: { status: () => ({ targets: [], sent: 0, lastSentAt: null, lastError: null }) }, tcp });
  await status.listen(0, '127.0.0.1');
  cache.start();

  console.log(`status page: http://127.0.0.1:${status.address().port}/`);
  console.log(`audit log:   ${audit.path}`);

  return {
    host: '127.0.0.1',
    port: tcp.address().port,
    upstreamCalls: () => startgg.callsInWindow(),
    upstreamTimes: () => fake.calls.map((c) => c.at),
    stop: async () => {
      cache.stop();
      await tcp.close();
      await status.close();
      await fake.close();
      audit.close();
    },
  };
}

async function main(): Promise<void> {
  const tally: Tally = { setsCompleted: 0, requests: 0, requestTimes: [], contention: 0, errors: [] };
  const stack: Stack = external
    ? {
        ...external,
        upstreamCalls: () => null,
        upstreamTimes: () => null,
        stop: async () => {},
      }
    : await inProcessStack(tally);

  const deadline = Date.now() + DURATION_S * 1000;
  console.log(`sim-wii: ${STATIONS} stations for ${DURATION_S} s against ${stack.host}:${stack.port}` +
    (external ? ' (external relay)' : ''));

  const progress = setInterval(() => {
    const upstream = stack.upstreamCalls();
    console.log(
      `  t+${Math.round((Date.now() - (deadline - DURATION_S * 1000)) / 1000)}s: ` +
        `${tally.setsCompleted} sets done, ${tally.requests} requests, ` +
        (upstream === null ? '' : `${upstream} upstream calls last 60s, `) +
        `${tally.errors.length} errors`,
    );
  }, 30_000);
  progress.unref();

  await Promise.all(
    Array.from({ length: STATIONS }, (_, i) =>
      stationLoop(new WiiClient(stack.port, i + 1, 0, stack.host, SECRET), deadline, tally),
    ),
  );

  clearInterval(progress);
  await stack.stop();

  const upstreamTimes = stack.upstreamTimes();
  const peakUpstream = upstreamTimes === null ? null : peakPerMinute(upstreamTimes);
  console.log('\n=== sim-wii results ===');
  console.log(`duration:            ${DURATION_S} s`);
  console.log(`sets completed:      ${tally.setsCompleted}`);
  console.log(`wii requests:        ${tally.requests} total, peak ${peakPerMinute(tally.requestTimes)}/min`);
  console.log(`benign contention:   ${tally.contention} (ST_SET_TAKEN races)`);
  console.log(
    upstreamTimes === null
      ? 'upstream calls:      (external relay -- see the serve-fake output)'
      : `upstream calls:      ${upstreamTimes.length} total, peak ${peakUpstream}/min (limit ${RATE_LIMIT_PER_MIN})`,
  );
  console.log(`errors:              ${tally.errors.length}`);
  for (const e of tally.errors.slice(0, 20)) console.log(`  ${e}`);

  let failed = false;
  if (peakUpstream !== null && peakUpstream >= RATE_LIMIT_PER_MIN) {
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
