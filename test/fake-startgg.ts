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
//   - resetSet: state -> 1, games cleared.
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
  selections: unknown;
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

export interface RecordedCall {
  op: string;
  at: number; // Date.now()
  variables: Record<string, unknown>;
}

type FailMode = '5xx' | 'gqlError';

const OPS = ['eventSets', 'markSetInProgress', 'assignStream', 'reportBracketSet', 'resetSet'] as const;
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

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}/gql/alpha`;
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
    }
  }

  private classify(query: string): Op | null {
    for (const op of OPS) {
      if (op === 'eventSets') continue;
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
      selections?: unknown;
    }[];
    for (const g of gameData) {
      if (!Number.isInteger(g.gameNum) || (g.gameNum as number) < 1) {
        return { status: 200, body: gqlErrorBody('gameData entry missing valid gameNum') };
      }
      if (!entrantIds.includes(Number(g.winnerId))) {
        return { status: 200, body: gqlErrorBody(`winnerId ${g.winnerId} is not an entrant in this set`) };
      }
    }

    // Full overwrite, as the probe confirmed: old rows deleted, fresh ids.
    set.games = gameData.map((g) => ({
      id: this.nextGameId++,
      orderNum: g.gameNum as number,
      winnerId: Number(g.winnerId),
      selections: g.selections ?? null,
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

  private resetSet(variables: Record<string, unknown>): { status: number; body: string } {
    const set = this.findSet(variables);
    if (!set) return { status: 200, body: gqlErrorBody('Set not found') };
    set.state = 1;
    set.games = [];
    set.stream = null;
    return { status: 200, body: JSON.stringify({ data: { resetSet: { id: set.id, state: set.state } } }) };
  }
}

// ---- default fixture: the shape of the real test tournament ----
// Event 1613010, 16 dummy entrants Alpha..Papa. Pool 1 is started (numeric
// set ids like the probe's 107949994); pool 2 (3292311) is deliberately
// unstarted, so its sets have preview_* string ids (design.md R8).

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
  totalGames = 3,
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
    set(107949994, 1, 'Winners Round 1', 1, 2),
    set(107949995, 1, 'Winners Round 1', 3, 4),
    set(107949996, 1, 'Winners Round 1', 5, 6),
    set(107949997, 1, 'Winners Round 1', 7, 8),
    set(107949998, 2, 'Winners Semi-Final', null, null), // entrants TBD: must be filtered out
    set(107950001, -1, 'Losers Round 1', null, null),
    set(107950002, 3, 'Winners Final', null, null),
    set(107950003, -3, 'Losers Final', null, null, 5),
    set(107950004, 4, 'Grand Final', null, null, 5),
    // Unstarted pool 2: preview ids, both entrants known but unreportable (R8).
    set('preview_3292311_1_1', 1, 'Winners Round 1', 9, 10),
    set('preview_3292311_1_2', 1, 'Winners Round 1', 11, 12),
  ];
}

export function makeFake(sets: FakeSet[] = defaultFixture()): FakeStartgg {
  return new FakeStartgg(FIXTURE_TOKEN, FIXTURE_EVENT_ID, sets);
}
