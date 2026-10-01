// Integration tests for the TCP server: every relay-side row of the
// architecture.md error table, plus the happy paths. The first two rows
// of that table (no tournament.cfg, relay unreachable) are Wii-side
// behaviors with no relay code to test; the closest relay-side property --
// a connection that is not our protocol gets dropped, not answered -- is
// covered here. The relay-restart row is covered in audit.test.ts, where
// the audit log replay lives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { RelayStatus, RelayCmd, MAX_SETS, encodeStartSetReq } from '../generated/wire.js';
import { RelayTcpServer, type AuditSink } from '../src/tcp.js';
import { SetCache } from '../src/cache.js';
import { StationState } from '../src/state.js';
import { StartggClient } from '../src/startgg.js';
import { makeFake, defaultFixture, FIXTURE_TOKEN, FIXTURE_EVENT_ID, entrant, type FakeSet } from './fake-startgg.js';
import { WiiClient, rawRequest, game, TEST_SECRET } from './wii-client.js';

const STREAM_STATION = 1;
const STREAM_ID = 1358079;
const SET = 107949994; // Alpha vs Bravo, WQF, bo5

class ArrayAudit implements AuditSink {
  events: Record<string, unknown>[] = [];
  record(event: Record<string, unknown>): void {
    this.events.push(event);
  }
}

async function setup(opts: { sets?: FakeSet[]; limits?: { capacity: number; refillPerMinute: number; maxWaitMs: number } } = {}) {
  const fake = makeFake(opts.sets);
  await fake.start();
  const startgg = new StartggClient({
    endpoint: fake.url,
    token: FIXTURE_TOKEN,
    retryDelaysMs: [0, 0],
    limits: opts.limits,
  });
  const cache = new SetCache(startgg, FIXTURE_EVENT_ID, 'startgg');
  await cache.refresh();
  const state = new StationState();
  const audit = new ArrayAudit();
  const server = new RelayTcpServer({ cache, state, startgg, audit, streamStation: STREAM_STATION, streamId: STREAM_ID, secret: TEST_SECRET });
  await server.listen(0, '127.0.0.1');
  const port = server.address().port;
  return {
    fake,
    startgg,
    cache,
    state,
    audit,
    server,
    port,
    wii: (station: number, stream: 0 | 1 = 0) => new WiiClient(port, station, stream),
    close: async () => {
      await server.close();
      await fake.close();
    },
  };
}

test('framing and versioning', async (t) => {
  const env = await setup();
  t.after(env.close);

  await t.test('bad protocol version gets ST_BAD_VERSION', async () => {
    const r = await rawRequest(env.port, 3, RelayCmd.CMD_LIST_SETS, new Uint8Array(0), { version: 2 });
    assert.equal(r.resp.status, RelayStatus.ST_BAD_VERSION);
    assert.equal(r.hdr.cmd, RelayCmd.CMD_LIST_SETS);
  });

  await t.test('a connection that is not our protocol is dropped without a reply', async () => {
    const closed = await new Promise<number>((resolve, reject) => {
      const s = connect({ port: env.port, host: '127.0.0.1' });
      const chunks: Buffer[] = [];
      s.setTimeout(2000, () => reject(new Error('server never closed the socket')));
      s.on('connect', () => s.write(Buffer.from('GET / HTTP/1.1\r\n\r\n')));
      s.on('data', (c: Buffer) => chunks.push(c));
      s.on('error', () => resolve(0));
      s.on('close', () => resolve(Buffer.concat(chunks).length));
    });
    assert.equal(closed, 0, 'no bytes should come back for garbage');
  });

  await t.test('a truncated payload gets ST_INTERNAL', async () => {
    // START_SET claims an 8-byte payload but the header says 4.
    const r = await rawRequest(env.port, 3, RelayCmd.CMD_START_SET, new Uint8Array(4));
    assert.equal(r.resp.status, RelayStatus.ST_INTERNAL);
    assert.equal(r.resp.msg, 'bad payload');
  });

  await t.test('unknown command gets ST_INTERNAL', async () => {
    const r = await rawRequest(env.port, 3, 99);
    assert.equal(r.resp.status, RelayStatus.ST_INTERNAL);
    assert.equal(r.resp.msg, 'unknown command');
  });
});

