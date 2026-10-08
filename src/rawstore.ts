// rawstore.ts -- the laptop's copy of every replay the beamers recorded
// (docs/redesign.md: Collection, Self-erase). Everything lives in the
// archive folder, so a reinstalled app finds it:
//
//   archive.json                  {"archive_id": <32 hex>}: this archive's random id. A
//                                 beamer drops its acks when a sync answers with another
//                                 one, so a new laptop or a deleted folder collects again.
//   index.jsonl                   one line per stored copy (a later line for the same id
//                                 replaces it; {"id", "dropped": true} removes it)
//   raw/<station_id>/<name>       a replay bound to (or wanted by) a reported game
//   unmatched/<station_id>/<name> a stray or an incomplete recording
//   .partial/<station_id>/<name>.<bytes>.<mtime>   a download in progress
//
// A copy is stored the way a beamer may trust it: the download goes to the
// part file, which is fsynced, renamed into place, read back and hashed
// (SHA-256). A second file with the same name and a different hash is
// <stem>~<sha8>.slp beside the first. Raw copies stay until the TO deletes
// the event's folder: the laptop can answer "held" only while it has the file.
//
// held() is what a sync's SA_HELD rests on: a copy of that file (station_id,
// name, size and FAT time) that still stats at its size, re-hashed first when
// its last check is older than REHASH_AFTER_MS.

import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SYNC_ID_LEN } from '../generated/wire.js';

/** A stored copy whose last hash check is older than this is hashed again before it is answered "held". */
export const REHASH_AFTER_MS = 24 * 3600_000;
/** Free space a download must leave on the archive's disk. */
export const MIN_FREE_BYTES = 256 * 1024 * 1024;

export type Folder = 'raw' | 'unmatched';

export interface StoredReplay {
  /** `${stationId}/${name}/${sha8}`: one per distinct copy. */
  id: string;
  stationId: string;
  /** The file's name on the beamer. */
  name: string;
  /** Where it is, relative to the archive folder, '/'-separated. */
  path: string;
  /** Its size and FAT modified time on the beamer: with the name, which file this copy is of. */
  bytes: number;
  mtime: number;
  /** The beamer's sync_kind when it was downloaded. */
  kind: number;
  sha256: string; // hex, of the stored copy
  /** The relay's own check (slp.ts): raw length covered and a Game End. */
  complete: boolean;
  storedAt: number;
  verifiedAt: number;
}

/** What identifies a file on a beamer: its name, size and modified time. */
export interface BeamerFile {
  name: string;
  bytes: number;
  mtime: number;
}

export interface RawStoreOptions {
  /** Free bytes on the archive's disk; tests stand in a full disk. */
  freeBytes?: () => number;
  minFreeBytes?: number;
}

/** A name a beamer may sync that is safe as a file name here: letters, digits, _ - . and .slp. */
export const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,35}\.slp$/;

export class RawStore {
  readonly archiveId: Uint8Array;
  private readonly records = new Map<string, StoredReplay>();
  private readonly indexPath: string;

  constructor(
    readonly dir: string,
    private readonly opts: RawStoreOptions = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.archiveId = loadArchiveId(join(dir, 'archive.json'));
    this.indexPath = join(dir, 'index.jsonl');
    if (existsSync(this.indexPath)) {
      for (const line of readFileSync(this.indexPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let r: Partial<StoredReplay> & { dropped?: boolean };
        try {
          r = JSON.parse(line);
        } catch {
          continue; // a line cut short by a crash
        }
        if (typeof r.id !== 'string') continue;
        if (r.dropped) this.records.delete(r.id);
        else if (isStored(r)) this.records.set(r.id, r);
      }
    }
  }

  all(): StoredReplay[] {
    return [...this.records.values()];
  }

  get(id: string): StoredReplay | undefined {
    return this.records.get(id);
  }

  /** Copies from this beamer whose file name ends in this _YYYYMMDDTHHMMSS.slp stamp. */
  byStamp(stationId: string, stamp: string): StoredReplay[] {
    return this.all().filter((r) => r.stationId === stationId && r.name.endsWith(`_${stamp}.slp`));
  }

  absolute(r: StoredReplay): string {
    return join(this.dir, ...r.path.split('/'));
  }

  /**
   * The stored copies of this beamer file that can still be answered "held":
   * each one stats at its size, and one not checked for REHASH_AFTER_MS is
   * hashed again. A copy that fails is dropped from the index.
   */
  async held(stationId: string, f: BeamerFile, now = Date.now()): Promise<StoredReplay[]> {
    const out: StoredReplay[] = [];
    for (const r of this.all()) {
      if (r.stationId !== stationId || r.name !== f.name || r.bytes !== f.bytes) continue;
      if (r.mtime !== f.mtime) continue;
      let size: number;
      try {
        size = statSync(this.absolute(r)).size;
      } catch {
        size = -1;
      }
      if (size !== r.bytes) {
        this.drop(r);
        continue;
      }
      if (now - r.verifiedAt > REHASH_AFTER_MS) {
        const sha = sha256(await readFile(this.absolute(r)));
        if (sha !== r.sha256) {
          this.drop(r);
          continue;
        }
        this.write({ ...r, verifiedAt: now });
      }
      out.push(this.records.get(r.id)!);
    }
    return out;
  }

  /** Whether a download of this many bytes leaves MIN_FREE_BYTES free. */
  roomFor(bytes: number): boolean {
    return this.freeBytes() - bytes >= (this.opts.minFreeBytes ?? MIN_FREE_BYTES);
  }

  freeBytes(): number {
    if (this.opts.freeBytes) return this.opts.freeBytes();
    const s = statfsSync(this.dir);
    return s.bavail * s.bsize;
  }

  /** Where a download of this beamer file goes; other parts of the same name (an older size or time) are removed. */
  part(stationId: string, f: BeamerFile): { path: string; size: number } {
    const dir = join(this.dir, '.partial', stationId);
    mkdirSync(dir, { recursive: true });
    const mine = `${f.name}.${f.bytes}.${f.mtime}`;
    for (const other of readdirSync(dir)) {
      if (other !== mine && other.startsWith(`${f.name}.`))
        rmSync(join(dir, other), { force: true });
    }
    const path = join(dir, mine);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // no part yet
    }
    return { path, size };
  }

