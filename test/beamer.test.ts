// Duplicate station numbers (beamer.ts): two beamers on one number, only the
// newcomer refused, over TCP (ST_DUP_STATION) and for telemetry, and the
// status page's banner and beamer rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeamerSyncFlags, RelayStatus, TelemetryKind } from '../generated/wire.js';
import { BeamerRegistry, DUP_WINDOW_MS, hexId } from '../src/beamer.js';
import { FakeBeamer } from './fake-beamer.js';
import { startHarness } from './harness.js';
import { statusPayload, telemetryDatagram } from './telemetry-helpers.js';

function syncReq(seed: number, station: number | null, flags = 0) {
  const b = new FakeBeamer(seed, station);
  return {
    ...b.syncRequest(),
    flags: (station === null ? 0 : BeamerSyncFlags.SF_STATION_SET) | flags,
  };
}

test('registry: one number, two addresses within the window: the newcomer is refused; the holder keeps it', () => {
  const r = new BeamerRegistry();
  const t0 = 1_000_000;
  assert.equal(r.admit(3, '10.0.0.5', t0), true);
  assert.equal(r.admit(3, '10.0.0.5', t0 + 1000), true, 'the holder again');
  assert.equal(r.admit(3, '10.0.0.9', t0 + 2000), false, 'the newcomer');
  assert.equal(r.admit(3, '10.0.0.5', t0 + 3000), true, 'the holder keeps playing');
  const [d] = r.duplicates(t0 + 3000);
  assert.equal(d!.station, 3);
  assert.equal(d!.holder.address, '10.0.0.5');
  assert.equal(d!.newcomer.address, '10.0.0.9');
  assert.equal(d!.refused, 1);
  // The holder falls silent (unplugged): after the window the other beamer takes the number.
  assert.equal(r.admit(3, '10.0.0.9', t0 + 3000 + DUP_WINDOW_MS + 1), true);
  assert.equal(
    r.admit(3, '10.0.0.5', t0 + 3000 + DUP_WINDOW_MS + 2),
    false,
    'now the old one is refused',
  );
  assert.equal(
    r.admit(4, '10.0.0.5', t0 + 3000 + DUP_WINDOW_MS + 3),
    true,
    'other numbers are free',
  );
  const [h] = r.handedOver(t0 + 3000 + DUP_WINDOW_MS + 3);
  assert.deepEqual(
    [h!.station, h!.before.address, h!.after.address],
    [3, '10.0.0.5', '10.0.0.9'],
    'the status page notes that station 3 changed beamer',
  );
});

test('registry: a beamer that changed address (its syncs name the same station_id) is not a duplicate', () => {
  const r = new BeamerRegistry();
  const req = syncReq(7, 3);
  r.synced(req, '10.0.0.5', 1000);
  assert.equal(r.admit(3, '10.0.0.5', 2000), true);
  r.synced(req, '10.0.0.6', 3000); // DHCP gave it a new address
  assert.equal(r.admit(3, '10.0.0.6', 3500), true);
  assert.equal(r.duplicates(3500).length, 0);
  assert.equal(r.list().length, 1);
  assert.equal(r.list()[0]!.address, '10.0.0.6');
  assert.equal(r.stationIdAt('10.0.0.6'), hexId(req.station_id));
});

