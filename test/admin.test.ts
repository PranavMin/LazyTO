// The TO's actions on the status page (src/admin.ts through src/status.ts):
// password, same-origin, free a stuck station, per-set best-of, and the
// audit replay that keeps best-of overrides across a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordMatches } from '../src/status.js';
import { replayBestOf } from '../src/audit.js';
import { RelayStatus } from '../generated/wire.js';
import { game } from './wii-client.js';
import { startHarness, TEST_PASSWORD } from './harness.js';

const PASSWORD = TEST_PASSWORD;
const SET = 107949994; // Alpha vs Bravo, WQF, Bo5 in the fixture
const OTHER = 107949995;

function basic(password: string, user = 'to'): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

async function setup(t: { after(fn: () => Promise<void> | void): void }) {
  const h = await startHarness();
  t.after(h.close);
  const post = (
    path: string,
    headers: Record<string, string> = { authorization: basic(PASSWORD) },
  ) => fetch(h.statusUrl + path, { method: 'POST', headers, redirect: 'manual' });
  const get = (
    path: string,
    headers: Record<string, string> = { authorization: basic(PASSWORD) },
  ) => fetch(h.statusUrl + path, { headers, redirect: 'manual' });
  return {
    fake: h.fake,
    cache: h.ev.cache,
    state: h.ev.state,
    audit: h.ev.audit,
    base: h.statusUrl,
    post,
    get,
    wii: (station: number) => h.wii(station),
  };
}

/** The message a 303 back to the page carries. */
function outcome(r: Response): { done?: string; error?: string } {
  assert.equal(r.status, 303);
  const q = new URL(r.headers.get('location')!, 'http://x').searchParams;
  return { done: q.get('done') ?? undefined, error: q.get('error') ?? undefined };
}

test('passwordMatches: any user name, exact password only', () => {
  assert.ok(passwordMatches(basic(PASSWORD), PASSWORD));
  assert.ok(passwordMatches(basic(PASSWORD, ''), PASSWORD));
  assert.ok(!passwordMatches(basic('to-pass-987'), PASSWORD));
  assert.ok(!passwordMatches(basic(`${PASSWORD}x`), PASSWORD));
  assert.ok(!passwordMatches(undefined, PASSWORD));
  assert.ok(!passwordMatches('Bearer abc', PASSWORD));
});

test('actions need the password and a same-site origin; reading does not', async (t) => {
  const env = await setup(t);
  assert.equal((await fetch(env.base)).status, 200, 'the page itself is open');
  assert.equal((await env.post(`/bestof?set=${SET}&bo=3`, {})).status, 401);
  const wrong = await env.post(`/bestof?set=${SET}&bo=3`, { authorization: basic('nope-nope') });
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get('www-authenticate') ?? '', /^Basic /);
  assert.equal((await env.get('/free?station=3', {})).status, 401);
  const cross = await env.post(`/bestof?set=${SET}&bo=3`, {
    authorization: basic(PASSWORD),
    origin: 'http://evil.example',
  });
  assert.equal(cross.status, 403);
  assert.equal(env.cache.get(SET)!.bestOf, 5, 'nothing changed');
});

test('best-of: Bo3 reaches the Wii list, auto restores the format, both are logged', async (t) => {
  const env = await setup(t);
  const html = await (await fetch(env.base)).text();
  assert.match(html, /Waiting sets/);
  assert.match(html, new RegExp(`/bestof\\?set=${SET}&amp;bo=3`));

  assert.ok(outcome(await env.post(`/bestof?set=${SET}&bo=3`)).done);
  const listed = (await env.wii(3).listSets()).sets.find((s) => s.set_id === SET)!;
  assert.equal(listed.best_of, 3, 'the Wii sees the TO override');
  assert.match(await (await fetch(env.base)).text(), /set by TO/);

  await env.cache.refresh();
  assert.equal(env.cache.get(SET)!.bestOf, 3, 'survives a refresh');

  assert.ok(outcome(await env.post(`/bestof?set=${SET}&bo=auto`)).done);
  assert.equal(env.cache.get(SET)!.bestOf, 5);
  assert.equal(env.cache.get(SET)!.bestOfOverridden, false);

  assert.match(outcome(await env.post(`/bestof?set=${SET}&bo=4`)).error!, /3 or 5/);
  assert.match(outcome(await env.post('/bestof?set=1&bo=3')).error!, /not pending/);

  const log = replayBestOf(env.audit.path);
  assert.equal(log.has(SET), false, 'auto cleared the override in the log too');
});

