// main.ts -- process entry point (architecture.md (Relay, Deployment)). Starts
// the relay app (app.ts): the web server first, then tonight's event from the
// settings in the data directory -- or the setup page if there are none yet.
// Exits non-zero only if the web server can't start (port 29473 taken).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { App } from './app.js';
import { DATA_DIR, HTTP_PORT, TCP_PORT, defaultArchiveDir } from './config.js';

/**
 * The root of the release bundle (/opt/lazyto), two levels above the built
 * dist/src/main.js; null when run from source, which has no bundle.
 */
const BUNDLE = import.meta.filename.endsWith('.js')
  ? resolve(import.meta.dirname, '..', '..')
  : null;

/** The bundle's VERSION; "dev" from source. */
function version(): string {
  if (BUNDLE === null) return 'dev';
  try {
    return readFileSync(join(BUNDLE, 'VERSION'), 'utf8').trim() || 'dev';
  } catch {
    return 'dev';
  }
}

async function main(): Promise<void> {
  const app = new App({
    dataDir: DATA_DIR,
    archiveDir: defaultArchiveDir(),
    httpPort: HTTP_PORT,
    tcpPort: TCP_PORT,
    version: version(),
    wiiDir: BUNDLE === null ? undefined : join(BUNDLE, 'wii'),
  });
  await app.start();

  const shutdown = async (signal: string) => {
    console.log(`${signal}: shutting down`);
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
