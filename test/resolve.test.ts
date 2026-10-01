// resolve.test.ts -- short URL + names -> tonight's ids (src/resolve.ts),
// against the fake start.gg's admin-tournament fixture, which mirrors what
// probe.ts --mine / --tournament recorded on 2026-09-25.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StartggClient } from '../src/startgg.js';
import { resolveEvent, ResolveError, ADMIN_PAGE_SIZE, nearestWeekly, isWeeklyName } from '../src/resolve.js';
import {
  FakeStartgg,
  FIXTURE_TOKEN,
  FIXTURE_EVENT_ID,
  FIXTURE_TOURNAMENT,
  FIXTURE_EVENT_NAME,
  FIXTURE_STREAM_NAME,
  FIXTURE_STREAM_ID,
  defaultFixture,
  defaultTournaments,
  ABBEY_160_START,
  type FakeTournament,
} from './fake-startgg.js';

async function withFake<T>(tournaments: FakeTournament[], fn: (client: StartggClient, fake: FakeStartgg) => Promise<T>): Promise<T> {
  const fake = new FakeStartgg(FIXTURE_TOKEN, FIXTURE_EVENT_ID, defaultFixture(), tournaments);
  await fake.start();
  try {
    return await fn(new StartggClient({ endpoint: fake.url, token: FIXTURE_TOKEN, retryDelaysMs: [1, 1] }), fake);
  } finally {
    await fake.close();
  }
}

async function expectResolveError(p: Promise<unknown>, ...substrings: string[]): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ResolveError, `expected ResolveError, got ${e}`);
    for (const s of substrings) assert.ok(e.message.includes(s), `expected "${s}" in: ${e.message}`);
    return true;
  });
}

test('the test tournament resolves to its singles event and the SFMelee stream', async () => {
  await withFake(defaultTournaments(), async (client) => {
    const r = await resolveEvent(client, {
      tournament: FIXTURE_TOURNAMENT,
      eventName: FIXTURE_EVENT_NAME,
      streamName: FIXTURE_STREAM_NAME, weeklyNamePrefix: '',
    });
    assert.deepEqual(r, {
      foundBy: 'full slug',
      tournamentName: 'SF Melee Discord Test',
      tournamentSlug: 'tournament/sf-melee-discord-test',
      eventId: FIXTURE_EVENT_ID,
      eventName: 'Melee Singles! (7:30 Start)',
      streamId: FIXTURE_STREAM_ID,
      streamName: 'SFMelee',
    });
  });
});

test('"abbey" picks the week that currently holds the short URL, skipping doubles and the waitlist', async () => {
  await withFake(defaultTournaments(), async (client) => {
    const r = await resolveEvent(client, { tournament: 'abbey', eventName: 'melee singles', streamName: 'sfmelee', weeklyNamePrefix: '' });
    assert.equal(r.foundBy, 'short URL');
    assert.equal(r.tournamentSlug, 'tournament/melee-abbey-tavern-160');
    assert.equal(r.eventName, 'Melee Singles! (7:30 Start)');
    assert.equal(r.streamName, 'SFMelee');
  });
});

test('the short URL is found past the first page of admin tournaments', async () => {
  const filler: FakeTournament[] = Array.from({ length: ADMIN_PAGE_SIZE + 5 }, (_, i) => ({
    slug: `tournament/old-${i}`,
    shortSlug: `old${i}`,
    published: true,
    startAt: null,
    id: 800000 + i,
    name: `Old #${i}`,
    events: [],
    streams: [],
  }));
  await withFake([...filler, ...defaultTournaments()], async (client, fake) => {
    const r = await resolveEvent(client, { tournament: 'abbey', eventName: FIXTURE_EVENT_NAME, streamName: FIXTURE_STREAM_NAME, weeklyNamePrefix: '' });
    assert.equal(r.tournamentSlug, 'tournament/melee-abbey-tavern-160');
    assert.equal(fake.callsFor('adminTournaments').length, 2, 'stopped at the page that had it');
  });
});

test('an unknown short URL fails, counting what was searched', async () => {
  await withFake(defaultTournaments(), async (client) => {
    await expectResolveError(
      resolveEvent(client, { tournament: 'abbey161', eventName: FIXTURE_EVENT_NAME, streamName: FIXTURE_STREAM_NAME, weeklyNamePrefix: '' }),
      'no tournament with short URL "abbey161"',
      'among the 3 tournaments',
    );
  });
});

test('an unpublished tournament is not found by its short URL, and the error says to use the full slug', async () => {
  await withFake(defaultTournaments(), async (client, fake) => {
    await expectResolveError(
      resolveEvent(client, { tournament: 'sfmeleetest', eventName: FIXTURE_EVENT_NAME, streamName: FIXTURE_STREAM_NAME, weeklyNamePrefix: '' }),
      'no tournament with short URL "sfmeleetest"',
      'give its full slug instead',
    );
    assert.equal(fake.callsFor('tournament').length, 0, 'a short URL never falls through to a direct lookup');
  });
});

test('a full slug is fetched directly, without listing admin tournaments', async () => {
  await withFake(defaultTournaments(), async (client, fake) => {
    await resolveEvent(client, { tournament: FIXTURE_TOURNAMENT, eventName: FIXTURE_EVENT_NAME, streamName: FIXTURE_STREAM_NAME, weeklyNamePrefix: '' });
    assert.equal(fake.callsFor('adminTournaments').length, 0);
  });
});

test('an event name matching several singles events fails and lists them', async () => {
  await withFake(defaultTournaments(), async (client) => {
    await expectResolveError(
      resolveEvent(client, { tournament: FIXTURE_TOURNAMENT, eventName: 'Melee', streamName: FIXTURE_STREAM_NAME, weeklyNamePrefix: '' }),
      '3 Melee singles events',
      '"Melee Ladder (9:30pm)"',
    );
  });
});