test('full set lifecycle on a non-stream station', async (t) => {
  const env = await setup();
  t.after(env.close);
  const wii = env.wii(3);

  await t.test('LIST_SETS shows the four selectable sets, earliest round first', async () => {
    const { resp, sets } = await wii.listSets();
    assert.equal(resp.status, RelayStatus.ST_OK);
    assert.deepEqual(sets.map((s) => s.set_id), [107949994, 107949995, 107949996, 107949997]);
    const first = sets[0]!;
    assert.equal(first.round, 'WINNERS QUARTER-FINAL');
    assert.equal(first.p1_tag, 'Alpha');
    assert.equal(first.p2_tag, 'Bravo');
    assert.equal(first.best_of, 5);
    assert.equal(first.state, 0);
  });

  await t.test('START_SET marks the set in progress upstream and claims it', async () => {
    const r = await wii.startSet(SET);
    assert.equal(r.resp.status, RelayStatus.ST_OK);
    assert.equal(env.fake.getSet(SET).state, 2);
    assert.equal(env.state.get(3)!.setId, SET);
  });

  await t.test('the started set disappears from another station and is taken (section 8 row 3)', async () => {
    const other = env.wii(4);
    const { sets } = await other.listSets();
    assert.ok(!sets.some((s) => s.set_id === SET));
    const r = await other.startSet(SET);
    assert.equal(r.resp.status, RelayStatus.ST_SET_TAKEN);
    assert.equal(r.resp.msg, 'started on station 3');
  });

  await t.test('REPORT_SCORE translates winner slots to entrant ids and sends characters + stage (decisions.md R13)', async () => {
    // Game 1: Alpha (slot 1) wins as Fox (ext 2) vs Marth (ext 9) on
    // Battlefield (StKind 0x1F) -- what an auto-scored game carries.
    const r = await wii.reportScore(SET, [game(1, 2, 9, 0x1f)]);
    assert.equal(r.resp.status, RelayStatus.ST_OK);
    assert.equal(r.resp.msg, '1-0');
    const games = env.fake.getSet(SET).games;
    assert.equal(games.length, 1);
    assert.equal(games[0]!.winnerId, entrant(1).id);

    const lastCall = env.fake.callsFor('reportBracketSet').at(-1)!;
    assert.deepEqual(lastCall.variables.gameData, [
      {
        gameNum: 1,
        winnerId: entrant(1).id,
        stageId: 19, // Battlefield
        selections: [
          { entrantId: entrant(1).id, characterId: 6 }, // Fox
          { entrantId: entrant(2).id, characterId: 14 }, // Marth
        ],
      },
    ]);

    const r2 = await wii.reportScore(SET, [game(1, 2, 9), game(2, 2, 9), game(1, 2, 9)]);
    assert.equal(r2.resp.msg, '2-1');
    assert.equal(env.fake.getSet(SET).games.length, 3);

    // Stocks and costume (auto-scored games) become the per-game scores,
    // Replay Reporter for Slippi style: (costume + 1) * 100 + stocks.
    const r3 = await wii.reportScore(SET, [game(1, 2, 9, 0x1f, [3, 0], [1, 0])]);
    assert.equal(r3.resp.msg, '1-0');
    const scored = env.fake.callsFor('reportBracketSet').at(-1)!.variables.gameData as { entrant1Score?: number; entrant2Score?: number }[];
    assert.equal(scored[0]!.entrant1Score, 203, 'second costume, 3 stocks');
    assert.equal(scored[0]!.entrant2Score, 100, 'default costume, 0 stocks');
    // Unknown costume: stocks only. Unknown stocks (hand-scored): no score at all.
    const r4 = await wii.reportScore(SET, [game(2, 2, 9, 0x1f, [0, 4], [0xff, 0xff]), game(1)]);
    assert.equal(r4.resp.msg, '1-1');
    const mixed = env.fake.callsFor('reportBracketSet').at(-1)!.variables.gameData as { entrant1Score?: number; entrant2Score?: number }[];
    assert.deepEqual([mixed[0]!.entrant1Score, mixed[0]!.entrant2Score], [0, 4]);
    assert.equal(mixed[1]!.entrant1Score, undefined);
    assert.equal(mixed[1]!.entrant2Score, undefined);
  });

  await t.test('a hand-scored game (0xFF characters, stage 0) reports the winner only', async () => {
    // 0 is Captain Falcon on the external scale, so "unknown" is 0xFF.
    const r = await wii.reportScore(SET, [game(2, 0xff, 0xff, 0)]);
    assert.equal(r.resp.status, RelayStatus.ST_OK);
    const lastCall = env.fake.callsFor('reportBracketSet').at(-1)!;
    assert.deepEqual(lastCall.variables.gameData, [{ gameNum: 1, winnerId: entrant(2).id }]);
  });

  await t.test('END_SET with an undecided score is refused locally', async () => {
    const r = await wii.endSet(SET, [game(1), game(2)]);
    assert.equal(r.resp.status, RelayStatus.ST_INTERNAL);
    assert.equal(r.resp.msg, 'no winner at 1-1 bo5');
    assert.equal(env.fake.getSet(SET).state, 2, 'nothing went upstream');
  });

  await t.test('END_SET with a decided score completes the set and frees the station', async () => {
    const r = await wii.endSet(SET, [game(1), game(2), game(1), game(1)]);
    assert.equal(r.resp.status, RelayStatus.ST_OK);
    assert.equal(r.resp.msg, 'final 3-1');
    assert.equal(env.fake.getSet(SET).state, 3);
    assert.equal(env.state.get(3), undefined);
  });

  await t.test('the completed set never comes back after a cache refresh', async () => {
    await env.cache.refresh();
    const { sets } = await wii.listSets();
    assert.ok(!sets.some((s) => s.set_id === SET));
  });
});

