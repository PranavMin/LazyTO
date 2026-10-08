// beamer.ts -- the stations' LazyTO beamers as the relay knows them
// (docs/redesign.md: Station identity on the beamer, Collection).
//
// A beamer is the Wii's only link: every Wii request and telemetry datagram
// arrives from its beamer's address, and the beamer's own sync
// (CMD_BEAMER_SYNC, collect.ts) says which beamer, by its station_id (from
// its MAC), is at that address, with its number, firmware, card and erase
// report. There is no beamer config and no announce: a beamer is known from
// its first sync.
//
// Duplicate numbers. The number is set with the beamer's button, so a stray
// click can make two beamers "Station 3". The relay remembers which address
// last used each station number (a request, a telemetry datagram or a sync
// naming it). Another beamer using the same number within DUP_WINDOW_MS is the
// newcomer: its Wii's requests get ST_DUP_STATION and its telemetry is
// dropped, until one of them is renumbered or the holder falls silent. The
// beamer already holding the station keeps playing. Two addresses are the
// same beamer when their syncs named the same station_id (a DHCP renewal). A
// sync is never refused: collection goes on, and the status page names both.
// The holder outlives a relay restart (settings saved, a crash relaunch):
// the claim's audit record names the beamer that made it, and startEvent
// gives a station with a live claim back to that beamer (hold).
//
// Downloads (fetchReplay): GET /SLIPPI/<name> from the address the beamer
// synced from, at the http_port it gave, resumed with X-Replay-From (the
// beamer echoes the header when it honours it), gzip accepted, the
// connection closed after each file. A transfer that stalls for stallMs is
// aborted. One attempt: the beamer's next sync asks again.

import { openSync, closeSync, writeSync } from 'node:fs';
import { BeamerSyncFlags, type BeamerSyncReq } from '../generated/wire.js';

/** Two beamers on one number within this long are a duplicate (the holder sends telemetry every 5 s). */
export const DUP_WINDOW_MS = 15_000;
/** A duplicate stays on the status page this long after its last refusal. */
export const DUP_SHOWN_MS = 60_000;
/** A station number that moved to another beamer is noted on the status page this long. */
export const HANDOVER_SHOWN_MS = 10 * 60_000;
/** A sync refused for its secret stays on the status page this long. */
const WRONG_SECRET_SHOWN_MS = 5 * 60_000;

