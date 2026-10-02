// The TO's actions on the status page (src/admin.ts through src/status.ts):
// password, same-origin, free a stuck station, per-set best-of, and the
// audit replay that keeps best-of overrides across a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatusServer, passwordMatches } from '../src/status.js';
import { Admin } from '../src/admin.js';
import { SetCache } from '../src/cache.js';
import { StationState } from '../src/state.js';
import { StartggClient } from '../src/startgg.js';
import { RelayTcpServer } from '../src/tcp.js';
import { AuditLog, replayBestOf } from '../src/audit.js';
import { StationTelemetry } from '../src/telemetry.js';
import { RelayStatus } from '../generated/wire.js';
import { makeFake, FIXTURE_TOKEN, FIXTURE_EVENT_ID } from './fake-startgg.js';
import { WiiClient, game, TEST_SECRET } from './wii-client.js';

const PASSWORD = 'to-pass-9876';
const SET = 107949994; // Alpha vs Bravo, WQF, Bo5 in the fixture
const OTHER = 107949995;

function basic(password: string, user = 'to'): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

async function setup(t: { after(fn: () => Promise<void> | void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'tr-admin-'));
  const fake = makeFake();
  await fake.start();
  const startgg = new StartggClient({
    endpoint: fake.url,
    token: FIXTURE_TOKEN,
    retryDelaysMs: [0, 0],
  });
  const cache = new SetCache(startgg, FIXTURE_EVENT_ID, 'startgg');
  await cache.refresh();
  const state = new StationState();
  const audit = new AuditLog(join(dir, `${FIXTURE_EVENT_ID}.jsonl`));
  const tcp = new RelayTcpServer({
    cache,
    state,
    startgg,
    audit,
    streamStation: 1,
    streamId: 1358079,
    secret: TEST_SECRET,
  });
  await tcp.listen(0, '127.0.0.1');
  const status = new StatusServer({
    state,
    cache,
    startgg,
    streamStation: 1,
    eventLabel: 'LazyTO Test Tournament',
    beacon: { status: () => ({ targets: [], sent: 0, lastSentAt: 0, lastError: null }) },
    tcp,
    telemetry: new StationTelemetry({ secret: TEST_SECRET }),
    admin: { actions: new Admin({ state, cache, startgg, audit }), password: PASSWORD },
  });
  await status.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${status.address().port}`;
  t.after(async () => {
    await status.close();
    await tcp.close();
    await fake.close();
    audit.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (
    path: string,
    headers: Record<string, string> = { authorization: basic(PASSWORD) },
  ) => fetch(base + path, { method: 'POST', headers, redirect: 'manual' });
  const get = (
    path: string,
    headers: Record<string, string> = { authorization: basic(PASSWORD) },
  ) => fetch(base + path, { headers, redirect: 'manual' });
  const wii = (station: number) => new WiiClient(tcp.address().port, station);
  return { fake, cache, state, audit, base, post, get, wii };
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

test('without admin the page has no actions and the routes are 404', async (t) => {
  const fake = makeFake();
  await fake.start();
  t.after(() => fake.close());
  const startgg = new StartggClient({
    endpoint: fake.url,
    token: FIXTURE_TOKEN,
    retryDelaysMs: [0, 0],
  });
  const cache = new SetCache(startgg, FIXTURE_EVENT_ID, 'startgg');
  await cache.refresh();
  const status = new StatusServer({
    state: new StationState(),
    cache,
    startgg,
    streamStation: 1,
    eventLabel: 'x',
    beacon: { status: () => ({ targets: [], sent: 0, lastSentAt: 0, lastError: null }) },
    tcp: { refused: () => null },
    telemetry: new StationTelemetry({ secret: TEST_SECRET }),
  });
  await status.listen(0, '127.0.0.1');
  t.after(() => status.close());
  const base = `http://127.0.0.1:${status.address().port}`;
  assert.doesNotMatch(await (await fetch(base)).text(), /Waiting sets/);
  const r = await fetch(`${base}/bestof?set=${SET}&bo=3`, {
    method: 'POST',
    headers: { authorization: basic(PASSWORD) },
  });
  assert.equal(r.status, 404);
});
