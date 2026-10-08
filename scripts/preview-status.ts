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
//   --entrants=<file.json> (with --network)
//       only Winners Round 1 sets between the entrants in the file, in seed
//       order (1 vs N, 2 vs N-1, ...): a long list of real-looking tags for a
//       set-list soak run. The file is probe.ts --entrants output (private
//       tools) or any {"entrants": [{"name": "..."}]}; no Wii starts a set
//   --wii=<dir> (any of the above)
//       a bundle's wii/ folder (unpacked lazyto.tgz), so the SD cards page
//       serves real zips; without it, the page says there are no Wii files
//   --laptop (any of the above)
//       as the desktop app runs it (src/platform.ts): a Windows Firewall note
//       with its "Allow" button (which only says it was pressed), "LazyTO
//       v99.0.0 is out", no update channel on the settings page, and the
//       archive folder default Documents/LazyTO
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryKind, ModuleState } from '../generated/wire.js';
import { App } from '../src/app.js';
import { configPath, saveConfig } from '../src/config.js';
import type { Platform } from '../src/platform.js';
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
const entrantsFile = /--entrants=(\S+)/.exec(args)?.[1];
if (!['running', 'setup', 'failed'].includes(pageKind)) {
  console.error(`preview-status: --page is running, setup or failed, not ${pageKind}`);
  process.exit(2);
}

/** --laptop: what the desktop app (desktop/platform.ts) would report on a blocked Windows laptop. */
const laptop: { platform?: Platform; archiveDir?: string } = process.argv.includes('--laptop')
  ? {
      platform: {
        notes: () => [
          {
            text: 'Windows Firewall blocks LazyTO on "Venue router" (Public): the beamers can\'t reach this laptop.',
            action: { name: 'firewall', label: 'Allow LazyTO through the firewall' },
          },
        ],
        latest: () => ({
          version: '99.0.0',
          url: 'https://github.com/PranavMin/LazyTO/releases/tag/v99.0.0',
        }),
        act: async (name) => ({
          ok: true,
          msg: `preview: "${name}" pressed; nothing was changed.`,
        }),
      },
      archiveDir: join(homedir(), 'Documents', 'LazyTO'),
    }
  : {};

let sets: FakeSet[] = defaultFixture();
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

if (entrantsFile) {
  const list: { name: string; participants?: { gamerTag: string | null }[] }[] = JSON.parse(
    readFileSync(entrantsFile, 'utf8'),
  ).entrants;
  sets = [];
  for (let i = 0; i < Math.floor(list.length / 2); i++) {
    const a = list[i]!;
    const b = list[list.length - 1 - i]!;
    sets.push({
      id: 108000000 + i,
      state: 1,
      round: 1,
      fullRoundText: 'Winners Round 1',
      totalGames: 3,
      slots: [
        { id: 20000 + i, name: a.name, participants: a.participants },
        { id: 30000 + i, name: b.name, participants: b.participants },
      ],
      games: [],
      stream: null,
    });
  }
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
    ...laptop,
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
    ...laptop,
  });

  if (!entrantsFile) await startDemoSets(h);
  console.log(`status preview: ${h.statusUrl}/  (TO password: ${TEST_PASSWORD})`);
  if (network) {
    console.log(`relay on the LAN: tcp :29470, beacon and telemetry on (Ctrl+C stops it)`);
  }
}

async function startDemoSets(h: Awaited<ReturnType<typeof startHarness>>): Promise<void> {
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
}
