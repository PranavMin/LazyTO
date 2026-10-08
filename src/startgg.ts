// startgg.ts -- the one place that talks to start.gg (architecture.md Relay).
// GraphQL over HTTPS with the token, a token-bucket rate limiter (70 per
// 60 s -- a guard under the API's 80/60 s, not a throttle), and retry on
// 5xx only: max 2 retries, backoff 1 s then 3 s. Anything else fails
// immediately -- 4xx and GraphQL errors are upstream rejections the caller
// must surface, and a network error means the venue link is down, which
// retrying from here would only hide.

// The endpoint (https://api.start.gg/gql/alpha in production) comes from
// config.startggEndpoint; there is no built-in default.
//
// Two REST reads, for the set archive's context.json only, are the ones
// Replay Reporter for Slippi makes (its src/main/startgg.ts), because the
// GraphQL schema lacks what they give (docs/redesign.md, The zip and Lucky
// Stats): the tournament once at startup (its locationDisplayName and the
// events Replay Reporter counts) and a set's phase group once per START_SET
// (bracket type, wave, winners target phase, and what the set's ordinal is
// worked out from). They go to the GraphQL endpoint's origin, without the
// token, as Replay Reporter sends them; the 5xx rule above applies, the rate
// limiter (a GraphQL limit) does not.

export type StartggErrorKind = 'upstream_5xx' | 'rejected' | 'network';

export class StartggError extends Error {
  constructor(
    public readonly kind: StartggErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'StartggError';
  }
}

export class RateLimitedError extends Error {
  constructor() {
    super('no rate-limit token within the wait budget');
    this.name = 'RateLimitedError';
  }
}

// BracketSetGameDataInput as the relay uses it. stageId and selections are
// present only when the Wii knew them (auto-scored games; decisions.md R13) --
// a hand-scored game carries winner only.
export interface GameDataInput {
  gameNum: number;
  winnerId: number;
  stageId?: number;
  selections?: { entrantId: number; characterId: number }[];
  /** Per-game entrant scores. For Melee start.gg reads them as stocks remaining; the relay packs the costume in as (costume + 1) * 100 + stocks, the Replay Reporter for Slippi convention. */
  entrant1Score?: number;
  entrant2Score?: number;
}

/** A set node as the event-sets query returns it (states 1 and 2 only). */
export interface UpstreamSet {
  id: number | string; // string = preview id (decisions.md R8)
  state: number;
  round: number;
  fullRoundText: string;
  totalGames: number;
  slots: { entrant: UpstreamEntrant | null }[];
  stream: { id: number } | null;
  /** The pool: its phase's phaseOrder for format.ts (phases number their rounds from 1 again), the rest for the set archive's context.json (archive.ts). */
  phaseGroup: UpstreamPhaseGroup;
}

export interface UpstreamPhaseGroup {
  id: number;
  displayIdentifier: string;
  bracketType: string | null; // "DOUBLE_ELIMINATION", ...
  wave: { id: number } | null;
  phase: { id: number; name: string; groupCount: number | null; phaseOrder: number };
}

/** name is the display name with the sponsor prefix ("C9 | Mang0"); a singles
 * entrant's one participant carries the bare gamerTag. */
export interface UpstreamEntrant {
  id: number;
  name: string;
  participants?: { gamerTag: string | null }[] | null;
}

/** A participant as START_SET's markSetInProgress returns it: the bare gamerTag, untrimmed; prefix and pronouns "" when start.gg has none. */
export interface StartedParticipant {
  id: number;
  gamerTag: string;
  prefix: string;
  pronouns: string;
}

/** The set as markSetInProgress returns it at START_SET: each slot's entrant and participants. */
export interface StartedSet {
  entrants: { id: number; participants: StartedParticipant[] }[];
}

/** The set as END_SET's reportBracketSet returns it: completedAt (unix seconds) and its stream. */
export interface ReportedSet {
  completedAt: number | null;
  stream: { id: number; streamName: string | null; streamSource: string | null } | null;
}

/** start.gg's REST tournament (GET /tournament/<slug>?expand[]=event), what the relay reads of it. */
export interface RestTournament {
  entities: {
    tournament: { name: string; slug: string; locationDisplayName: string | null };
    event: {
      id: number;
      name: string;
      slug: string;
      videogameId: number;
      teamRosterSize: { minPlayers: number; maxPlayers: number } | null;
    }[];
  };
}

