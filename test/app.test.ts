// app.ts: the modes (setup, starting, failed, running), the setup code, retry,
// and applying new settings without losing the stations' sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.js';
import { configPath, saveConfig } from '../src/config.js';
import { RelayStatus } from '../generated/wire.js';
import { makeFake, type FakeStartgg } from './fake-startgg.js';
import { harnessConfig, startHarness } from './harness.js';
import { WiiClient } from './wii-client.js';

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'lazyto-app-'));
}

async function startApp(
  dataDir: string,
  fake: FakeStartgg,
  extra: Partial<ConstructorParameters<typeof App>[0]> = {},
) {
  const app = new App({
    dataDir,
    archiveDir: join(dataDir, 'archive'),
    httpPort: 0,
    tcpPort: 0,
    host: '127.0.0.1',
    network: false,
    startggEndpoint: fake.url,
    startggOptions: { retryDelaysMs: [0, 0] },
    clockSynced: () => true,
    retryDelaysMs: [60_000],
    ...extra,
  });
  await app.start();
  return { app, url: `http://127.0.0.1:${app.web.address().port}` };
}

test('no settings: setup mode, a setup code, and every page leads to /setup', async (t) => {
  const fake = makeFake();
  await fake.start();
  const dir = newDir();
  const { app, url } = await startApp(dir, fake);
  t.after(async () => {
    await app.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(app.current().kind, 'setup');
  const code = readFileSync(join(dir, 'setup-code'), 'utf8').trim();
  assert.match(code, /^\d{8}$/);
  if (process.platform !== 'win32')
    assert.equal(statSync(join(dir, 'setup-code')).mode & 0o777, 0o600);

  const home = await fetch(url, { redirect: 'manual' });
  assert.equal(home.status, 303);
  assert.equal(home.headers.get('location'), '/setup');
  assert.equal((await fetch(`${url}/log?station=1`)).status, 404, 'no status pages before setup');
  assert.equal(fake.calls.length, 0, 'nothing reaches start.gg before setup');
});

test('invalid settings: setup mode, and the setup page says what is wrong', async (t) => {
  const fake = makeFake();
  await fake.start();
  const dir = newDir();
  writeFileSync(configPath(dir), JSON.stringify({ token: 'x' }));
  const { app, url } = await startApp(dir, fake);
  t.after(async () => {
    await app.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(app.current().kind, 'setup');
  const html = await (await fetch(`${url}/setup`)).text();
  assert.match(html, /saved settings can&#39;t be used|saved settings can't be used/);
  assert.match(html, /missing field &quot;tournament&quot;|missing field "tournament"/);
});

test('an event that cannot be found: the page says why, retries, and Retry works', async (t) => {
  const fake = makeFake();
  await fake.start();
  const dir = newDir();
  saveConfig(configPath(dir), harnessConfig());
  // start.gg is down (5xx three times: the client's two retries included) while the relay starts.
  fake.failNext('tournament', '5xx', 3);
  const { app, url } = await startApp(dir, fake);
  t.after(async () => {
    await app.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const m = app.current();
  assert.equal(m.kind, 'failed');
  const html = await (await fetch(url)).text();
  assert.match(html, /Not running/);
  assert.match(html, /HTTP 503/);
  assert.match(html, /trying again in \d+ s/);
  assert.match(html, /action="\/retry"/);

  const retry = await fetch(`${url}/retry`, { method: 'POST', redirect: 'manual' });
  assert.equal(retry.status, 303);
  for (let i = 0; i < 100 && app.current().kind !== 'running'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(app.current().kind, 'running', 'start.gg is back: Retry starts the relay');
});

test('a clock that is not set yet holds the start, with the reason on the page', async (t) => {
  const fake = makeFake();
  await fake.start();
  const dir = newDir();
  saveConfig(configPath(dir), harnessConfig());
  const { app, url } = await startApp(dir, fake, { clockSynced: () => false });
  t.after(async () => {
    await app.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const m = app.current();
  assert.equal(m.kind, 'failed');
  assert.match(await (await fetch(url)).text(), /waiting for the clock/);
  assert.equal(fake.calls.length, 0);
});

test('saving settings applies them in place and the stations keep their sets', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const SET = 107949994;
  assert.equal((await h.wii(3).startSet(SET)).resp.status, RelayStatus.ST_OK);

  await h.app.save({ ...harnessConfig(), setFormat: 'top8q' }, 'off');

  const m = h.app.current();
  assert.equal(m.kind, 'running');
  assert.equal(h.app.config()!.setFormat, 'top8q');
  assert.equal(readFileSync(join(h.dataDir, 'update-channel'), 'utf8').trim(), 'off');
  // A fresh WiiClient: the restarted relay listens on a new ephemeral port in tests.
  if (m.kind !== 'running') return;
  const { sets } = await new WiiClient(m.ev.tcp.address().port, 3).listSets();
  assert.equal(sets[0]!.set_id, SET, "station 3's set came back from the audit log");
  assert.equal(sets[0]!.state, 1);
});

test('stop() closes the web server and the event', async () => {
  const h = await startHarness();
  const url = h.statusUrl;
  await h.close();
  await assert.rejects(fetch(url));
  assert.ok(!existsSync(h.dataDir));
});
