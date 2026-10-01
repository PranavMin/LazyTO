// resolve.ts -- turn the config's names into tonight's ids, once, at startup
// (architecture.md Relay). The config names the tournament by its start.gg
// short URL (e.g. "mybar"), which the TO moves to the new tournament every week,
// and names the event and stream; their ids change every week, so the relay
// looks them up instead of being re-pushed with new ids.
//
// The tournament is given in one of two forms, told apart by shape, never by
// trying one and then the other:
//   - a short URL (e.g. "mybar"): found among the token owner's admin tournaments
//     (the relay needs admin rights to report anyway). This is production: the
//     TO moves the short URL to each week's tournament. The API's own
//     tournament(slug: <short URL>) returned null for one on 2026-09-25, so the
//     admin list is the lookup that works.
//   - a full slug ("tournament/<slug>"): fetched directly. For
//     an unpublished tournament, which no list query returns (checked with
//     probe.ts --find-short on 2026-09-25): the test tournament.
// Then the event and stream are picked from that tournament by name.
//
// One exception to "no fallbacks", for a numbered weekly series (user,
// 2026-09-25, taken from the venue's bracket-display resolver; a config field since
// 2026-09-30): if weeklyNamePrefix is set and no admin tournament carries the
// short URL -- the TO has not moved it to tonight's tournament yet -- the
// relay takes the admin tournament whose name is that prefix followed by a
// number (prefix "My Bar Weekly #" matches "My Bar Weekly #160")
// and whose start time is nearest to now, within WEEKLY_WINDOW_DAYS, a future
// one winning a tie. An empty prefix turns the fallback off. It comes from the same admin
// list already fetched, so it costs no extra call and never scrapes the
// website (following the start.gg/<short URL> redirect would hit
// behind Cloudflare's bot challenge). The startup log says which rule found
// the tournament. It needs a correct clock: the unit waits for time sync. Exactly one of each must match;
// zero or several is a startup failure that lists what was there, so the fix
// is obvious from the journal. No guessing, no "closest match".

import type { AdminTournament, StartggClient, TournamentDetail } from './startgg.js';

/** Melee's videogame id and start.gg's singles event type. */
export const MELEE_VIDEOGAME_ID = 1;
export const SINGLES_EVENT_TYPE = 1;

/** Admin tournaments fetched per page while looking for the short URL. */
export const ADMIN_PAGE_SIZE = 50;

/** How far from now a weekly's start may be for the weekly fallback to take it. */
export const WEEKLY_WINDOW_DAYS = 30;

export interface ResolveInput {
  tournament: string; // short URL (e.g. "mybar") or full slug ("tournament/<slug>")
  eventName: string; // matched case-insensitively as a substring, e.g. "Melee Singles"
  streamName: string; // matched case-insensitively and exactly
  weeklyNamePrefix: string; // "" = no weekly fallback; else e.g. "My Bar Weekly #"
}

export interface Resolved {
  /** Which rule found the tournament: the full slug given, the short URL, or the nearest weekly. */
  foundBy: 'full slug' | 'short URL' | 'nearest weekly';
  tournamentName: string;
  tournamentSlug: string;
  eventId: number;
  eventName: string;
  streamId: number;
  streamName: string;
}

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveError';
  }
}

/** True when `name` is `prefix` (case-insensitive) followed by digits and nothing else. */
export function isWeeklyName(name: string, prefix: string): boolean {
  if (prefix.length === 0 || name.length <= prefix.length) return false;
  return name.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase() && /^\d+$/.test(name.slice(prefix.length));
}

/** The weekly whose start is nearest to `nowSec`, within the window; a future one wins a tie. */
export function nearestWeekly(tournaments: AdminTournament[], prefix: string, nowSec: number): AdminTournament | null {
  const window = WEEKLY_WINDOW_DAYS * 24 * 60 * 60;
  let best: AdminTournament | null = null;
  let bestRank: [number, number] | null = null;
  for (const t of tournaments) {
    if (!isWeeklyName(t.name, prefix) || t.startAt === null) continue;
    const distance = Math.abs(t.startAt - nowSec);
    if (distance > window) continue;
    const rank: [number, number] = [distance, t.startAt >= nowSec ? 0 : 1];
    if (!bestRank || rank[0] < bestRank[0] || (rank[0] === bestRank[0] && rank[1] < bestRank[1])) {
      best = t;
      bestRank = rank;
    }
  }
  return best;
}

