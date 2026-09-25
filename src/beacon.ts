// beacon.ts -- relay discovery (design.md R15). Every BEACON_INTERVAL_MS the
// relay broadcasts one relay_beacon datagram (protocol.yaml) to the directed
// broadcast address of each of its IPv4 interfaces, UDP port BEACON_PORT.
// Stations take the datagram's source address plus its tcp_port as the relay,
// so no SD card carries a relay address and the Pi's address may change.
//
// The broadcast list is recomputed on every tick, not once at startup: a Pi
// that joins Wi-Fi after the relay starts, or gets a new DHCP address, is
// announced correctly on the next beacon. Send errors (an interface going
// down between listing and sending) are counted and shown on the status page,
// never fatal: the next tick tries again with the current interface list.

import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import {
  BEACON_INTERVAL_MS,
  BEACON_PORT,
  MAGIC_0,
  MAGIC_1,
  PROTO_VERSION,
  encodeRelayBeacon,
} from '../generated/wire.js';

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

/** Directed broadcast address (addr | ~mask) of every non-internal IPv4 interface, deduplicated. */
export function directedBroadcasts(ifaces: Interfaces = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      // Node reports family as 'IPv4' (a number, 4, in 18.0 only).
      if ((a.family !== 'IPv4' && (a.family as unknown) !== 4) || a.internal) continue;
      const addr = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      if (addr.length !== 4 || mask.length !== 4) continue;
      out.add(addr.map((b, i) => (b | (~mask[i]! & 0xff)) & 0xff).join('.'));
    }
  }
  return [...out].sort();
}

export interface BeaconOptions {
  tcpPort: number;
  eventId: number;
  /** Where to send each tick; production recomputes directed broadcasts, tests pass 127.0.0.1. */
  targets?: () => string[];
  port?: number;
  intervalMs?: number;
}

export interface BeaconStatus {
  targets: string[];
  sent: number;
  lastSentAt: number | null;
  lastError: string | null;
}

export class RelayBeacon {
  private socket: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly payload: Uint8Array;
  private readonly targets: () => string[];
  private readonly port: number;
  private readonly intervalMs: number;
  private state: BeaconStatus = { targets: [], sent: 0, lastSentAt: null, lastError: null };

  constructor(opts: BeaconOptions) {
    this.payload = encodeRelayBeacon({
      magic: new Uint8Array([MAGIC_0, MAGIC_1]),
      version: PROTO_VERSION,
      tcp_port: opts.tcpPort,
      event_id: opts.eventId,
    });
    this.targets = opts.targets ?? (() => directedBroadcasts());
    this.port = opts.port ?? BEACON_PORT;
    this.intervalMs = opts.intervalMs ?? BEACON_INTERVAL_MS;
  }

  /** Bind an ephemeral UDP socket with broadcast enabled and send the first beacon now. */
  async start(): Promise<void> {
    const socket = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
    socket.setBroadcast(true);
    socket.on('error', (e) => {
      this.state.lastError = e.message;
    });
    this.socket = socket;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  status(): BeaconStatus {
    return { ...this.state, targets: [...this.state.targets] };
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  private tick(): void {
    const socket = this.socket;
    if (!socket) return;
    const targets = this.targets();
    this.state.targets = targets;
    if (targets.length === 0) {
      this.state.lastError = 'no IPv4 network interface (not on Wi-Fi / no cable?)';
      return;
    }
    for (const host of targets) {
      socket.send(this.payload, this.port, host, (err) => {
        if (err) {
          this.state.lastError = `${host}: ${err.message}`;
          return;
        }
        this.state.sent++;
        this.state.lastSentAt = Date.now();
        this.state.lastError = null;
      });
    }
  }
}
