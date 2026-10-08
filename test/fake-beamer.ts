// A fake LazyTO beamer for tests and scripts/fake-beamer.ts: the firmware's
// side of CMD_BEAMER_SYNC and its HTTP file server (docs/protocol-v2.md,
// Beamer firmware), over an in-memory card.
//
//   - HTTP: GET /SLIPPI/<name> serves any file by name that is not being
//     recorded, resumed with X-Replay-From (echoed back), gzip when asked,
//     503 + Retry-After while `busy`. A whole file served (resumed or not)
//     is hashed as the firmware does, over its raw bytes, and remembered for
//     this boot.
//   - Sync: relay_auth (the key from the secret, never the secret) +
//     relay_hdr (version BEAMER_SYNC_VERSION, cmd 8) +
//     beamer_sync_req listing the files without an ack (served-this-boot
//     first, then finished, incomplete, live; 16 at most, SF_MORE beyond),
//     then the reply checked the way the firmware must: magic, version,
//     cmd, ST_OK, answer count, a nonzero archive_id, the HMAC. A new
//     archive_id drops every ack; SA_HELD acks a file only if its hash is
//     the one computed serving it this boot.
//   - boot(): a cold boot's erase. 0-byte files and acked ones go; hashes
//     are forgotten.
//
// Like a real beamer it sends from and serves on its own address: tests give
// a second beamer 127.0.0.2.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import {
  AUTH_MAGIC_0,
  AUTH_MAGIC_1,
  BEAMER_SYNC_RESP_SIZE,
  BEAMER_SYNC_VERSION,
  BeamerSyncFlags,
  MAGIC_0,
  MAGIC_1,
  RELAY_HDR_SIZE,
  RELAY_RESP_SIZE,
  RelayCmd,
  RelayStatus,
  SECRET_LEN,
  SHA256_LEN,
  SYNC_ANSWER_SIZE,
  SYNC_MAX_FILES,
  SyncAnswerKind,
  SyncKind,
  decodeBeamerSyncResp,
  decodeRelayHdr,
  decodeRelayResp,
  encodeBeamerSyncReq,
  encodeRelayAuth,
  encodeRelayHdr,
  type BeamerSyncReq,
  type SyncFile,
} from '../generated/wire.js';
import { relayAuthKey } from '../src/sync.js';
import { TEST_SECRET } from './wii-client.js';

export interface FakeFile {
  name: string;
  data: Buffer;
  mtime: number; // FAT date << 16 | time
  kind: SyncKind;
}

export interface SyncResult {
  status: RelayStatus;
  msg: string;
  /** Answers by file name, in the order the sync listed them. */
  answers: { name: string; answer: SyncAnswerKind; sha256: string }[];
  /** Whether the reply passed every check the firmware makes. */
  verified: boolean;
  /** Files acked by this reply. */
  acked: string[];
}

/** A FAT modified time for a test file: date and time packed, distinct per n. */
export function fatTime(n: number): number {
  const date = ((2026 - 1980) << 9) | (10 << 5) | 7;
  return ((date << 16) | (n & 0xffff)) >>> 0;
}

export class FakeBeamer {
  readonly stationId: Uint8Array;
  station: number | null;
  secret = TEST_SECRET;
  fwBuild = 2;
  uptimeS = 60;
  coldBoot = true;
  busy = false;
  /** The next transfer is cut off after this many body bytes. */
  cutAfter: number | null = null;
  readonly files: FakeFile[] = [];
  /** Acked files: name -> (bytes, mtime, sha), as the firmware keeps them in NVS. */
  readonly acks = new Map<string, { bytes: number; mtime: number; sha: string }>();
  /** Files served whole this boot: name -> SHA-256 of their raw bytes. */
  readonly hashes = new Map<string, string>();
  archiveId: Uint8Array = new Uint8Array(16);
  /** Every HTTP request: the file, its X-Replay-From (null = none), whether gzip was asked for, its Connection header. */
  readonly gets: { name: string; from: number | null; gzip: boolean; connection: string }[] = [];
  erasedAtBoot = { erased: 0, empty: 0 };
  private readonly server: Server;

