// main.ts -- process entry point (architecture.md (Relay, Deployment)). Reads the
// config path from the CONFIG environment variable (the systemd unit sets
// it), validates everything, resolves the configured tournament short URL,
// event name and stream name to tonight's ids (resolve.ts), starts the
// night's relay (relay.ts: one cache refresh, so a bad token, a short URL
// nobody moved yet or an ambiguous event name kills the process before a Wii
// ever connects; audit replay; TCP, beacon, telemetry), then the status page.

import { loadConfig } from './config.js';
import { StartggClient } from './startgg.js';
import { StatusServer } from './status.js';
import { resolveEvent } from './resolve.js';
import { startEvent } from './relay.js';
import { BEACON_PORT, BEACON_INTERVAL_MS } from '../generated/wire.js';

async function main(): Promise<void> {
  const configPath = process.env.CONFIG;
  if (!configPath) {
    throw new Error('CONFIG environment variable not set (path to config.json)');
  }
  const config = loadConfig(configPath);

  const startgg = new StartggClient({ endpoint: config.startggEndpoint, token: config.token });
  const resolved = await resolveEvent(startgg, config); // fail fast: unknown short URL / event / stream dies here
  console.log(
    `resolved "${config.tournament}" by ${resolved.foundBy}: ${resolved.tournamentName} (${resolved.tournamentSlug}), ` +
      `event "${resolved.eventName}" ${resolved.eventId}, ` +
      (resolved.streamId === null
        ? 'no stream'
        : `stream "${resolved.streamName}" ${resolved.streamId} on station ${config.streamStation}`),
  );

  const ev = await startEvent({
    startgg,
    eventId: resolved.eventId,
    setFormat: config.setFormat,
    secret: config.secret,
    stream:
      resolved.streamId === null
        ? null
        : { station: config.streamStation, streamId: resolved.streamId },
    dataDir: config.auditDir,
    tcpPort: config.tcpPort,
  });
  const beacon = ev.beacon!; // started with the network side on
  const status = new StatusServer({
    state: ev.state,
    cache: ev.cache,
    startgg,
    streamStation: resolved.streamId === null ? null : config.streamStation,
    eventLabel: `${resolved.tournamentName} · ${resolved.eventName} (${resolved.eventId})`,
    beacon,
    tcp: ev.tcp,
    telemetry: ev.telemetry,
    admin: { actions: ev.admin, password: config.adminPassword },
  });
  await status.listen(config.httpPort);

  ev.audit.record({ type: 'startup', ...resolved, sets: ev.cache.status().count });
  console.log(
    `relay up: event ${resolved.eventId}, ${ev.cache.status().count} sets cached, ` +
      `tcp :${config.tcpPort}, status http://localhost:${config.httpPort}`,
  );
  console.log(
    `beacon: udp :${BEACON_PORT} to ${beacon.status().targets.join(', ') || '(no IPv4 interface yet)'} every ${BEACON_INTERVAL_MS} ms`,
  );
  console.log(`telemetry: udp :${ev.telemetry.address().port} (Wii kernel logs and module status)`);

  const shutdown = async (signal: string) => {
    console.log(`${signal}: shutting down`);
    ev.audit.record({ type: 'shutdown', signal });
    await Promise.all([ev.stop(), status.close()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