/** A 16-byte station_id or archive_id as lower-case hex. */
export function hexId(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

/** A station_id as a beamer's /status shows it: a UUID. */
export function uuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface EraseReport {
  erased: number;
  erasedEmpty: number;
  eraseMs: number;
  eraseLeft: number;
  failed: boolean;
  /** When the relay first heard of it (the cold boot itself is uptime_s before). */
  at: number;
}

export interface BeamerRow {
  stationId: string; // hex
  address: string;
  httpPort: number;
  /** The number on its screen; null while unset (no SF_STATION_SET). */
  station: number | null;
  /** The number before the last change, and when it changed: the status page notes a renumbered beamer. */
  previousStation: number | null;
  renumberedAt: number | null;
  fwBuild: number;
  uptimeS: number;
  /** When this boot of the beamer began ("not unplugged since"). */
  bootAt: number;
  freeMb: number;
  cardMb: number;
  usedMb: number;
  onCard: number;
  toCollect: number;
  toErase: number;
  empty: number;
  incomplete: number;
  acks: number;
  /** The last cold boot's erase report. */
  erase: EraseReport | null;
  acksDropped: boolean;
  more: boolean;
  storage: number; // BeamerStorage
  lastResult: number; // BeamerResult
  rssi: number; // -dBm; 0 unknown
  firstSeenAt: number;
  lastSyncAt: number;
  syncs: number;
}

export interface Duplicate {
  station: number;
  /** The beamer that holds the number and keeps playing. */
  holder: { address: string; stationId: string | null };
  /** The beamer refused while the holder is active. */
  newcomer: { address: string; stationId: string | null };
  firstAt: number;
  lastAt: number;
  /** Wii requests and telemetry datagrams refused. */
  refused: number;
}

export interface WrongSecret {
  address: string;
  count: number;
  lastAt: number;
}

/** A station number taken over by another beamer after its holder fell silent (a beamer replaced mid-event). */
export interface Handover {
  station: number;
  before: { address: string; stationId: string | null };
  after: { address: string; stationId: string | null };
  at: number;
}

export class BeamerRegistry {
  private readonly rows = new Map<string, BeamerRow>(); // by station_id
  private readonly ids = new Map<string, string>(); // address -> station_id, from syncs
  private readonly owners = new Map<number, { address: string; lastAt: number }>(); // by station number
  private readonly dups = new Map<string, Duplicate>(); // by `${station}|${newcomer address}`
  private readonly wrongSecrets = new Map<string, WrongSecret>(); // by address
  private readonly handovers = new Map<number, Handover>(); // by station number, the latest
  private lastContactAt: number | null = null;

  /** A verified sync from `from`: the beamer's row, as it now stands. */
  synced(req: BeamerSyncReq, from: string, now = Date.now()): BeamerRow {
    const stationId = hexId(req.station_id);
    this.ids.set(from, stationId);
    this.lastContactAt = now;
    const station = req.flags & BeamerSyncFlags.SF_STATION_SET ? req.station : null;
    const prev = this.rows.get(stationId);
    const coldBoot = (req.flags & BeamerSyncFlags.SF_COLD_BOOT) !== 0;
    const bootAt = now - req.uptime_s * 1000;
    // A new boot is one that began after the last one we know of (two seconds' slack for rounding).
    const newBoot = !prev || bootAt > prev.bootAt + 2000;
    const erase: EraseReport | null =
      coldBoot && (newBoot || !prev?.erase)
        ? {
            erased: req.erased,
            erasedEmpty: req.erased_empty,
            eraseMs: req.erase_ms,
            eraseLeft: req.erase_left,
            failed: (req.flags & BeamerSyncFlags.SF_ERASE_FAILED) !== 0,
            at: now,
          }
        : (prev?.erase ?? null);
    const renumbered = prev !== undefined && prev.station !== station;
    const row: BeamerRow = {
      stationId,
      address: from,
      httpPort: req.http_port,
      station,
      previousStation: renumbered ? prev.station : (prev?.previousStation ?? null),
      renumberedAt: renumbered ? now : (prev?.renumberedAt ?? null),
      fwBuild: req.fw_build,
      uptimeS: req.uptime_s,
      bootAt: newBoot || !prev ? bootAt : prev.bootAt,
      freeMb: req.free_mb,
      cardMb: req.card_mb,
      usedMb: req.used_mb,
      onCard: req.on_card,
      toCollect: req.to_collect,
      toErase: req.to_erase,
      empty: req.empty,
      incomplete: req.incomplete,
      acks: req.acks,
      erase,
      acksDropped: (req.flags & BeamerSyncFlags.SF_ACKS_DROPPED) !== 0,
      more: (req.flags & BeamerSyncFlags.SF_MORE) !== 0,
      storage: req.storage,
      lastResult: req.last_result,
      rssi: req.rssi,
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSyncAt: now,
      syncs: (prev?.syncs ?? 0) + 1,
    };
    this.rows.set(stationId, row);
    // A sync naming a number keeps (or takes) it, and is never refused.
    if (station !== null) this.use(station, from, now);
    return row;
  }

  /** The station_id of the beamer that last synced from this address. */
  stationIdAt(address: string): string | undefined {
    return this.ids.get(address);
  }

  row(stationId: string): BeamerRow | undefined {
    return this.rows.get(stationId);
  }

  /** Every beamer that has synced, by station number (unset last), then station_id. */
  list(): BeamerRow[] {
    return [...this.rows.values()].sort(
      (a, b) =>
        (a.station ?? Infinity) - (b.station ?? Infinity) || a.stationId.localeCompare(b.stationId),
    );
  }

  /**
   * A Wii request or telemetry datagram for `station` from the beamer at
   * `from`. False for the newcomer of a duplicate: the caller refuses it.
   */
  admit(station: number, from: string, now = Date.now()): boolean {
    this.lastContactAt = now;
    return this.use(station, from, now);
  }

  /**
   * After a relay restart: the beamer that claimed `station`'s live set
   * (audit.ts replayHolders) holds the number again, as if it had just
   * spoken, so the newcomer of a duplicate pair cannot take the station and
   * its set by speaking first. It keeps it until it is silent for
   * DUP_WINDOW_MS, like any holder. Its station_id, when known, lets its
   * syncs from a new address count as the same beamer.
   */
  hold(station: number, address: string, stationId: string | null, now = Date.now()): void {
    this.owners.set(station, { address, lastAt: now });
    if (stationId !== null && !this.ids.has(address)) this.ids.set(address, stationId);
  }

  /** Duplicates refused within DUP_SHOWN_MS, lowest station first. */
  duplicates(now = Date.now()): Duplicate[] {
    return [...this.dups.values()]
      .filter((d) => now - d.lastAt < DUP_SHOWN_MS)
      .sort((a, b) => a.station - b.station);
  }

  /** A sync refused for a wrong or missing secret (tcp.ts). */
  wrongSecret(from: string, now = Date.now()): void {
    const w = this.wrongSecrets.get(from);
    this.wrongSecrets.set(from, { address: from, count: (w?.count ?? 0) + 1, lastAt: now });
  }

  /** Beamers whose syncs were refused for their secret recently. */
  wrongSecretBeamers(now = Date.now()): WrongSecret[] {
    return [...this.wrongSecrets.values()].filter((w) => now - w.lastAt < WRONG_SECRET_SHOWN_MS);
  }

  /** Station numbers that moved to another beamer within `withinMs`. */
  handedOver(now = Date.now(), withinMs = HANDOVER_SHOWN_MS): Handover[] {
    return [...this.handovers.values()]
      .filter((h) => now - h.at < withinMs)
      .sort((a, b) => a.station - b.station);
  }

  /** When anything last came from a beamer: a sync, a Wii request or telemetry; null if never. */
  lastContact(): number | null {
    return this.lastContactAt;
  }

  /** Whether two addresses are one beamer (the same one, or syncs from both named the same station_id). */
  private same(a: string, b: string): boolean {
    if (a === b) return true;
    const ia = this.ids.get(a);
    return ia !== undefined && ia === this.ids.get(b);
  }

  private use(station: number, from: string, now: number): boolean {
    const owner = this.owners.get(station);
    if (!owner || this.same(owner.address, from) || now - owner.lastAt > DUP_WINDOW_MS) {
      if (owner && !this.same(owner.address, from)) {
        this.handovers.set(station, {
          station,
          before: { address: owner.address, stationId: this.ids.get(owner.address) ?? null },
          after: { address: from, stationId: this.ids.get(from) ?? null },
          at: now,
        });
      }
      this.owners.set(station, { address: from, lastAt: now });
      return true;
    }
    const key = `${station}|${from}`;
    const d = this.dups.get(key);
    this.dups.set(key, {
      station,
      holder: { address: owner.address, stationId: this.ids.get(owner.address) ?? null },
      newcomer: { address: from, stationId: this.ids.get(from) ?? null },
      firstAt: d?.firstAt ?? now,
      lastAt: now,
      refused: (d?.refused ?? 0) + 1,
    });
    return false;
  }
}

export class BeamerBusy extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`beamer busy, retry after ${retryAfterMs} ms`);
    this.name = 'BeamerBusy';
  }
}

