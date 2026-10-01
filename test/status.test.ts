import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusServer, STALE_CACHE_MS } from '../src/status.js';
import { SetCache } from '../src/cache.js';
import { StationState } from '../src/state.js';
import { StartggClient } from '../src/startgg.js';
import { RelayTcpServer, type AuditSink } from '../src/tcp.js';
import { makeFake, FIXTURE_TOKEN, FIXTURE_EVENT_ID } from './fake-startgg.js';
import { WiiClient, game, TEST_SECRET } from './wii-client.js';
import { StationTelemetry } from '../src/telemetry.js';
import { telemetryDatagram, statusPayload, crashPayload } from './telemetry.test.js';
import { ModuleState, TelemetryKind } from '../generated/wire.js';
import { RecordingArchive } from './archive-stub.js';

const nullAudit: AuditSink = { record() {} };

test('status page', async (t) => {
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
  const tcp = new RelayTcpServer({
    cache,
    state,
    startgg,
    audit: nullAudit,
    archive: new RecordingArchive(),
    streamStation: 1,
    streamId: 1358079,
    secret: TEST_SECRET,
  });
  await tcp.listen(0, '127.0.0.1');
  const telemetry = new StationTelemetry({ secret: TEST_SECRET });
  const status = new StatusServer({
    state,
    cache,
    startgg,
    streamStation: 1,
    eventLabel: `LazyTO Test Tournament · Melee Singles! (7:30 Start) (${FIXTURE_EVENT_ID})`,
    beacon: {
      status: () => ({
        targets: ['192.168.1.255'],
        sent: 1,
        lastSentAt: Date.now(),
        lastError: null,
      }),
    },
    tcp,
    telemetry,
    archive: { status: () => ({ inProgress: [], recent: [], watches: [] }) },
    beamers: { status: () => ({ beamers: [], unnamed: 0, bad: 0 }) },
  });
  await status.listen(0, '127.0.0.1');
  const statusUrl = `http://127.0.0.1:${status.address().port}`;
  t.after(async () => {
    await status.close();
    await tcp.close();
    await fake.close();
  });

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
      '192.168.1.80',
    );
    telemetry.receive(
      telemetryDatagram(
        TelemetryKind.TM_STATUS,
        4,
        1,
        statusPayload({ module_state: ModuleState.MOD_ARENA, arena_hi: 0 }),
      ),
      '192.168.1.80',
    );
    html = await (await fetch(statusUrl)).text();
    assert.match(html, /<h2>Wii consoles<\/h2>/);
    assert.match(html, /✗ NOT LOADED: module overlaps game memory \(arena top 0x0\)/);
    assert.match(
      html,
      /TMOD:arena top 00000000 below module end 817f38a4/,
      'log tail on the main page',
    );
    assert.match(html, /192\.168\.1\.80/);
    const log = await fetch(`${statusUrl}/log?station=4`);
    assert.equal(log.status, 200);
    assert.match(
      await log.text(),
      /^station 4 \(192\.168\.1\.80\)[\s\S]*Patch:Game ID = 47414c45\nTMOD:arena top/,
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
      '192.168.1.80',
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
      '192.168.1.80',
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
      /<meta http-equiv="refresh" content="5">/,
      'the only client-side behaviour is the meta refresh',
    );
    assert.doesNotMatch(html, /<script/, 'no client JS');
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
    assert.match(html, /preview-id set\(s\) dropped/, 'R8 warning is shown');
    assert.match(html, /Cache: 4 sets \(2 selectable, 2 on stations\), refreshed \d+s ago/);
    assert.match(html, /Upstream: \d+ calls last 60s/);
    assert.doesNotMatch(html, /cache is stale/);
  });

  await t.test('a failed last action shows the status and message the player saw', async () => {
    const html = await (await fetch(statusUrl)).text();
    assert.match(html, /✗ REPORT_SCORE \d+s ago — ST_STARTGG_ERROR: start\.gg error - retry/);
    // Station 1's last action succeeded: no marker.
    assert.match(html, /<td>1 ★<\/td>.*<td>REPORT_SCORE \d+s ago<\/td>/);
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
    const res = await fetch(`${statusUrl}/ack?id=${id}`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(state.flags().length, before - 1);
    assert.ok(!(await (await fetch(statusUrl)).text()).includes('HTTP 503 after 3 attempts'));
  });

  await t.test('acking an unknown flag is a 404', async () => {
    const res = await fetch(`${statusUrl}/ack?id=999`, { method: 'POST', redirect: 'manual' });
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
    const html = status.render();
    assert.match(html, /⚠ cache is stale \(last refresh \d+s ago/);
    tt.mock.timers.reset();
    assert.doesNotMatch(status.render(), /cache is stale/);
  });
});
