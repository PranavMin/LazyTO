// fake-startgg.ts -- in-process fake of api.start.gg/gql/alpha for
// integration tests (design.md section 9.2). Response shapes mirror what
// scripts/probe.ts recorded on 2026-09-19 against the real test tournament
// (event 1613010): mutations answer with the set's {id state ...} selection,
// semantic failures are HTTP 200 with a GraphQL "errors" array, and the Game
// OUTPUT type has orderNum, not gameNum -- a query selecting gameNum on games
// is rejected exactly like the real schema rejects it (design.md section 6.3
// gotcha). gameNum exists only inside the BracketSetGameDataInput variables.
//
// Behavior verified by the probe and reproduced here:
//   - markSetInProgress: state 1 -> 2.
//   - assignStream: attaches the stream, no stream-queue precondition.
//   - reportBracketSet without winnerId: full overwrite of the game rows
//     (old ids deleted, fresh ids created), set stays state 2.
//   - reportBracketSet with winnerId: same overwrite, state -> 3.
//   - resetSet: state -> 1, games cleared, stream assignment KEPT (verified
//     live 2026-09-20, design.md section 5.6).
//
//   - currentUser.tournaments(filter: {tournamentView: "admin"}): paged
//     {slug, shortSlug} of the token owner's tournaments (resolve.ts).
//   - tournament(slug): events {id name type videogame {id}} and streams.
//
// Test hooks: failNext() injects 5xx or GraphQL errors, calls[] records
// every upstream call with a timestamp for retry-count and rate assertions.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeEntrant {
  id: number;
  name: string;
}

export interface FakeGame {
  id: number;
  orderNum: number;
  winnerId: number;
  stageId?: number;
  selections?: { entrantId: number; characterId: number }[];
}

export interface FakeSet {
  id: number | string; // string ids are preview sets (design.md R8)
  state: 1 | 2 | 3;
  round: number; // start.gg round: positive winners, negative losers
  fullRoundText: string;
  totalGames: number; // best of N
  slots: [FakeEntrant | null, FakeEntrant | null];
  games: FakeGame[];
  stream: { id: number; streamName: string; streamSource: string } | null;
}

export interface FakeTournament {
  slug: string; // "tournament/sf-melee-discord-test"
  shortSlug: string | null;
  published: boolean; // unpublished tournaments are absent from every list query (probe.ts --find-short)
  startAt: number | null; // unix seconds
  id: number;
  name: string;
  events: { id: number; name: string; type: number; videogame: { id: number } }[];
  streams: { id: number; streamName: string }[];
}

export interface RecordedCall {
  op: string;
  at: number; // Date.now()
  variables: Record<string, unknown>;
}

type FailMode = '5xx' | 'gqlError';

const OPS = ['eventSets', 'markSetInProgress', 'assignStream', 'reportBracketSet', 'resetSet', 'adminTournaments', 'tournament'] as const;
type Op = (typeof OPS)[number];

function gqlErrorBody(message: string): string {
  return JSON.stringify({ errors: [{ message }] });
}

export class FakeStartgg {
  readonly calls: RecordedCall[] = [];
  private server: Server;
  private baseUrl = '';
  private nextGameId = 500_000;
  private failures: { op: Op | '*'; mode: FailMode; message: string; times: number }[] = [];

