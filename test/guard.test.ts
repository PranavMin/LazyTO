// One LazyTO per network (guard.ts): another relay's beacon keeps tonight's
// event from starting; the relay's own beacons and beamers' beacon requests
// do not; a running relay shows the other one on its status page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAGIC_0, MAGIC_1, encodeRelayBeacon } from '../generated/wire.js';
import { App } from '../src/app.js';
import { configPath, saveConfig } from '../src/config.js';
import { OTHER_RELAY_FRESH_MS, RelayGuard } from '../src/guard.js';
import { makeFake } from './fake-startgg.js';
import { harnessConfig, startHarness } from './harness.js';

function beacon(tcpPort: number, eventId = 1613010, version = 2): Uint8Array {
  return encodeRelayBeacon({
    magic: new Uint8Array([MAGIC_0, MAGIC_1]),
    version,
    tcp_port: tcpPort,
    event_id: eventId,
  });
}

test('guard: another relay is heard; its own beacons and beacon requests are not; it fades after 10 s', () => {
  const g = new RelayGuard({ port: 0, ownAddresses: () => ['192.168.1.67'] });
  const now = 1_000_000;
  g.receive(beacon(29470), '192.168.1.67', now); // our own, looped back
  g.receive(beacon(0, 0), '192.168.1.80', now); // a beamer asking for the beacon
  g.receive(new Uint8Array(13), '192.168.1.81', now);
  assert.equal(g.heard(now), null);
  g.receive(beacon(29470, 99, 1), '192.168.1.50', now); // a v1 Pi relay counts too
  assert.deepEqual(g.heard(now + 1000), {
    address: '192.168.1.50',
    tcpPort: 29470,
    eventId: 99,
    version: 1,
    firstAt: now,
    lastAt: now,
  });
  assert.equal(g.heard(now + OTHER_RELAY_FRESH_MS + 1), null);
});

test('guard: a beacon arriving on the UDP port is heard', async (t) => {
  const g = new RelayGuard({ port: 0, listenMs: 0, ownAddresses: () => [] });
  await g.listen();
  t.after(() => g.stop());
  const s = createSocket('udp4');
  t.after(() => new Promise<void>((resolve) => s.close(() => resolve())));
  await new Promise<void>((resolve, reject) =>
    s.send(beacon(29470), g.port(), '127.0.0.1', (e) => (e ? reject(e) : resolve())),
  );
  for (let i = 0; i < 100 && !g.heard(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.heard()?.address, '127.0.0.1');
  assert.match(
    (await g.check()) ?? '',
    /another LazyTO relay is running on this network, at 127\.0\.0\.1/,
  );
});

test('app: the event does not start while another relay is heard; it does once that one is gone', async (t) => {
  const fake = makeFake();
  await fake.start();
  const dir = mkdtempSync(join(tmpdir(), 'lazyto-guard-'));
  saveConfig(configPath(dir), harnessConfig());
  const guard = new RelayGuard({ port: 0, listenMs: 50, ownAddresses: () => [] });
  // Heard just now, and gone in half a second.
  guard.receive(beacon(29470, 777), '192.168.1.50', Date.now() - OTHER_RELAY_FRESH_MS + 500);
  const app = new App({
    dataDir: dir,
    archiveDir: join(dir, 'archive'),
    httpPort: 0,
    tcpPort: 0,
    host: '127.0.0.1',
    network: false,
    guard,
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
  const m = app.current();
  assert.equal(m.kind, 'failed');
  assert.match(
    m.kind === 'failed' ? m.reason : '',
    /another LazyTO relay is running on this network, at 192\.168\.1\.50 \(event 777\)/,
  );
  const html = await (await fetch(`http://127.0.0.1:${app.web.address().port}/`)).text();
  assert.match(html, /Not running/);
  assert.match(html, /only one may run: close the other one/);

  await new Promise((r) => setTimeout(r, 600));
  app.retryNow();
  for (let i = 0; i < 200 && app.current().kind !== 'running'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(app.current().kind, 'running');
});

test('a running relay that hears another one keeps running and says so', async (t) => {
  const guard = new RelayGuard({ port: 0, listenMs: 0, ownAddresses: () => [] });
  const h = await startHarness({ guard });
  t.after(h.close);
  assert.doesNotMatch(await (await fetch(h.statusUrl)).text(), /Another LazyTO relay/);
  guard.receive(beacon(29470, 777), '192.168.1.50');
  assert.match(
    await (await fetch(h.statusUrl)).text(),
    /Another LazyTO relay is on this network, at 192\.168\.1\.50 \(event 777\)/,
  );
  assert.equal(h.app.current().kind, 'running');
});
