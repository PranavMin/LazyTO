// main.ts -- process entry point (design.md sections 6.3 and 10). Reads the
// config path from the CONFIG environment variable (the systemd unit sets
// it), validates everything, resolves the configured tournament short URL,
// event name and stream name to tonight's ids (resolve.ts), does one cache
// refresh -- so a bad token, a short URL nobody moved yet or an ambiguous
// event name kills the process before a Wii ever connects -- replays the
// audit log to rebuild station claims, then serves TCP and the status page.

import { loadConfig } from './config.js';
import { StartggClient } from './startgg.js';
import { SetCache } from './cache.js';
import { StationState } from './state.js';
import { AuditLog, auditPath, replayClaims } from './audit.js';
import { RelayTcpServer } from './tcp.js';
import { StatusServer } from './status.js';
import { resolveEvent } from './resolve.js';
import { RelayBeacon } from './beacon.js';
import { StationTelemetry } from './telemetry.js';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEACON_PORT, BEACON_INTERVAL_MS } from '../generated/wire.js';

async function main(): Promise<void> {
  const configPath = process.env.CONFIG;
  if (!configPath) {
    throw new Error('CONFIG environment variable not set (path to config.json)');
  }
  const config = loadConfig(configPath);

  const startgg = new StartggClient({ endpoint: config.startggEndpoint, token: config.token });
  const ev = await resolveEvent(startgg, config); // fail fast: unknown short URL / event / stream dies here
  console.log(
    `resolved "${config.tournament}" by ${ev.foundBy}: ${ev.tournamentName} (${ev.tournamentSlug}), ` +
      `event "${ev.eventName}" ${ev.eventId}, stream "${ev.streamName}" ${ev.streamId}`,
  );

  const audit = new AuditLog(auditPath(config.auditDir, ev.eventId));
  const cache = new SetCache(startgg, ev.eventId, (e) =>
    audit.record({ type: 'refresh_error', error: String(e) }),
  );
  await cache.refresh(); // fail fast: bad token / event id dies here

  const state = new StationState();
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
    startgg,
    audit,
    streamStation: config.streamStation,
    streamId: ev.streamId,
    secret: config.secret,
  });
  await tcp.listen(config.tcpPort);
  // Stations find the relay from this broadcast (design R15); started only
  // once TCP is listening, so a station never learns an address that refuses.
  const beacon = new RelayBeacon({ tcpPort: config.tcpPort, eventId: ev.eventId });
  await beacon.start();
  // Each Wii's own boot report (kernel log + module status). Lines are also
  // appended to <auditDir>/wii-station-N.log so a boot can be read after the fact.
  const telemetry = new StationTelemetry({
    secret: config.secret,
    beaconPayload: beacon.beaconPayload,
    onLine: (station, line) => {
      try {
        appendFileSync(join(config.auditDir, `wii-station-${station}.log`), `${new Date().toISOString()} ${line}\n`);
      } catch (e) {
        console.error(`wii log write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
  await telemetry.start();
  const status = new StatusServer({
    state,
    cache,
    startgg,
    streamStation: config.streamStation,
    eventLabel: `${ev.tournamentName} · ${ev.eventName} (${ev.eventId})`,
    beacon,
    tcp,
    telemetry,
  });
  await status.listen(config.httpPort);

  audit.record({ type: 'startup', ...ev, sets: cache.status().count });
  console.log(
    `relay up: event ${ev.eventId}, ${cache.status().count} sets cached, ` +
      `tcp :${config.tcpPort}, status http://localhost:${config.httpPort}`,
  );
  console.log(`beacon: udp :${BEACON_PORT} to ${beacon.status().targets.join(', ') || '(no IPv4 interface yet)'} every ${BEACON_INTERVAL_MS} ms`);
  console.log(`telemetry: udp :${telemetry.address().port} (Wii kernel logs and module status)`);

  const shutdown = async (signal: string) => {
    console.log(`${signal}: shutting down`);
    cache.stop();
    await Promise.all([beacon.stop(), telemetry.stop(), tcp.close(), status.close()]);
    audit.record({ type: 'shutdown', signal });
    audit.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
