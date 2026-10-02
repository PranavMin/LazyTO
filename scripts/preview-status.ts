// scripts/preview-status.ts -- a relay on fake data: the relay stack from
// test/harness.ts on the in-process fake start.gg, with three Wiis that have
// started sets (one with a score, one with a failed start.gg call) and
// telemetry from two consoles. Nothing touches the real start.gg.
//
//   npx tsx scripts/preview-status.ts [--port=29480]
//       the status page, for checking its layout in a browser (phone width,
//       light and dark)
//   npx tsx scripts/preview-status.ts --network [--secret=<s>]
//       also a real relay on the LAN (beacon, telemetry, TCP 29470) that a
//       development Dolphin can find and play against; Dolphin's
//       SlippiRelaySecret must match --secret (default: the test secret)
import { TelemetryKind, ModuleState } from '../generated/wire.js';
import { defaultFixture, entrant, type FakeSet } from '../test/fake-startgg.js';
import { game } from '../test/wii-client.js';
import { telemetryDatagram, statusPayload } from '../test/telemetry-helpers.js';
import { startHarness, TEST_PASSWORD } from '../test/harness.js';

const args = process.argv.join(' ');
const port = Number(/--port=(\d+)/.exec(args)?.[1] ?? 29480);
const network = process.argv.includes('--network');
const secret = /--secret=(\S+)/.exec(args)?.[1];

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
const h = await startHarness({
  sets,
  setFormat: 'top8q',
  statusPort: port,
  network,
  tcpPort: network ? 29470 : 0,
  secret,
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
if (network) console.log(`relay on the LAN: tcp :29470, beacon and telemetry on (Ctrl+C stops it)`);
