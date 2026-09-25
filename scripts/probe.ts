// scripts/probe.ts — live start.gg probe for design.md §11 R1 (assignStream
// semantics) and R2 (reportBracketSet with gameData but no winnerId).
//
// Touches ONLY the test tournament configured in .env (see CLAUDE.md: the real
// API is touched only by this script). Mutates TEST_SET_ID and resets it at the
// end; on a mid-run failure it attempts a cleanup resetSet before exiting.
//
// Run: node scripts/probe.ts
//      node scripts/probe.ts --stages | --tournament=<slug> | --mine | --resolve=<short URL> | --find-short=<short URL>   (read-only)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StartggClient } from "../src/startgg.js";
import { resolveEvent } from "../src/resolve.js";

const ENDPOINT = "https://api.start.gg/gql/alpha";
const NEEDED_MUTATIONS = ["markSetInProgress", "assignStream", "reportBracketSet", "resetSet"];

class ProbeError extends Error {}

function fail(msg: string): never {
  console.error(`probe: ${msg}`);
  process.exit(1);
}

function loadEnv(): Record<string, string> {
  const path = resolve(import.meta.dirname, "..", ".env");
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  for (const key of ["STARTGG_TOKEN", "STREAM_ID", "TEST_SET_ID"]) {
    if (!env[key]) fail(`missing ${key} in .env`);
  }
  return env;
}

const env = loadEnv();
const SET_ID = env.TEST_SET_ID;
const STREAM_ID = env.STREAM_ID;

async function gql(label: string, query: string, variables: Record<string, unknown>, printRaw = true): Promise<any> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.STARTGG_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* handled below */
  }
  const failed = !res.ok || json === null || json.errors;
  if (printRaw || failed) {
    console.log(`\n=== ${label} ===`);
    console.log(`--- variables: ${JSON.stringify(variables)}`);
    console.log(`--- HTTP ${res.status}, raw response:`);
    console.log(text);
  }
  if (failed) {
    throw new ProbeError(`${label} failed (HTTP ${res.status}${json?.errors ? ", GraphQL errors in raw response above" : ""})`);
  }
  return json.data;
}

// --- schema check: never guess at mutation names -----------------------------

type IntroType = { kind: string; name: string | null; ofType: IntroType | null };

function typeName(t: IntroType | null): string {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return `${typeName(t.ofType)}!`;
  if (t.kind === "LIST") return `[${typeName(t.ofType)}]`;
  return t.name ?? "?";
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]++;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

