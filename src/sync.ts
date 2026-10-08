// sync.ts -- the two uses of the secret on the wire (protocol.yaml
// relay_auth, beamer_sync_resp; docs/protocol-v2.md).
//
// relay_auth carries a key derived from the secret, never the secret itself:
// the first SECRET_LEN bytes of HMAC-SHA256 keyed with the NUL-padded secret
// over "LazyTO relay_auth". A beamer sends relay_auth to whichever host sent
// the last beacon, so anyone can collect that key by sending one beacon.
//
// The signature on a sync reply is keyed with the secret itself, which never
// travels: a beamer acks (and later erases) a replay only on a reply whose
// hmac verifies, so a host that collected the key, or downloaded a file,
// still cannot answer "held" for it. hmac = HMAC-SHA256 keyed with the
// secret's SECRET_LEN bytes (NUL-padded), over the request's nonce, then its
// station_id, then the reply payload after the hmac field. The beamer
// firmware computes both the same way; test/protocol-frozen.test.ts pins a
// vector of each that both sides check. Which answers to give is
// collect.ts's.

import { createHmac } from 'node:crypto';
import {
  SECRET_LEN,
  SHA256_LEN,
  encodeBeamerSyncResp,
  type BeamerSyncReq,
  type BeamerSyncResp,
} from '../generated/wire.js';

/** What relay_auth's key is derived over (17 ASCII bytes). */
const AUTH_LABEL = 'LazyTO relay_auth';

/** The secret's SECRET_LEN bytes, NUL-padded, as both HMACs are keyed. */
function secretKey(secret: string): Buffer {
  const key = Buffer.alloc(SECRET_LEN);
  key.write(secret, 'ascii');
  return key;
}

/** relay_auth's key for this secret: HMAC-SHA256(padded secret, AUTH_LABEL), its first SECRET_LEN bytes. */
export function relayAuthKey(secret: string): Buffer {
  return createHmac('sha256', secretKey(secret))
    .update(AUTH_LABEL, 'ascii')
    .digest()
    .subarray(0, SECRET_LEN);
}

/** HMAC-SHA256 over nonce | station_id | body, keyed with the NUL-padded secret. */
export function syncHmac(
  secret: string,
  nonce: Uint8Array,
  stationId: Uint8Array,
  body: Uint8Array,
): Uint8Array {
  return createHmac('sha256', secretKey(secret))
    .update(nonce)
    .update(stationId)
    .update(body)
    .digest();
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
