// beacon.ts -- relay discovery (decisions.md R15). Every BEACON_INTERVAL_MS the
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
// The error's code is kept too: on macOS, EHOSTUNREACH means Local Network
// permission is off for LazyTO (status.ts says where to turn it on), and the
// next tick after it is turned on works.

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

/** Every non-internal IPv4 interface address of this machine. */
function ipv4Interfaces(ifaces: Interfaces): NetworkInterfaceInfo[] {
  return Object.values(ifaces)
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal);
}

/** Directed broadcast address (addr | ~mask) of every non-internal IPv4 interface, deduplicated. */
export function directedBroadcasts(ifaces: Interfaces = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const a of ipv4Interfaces(ifaces)) {
    const addr = a.address.split('.').map(Number);
    const mask = a.netmask.split('.').map(Number);
    if (addr.length !== 4 || mask.length !== 4) continue;
    out.add(addr.map((b, i) => (b | (~mask[i]! & 0xff)) & 0xff).join('.'));
  }
  return [...out].sort();
}

/** This machine's own IPv4 addresses, for pages to show when relay.local does not resolve. */
export function localAddresses(ifaces: Interfaces = networkInterfaces()): string[] {
  return [...new Set(ipv4Interfaces(ifaces).map((a) => a.address))].sort();
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
  /** When the first beacon went out: how long stations have had to answer. */
  firstSentAt: number | null;
  lastSentAt: number | null;
  lastError: string | null;
  /** The last send error's errno code (EHOSTUNREACH, ENETUNREACH...); null after a send works. */
  lastErrorCode: string | null;
}

export class RelayBeacon {
  private socket: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly payload: Uint8Array;
  private readonly targets: () => string[];
  private readonly port: number;
  private readonly intervalMs: number;
  private state: BeaconStatus = {
    targets: [],
    sent: 0,
    firstSentAt: null,
    lastSentAt: null,
    lastError: null,
    lastErrorCode: null,
  };

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
    socket.on('error', (e: NodeJS.ErrnoException) => {
      this.state.lastError = e.message;
      this.state.lastErrorCode = e.code ?? null;
    });
    this.socket = socket;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  status(): BeaconStatus {
    return { ...this.state, targets: [...this.state.targets] };
  }

  /** The 12-byte relay_beacon this relay sends; telemetry.ts answers beacon requests with it. */
  get beaconPayload(): Uint8Array {
    return this.payload;
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
      this.state.lastErrorCode = null;
      return;
    }
    for (const host of targets) {
      socket.send(this.payload, this.port, host, (err: NodeJS.ErrnoException | null) => {
        if (err) {
          this.state.lastError = `${host}: ${err.message}`;
          this.state.lastErrorCode = err.code ?? null;
          return;
        }
        const now = Date.now();
        this.state.sent++;
        this.state.firstSentAt ??= now;
        this.state.lastSentAt = now;
        this.state.lastError = null;
        this.state.lastErrorCode = null;
      });
    }
  }
}