/** Page through the admin tournaments until one has this short URL; else, with a weekly prefix, the nearest weekly. */
export async function findTournamentSlug(
  client: StartggClient,
  shortSlug: string,
  weeklyNamePrefix: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ slug: string; foundBy: 'short URL' | 'nearest weekly' }> {
  const want = shortSlug.toLowerCase();
  const all: AdminTournament[] = [];
  for (let page = 1; ; page++) {
    const { totalPages, nodes } = await client.getAdminTournaments(page, ADMIN_PAGE_SIZE);
    all.push(...nodes);
    const hit = nodes.find((t) => t.shortSlug?.toLowerCase() === want);
    if (hit) return { slug: hit.slug, foundBy: 'short URL' };
    if (page >= totalPages || nodes.length === 0) break;
  }
  const seen = all.length;
  if (weeklyNamePrefix.length > 0) {
    const weekly = nearestWeekly(all, weeklyNamePrefix, nowSec);
    if (weekly) return { slug: weekly.slug, foundBy: 'nearest weekly' };
    throw new ResolveError(
      `no tournament with short URL "${shortSlug}", and no "${weeklyNamePrefix}<number>" starting within ` +
        `${WEEKLY_WINDOW_DAYS} days of now, among the ${seen} tournaments this token's user administers ` +
        `(check the token belongs to a tournament admin, the weekly's name, and the relay's clock)`,
    );
  }
  throw new ResolveError(
    `no tournament with short URL "${shortSlug}" among the ${seen} tournaments this token's user administers ` +
      `(check the short URL on start.gg and that the token belongs to a tournament admin; an unpublished ` +
      `tournament is never listed, so give its full slug instead, tournament/<slug>)`,
  );
}

/** Exactly one Melee singles event whose name contains eventName. */
export function pickEvent(t: TournamentDetail, eventName: string): TournamentDetail['events'][number] {
  const want = eventName.toLowerCase();
  const matches = t.events.filter(
    (e) =>
      e.videogame?.id === MELEE_VIDEOGAME_ID &&
      e.type === SINGLES_EVENT_TYPE &&
      e.name.toLowerCase().includes(want),
  );
  if (matches.length === 1) return matches[0]!;
  const listed = t.events.map((e) => `"${e.name}" (id ${e.id}, type ${e.type}, game ${e.videogame?.id ?? '?'})`).join(', ');
  throw new ResolveError(
    `${matches.length === 0 ? 'no' : `${matches.length}`} Melee singles events in ${t.slug} have "${eventName}" in the name ` +
      `(need exactly one); events: ${listed || 'none'}`,
  );
}

/** Exactly one stream named streamName. */
export function pickStream(t: TournamentDetail, streamName: string): TournamentDetail['streams'][number] {
  const want = streamName.toLowerCase();
  const matches = t.streams.filter((s) => s.streamName.toLowerCase() === want);
  if (matches.length === 1) return matches[0]!;
  const listed = t.streams.map((s) => `"${s.streamName}" (id ${s.id})`).join(', ');
  throw new ResolveError(
    `${matches.length === 0 ? 'no' : `${matches.length}`} streams named "${streamName}" in ${t.slug} ` +
      `(need exactly one; add it under the tournament's stream settings); streams: ${listed || 'none'}`,
  );
}

export async function resolveEvent(
  client: StartggClient,
  input: ResolveInput,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<Resolved> {
  const found = input.tournament.startsWith('tournament/')
    ? { slug: input.tournament, foundBy: 'full slug' as const }
    : await findTournamentSlug(client, input.tournament, input.weeklyNamePrefix, nowSec);
  const t = await client.getTournament(found.slug);
  const event = pickEvent(t, input.eventName);
  const stream = pickStream(t, input.streamName);
  return {
    foundBy: found.foundBy,
    tournamentName: t.name,
    tournamentSlug: t.slug,
    eventId: Number(event.id),
    eventName: event.name,
    streamId: Number(stream.id),
    streamName: stream.streamName,
  };
}
