// telemetry-helpers.ts -- station telemetry datagrams built exactly as the
// Nintendont kernel sends them (relay_auth + telemetry_hdr + payload), for the
// telemetry and status tests and the status-page preview. Not a test file, so
// importing it runs no tests.

import {
  AUTH_MAGIC_0,
  AUTH_MAGIC_1,
  MAGIC_0,
  ModuleState,
  PROTO_VERSION,
  SECRET_LEN,
  TELEMETRY_MAGIC_1,
  encodeCrashReport,
  encodeRelayAuth,
  encodeStationStatus,
  encodeTelemetryHdr,
  type CrashReport,
  type StationStatus,
} from '../generated/wire.js';
import { TEST_SECRET } from './wii-client.js';

export function statusPayload(s: Partial<StationStatus>): Uint8Array {
  return encodeStationStatus({
    module_state: ModuleState.MOD_PENDING,
    module_patches: 0,
    module_len: 0,
    module_load: 0,
    arena_hi: 0,
    log_dropped: 0,
    ...s,
  });
}

export function crashPayload(c: Partial<CrashReport>): Uint8Array {
  return encodeCrashReport({
    error: 6,
    count: 1,
    srr0: 0,
    srr1: 0,
    dsisr: 0,
    dar: 0,
    lr: 0,
    sp: 0,
    r3: 0,
    r4: 0,
    fetched: [0, 0, 0, 0],
    stack: [0, 0, 0, 0, 0, 0, 0, 0],
    ...c,
  });
}

/** One datagram as the kernel sends it. */
export function telemetryDatagram(
  kind: number,
  station: number,
  seq: number,
  payload: string | Uint8Array,
  secret = TEST_SECRET,
): Uint8Array {
  const body =
    typeof payload === 'string' ? new Uint8Array(Buffer.from(payload, 'latin1')) : payload;
  const secretBytes = Buffer.alloc(SECRET_LEN);
  secretBytes.write(secret, 'ascii');
  const auth = encodeRelayAuth({
    magic: new Uint8Array([AUTH_MAGIC_0, AUTH_MAGIC_1]),
    secret: secretBytes.toString('latin1').replace(/\0+$/, ''),
  });
  const hdr = encodeTelemetryHdr({
    magic: new Uint8Array([MAGIC_0, TELEMETRY_MAGIC_1]),
    version: PROTO_VERSION,
    kind,
    station,
    len: body.length,
    seq,
    uptime_ms: 1000 + seq,
  });
  return new Uint8Array(Buffer.concat([auth, hdr, body]));
}
