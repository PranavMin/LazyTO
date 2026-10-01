import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SetCache, abbreviateRound, wireRoundName } from '../src/cache.js';
import { StartggClient } from '../src/startgg.js';
import { makeFake, defaultFixture, FIXTURE_TOKEN, FIXTURE_EVENT_ID, FIXTURE_PHASE_ORDER, entrant } from './fake-startgg.js';

function makeClient(url: string) {
  return new StartggClient({ endpoint: url, token: FIXTURE_TOKEN, retryDelaysMs: [0, 0] });
}

async function until(cond: () => boolean, what: string, deadlineMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > deadlineMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('abbreviateRound', () => {
  assert.equal(abbreviateRound('Winners Round 2'), 'WR2');
  assert.equal(abbreviateRound('Winners Quarter-Final'), 'WQF');
  assert.equal(abbreviateRound('Winners Semi-Final'), 'WSF');
  assert.equal(abbreviateRound('Winners Final'), 'WF');
  assert.equal(abbreviateRound('Losers Round 1'), 'LR1');
  assert.equal(abbreviateRound('Losers Final'), 'LF');
  assert.equal(abbreviateRound('Grand Final'), 'GF');
  assert.equal(abbreviateRound('Grand Final Reset'), 'GFR');
  assert.equal(abbreviateRound('Round 3'), 'R3');
  // Unrecognized wording ships verbatim, clipped to the 16-char wire field.
  assert.equal(abbreviateRound('Some Custom Round Name Here'), 'Some Custom Roun');
});

test('set cache', async (t) => {
  const fake = makeFake();
  await fake.start();
  t.after(() => fake.close());
  const client = makeClient(fake.url);

  await t.test('top8q decides best-of from the bracket shape, not totalGames', async () => {
    // Fixture: one phase, winners 1..4 (Grand Final 4); WQF round 1 = GF - 3: Bo5.
    const c1 = new SetCache(client, FIXTURE_EVENT_ID, 'top8q');
    await c1.refresh();
    assert.equal(c1.get(107949994)!.bestOf, 5);

    // Now a Bracket phase of WQF, LR1 and LR2 feeding a Top 8 phase (Grand
    // Final round 3). The feeder's last rounds, WQF and LR2, are the
    // qualifiers: Bo5. LR1 before them is Bo3, whatever totalGames says. The
    // Top 8's Winners Semi-Final is Bo5.
    const top8 = FIXTURE_PHASE_ORDER + 1;
    const sets = defaultFixture().slice(0, 4); // the four WQF sets
    sets.push({ ...sets[0]!, id: 107949900, round: -1, fullRoundText: 'Losers Round 1' });
    sets.push({ ...sets[0]!, id: 107949904, round: -2, fullRoundText: 'Losers Round 2', slots: [null, null] });
    sets.push({ ...sets[0]!, id: 107949901, round: 1, fullRoundText: 'Winners Semi-Final', phaseOrder: top8 });
    sets.push({ ...sets[0]!, id: 107949902, round: 3, fullRoundText: 'Grand Final', phaseOrder: top8, slots: [null, null] });
    sets.push({ ...sets[0]!, id: 107949903, round: -6, fullRoundText: 'Losers Final', phaseOrder: top8, slots: [null, null] });
    const f2 = makeFake(sets);
    await f2.start();
    try {
      const c2 = new SetCache(makeClient(f2.url), FIXTURE_EVENT_ID, 'top8q');
      await c2.refresh();
      assert.equal(c2.get(107949900)!.bestOf, 3);
      assert.equal(c2.get(107949994)!.bestOf, 5);
      assert.equal(c2.get(107949901)!.bestOf, 5);
    } finally {
      f2.close();
    }
  });

  await t.test('refresh keeps numeric both-entrant sets and drops preview ids with a warning', async () => {
    const cache = new SetCache(client, FIXTURE_EVENT_ID, 'startgg');
    await cache.refresh();

    // Fixture: 4 numeric sets with both entrants, 5 with TBD slots, 2 preview.
    const pending = cache.pending();
    assert.deepEqual(
      pending.map((s) => s.id),
      [107949994, 107949995, 107949996, 107949997],
    );
    assert.equal(pending[0]!.roundShort, 'WQF');
    assert.equal(pending[0]!.bestOf, 5);
    assert.equal(pending[0]!.p1.tag, 'Alpha');

    const status = cache.status();
    assert.equal(status.count, 4);
    assert.equal(status.error, null);
    assert.ok(status.refreshedAt > 0);
    assert.equal(status.warnings.length, 1);
    assert.match(status.warnings[0]!, /2 preview-id set\(s\) dropped/);
    assert.match(status.warnings[0]!, /R8/);
  });

  await t.test('pending sorts earliest rounds first, winners before losers', async () => {
    const sets = defaultFixture().map((s) => ({ ...s }));
    // Give the TBD sets entrants so round ordering is visible.
    for (const s of sets) {
      if (!s.slots[0]) s.slots = [entrant(13), entrant(14)];
    }
    const f2 = makeFake(sets);
    await f2.start();
    try {
      const cache = new SetCache(makeClient(f2.url), FIXTURE_EVENT_ID, 'startgg');
      await cache.refresh();
      assert.deepEqual(
        cache.pending().map((s) => s.roundShort),
        ['WQF', 'WQF', 'WQF', 'WQF', 'LR1', 'WSF', 'WF', 'LF', 'GF'],
      );
    } finally {
      await f2.close();
    }
  });

  await t.test('in-progress sets stay cached with games mapped to winner slots', async () => {
    const SET = 107949995;
    await client.markSetInProgress(SET);
    await client.reportGames(SET, [
      { gameNum: 1, winnerId: entrant(3).id },
      { gameNum: 2, winnerId: entrant(4).id },
    ]);

    const cache = new SetCache(client, FIXTURE_EVENT_ID, 'startgg');
    await cache.refresh();
    const s = cache.get(SET)!;
    assert.equal(s.state, 2);
    assert.deepEqual(s.games, [
      { orderNum: 1, winnerSlot: 1 },
      { orderNum: 2, winnerSlot: 2 },
    ]);
    // In progress -> not selectable.
    assert.ok(!cache.pending().some((p) => p.id === SET));
    await client.resetSet(SET);
  });

  await t.test('a failed refresh keeps the old data and records the error', async () => {
    const cache = new SetCache(client, FIXTURE_EVENT_ID, 'startgg');
    await cache.refresh();
    const countBefore = cache.status().count;

    fake.failNext('eventSets', '5xx', 3);
    await assert.rejects(cache.refresh());
    assert.equal(cache.status().count, countBefore, 'old data survives a failed refresh');
    assert.ok(cache.status().error);

    await cache.refresh(); // recovery clears the error
    assert.equal(cache.status().error, null);
  });

  await t.test('start() refreshes on the interval and routes errors to the callback', async () => {
    const errors: Error[] = [];
    const cache = new SetCache(client, FIXTURE_EVENT_ID, 'startgg', (e) => errors.push(e));
    await cache.refresh();
    const before = fake.callsFor('eventSets').length;

    fake.failNext('eventSets', '5xx', 3); // one full failed refresh (1 try + 2 retries)
    cache.start(25);
    try {
      // Tick 1: all three failures land on the same refresh (start() never
      // overlaps refreshes), so it exhausts its retries and rejects.
      await until(() => errors.length === 1, 'the failed refresh to reach the callback');
      // Later ticks keep refreshing, now successfully; wait for one to finish.
      await until(
        () => fake.callsFor('eventSets').length >= before + 4 && cache.status().error === null,
        'a successful refresh after the failed one',
      );
    } finally {
      cache.stop();
    }

    assert.ok(fake.callsFor('eventSets').length >= before + 4, 'interval kept refreshing');
    assert.equal(errors.length, 1, 'the failed refresh reached the callback');
    assert.equal(cache.status().error, null, 'recovery cleared the recorded error');
  });
});

test('wireRoundName: upper case, cut to the wire field', () => {
  assert.equal(wireRoundName('Winners Quarter-Final'), 'WINNERS QUARTER-FINAL');
  assert.equal(wireRoundName('Grand Final Reset'), 'GRAND FINAL RESET');
  assert.equal(wireRoundName('Some Custom Round Name Here Too'), 'SOME CUSTOM ROUND NAME H');
  assert.equal(wireRoundName('Winners Quarter-Final').length <= 24, true);
});
