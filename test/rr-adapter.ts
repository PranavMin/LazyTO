// rr-adapter.ts -- Replay Reporter's conformance bundle (test/rr-conformance/,
// see its BUNDLE.md) as LazyTO's inputs. A fixture holds Replay Reporter's
// renderer state for one set; this turns it into what LazyTO would have
// gathered for the same set: the event as resolve.ts finds it, the set as the
// cache and START_SET's markSetInProgress give it, the phase group facts of
// the REST call, END_SET's completedAt and stream, and each game as the kiosk
// reports it (game_result) with its replay. rr-conformance.test.ts feeds that
// to the archive and compares with Replay Reporter's own output.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameResult } from '../generated/wire.js';
import type { SetZipInput } from '../src/setzip.js';

export const BUNDLE = join(import.meta.dirname, 'rr-conformance');

export function bundleJson<T = any>(...path: string[]): T {
  return JSON.parse(readFileSync(join(BUNDLE, ...path), 'utf8')) as T;
}

export function bundleFile(...path: string[]): Buffer {
  return readFileSync(join(BUNDLE, ...path));
}

interface RrParticipant {
  id: number;
  displayName: string;
  prefix: string;
  pronouns: string;
}

/** A fixture: Replay Reporter's renderer state (the fields read here). */
export interface Fixture {
  name: string;
  startggTournament: { slug: string; name: string; location: string | null };
  selectedSetChain: {
    event: { id: number; name: string; slug: string; hasSiblings: boolean };
    phase: { id: number; name: string; hasSiblings: boolean };
    phaseGroup: {
      id: number;
      name: string;
      bracketType: number;
      hasSiblings: boolean;
      waveId: number | null;
      winnersTargetPhaseId: number | null;
    };
  };
  selectedSet: {
    id: number | string;
    round: number;
    fullRoundText: string;
    entrant1Id: number;
    entrant1Participants: RrParticipant[];
    entrant2Id: number;
    entrant2Participants: RrParticipant[];
    ordinal: number | null;
  };
  report: {
    updatedSetFields: {
      completedAtMs: number;
      stream: { id: number; domain: string; path: string } | null;
    };
  } | null;
  clock: string;
  games: { replay: string; ports: { port: number; entrant: number; participant: number }[] }[];
}

/** RR's parse of a replay (parse.json). */
export interface RrReplay {
  fileName: string;
  sha256: string;
  startAt: string;
  lastFrame: number;
  stageId: number;
  isTeams: boolean;
  players: {
    port: number;
    playerType: number;
    externalCharacterId: number | null;
    costumeIndex: number | null;
    teamId: number;
    isWinner: boolean;
    nametag: string;
    displayName: string;
  }[];
}

export function fixture(name: string): Fixture {
  return bundleJson<Fixture>('fixtures', `${name}.json`);
}

export function rrReplay(fileName: string): RrReplay {
  const r = bundleJson<{ replays: RrReplay[] }>('parse.json').replays.find(
    (x) => x.fileName === fileName,
  );
  if (!r) throw new Error(`no replay ${fileName} in parse.json`);
  return r;
}

/**
 * Each fixture's best-of, as its description states it ("Bo3 won 2-0", "Bo5
 * won 3-2", ...): what LazyTO's Wiis would have played. 06r and 06z (two
 * ties and a win, reported) are the round robin's Bo3, won 2-1 once the ties
 * are reported (see winnerSlot).
 */
export const BEST_OF: Record<string, number> = {
  '01-bo3-2-0': 3,
  '02-bo5-3-2-charswitch': 5,
  '03-bo3-port-swap': 3,
  '04-sjis-long-tags': 3,
  '05-gfr-edge-names': 3,
  '06r-reported-ties': 3,
  '06z-reported-no-completedat': 3,
  '07-bo5-3-1-fixed-ports': 5,
  '08-e2e-de4-wf': 3,
  '09-e2e-de4-gfr': 3,
};

/** A replay's file name stamp as its replay_id: the gameStartTime, UTC (archive.ts replayStamp). */
export function replayId(fileName: string): number {
  const m = /_(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)\.slp$/.exec(fileName);
  if (!m) throw new Error(`no stamp in ${fileName}`);
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) / 1000;
}