  constructor(
    private readonly token: string,
    private readonly eventId: number,
    readonly sets: FakeSet[],
    readonly tournaments: FakeTournament[] = defaultTournaments(),
  ) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const { status, body } = this.handle(
          req.headers.authorization,
          Buffer.concat(chunks).toString('utf8'),
        );
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      });
    });
  }

  /** Listen on 127.0.0.1; port 0 (tests) picks a free one, scripts/serve-fake.ts passes a fixed one. */
  async start(port = 0): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    const bound = (this.server.address() as AddressInfo).port;
    this.baseUrl = `http://127.0.0.1:${bound}/gql/alpha`;
  }

  get url(): string {
    if (!this.baseUrl) throw new Error('FakeStartgg not started');
    return this.baseUrl;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
  }

  /** The next `times` calls matching `op` fail with HTTP 5xx or a GraphQL error. */
  failNext(op: Op | '*', mode: FailMode, times = 1, message = 'injected failure'): void {
    this.failures.push({ op, mode, message, times });
  }

  callsFor(op: Op): RecordedCall[] {
    return this.calls.filter((c) => c.op === op);
  }

  getSet(id: number | string): FakeSet {
    const set = this.sets.find((s) => s.id === id);
    if (!set) throw new Error(`fake: no set ${id}`);
    return set;
  }

  // ---- request handling ----

  private handle(auth: string | undefined, bodyText: string): { status: number; body: string } {
    if (auth !== `Bearer ${this.token}`) {
      return { status: 401, body: gqlErrorBody('Invalid authentication token') };
    }

    let query: string;
    let variables: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bodyText);
      query = String(parsed.query ?? '');
      variables = parsed.variables ?? {};
    } catch {
      return { status: 400, body: gqlErrorBody('Invalid request body') };
    }

    const op = this.classify(query);
    if (!op) return { status: 200, body: gqlErrorBody('Unknown operation') };
    this.calls.push({ op, at: Date.now(), variables });

    // The real schema's Game output type has orderNum, not gameNum: selecting
    // gameNum in the QUERY TEXT (not in gameData variables) must fail.
    if (/games\s*\{[^}]*\bgameNum\b/.test(query)) {
      return { status: 200, body: gqlErrorBody('Cannot query field "gameNum" on type "Game".') };
    }

    const failure = this.failures.find((f) => (f.op === op || f.op === '*') && f.times > 0);
    if (failure) {
      failure.times--;
      if (failure.mode === '5xx') {
        return { status: 503, body: gqlErrorBody(failure.message) };
      }
      return { status: 200, body: gqlErrorBody(failure.message) };
    }

    switch (op) {
      case 'eventSets':
        return this.eventSets(variables);
      case 'markSetInProgress':
        return this.markSetInProgress(variables);
      case 'assignStream':
        return this.assignStream(variables);
      case 'reportBracketSet':
        return this.reportBracketSet(variables);
      case 'resetSet':
        return this.resetSet(variables);
      case 'adminTournaments':
        return this.adminTournaments(variables);
      case 'tournament':
        return this.tournament(variables);
    }
  }

  private classify(query: string): Op | null {
    if (query.includes('currentUser')) return 'adminTournaments';
    if (/\btournament\s*\(\s*slug\s*:/.test(query)) return 'tournament';
    for (const op of OPS) {
      if (op === 'eventSets' || op === 'adminTournaments' || op === 'tournament') continue;
      if (query.includes(op)) return op;
    }
    if (/event\s*\(/.test(query) && query.includes('sets')) return 'eventSets';
    return null;
  }

  private findSet(variables: Record<string, unknown>): FakeSet | null {
    // start.gg's ID scalar accepts numbers and numeric strings alike.
    const raw = variables.setId;
    return (
      this.sets.find((s) => s.id === raw || String(s.id) === String(raw)) ?? null
    );
  }

  private setNode(set: FakeSet) {
    return {
      id: set.id,
      state: set.state,
      round: set.round,
      fullRoundText: set.fullRoundText,
      totalGames: set.totalGames,
      slots: set.slots.map((e) => ({ entrant: e ? { id: e.id, name: e.name } : null })),
      games: set.games.length
        ? set.games.map((g) => ({ id: g.id, orderNum: g.orderNum, winnerId: g.winnerId }))
        : null, // the real API returns null, not [], for a set with no games
      stream: set.stream,
    };
  }

  private eventSets(variables: Record<string, unknown>): { status: number; body: string } {
    if (Number(variables.eventId) !== this.eventId) {
      return { status: 200, body: JSON.stringify({ data: { event: null } }) };
    }
    // The relay queries filters {state: [1, 2]}; completed sets never appear.
    const nodes = this.sets.filter((s) => s.state !== 3).map((s) => this.setNode(s));
    return {
      status: 200,
      body: JSON.stringify({
        data: { event: { id: this.eventId, sets: { pageInfo: { total: nodes.length }, nodes } } },
      }),
    };
  }

  private markSetInProgress(variables: Record<string, unknown>): { status: number; body: string } {
    const set = this.findSet(variables);
    if (!set) return { status: 200, body: gqlErrorBody('Set not found') };
    if (set.state === 3) return { status: 200, body: gqlErrorBody('Set is already complete') };
    set.state = 2;
    return { status: 200, body: JSON.stringify({ data: { markSetInProgress: { id: set.id, state: set.state } } }) };
  }

  private assignStream(variables: Record<string, unknown>): { status: number; body: string } {
    const set = this.findSet(variables);
    if (!set) return { status: 200, body: gqlErrorBody('Set not found') };
    set.stream = { id: Number(variables.streamId), streamName: 'SFMelee', streamSource: 'TWITCH' };
    return {
      status: 200,
      body: JSON.stringify({ data: { assignStream: { id: set.id, state: set.state, stream: set.stream } } }),
    };
  }

  private reportBracketSet(variables: Record<string, unknown>): { status: number; body: string } {
    const set = this.findSet(variables);
    if (!set) return { status: 200, body: gqlErrorBody('Set not found') };
    if (set.state === 3) return { status: 200, body: gqlErrorBody('Set has already been completed') };

    const entrantIds = set.slots.map((e) => e?.id).filter((x): x is number => x != null);
    const gameData = (variables.gameData ?? []) as {
      gameNum?: unknown;
      winnerId?: unknown;
      stageId?: unknown;
      selections?: { entrantId?: unknown; characterId?: unknown }[];
      entrant1Score?: unknown;
      entrant2Score?: unknown;
    }[];
    for (const g of gameData) {
      if (!Number.isInteger(g.gameNum) || (g.gameNum as number) < 1) {
        return { status: 200, body: gqlErrorBody('gameData entry missing valid gameNum') };
      }
      if (!entrantIds.includes(Number(g.winnerId))) {
        return { status: 200, body: gqlErrorBody(`winnerId ${g.winnerId} is not an entrant in this set`) };
      }
      // Selections must name entrants of this set and a positive character id
      // (the real API rejects both otherwise).
      for (const s of g.selections ?? []) {
        if (!entrantIds.includes(Number(s.entrantId))) {
          return { status: 200, body: gqlErrorBody(`selection entrantId ${s.entrantId} is not an entrant in this set`) };
        }
        if (!Number.isInteger(s.characterId) || (s.characterId as number) < 1) {
          return { status: 200, body: gqlErrorBody('selection missing valid characterId') };
        }
      }
      if (g.stageId !== undefined && (!Number.isInteger(g.stageId) || (g.stageId as number) < 1)) {
        return { status: 200, body: gqlErrorBody('gameData entry has invalid stageId') };
      }
      for (const k of ['entrant1Score', 'entrant2Score'] as const) {
        if (g[k] !== undefined && (!Number.isInteger(g[k]) || (g[k] as number) < 0)) {
          return { status: 200, body: gqlErrorBody(`gameData entry has invalid ${k}`) };
        }
      }
    }

    // Full overwrite, as the probe confirmed: old rows deleted, fresh ids.
    set.games = gameData.map((g) => ({
      id: this.nextGameId++,
      orderNum: g.gameNum as number,
      winnerId: Number(g.winnerId),
      ...(g.stageId !== undefined ? { stageId: Number(g.stageId) } : {}),
      ...(g.entrant1Score !== undefined ? { entrant1Score: Number(g.entrant1Score) } : {}),
      ...(g.entrant2Score !== undefined ? { entrant2Score: Number(g.entrant2Score) } : {}),
      ...(g.selections?.length
        ? { selections: g.selections.map((s) => ({ entrantId: Number(s.entrantId), characterId: Number(s.characterId) })) }
        : {}),
    }));

    if (variables.winnerId != null) {
      if (!entrantIds.includes(Number(variables.winnerId))) {
        return { status: 200, body: gqlErrorBody(`winnerId ${variables.winnerId} is not an entrant in this set`) };
      }
      set.state = 3;
    }
    return {
      status: 200,
      body: JSON.stringify({ data: { reportBracketSet: [{ id: set.id, state: set.state }] } }),
    };
  }

  private adminTournaments(variables: Record<string, unknown>): { status: number; body: string } {
    const page = Number(variables.page);
    const perPage = Number(variables.perPage);
    const listed = this.tournaments.filter((t) => t.published);
    const totalPages = Math.max(1, Math.ceil(listed.length / perPage));
    const nodes = listed
      .slice((page - 1) * perPage, page * perPage)
      .map((t) => ({ slug: t.slug, shortSlug: t.shortSlug, name: t.name, startAt: t.startAt }));
    return {
      status: 200,
      body: JSON.stringify({ data: { currentUser: { tournaments: { pageInfo: { totalPages }, nodes } } } }),
    };
  }

  private tournament(variables: Record<string, unknown>): { status: number; body: string } {
    // Full slugs only: the relay never asks this query to resolve a short URL.
    const t = this.tournaments.find((x) => x.slug === variables.slug) ?? null;
    const body = t && { id: t.id, name: t.name, slug: t.slug, events: t.events, streams: t.streams };
    return { status: 200, body: JSON.stringify({ data: { tournament: body } }) };
  }

  private resetSet(variables: Record<string, unknown>): { status: number; body: string } {
    const set = this.findSet(variables);
    if (!set) return { status: 200, body: gqlErrorBody('Set not found') };
    set.state = 1;
    set.games = [];
    // set.stream stays: the real resetSet does not clear a stream assignment
    // (verified live 2026-09-20, design.md section 5.6).
    return { status: 200, body: JSON.stringify({ data: { resetSet: { id: set.id, state: set.state } } }) };
  }
}

// ---- default fixture: the shape of the real test tournament ----
// Event 1613010, 16 dummy entrants Alpha..Papa. Pool 1 is started (numeric
// set ids like the probe's 107949994); pool 2 (3292311) is deliberately
// unstarted, so its sets have preview_* string ids (design.md R8).
// Matches the live event's shape (2026-09-20 run): sets are Bo5 and the
// first round is "Winners Quarter-Final".

export const FIXTURE_EVENT_ID = 1613010;
export const FIXTURE_TOKEN = 'test-token';

const TAGS = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel',
  'India', 'Juliett', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa',
];