/**
 * start.gg's REST phase group (GET /phase_group/<id>?expand[]=sets&...): the
 * group's facts, its seeds and every set, which phasegroup.ts reads as
 * Replay Reporter does. Sets are left loose; only some of their fields are read.
 */
export interface RestPhaseGroup {
  entities: {
    groups: {
      groupTypeId: number;
      displayIdentifier: string;
      waveId: number | null;
      winnersTargetPhaseId: number | null;
    };
    seeds?: unknown;
    sets?: Record<string, any>[];
  };
}

/** A tournament as the admin list returns it (resolve.ts finds tonight's by short URL). */
export interface AdminTournament {
  slug: string; // "tournament/my-bar-weekly-160"
  shortSlug: string | null; // "mybar"; a weekly moves it to the new tournament each week
  name: string; // "My Bar Weekly #160"
  startAt: number | null; // unix seconds
}

/** A tournament's events and streams, for resolve.ts to pick from by name. */
export interface TournamentDetail {
  id: number;
  name: string;
  slug: string;
  events: {
    id: number;
    name: string;
    slug: string;
    type: number;
    videogame: { id: number } | null;
    phases: { id: number }[] | null;
  }[];
  streams: { id: number; streamName: string }[];
}

// The token owner's admin tournaments, newest first. Short URLs are looked up
// here rather than with tournament(slug: <short URL>): the API resolved one
// short URL but returned null for another on 2026-09-25 while it
// pointed at an upcoming tournament (probe.ts --tournament / --mine).
const ADMIN_TOURNAMENTS_QUERY = `query AdminTournaments($page: Int!, $perPage: Int!) {
  currentUser {
    tournaments(query: { page: $page, perPage: $perPage, filter: { tournamentView: "admin" } }) {
      pageInfo { totalPages }
      nodes { slug shortSlug name startAt }
    }
  }
}`;

const TOURNAMENT_QUERY = `query Tournament($slug: String!) {
  tournament(slug: $slug) {
    id
    name
    slug
    events { id name slug type videogame { id } phases { id } }
    streams { id streamName }
  }
}`;

// The Game OUTPUT type has orderNum, not gameNum (probe, 2026-09-19);
// gameNum exists only on BracketSetGameDataInput.
const EVENT_SETS_QUERY = `query EventSets($eventId: ID!) {
  event(id: $eventId) {
    id
    sets(perPage: 100, filters: { state: [1, 2] }) {
      nodes {
        id
        state
        round
        fullRoundText
        totalGames
        slots { entrant { id name participants { gamerTag } } }
        stream { id }
        phaseGroup { id displayIdentifier bracketType wave { id } phase { id name groupCount phaseOrder } }
      }
    }
  }
}`;

// START_SET: the participants are the set archive's names, prefixes and
// pronouns (archive.ts), taken here because the set leaves the cache once it
// completes. Replay Reporter takes the same fields from the same mutation.
const MARK_IN_PROGRESS = `mutation Start($setId: ID!) {
  markSetInProgress(setId: $setId) {
    id
    state
    slots { entrant { id participants { id gamerTag prefix player { user { genderPronoun } } } } }
  }
}`;

// Starting a pool from a preview id needs only the set's new id.
const START_POOL = `mutation StartPool($setId: ID!) {
  markSetInProgress(setId: $setId) { id state }
}`;

const ASSIGN_STREAM = `mutation Assign($setId: ID!, $streamId: ID!) {
  assignStream(setId: $setId, streamId: $streamId) { id state stream { id } }
}`;

const REPORT_GAMES = `mutation Report($setId: ID!, $gameData: [BracketSetGameDataInput]) {
  reportBracketSet(setId: $setId, gameData: $gameData) { id state }
}`;

// END_SET: completedAt anchors the archive's re-timed replays, and the stream
// goes into its context.json (archive.ts).
const REPORT_WINNER = `mutation ReportWin($setId: ID!, $winnerId: ID!, $gameData: [BracketSetGameDataInput]) {
  reportBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData) {
    id
    state
    completedAt
    stream { id streamName streamSource }
  }
}`;

const RESET_SET = `mutation Reset($setId: ID!) {
  resetSet(setId: $setId) { id state }
}`;

/** A slot as markSetInProgress answers it. */
interface ApiSlot {
  entrant: {
    id: number;
    participants:
      | {
          id: number;
          gamerTag: string | null;
          prefix: string | null;
          player: { user: { genderPronoun: string | null } | null } | null;
        }[]
      | null;
  } | null;
}

