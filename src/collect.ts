// collect.ts -- the relay's side of CMD_BEAMER_SYNC (docs/protocol-v2.md,
// docs/redesign.md: Collection, Self-erase). A beamer syncs on its relay link
// when it has no Wii request pending: after each file it served, when it
// finds a new file, and every 30 s. The relay records the beamer
// (beamer.ts), answers each listed file, signs the reply (sync.ts) and
// downloads what it asked for. This replaces polling each beamer's index and
// listening for its announces: everything a beamer has is collected,
// whatever the set archive makes of it.
//
// The answer for each file:
//   SA_HELD    the beamer served it whole this boot and hashed it, and the
//              laptop has a stored copy (rawstore.ts held(): stat, re-hash
//              after a day) with that very hash. The beamer acks it, and
//              erases it at its next cold boot.
//   SA_WANTED  the laptop downloads it now: not stored yet, or stored but not
//              hashed by the beamer this boot (a file served before a reboot
//              is served again, so that the beamer can hash it), or stored
//              with another hash.
//   SA_NOTED   anything else: being recorded (SK_LIVE), downloading right now,
//              a name that is not a plain .slp, or not enough free disk.
//
// Downloads go one at a time per beamer, in the sync's order, from the
// address it synced from: resumed with X-Replay-From from the part file,
// after a free-disk check. A failed download is not retried: the beamer's
// next sync asks again (CLAUDE.md: no retries). Each stored copy goes to
// raw/ or unmatched/ as the set archive says (archive.ts placeFor), and the
// archive hears of it at once.

import { readFileSync, rmSync, statSync } from 'node:fs';
import {
  SHA256_LEN,
  SyncAnswerKind,
  SyncKind,
  type BeamerSyncReq,
  type SyncAnswer,
  type SyncFile,
} from '../generated/wire.js';
import { BeamerBusy, ResumePastEnd, fetchReplay, hexId, type BeamerRegistry } from './beamer.js';
import { SAFE_NAME, type Folder, type RawStore, type StoredReplay } from './rawstore.js';
import { parseSlp } from './slp.js';
import { signedSyncResp } from './sync.js';

/** A download that sends nothing for this long is abandoned until the next sync. */
export const STALL_MS = 10_000;

export interface CollectorDeps {
  store: RawStore;
  beamers: BeamerRegistry;
  /** Keys the reply's HMAC: the secret itself, which never travels (relay_auth carries a key derived from it, sync.ts). */
  secret: string;
  /** The set archive: where a stored copy goes, and that it arrived. */
  archive: {
    placeFor(stationId: string, name: string, complete: boolean): Folder;
    stored(r: StoredReplay): void;
  };
  audit: { record(event: Record<string, unknown>): void };
  stallMs?: number;
}

export interface WorkerStatus {
  stationId: string;
  current: string | null;
  queued: number;
  downloaded: number;
  lastError: string | null;
  lastErrorAt: number | null;
  /** The last sync could not want a file for lack of disk space. */
  diskFull: boolean;
}

interface Worker extends WorkerStatus {
  queue: SyncFile[];
  running: Promise<void> | null;
}

export class Collector {
  private readonly workers = new Map<string, Worker>();
  private readonly stopper = new AbortController();

  constructor(private readonly deps: CollectorDeps) {}

  /** Handle one verified sync from `from`; returns the signed beamer_sync_resp payload. */
  async sync(req: BeamerSyncReq, from: string, now = Date.now()): Promise<Uint8Array> {
    const row = this.deps.beamers.synced(req, from, now);
    const w = this.worker(row.stationId);
    const answers: SyncAnswer[] = [];
    const wanted: SyncFile[] = [];
    let diskFull = false;
    for (const f of req.files) {
      const a = await this.answer(row.stationId, w, f, now);
      if (a === 'full') diskFull = true;
      if (a === SyncAnswerKind.SA_WANTED) wanted.push(f);
      answers.push(
        typeof a === 'object'
          ? { answer: SyncAnswerKind.SA_HELD, sha256: Buffer.from(a.sha256, 'hex') }
          : {
              answer: a === SyncAnswerKind.SA_WANTED ? a : SyncAnswerKind.SA_NOTED,
              sha256: new Uint8Array(SHA256_LEN),
            },
      );
    }
    w.diskFull = diskFull;
    // The latest sync is the beamer's truth: what it lists and we want, in its order.
    w.queue = wanted;
    this.kick(w);
    return signedSyncResp(this.deps.secret, req, {
      archive_id: this.deps.store.archiveId,
      answers,
    });
  }

  status(): WorkerStatus[] {
    return [...this.workers.values()].map(({ queue, running: _running, ...s }) => ({
      ...s,
      queued: queue.length,
    }));
  }

