import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusServer } from '../src/status.js';
import { SetCache } from '../src/cache.js';
import { StationState } from '../src/state.js';
import { StartggClient } from '../src/startgg.js';
import { RelayTcpServer, type AuditSink } from '../src/tcp.js';
import { makeFake, FIXTURE_TOKEN, FIXTURE_EVENT_ID } from './fake-startgg.js';
import { WiiClient, game } from './wii-client.js';

const nullAudit: AuditSink = { record() {} };

test('status page', async (t) => {
  const fake = makeFake();
  await fake.start();
  const startgg = new StartggClient({ endpoint: fake.url, token: FIXTURE_TOKEN, retryDelaysMs: [0, 0] });
  const cache = new SetCache(startgg, FIXTURE_EVENT_ID);
  await cache.refresh();
  const state = new StationState();
  const tcp = new RelayTcpServer({ cache, state, startgg, audit: nullAudit, streamStation: 1, streamId: 1358079 });
  await tcp.listen(0, '127.0.0.1');
  const status = new StatusServer({ state, cache, startgg, streamStation: 1 });
  await status.listen(0, '127.0.0.1');
  const statusUrl = `http://127.0.0.1:${status.address().port}`;
  t.after(async () => {
    await status.close();
    await tcp.close();
    await fake.close();
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

  await t.test('renders stations, sets, scores, flags, and cache info', async () => {
    const html = await (await fetch(statusUrl)).text();
    assert.match(html, /1 ★/, 'stream station is starred');
    assert.match(html, /WQF {2}Alpha vs Bravo \(Bo5\)/);
    assert.match(html, /2–1/);
    assert.match(html, /REPORT_SCORE \d+s/);
    assert.match(html, /✗ reportBracketSet failed/, 'failed upstream call is flagged');
    assert.match(html, /preview-id set\(s\) dropped/, 'R8 warning is shown');
    assert.match(html, /Cache: 4 sets, refreshed \d+s ago/);
    assert.match(html, /Upstream: \d+ calls last 60s/);
  });

  await t.test('ack clears the flagged row', async () => {
    const id = state.flags()[0]!.id;
    const res = await fetch(`${statusUrl}/ack?id=${id}`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(state.flags().length, 0);
    const html = await (await fetch(statusUrl)).text();
    assert.ok(!html.includes('reportBracketSet failed'));
  });

  await t.test('acking an unknown flag is a 404', async () => {
    const res = await fetch(`${statusUrl}/ack?id=999`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 404);
  });

  await t.test('unknown paths are 404', async () => {
    assert.equal((await fetch(`${statusUrl}/nope`)).status, 404);
  });
});