test('registry: a sync is never refused, but names the duplicate; renumbering and erase reports are kept', () => {
  const r = new BeamerRegistry();
  r.synced(syncReq(1, 3), '10.0.0.5', 1000);
  r.synced(syncReq(2, 3), '10.0.0.6', 2000); // a stray click made this one 3 too
  assert.equal(r.list().length, 2);
  const [d] = r.duplicates(2000);
  assert.equal(d!.holder.stationId, hexId(syncReq(1, 3).station_id));
  assert.equal(d!.newcomer.stationId, hexId(syncReq(2, 3).station_id));
  // Renumbered with its button: the row notes the change.
  r.synced(syncReq(2, 4), '10.0.0.6', 3000);
  const row = r.list().find((b) => b.address === '10.0.0.6')!;
  assert.equal(row.station, 4);
  assert.equal(row.previousStation, 3);
  // An unset beamer has no number, never "1".
  r.synced(syncReq(9, null), '10.0.0.7', 4000);
  assert.equal(r.list().at(-1)!.station, null);
  // The cold boot's erase report is the first sync's, kept for the boot.
  const cold = { ...syncReq(5, 6, BeamerSyncFlags.SF_COLD_BOOT), erased: 12, erase_ms: 3100 };
  r.synced(cold, '10.0.0.8', 5000);
  r.synced({ ...syncReq(5, 6), uptime_s: 90 }, '10.0.0.8', 35_000);
  const b6 = r.list().find((b) => b.station === 6)!;
  assert.equal(b6.erase?.erased, 12);
  assert.equal(b6.erase?.eraseMs, 3100);
});

test('over TCP: a second beamer on station 3 gets ST_DUP_STATION; the first keeps playing; telemetry from it is dropped', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const first = new FakeBeamer(1, 3, '127.0.0.1');
  const second = new FakeBeamer(2, 3, '127.0.0.2');
  await first.listen();
  await second.listen();
  t.after(() => Promise.all([first.close(), second.close()]));
  assert.equal((await first.sync(h.tcpPort)).verified, true);
  const wiiA = h.wii(3, 0, '127.0.0.1');
  const wiiB = h.wii(3, 0, '127.0.0.2');
  assert.equal((await wiiA.listSets()).resp.status, RelayStatus.ST_OK);
  assert.equal((await second.sync(h.tcpPort)).verified, true, 'its sync still goes through');
  const refused = await wiiB.listSets();
  assert.equal(refused.resp.status, RelayStatus.ST_DUP_STATION);
  assert.equal(refused.resp.msg, 'two beamers are station 3');
  assert.equal(
    (await wiiA.startSet(107949994)).resp.status,
    RelayStatus.ST_OK,
    'the holder plays on',
  );
  assert.equal(h.ev.state.get(3)?.setId, 107949994);
  const dupAudit = h
    .auditEvents()
    .find((e) => e.type === 'refused' && e.reason === 'duplicate station');
  assert.equal(dupAudit?.from, '127.0.0.2');

  // Telemetry from the newcomer is dropped and counted; the holder's arrives.
  h.ev.telemetry.receive(
    telemetryDatagram(TelemetryKind.TM_STATUS, 3, 0, statusPayload({})),
    '127.0.0.2',
  );
  assert.equal(h.ev.telemetry.stations().length, 0);
  assert.equal(h.ev.telemetry.duplicateDropped(), 1);
  h.ev.telemetry.receive(
    telemetryDatagram(TelemetryKind.TM_STATUS, 3, 0, statusPayload({})),
    '127.0.0.1',
  );
  assert.equal(h.ev.telemetry.stations().length, 1);

  const html = await (await fetch(h.statusUrl)).text();
  assert.match(
    html,
    /Two beamers are station 3: 127\.0\.0\.1 \([0-9a-f]{8}\) keeps playing; 127\.0\.0\.2 \([0-9a-f]{8}\) is refused/,
  );
  assert.match(html, /Renumber one with its button/);

  // Renumbered: the second beamer is station 4 now, and its Wii plays.
  second.station = 4;
  await second.sync(h.tcpPort);
  assert.equal((await h.wii(4, 0, '127.0.0.2').listSets()).resp.status, RelayStatus.ST_OK);

  // Station 3's beamer replaced: a third one takes the number once the first has been silent.
  assert.equal(h.ev.beamers.admit(3, '127.0.0.3', Date.now() + DUP_WINDOW_MS + 1000), true);
  assert.match(
    await (await fetch(h.statusUrl)).text(),
    /Station 3 changed beamer .* ago: now a beamer \(127\.0\.0\.3\), before [0-9a-f]{8} \(127\.0\.0\.1\)/,
  );
});
