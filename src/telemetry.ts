// telemetry.ts -- station telemetry (protocol.yaml telemetry_hdr). Each Wii's
// Nintendont kernel sends its own log lines and its tournament-module load
// status to UDP TELEMETRY_PORT at the relay address it learned from the
// beacon, so a station that boots wrong is diagnosed from the status page,
// not by carrying its SD card to a PC (first hardware run, 2026-09-30: the
// module silently refused to load and only the SD log said why).
//
// Every datagram is relay_auth + telemetry_hdr + payload. A wrong or missing
// secret is dropped and counted, exactly like a TCP request (design R16), so
// nobody else on the venue Wi-Fi can paint a station's row. Nothing is ever
// sent back. Memory is bounded: MAX_STATIONS rows, MAX_LINES lines each,
// lines cut to MAX_LINE_LEN.

import { createSocket, type Socket } from 'node:dgram';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  AUTH_MAGIC_0,
  AUTH_MAGIC_1,
  MAGIC_0,
  ModuleState,
  PROTO_VERSION,
  RELAY_AUTH_SIZE,
  SECRET_LEN,
  STATION_STATUS_SIZE,
  CRASH_REPORT_SIZE,
  TELEMETRY_HDR_SIZE,
  TELEMETRY_MAGIC_1,
  TELEMETRY_PORT,
  TELEMETRY_TEXT_MAX,
  TelemetryKind,
  decodeCrashReport,
  decodeStationStatus,
  decodeTelemetryHdr,
  type CrashReport,
  type StationStatus,
} from '../generated/wire.js';

export const MAX_STATIONS = 64;
export const MAX_LINES = 400;
export const MAX_LINE_LEN = 300;

export interface StationTelemetryRow {
  station: number;
  from: string;
  lastSeenAt: number;
  /** Datagrams missing between seq numbers since the station's last reboot. */
  lost: number;
  /** Times the station's seq went backwards (a kernel reboot). */
  reboots: number;
  uptimeMs: number;
  status: StationStatus | null;
  statusAt: number | null;
  /** The game's last unhandled exception, as the module recorded it. */
  crash: CrashReport | null;
  crashAt: number | null;
  lines: string[];
}

const ERROR_NAMES: Record<number, string> = {
  2: 'DSI (bad data address)',
  3: 'ISI (bad instruction address)',
  5: 'alignment',
  6: 'program',
  7: 'floating point',
};

/** One line for a crash: "program (illegal instruction) at 0x817E88D8 = module+0x88D8". */
export function crashText(c: CrashReport, status: StationStatus | null): string {
  let kind = ERROR_NAMES[c.error] ?? `error ${c.error}`;
  if (c.error === 6) {
    const why = c.srr1 & 0x80000 ? 'illegal instruction' : c.srr1 & 0x40000 ? 'privileged instruction' : c.srr1 & 0x20000 ? 'trap' : 'program check';
    kind = `${kind} (${why})`;
  }
  return `${kind} at ${hexAddr(c.srr0, status)}, lr ${hexAddr(c.lr, status)}`;
}

/** 0x817E88D8, plus "= module+0x88D8" when the address is inside the loaded module. */
export function hexAddr(a: number, status: StationStatus | null): string {
  const hex = `0x${a.toString(16).toUpperCase().padStart(8, '0')}`;
  if (status && status.module_len && a >= status.module_load && a < status.module_load + status.module_len) {
    return `${hex} = module+0x${(a - status.module_load).toString(16).toUpperCase()}`;
  }
  return hex;
}

export interface TelemetryRefused {
  count: number;
  lastAt: number;
  lastFrom: string;
  lastStation: number;
}

export interface TelemetryOptions {
  secret: string;
  port?: number;
  host?: string;
  /** Called with every complete log line (the relay appends them to a per-station file). */
  onLine?: (station: number, line: string) => void;
}

/** Human text for a module_state, for the status page. */
export function moduleStateText(s: StationStatus): string {
  switch (s.module_state) {
    case ModuleState.MOD_PENDING:
      return 'no game booted yet';
    case ModuleState.MOD_LOADED:
      return `loaded (${s.module_len} bytes, ${s.module_patches} patches)`;
    case ModuleState.MOD_NOT_FOUND:
      return 'NOT LOADED: no tournament.bin on the SD card';
    case ModuleState.MOD_BAD_FILE:
      return 'NOT LOADED: tournament.bin is not a module file';
    case ModuleState.MOD_BAD_HEADER:
      return 'NOT LOADED: tournament.bin header rejected (wrong version or size)';
    case ModuleState.MOD_GUARD:
      return 'NOT LOADED: the disc is not stock Melee 1.02';
    case ModuleState.MOD_ARENA:
      return `NOT LOADED: module overlaps game memory (arena top 0x${s.arena_hi.toString(16)})`;
    case ModuleState.MOD_READ_FAILED:
      return 'NOT LOADED: reading tournament.bin failed';
    case ModuleState.MOD_NOT_MELEE:
      return 'NOT LOADED: the game is not Melee NTSC 1.02';
    default:
      return `unknown module state ${s.module_state}`;
  }
}

