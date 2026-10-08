import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StartggClient, StartggError, RateLimitedError } from '../src/startgg.js';
import {
  makeFake,
  FIXTURE_TOKEN,
  FIXTURE_EVENT_ID,
  entrant,
  type FakeStartgg,
} from './fake-startgg.js';

function client(
  fake: FakeStartgg,
  opts: Partial<ConstructorParameters<typeof StartggClient>[0]> = {},
) {
  return new StartggClient({
    endpoint: fake.url,
    token: FIXTURE_TOKEN,
    retryDelaysMs: [0, 0],
    ...opts,
  });
}

test('startgg client', async (t) => {
  const fake = makeFake();
  await fake.start();
  t.after(() => fake.close());
  const SET = 107949994;

  await t.test('getEventSets returns every state-1/2 node, preview ids included', async () => {
    const sets = await client(fake).getEventSets(FIXTURE_EVENT_ID);
    assert.equal(sets.length, 11);
    assert.ok(sets.some((s) => typeof s.id === 'string' && s.id.startsWith('preview_')));
    const first = sets.find((s) => s.id === SET)!;
    assert.equal(first.totalGames, 5);
    assert.equal(first.slots[0]!.entrant!.name, 'Alpha');
  });

  await t.test('unknown event is rejected without retry', async () => {
    await assert.rejects(
      client(fake).getEventSets(999),
      (e: StartggError) => e.kind === 'rejected',
    );
  });

  await t.test('mutations send the token and reach the fake', async () => {
    await client(fake).markSetInProgress(SET);
    assert.equal(fake.getSet(SET).state, 2);
    await client(fake).assignStream(SET, 1358079);
    assert.equal(fake.getSet(SET).stream!.id, 1358079);
    await client(fake).reportGames(SET, [{ gameNum: 1, winnerId: entrant(1).id }]);
    assert.equal(fake.getSet(SET).games.length, 1);
    assert.equal(fake.getSet(SET).state, 2);
    await client(fake).reportWinner(SET, entrant(1).id, [
      { gameNum: 1, winnerId: entrant(1).id },
      { gameNum: 2, winnerId: entrant(1).id },
    ]);
    assert.equal(fake.getSet(SET).state, 3);
    await client(fake).resetSet(SET);
    assert.equal(fake.getSet(SET).state, 1);
  });

  await t.test(
    "START_SET's participants and END_SET's completedAt and stream come back",
    async () => {
      const fake2 = makeFake();
      await fake2.start();
      try {
        const set = fake2.getSet(SET);
        set.slots[0] = {
          ...entrant(1),
          name: 'LZY | Alpha',
          participants: [{ id: 61, gamerTag: ' Alpha ', prefix: 'LZY', pronouns: 'she/her' }],
        };
        set.stream = { id: 8001, streamName: 'lazytomelee', streamSource: 'TWITCH' };
        set.completedAt = 1791056530;
        const started = await client(fake2).markSetInProgress(SET);
        assert.deepEqual(started.entrants, [
          {
            id: entrant(1).id,
            participants: [{ id: 61, gamerTag: ' Alpha ', prefix: 'LZY', pronouns: 'she/her' }],
          },
          {
            id: entrant(2).id,
            participants: [
              { id: entrant(2).id + 1_000_000, gamerTag: 'Bravo', prefix: '', pronouns: '' },
            ],
          },
        ]);
        const reported = await client(fake2).reportWinner(SET, entrant(1).id, [
          { gameNum: 1, winnerId: entrant(1).id },
        ]);
        assert.deepEqual(reported, {
          completedAt: 1791056530,
          stream: { id: 8001, streamName: 'lazytomelee', streamSource: 'TWITCH' },
        });
      } finally {
        await fake2.close();
      }
    },
  );

  await t.test(
    "REST goes to the endpoint's origin without the token; a 5xx is retried twice",
    async () => {
      fake.failNext('restPhaseGroup', '5xx', 2);
      const c = client(fake);
      const before = c.callsInWindow();
      const json = await c.getPhaseGroupRest(3290148);
      assert.equal(json.entities.groups.groupTypeId, 2);
      assert.equal(c.callsInWindow(), before + 3);
      const last = fake.restCalls.at(-1)!;
      assert.equal(
        last.path,
        '/phase_group/3290148?expand[]=sets&expand[]=entrants&expand[]=seeds&bustCache=true',
      );
      assert.equal(last.auth, null, 'no token, as Replay Reporter sends it');
      fake.failNext('restPhaseGroup', '5xx', 3);
      await assert.rejects(
        c.getPhaseGroupRest(3290148),
        (e: StartggError) => e.kind === 'upstream_5xx',
      );
    },
  );

  await t.test('wrong token surfaces as rejected', async () => {
    await assert.rejects(
      client(fake, { token: 'bad' }).markSetInProgress(SET),
      (e: StartggError) => e.kind === 'rejected',
    );
  });

  await t.test('5xx is retried twice then succeeds', async () => {
    const before = fake.callsFor('markSetInProgress').length;
    fake.failNext('markSetInProgress', '5xx', 2);
    await client(fake).markSetInProgress(SET);
    assert.equal(fake.callsFor('markSetInProgress').length, before + 3);
  });

  await t.test('three 5xx in a row exhausts the retries', async () => {
    const before = fake.callsFor('markSetInProgress').length;
    fake.failNext('markSetInProgress', '5xx', 3);
    await assert.rejects(
      client(fake).markSetInProgress(SET),
      (e: StartggError) => e.kind === 'upstream_5xx',
    );
    assert.equal(fake.callsFor('markSetInProgress').length, before + 3); // 1 + exactly 2 retries
  });

  await t.test('a GraphQL error is never retried', async () => {
    const before = fake.callsFor('resetSet').length;
    fake.failNext('resetSet', 'gqlError', 1, 'Set not found');
    await assert.rejects(client(fake).resetSet(123), (e: StartggError) => {
      assert.equal(e.kind, 'rejected');
      assert.match(e.message, /Set not found/);
      return true;
    });
    assert.equal(fake.callsFor('resetSet').length, before + 1);
  });

  await t.test('network error is never retried', async () => {
    const dead = new StartggClient({
      endpoint: 'http://127.0.0.1:1/gql/alpha',
      token: FIXTURE_TOKEN,
      retryDelaysMs: [0, 0],
    });
    await assert.rejects(dead.markSetInProgress(SET), (e: StartggError) => e.kind === 'network');
  });

  await t.test('rate limiter waits for a token that arrives within the budget', async () => {
    // 1-token bucket refilling 1200/min = one token every 50 ms.
    const c = client(fake, { limits: { capacity: 1, refillPerMinute: 1200, maxWaitMs: 500 } });
    await c.markSetInProgress(SET);
    const t0 = Date.now();
    await c.markSetInProgress(SET);
    assert.ok(Date.now() - t0 >= 40, 'second call should have waited for a refill');
  });

  await t.test('rate limiter rejects when no token can arrive in time', async () => {
    // 1-token bucket refilling 1/min: next token is ~60 s away, budget is 50 ms.
    const c = client(fake, { limits: { capacity: 1, refillPerMinute: 1, maxWaitMs: 50 } });
    await c.markSetInProgress(SET);
    const before = fake.callsFor('markSetInProgress').length;
    await assert.rejects(c.markSetInProgress(SET), RateLimitedError);
    assert.equal(fake.callsFor('markSetInProgress').length, before); // never reached the wire
  });

  await t.test('callsInWindow counts actual HTTP requests', async () => {
    const c = client(fake);
    assert.equal(c.callsInWindow(), 0);
    await c.markSetInProgress(SET);
    fake.failNext('markSetInProgress', '5xx', 2);
    await c.markSetInProgress(SET); // 3 HTTP requests
    assert.equal(c.callsInWindow(), 4);
  });
});
