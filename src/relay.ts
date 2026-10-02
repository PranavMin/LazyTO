// relay.ts -- one tournament night's relay for one resolved event
// (architecture.md Relay): the audit log, the set cache (refreshed once
// before anything listens, so a bad token or event id fails here), station
// state rebuilt from the audit log, the Wii-facing TCP server, and -- unless
// the caller turns the network side off -- the discovery beacon and station
// telemetry. main.ts resolves the event and calls startEvent; the tests and
// the load test call it with the fake start.gg, port 0 and no broadcasts
// (test/harness.ts). The status page is the caller's: it serves this event's
// state but is not part of it.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog, auditPath, replayBestOf, replayClaims } from './audit.js';
import { Admin } from './admin.js';
import { RelayBeacon } from './beacon.js';
import { SetCache } from './cache.js';
import type { SetFormat } from './format.js';
import type { StartggClient } from './startgg.js';
import { StationState } from './state.js';
import { RelayTcpServer } from './tcp.js';
import { StationTelemetry } from './telemetry.js';

export interface EventOptions {
  startgg: StartggClient;
  eventId: number;
  setFormat: SetFormat;
  /** Shared secret every Wii request and telemetry datagram carries (decisions.md R16). */
  secret: string;
  /** The stream setup's station and its start.gg stream; null = no stream. */
  stream: { station: number; streamId: number } | null;
  /** Where the audit log (<eventId>.jsonl) and the per-station Wii logs go. */
  dataDir: string;
  tcpPort: number;
  host?: string;
  /** Beacon and telemetry on their fixed UDP ports. Tests leave them off. */
  network?: boolean;
}

export interface RunningEvent {
  eventId: number;
  cache: SetCache;
  state: StationState;
  audit: AuditLog;
  tcp: RelayTcpServer;
  /** null when started without the network side. */
  beacon: RelayBeacon | null;
  /** Always present (the status page reads it); bound to its UDP port only with the network side. */
  telemetry: StationTelemetry;
  admin: Admin;
  stop(): Promise<void>;
}

export async function startEvent(o: EventOptions): Promise<RunningEvent> {
  const host = o.host ?? '0.0.0.0';
  const network = o.network ?? true;
  const audit = new AuditLog(auditPath(o.dataDir, o.eventId));
  const cache = new SetCache(o.startgg, o.eventId, o.setFormat, (e) =>
    audit.record({ type: 'refresh_error', error: String(e) }),
  );
  try {
    await cache.refresh();
  } catch (e) {
    audit.close();
    throw e;
  }

  const state = new StationState();
  // The TO's best-of overrides from the status page (admin.ts) outlive restarts.
  for (const [setId, bestOf] of replayBestOf(audit.path)) cache.setBestOfOverride(setId, bestOf);
  for (const [station, claim] of replayClaims(audit.path)) {
    if (cache.get(claim.setId)) {
      state.claim(station, claim);
      audit.record({ type: 'replay', station, setId: claim.setId, games: claim.games.length });
    }
  }
  cache.start();

  const tcp = new RelayTcpServer({
    cache,
    state,
    startgg: o.startgg,
    audit,
    stream: o.stream,
    secret: o.secret,
  });
  await tcp.listen(o.tcpPort, host);

  // Stations find the relay from this broadcast (decisions.md R15); started only
  // once TCP is listening, so a station never learns an address that refuses.
  const beacon = network
    ? new RelayBeacon({ tcpPort: tcp.address().port, eventId: o.eventId })
    : null;
  await beacon?.start();
  // Each Wii's own boot report (kernel log + module status). Lines are also
  // appended to <dataDir>/wii-station-N.log so a boot can be read after the fact.
  const telemetry = new StationTelemetry({
    secret: o.secret,
    beaconPayload: beacon?.beaconPayload,
    onLine: (station, line) => {
      try {
        appendFileSync(
          join(o.dataDir, `wii-station-${station}.log`),
          `${new Date().toISOString()} ${line}\n`,
        );
      } catch (e) {
        console.error(`wii log write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
  if (network) await telemetry.start();

  return {
    eventId: o.eventId,
    cache,
    state,
    audit,
    tcp,
    beacon,
    telemetry,
    admin: new Admin({ state, cache, startgg: o.startgg, audit }),
    async stop() {
      cache.stop();
      await Promise.all([beacon?.stop(), network ? telemetry.stop() : undefined, tcp.close()]);
      audit.close();
    },
  };
}
