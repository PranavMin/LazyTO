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
// part file, which is fsynced, renamed into place (the renamed file and, on
// POSIX, its folder fsynced too), read back and hashed (SHA-256), and its
// index line is fsynced before anything can answer "held" for it: a beamer
// that has the ack erases its file at the next power-on, so a crash must not
// lose the copy or its index line after that. A second file with the same
// name and a different hash is <stem>~<sha8>.slp beside the first. The same
// file downloaded again is checked against the stored copy, re-read, and
// replaces it if it no longer reads back as stored. Raw copies stay until the
// TO deletes the event's folder: the laptop can answer "held" only while it
// has the file.
//
// held() is what a sync's SA_HELD rests on: a copy of that file (station_id,
// name, size and FAT time) that still stats at its size, re-hashed first when
// its last check is older than REHASH_AFTER_MS.
//
// The folder is the truth for the archive's id. checkedArchiveId(), before
// each sync reply, reads archive.json again: if the TO deleted the folder (or
// archive.json) while LazyTO runs, a new archive starts with a new id, so
// the beamers drop their acks and the files are collected again, instead of
// erasing replays this laptop no longer has.

import { createHash, randomBytes } from 'node:crypto';
import {
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
  writeSync,
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
  private id: Uint8Array;
  private readonly records = new Map<string, StoredReplay>();
  private readonly indexPath: string;
  private readonly idPath: string;

  constructor(
    readonly dir: string,
    private readonly opts: RawStoreOptions = {},
  ) {
    this.indexPath = join(dir, 'index.jsonl');
    this.idPath = join(dir, 'archive.json');
    this.id = this.open();
  }

  /** This archive's id (archive.json) as last read. */
  get archiveId(): Uint8Array {
    return this.id;
  }

  /**
   * The archive_id for a sync reply, after reading archive.json again. If it
   * is gone (the folder was deleted while LazyTO runs) or names another
   * archive, the store starts again from what the folder holds now, with a
   * new id when it has none: a beamer that gets another id drops every ack.
   * An unreadable archive.json throws, so the sync gets no reply to ack on.
   */
  checkedArchiveId(): Uint8Array {
    const onDisk = readArchiveId(this.idPath);
    if (onDisk === null || !Buffer.from(onDisk).equals(Buffer.from(this.id))) {
      this.id = this.open();
    }
    return this.id;
  }

  /** The folder, archive.json (made when missing) and the index, read from disk. */
  private open(): Uint8Array {
    mkdirSync(this.dir, { recursive: true });
    const id = readArchiveId(this.idPath) ?? newArchiveId(this.idPath);
    this.records.clear();
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
    return id;
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
    fsyncFile(partPath);
    const sha = sha256(readFileSync(partPath));
    const existing = this.all().find(
      (r) => r.stationId === stationId && r.name === f.name && r.sha256 === sha,
    );
    if (existing) {
      if (readsBack(this.absolute(existing), sha)) {
        // Served again (after the beamer rebooted, so that it could hash it),
        // and the stored copy still reads back as stored: nothing new to keep.
        rmSync(partPath, { force: true });
        const r = { ...existing, bytes: f.bytes, mtime: f.mtime, verifiedAt: now };
        this.write(r);
        return r;
      }
      // The stored copy is gone, or was changed in place at its size (an
      // edit, a sync tool, the disk): this download, which hashes as that
      // copy did when it was stored, takes its place.
      return this.place(partPath, sha, {
        ...existing,
        bytes: f.bytes,
        mtime: f.mtime,
        kind,
        storedAt: now,
        verifiedAt: now,
      });
    }
    return this.place(partPath, sha, {
      id: `${stationId}/${f.name}/${sha.slice(0, 8)}`,
      stationId,
      name: f.name,
      path: this.placeFor(folder, stationId, f.name, sha),
      bytes: f.bytes,
      mtime: f.mtime,
      kind,
      sha256: sha,
      complete,
      storedAt: now,
      verifiedAt: now,
    });
  }

  /** Move a stored copy to the other folder (an unmatched replay a late report binds, or a set abandoned). */
  move(r: StoredReplay, folder: Folder): StoredReplay {
    if (r.path.startsWith(`${folder}/`)) return r;
    const target = this.placeFor(folder, r.stationId, r.name, r.sha256);
    const to = join(this.dir, ...target.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    renameSync(this.absolute(r), to);
    syncRenamed(to);
    const moved = { ...r, path: target };
    this.write(moved);
    return moved;
  }

  /**
   * The fsynced part file becomes the stored copy `r` at r.path: renamed
   * into place, the rename made durable, read back and hashed, then indexed
   * (fsynced). Only then can a sync answer "held" for it.
   */
  private place(partPath: string, sha: string, r: StoredReplay): StoredReplay {
    const to = join(this.dir, ...r.path.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    renameSync(partPath, to);
    syncRenamed(to);
    if (sha256(readFileSync(to)) !== sha) {
      throw new Error(`stored copy of ${r.name} reads back differently`);
    }
    this.write(r);
    return r;
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

  /** A record's index line, on disk (fsynced) before the record can be answered "held". */
  private write(r: StoredReplay): void {
    this.append(JSON.stringify(r));
    this.records.set(r.id, r);
  }

  private drop(r: StoredReplay): void {
    this.records.delete(r.id);
    this.append(JSON.stringify({ id: r.id, dropped: true }));
  }

  private append(line: string): void {
    const created = !existsSync(this.indexPath);
    const fd = openSync(this.indexPath, 'a');
    try {
      writeSync(fd, `${line}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) fsyncDir(this.dir);
  }
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Whether the file at `path` is there and hashes to `sha`. */
function readsBack(path: string, sha: string): boolean {
  try {
    return sha256(readFileSync(path)) === sha;
  } catch {
    return false; // gone or unreadable: not a copy to answer "held" for
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * A folder's entries to disk, after a rename into it or a new file in it.
 * POSIX only: Windows cannot open a folder to fsync it, and there the
 * renamed file's own fsync (FlushFileBuffers) is what Node can do.
 */
function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A rename into `path` made durable: the file, then its folder's entry. */
function syncRenamed(path: string): void {
  fsyncFile(path);
  fsyncDir(dirname(path));
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

/** archive.json's archive_id; null when there is no archive.json. Throws when it is unreadable or holds no valid id. */
function readArchiveId(path: string): Uint8Array | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${path} is not readable: ${e instanceof Error ? e.message : String(e)}`);
  }
  let hex: unknown;
  try {
    hex = (JSON.parse(text) as { archive_id?: unknown }).archive_id;
  } catch (e) {
    throw new Error(`${path} is not readable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof hex !== 'string' || !/^[0-9a-f]{32}$/.test(hex) || /^0+$/.test(hex)) {
    throw new Error(`${path} has no valid archive_id`);
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** A new archive.json with a random archive_id (never all zero), on disk before it is used. */
function newArchiveId(path: string): Uint8Array {
  let id: Buffer;
  do id = randomBytes(SYNC_ID_LEN);
  while (id.every((b) => b === 0));
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ archive_id: id.toString('hex'), created: new Date().toISOString() }, null, 2)}\n`,
  );
  fsyncFile(tmp);
  renameSync(tmp, path);
  syncRenamed(path);
  return Uint8Array.from(id);
}
