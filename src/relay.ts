// relay.ts -- one tournament night's relay for one resolved event
// (architecture.md Relay): the audit log, the set cache (refreshed once
// before anything listens, so a bad token or event id fails here), station
// state rebuilt from the audit log, the TCP server the beamers reach, the
// beamers and their syncs (beamer.ts, collect.ts), the raw replay store and
// the set archive in the archive folder (rawstore.ts, archive.ts), and --
// unless the caller turns the network side off -- the discovery beacon and
// station telemetry. app.ts resolves the event and calls startEvent; the
// tests and the load test call it with the fake start.gg, port 0 and no
// broadcasts (test/harness.ts). The status page is the caller's: it serves
// this event's state but is not part of it.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog, auditPath, replayBestOf, replayClaims } from './audit.js';
import { Admin } from './admin.js';
import { SetArchive, type ArchiveEvent } from './archive.js';
import { BeamerRegistry } from './beamer.js';
import { RelayBeacon } from './beacon.js';
import { SetCache } from './cache.js';
import { Collector } from './collect.js';
import type { SetFormat } from './format.js';
import { RawStore, type RawStoreOptions } from './rawstore.js';
import type { StartggClient } from './startgg.js';
import { StationState } from './state.js';
import { RelayTcpServer } from './tcp.js';
import { StationTelemetry } from './telemetry.js';

export interface EventOptions {
  startgg: StartggClient;
  eventId: number;
  setFormat: SetFormat;
  /** Shared secret every beamer puts in relay_auth and that signs sync replies (decisions.md R16). */
  secret: string;
  /** The stream setup's station and its start.gg stream; null = no stream. */
  stream: { station: number; streamId: number } | null;
  /** Where the audit log (<eventId>.jsonl) and the per-station Wii logs go. */
  dataDir: string;
  tcpPort: number;
  host?: string;
  /** Beacon and telemetry on their fixed UDP ports. Tests leave them off. */
  network?: boolean;
  /** The archive folder, the set archive's file-name templates (names.ts) and what it says about the event. */
  archive: { dir: string; setName: string; gameName: string; event: ArchiveEvent };
  /** Tests stand in a full disk and shorten the download stall timeout. */
  rawStore?: RawStoreOptions;
  stallMs?: number;
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
  /** Each beamer, from its syncs, and who holds which station number. */
  beamers: BeamerRegistry;
  store: RawStore;
  collector: Collector;
  archive: SetArchive;
  admin: Admin;
  stop(): Promise<void>;
}

export async function startEvent(o: EventOptions): Promise<RunningEvent> {
  const host = o.host ?? '0.0.0.0';
  const network = o.network ?? true;
  const audit = new AuditLog(auditPath(o.dataDir, o.eventId));
  const cache = new SetCache(
    o.startgg,
    o.eventId,
    o.setFormat,
    (e) => audit.record({ type: 'refresh_error', error: String(e) }),
    (setId, e) =>
      audit.record({
        type: 'upstream',
        op: 'startPool',
        setId,
        ok: e === null,
        ...(e ? { error: String(e) } : {}),
      }),
  );
  let store: RawStore;
  try {
    await cache.refresh();
    // The archive folder's id and index; an unreadable archive.json stops the start here.
    store = new RawStore(o.archive.dir, o.rawStore);
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

  const beamers = new BeamerRegistry();
  const archive = new SetArchive({
    dir: o.archive.dir,
    store,
    beamerAt: (address) => beamers.stationIdAt(address),
    setTemplate: o.archive.setName,
    gameTemplate: o.archive.gameName,
    event: o.archive.event,
    audit,
  });
  const collector = new Collector({
    store,
    beamers,
    secret: o.secret,
    archive,
    audit,
    stallMs: o.stallMs,
  });

  cache.start();

  const tcp = new RelayTcpServer({
    cache,
    state,
    startgg: o.startgg,
    audit,
    archive,
    beamers,
    collector,
    stream: o.stream,
    secret: o.secret,
  });
  await tcp.listen(o.tcpPort, host);

  // Beamers find the relay from this broadcast (decisions.md R15); started only
  // once TCP is listening, so a beamer never learns an address that refuses.
  const beacon = network
    ? new RelayBeacon({ tcpPort: tcp.address().port, eventId: o.eventId })
    : null;
  await beacon?.start();
  // Each Wii's own boot report (kernel log + module status), through its beamer.
  // Lines are also appended to <dataDir>/wii-station-N.log so a boot can be read after the fact.
  const telemetry = new StationTelemetry({
    secret: o.secret,
    beaconPayload: beacon?.beaconPayload,
    admit: (station, from) => beamers.admit(station, from),
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
    beamers,
    store,
    collector,
    archive,
    admin: new Admin({ state, cache, startgg: o.startgg, audit, archive }),
    async stop() {
      cache.stop();
      await Promise.all([
        beacon?.stop(),
        network ? telemetry.stop() : undefined,
        tcp.close(),
        collector.stop(),
      ]);
      audit.close();
    },
  };
}
