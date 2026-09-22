// serve-fake.ts -- run test/fake-startgg.ts as a standalone process so the
// BUILT relay (`node dist/main.js`) can be rehearsed end to end on a dev
// machine without the real API (CLAUDE.md: tests never touch start.gg).
//
//   npm run fake -- --port=18080
//
// serves the load-test fixture (400 pending Bo3 sets) on
// http://127.0.0.1:18080/gql/alpha with token "test-token" and event id
// 1613010; point a config.json's startggEndpoint/token/eventId at those,
// start the relay, then `npm run sim -- --relay=127.0.0.1:<tcpPort>`.
//
// Prints the upstream call rate every 30 s and a summary (total calls, peak
// calls in any 60 s window -- the N2 number) on SIGINT/SIGTERM.

import { FakeStartgg, FIXTURE_TOKEN, FIXTURE_EVENT_ID, loadFixture, peakPerMinute } from '../test/fake-startgg.js';

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg?.slice('--port='.length));
if (!portArg || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('usage: npm run fake -- --port=<1..65535>');
  process.exit(1);
}

const fake = new FakeStartgg(FIXTURE_TOKEN, FIXTURE_EVENT_ID, loadFixture(400));
const startedAt = Date.now();

function summary(): void {
  const times = fake.calls.map((c) => c.at);
  const last60 = times.filter((t) => t > Date.now() - 60_000).length;
  console.log(
    `serve-fake t+${Math.round((Date.now() - startedAt) / 1000)}s: ` +
      `${times.length} upstream calls total, ${last60} last 60s, peak ${peakPerMinute(times)}/min`,
  );
}

async function main(): Promise<void> {
  await fake.start(PORT);
  console.log(`serve-fake: ${fake.url}  token=${FIXTURE_TOKEN}  eventId=${FIXTURE_EVENT_ID}  sets=${fake.sets.length}`);
  const ticker = setInterval(summary, 30_000);
  const stop = async (signal: string) => {
    clearInterval(ticker);
    console.log(`${signal}: final`);
    summary();
    await fake.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