class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
  ) {
    this.tokens = capacity;
  }

  private refill(now: number): void {
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.lastRefill) / 60_000) * this.refillPerMinute,
    );
    this.lastRefill = now;
  }

  /** Take a token, waiting at most maxWaitMs for one. Throws RateLimitedError. */
  async take(maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const now = Date.now();
      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Timers can fire a little before Date.now() has advanced by the full
      // delay (libuv measures from its cached loop time), so re-check rather
      // than assume the token arrived. A concurrent taker also lands here.
      const needMs = ((1 - this.tokens) / this.refillPerMinute) * 60_000;
      if (now + needMs > deadline) throw new RateLimitedError();
      await new Promise((r) => setTimeout(r, Math.max(1, Math.ceil(needMs))));
    }
  }
}

export interface StartggClientOptions {
  endpoint: string;
  token: string;
  /** Rate-limit guard; production values are the design's 70/60 s, wait <= 2 s. */
  limits?: { capacity: number; refillPerMinute: number; maxWaitMs: number };
  /** Backoff before retry 1 and retry 2 on a 5xx; tests shrink these. */
  retryDelaysMs?: [number, number];
}

export class StartggClient {
  private readonly endpoint: string;
  /** Where the REST API is: the GraphQL endpoint's origin (https://api.start.gg). */
  private readonly restOrigin: string;
  private readonly token: string;
  private readonly bucket: TokenBucket;
  private readonly maxWaitMs: number;
  private readonly retryDelaysMs: [number, number];
  private readonly callTimes: number[] = [];

  constructor(opts: StartggClientOptions) {
    this.endpoint = opts.endpoint;
    this.restOrigin = new URL(opts.endpoint).origin;
    this.token = opts.token;
    const limits = opts.limits ?? { capacity: 70, refillPerMinute: 70, maxWaitMs: 2000 };
    this.bucket = new TokenBucket(limits.capacity, limits.refillPerMinute);
    this.maxWaitMs = limits.maxWaitMs;
    this.retryDelaysMs = opts.retryDelaysMs ?? [1000, 3000];
  }

  /** Upstream calls (HTTP requests actually sent) in the last windowMs. */
  callsInWindow(windowMs = 60_000): number {
    const cutoff = Date.now() - windowMs;
    while (this.callTimes.length > 0 && this.callTimes[0] < cutoff) this.callTimes.shift();
    return this.callTimes.length;
  }

  /** One page of the token owner's admin tournaments (1-based page). */
  async getAdminTournaments(
    page: number,
    perPage: number,
  ): Promise<{ totalPages: number; nodes: AdminTournament[] }> {
    const data = await this.gql(ADMIN_TOURNAMENTS_QUERY, { page, perPage });
    const user = data.currentUser as {
      tournaments: { pageInfo: { totalPages: number }; nodes: AdminTournament[] } | null;
    } | null;
    if (!user?.tournaments)
      throw new StartggError('rejected', 'start.gg returned no user for this token');
    return { totalPages: user.tournaments.pageInfo.totalPages, nodes: user.tournaments.nodes };
  }

  async getTournament(slug: string): Promise<TournamentDetail> {
    const data = await this.gql(TOURNAMENT_QUERY, { slug });
    const t = data.tournament as TournamentDetail | null;
    if (!t) throw new StartggError('rejected', `tournament ${slug} not found`);
    return t;
  }

  async getEventSets(eventId: number): Promise<UpstreamSet[]> {
    const data = await this.gql(EVENT_SETS_QUERY, { eventId });
    const event = data.event as { sets: { nodes: UpstreamSet[] } } | null;
    if (!event) throw new StartggError('rejected', `event ${eventId} not found`);
    return event.sets.nodes;
  }

  /** Start the set; its entrants and their participants as start.gg answers. */
  async markSetInProgress(setId: number): Promise<StartedSet> {
    const data = await this.gql(MARK_IN_PROGRESS, { setId });
    const set = data.markSetInProgress as { slots: ApiSlot[] | null } | null;
    if (!set) throw new StartggError('rejected', 'markSetInProgress returned no set');
    return {
      entrants: (set.slots ?? []).flatMap((slot) =>
        slot.entrant
          ? [
              {
                id: slot.entrant.id,
                participants: (slot.entrant.participants ?? []).map((p) => ({
                  id: p.id,
                  gamerTag: p.gamerTag ?? '',
                  prefix: p.prefix || '',
                  pronouns: p.player?.user?.genderPronoun || '',
                })),
              },
            ]
          : [],
      ),
    };
  }

