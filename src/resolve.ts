// resolve.ts -- turn the config's names into tonight's ids, once, at startup
// (design.md section 6.3). The config names the tournament by its start.gg
// short URL ("abbey"), which the TO moves to the new tournament every week,
// and names the event and stream; their ids change every week, so the relay
// looks them up instead of being re-pushed with new ids.
//
// The tournament is given in one of two forms, told apart by shape, never by
// trying one and then the other:
//   - a short URL ("abbey"): found among the token owner's admin tournaments
//     (the relay needs admin rights to report anyway). This is production: the
//     TO moves the short URL to each week's tournament. The API's own
//     tournament(slug: "abbey") returned null for it on 2026-09-25, so the
//     admin list is the lookup that works.
//   - a full slug ("tournament/sf-melee-discord-test"): fetched directly. For
//     an unpublished tournament, which no list query returns (checked with
//     probe.ts --find-short on 2026-09-25): the test tournament.
// Then the event and stream are picked from that tournament by name. Exactly one of each must match;
// zero or several is a startup failure that lists what was there, so the fix
// is obvious from the journal. No guessing, no "closest match".

import type { StartggClient, TournamentDetail } from './startgg.js';

/** Melee's videogame id and start.gg's singles event type. */
export const MELEE_VIDEOGAME_ID = 1;
export const SINGLES_EVENT_TYPE = 1;

/** Admin tournaments fetched per page while looking for the short URL. */
export const ADMIN_PAGE_SIZE = 50;

export interface ResolveInput {
  tournament: string; // short URL ("abbey") or full slug ("tournament/sf-melee-discord-test")
  eventName: string; // matched case-insensitively as a substring, e.g. "Melee Singles"
  streamName: string; // matched case-insensitively and exactly, e.g. "SFMelee"
}

export interface Resolved {
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

/** Page through the admin tournaments until one has this short URL. */
export async function findTournamentSlug(client: StartggClient, shortSlug: string): Promise<string> {
  const want = shortSlug.toLowerCase();
  let seen = 0;
  for (let page = 1; ; page++) {
    const { totalPages, nodes } = await client.getAdminTournaments(page, ADMIN_PAGE_SIZE);
    seen += nodes.length;
    const hit = nodes.find((t) => t.shortSlug?.toLowerCase() === want);
    if (hit) return hit.slug;
    if (page >= totalPages || nodes.length === 0) break;
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

export async function resolveEvent(client: StartggClient, input: ResolveInput): Promise<Resolved> {
  const slug = input.tournament.startsWith('tournament/')
    ? input.tournament
    : await findTournamentSlug(client, input.tournament);
  const t = await client.getTournament(slug);
  const event = pickEvent(t, input.eventName);
  const stream = pickStream(t, input.streamName);
  return {
    tournamentName: t.name,
    tournamentSlug: t.slug,
    eventId: Number(event.id),
    eventName: event.name,
    streamId: Number(stream.id),
    streamName: stream.streamName,
  };
}
