// Pins the fake's semantics to what a read-only probe recorded from the real
// API, so later tests against the fake are testing the right behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeFake,
  FIXTURE_TOKEN,
  FIXTURE_EVENT_ID,
  entrant,
  type FakeStartgg,
} from './fake-startgg.js';

async function gql(
  fake: FakeStartgg,
  query: string,
  variables: Record<string, unknown>,
  token = FIXTURE_TOKEN,
) {
  const res = await fetch(fake.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

const REPORT = `mutation Report($setId: ID!, $winnerId: ID, $gameData: [BracketSetGameDataInput]) {
  reportBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData) { id state }
}`;

test('fake start.gg', async (t) => {
  const fake = makeFake();
  await fake.start();
  t.after(() => fake.close());

  const SET = 107949994;
  const [p1, p2] = [entrant(1).id, entrant(2).id];

  await t.test('rejects a bad token with 401', async () => {
    const { status } = await gql(fake, 'query { event(id: 1) { id } }', {}, 'wrong');
    assert.equal(status, 401);
  });

  await t.test('event sets query returns pending sets including preview ids', async () => {
    const { status, json } = await gql(
      fake,
      'query Sets($eventId: ID!) { event(id: $eventId) { id sets(perPage: 100, filters: {state: [1, 2]}) { nodes { id state round fullRoundText totalGames slots { entrant { id name } } games { orderNum winnerId } stream { id } } } } }',
      { eventId: FIXTURE_EVENT_ID },
    );
    assert.equal(status, 200);
    const nodes = json.data.event.sets.nodes;
    assert.ok(nodes.some((n: any) => n.id === SET));
    assert.ok(nodes.some((n: any) => typeof n.id === 'string' && n.id.startsWith('preview_')));
    const first = nodes.find((n: any) => n.id === SET);
    assert.equal(first.games, null); // no games yet -> null, like the real API
    assert.equal(first.slots[0].entrant.name, 'Alpha');
  });

  await t.test('selecting gameNum on games is rejected like the real schema', async () => {
    const { json } = await gql(
      fake,
      'query Sets($eventId: ID!) { event(id: $eventId) { sets { nodes { id games { gameNum winnerId } } } } }',
      { eventId: FIXTURE_EVENT_ID },
    );
    assert.match(json.errors[0].message, /Cannot query field "gameNum"/);
  });

  await t.test('markSetInProgress moves state 1 -> 2', async () => {
    const { json } = await gql(
      fake,
      'mutation Start($setId: ID!) { markSetInProgress(setId: $setId) { id state } }',
      {
        setId: SET,
      },
    );
    assert.equal(json.data.markSetInProgress.state, 2);
    assert.equal(fake.getSet(SET).state, 2);
  });

  await t.test('assignStream attaches the stream with no precondition', async () => {
    const { json } = await gql(
      fake,
      'mutation Assign($setId: ID!, $streamId: ID!) { assignStream(setId: $setId, streamId: $streamId) { id stream { id } } }',
      { setId: SET, streamId: 1358079 },
    );
    assert.equal(json.data.assignStream.stream.id, 1358079);
  });

  await t.test(
    'reportBracketSet without winnerId overwrites games, set stays state 2',
    async () => {
      await gql(fake, REPORT, { setId: SET, gameData: [{ gameNum: 1, winnerId: p1 }] });
      const firstIds = fake.getSet(SET).games.map((g) => g.id);

      const { json } = await gql(fake, REPORT, {
        setId: SET,
        gameData: [
          { gameNum: 1, winnerId: p1 },
          { gameNum: 2, winnerId: p2 },
        ],
      });
      assert.equal(json.data.reportBracketSet[0].state, 2);
      const games = fake.getSet(SET).games;
      assert.equal(games.length, 2);
      // Full overwrite: the old row's id is gone, fresh ids assigned.
      assert.ok(!games.some((g) => firstIds.includes(g.id)));
    },
  );

  await t.test('reportBracketSet with winnerId completes the set', async () => {
    const { json } = await gql(fake, REPORT, {
      setId: SET,
      winnerId: p1,
      gameData: [
        { gameNum: 1, winnerId: p1 },
        { gameNum: 2, winnerId: p2 },
        { gameNum: 3, winnerId: p1 },
      ],
    });
    assert.equal(json.data.reportBracketSet[0].state, 3);
  });

  await t.test('reporting a completed set is a GraphQL error (the R6 case)', async () => {
    const { status, json } = await gql(fake, REPORT, {
      setId: SET,
      gameData: [{ gameNum: 1, winnerId: p1 }],
    });
    assert.equal(status, 200);
    assert.match(json.errors[0].message, /already been completed/);
  });

  await t.test(
    'resetSet returns the set to pending with no games, keeping the stream',
    async () => {
      const { json } = await gql(
        fake,
        'mutation Reset($setId: ID!) { resetSet(setId: $setId) { id state } }',
        {
          setId: SET,
        },
      );
      assert.equal(json.data.resetSet.state, 1);
      assert.equal(fake.getSet(SET).games.length, 0);
      // Verified live 2026-09-20 (architecture.md "start.gg calls"): the real resetSet
      // does not clear the stream assigned by the earlier assignStream.
      assert.equal(fake.getSet(SET).stream?.id, 1358079);
    },
  );

  await t.test('failNext injects 5xx then recovers, and calls are recorded', async () => {
    const before = fake.callsFor('resetSet').length;
    fake.failNext('resetSet', '5xx', 2);
    assert.equal(
      (
        await gql(fake, 'mutation R($setId: ID!) { resetSet(setId: $setId) { id } }', {
          setId: SET,
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await gql(fake, 'mutation R($setId: ID!) { resetSet(setId: $setId) { id } }', {
          setId: SET,
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await gql(fake, 'mutation R($setId: ID!) { resetSet(setId: $setId) { id } }', {
          setId: SET,
        })
      ).status,
      200,
    );
    assert.equal(fake.callsFor('resetSet').length, before + 3);
  });
});