test('a doubles event is never picked, even by exact name', async () => {
  await withFake(defaultTournaments(), async (client) => {
    await expectResolveError(
      resolveEvent(client, { tournament: 'abbey', eventName: 'Melee Doubles', streamName: FIXTURE_STREAM_NAME, weeklyNamePrefix: '' }),
      'no Melee singles events',
      '"Melee Doubles (6:30 pm Start)" (id',
    );
  });
});

test('a missing stream fails and lists the streams that exist', async () => {
  await withFake(defaultTournaments(), async (client) => {
    await expectResolveError(
      resolveEvent(client, { tournament: FIXTURE_TOURNAMENT, eventName: FIXTURE_EVENT_NAME, streamName: 'SFMeleeTV', weeklyNamePrefix: '' }),
      'no streams named "SFMeleeTV"',
      '"sidestream" (id 1358080)',
    );
  });
});

// ---- a numbered weekly when the short URL has not moved (taken from matchcaller) ----

const WEEKLY = 'Melee @ Abbey Tavern #';


const HOUR = 60 * 60;
const DAY = 24 * HOUR;

function withoutAbbeyShortUrl(): FakeTournament[] {
  // Tonight's #160 exists but the TO has not moved "abbey" onto it yet.
  return defaultTournaments().map((t) => (t.shortSlug === 'abbey' ? { ...t, shortSlug: null } : t));
}

test('short URL "abbey" not on any tournament: tonight\'s weekly is found by name and start time', async () => {
  await withFake(withoutAbbeyShortUrl(), async (client) => {
    const r = await resolveEvent(
      client,
      { tournament: 'abbey', eventName: FIXTURE_EVENT_NAME, streamName: FIXTURE_STREAM_NAME, weeklyNamePrefix: WEEKLY },
      ABBEY_160_START - 2 * HOUR, // 5:30 pm on the night, doors open
    );
    assert.equal(r.foundBy, 'nearest weekly');
    assert.equal(r.tournamentSlug, 'tournament/melee-abbey-tavern-160');
    assert.equal(r.eventName, 'Melee Singles! (7:30 Start)');
  });
});

test('the short URL wins over the nearest weekly when both exist', async () => {
  await withFake(defaultTournaments(), async (client) => {
    // Two days after #159, so #159 is nearer than #160, but "abbey" is on #160.
    const r = await resolveEvent(
      client,
      { tournament: 'abbey', eventName: FIXTURE_EVENT_NAME, streamName: FIXTURE_STREAM_NAME, weeklyNamePrefix: WEEKLY },
      ABBEY_160_START - 5 * DAY,
    );
    assert.equal(r.foundBy, 'short URL');
    assert.equal(r.tournamentSlug, 'tournament/melee-abbey-tavern-160');
  });
});

test('nearest weekly: closest start wins, a future one breaks a tie, non-weekly names and far dates never count', () => {
  const t = (name: string, startAt: number | null, slug = name) => ({ slug, shortSlug: null, name, startAt });
  const now = 1_000_000_000;
  const list = [
    t('Melee @ Abbey Tavern #1', now - 3 * DAY, 'past'),
    t('Melee @ Abbey Tavern #2', now + 3 * DAY, 'future'),
    t('Weekend Doubles @ Abbey Tavern', now + HOUR, 'doubles'),
    t('The Big Abbey 3: HUGE', now, 'big'),
    t('Melee @ Abbey Tavern #9', null, 'no-date'),
  ];
  assert.equal(nearestWeekly(list, WEEKLY, now)?.slug, 'future', 'equal distance: the future one');
  assert.equal(nearestWeekly(list, WEEKLY, now - DAY)?.slug, 'past');
  assert.equal(nearestWeekly([t('Melee @ Abbey Tavern #1', now - 31 * DAY)], WEEKLY, now), null, 'outside 30 days');
});

test('no short URL and no weekly in range: a clear failure naming the clock', async () => {
  await withFake(withoutAbbeyShortUrl(), async (client) => {
    await expectResolveError(
      resolveEvent(
        client,
        { tournament: 'abbey', eventName: FIXTURE_EVENT_NAME, streamName: FIXTURE_STREAM_NAME, weeklyNamePrefix: WEEKLY },
        ABBEY_160_START + 60 * DAY,
      ),
      'no tournament with short URL "abbey", and no "Melee @ Abbey Tavern #<number>"',
      "the relay's clock",
    );
  });
});

test('without a weekly prefix, a short URL that is on no tournament fails exactly', async () => {
  await withFake(withoutAbbeyShortUrl(), async (client) => {
    await expectResolveError(
      resolveEvent(client, { tournament: 'abbey', eventName: FIXTURE_EVENT_NAME, streamName: FIXTURE_STREAM_NAME, weeklyNamePrefix: '' }, ABBEY_160_START),
      'no tournament with short URL "abbey" among',
    );
  });
});

test('weekly names: the prefix then digits only, case-insensitive', () => {
  assert.equal(isWeeklyName('Melee @ Abbey Tavern #160', WEEKLY), true);
  assert.equal(isWeeklyName('melee @ abbey tavern #7', WEEKLY), true);
  assert.equal(isWeeklyName('Melee @ Abbey Tavern #160 (rescheduled)', WEEKLY), false);
  assert.equal(isWeeklyName('Melee @ Abbey Tavern #', WEEKLY), false);
  assert.equal(isWeeklyName('Melee @ Abbey Tavern #160', ''), false, 'empty prefix never matches');
});
