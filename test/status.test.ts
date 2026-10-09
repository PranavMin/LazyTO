import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { rmSync } from 'node:fs';
import { NO_CONTACT_MS, STALE_CACHE_MS, beaconProblem, renderStatus } from '../src/status.js';
import { WiiClient, game } from './wii-client.js';
import { telemetryDatagram, statusPayload, crashPayload } from './telemetry-helpers.js';
import { ModuleState, TelemetryKind } from '../generated/wire.js';
import { startHarness, TEST_PASSWORD } from './harness.js';
import { entrant } from './fake-startgg.js';

function basic(password: string): string {
  return `Basic ${Buffer.from(`to:${password}`).toString('base64')}`;
}

test('status page', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const { fake, statusUrl } = h;
  const { cache, state } = h.ev;
  const tcp = h.ev.tcp;
  const telemetry = h.ev.telemetry;
  const view = h.view;

  await t.test('Wii consoles: module status, log tail, full log page', async () => {
    let html = await (await fetch(statusUrl)).text();
    assert.match(html, /no Wii has reported yet/);
    telemetry.receive(
      telemetryDatagram(
        TelemetryKind.TM_LOG,
        4,
        0,
        'Patch:Game ID = 47414c45\nTMOD:arena top 00000000 below module end 817f38a4\n',
      ),
      '127.0.0.1',
    );
    telemetry.receive(
      telemetryDatagram(
        TelemetryKind.TM_STATUS,
        4,
        1,
        statusPayload({ module_state: ModuleState.MOD_ARENA, arena_hi: 0 }),
      ),
      '127.0.0.1',
    );
    html = await (await fetch(statusUrl)).text();
    assert.match(html, /<h2>Wii consoles<\/h2>/);
    assert.match(html, /✗ NOT LOADED: module overlaps game memory \(arena top 0x0\)/);
    assert.match(
      html,
      /TMOD:arena top 00000000 below module end 817f38a4/,
      'log tail on the main page',
    );
    assert.match(html, /127\.0\.0\.1/);
    const log = await fetch(`${statusUrl}/log?station=4`);
    assert.equal(log.status, 200);
    assert.match(
      await log.text(),
      /^station 4 \(127\.0\.0\.1\)[\s\S]*Patch:Game ID = 47414c45\nTMOD:arena top/,
    );
    assert.equal((await fetch(`${statusUrl}/log?station=9`)).status, 404);
    telemetry.receive(
      telemetryDatagram(
        TelemetryKind.TM_STATUS,
        4,
        2,
        statusPayload({
          module_state: ModuleState.MOD_LOADED,
          module_len: 80288,
          module_patches: 28,
          module_load: 0x817e0000,
        }),
      ),
      '127.0.0.1',
    );
    html = await (await fetch(statusUrl)).text();
    assert.match(html, /loaded \(80288 bytes, 28 patches\)/);
    assert.doesNotMatch(html, /NOT LOADED/);
    telemetry.receive(
      telemetryDatagram(
        TelemetryKind.TM_CRASH,
        4,
        3,
        crashPayload({ srr0: 0x817e88d8, srr1: 0x00083032, lr: 0x801bf94c }),
      ),
      '127.0.0.1',
    );
    html = await (await fetch(statusUrl)).text();
    assert.match(
      html,
      /✗ crashed .*program \(illegal instruction\) at 0x817E88D8 = module\+0x88D8/,
    );
    assert.match(html, /words at the fault: 00000000 00000000 00000000 00000000/);
  });

  await t.test('before any Wii connects: event id, empty table, cache line', async () => {
    const html = await (await fetch(statusUrl)).text();
    assert.match(
      html,
      /<b>LazyTO Test Tournament · Melee Singles! \(7:30 Start\) \(1613010\)<\/b>/,
      'tournament, event and id are shown',
    );
    assert.match(html, /no station has connected yet/);
    assert.match(html, /Cache: 4 sets \(4 selectable, 0 on stations\), refreshed \d+s ago/);
    assert.match(html, /<meta name="viewport"/, 'phone-readable');
    assert.match(
      html,
      /<meta http-equiv="refresh" content="5;url=\/">/,
      'the only client-side behaviour is the meta refresh',
    );
    assert.doesNotMatch(html, /<script/, 'no client JS');
    assert.match(html, /--card:/, 'the page carries the shared card stylesheet (PAGE_CSS)');
  });

  // Drive real traffic: the stream station plays a set to 2-1, another
  // station hits an upstream failure that flags its row.
  const wii1 = new WiiClient(tcp.address().port, 1, 1);
  await wii1.startSet(107949994, 1);
  await wii1.reportScore(107949994, [game(1), game(2), game(1)]);

  const wii4 = new WiiClient(tcp.address().port, 4);
  await wii4.startSet(107949995);
  fake.failNext('reportBracketSet', '5xx', 3);
  await wii4.reportScore(107949995, [game(1)]);

  // The preview pool gets a ready set that start.gg refuses to start (R8).
  fake.getSet('preview_3292311_1_1').slots = [entrant(9), entrant(10)];
  fake.failNext('markSetInProgress', 'gqlError', 1, 'not an admin');
  await cache.refresh();

  await t.test('renders stations, sets, scores, actions, flags, and cache info', async () => {
    const html = await (await fetch(statusUrl)).text();
    assert.match(html, /1 ★/, 'stream station is starred');
    assert.match(html, /WQF {2}Alpha vs Bravo \(Bo5\)/);
    assert.match(html, /2–1/);
    assert.match(html, /REPORT_SCORE \d+s ago/);
    assert.match(
      html,
      /✗ reportBracketSet failed: start\.gg HTTP 503 after 3 attempts \(\d+s ago\)/,
      'failed upstream call, message, and age',
    );
    assert.match(
      html,
      /pool 3292311 has a ready set but could not be started/,
      'R8 warning is shown',
    );
    assert.match(html, /Cache: 4 sets \(2 selectable, 2 on stations\), refreshed \d+s ago/);
    assert.match(html, /Upstream: \d+ calls last 60s/);
    assert.doesNotMatch(html, /cache is stale/);
  });

  await t.test('a failed last action shows the status and message the player saw', async () => {
    const html = await (await fetch(statusUrl)).text();
    assert.match(html, /✗ REPORT_SCORE \d+s ago — ST_STARTGG_ERROR: start\.gg error - retry/);
    // Station 1's last action succeeded: no marker.
    assert.match(
      html,
      /<span class="st">1 ★<\/span>.*<div class="line">REPORT_SCORE \d+s ago<\/div>/,
    );
  });

  await t.test('a rejected (4xx) call shows the start.gg message verbatim', async () => {
    fake.failNext('reportBracketSet', 'gqlError', 1, 'Set has already been completed');
    await wii1.reportScore(107949994, [game(1), game(2), game(1), game(1)]);
    const html = await (await fetch(statusUrl)).text();
    assert.match(
      html,
      /✗ reportBracketSet failed: start\.gg rejected: Set has already been completed/,
    );
    assert.match(html, /✗ REPORT_SCORE \d+s ago — ST_STARTGG_ERROR: start\.gg rejected - ask TO/);
    // HTML in an upstream message is escaped, never rendered.
    fake.failNext('reportBracketSet', 'gqlError', 1, '<b>bold</b>');
    await wii1.reportScore(107949994, [game(1), game(2), game(1), game(1)]);
    const html2 = await (await fetch(statusUrl)).text();
    assert.match(html2, /&lt;b&gt;bold&lt;\/b&gt;/);
    assert.doesNotMatch(html2, /<b>bold<\/b>/);
  });

  await t.test('ack clears a flagged row', async () => {
    const before = state.flags().length;
    assert.ok(before >= 3);
    const id = state.flags()[0]!.id;
    const anon = await fetch(`${statusUrl}/ack?id=${id}`, { method: 'POST', redirect: 'manual' });
    assert.equal(anon.status, 401, 'ack needs the TO password like the other actions');
    assert.equal(state.flags().length, before);
    const res = await fetch(`${statusUrl}/ack?id=${id}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: basic(TEST_PASSWORD) },
    });
    assert.equal(res.status, 303);
    assert.equal(state.flags().length, before - 1);
    assert.ok(!(await (await fetch(statusUrl)).text()).includes('HTTP 503 after 3 attempts'));
  });

  await t.test('acking an unknown flag is a 404', async () => {
    const res = await fetch(`${statusUrl}/ack?id=999`, {
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: basic(TEST_PASSWORD) },
    });
    assert.equal(res.status, 404);
  });

  await t.test('unknown paths are 404', async () => {
    assert.equal((await fetch(`${statusUrl}/nope`)).status, 404);
  });

  await t.test('a failed refresh is shown with its message; old data is kept', async () => {
    fake.failNext('eventSets', 'gqlError', 1, 'Invalid authentication token');
    await assert.rejects(cache.refresh());
    const html = await (await fetch(statusUrl)).text();
    assert.match(html, /✗ last refresh failed: start\.gg rejected: Invalid authentication token/);
    assert.match(html, /Cache: 4 sets/);
    await cache.refresh();
    assert.doesNotMatch(await (await fetch(statusUrl)).text(), /last refresh failed/);
  });

  await t.test('a cache older than STALE_CACHE_MS is flagged', async (tt) => {
    tt.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    tt.mock.timers.tick(STALE_CACHE_MS + 5_000);
    const html = renderStatus(view);
    assert.match(html, /⚠ cache is stale \(last refresh \d+s ago/);
    tt.mock.timers.reset();
    assert.doesNotMatch(renderStatus(view), /cache is stale/);
  });
});

/** A raw client socket, connected, with a promise for when the relay drops it. */
async function openSocket(port: number): Promise<{ socket: Socket; dropped: Promise<void> }> {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => {});
  const dropped = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  await new Promise((resolve) => socket.once('connect', resolve));
  return { socket, dropped };
}

// Before close() dropped them, these connections held it open forever and
// systemd had to kill the relay on every restart (timeout here instead).
test(
  'close() drops open browser connections instead of waiting for them',
  { timeout: 5000 },
  async () => {
    const h = await startHarness();
    const web = h.app.web;
    const port = web.address().port;

    // A phone between meta refreshes: one keep-alive socket that has fetched the
    // page, one its browser opened ahead for the next refresh, and one cut off
    // part way through its request headers.
    const keptAlive = await openSocket(port);
    let page = '';
    keptAlive.socket.on('data', (chunk: Buffer) => (page += chunk.toString('utf8')));
    keptAlive.socket.write('GET / HTTP/1.1\r\nHost: relay\r\nConnection: keep-alive\r\n\r\n');
    while (!page.includes('</html>')) await new Promise((resolve) => setTimeout(resolve, 10));
    const preconnected = await openSocket(port);
    const halfSent = await openSocket(port);
    halfSent.socket.write('GET / HTTP/1.1\r\nHost: relay\r\n');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const start = Date.now();
    await web.close();
    assert.ok(Date.now() - start < 1000, `close() took ${Date.now() - start} ms`);
    await Promise.all([keptAlive.dropped, preconnected.dropped, halfSent.dropped]);
    // The status server is closed above; shut the rest down without closing it twice.
    await h.ev.stop();
    await h.fake.close();
    rmSync(h.dataDir, { recursive: true, force: true });
  },
);

test('network warnings: no beamer has answered the beacon; macOS Local Network', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const beacon = (firstSentAt: number | null, lastErrorCode: string | null = null) => ({
    status: () => ({
      targets: ['192.168.1.255'],
      sent: 60,
      firstSentAt,
      lastSentAt: Date.now(),
      lastError: lastErrorCode ? 'send EHOSTUNREACH 192.168.1.255:29471' : null,
      lastErrorCode,
    }),
  });
  const now = Date.now();
  assert.doesNotMatch(
    renderStatus({ ...h.view, beacon: beacon(now - 60_000) }),
    /No beamer has reached this relay/,
    'a minute is not long enough to say',
  );
  assert.match(
    renderStatus({ ...h.view, beacon: beacon(now - NO_CONTACT_MS - 60_000) }),
    /No beamer has reached this relay: its beacon has gone out for 3 min/,
  );
  assert.match(
    beaconProblem(beacon(now, 'EHOSTUNREACH').status(), 'darwin'),
    /macOS is blocking LazyTO from your network: System Settings > Privacy & Security > Local Network/,
  );
  assert.match(beaconProblem(beacon(now, 'EHOSTUNREACH').status(), 'win32'), /^discovery beacon:/);
  // Anything at all from a beamer, even a refused request, clears it.
  await h.wii(2).listSets();
  assert.doesNotMatch(
    renderStatus({ ...h.view, beacon: beacon(now - NO_CONTACT_MS - 60_000) }),
    /No beamer has reached this relay/,
  );
});

test('Replays: a finished set with a game that has no replay is listed as skipped for Lucky Stats', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const wii = h.wii(6);
  await wii.startSet(107949995);
  const g = (w: 1 | 2, id: number) => game(w, 9, 2, 0x1f, [0xff, 0xff], [0, 0], { replay_id: id });
  await wii.endSet(107949995, [g(1, 0), g(1, 1791403502), g(1, 1791403802)]);
  const html = await (await fetch(h.statusUrl)).text();
  assert.match(
    html,
    /✗ WQF Charlie vs Delta \(station 6, ended \d+s ago\): no zip for Lucky Stats yet — game 1 not recorded; game 2 its beamer has not synced; game 3 its beamer has not synced/,
  );
});
