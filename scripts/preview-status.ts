// scripts/preview-status.ts -- a relay on fake data: the relay stack from
// test/harness.ts on the in-process fake start.gg, with three Wiis that have
// started sets (one with a score, one with a failed start.gg call) and
// telemetry from two consoles. Nothing touches the real start.gg.
//
//   npx tsx scripts/preview-status.ts [--port=29480]
//       the status page, for checking its layout in a browser (phone width,
//       light and dark)
//   npx tsx scripts/preview-status.ts --page=setup [--port=29480]
//       a relay that is not set up yet: the setup wizard, to walk through
//       with the printed setup code and the fake's token. Only the test
//       tournament has a bracket in the fake: paste its link
//       (start.gg/tournament/lazyto-test) to end up running; a listed weekly
//       saves, then fails to start with "event not found"
//   npx tsx scripts/preview-status.ts --page=failed [--port=29480]
//       a set-up relay whose event can't be found: the "Not running" page
//   npx tsx scripts/preview-status.ts --network [--secret=<s>]
//       also a real relay on the LAN (beacon, telemetry, TCP 29470) that a
//       development Dolphin can find and play against; Dolphin's
//       SlippiRelaySecret must match --secret (default: the test secret)
//   --wii=<dir> (any of the above)
//       a bundle's wii/ folder (unpacked lazyto.tgz), so the SD cards page
//       serves real zips; without it, the page says there are no Wii files
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryKind, ModuleState } from '../generated/wire.js';
import { App } from '../src/app.js';
import { configPath, saveConfig } from '../src/config.js';
import {
  defaultFixture,
  entrant,
  makeFake,
  FIXTURE_TOKEN,
  type FakeSet,
} from '../test/fake-startgg.js';
import { game } from '../test/wii-client.js';
import { telemetryDatagram, statusPayload } from '../test/telemetry-helpers.js';
import { harnessConfig, startHarness, TEST_PASSWORD } from '../test/harness.js';

const args = process.argv.join(' ');
const port = Number(/--port=(\d+)/.exec(args)?.[1] ?? 29480);
const network = process.argv.includes('--network');
const secret = /--secret=(\S+)/.exec(args)?.[1];
const wiiDir = /--wii=(\S+)/.exec(args)?.[1];
const pageKind = /--page=(\w+)/.exec(args)?.[1] ?? 'running';
if (!['running', 'setup', 'failed'].includes(pageKind)) {
  console.error(`preview-status: --page is running, setup or failed, not ${pageKind}`);
  process.exit(2);
}

const sets: FakeSet[] = defaultFixture();
for (let i = 0; i < 6; i++) {
  sets.push({
    id: 107960000 + i,
    state: 1,
    round: -1,
    fullRoundText: 'Losers Round 1',
    totalGames: 5,
    slots: [entrant(9 + i), entrant(10 + i)],
    games: [],
    stream: null,
  });
}

if (pageKind !== 'running') {
  const fake = makeFake(sets);
  await fake.start();
  const dataDir = mkdtempSync(join(tmpdir(), 'lazyto-preview-'));
  // An event name the test tournament doesn't have: the start fails and stays failed.
  if (pageKind === 'failed') {
    saveConfig(configPath(dataDir), { ...harnessConfig(), eventName: 'Doubles' });
  }
  const app = new App({
    dataDir,
    httpPort: port,
    tcpPort: 0,
    host: '127.0.0.1',
    startggEndpoint: fake.url,
    startggOptions: { retryDelaysMs: [0, 0] },
    retryDelaysMs: [120_000],
    clockSynced: () => true,
    wiiDir,
  });
  await app.start();
  const url = `http://127.0.0.1:${app.web.address().port}`;
  if (pageKind === 'setup') {
    console.log(
      `setup preview: ${url}/setup  (setup code: ${app.setupCode()}, token: ${FIXTURE_TOKEN})`,
    );
  } else {
    console.log(`failed preview: ${url}/  (settings password: ${TEST_PASSWORD})`);
  }
} else {
  const h = await startHarness({
    sets,
    setFormat: 'top8q',
    statusPort: port,
    network,
    tcpPort: network ? 29470 : 0,
    secret,
    wiiDir,
  });

  await h.wii(1, 1).startSet(107949994, 1);
  await h.wii(1, 1).reportScore(107949994, [game(1), game(2)]);
  await h.wii(2).startSet(107949995);
  h.fake.failNext('reportBracketSet', 'gqlError', 1, 'Set is already completed');
  await h.wii(2).reportScore(107949995, [game(1)]);
  await h.wii(3).startSet(107949996);
  for (const [station, from] of [
    [1, '192.168.1.81'],
    [2, '192.168.1.82'],
  ] as const) {
    h.ev.telemetry.receive(
      telemetryDatagram(
        TelemetryKind.TM_LOG,
        station,
        0,
        'Patch:Game ID = 47414c45\nTMOD:loaded at 817f38a4\nrelay: beacon from 192.168.1.252\n',
      ),
      from,
    );
    h.ev.telemetry.receive(
      telemetryDatagram(
        TelemetryKind.TM_STATUS,
        station,
        1,
        statusPayload({ module_state: ModuleState.MOD_LOADED }),
      ),
      from,
    );
  }
  console.log(`status preview: ${h.statusUrl}/  (TO password: ${TEST_PASSWORD})`);
  if (network) {
    console.log(`relay on the LAN: tcp :29470, beacon and telemetry on (Ctrl+C stops it)`);
  }
}
