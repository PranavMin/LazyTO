// scripts/preview-status.ts -- the status page with fake data, for checking
// its layout in a browser (a phone-width window, light and dark). Nothing
// touches start.gg: an in-process fake (test/fake-startgg.ts), three Wiis
// that start sets, one with a score, one failed start.gg call, telemetry
// from two consoles. TO password: preview-pass.
//
//   npx tsx scripts/preview-status.ts [--port=29480]
import { SetCache } from '../src/cache.js';
import { StationState } from '../src/state.js';
import { StartggClient } from '../src/startgg.js';
import { RelayTcpServer } from '../src/tcp.js';
import { StatusServer } from '../src/status.js';
import { Admin } from '../src/admin.js';
import { StationTelemetry } from '../src/telemetry.js';
import { TelemetryKind, ModuleState } from '../generated/wire.js';
import { makeFake, FIXTURE_TOKEN, FIXTURE_EVENT_ID, type FakeSet } from '../test/fake-startgg.js';
import { WiiClient, game, TEST_SECRET } from '../test/wii-client.js';
import { telemetryDatagram, statusPayload } from '../test/telemetry.test.js';
import { entrant, defaultFixture } from '../test/fake-startgg.js';

const port = Number(/--port=(\d+)/.exec(process.argv.join(' '))?.[1] ?? 29480);

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
const fake = makeFake(sets);
await fake.start();
const startgg = new StartggClient({ endpoint: fake.url, token: FIXTURE_TOKEN });
const cache = new SetCache(startgg, FIXTURE_EVENT_ID, 'top8q');
await cache.refresh();
const state = new StationState();
const audit = { record() {} };
const tcp = new RelayTcpServer({
  cache,
  state,
  startgg,
  audit,
  streamStation: 1,
  streamId: 1358079,
  secret: TEST_SECRET,
});
await tcp.listen(0, '127.0.0.1');
const telemetry = new StationTelemetry({ secret: TEST_SECRET });
const status = new StatusServer({
  state,
  cache,
  startgg,
  streamStation: 1,
  eventLabel: `LazyTO Test Tournament · Melee Singles! (7:30 Start) (${FIXTURE_EVENT_ID})`,
  beacon: {
    status: () => ({
      targets: ['192.168.1.255'],
      sent: 1,
      lastSentAt: Date.now(),
      lastError: null,
    }),
  },
  tcp,
  telemetry,
  admin: { actions: new Admin({ state, cache, startgg, audit }), password: 'preview-pass' },
});
await status.listen(port, '127.0.0.1');

const wii = (n: number, stream: 0 | 1 = 0) => new WiiClient(tcp.address().port, n, stream);
await wii(1, 1).startSet(107949994, 1);
await wii(1, 1).reportScore(107949994, [game(1), game(2)]);
await wii(2).startSet(107949995);
fake.failNext('reportBracketSet', 'gqlError', 1, 'Set is already completed');
await wii(2).reportScore(107949995, [game(1)]);
await wii(3).startSet(107949996);
for (const [station, from] of [
  [1, '192.168.1.81'],
  [2, '192.168.1.82'],
] as const) {
  telemetry.receive(
    telemetryDatagram(
      TelemetryKind.TM_LOG,
      station,
      0,
      'Patch:Game ID = 47414c45\nTMOD:loaded at 817f38a4\nrelay: beacon from 192.168.1.252\n',
    ),
    from,
  );
  telemetry.receive(
    telemetryDatagram(
      TelemetryKind.TM_STATUS,
      station,
      1,
      statusPayload({ module_state: ModuleState.MOD_LOADED }),
    ),
    from,
  );
}
console.log(`status preview: http://127.0.0.1:${port}/  (TO password: preview-pass)`);