  /**
   * A finished download (the part file) becomes a stored copy in `folder`:
   * fsync, rename into place, read back, hash. The same content already
   * stored is reused; the same name with other content is <stem>~<sha8>.slp.
   */
  commit(
    stationId: string,
    f: BeamerFile,
    partPath: string,
    folder: Folder,
    kind: number,
    complete: boolean,
    now = Date.now(),
  ): StoredReplay {
    const fd = openSync(partPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const sha = sha256(readFileSync(partPath));
    const existing = this.all().find(
      (r) =>
        r.stationId === stationId &&
        r.name === f.name &&
        r.sha256 === sha &&
        existsSync(this.absolute(r)),
    );
    if (existing) {
      // Served again (after the beamer rebooted, so that it could hash it): nothing new to keep.
      rmSync(partPath, { force: true });
      const r = { ...existing, bytes: f.bytes, mtime: f.mtime, verifiedAt: now };
      this.write(r);
      return r;
    }
    const target = this.placeFor(folder, stationId, f.name, sha);
    mkdirSync(dirname(join(this.dir, ...target.split('/'))), { recursive: true });
    renameSync(partPath, join(this.dir, ...target.split('/')));
    const reread = sha256(readFileSync(join(this.dir, ...target.split('/'))));
    if (reread !== sha) throw new Error(`stored copy of ${f.name} reads back differently`);
    const r: StoredReplay = {
      id: `${stationId}/${f.name}/${sha.slice(0, 8)}`,
      stationId,
      name: f.name,
      path: target,
      bytes: f.bytes,
      mtime: f.mtime,
      kind,
      sha256: sha,
      complete,
      storedAt: now,
      verifiedAt: now,
    };
    this.write(r);
    return r;
  }

  /** Move a stored copy to the other folder (an unmatched replay a late report binds, or a set abandoned). */
  move(r: StoredReplay, folder: Folder): StoredReplay {
    if (r.path.startsWith(`${folder}/`)) return r;
    const target = this.placeFor(folder, r.stationId, r.name, r.sha256);
    mkdirSync(dirname(join(this.dir, ...target.split('/'))), { recursive: true });
    renameSync(this.absolute(r), join(this.dir, ...target.split('/')));
    const moved = { ...r, path: target };
    this.write(moved);
    return moved;
  }

  /**
   * The path for this copy in `folder`: <name>, or <stem>~<sha8>.slp when
   * <name> holds other content. A file there that no record names (its index
   * line was lost) and that has the same content is simply replaced.
   */
  private placeFor(folder: Folder, stationId: string, name: string, sha: string): string {
    const plain = `${folder}/${stationId}/${name}`;
    const file = join(this.dir, ...plain.split('/'));
    if (!existsSync(file)) return plain;
    const named = this.all().some((r) => r.path === plain);
    if (!named && sha256(readFileSync(file)) === sha) return plain;
    return `${folder}/${stationId}/${basename(name, '.slp')}~${sha.slice(0, 8)}.slp`;
  }

  private write(r: StoredReplay): void {
    this.records.set(r.id, r);
    appendFileSync(this.indexPath, `${JSON.stringify(r)}\n`);
  }

  private drop(r: StoredReplay): void {
    this.records.delete(r.id);
    appendFileSync(this.indexPath, `${JSON.stringify({ id: r.id, dropped: true })}\n`);
  }
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isStored(r: Partial<StoredReplay>): r is StoredReplay {
  return (
    typeof r.stationId === 'string' &&
    typeof r.name === 'string' &&
    typeof r.path === 'string' &&
    typeof r.bytes === 'number' &&
    typeof r.mtime === 'number' &&
    typeof r.sha256 === 'string' &&
    typeof r.verifiedAt === 'number'
  );
}

/** archive.json's archive_id, created (random, never all zero) when the folder has none. */
function loadArchiveId(path: string): Uint8Array {
  if (existsSync(path)) {
    let hex: unknown;
    try {
      hex = (JSON.parse(readFileSync(path, 'utf8')) as { archive_id?: unknown }).archive_id;
    } catch (e) {
      throw new Error(`${path} is not readable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (typeof hex !== 'string' || !/^[0-9a-f]{32}$/.test(hex) || /^0+$/.test(hex)) {
      throw new Error(`${path} has no valid archive_id`);
    }
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  }
  let id: Buffer;
  do id = randomBytes(SYNC_ID_LEN);
  while (id.every((b) => b === 0));
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ archive_id: id.toString('hex'), created: new Date().toISOString() }, null, 2)}\n`,
  );
  renameSync(tmp, path);
  return Uint8Array.from(id);
}
