// sync.ts -- the signature on a beamer sync reply (protocol.yaml
// beamer_sync_resp, docs/protocol-v2.md). A beamer acks (and later erases) a
// replay only on a reply whose hmac verifies, so a stranger on the Wi-Fi who
// downloads a file cannot answer "held" for it. hmac = HMAC-SHA256 keyed with
// the secret's SECRET_LEN bytes exactly as relay_auth carries them
// (NUL-padded), over the request's nonce, then its station_id, then the
// reply payload after the hmac field. The beamer firmware computes the same;
// test/protocol-frozen.test.ts pins a vector both sides check.
//
// Which answers to give (collection, acks) is not built yet: tcp.ts answers a
// sync without a payload, so nothing is acked.

import { createHmac } from 'node:crypto';
import {
  SECRET_LEN,
  SHA256_LEN,
  encodeBeamerSyncResp,
  type BeamerSyncReq,
  type BeamerSyncResp,
} from '../generated/wire.js';

/** HMAC-SHA256 over nonce | station_id | body, keyed with the NUL-padded secret. */
export function syncHmac(
  secret: string,
  nonce: Uint8Array,
  stationId: Uint8Array,
  body: Uint8Array,
): Uint8Array {
  const key = Buffer.alloc(SECRET_LEN);
  key.write(secret, 'ascii');
  return createHmac('sha256', key).update(nonce).update(stationId).update(body).digest();
}

/** The beamer_sync_resp payload for a request, with its hmac filled in. */
export function signedSyncResp(
  secret: string,
  req: Pick<BeamerSyncReq, 'nonce' | 'station_id'>,
  resp: Omit<BeamerSyncResp, 'hmac'>,
): Uint8Array {
  const out = encodeBeamerSyncResp({ ...resp, hmac: new Uint8Array(SHA256_LEN) });
  out.set(syncHmac(secret, req.nonce, req.station_id, out.subarray(SHA256_LEN)), 0);
  return out;
}