async function checkMutations(): Promise<void> {
  // Raw introspection output is thousands of lines, so this prints the needed
  // signatures (or closest candidates) instead of the raw response.
  const data = await gql(
    "introspect Mutation",
    `query MutationFields {
      __schema { mutationType { fields {
        name
        args { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
      } } }
    }`,
    {},
    false,
  );
  const fields: { name: string; args: { name: string; type: IntroType }[] }[] = data.__schema.mutationType.fields;
  const byName = new Map(fields.map((f) => [f.name, f]));

  console.log("\n=== schema check: required mutations ===");
  let missing = false;
  for (const wanted of NEEDED_MUTATIONS) {
    const f = byName.get(wanted);
    if (f) {
      const sig = f.args.map((a) => `${a.name}: ${typeName(a.type)}`).join(", ");
      console.log(`  ${wanted}(${sig})`);
    } else {
      missing = true;
      const candidates = fields
        .map((x) => ({ name: x.name, d: levenshtein(wanted.toLowerCase(), x.name.toLowerCase()) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 5)
        .map((x) => x.name);
      console.log(`  ${wanted}: NOT IN SCHEMA — closest candidates: ${candidates.join(", ")}`);
    }
  }
  if (missing) fail("required mutation(s) missing from schema; see candidates above");
}

// --- probe steps -------------------------------------------------------------

const SET_QUERY = `query SetProbe($setId: ID!) {
  set(id: $setId) {
    id
    state
    fullRoundText
    stream { id streamName streamSource }
    slots { id entrant { id name } }
    games { id orderNum winnerId }
  }
}`;

const REPORT_MUTATION = `mutation Report($setId: ID!, $gameData: [BracketSetGameDataInput]) {
  reportBracketSet(setId: $setId, gameData: $gameData) { id state }
}`;

async function resetSet(label: string): Promise<void> {
  await gql(label, `mutation Reset($setId: ID!) { resetSet(setId: $setId) { id state } }`, { setId: SET_ID });
}

// --- read-only lookups (no mutations) ---------------------------------------

// `node scripts/probe.ts --stages`: Melee's stage list with start.gg's ids, the
// source for src/stages.ts (design.md section 6.3). Read-only; touches no set.
async function listStages(): Promise<void> {
  const data = await gql(
    "videogame(id: 1) stages",
    `query MeleeStages { videogame(id: 1) { id name stages { id name } } }`,
    {},
    false,
  );
  const stages = (data.videogame?.stages ?? []) as { id: number; name: string }[];
  console.log(`\n${data.videogame?.name}: ${stages.length} stages`);
  for (const s of stages.slice().sort((a, b) => a.id - b.id)) {
    console.log(`  ${String(s.id).padStart(6)}  ${s.name}`);
  }
}

// `node scripts/probe.ts --tournament=<slug>`: what a tournament slug (full
// slug or short URL, e.g. "abbey") resolves to: its events with game and
// entrant type, and its streams. Read-only. Source for the relay's
// slug-based event discovery (design.md section 6.3).
async function showTournament(slug: string): Promise<void> {
  const data = await gql(
    `tournament(slug: ${slug})`,
    `query T($slug: String!) {
      tournament(slug: $slug) {
        id name slug shortSlug startAt state
        events { id name slug type state numEntrants videogame { id name } }
        streams { id streamName streamSource }
      }
    }`,
    { slug },
    false,
  );
  const t = data.tournament;
  if (!t) throw new ProbeError(`no tournament for slug "${slug}"`);
  const when = t.startAt ? new Date(t.startAt * 1000).toISOString() : "?";
  console.log(`
${t.name}  id=${t.id}  slug=${t.slug}  shortSlug=${t.shortSlug ?? "-"}  startAt=${when}  state=${t.state}`);
  console.log("events (type 1 = singles, 5 = teams):");
  for (const e of t.events ?? []) {
    console.log(`  ${String(e.id).padStart(8)}  type=${e.type}  state=${e.state}  game=${e.videogame?.id} ${e.videogame?.name}  entrants=${e.numEntrants}  "${e.name}"  ${e.slug}`);
  }
  console.log("streams:");
  for (const s of t.streams ?? []) console.log(`  ${String(s.id).padStart(8)}  ${s.streamSource}  ${s.streamName}`);
}

// `node scripts/probe.ts --mine`: tournaments the token's user administers,
// soonest first, with their short URL. Read-only. Shows whether a short URL
// such as "abbey" can be found without the API resolving it directly.
async function showMine(): Promise<void> {
  const schema = await gql(
    "UserTournamentsPaginationFilter fields",
    `query { __type(name: "UserTournamentsPaginationFilter") { inputFields { name type { name kind ofType { name } } } } }`,
    {},
    false,
  );
  console.log("\nUserTournamentsPaginationFilter: " + (schema.__type?.inputFields ?? []).map((f: any) => f.name).join(", "));
  const data = await gql(
    "currentUser tournaments (admin)",
    `query Mine {
      currentUser {
        id slug
        tournaments(query: { perPage: 15, filter: { tournamentView: "admin" } }) {
          nodes { id name slug shortSlug startAt state }
        }
      }
    }`,
    {},
    false,
  );
  const u = data.currentUser;
  console.log(`user ${u?.slug} (${u?.id}), admin tournaments:`);
  for (const t of u?.tournaments?.nodes ?? []) {
    const when = t.startAt ? new Date(t.startAt * 1000).toISOString().slice(0, 16) : "?";
    console.log(`  ${when}  state=${t.state}  short=${(t.shortSlug ?? "-").padEnd(12)}  ${t.slug}`);
  }
}

// `node scripts/probe.ts --resolve=<short URL>`: run the relay's own startup
// resolution (src/resolve.ts) against the real API with the relay's default
// names, exactly as the Pi will. Read-only.
async function showResolve(shortSlug: string): Promise<void> {
  const client = new StartggClient({ endpoint: ENDPOINT, token: env.STARTGG_TOKEN! });
  const r = await resolveEvent(client, { tournament: shortSlug, eventName: "Melee Singles", streamName: "SFMelee" });
  console.log(JSON.stringify(r, null, 2));
}

// `node scripts/probe.ts --find-short=<short URL>`: which list queries can see
// a short URL -- the admin list under each tournamentView, and the global
// tournaments() query with isCurrentUserAdmin. Read-only; for choosing how
// src/resolve.ts looks tournaments up.
async function findShort(short: string): Promise<void> {
  const tf = await gql(
    "TournamentPageFilter fields",
    `query { __type(name: "TournamentPageFilter") { inputFields { name } } }`,
    {},
    false,
  );
  console.log("\nTournamentPageFilter: " + (tf.__type?.inputFields ?? []).map((f: any) => f.name).join(", "));
  for (const view of ["admin", "competitor", "owner", "staff", null]) {
    const found: string[] = [];
    let seen = 0;
    for (let page = 1; page <= 10; page++) {
      const d = await gql(
        `currentUser tournaments view=${view} page ${page}`,
        `query M($page: Int!, $view: String) { currentUser { tournaments(query: { page: $page, perPage: 50, filter: { tournamentView: $view } }) {
          pageInfo { totalPages } nodes { slug shortSlug } } } }`,
        { page, view },
        false,
      );
      const tt = d.currentUser?.tournaments;
      if (!tt) break;
      seen += tt.nodes.length;
      for (const n of tt.nodes) if ((n.shortSlug ?? "").toLowerCase() === short.toLowerCase()) found.push(n.slug);
      if (page >= tt.pageInfo.totalPages) break;
    }
    console.log(`  currentUser.tournaments view=${view}: ${seen} seen, match: ${found.join(", ") || "none"}`);
  }
  const g = await gql(
    "tournaments(isCurrentUserAdmin)",
    `query G { tournaments(query: { perPage: 50, filter: { isCurrentUserAdmin: true } }) { pageInfo { total } nodes { slug shortSlug } } }`,
    {},
    false,
  ).catch((e) => { console.log(`  tournaments(isCurrentUserAdmin): ${e.message}`); return null; });
  if (g) {
    const hit = g.tournaments.nodes.filter((n: any) => (n.shortSlug ?? "").toLowerCase() === short.toLowerCase());
    console.log(`  tournaments(isCurrentUserAdmin) first page: total ${g.tournaments.pageInfo.total}, match: ${hit.map((n: any) => n.slug).join(", ") || "none"}`);
  }
}

async function main(): Promise<void> {
  const fArg = process.argv.find((a) => a.startsWith("--find-short="));
  if (fArg) {
    await findShort(fArg.slice("--find-short=".length));
    return;
  }
  const rArg = process.argv.find((a) => a.startsWith("--resolve="));
  if (rArg) {
    await showResolve(rArg.slice("--resolve=".length));
    return;
  }
  if (process.argv.includes("--mine")) {
    await showMine();
    return;
  }
  const tArg = process.argv.find((a) => a.startsWith("--tournament="));
  if (tArg) {
    await showTournament(tArg.slice("--tournament=".length));
    return;
  }
  if (process.argv.includes("--stages")) {
    await listStages();
    return;
  }
  await checkMutations();

  const before = await gql("initial set query (entrant ids + starting state)", SET_QUERY, { setId: SET_ID });
  const slots = before.set?.slots;
  const entrant1 = slots?.[0]?.entrant;
  const entrant2 = slots?.[1]?.entrant;
  if (!entrant1?.id || !entrant2?.id) {
    throw new ProbeError(`set ${SET_ID} does not have two entrants; cannot build gameData`);
  }
  console.log(`\nentrant 1 = ${entrant1.id} (${entrant1.name}), entrant 2 = ${entrant2.id} (${entrant2.name})`);

  let dirty = false;
  try {
    dirty = true;
    await gql(
      "1. markSetInProgress",
      `mutation Start($setId: ID!) { markSetInProgress(setId: $setId) { id state } }`,
      { setId: SET_ID },
    );

    await gql(
      "2. assignStream",
      `mutation Assign($setId: ID!, $streamId: ID!) {
        assignStream(setId: $setId, streamId: $streamId) { id state stream { id streamName streamSource } }
      }`,
      { setId: SET_ID, streamId: STREAM_ID },
    );

    await gql("3. reportBracketSet — 1 game, winner=entrant1, NO winnerId", REPORT_MUTATION, {
      setId: SET_ID,
      gameData: [{ gameNum: 1, winnerId: entrant1.id }],
    });

    await gql("4. set after one game", SET_QUERY, { setId: SET_ID });

    // Game 2 goes to entrant 2 so the score stays undecided: this isolates the
    // R2 question (does gameData without winnerId ever complete the set?).
    await gql("5. reportBracketSet — 2 games (full overwrite), NO winnerId", REPORT_MUTATION, {
      setId: SET_ID,
      gameData: [
        { gameNum: 1, winnerId: entrant1.id },
        { gameNum: 2, winnerId: entrant2.id },
      ],
    });

    await gql("5b. set after two games", SET_QUERY, { setId: SET_ID });

    await resetSet("6. resetSet");
  } catch (e) {
    if (dirty) {
      try {
        await resetSet("cleanup: resetSet after failure");
      } catch {
        console.error("probe: cleanup resetSet also failed; set may be left in progress");
      }
    }
    throw e;
  }

  console.log("\nprobe: all steps completed");
}

main().catch((e) => fail(e instanceof ProbeError ? e.message : String(e)));