test('stream station rules', async (t) => {
  const env = await setup();
  t.after(env.close);

  await t.test('stream flag from a non-stream station is refused (ST_NOT_STREAM)', async () => {
    const r = await env.wii(4).startSet(SET, 1);
    assert.equal(r.resp.status, RelayStatus.ST_NOT_STREAM);
    assert.equal(env.fake.getSet(SET).state, 1, 'nothing went upstream');
  });

  await t.test('stream station start assigns the configured stream', async () => {
    const r = await env.wii(STREAM_STATION, 1).startSet(SET, 1);
    assert.equal(r.resp.status, RelayStatus.ST_OK);
    assert.equal(env.fake.getSet(SET).stream!.id, STREAM_ID);
  });
});

test('assignStream fails after markSetInProgress (section 8 row 4)', async (t) => {
  const env = await setup();
  t.after(env.close);

  env.fake.failNext('assignStream', 'gqlError', 1, 'Stream not found');
  const r = await env.wii(STREAM_STATION, 1).startSet(SET, 1);
  assert.equal(r.resp.status, RelayStatus.ST_STARTGG_ERROR);
  assert.equal(r.resp.msg, 'stream assign failed - ask TO');

  // The set IS in progress and the station keeps the claim: play proceeds,
  // the TO assigns the stream by hand off the flagged status row.
  assert.equal(env.fake.getSet(SET).state, 2);
  assert.equal(env.state.get(STREAM_STATION)!.setId, SET);
  const flags = env.state.flags();
  assert.equal(flags.length, 1);
  assert.match(flags[0]!.message, /assignStream failed/);

  const score = await env.wii(STREAM_STATION).reportScore(SET, [game(1)]);
  assert.equal(score.resp.status, RelayStatus.ST_OK);
});

test('upstream 5xx handling (section 8 row 5)', async (t) => {
  const env = await setup();
  t.after(env.close);
  const wii = env.wii(5);
  await wii.startSet(SET);

  await t.test('two 5xx are retried invisibly', async () => {
    const before = env.fake.callsFor('reportBracketSet').length;
    env.fake.failNext('reportBracketSet', '5xx', 2);
    const r = await wii.reportScore(SET, [game(1)]);
    assert.equal(r.resp.status, RelayStatus.ST_OK);
    assert.equal(env.fake.callsFor('reportBracketSet').length, before + 3);
  });

  await t.test('three 5xx exhaust the retries, flag the row, and a later retry is safe', async () => {
    env.fake.failNext('reportBracketSet', '5xx', 3);
    const r = await wii.reportScore(SET, [game(1), game(1)]);
    assert.equal(r.resp.status, RelayStatus.ST_STARTGG_ERROR);
    assert.equal(r.resp.msg, 'start.gg error - retry');
    assert.equal(env.state.flags().length, 1);
    assert.equal(env.fake.getSet(SET).games.length, 1, 'failed report changed nothing upstream');

    // The player presses the button again: full overwrite makes it safe.
    const retry = await wii.reportScore(SET, [game(1), game(1)]);
    assert.equal(retry.resp.status, RelayStatus.ST_OK);
    assert.equal(env.fake.getSet(SET).games.length, 2);
  });
});