  constructor(
    seed: number,
    station: number | null,
    readonly address = '127.0.0.1',
  ) {
    this.stationId = Uint8Array.from(
      createHash('sha256').update(`beamer-${seed}`).digest().subarray(0, 16),
    );
    this.station = station;
    this.server = createServer((req, res) => {
      const m = /^\/SLIPPI\/([^/?]+)$/.exec(req.url ?? '');
      const name = m ? decodeURIComponent(m[1]!) : '';
      const f = this.files.find((x) => x.name === name && x.kind !== SyncKind.SK_LIVE);
      const fromHeader = req.headers['x-replay-from'];
      const from = typeof fromHeader === 'string' ? Number(fromHeader) : null;
      const gzip = /gzip/.test(String(req.headers['accept-encoding'] ?? ''));
      this.gets.push({ name, from, gzip, connection: String(req.headers.connection ?? '') });
      if (this.busy) {
        res.writeHead(503, { 'Retry-After': '1', 'Content-Type': 'application/json' }).end('{}');
        return;
      }
      if (!f) {
        res.writeHead(404).end();
        return;
      }
      const start = from ?? 0;
      if (start >= f.data.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${f.data.length}` }).end();
        return;
      }
      const body = f.data.subarray(start);
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
      if (from !== null) headers['X-Replay-From'] = String(start);
      if (this.cutAfter !== null) {
        // A transfer that dies part way: the bytes so far, then the connection drops.
        const cut = this.cutAfter;
        this.cutAfter = null;
        res.writeHead(200, { ...headers, 'Content-Length': String(body.length) });
        res.write(body.subarray(0, cut), () => setTimeout(() => res.destroy(), 20));
        return;
      }
      const out = gzip ? gzipSync(body) : body;
      if (gzip) headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, { ...headers, 'Content-Length': String(out.length) });
      // The firmware hashes the skipped prefix, then everything it sends: the whole file.
      this.hashes.set(f.name, createHash('sha256').update(f.data).digest('hex'));
      res.end(out);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, this.address, resolve));
  }

  /** 0 until listen(): a beamer used only to build sync requests serves nothing. */
  httpPort(): number {
    return this.server.listening ? (this.server.address() as AddressInfo).port : 0;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  add(
    name: string,
    data: Buffer,
    kind: SyncKind = SyncKind.SK_FINISHED,
    mtime = fatTime(this.files.length + 1),
  ): FakeFile {
    const f = { name, data, mtime, kind };
    const i = this.files.findIndex((x) => x.name === name);
    if (i >= 0) this.files[i] = f;
    else this.files.push(f);
    return f;
  }

  /** A cold boot's erase: empty files, and acked ones whose size and time still match. */
  boot(): { erased: number; empty: number } {
    let erased = 0;
    let empty = 0;
    for (let i = this.files.length - 1; i >= 0; i--) {
      const f = this.files[i]!;
      const ack = this.acks.get(f.name);
      if (f.data.length === 0) {
        this.files.splice(i, 1);
        empty++;
      } else if (ack && ack.bytes === f.data.length && ack.mtime === f.mtime) {
        this.files.splice(i, 1);
        this.acks.delete(f.name);
        erased++;
      }
    }
    this.hashes.clear();
    this.coldBoot = true;
    this.uptimeS = 5;
    this.erasedAtBoot = { erased, empty };
    return this.erasedAtBoot;
  }

  /** The sync request the firmware would send now. */
  syncRequest(): BeamerSyncReq {
    const order = (f: FakeFile) =>
      this.hashes.has(f.name)
        ? 0
        : f.kind === SyncKind.SK_FINISHED
          ? 1
          : f.kind === SyncKind.SK_INCOMPLETE
            ? 2
            : 3;
    const pending = this.files
      .filter((f) => f.data.length > 0 && !this.acks.has(f.name))
      .sort((a, b) => order(a) - order(b) || a.mtime - b.mtime);
    const listed = pending.slice(0, SYNC_MAX_FILES);
    const files: SyncFile[] = listed.map((f) => {
      const sha = this.hashes.get(f.name);
      return {
        name: f.name,
        bytes: f.data.length,
        mtime: f.mtime,
        kind: f.kind,
        hashed: sha ? 1 : 0,
        sha256: sha ? Buffer.from(sha, 'hex') : new Uint8Array(SHA256_LEN),
      };
    });
    const used = this.files.reduce((n, f) => n + f.data.length, 0);
    return {
      station_id: this.stationId,
      archive_id: this.archiveId,
      nonce: Uint8Array.from(randomBytes(16)),
      fw_build: this.fwBuild,
      uptime_s: this.uptimeS,
      free_mb: 3800 - Math.ceil(used / 1024 / 1024),
      card_mb: 3800,
      used_mb: Math.ceil(used / 1024 / 1024),
      station: this.station ?? 0,
      http_port: this.httpPort(),
      on_card: this.files.length,
      to_collect: pending.length,
      to_erase: this.files.filter((f) => this.acks.has(f.name)).length,
      empty: this.files.filter((f) => f.data.length === 0).length,
      incomplete: this.files.filter((f) => f.kind === SyncKind.SK_INCOMPLETE).length,
      acks: this.acks.size,
      erased: this.coldBoot ? this.erasedAtBoot.erased : 0,
      erased_empty: this.coldBoot ? this.erasedAtBoot.empty : 0,
      erase_ms: this.coldBoot ? 120 : 0,
      erase_left: 0,
      flags:
        (this.station !== null ? BeamerSyncFlags.SF_STATION_SET : 0) |
        (this.coldBoot ? BeamerSyncFlags.SF_COLD_BOOT : 0) |
        (pending.length > listed.length ? BeamerSyncFlags.SF_MORE : 0),
      storage: 0,
      last_result: 0,
      rssi: 61,
      files,
    };
  }

  /** Sync with the relay at port over TCP, from this beamer's address, and apply the reply. */
  async sync(port: number, host = '127.0.0.1'): Promise<SyncResult> {
    const req = this.syncRequest();
    const payload = encodeBeamerSyncReq(req);
    const out = Buffer.concat([
      encodeRelayAuth({
        magic: new Uint8Array([AUTH_MAGIC_0, AUTH_MAGIC_1]),
        key: relayAuthKey(this.secret),
      }),
      encodeRelayHdr({
        magic: new Uint8Array([MAGIC_0, MAGIC_1]),
        version: BEAMER_SYNC_VERSION,
        cmd: RelayCmd.CMD_BEAMER_SYNC,
        station: this.station ?? 0,
        len: payload.length,
      }),
      payload,
    ]);
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect({ port, host, localAddress: this.address });
      const chunks: Buffer[] = [];
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('relay timeout'));
      });
      socket.on('error', reject);
      socket.on('connect', () => socket.write(out));
      socket.on('data', (c: Buffer) => chunks.push(c));
      socket.on('close', () => resolve(Buffer.concat(chunks)));
    });
    return this.apply(req, reply);
  }

  /** Check a reply as the firmware does and apply it: adopt the archive, ack what is held. */
  apply(req: BeamerSyncReq, reply: Buffer): SyncResult {
    const hdr = decodeRelayHdr(reply);
    const resp = decodeRelayResp(reply, RELAY_HDR_SIZE);
    const body = reply.subarray(RELAY_HDR_SIZE + RELAY_RESP_SIZE);
    const result: SyncResult = {
      status: resp.status,
      msg: resp.msg,
      answers: [],
      verified: false,
      acked: [],
    };
    this.coldBoot = false; // the erase report goes with the first sync after the boot
    if (
      hdr.magic[0] !== MAGIC_0 ||
      hdr.magic[1] !== MAGIC_1 ||
      hdr.version !== BEAMER_SYNC_VERSION ||
      hdr.cmd !== RelayCmd.CMD_BEAMER_SYNC ||
      resp.status !== RelayStatus.ST_OK ||
      body.length !== BEAMER_SYNC_RESP_SIZE + SYNC_ANSWER_SIZE * req.files.length
    ) {
      return result;
    }
    const sync = decodeBeamerSyncResp(body);
    const key = Buffer.alloc(SECRET_LEN);
    key.write(this.secret, 'ascii');
    const mac = createHmac('sha256', key)
      .update(req.nonce)
      .update(req.station_id)
      .update(body.subarray(SHA256_LEN))
      .digest();
    if (
      sync.answers.length !== req.files.length ||
      sync.archive_id.every((b) => b === 0) ||
      !mac.equals(Buffer.from(sync.hmac))
    ) {
      return result;
    }
    result.verified = true;
    if (!Buffer.from(sync.archive_id).equals(Buffer.from(this.archiveId))) {
      this.acks.clear();
      this.archiveId = Uint8Array.from(sync.archive_id);
    }
    sync.answers.forEach((a, i) => {
      const f = req.files[i]!;
      const sha = Buffer.from(a.sha256).toString('hex');
      result.answers.push({ name: f.name, answer: a.answer, sha256: sha });
      if (a.answer === SyncAnswerKind.SA_HELD && this.hashes.get(f.name) === sha) {
        this.acks.set(f.name, { bytes: f.bytes, mtime: f.mtime, sha });
        result.acked.push(f.name);
      }
    });
    return result;
  }
}