  /**
   * Start an unstarted pool from one of its preview set ids (decisions.md R8).
   * resetSet rejects a preview id ("Set not found"); markSetInProgress takes
   * it, gives the whole pool numeric ids and answers with this set's real id,
   * so that set is put straight back to pending (probe, 2026-10-02).
   */
  async startPool(previewSetId: string): Promise<void> {
    const data = await this.gql(START_POOL, { setId: previewSetId });
    const set = data.markSetInProgress as { id: number } | null;
    if (!set) throw new StartggError('rejected', 'markSetInProgress returned no set');
    await this.gql(RESET_SET, { setId: set.id });
  }

  async assignStream(setId: number, streamId: number): Promise<void> {
    await this.gql(ASSIGN_STREAM, { setId, streamId });
  }

  /** Full-overwrite game report; the set stays in progress (probe R2). */
  async reportGames(setId: number, gameData: GameDataInput[]): Promise<void> {
    await this.gql(REPORT_GAMES, { setId, gameData });
  }

  /**
   * Final report: winner + full game list; completes the set. reportBracketSet
   * answers with a list of sets; this one is the element with its id (null if
   * start.gg left it out).
   */
  async reportWinner(
    setId: number,
    winnerId: number,
    gameData: GameDataInput[],
  ): Promise<ReportedSet | null> {
    const data = await this.gql(REPORT_WINNER, { setId, winnerId, gameData });
    const sets = (data.reportBracketSet ?? []) as ({ id: number | string } & ReportedSet)[];
    const set = sets.find((x) => String(x.id) === String(setId));
    return set ? { completedAt: set.completedAt ?? null, stream: set.stream ?? null } : null;
  }

  async resetSet(setId: number): Promise<void> {
    await this.gql(RESET_SET, { setId });
  }

  /** REST: the tournament with its events, by its slug without "tournament/". */
  async getTournamentRest(slug: string): Promise<RestTournament> {
    const json = (await this.rest(`/tournament/${slug}?expand[]=event`)) as RestTournament | null;
    if (typeof json?.entities?.tournament !== 'object' || !Array.isArray(json.entities.event)) {
      throw new StartggError('rejected', `start.gg REST: no tournament ${slug}`);
    }
    return json;
  }

  /** REST: a phase group with its sets, entrants and seeds, Replay Reporter's exact request. */
  async getPhaseGroupRest(id: number): Promise<RestPhaseGroup> {
    const json = (await this.rest(
      `/phase_group/${id}?expand[]=sets&expand[]=entrants&expand[]=seeds&bustCache=true`,
    )) as RestPhaseGroup | null;
    if (typeof json?.entities?.groups !== 'object' || json.entities.groups === null) {
      throw new StartggError('rejected', `start.gg REST: no phase group ${id}`);
    }
    return json;
  }

  /** One HTTP request with the 5xx retries; a network failure is StartggError 'network'. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      this.callTimes.push(Date.now());
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (e) {
        throw new StartggError('network', `start.gg unreachable: ${(e as Error).message}`);
      }
      if (res.status < 500) return res;
      if (attempt < this.retryDelaysMs.length) {
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
        continue;
      }
      throw new StartggError(
        'upstream_5xx',
        `start.gg HTTP ${res.status} after ${attempt + 1} attempts`,
      );
    }
  }

  private async rest(path: string): Promise<unknown> {
    const res = await this.send(`${this.restOrigin}${path}`, { method: 'GET' });
    const text = await res.text();
    if (!res.ok) throw new StartggError('rejected', `start.gg REST ${path}: HTTP ${res.status}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new StartggError('rejected', `start.gg REST ${path}: unparseable response`);
    }
  }

  private async gql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.bucket.take(this.maxWaitMs);
    const res = await this.send(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json: { data?: Record<string, unknown>; errors?: { message: string }[] };
    try {
      json = JSON.parse(text);
    } catch {
      throw new StartggError('rejected', `start.gg HTTP ${res.status}: unparseable response`);
    }
    if (!res.ok || json.errors || !json.data) {
      const msg = json.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`;
      throw new StartggError('rejected', `start.gg rejected: ${msg}`);
    }
    return json.data;
  }
}