test('upstream 4xx: set completed by the TO (section 8 row 6, R6)', async (t) => {
  const env = await setup();
  t.after(env.close);
  const wii = env.wii(6);
  await wii.startSet(SET);
  await wii.reportScore(SET, [game(1)]);

  // The TO reports the set by hand on start.gg.
  env.fake.getSet(SET).state = 3;

  const r = await wii.reportScore(SET, [game(1), game(1)]);
  assert.equal(r.resp.status, RelayStatus.ST_STARTGG_ERROR);
  assert.equal(r.resp.msg, 'start.gg rejected - ask TO');

  // Next refresh drops the completed set; the next LIST_SETS clears the claim.
  await env.cache.refresh();
  const { sets } = await wii.listSets();
  assert.ok(!sets.some((s) => s.set_id === SET));
  assert.equal(env.state.get(6), undefined);
});

test('rate limited request gets ST_RATE_LIMITED (section 8 row 7)', async (t) => {
  // A 2-token bucket refilling one token a minute: the initial cache
  // refresh and the first start each take one; the next upstream call
  // cannot get a token inside the 50 ms budget.
  const env = await setup({ limits: { capacity: 2, refillPerMinute: 1, maxWaitMs: 50 } });
  t.after(env.close);

  const first = await env.wii(3).startSet(SET);
  assert.equal(first.resp.status, RelayStatus.ST_OK);
  const second = await env.wii(4).startSet(107949995);
  assert.equal(second.resp.status, RelayStatus.ST_RATE_LIMITED);
  assert.equal(second.resp.msg, 'rate limited; retry');
});

test('station reboot mid-set (section 8 row 8)', async (t) => {
  const env = await setup();
  t.after(env.close);
  const wii = env.wii(7);
  await wii.startSet(SET);
  await wii.reportScore(SET, [game(1), game(2)]);
  await env.cache.refresh(); // relay has seen the games upstream

  // Reboot: the Wii lost everything and lists again. Its own set comes
  // first with state=1; selecting it is a no-op resume with no upstream call.
  const { sets } = await wii.listSets();
  assert.equal(sets[0]!.set_id, SET);
  assert.equal(sets[0]!.state, 1);

  const upstreamBefore = env.fake.calls.length;
  const r = await wii.startSet(SET);
  assert.equal(r.resp.status, RelayStatus.ST_OK);
  assert.equal(r.resp.msg, 'resumed');
  assert.equal(env.fake.calls.length, upstreamBefore, 'resume makes no upstream call');
  assert.equal(env.state.get(7)!.games.length, 2, 'games reloaded from the cache');
});

test('claim guards', async (t) => {
  const env = await setup();
  t.after(env.close);
  const wii = env.wii(8);

  await t.test('unknown set id', async () => {
    const r = await wii.startSet(424242);
    assert.equal(r.resp.status, RelayStatus.ST_SET_NOT_FOUND);
  });

  await t.test('a station with a set cannot start a different one', async () => {
    await wii.startSet(SET);
    const r = await wii.startSet(107949995);
    assert.equal(r.resp.status, RelayStatus.ST_INTERNAL);
    assert.equal(r.resp.msg, 'finish current set first');
  });

  await t.test('reporting a set the station does not hold', async () => {
    const r = await wii.reportScore(107949995, [game(1)]);
    assert.equal(r.resp.status, RelayStatus.ST_SET_NOT_FOUND);
  });

  await t.test('a set the TO started by hand upstream is not claimable', async () => {
    await env.startgg.markSetInProgress(107949996);
    await env.cache.refresh();
    const r = await env.wii(9).startSet(107949996);
    assert.equal(r.resp.status, RelayStatus.ST_SET_TAKEN);
    assert.equal(r.resp.msg, 'in progress on start.gg');
  });

  await t.test('an out-of-range character or stage value never blocks the report (decisions.md R13)', async () => {
    // ext 77 has no start.gg character mapping and 0x15 (Akaneia) no stage
    // mapping: both are dropped, the mapped Marth selection and the winner
    // still go through.
    const r = await wii.reportScore(SET, [game(1, 77, 9, 0x15)]);
    assert.equal(r.resp.status, RelayStatus.ST_OK);
    assert.equal(r.resp.msg, '1-0');
    const games = env.fake.getSet(SET).games;
    assert.equal(games.at(-1)!.winnerId, entrant(1).id);
    const lastCall = env.fake.callsFor('reportBracketSet').at(-1)!;
    assert.deepEqual(lastCall.variables.gameData, [
      { gameNum: 1, winnerId: entrant(1).id, selections: [{ entrantId: entrant(2).id, characterId: 14 }] },
    ]);
  });
});

