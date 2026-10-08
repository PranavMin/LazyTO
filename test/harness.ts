// harness.ts -- the relay as a Pi runs it (src/app.ts: settings file ->
// resolve -> relay.ts startEvent -> web server), against the in-process fake
// start.gg. By default on ephemeral localhost ports without the LAN beacon or
// the telemetry port; `network: true` serves it like a real relay (beacon,
// telemetry, TCP on all interfaces) so a development Dolphin can play against
// fake data. One place for the tests, the load test and the status-page
// preview to build it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.js';
import type { RelayGuard } from '../src/guard.js';
import { configPath, saveConfig, type Config } from '../src/config.js';
import type { RunningEvent } from '../src/relay.js';
import type { StartggClient } from '../src/startgg.js';
import type { StatusView } from '../src/status.js';
import type { SetFormat } from '../src/format.js';
import type { Platform } from '../src/platform.js';
import {
  makeFake,
  FakeStartgg,
  FIXTURE_EVENT_NAME,
  FIXTURE_STREAM_NAME,
  FIXTURE_TOKEN,
  FIXTURE_TOURNAMENT,
  type FakeSet,
} from './fake-startgg.js';
import { WiiClient, TEST_SECRET } from './wii-client.js';

export const STREAM_STATION = 1;
export const TEST_PASSWORD = 'to-pass-9876';

export interface HarnessOptions {
  sets?: FakeSet[];
  /** Reuse a running fake (not closed by this harness), e.g. to restart the relay on it. */
  fake?: FakeStartgg;
  /** Reuse a data dir (not removed by this harness): the audit log survives a restart. */
  dataDir?: string;
  setFormat?: SetFormat;
  limits?: { capacity: number; refillPerMinute: number; maxWaitMs: number };
  statusPort?: number;
  /** Beacon, telemetry and TCP on all interfaces, like a real relay. */
  network?: boolean;
  tcpPort?: number;
  secret?: string;
  /** false: no stream tonight. Default: station STREAM_STATION streams to the fixture's stream. */
  stream?: false;
  /** The bundle's wii/ folder, for the SD-card zips. */
  wiiDir?: string;
  /** The archive folder; default <dataDir>/archive, never the real Documents/LazyTO. */
  archiveDir?: string;
  /** A stand-in free-disk figure for the archive's disk. */
  freeBytes?: () => number;
  /** The one-relay-per-network guard (guard.ts); none by default without the network side. */
  guard?: RelayGuard;
  /** The desktop app's view of the laptop (src/platform.ts); default none, as src/main.ts runs. */
  platform?: Platform;
  /** The settings' tournament and event name; default the fake's test tournament and its singles event. */
  tournament?: string;
  eventName?: string;
  /** The set archive's clock; default the real one. */
  archiveClock?: () => number;
}

export interface Harness {
  app: App;
  fake: FakeStartgg;
  startgg: StartggClient;
  ev: RunningEvent;
  view: StatusView;
  statusUrl: string;
  dataDir: string;
  /** A Wii at this station, behind a beamer at `beamer` (default 127.0.0.1); stream is what it puts in start_set_req.stream. */
  wii(station: number, stream?: 0 | 1, beamer?: string): WiiClient;
  /** The relay's TCP port, where beamers sync. */
  tcpPort: number;
  /** Every audit record written so far, oldest first. */
  auditEvents(): Record<string, unknown>[];
  close(): Promise<void>;
}

/** The settings the harness writes: the fake's test tournament, its stream, the test secret. */
export function harnessConfig(opts: HarnessOptions = {}): Config {
  return {
    token: FIXTURE_TOKEN,
    tournament: opts.tournament ?? FIXTURE_TOURNAMENT,
    eventName: opts.eventName ?? FIXTURE_EVENT_NAME,
    secret: opts.secret ?? TEST_SECRET,
    adminPassword: TEST_PASSWORD,
    weeklyNamePrefix: '',
    streamName: opts.stream === false ? '' : FIXTURE_STREAM_NAME,
    streamStation: STREAM_STATION,
    setFormat: opts.setFormat ?? 'startgg',
    archiveDir: '',
  };
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const ownFake = opts.fake === undefined;
  const fake = opts.fake ?? makeFake(opts.sets);
  if (ownFake) await fake.start();
  const ownDir = opts.dataDir === undefined;
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'lazyto-test-'));
  mkdirSync(dataDir, { recursive: true });
  saveConfig(configPath(dataDir), harnessConfig(opts));

  const app = new App({
    dataDir,
    httpPort: opts.statusPort ?? 0,
    tcpPort: opts.tcpPort ?? 0,
    host: opts.network ? '0.0.0.0' : '127.0.0.1',
    network: opts.network ?? false,
    startggEndpoint: fake.url,
    startggOptions: { retryDelaysMs: [0, 0], limits: opts.limits },
    clockSynced: () => true,
    wiiDir: opts.wiiDir,
    archiveDir: opts.archiveDir ?? join(dataDir, 'archive'),
    rawStore: opts.freeBytes ? { freeBytes: opts.freeBytes } : undefined,
    stallMs: 2000,
    guard: opts.guard,
    platform: opts.platform,
    archiveClock: opts.archiveClock,
  });
  await app.start();
  const m = app.current();
  if (m.kind !== 'running') {
    await app.stop();
    throw new Error(`harness: the relay did not start: ${JSON.stringify(m)}`);
  }
  const port = m.ev.tcp.address().port;
  const secret = opts.secret ?? TEST_SECRET;

  return {
    app,
    fake,
    startgg: m.view.startgg,
    ev: m.ev,
    view: m.view,
    statusUrl: `http://127.0.0.1:${app.web.address().port}`,
    dataDir,
    wii: (station, stream = 0, beamer) =>
      new WiiClient(port, station, stream, '127.0.0.1', secret, beamer),
    tcpPort: port,
    auditEvents: () =>
      readFileSync(m.ev.audit.path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    close: async () => {
      await app.stop();
      if (ownFake) await fake.close();
      if (ownDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
