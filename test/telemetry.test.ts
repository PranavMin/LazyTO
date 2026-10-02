// telemetry.test.ts -- station telemetry (src/telemetry.ts): datagrams built
// exactly as the Nintendont kernel sends them (relay_auth + telemetry_hdr +
// payload), received over real UDP and through receive().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import {
  MAX_LINES,
  MAX_STATIONS,
  StationTelemetry,
  crashText,
  moduleStateText,
} from '../src/telemetry.js';
import { MAGIC_0, ModuleState, PROTO_VERSION, TelemetryKind } from '../generated/wire.js';
import { TEST_SECRET } from './wii-client.js';
import { crashPayload, statusPayload, telemetryDatagram } from './telemetry-helpers.js';

test('a real UDP datagram from a station is received and decoded', async () => {
  const t = new StationTelemetry({ secret: TEST_SECRET, port: 0, host: '127.0.0.1' });
  await t.start();
  const sock = createSocket('udp4');
  try {
    const msg = telemetryDatagram(
      TelemetryKind.TM_LOG,
      3,
      0,
      'Nintendont IOS58 v24.32\nTMOD:42 bytes\n',
    );
    await new Promise<void>((resolve, reject) =>
      sock.send(msg, t.address().port, '127.0.0.1', (e) => (e ? reject(e) : resolve())),
    );
    for (let i = 0; i < 50 && !t.get(3); i++) await new Promise((r) => setTimeout(r, 10));
    const row = t.get(3);
    assert.ok(row, 'station 3 heard');
    assert.deepEqual(row.lines, ['Nintendont IOS58 v24.32', 'TMOD:42 bytes']);
    assert.equal(row.from, '127.0.0.1');
    assert.equal(row.uptimeMs, 1000);
  } finally {
    sock.close();
    await t.stop();
  }
});

