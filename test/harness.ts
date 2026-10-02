// harness.ts -- the relay as main.ts runs it (src/relay.ts startEvent plus
// the status page), against the in-process fake start.gg. By default on
// ephemeral localhost ports without the LAN beacon or the telemetry port;
// `network: true` serves it like a real relay (beacon, telemetry, TCP on all
// interfaces) so a development Dolphin can play against fake data. One place
// for the tests, the load test and the status-page preview to build it.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEvent, type RunningEvent } from '../src/relay.js';
import { StartggClient } from '../src/startgg.js';
import { StatusServer } from '../src/status.js';
import type { SetFormat } from '../src/format.js';
import {
  makeFake,
  FakeStartgg,
  FIXTURE_EVENT_ID,
  FIXTURE_STREAM_ID,
  FIXTURE_TOKEN,
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
  eventLabel?: string;
  /** Beacon, telemetry and TCP on all interfaces, like a real relay. */
  network?: boolean;
  tcpPort?: number;
  secret?: string;
}

export interface Harness {
  fake: FakeStartgg;
  startgg: StartggClient;
  ev: RunningEvent;
  status: StatusServer;
  statusUrl: string;
  dataDir: string;
  /** A Wii at this station (stream=1 when it is the stream setup). */
  wii(station: number, stream?: 0 | 1): WiiClient;
  /** Every audit record written so far, oldest first. */
  auditEvents(): Record<string, unknown>[];
  close(): Promise<void>;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const ownFake = opts.fake === undefined;
  const fake = opts.fake ?? makeFake(opts.sets);
  if (ownFake) await fake.start();
  const ownDir = opts.dataDir === undefined;
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'lazyto-test-'));

  const startgg = new StartggClient({
    endpoint: fake.url,
    token: FIXTURE_TOKEN,
    retryDelaysMs: [0, 0],
    limits: opts.limits,
  });
  const ev = await startEvent({
    startgg,
    eventId: FIXTURE_EVENT_ID,
    setFormat: opts.setFormat ?? 'startgg',
    secret: opts.secret ?? TEST_SECRET,
    streamStation: STREAM_STATION,
    streamId: FIXTURE_STREAM_ID,
    dataDir,
    tcpPort: opts.tcpPort ?? 0,
    host: opts.network ? '0.0.0.0' : '127.0.0.1',
    network: opts.network ?? false,
  });
  const status = new StatusServer({
    state: ev.state,
    cache: ev.cache,
    startgg,
    streamStation: STREAM_STATION,
    eventLabel:
      opts.eventLabel ??
      `LazyTO Test Tournament · Melee Singles! (7:30 Start) (${FIXTURE_EVENT_ID})`,
    beacon: ev.beacon ?? {
      status: () => ({
        targets: ['192.168.1.255'],
        sent: 1,
        lastSentAt: Date.now(),
        lastError: null,
      }),
    },
    tcp: ev.tcp,
    telemetry: ev.telemetry,
    admin: { actions: ev.admin, password: TEST_PASSWORD },
  });
  await status.listen(opts.statusPort ?? 0, '127.0.0.1');
  const port = ev.tcp.address().port;

  return {
    fake,
    startgg,
    ev,
    status,
    statusUrl: `http://127.0.0.1:${status.address().port}`,
    dataDir,
    wii: (station, stream = 0) =>
      new WiiClient(port, station, stream, '127.0.0.1', opts.secret ?? TEST_SECRET),
    auditEvents: () =>
      readFileSync(ev.audit.path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    close: async () => {
      await Promise.all([ev.stop(), status.close()]);
      if (ownFake) await fake.close();
      if (ownDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