export function entrant(n: number): FakeEntrant {
  return { id: 9000 + n, name: TAGS[n - 1] ?? `Entrant${n}` };
}

function set(
  id: number | string,
  round: number,
  fullRoundText: string,
  p1: number | null,
  p2: number | null,
  totalGames = 5,
): FakeSet {
  return {
    id,
    state: 1,
    round,
    fullRoundText,
    totalGames,
    slots: [p1 ? entrant(p1) : null, p2 ? entrant(p2) : null],
    games: [],
    stream: null,
  };
}

/** Fresh mutable fixture per test; entrants 1..8 in pool 1, 9..16 in preview pool 2. */
export function defaultFixture(): FakeSet[] {
  return [
    set(107949994, 1, 'Winners Quarter-Final', 1, 2),
    set(107949995, 1, 'Winners Quarter-Final', 3, 4),
    set(107949996, 1, 'Winners Quarter-Final', 5, 6),
    set(107949997, 1, 'Winners Quarter-Final', 7, 8),
    set(107949998, 2, 'Winners Semi-Final', null, null), // entrants TBD: must be filtered out
    set(107950001, -1, 'Losers Round 1', null, null),
    set(107950002, 3, 'Winners Final', null, null),
    set(107950003, -3, 'Losers Final', null, null),
    set(107950004, 4, 'Grand Final', null, null),
    // Unstarted pool 2: preview ids, both entrants known but unreportable (R8).
    set('preview_3292311_1_1', 1, 'Winners Quarter-Final', 9, 10),
    set('preview_3292311_1_2', 1, 'Winners Quarter-Final', 11, 12),
  ];
}

