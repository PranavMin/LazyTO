// setup.ts end to end over HTTP: the first-run wizard (setup code, token,
// tournament, event and the rest), then the settings page behind the admin
// password -- against the fake start.gg, as a TO's browser would post it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.js';
import { configPath, loadConfig } from '../src/config.js';
import { makeFake, FIXTURE_TOKEN } from './fake-startgg.js';

const PASSWORD = 'my-to-password';

function basic(password: string): string {
  return `Basic ${Buffer.from(`to:${password}`).toString('base64')}`;
}

async function setup(t: { after(fn: () => Promise<void> | void): void }) {
  const fake = makeFake();
  await fake.start();
  const dir = mkdtempSync(join(tmpdir(), 'lazyto-setup-'));
  const app = new App({
    dataDir: dir,
    httpPort: 0,
    tcpPort: 0,
    host: '127.0.0.1',
    network: false,
    startggEndpoint: fake.url,
    startggOptions: { retryDelaysMs: [0, 0] },
    clockSynced: () => true,
    retryDelaysMs: [60_000],
  });
  await app.start();
  t.after(async () => {
    await app.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.web.address().port}`;
  const code = readFileSync(join(dir, 'setup-code'), 'utf8').trim();
  const post = async (fields: Record<string, string>, headers: Record<string, string> = {}) => {
    const r = await fetch(`${url}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
  return { app, fake, dir, url, code, post };
}

const SAVE = {
  step: 'save',
  tournament: 'tournament/lazyto-test',
  slug: 'tournament/lazyto-test',
  weekly: '',
  event: 'Melee Singles! (7:30 Start)',
  stream: 'LazyTOStream',
  station: '2',
  setFormat: 'top8q',
  channel: 'main',
  password: PASSWORD,
  password2: PASSWORD,
};

test('first run: code, token, tournament by link, event; then the relay runs', async (t) => {
  const env = await setup(t);

  const step1 = await (await fetch(`${env.url}/setup`)).text();
  assert.match(step1, /Setup code/);
  assert.match(step1, /start\.gg token/);

  // A wrong code is refused and nothing reaches start.gg.
  const wrong = await env.post({ step: 'token', code: '00000000', token: FIXTURE_TOKEN });
  assert.equal(wrong.status, 403);
  assert.equal(env.fake.calls.length, 0);

  // Step 2: the admin tournaments. The unpublished test tournament is never listed.
  const step2 = await env.post({ step: 'token', code: env.code, token: FIXTURE_TOKEN });
  assert.equal(step2.status, 200);
  assert.match(step2.html, /Follow <b>start\.gg\/lazyto-weekly<\/b> every week/);
  assert.match(step2.html, /Only <b>LazyTO Weekly #160<\/b>/);
  assert.doesNotMatch(step2.html, /LazyTO Test Tournament/);

  // Step 3 from a pasted link: its Melee singles events and streams, plus "No stream".
  const step3 = await env.post({
    step: 'tournament',
    code: env.code,
    token: FIXTURE_TOKEN,
    link: 'https://www.start.gg/tournament/lazyto-test/details',
  });
  assert.equal(step3.status, 200);
  for (const name of [
    'Melee Singles! (7:30 Start)',
    'Melee Ladder (9:30pm)',
    'LazyTOStream',
    'No stream',
  ]) {
    assert.ok(step3.html.includes(name), `step 3 lists ${name}`);
  }

  const mismatch = await env.post({
    ...SAVE,
    code: env.code,
    token: FIXTURE_TOKEN,
    password2: 'other-one',
  });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.html, /two passwords differ/);

  const saved = await env.post({ ...SAVE, code: env.code, token: FIXTURE_TOKEN });
  assert.equal(saved.status, 303);
  assert.match(saved.location ?? '', /done=LazyTO\+is\+set\+up/);

  assert.equal(env.app.current().kind, 'running');
  const loaded = loadConfig(configPath(env.dir));
  assert.equal(loaded.kind, 'ok');
  if (loaded.kind !== 'ok') return;
  assert.equal(loaded.config.token, FIXTURE_TOKEN);
  assert.equal(loaded.config.eventName, 'Melee Singles! (7:30 Start)');
  assert.equal(loaded.config.streamStation, 2);
  assert.equal(loaded.config.setFormat, 'top8q');
  assert.match(loaded.config.secret, /^[A-Za-z0-9_-]{16}$/, 'a Wii secret was generated');
  assert.equal(readFileSync(join(env.dir, 'update-channel'), 'utf8').trim(), 'main');
  assert.ok(!existsSync(join(env.dir, 'setup-code')), 'the setup code is spent');

  const status = await (await fetch(env.url)).text();
  assert.match(status, /LazyTO Test Tournament · Melee Singles! \(7:30 Start\) \(1613010\)/);
  assert.match(status, /stream station 2 ★/);
});

test('after setup: settings need the password, keep what is left blank, and never show the token', async (t) => {
  const env = await setup(t);
  await env.post({ ...SAVE, code: env.code, token: FIXTURE_TOKEN });
  const before = loadConfig(configPath(env.dir));
  assert.equal(before.kind, 'ok');
  if (before.kind !== 'ok') return;

  assert.equal((await fetch(`${env.url}/setup`)).status, 401);
  // The old setup code no longer opens anything.
  assert.equal((await env.post({ ...SAVE, code: env.code, token: FIXTURE_TOKEN })).status, 401);

  const auth = { authorization: basic(PASSWORD) };
  const settings = await fetch(`${env.url}/setup`, { headers: auth });
  assert.equal(settings.status, 200);
  const html = await settings.text();
  assert.match(html, /LazyTO Test Tournament/);
  assert.ok(!html.includes(FIXTURE_TOKEN), 'the saved token is never written into a page');
  assert.ok(html.includes(before.config.secret), 'the Wii secret is shown, for the SD cards');
  assert.match(html, /checked required><span>Melee Singles! \(7:30 Start\)/);

  // No new token, no new password, no stream now.
  const r = await env.post(
    { ...SAVE, stream: '', password: '', password2: '', channel: 'release' },
    auth,
  );
  assert.equal(r.status, 303);
  const after = loadConfig(configPath(env.dir));
  assert.equal(after.kind, 'ok');
  if (after.kind !== 'ok') return;
  assert.equal(after.config.token, FIXTURE_TOKEN, 'blank token keeps the saved one');
  assert.equal(after.config.adminPassword, PASSWORD, 'blank password keeps the saved one');
  assert.equal(after.config.secret, before.config.secret, 'the Wii secret never changes on a save');
  assert.equal(after.config.streamName, '');
  assert.match(await (await fetch(env.url)).text(), /no stream · refreshes/);

  // A new Wii secret only when asked for.
  const blank = { ...SAVE, stream: '', password: '', password2: '', channel: 'release' };
  assert.equal((await env.post({ ...blank, newSecret: 'on' }, auth)).status, 303);
  const rotated = loadConfig(configPath(env.dir));
  assert.equal(rotated.kind, 'ok');
  if (rotated.kind !== 'ok') return;
  assert.notEqual(rotated.config.secret, before.config.secret, 'a new Wii secret on request');
});

test('a token start.gg refuses goes back to step 1 with the reason', async (t) => {
  const env = await setup(t);
  const r = await env.post({ step: 'token', code: env.code, token: 'not-a-real-token' });
  assert.equal(r.status, 200);
  assert.match(r.html, /start\.gg refused the token/);
  assert.equal(env.app.current().kind, 'setup');
});

test('following a short URL saves it with the weekly fallback from the tournament name', async (t) => {
  const env = await setup(t);
  const step3 = await env.post({
    step: 'tournament',
    code: env.code,
    token: FIXTURE_TOKEN,
    choice: 'follow|lazyto-weekly|tournament/lazyto-weekly-160',
  });
  assert.match(step3.html, /Following <b>start\.gg\/lazyto-weekly<\/b> each week/);
  assert.match(step3.html, /nearest "LazyTO Weekly #&lt;number&gt;"/);

  await env.post({
    ...SAVE,
    code: env.code,
    token: FIXTURE_TOKEN,
    tournament: 'lazyto-weekly',
    slug: 'tournament/lazyto-weekly-160',
    weekly: 'LazyTO Weekly #',
  });
  const loaded = loadConfig(configPath(env.dir));
  assert.equal(loaded.kind, 'ok');
  if (loaded.kind !== 'ok') return;
  assert.equal(loaded.config.tournament, 'lazyto-weekly');
  assert.equal(loaded.config.weeklyNamePrefix, 'LazyTO Weekly #');
});

test('a save the relay could not run with is refused on the page', async (t) => {
  const env = await setup(t);
  const r = await env.post({ ...SAVE, code: env.code, token: FIXTURE_TOKEN, event: 'Doubles' });
  assert.equal(r.status, 400);
  assert.match(
    r.html,
    /no Melee singles events in tournament\/lazyto-test have &quot;Doubles&quot;/,
  );
  assert.equal(loadConfig(configPath(env.dir)).kind, 'missing', 'nothing was saved');
});