  /** True while any beamer has a download running or queued. */
  busy(): boolean {
    return [...this.workers.values()].some((w) => w.running !== null || w.queue.length > 0);
  }

  /** Resolves when every download in flight or queued has finished (tests). */
  async idle(): Promise<void> {
    while (true) {
      const running = [...this.workers.values()].map((w) => w.running).filter((p) => p !== null);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  /** Abandon downloads in flight (the event is stopping); parts stay for the next run. */
  async stop(): Promise<void> {
    this.stopper.abort();
    await this.idle();
  }

  private worker(stationId: string): Worker {
    let w = this.workers.get(stationId);
    if (!w) {
      w = {
        stationId,
        current: null,
        queued: 0,
        downloaded: 0,
        lastError: null,
        lastErrorAt: null,
        diskFull: false,
        queue: [],
        running: null,
      };
      this.workers.set(stationId, w);
    }
    return w;
  }

  private async answer(
    stationId: string,
    w: Worker,
    f: SyncFile,
    now: number,
  ): Promise<StoredReplay | SyncAnswerKind | 'full'> {
    if (!SAFE_NAME.test(f.name) || f.kind === SyncKind.SK_LIVE || w.current === f.name) {
      return SyncAnswerKind.SA_NOTED;
    }
    if (f.hashed) {
      const beamerSha = hexId(f.sha256);
      const copy = (await this.deps.store.held(stationId, f, now)).find(
        (r) => r.sha256 === beamerSha,
      );
      if (copy) return copy;
    }
    if (!this.deps.store.roomFor(f.bytes)) return 'full';
    return SyncAnswerKind.SA_WANTED;
  }

  /** Start the beamer's downloads unless they are running (a sync that came while the last one finished restarts them). */
  private kick(w: Worker): void {
    if (w.running || w.queue.length === 0 || this.stopper.signal.aborted) return;
    w.running = this.run(w).finally(() => {
      w.running = null;
      this.kick(w);
    });
  }

  private async run(w: Worker): Promise<void> {
    while (w.queue.length > 0 && !this.stopper.signal.aborted) {
      const f = w.queue.shift()!;
      const row = this.deps.beamers.row(w.stationId);
      if (!row) break;
      if (!this.deps.store.roomFor(f.bytes)) {
        w.diskFull = true;
        w.queue = [];
        break;
      }
      w.current = f.name;
      try {
        await this.download(w.stationId, row.address, row.httpPort, f);
        w.downloaded++;
        w.lastError = null;
      } catch (e) {
        w.lastError = `${f.name}: ${e instanceof Error ? e.message : String(e)}`;
        w.lastErrorAt = Date.now();
        this.deps.audit.record({
          type: 'collect_error',
          stationId: w.stationId,
          station: row.station,
          replay: f.name,
          error: e instanceof Error ? e.message : String(e),
        });
        // The next sync asks again; nothing is retried here.
        w.queue = [];
      } finally {
        w.current = null;
      }
    }
  }

  private async download(stationId: string, address: string, port: number, f: SyncFile) {
    const { store } = this.deps;
    const part = store.part(stationId, f);
    let from = part.size > f.bytes ? 0 : part.size;
    if (from === f.bytes && f.bytes > 0) from = 0; // a whole part not committed: fetch it again
    const url = `http://${address}:${port}/SLIPPI/${encodeURIComponent(f.name)}`;
    try {
      await fetchReplay(url, part.path, from, this.deps.stallMs ?? STALL_MS, this.stopper.signal);
    } catch (e) {
      if (e instanceof ResumePastEnd) rmSync(part.path, { force: true });
      if (e instanceof BeamerBusy) throw new Error('beamer busy');
      throw e;
    }
    const size = statSync(part.path).size;
    if (size !== f.bytes) {
      // Short: the part is kept, and the next sync resumes it. Longer: the file changed.
      if (size > f.bytes) rmSync(part.path, { force: true });
      throw new Error(`got ${size} of ${f.bytes} bytes`);
    }
    const complete = slpComplete(readFileSync(part.path));
    const folder = this.deps.archive.placeFor(stationId, f.name, complete);
    const r = store.commit(stationId, f, part.path, folder, f.kind, complete);
    this.deps.audit.record({
      type: 'collected',
      stationId,
      station: this.deps.beamers.row(stationId)?.station ?? null,
      replay: f.name,
      path: r.path,
      bytes: r.bytes,
      sha256: r.sha256,
      complete,
    });
    this.deps.archive.stored(r);
  }
}

/** A replay the relay can use: it parses, and its raw length and Game End are there. */
function slpComplete(buf: Buffer): boolean {
  try {
    return parseSlp(buf).complete;
  } catch {
    return false;
  }
}
