// The layouts a beamer parses are frozen (protocol.yaml, "FROZEN layouts"):
// dongles have no over-the-air update, so these bytes may never change with
// PROTO_VERSION. A failure here means a frozen struct was edited; that needs
// a new BEAMER_SYNC_VERSION or a new beacon instead. The sync signature
// vector is the one docs/protocol-v2.md gives the firmware.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  AUTH_MAGIC_0,
  AUTH_MAGIC_1,
  BEAMER_SYNC_VERSION,
  BEAMER_SYNC_REQ_SIZE,
  BEAMER_SYNC_RESP_SIZE,
  MAGIC_0,
  MAGIC_1,
  RELAY_AUTH_SIZE,
  RELAY_BEACON_SIZE,
  RELAY_HDR_SIZE,
  RELAY_RESP_SIZE,
  RelayCmd,
  SYNC_ANSWER_SIZE,
  SYNC_FILE_SIZE,
  SyncAnswerKind,
  SyncKind,
  decodeBeamerSyncResp,
  encodeBeamerSyncReq,
  encodeRelayAuth,
  encodeRelayBeacon,
  encodeRelayHdr,
  encodeRelayResp,
} from '../generated/wire.js';
import { signedSyncResp, syncHmac } from '../src/sync.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const seq = (from: number, n = 16) => Uint8Array.from({ length: n }, (_, i) => (from + i) & 0xff);

test('frozen: the command value, the sync version and the struct sizes', () => {
  assert.equal(RelayCmd.CMD_BEAMER_SYNC, 8);
  assert.equal(BEAMER_SYNC_VERSION, 1);
  assert.deepEqual(
    [
      RELAY_BEACON_SIZE,
      RELAY_AUTH_SIZE,
      RELAY_HDR_SIZE,
      RELAY_RESP_SIZE,
      BEAMER_SYNC_REQ_SIZE,
      SYNC_FILE_SIZE,
      BEAMER_SYNC_RESP_SIZE,
      SYNC_ANSWER_SIZE,
    ],
    [12, 20, 8, 32, 100, 84, 52, 36],
  );
});

test('frozen: relay_beacon, relay_auth, relay_hdr and relay_resp bytes', () => {
  assert.equal(
    hex(
      encodeRelayBeacon({
        magic: new Uint8Array([MAGIC_0, MAGIC_1]),
        version: 2,
        tcp_port: 29470,
        event_id: 1613010,
      }),
    ),
    '4d540200731e000000189cd2',
  );
  assert.equal(
    hex(
      encodeRelayAuth({
        magic: new Uint8Array([AUTH_MAGIC_0, AUTH_MAGIC_1]),
        secret: 'venue-secret',
      }),
    ),
    '4d4b0000' + '76656e75652d736563726574' + '00000000',
  );
  assert.equal(
    hex(
      encodeRelayHdr({
        magic: new Uint8Array([MAGIC_0, MAGIC_1]),
        version: BEAMER_SYNC_VERSION,
        cmd: RelayCmd.CMD_BEAMER_SYNC,
        station: 12,
        len: 184,
      }),
    ),
    '4d540108000c00b8',
  );
  assert.equal(hex(encodeRelayResp({ status: 0, msg: 'ok' })), '00006f6b' + '00'.repeat(28));
});

test('frozen: beamer_sync_req field offsets', () => {
  const req = encodeBeamerSyncReq({
    station_id: seq(0x10),
    archive_id: seq(0xa0),
    nonce: seq(0x00),
    fw_build: 0x01020304,
    uptime_s: 0x05060708,
    free_mb: 0x090a0b0c,
    card_mb: 0x0d0e0f10,
    used_mb: 0x11121314,
    station: 0x1516,
    http_port: 0x1718,
    on_card: 0x191a,
    to_collect: 0x1b1c,
    to_erase: 0x1d1e,
    empty: 0x1f20,
    incomplete: 0x2122,
    acks: 0x2324,
    erased: 0x2526,
    erased_empty: 0x2728,
    erase_ms: 0x292a,
    erase_left: 0x2b2c,
    flags: 0x2d,
    storage: 0x2e,
    last_result: 0x2f,
    rssi: 0x30,
    files: [
      {
        name: 'Game_0017AB12CD34_20261007T201502.slp',
        bytes: 0x31323334,
        mtime: 0x35363738,
        kind: SyncKind.SK_FINISHED,
        hashed: 1,
        sha256: seq(0x40, 32),
      },
    ],
  });
  assert.equal(req.length, 100 + 84);
  assert.equal(
    hex(req.subarray(48, 100)),
    '01020304' +
      '05060708' +
      '090a0b0c' +
      '0d0e0f10' +
      '11121314' +
      '1516' +
      '1718' +
      '191a1b1c1d1e1f20212223242526' +
      '2728292a2b2c' +
      '2d2e2f30' +
      '01000000',
  );
  assert.equal(hex(req.subarray(0, 16)), hex(seq(0x10)), 'station_id first');
  assert.equal(hex(req.subarray(16, 32)), hex(seq(0xa0)), 'then archive_id');
  assert.equal(hex(req.subarray(32, 48)), hex(seq(0x00)), 'then the nonce');
  const f = req.subarray(100);
  assert.equal(
    Buffer.from(f.subarray(0, 37)).toString('ascii'),
    'Game_0017AB12CD34_20261007T201502.slp',
  );
  assert.equal(hex(f.subarray(37, 52)), '000000' + '31323334' + '35363738' + '01' + '01' + '0000');
  assert.equal(hex(f.subarray(52, 84)), hex(seq(0x40, 32)));
});

test('frozen: the sync reply signature (the vector docs/protocol-v2.md gives the firmware)', () => {
  const nonce = seq(0x00);
  const stationId = seq(0x10);
  const held = createHash('sha256').update('replay').digest();
  const out = signedSyncResp(
    'venue-secret',
    { nonce, station_id: stationId },
    {
      archive_id: seq(0xa0),
      answers: [
        { answer: SyncAnswerKind.SA_HELD, sha256: held },
        { answer: SyncAnswerKind.SA_WANTED, sha256: new Uint8Array(32) },
        { answer: SyncAnswerKind.SA_NOTED, sha256: new Uint8Array(32) },
      ],
    },
  );
  assert.equal(out.length, 52 + 3 * 36);
  assert.equal(
    hex(out.subarray(0, 32)),
    'dff09c43e230fa9913e545f4df881b9f78dbc9046530bfe3654b6583e988e48b',
  );
  assert.equal(hex(out.subarray(32, 52)), hex(seq(0xa0)) + '03000000');
  assert.equal(hex(out.subarray(52, 56)), '01000000');
  assert.equal(hex(out.subarray(56, 88)), hex(held));
  // The beamer's side of it: recompute over the bytes after the hmac.
  const r = decodeBeamerSyncResp(out);
  assert.equal(hex(syncHmac('venue-secret', nonce, stationId, out.subarray(32))), hex(r.hmac));
  assert.notEqual(
    hex(syncHmac('other-secret', nonce, stationId, out.subarray(32))),
    hex(r.hmac),
    'another secret does not verify',
  );
  assert.deepEqual(
    r.answers.map((a) => a.answer),
    [SyncAnswerKind.SA_HELD, SyncAnswerKind.SA_WANTED, SyncAnswerKind.SA_NOTED],
  );
});