export class StationTelemetry {
  private socket: Socket | null = null;
  private readonly expectedSecret: Buffer;
  private readonly rows = new Map<number, StationTelemetryRow & { seq: number; partial: string }>();
  private refusals: TelemetryRefused | null = null;

  constructor(private readonly opts: TelemetryOptions) {
    this.expectedSecret = Buffer.alloc(SECRET_LEN);
    this.expectedSecret.write(opts.secret, 'ascii');
  }

  async start(): Promise<void> {
    const socket = createSocket('udp4');
    socket.on('message', (msg, rinfo) => this.receive(msg, rinfo.address));
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.opts.port ?? TELEMETRY_PORT, this.opts.host ?? '0.0.0.0', () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
    // A later socket error (none expected for a bound UDP receiver) must not kill the relay.
    socket.on('error', (e) => console.error(`telemetry socket: ${e.message}`));
    this.socket = socket;
  }

  address(): AddressInfo {
    if (!this.socket) throw new Error('telemetry not started');
    return this.socket.address();
  }

  async stop(): Promise<void> {
    const s = this.socket;
    this.socket = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** One row per station heard from, lowest station first. */
  stations(): StationTelemetryRow[] {
    return [...this.rows.values()]
      .sort((a, b) => a.station - b.station)
      .map(({ seq: _seq, partial: _partial, ...row }) => ({ ...row, lines: [...row.lines] }));
  }

  get(station: number): StationTelemetryRow | undefined {
    return this.stations().find((r) => r.station === station);
  }

  refused(): TelemetryRefused | null {
    return this.refusals ? { ...this.refusals } : null;
  }

  /** Parse one datagram; public so tests can drive it without a socket. */
  receive(msg: Uint8Array, from: string, now = Date.now()): void {
    if (msg.length < RELAY_AUTH_SIZE + TELEMETRY_HDR_SIZE) return;
    const authed = msg[0] === AUTH_MAGIC_0 && msg[1] === AUTH_MAGIC_1;
    const hdrOff = RELAY_AUTH_SIZE;
    if (msg[hdrOff] !== MAGIC_0 || msg[hdrOff + 1] !== TELEMETRY_MAGIC_1) return;
    const hdr = decodeTelemetryHdr(msg, hdrOff);
    if (hdr.version !== PROTO_VERSION) return;
    const payloadOff = hdrOff + TELEMETRY_HDR_SIZE;
    if (msg.length < payloadOff + hdr.len) return;

    const secretOk =
      authed && timingSafeEqual(Buffer.from(msg.subarray(4, 4 + SECRET_LEN)), this.expectedSecret);
    if (!secretOk) {
      this.refusals = {
        count: (this.refusals?.count ?? 0) + 1,
        lastAt: now,
        lastFrom: from,
        lastStation: hdr.station,
      };
      return;
    }

    let row = this.rows.get(hdr.station);
    if (!row) {
      if (this.rows.size >= MAX_STATIONS) return;
      row = {
        station: hdr.station,
        from,
        lastSeenAt: now,
        lost: 0,
        reboots: 0,
        uptimeMs: 0,
        status: null,
        statusAt: null,
        crash: null,
        crashAt: null,
        lines: [],
        seq: -1,
        partial: '',
      };
      this.rows.set(hdr.station, row);
    }
    if (row.seq >= 0 && hdr.seq <= row.seq) {
      if (hdr.seq < row.seq) {
        // The kernel restarted: a fresh boot log follows.
        row.reboots += 1;
        row.lost = 0;
        row.partial = '';
        this.pushLine(row, `--- station rebooted ---`);
      } else {
        return; // duplicate
      }
    } else if (row.seq >= 0 && hdr.seq > row.seq + 1) {
      row.lost += hdr.seq - row.seq - 1;
    }
    row.seq = hdr.seq;
    row.from = from;
    row.lastSeenAt = now;
    row.uptimeMs = hdr.uptime_ms;

    const payload = msg.subarray(payloadOff, payloadOff + hdr.len);
    if (hdr.kind === TelemetryKind.TM_STATUS && payload.length >= STATION_STATUS_SIZE) {
      row.status = decodeStationStatus(payload);
      row.statusAt = now;
    } else if (hdr.kind === TelemetryKind.TM_CRASH && payload.length >= CRASH_REPORT_SIZE) {
      row.crash = decodeCrashReport(payload);
      row.crashAt = now;
      this.pushLine(row, `--- crash: ${crashText(row.crash, row.status)} ---`);
    } else if (hdr.kind === TelemetryKind.TM_LOG && payload.length <= TELEMETRY_TEXT_MAX) {
      const text = row.partial + Buffer.from(payload).toString('latin1');
      const parts = text.split('\n');
      row.partial = (parts.pop() ?? '').slice(0, MAX_LINE_LEN);
      for (const p of parts) this.pushLine(row, p.replace(/\r$/, ''));
    }
  }

  private pushLine(row: StationTelemetryRow, line: string): void {
    const clean = line.replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_LINE_LEN);
    row.lines.push(clean);
    if (row.lines.length > MAX_LINES) row.lines.splice(0, row.lines.length - MAX_LINES);
    this.opts.onLine?.(row.station, clean);
  }
}