/**
 * The entrant (1 or 2) the kiosk reports as game i's winner: the one on the
 * port Replay Reporter's parse names the winner. A game the replay calls a
 * tie (06r's two 0%-0% timeouts) LazyTO cannot report as one: the TO scored
 * it by hand, for entrant 1.
 */
export function winnerSlot(f: Fixture, i: number): 1 | 2 {
  const g = f.games[i]!;
  const winner = rrReplay(g.replay).players.find((p) => p.isWinner);
  if (!winner) return 1;
  const entrant = g.ports.find((p) => p.port === winner.port)?.entrant;
  if (entrant !== 1 && entrant !== 2) throw new Error(`${f.name} game ${i + 1}: winner unassigned`);
  return entrant;
}

/** Game i as the kiosk reports it: ports from the L + R claim, characters and stage from the match, no stocks. */
export function gameResult(f: Fixture, i: number): GameResult {
  const g = f.games[i]!;
  const replay = rrReplay(g.replay);
  const portOf = (entrant: number) => g.ports.find((p) => p.entrant === entrant)!.port - 1;
  const charOf = (entrant: number) => replay.players[portOf(entrant)]!.externalCharacterId!;
  return {
    winner_slot: winnerSlot(f, i),
    p1_char: charOf(1),
    p2_char: charOf(2),
    stage: replay.stageId,
    p1_stocks: 0xff,
    p2_stocks: 0xff,
    p1_costume: 0xff,
    p2_costume: 0xff,
    p1_port: portOf(1),
    p2_port: portOf(2),
    replay_id: replayId(g.replay),
  };
}

/** The participants as markSetInProgress gives them: Replay Reporter's displayName is the gamerTag. */
export function participants(p: RrParticipant[]) {
  return p.map((x) => ({
    id: x.id,
    gamerTag: x.displayName,
    prefix: x.prefix,
    pronouns: x.pronouns,
  }));
}

/**
 * Everything LazyTO's archive builds the fixture's zip from. Replay Reporter
 * adds 1 to a grand final reset's round; the cache holds start.gg's own, so
 * that is taken off here for the archive to add back. The event's phase
 * count and the phase's group count only matter as more than one or not.
 */
export function setZipInput(f: Fixture): SetZipInput {
  const chain = f.selectedSetChain;
  const s = f.selectedSet;
  if (typeof s.id !== 'number') throw new Error(`${f.name}: LazyTO's set ids are numeric`);
  const updated = f.report?.updatedSetFields;
  return {
    event: {
      tournamentName: f.startggTournament.name,
      tournamentLocation: f.startggTournament.location,
      eventId: chain.event.id,
      eventName: chain.event.name,
      eventSlug: chain.event.slug,
      eventHasSiblings: chain.event.hasSiblings,
      eventPhaseCount: chain.phase.hasSiblings ? 2 : 1,
    },
    set: {
      id: s.id,
      round: s.fullRoundText === 'Grand Final Reset' ? s.round - 1 : s.round,
      fullRoundText: s.fullRoundText,
      bestOf: BEST_OF[f.name]!,
      phaseGroup: {
        id: chain.phaseGroup.id,
        displayIdentifier: chain.phaseGroup.name,
        bracketType: null,
        wave: chain.phaseGroup.waveId === null ? null : { id: chain.phaseGroup.waveId },
        phase: {
          id: chain.phase.id,
          name: chain.phase.name,
          groupCount: chain.phaseGroup.hasSiblings ? 2 : 1,
          phaseOrder: 1,
        },
      },
      p1: { id: s.entrant1Id, tag: s.entrant1Participants[0]!.displayName },
      p2: { id: s.entrant2Id, tag: s.entrant2Participants[0]!.displayName },
    },
    participants: [participants(s.entrant1Participants), participants(s.entrant2Participants)],
    phaseGroup: {
      bracketType: chain.phaseGroup.bracketType,
      name: chain.phaseGroup.name,
      waveId: chain.phaseGroup.waveId,
      winnersTargetPhaseId: chain.phaseGroup.winnersTargetPhaseId,
      ordinal: s.ordinal,
    },
    report: {
      // No completedAt: the relay's clock at END_SET, as Replay Reporter's Date.now() at copy.
      completedMs: updated?.completedAtMs || Date.parse(f.clock),
      stream: updated?.stream ?? null,
    },
    games: f.games.map((g, i) => ({
      result: gameResult(f, i),
      replay: bundleFile('replays', g.replay),
    })),
  };
}
