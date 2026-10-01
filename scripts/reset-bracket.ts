// scripts/reset-bracket.ts -- put the TEST tournament's bracket back to the
// start: reset every set that has been started or completed, latest rounds
// first, so the event can be played through again on the kiosk.
//
// Touches only the event in .env (EVENT_ID, the test tournament; see
// CLAUDE.md: the live API is for scripts/ only). Read-only by default: lists
// every set with its state. Pass --yes to reset.
//
// Run: npx tsx scripts/reset-bracket.ts          (list)
//      npx tsx scripts/reset-bracket.ts --yes    (reset)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENDPOINT = "https://api.start.gg/gql/alpha";
const STATE_NAMES: Record<number, string> = { 1: "not started", 2: "in progress", 3: "completed", 4: "ready", 5: "invalid", 6: "called", 7: "queued" };

function fail(msg: string): never {
  console.error(`reset-bracket: ${msg}`);
  process.exit(1);
}

function loadEnv(): Record<string, string> {
  const path = resolve(import.meta.dirname, "..", ".env");
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  for (const key of ["STARTGG_TOKEN", "EVENT_ID"]) if (!env[key]) fail(`missing ${key} in .env`);
  return env;
}

const env = loadEnv();
const yes = process.argv.includes("--yes");

async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.STARTGG_TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) {
    throw new Error(`start.gg ${res.status}: ${JSON.stringify(json?.errors ?? json)}`);
  }
  return json.data;
}

interface SetRow { id: number; state: number; round: number; roundText: string; names: string }

async function listSets(): Promise<{ eventName: string; sets: SetRow[] }> {
  const sets: SetRow[] = [];
  let eventName = "";
  for (let page = 1; ; page++) {
    const d = await gql(
      `query Sets($id: ID!, $page: Int!) {
         event(id: $id) { name
           sets(page: $page, perPage: 50, sortType: ROUND) {
             pageInfo { totalPages }
             nodes { id state round fullRoundText slots { entrant { name } } } } } }`,
      { id: env.EVENT_ID, page },
    );
    if (!d.event) fail(`event ${env.EVENT_ID} not found`);
    eventName = d.event.name;
    for (const n of d.event.sets.nodes) {
      const names = n.slots.map((s: any) => s.entrant?.name ?? "?").join(" vs ");
      sets.push({ id: Number(n.id), state: n.state, round: n.round, roundText: n.fullRoundText, names });
    }
    if (page >= d.event.sets.pageInfo.totalPages) break;
  }
  return { eventName, sets };
}

function print(eventName: string, sets: SetRow[]): void {
  console.log(`${eventName}: ${sets.length} sets`);
  for (const s of sets) {
    console.log(`  ${String(s.id).padEnd(10)} ${(STATE_NAMES[s.state] ?? `state ${s.state}`).padEnd(12)} ${s.roundText.padEnd(24)} ${s.names}`);
  }
}

async function main(): Promise<void> {
  const { eventName, sets } = await listSets();
  print(eventName, sets);
  const touched = sets.filter((s) => s.state !== 1);
  if (touched.length === 0) {
    console.log("nothing to reset: every set is not started");
    return;
  }
  if (!yes) {
    console.log(`\n${touched.length} set(s) would be reset; run again with --yes`);
    return;
  }
  // Latest rounds first (|round| descending): a completed set's dependents go first.
  touched.sort((a, b) => Math.abs(b.round) - Math.abs(a.round));
  for (const s of touched) {
    try {
      await gql(`mutation Reset($setId: ID!) { resetSet(setId: $setId, resetDependentSets: true) { id state } }`, { setId: s.id });
      console.log(`reset ${s.id} ${s.roundText} ${s.names}`);
    } catch (e) {
      console.log(`reset ${s.id} ${s.roundText}: ${e instanceof Error ? e.message : String(e)} (continuing)`);
    }
  }
  const after = await listSets();
  console.log("");
  print(after.eventName, after.sets);
  const left = after.sets.filter((s) => s.state !== 1);
  if (left.length) fail(`${left.length} set(s) still not reset`);
  console.log("\nbracket is back to the start. Restart the relay with a fresh audit log so it forgets the old station claims.");
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