test('best-of overrides replay from the audit log', async (t) => {
  const env = await setup(t);
  await env.post(`/bestof?set=${SET}&bo=3`);
  await env.post(`/bestof?set=${OTHER}&bo=3`);
  await env.post(`/bestof?set=${OTHER}&bo=auto`);
  assert.deepEqual([...replayBestOf(env.audit.path)], [[SET, 3]]);
});

test('best-of is refused for a set a station is playing', async (t) => {
  const env = await setup(t);
  assert.equal((await env.wii(3).startSet(SET)).resp.status, RelayStatus.ST_OK);
  assert.match(outcome(await env.post(`/bestof?set=${SET}&bo=3`)).error!, /station 3 is playing/);
  const html = await (await fetch(env.base)).text();
  assert.doesNotMatch(
    html,
    new RegExp(`/bestof\\?set=${SET}&`),
    'not offered while it is on a station',
  );
});

test('free station: confirm page names the score, POST resets on start.gg and frees', async (t) => {
  const env = await setup(t);
  const wii = env.wii(3);
  assert.equal((await wii.startSet(SET)).resp.status, RelayStatus.ST_OK);
  assert.equal((await wii.reportScore(SET, [game(1), game(2)])).resp.status, RelayStatus.ST_OK);
  assert.equal(env.fake.getSet(SET).state, 2);

  const page = await (await fetch(env.base)).text();
  assert.match(page, /action="\/free"/, 'a free button on the busy station');

  const confirm = await env.get('/free?station=3');
  assert.equal(confirm.status, 200);
  const text = await confirm.text();
  assert.match(text, /discards its score, 1–1/);
  assert.match(text, new RegExp(`/free\\?station=3&amp;set=${SET}`));

  const r = outcome(await env.post(`/free?station=3&set=${SET}`));
  assert.match(r.done!, /station 3 freed/);
  assert.equal(env.state.get(3), undefined);
  assert.equal(env.fake.callsFor('resetSet').length, 1);
  assert.equal(env.fake.getSet(SET).state, 1, 'pending again on start.gg');
  assert.equal(env.cache.get(SET)!.state, 1, 'and in the cache without waiting for a refresh');

  const other = env.wii(4);
  assert.ok(
    (await other.listSets()).sets.some((s) => s.set_id === SET),
    'any Wii can pick it',
  );
  assert.equal((await other.startSet(SET)).resp.status, RelayStatus.ST_OK);

  // The dead Wii coming back is told its set is gone.
  assert.equal((await wii.reportScore(SET, [game(1)])).resp.status, RelayStatus.ST_SET_NOT_FOUND);
});

test('free station: a stale page cannot free a newer set; a failed reset frees nothing', async (t) => {
  const env = await setup(t);
  assert.equal((await env.wii(3).startSet(SET)).resp.status, RelayStatus.ST_OK);
  assert.match(outcome(await env.post(`/free?station=3&set=${OTHER}`)).error!, /different set/);
  assert.match(outcome(await env.post(`/free?station=5&set=${SET}`)).error!, /has no set/);

  env.fake.failNext('resetSet', 'gqlError', 1, 'set is locked');
  assert.match(
    outcome(await env.post(`/free?station=3&set=${SET}`)).error!,
    /reset failed, station not freed/,
  );
  assert.equal(env.state.get(3)?.setId, SET, 'still claimed');
  assert.equal(env.fake.getSet(SET).state, 2);
});