// ---- admin tournaments: the shape probe.ts --mine / --tournament recorded ----
// 2026-09-25. The test tournament has three Melee singles events and two
// streams, so "Melee Singles" + "SFMelee" is the unambiguous pick; it is
// unpublished, so no list returns it and the relay is given its full slug.
// The weekly Abbey tournaments are in the admin list (newest first) and each
// week's gets the "abbey" short URL.

export const FIXTURE_TOURNAMENT = 'tournament/sf-melee-discord-test';

/** Melee @ Abbey Tavern #160's real start (2026-09-30T01:30:00Z, probe.ts --tournament); weeks step back from it. */
export const ABBEY_160_START = 1790731800;
const WEEK = 7 * 24 * 60 * 60;
export const FIXTURE_EVENT_NAME = 'Melee Singles';
export const FIXTURE_STREAM_NAME = 'SFMelee';
export const FIXTURE_STREAM_ID = 1358079;

export function defaultTournaments(): FakeTournament[] {
  const abbey = (n: number, short: string): FakeTournament => ({
    slug: `tournament/melee-abbey-tavern-${n}`,
    shortSlug: short,
    published: true,
    // Weekly on Tuesdays: #160 starts at ABBEY_160_START, each earlier week 7 days before.
    startAt: ABBEY_160_START - (160 - n) * WEEK,
    id: 956000 + n,
    name: `Melee @ Abbey Tavern #${n}`,
    events: [
      { id: 1717000 + n * 3, name: 'Melee Doubles (6:30 pm Start)', type: 5, videogame: { id: 1 } },
      { id: 1717001 + n * 3, name: 'Melee Singles! (7:30 Start)', type: 1, videogame: { id: 1 } },
      { id: 1717002 + n * 3, name: 'Melee Waitlist', type: 1, videogame: { id: 1 } },
    ],
    streams: [
      { id: 1420000 + n * 2, streamName: 'SFMelee' },
      { id: 1420001 + n * 2, streamName: 'sidestream' },
    ],
  });
  return [
    abbey(160, 'abbey'),
    abbey(159, 'abbey159'),
    abbey(158, 'abbey158'),
    {
      slug: 'tournament/sf-melee-discord-test',
      shortSlug: 'sfmeleetest',
      published: false,
      startAt: 1777316400, // 2026-04-27T19:00:00Z, as the probe recorded
      id: 905882,
      name: 'SF Melee Discord Test',
      events: [
        { id: FIXTURE_EVENT_ID, name: 'Melee Singles! (7:30 Start)', type: 1, videogame: { id: 1 } },
        { id: 1613012, name: 'Melee Ladder (9:30pm)', type: 1, videogame: { id: 1 } },
        { id: 1613011, name: 'Melee Waitlist', type: 1, videogame: { id: 1 } },
      ],
      streams: [
        { id: FIXTURE_STREAM_ID, streamName: 'SFMelee' },
        { id: 1358080, streamName: 'sidestream' },
      ],
    },
  ];
}

export function makeFake(sets: FakeSet[] = defaultFixture()): FakeStartgg {
  return new FakeStartgg(FIXTURE_TOKEN, FIXTURE_EVENT_ID, sets);
}

/** Peak events in any sliding 60 s window (the N2 number for calls[]). */
export function peakPerMinute(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let peak = 0;
  for (let lo = 0, hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] > 60_000) lo++;
    peak = Math.max(peak, hi - lo + 1);
  }
  return peak;
}

/**
 * Load-test fixture (scripts/sim-wii.ts, scripts/serve-fake.ts): `count`
 * Bo3 pending sets, all with both entrants known, 64 per winners round --
 * enough that 12 stations churning for 10 minutes never run dry.
 */
export function loadFixture(count: number): FakeSet[] {
  const sets: FakeSet[] = [];
  for (let i = 0; i < count; i++) {
    sets.push({
      id: 300_000 + i,
      state: 1,
      round: Math.floor(i / 64) + 1,
      fullRoundText: `Winners Round ${Math.floor(i / 64) + 1}`,
      totalGames: 3,
      slots: [entrant((i * 2) % 16 + 1), entrant((i * 2 + 1) % 16 + 1)],
      games: [],
      stream: null,
    });
  }
  return sets;
}