test('a beacon request (relay_beacon with tcp_port 0) is answered with the relay beacon, unicast', async () => {
  const beaconPayload = new Uint8Array([
    MAGIC_0,
    0x54,
    PROTO_VERSION,
    0,
    0x73,
    0x1e,
    0,
    0,
    0,
    0x18,
    0x9c,
    0x92,
  ]); // tcp 29470, event 1613010
  const station = createSocket('udp4');
  await new Promise<void>((resolve) => station.bind(0, '127.0.0.1', () => resolve()));
  const replyPort = (station.address() as AddressInfo).port;
  const t = new StationTelemetry({
    secret: TEST_SECRET,
    port: 0,
    host: '127.0.0.1',
    beaconPayload,
    beaconReplyPort: replyPort,
  });
  await t.start();
  try {
    const got = new Promise<Buffer>((resolve) => station.once('message', (m) => resolve(m)));
    const request = new Uint8Array([MAGIC_0, 0x54, PROTO_VERSION, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // tcp_port 0 = please send it
    await new Promise<void>((resolve, reject) =>
      station.send(request, t.address().port, '127.0.0.1', (e) => (e ? reject(e) : resolve())),
    );
    const reply = await got;
    assert.deepEqual([...reply], [...beaconPayload]);
    assert.equal(t.beaconRequested()?.count, 1);
    assert.equal(t.stations().length, 0, 'a request is not a station report');
  } finally {
    station.close();
    await t.stop();
  }
});

test('a wrong or missing secret is dropped and counted, never shown', () => {
  const t = new StationTelemetry({ secret: TEST_SECRET });
  t.receive(
    telemetryDatagram(TelemetryKind.TM_LOG, 5, 0, 'spoofed\n', 'not-the-secret'),
    '10.0.0.9',
  );
  const noAuth = telemetryDatagram(TelemetryKind.TM_LOG, 5, 1, 'no auth\n');
  noAuth[0] = 0;
  t.receive(noAuth, '10.0.0.9');
  assert.equal(t.stations().length, 0);
  const r = t.refused();
  assert.ok(r);
  assert.equal(r.count, 2);
  assert.equal(r.lastFrom, '10.0.0.9');
  assert.equal(r.lastStation, 5);
});

test('malformed datagrams are ignored: short, wrong magic, wrong version, truncated payload', () => {
  const t = new StationTelemetry({ secret: TEST_SECRET });
  t.receive(new Uint8Array(10), 'x');
  const badMagic = telemetryDatagram(TelemetryKind.TM_LOG, 1, 0, 'a\n');
  badMagic[21] = 0x54; // 'T': a relay_hdr, not telemetry
  t.receive(badMagic, 'x');
  const badVersion = telemetryDatagram(TelemetryKind.TM_LOG, 1, 0, 'a\n');
  badVersion[22] = PROTO_VERSION + 1;
  t.receive(badVersion, 'x');
  const truncated = telemetryDatagram(TelemetryKind.TM_LOG, 1, 0, 'abcdef\n').subarray(0, 40);
  t.receive(truncated, 'x');
  assert.equal(t.stations().length, 0);
  assert.equal(t.refused(), null);
});

test('log lines split across datagrams are joined; CR stripped; non-printables replaced', () => {
  const t = new StationTelemetry({ secret: TEST_SECRET });
  t.receive(telemetryDatagram(TelemetryKind.TM_LOG, 2, 0, 'Patch:Game ID = 474'), 'w');
  t.receive(telemetryDatagram(TelemetryKind.TM_LOG, 2, 1, '14c45\r\nbell\x07here\n'), 'w');
  assert.deepEqual(t.get(2)?.lines, ['Patch:Game ID = 47414c45', 'bell?here']);
});

test('status datagrams set the module state; texts name the reason', () => {
  const t = new StationTelemetry({ secret: TEST_SECRET });
  t.receive(
    telemetryDatagram(
      TelemetryKind.TM_STATUS,
      7,
      0,
      statusPayload({
        module_state: ModuleState.MOD_LOADED,
        module_len: 80288,
        module_patches: 28,
        module_load: 0x817e0000,
      }),
    ),
    'w',
  );
  const s = t.get(7)?.status;
  assert.ok(s);
  assert.equal(moduleStateText(s), 'loaded (80288 bytes, 28 patches)');
  assert.equal(s.module_load, 0x817e0000);
  assert.match(
    moduleStateText({ ...s, module_state: ModuleState.MOD_NOT_FOUND }),
    /no tournament\.bin/,
  );
  assert.match(
    moduleStateText({ ...s, module_state: ModuleState.MOD_GUARD }),
    /not stock Melee 1\.02/,
  );
  assert.match(
    moduleStateText({ ...s, module_state: ModuleState.MOD_ARENA, arena_hi: 0 }),
    /arena top 0x0/,
  );
});

test('a crash report is kept, named, and resolved against the module range', () => {
  const t = new StationTelemetry({ secret: TEST_SECRET });
  t.receive(
    telemetryDatagram(
      TelemetryKind.TM_STATUS,
      1,
      0,
      statusPayload({
        module_state: ModuleState.MOD_LOADED,
        module_len: 80036,
        module_load: 0x817e0000,
        module_patches: 28,
      }),
    ),
    'w',
  );
  const stack = [0x801a40b4, 0x801a44c4, 0x801601ac, 0, 0, 0, 0, 0];
  t.receive(
    telemetryDatagram(
      TelemetryKind.TM_CRASH,
      1,
      1,
      crashPayload({
        srr0: 0x817e88d8,
        srr1: 0x00083032,
        lr: 0x801bf94c,
        sp: 0x804eeb40,
        fetched: [0, 0, 0, 0],
        stack,
      }),
    ),
    'w',
  );
  const row = t.get(1);
  assert.ok(row?.crash);
  assert.equal(
    crashText(row.crash, row.status),
    'program (illegal instruction) at 0x817E88D8 = module+0x88D8, lr 0x801BF94C',
  );
  assert.equal(
    row.lines.at(-1),
    '--- crash: program (illegal instruction) at 0x817E88D8 = module+0x88D8, lr 0x801BF94C ---',
  );
  assert.deepEqual([...row.crash.stack].slice(0, 3), [0x801a40b4, 0x801a44c4, 0x801601ac]);
});

test('seq: gaps count as lost, duplicates ignored, going backwards is a reboot', () => {
  const t = new StationTelemetry({ secret: TEST_SECRET });
  t.receive(telemetryDatagram(TelemetryKind.TM_LOG, 1, 0, 'boot 1\n'), 'w');
  t.receive(telemetryDatagram(TelemetryKind.TM_LOG, 1, 3, 'after gap\n'), 'w');
  t.receive(telemetryDatagram(TelemetryKind.TM_LOG, 1, 3, 'duplicate\n'), 'w');
  let row = t.get(1);
  assert.equal(row?.lost, 2);
  assert.deepEqual(row?.lines, ['boot 1', 'after gap']);
  t.receive(telemetryDatagram(TelemetryKind.TM_LOG, 1, 0, 'boot 2\n'), 'w');
  row = t.get(1);
  assert.equal(row?.reboots, 1);
  assert.equal(row?.lost, 0);
  assert.deepEqual(row?.lines.slice(-2), ['--- station rebooted ---', 'boot 2']);
});

test('memory is bounded: lines per station and number of stations', () => {
  const t = new StationTelemetry({ secret: TEST_SECRET });
  for (let i = 0; i < MAX_LINES + 50; i++)
    t.receive(telemetryDatagram(TelemetryKind.TM_LOG, 1, i, `line ${i}\n`), 'w');
  const lines = t.get(1)?.lines ?? [];
  assert.equal(lines.length, MAX_LINES);
  assert.equal(lines.at(-1), `line ${MAX_LINES + 49}`);
  for (let st = 2; st < MAX_STATIONS + 10; st++)
    t.receive(telemetryDatagram(TelemetryKind.TM_LOG, st, 0, 'x\n'), 'w');
  assert.equal(t.stations().length, MAX_STATIONS);
});

test('every complete line reaches onLine (the per-station log file)', () => {
  const got: string[] = [];
  const t = new StationTelemetry({
    secret: TEST_SECRET,
    onLine: (st, line) => got.push(`${st}:${line}`),
  });
  t.receive(telemetryDatagram(TelemetryKind.TM_LOG, 6, 0, 'a\nb\npart'), 'w');
  assert.deepEqual(got, ['6:a', '6:b']);
});
