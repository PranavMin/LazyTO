// scripts/probe.ts — live start.gg probe for design.md §11 R1 (assignStream
// semantics) and R2 (reportBracketSet with gameData but no winnerId).
//
// Touches ONLY the test tournament configured in .env (see CLAUDE.md: the real
// API is touched only by this script). Mutates TEST_SET_ID and resets it at the
// end; on a mid-run failure it attempts a cleanup resetSet before exiting.
//
// Run: node scripts/probe.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

async function main(): Promise<void> {
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