test('abandon (section 5.6)', async (t) => {
  const env = await setup();
  t.after(env.close);
  const wii = env.wii(10);

  await t.test('abandoning an unplayed set resets it upstream and frees it', async () => {
    await wii.startSet(SET);
    const r = await wii.abandonSet(SET);
    assert.equal(r.resp.status, RelayStatus.ST_OK);
    assert.equal(env.fake.getSet(SET).state, 1);
    assert.equal(env.state.get(10), undefined);
    await env.cache.refresh();
    const { sets } = await wii.listSets();
    assert.ok(sets.some((s) => s.set_id === SET));
  });

  await t.test('abandoning a set with reported games is a TO decision', async () => {
    await wii.startSet(SET);
    await wii.reportScore(SET, [game(1)]);
    const r = await wii.abandonSet(SET);
    assert.equal(r.resp.status, RelayStatus.ST_INTERNAL);
    assert.equal(r.resp.msg, 'set has games - ask TO');
    assert.equal(env.fake.getSet(SET).state, 2, 'set untouched upstream');
  });

  await t.test('abandoning a set the station does not hold', async () => {
    const r = await env.wii(11).abandonSet(SET);
    assert.equal(r.resp.status, RelayStatus.ST_SET_NOT_FOUND);
  });

  await t.test('abandoning a stream set leaves the stream assigned upstream', async () => {
    // Verified live 2026-09-20 (architecture.md "start.gg calls"): resetSet does not
    // clear a stream assignment; only the TO can, by hand.
    const streamWii = env.wii(STREAM_STATION, 1);
    await streamWii.startSet(107949995, 1);
    const r = await streamWii.abandonSet(107949995);
    assert.equal(r.resp.status, RelayStatus.ST_OK);
    assert.equal(env.fake.getSet(107949995).state, 1);
    assert.equal(env.fake.getSet(107949995).stream!.id, STREAM_ID);
  });
});

test('LIST_SETS caps at the wire limit of MAX_SETS rows', async (t) => {
  const sets: FakeSet[] = [];
  for (let i = 0; i < MAX_SETS + 6; i++) {
    sets.push({
      id: 200_000 + i,
      state: 1,
      round: 1,
      fullRoundText: 'Winners Round 1',
      totalGames: 3,
      slots: [entrant(1), entrant(2)],
      games: [],
      stream: null,
    });
  }
  const env = await setup({ sets });
  t.after(env.close);

  const { resp, sets: listed } = await env.wii(3).listSets();
  assert.equal(resp.status, RelayStatus.ST_OK);
  assert.equal(listed.length, MAX_SETS);
});

// ---- shared secret (decisions.md R16) ----

test('a wrong secret is refused with ST_BAD_SECRET and nothing happens upstream or on the status page', async () => {
  const env = await setup();
  try {
    const before = env.fake.calls.length;
    const r = await rawRequest(env.port, 3, RelayCmd.CMD_START_SET, encodeStartSetReq({ set_id: SET, stream: 0 }), {
      secret: 'not-the-secret',
    });
    assert.equal(r.resp.status, RelayStatus.ST_BAD_SECRET);
    assert.equal(r.resp.msg, 'wrong relay secret');
    assert.equal(r.hdr.cmd, RelayCmd.CMD_START_SET, 'the reply echoes the command');
    assert.equal(env.fake.calls.length, before, 'no start.gg call');
    assert.equal(env.state.get(3), undefined, 'no claim');
    assert.equal(env.state.lastAction(3), undefined, 'an unauthenticated station number makes no status row');
    const rf = env.server.refused();
    assert.equal(rf?.count, 1);
    assert.equal(rf?.lastStation, 3);
    assert.equal(rf?.lastReason, 'wrong relay secret');
  } finally {
    await env.close();
  }
});

test('a host that sends no relay_auth at all is told so, within its own framing', async () => {
  const env = await setup();
  try {
    const r = await rawRequest(env.port, 5, RelayCmd.CMD_LIST_SETS, new Uint8Array(0), { secret: null });
    assert.equal(r.resp.status, RelayStatus.ST_BAD_SECRET);
    assert.equal(r.resp.msg, 'no relay secret sent');
    assert.equal(r.hdr.station, 5);
  } finally {
    await env.close();
  }
});

test('the right secret goes through (every other test here uses it)', async () => {
  const env = await setup();
  try {
    const { resp } = await env.wii(3).listSets();
    assert.equal(resp.status, RelayStatus.ST_OK);
    assert.equal(env.server.refused(), null);
  } finally {
    await env.close();
  }
});
