// scripts/probe.ts -- read-only lookups against the real start.gg API, for
// filling in .env and checking how the relay will resolve your event.
//
// Reads STARTGG_TOKEN (and, for --resolve / --weekly, EVENT_NAME, STREAM_NAME
// and WEEKLY_NAME_PREFIX) from .env. Changes nothing on start.gg.
//
//   npx tsx scripts/probe.ts --mine                    tournaments your token administers, with short URLs
//   npx tsx scripts/probe.ts --tournament=<slug>       a tournament's events and streams (full slug or short URL)
//   npx tsx scripts/probe.ts --resolve=<tournament>    what the relay would pick at startup with your .env
//   npx tsx scripts/probe.ts --weekly                  the weekly fallback's pick (WEEKLY_NAME_PREFIX)
//   npx tsx scripts/probe.ts --stages                  Melee's stages with start.gg's ids (source of src/stages.ts)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StartggClient } from "../src/startgg.js";
import { resolveEvent, nearestWeekly, ADMIN_PAGE_SIZE } from "../src/resolve.js";
import type { AdminTournament } from "../src/startgg.js";

const ENDPOINT = "https://api.start.gg/gql/alpha";

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
  if (!env.STARTGG_TOKEN) fail("missing STARTGG_TOKEN in .env");
  return env;
}

const env = loadEnv();

async function gql(label: string, query: string, variables: Record<string, unknown>): Promise<any> {
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
  if (!res.ok || json === null || json.errors) {
    console.log(`\n=== ${label} ===`);
    console.log(`--- variables: ${JSON.stringify(variables)}`);
    console.log(`--- HTTP ${res.status}, raw response:`);
    console.log(text);
    throw new ProbeError(`${label} failed (HTTP ${res.status}${json?.errors ? ", GraphQL errors in raw response above" : ""})`);
  }
  return json.data;
}

// --stages: Melee's stage list with start.gg's ids, the source for src/stages.ts.
async function listStages(): Promise<void> {
  const data = await gql(
    "videogame(id: 1) stages",
    `query MeleeStages { videogame(id: 1) { id name stages { id name } } }`,
    {},
  );
  const stages = (data.videogame?.stages ?? []) as { id: number; name: string }[];
  console.log(`\n${data.videogame?.name}: ${stages.length} stages`);
  for (const s of stages.slice().sort((a, b) => a.id - b.id)) {
    console.log(`  ${String(s.id).padStart(6)}  ${s.name}`);
  }
}

// --tournament=<slug>: a tournament's events (with game and entrant type) and
// streams, to pick EVENT_NAME and STREAM_NAME from.
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
  );
  const t = data.tournament;
  if (!t) throw new ProbeError(`no tournament for slug "${slug}" (the API does not resolve every short URL; try --mine)`);
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

// --mine: tournaments the token's user administers, soonest first, with their
// short URL. This is the list the relay searches for TOURNAMENT.
async function showMine(): Promise<void> {
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
  );
  const u = data.currentUser;
  console.log(`user ${u?.slug} (${u?.id}), admin tournaments:`);
  for (const t of u?.tournaments?.nodes ?? []) {
    const when = t.startAt ? new Date(t.startAt * 1000).toISOString().slice(0, 16) : "?";
    console.log(`  ${when}  state=${t.state}  short=${(t.shortSlug ?? "-").padEnd(12)}  ${t.slug}`);
  }
}

// --resolve=<tournament>: the relay's own startup resolution (src/resolve.ts)
// with EVENT_NAME, STREAM_NAME and WEEKLY_NAME_PREFIX from .env, exactly as
// the Pi will run it.
async function showResolve(tournament: string): Promise<void> {
  const client = new StartggClient({ endpoint: ENDPOINT, token: env.STARTGG_TOKEN! });
  const r = await resolveEvent(client, {
    tournament,
    eventName: env.EVENT_NAME ?? fail("missing EVENT_NAME in .env"),
    streamName: env.STREAM_NAME ?? fail("missing STREAM_NAME in .env"),
    weeklyNamePrefix: tournament.startsWith("tournament/") ? "" : (env.WEEKLY_NAME_PREFIX ?? ""),
  });
  console.log(JSON.stringify(r, null, 2));
}

// --weekly: the fallback rule (nearest WEEKLY_NAME_PREFIX<number> by start
// time) run over the real admin list, as if the short URL had not been moved.
async function showWeekly(): Promise<void> {
  const prefix = env.WEEKLY_NAME_PREFIX || fail("missing WEEKLY_NAME_PREFIX in .env");
  const client = new StartggClient({ endpoint: ENDPOINT, token: env.STARTGG_TOKEN! });
  const all: AdminTournament[] = [];
  for (let page = 1; ; page++) {
    const { totalPages, nodes } = await client.getAdminTournaments(page, ADMIN_PAGE_SIZE);
    all.push(...nodes);
    if (page >= totalPages || nodes.length === 0) break;
  }
  const now = Math.floor(Date.now() / 1000);
  const w = nearestWeekly(all, prefix, now);
  console.log(`${all.length} admin tournaments; nearest "${prefix}<number>" to now: ` +
    (w ? `${w.name} (${w.slug}) starting ${new Date(w.startAt! * 1000).toISOString()}, short URL ${w.shortSlug ?? "-"}` : "none"));
}

async function main(): Promise<void> {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  if (process.argv.includes("--weekly")) return showWeekly();
  const r = arg("--resolve");
  if (r) return showResolve(r);
  if (process.argv.includes("--mine")) return showMine();
  const t = arg("--tournament");
  if (t) return showTournament(t);
  if (process.argv.includes("--stages")) return listStages();
  fail("usage: npx tsx scripts/probe.ts --mine | --tournament=<slug> | --resolve=<tournament> | --weekly | --stages");
}

main().catch((e) => fail(e instanceof ProbeError ? e.message : String(e)));