/** The beamer has less of the file than the resume asked for (416): start again from 0. */
export class ResumePastEnd extends Error {
  constructor() {
    super('the beamer has less of this file than was already downloaded');
    this.name = 'ResumePastEnd';
  }
}

const CONNECT_TIMEOUT_MS = 5000;

/**
 * Download a replay into `partPath`, resuming at `from` bytes (the part's
 * size). Appends when the beamer honours the resume (it echoes
 * X-Replay-From), else rewrites the part from the start. Throws on any
 * failure; the part keeps what arrived.
 */
export async function fetchReplay(
  url: string,
  partPath: string,
  from: number,
  stallMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  signal?.addEventListener('abort', abort);
  let timer = setTimeout(abort, CONNECT_TIMEOUT_MS);
  const stall = () => {
    clearTimeout(timer);
    timer = setTimeout(abort, stallMs);
  };
  try {
    // Connection: close. A beamer has two TCP connections in all and, in LazyTO
    // mode, one HTTP socket; a kept-alive download would hold one that its
    // Wii's next request to the relay needs.
    const headers: Record<string, string> = { 'accept-encoding': 'gzip', connection: 'close' };
    if (from > 0) headers['x-replay-from'] = String(from);
    const res = await fetch(url, { headers, signal: ctl.signal });
    stall();
    if (res.status === 503 || res.status === 409) {
      await res.body?.cancel();
      const after = Number(res.headers.get('retry-after'));
      throw new BeamerBusy(Number.isFinite(after) && after > 0 ? after * 1000 : 5000);
    }
    if (res.status === 416) {
      await res.body?.cancel();
      throw new ResumePastEnd();
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    const resumed = from > 0 && res.headers.get('x-replay-from') === String(from);
    const fd = openSync(partPath, resumed ? 'a' : 'w');
    try {
      for await (const chunk of res.body) {
        writeSync(fd, chunk as Uint8Array);
        stall();
      }
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (ctl.signal.aborted && !(e instanceof BeamerBusy) && !(e instanceof ResumePastEnd)) {
      throw new Error(signal?.aborted ? 'download stopped' : 'download stalled');
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
