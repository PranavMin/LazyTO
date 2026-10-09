// guard.ts -- one LazyTO per network (docs/redesign.md: The LazyTO app).
// A beamer follows the last relay beacon it heard, so two relays on one
// Wi-Fi (a second laptop, a forgotten Pi) would split the stations between
// them, and each would report to start.gg. The relay listens on BEACON_PORT,
// where beamers hear beacons, for any beacon that is not its own (by source
// address): a relay that has heard another one refuses to start its event,
// and says so with the failed page's retries (app.ts). One that is already
// running keeps running and shows the other relay on the status page.

import { createSocket, type Socket } from 'node:dgram';
import { MAGIC_0, MAGIC_1, RELAY_BEACON_SIZE, decodeRelayBeacon } from '../generated/wire.js';
import { localAddresses } from './beacon.js';

/** Long enough to hear a beacon (one every BEACON_INTERVAL_MS, 2 s) before starting. */
export const GUARD_LISTEN_MS = 2500;
/** Another relay counts as present this long after its last beacon. */
export const OTHER_RELAY_FRESH_MS = 10_000;

export interface OtherRelay {
  address: string;
  tcpPort: number;
  eventId: number;
  version: number;
  firstAt: number;
  lastAt: number;
}

export interface GuardOptions {
  port: number;
  listenMs?: number;
  /** This machine's addresses: its own beacons come back from them. */
  ownAddresses?: () => string[];
}

export class RelayGuard {
  private socket: Socket | null = null;
  private boundAt = 0;
  private bindError: string | null = null;
  private other: OtherRelay | null = null;

  constructor(private readonly opts: GuardOptions) {}

  /** Bind the listening socket if it is not bound yet; a failure is kept for check(). */
  async listen(): Promise<void> {
    if (this.socket) return;
    // Shared: a development Dolphin on the same machine listens here for the beacon too.
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg, rinfo) => this.receive(msg, rinfo.address));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(this.opts.port, () => {
          socket.removeListener('error', reject);
          resolve();
        });
      });
    } catch (e) {
      socket.close();
      this.bindError = e instanceof Error ? e.message : String(e);
      return;
    }
    socket.on('error', (e) => console.error(`relay guard socket: ${e.message}`));
    this.socket = socket;
    this.bindError = null;
    this.boundAt = Date.now();
  }

  /**
   * Why tonight's event must not start, or null: another relay's beacon was
   * heard, or the guard cannot listen. Waits until it has listened for
   * GUARD_LISTEN_MS.
   */
  async check(): Promise<string | null> {
    await this.listen();
    if (!this.socket) {
      return `cannot listen on UDP ${this.opts.port} for another LazyTO relay: ${this.bindError}`;
    }
    const wait = this.boundAt + (this.opts.listenMs ?? GUARD_LISTEN_MS) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const other = this.heard();
    return other
      ? `another LazyTO relay is running on this network, at ${other.address} (event ${other.eventId}). ` +
          'Beamers follow whichever relay they heard last, so only one may run: close the other one'
      : null;
  }

  /** The other relay heard within OTHER_RELAY_FRESH_MS, or null. */
  heard(now = Date.now()): OtherRelay | null {
    return this.other && now - this.other.lastAt < OTHER_RELAY_FRESH_MS ? { ...this.other } : null;
  }

  /** The bound port (tests bind 0). */
  port(): number {
    return this.socket?.address().port ?? 0;
  }

  async stop(): Promise<void> {
    const s = this.socket;
    this.socket = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** One datagram on the beacon port; public so tests can drive it. A beacon request (tcp_port 0) is not a relay. */
  receive(msg: Uint8Array, from: string, now = Date.now()): void {
    if (msg.length !== RELAY_BEACON_SIZE || msg[0] !== MAGIC_0 || msg[1] !== MAGIC_1) return;
    const b = decodeRelayBeacon(msg);
    if (b.tcp_port === 0) return;
    if ((this.opts.ownAddresses ?? (() => localAddresses()))().includes(from)) return;
    const same = this.other?.address === from;
    this.other = {
      address: from,
      tcpPort: b.tcp_port,
      eventId: b.event_id,
      version: b.version,
      firstAt: same ? this.other!.firstAt : now,
      lastAt: now,
    };
  }
}
