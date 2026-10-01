// beamer.ts -- finding each station's Slippi Beamer and reading its replays
// (archive.ts uses both). A beamer (github.com/jendotpg/slippi-beamer) is a
// USB stick on the Wii that records the Slippi replays and serves them over
// Wi-Fi. Its API (API.md there, schema 1):
//   - a UDP multicast to 239.255.42.1:34700 on every game start and finish,
//     JSON with station_name ("Station 3", set with the beamer's button) and
//     the replay's name;
//   - GET /SLIPPI/ on port 80: {"files": [{"size", "url"}]}, the newest
//     replays, never the one still being written;
//   - GET /SLIPPI/<file>: the replay; 503 + Retry-After while another client
//     is pulling.
// The relay learns a station's beamer address from the announce's source
// address and the station number in its name; there is no beamer config.

import { createSocket, type Socket } from 'node:dgram';

export const ANNOUNCE_GROUP = '239.255.42.1';
export const ANNOUNCE_PORT = 34700;
const HTTP_TIMEOUT_MS = 15_000;

export interface BeamerInfo {
  address: string;
  stationId: string; // the beamer's own uuid
  stationName: string;
  lastSeen: number;
}

export interface AnnounceEvent {
  station: number;
  event: string; // "game_started" | "game_finished"
  replay: string | null; // file name
}

/** "Station 12" -> 12; anything else (a renamed beamer) -> null. */
export function stationNumber(stationName: string): number | null {
  const m = /^Station (\d{1,5})$/.exec(stationName.trim());
  return m ? Number(m[1]) : null;
}

/** Listens for beamer announces and remembers which address is which station. */
export class BeamerDirectory {
  private socket: Socket | null = null;
  private readonly beamers = new Map<number, BeamerInfo>();
  private unnamed = 0; // announces whose station_name is not "Station N"
  private bad = 0; // datagrams that are not schema-1 JSON

  constructor(
    private readonly opts: {
      port: number; // ANNOUNCE_PORT in production; tests pass 0
      onAnnounce?: (e: AnnounceEvent) => void;
      joinGroup?: boolean; // false in tests: they send unicast
    },
  ) {}

  async start(): Promise<void> {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo.address));
    socket.on('error', (e) => console.error(`beamer announce socket: ${e.message}`));
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.opts.port, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
    if (this.opts.joinGroup !== false) socket.addMembership(ANNOUNCE_GROUP);
    this.socket = socket;
  }

  port(): number {
    return this.socket?.address().port ?? 0;
  }

  async stop(): Promise<void> {
    const s = this.socket;
    this.socket = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  get(station: number): BeamerInfo | undefined {
    return this.beamers.get(station);
  }

  /** For the status page. */
  status(): { beamers: [number, BeamerInfo][]; unnamed: number; bad: number } {
    return {
      beamers: [...this.beamers.entries()].sort((a, b) => a[0] - b[0]),
      unnamed: this.unnamed,
      bad: this.bad,
    };
  }

  /** Exposed for tests; the socket calls it. */
  onMessage(msg: Buffer, from: string): void {
    let j: {
      schema?: unknown;
      event?: unknown;
      station_id?: unknown;
      station_name?: unknown;
      replay?: { name?: unknown };
    };
    try {
      j = JSON.parse(msg.toString('utf8'));
    } catch {
      this.bad++;
      return;
    }
    if (j.schema !== 1 || typeof j.station_name !== 'string' || typeof j.event !== 'string') {
      this.bad++;
      return;
    }
    const station = stationNumber(j.station_name);
    if (station === null) {
      this.unnamed++;
      return;
    }
    this.beamers.set(station, {
      address: from,
      stationId: typeof j.station_id === 'string' ? j.station_id : '',
      stationName: j.station_name,
      lastSeen: Date.now(),
    });
    const replay = typeof j.replay?.name === 'string' ? j.replay.name : null;
    this.opts.onAnnounce?.({ station, event: j.event, replay });
  }
}

export class BeamerBusy extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`beamer busy, retry after ${retryAfterMs} ms`);
    this.name = 'BeamerBusy';
  }
}

/** HTTP reads from one beamer. */
export class BeamerClient {
  constructor(private readonly base: string) {} // "http://10.0.0.7:80"

  static at(address: string, port: number): BeamerClient {
    return new BeamerClient(`http://${address}:${port}`);
  }

  /** Replay file names the beamer serves now, oldest first as listed. */
  async list(): Promise<{ name: string; size: number }[]> {
    const res = await this.get('/SLIPPI/');
    const j = (await res.json()) as {
      schema?: number;
      files?: { size?: unknown; url?: unknown }[];
    };
    if (j.schema !== 1 || !Array.isArray(j.files)) throw new Error('beamer index: not schema 1');
    const out: { name: string; size: number }[] = [];
    for (const f of j.files) {
      if (typeof f.url !== 'string' || typeof f.size !== 'number') continue;
      const name = f.url.split('/').pop() ?? '';
      if (/^[A-Za-z0-9_.-]+\.slp$/.test(name)) out.push({ name, size: f.size });
    }
    return out;
  }

  async fetchReplay(name: string): Promise<Buffer> {
    const res = await this.get(`/SLIPPI/${encodeURIComponent(name)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async get(path: string): Promise<Response> {
    const res = await fetch(this.base + path, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (res.status === 503 || res.status === 409) {
      const after = Number(res.headers.get('retry-after'));
      throw new BeamerBusy(Number.isFinite(after) && after > 0 ? after * 1000 : 5000);
    }
    if (!res.ok) throw new Error(`beamer ${path}: HTTP ${res.status}`);
    return res;
  }
}
