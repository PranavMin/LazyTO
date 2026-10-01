// startgg.ts -- the one place that talks to start.gg (architecture.md Relay).
// GraphQL over HTTPS with the token, a token-bucket rate limiter (70 per
// 60 s -- a guard under the API's 80/60 s, not a throttle), and retry on
// 5xx only: max 2 retries, backoff 1 s then 3 s. Anything else fails
// immediately -- 4xx and GraphQL errors are upstream rejections the caller
// must surface, and a network error means the venue link is down, which
// retrying from here would only hide.

// The endpoint (https://api.start.gg/gql/alpha in production) comes from
// config.startggEndpoint; there is no built-in default.

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
  slots: { entrant: { id: number; name: string } | null }[];
  games: { orderNum: number; winnerId: number }[] | null;
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
  venueAddress: string | null;
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
    venueAddress
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
        slots { entrant { id name } }
        games { orderNum winnerId }
        stream { id }
        phaseGroup { id displayIdentifier bracketType wave { id } phase { id name groupCount phaseOrder } }
      }
    }
  }
}`;

const MARK_IN_PROGRESS = `mutation Start($setId: ID!) {
  markSetInProgress(setId: $setId) { id state }
}`;

const ASSIGN_STREAM = `mutation Assign($setId: ID!, $streamId: ID!) {
  assignStream(setId: $setId, streamId: $streamId) { id state stream { id } }
}`;

const REPORT_GAMES = `mutation Report($setId: ID!, $gameData: [BracketSetGameDataInput]) {
  reportBracketSet(setId: $setId, gameData: $gameData) { id state }
}`;

const REPORT_WINNER = `mutation ReportWin($setId: ID!, $winnerId: ID!, $gameData: [BracketSetGameDataInput]) {
  reportBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData) { id state }
}`;

const RESET_SET = `mutation Reset($setId: ID!) {
  resetSet(setId: $setId) { id state }
}`;

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
  private readonly token: string;
  private readonly bucket: TokenBucket;
  private readonly maxWaitMs: number;
  private readonly retryDelaysMs: [number, number];
  private readonly callTimes: number[] = [];

  constructor(opts: StartggClientOptions) {
    this.endpoint = opts.endpoint;
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

  async markSetInProgress(setId: number): Promise<void> {
    await this.gql(MARK_IN_PROGRESS, { setId });
  }

  async assignStream(setId: number, streamId: number): Promise<void> {
    await this.gql(ASSIGN_STREAM, { setId, streamId });
  }

  /** Full-overwrite game report; the set stays in progress (probe R2). */
  async reportGames(setId: number, gameData: GameDataInput[]): Promise<void> {
    await this.gql(REPORT_GAMES, { setId, gameData });
  }

  /** Final report: winner + full game list; completes the set. */
  async reportWinner(setId: number, winnerId: number, gameData: GameDataInput[]): Promise<void> {
    await this.gql(REPORT_WINNER, { setId, winnerId, gameData });
  }

  async resetSet(setId: number): Promise<void> {
    await this.gql(RESET_SET, { setId });
  }

  private async gql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.bucket.take(this.maxWaitMs);
    for (let attempt = 0; ; attempt++) {
      this.callTimes.push(Date.now());
      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (e) {
        throw new StartggError('network', `start.gg unreachable: ${(e as Error).message}`);
      }

      if (res.status >= 500) {
        if (attempt < this.retryDelaysMs.length) {
          await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
          continue;
        }
        throw new StartggError(
          'upstream_5xx',
          `start.gg HTTP ${res.status} after ${attempt + 1} attempts`,
        );
      }

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
}
