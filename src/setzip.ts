// setzip.ts -- one finished set as the zip Replay Reporter for Slippi writes
// when it reports and copies a set with its default settings (v2.7.0: output
// ZIP, with context, display names, file names and start times), filled with
// what LazyTO itself reported. archive.ts decides when; this builds it, from
// the set's records alone (no clock, no disk), so the conformance tests can
// run it on Replay Reporter's own fixtures (test/rr-conformance/).
//
// Replay Reporter's code this follows: src/renderer/App.tsx onCopy (names,
// context.json, the re-time) and src/main/replay.ts writeReplays (display
// names, startAt, the zip). docs/redesign.md, The zip and Lucky Stats, has
// the decision. Copied from it, byte for byte:
//   - the zip name '{phaseOrEvent} {roundShort} - {playersChars}' and each
//     entry's '{ordinal} - {playersChars} - {stage}.slp' (names.ts), with its
//     character and stage names and its sanitize-filename;
//   - context.json: its keys in its order, minified, context.json first;
//     written only when every player of every game has a name;
//   - the zip's header fields (zip.ts);
//   - each replay's display names (slp.ts) and its metadata.startAt re-timed
//     so the last game ends at the reported set's completedAt.
// LazyTO's values where Replay Reporter's are wrong:
//   - each game's winner is the one LazyTO reported (game_result.winner_slot,
//     which includes LGL's tiebreak), not the one Replay Reporter works out
//     from the replay;
//   - the running score and finalScore count per player, so players who
//     swap ports between games keep their own score (Replay Reporter counts
//     per port slot and credits the wrong player);
//   - bestOf is the set's best-of, the one the Wiis played (Replay Reporter
//     derives it from the winner's game count);
//   - names are taken literally ("$&" in a tag stays "$&"), and display names
//     are encoded without corrupting double-byte characters and never spill
//     into the next port (names.ts, slp.ts).
// The game order is the report's (game N is game N on start.gg); Replay
// Reporter sorts its replays by startAt, which is the same order for a set
// played in order. Each game starts at its replay_id, the replay's own
// gameStartTime (UTC), where Replay Reporter reads the replay's zone-less
// startAt in its machine's local time; the two agree except across a
// daylight-saving change.
//
// Ported from Replay Reporter for Slippi (jmlee337/replay-manager-for-slippi,
// MIT).

import { NO_PORT, type GameResult } from '../generated/wire.js';
import type { CachedSet } from './cache.js';
import {
  RR_CHARACTER,
  RR_ENTRY_TEMPLATE,
  RR_STAGE,
  RR_ZIP_TEMPLATE,
  rrFill,
  rrRoundShort,
  rrSanitize,
} from './names.js';
import type { PhaseGroupFacts } from './phasegroup.js';
import { parseSlp, withDisplayNames, withStartAt } from './slp.js';
import type { StartedParticipant } from './startgg.js';
import { buildZip, type ZipEntry } from './zip.js';

/** Replay Reporter's frames-to-milliseconds divisor (src/common/constants.ts frameMsDivisor). */
const FRAME_MS_DIVISOR = 0.05994;

/** What the archive needs to know about an event (resolve.ts). */
export interface ArchiveEvent {
  tournamentName: string;
  tournamentLocation: string | null;
  eventId: number;
  eventName: string;
  eventSlug: string;
  eventHasSiblings: boolean;
  eventPhaseCount: number;
}

export interface ContextStream {
  id: number;
  domain: string;
  path: string;
}

/** Everything one set's zip is made of. */
export interface SetZipInput {
  event: ArchiveEvent;
  /** The set as the cache had it at START_SET. */
  set: Pick<CachedSet, 'id' | 'round' | 'fullRoundText' | 'bestOf' | 'phaseGroup' | 'p1' | 'p2'>;
  /** Entrant 1's and entrant 2's participants, from START_SET's markSetInProgress. */
  participants: [StartedParticipant[], StartedParticipant[]];
  /** start.gg's REST phase group for the set, or why there is none (no context.json then). */
  phaseGroup: PhaseGroupFacts | { error: string } | null;
  /** From END_SET: the re-time's anchor (completedAt, else the relay's clock then) and the set's stream. */
  report: { completedMs: number; stream: ContextStream | null };
  /** In game order: each game as last reported and its replay's bytes. */
  games: { result: GameResult; replay: Buffer }[];
}

export interface SetZip {
  /** The zip's file name without ".zip", sanitized; the caller makes it unique in its folder. */
  name: string;
  zip: Buffer;
  /** Why there is no context.json; "" when there is one. */
  note: string;
}

/** A port's player assignment: Replay Reporter's playerOverrides, here from the L + R claim. */
interface Override {
  displayName: string;
  entrantId: number;
  participantId: number;
  prefix: string;
  pronouns: string;
  /** The entrant (1 or 2) the port was claimed for: the score is theirs. */
  entrant: 1 | 2;
}

interface Player {
  port: number; // 0-3
  isPlayer: boolean; // human or CPU
  character: number;
  teamId: number;
  nametag: string;
  slpName: string; // the replay's own display name, empty in a Wii replay
  override: Override | null;
}

/** Replay Reporter's per-game, per-port naming record (App.tsx NameObj). */
interface NameObj {
  characterName: string | undefined;
  displayName: string;
  entrantId: number;
  participantId: number;
  nametag: string;
}

interface CombinedNameObj {
  characterNames: (string | undefined)[];
  displayName: string;
  entrantId: number;
  participantId: number;
  nametags: string[];
}

/** Entrant 1's and 2's CSS ports, or null unless both are known (0-3) and differ. */
export function entrantPorts(g: GameResult): [number, number] | null {
  const ok = (p: number) => p !== NO_PORT && p >= 0 && p <= 3;
  return ok(g.p1_port) && ok(g.p2_port) && g.p1_port !== g.p2_port ? [g.p1_port, g.p2_port] : null;
}

/** The set's round as Replay Reporter keeps it: the grand final reset one past the grand final. */
export function rrRound(set: { round: number; fullRoundText: string }): number {
  return set.fullRoundText === 'Grand Final Reset' ? set.round + 1 : set.round;
}

/** start.gg's stream as Replay Reporter stores it, or null without an id, source and name. */
export function rrStream(
  s: { id: number; streamName: string | null; streamSource: string | null } | null | undefined,
): ContextStream | null {
  return s?.id && s.streamSource && s.streamName
    ? { id: s.id, domain: s.streamSource.toLowerCase(), path: s.streamName }
    : null;
}

/**
 * Replay Reporter's re-time (App.tsx onCopy): every game moves by one offset
 * so that the last game, at its length in frames rounded to milliseconds,
 * ends at completedMs. Returns each game's new start (ISO, 24 characters) and
 * the first one in ms.
 */
export function retime(
  games: { startMs: number; lastFrame: number }[],
  completedMs: number,
): { startTimes: string[]; startMs: number } {
  const last = games[games.length - 1]!;
  const offsetMs =
    completedMs - last.startMs - Math.round((last.lastFrame + 124) / FRAME_MS_DIVISOR);
  return {
    startTimes: games.map((g) => new Date(g.startMs + offsetMs).toISOString()),
    startMs: games[0]!.startMs + offsetMs,
  };
}

export function buildSetZip(input: SetZipInput, now: Date): SetZip {
  const { set, event, games } = input;
  if (games.length === 0) throw new Error('a set without games');
  const infos = games.map((g) => parseSlp(g.replay));
  const unfinished = infos.findIndex((info) => !info.complete);
  if (unfinished >= 0) throw new Error(`game ${unfinished + 1}'s replay is not complete`);

  // Each game's four ports, with the entrant claimed on each player port.
  const players: Player[][] = games.map((g, i) => {
    const claimed = entrantPorts(g.result);
    return infos[i]!.ports.map((p): Player => {
      const isPlayer = p.type === 0 || p.type === 1;
      const at = isPlayer && claimed ? claimed.indexOf(p.port) : -1;
      const entrant = at === 0 ? 1 : at === 1 ? 2 : null;
      // A singles entrant's one participant (Replay Reporter's chip on the port).
      const participant = entrant ? input.participants[entrant - 1][0] : undefined;
      return {
        port: p.port,
        isPlayer,
        character: p.character,
        teamId: p.teamId,
        nametag: p.nametag,
        slpName: p.displayName,
        override:
          entrant && participant
            ? {
                displayName: participant.gamerTag,
                entrantId: entrant === 1 ? set.p1.id : set.p2.id,
                participantId: participant.id,
                prefix: participant.prefix,
                pronouns: participant.pronouns,
                entrant,
              }
            : null,
      };
    });
  });

  // ---- names (App.tsx onCopy, the default templates) ----

  let allEntrantIdsSet = true;
  const nameObjs: NameObj[][] = players.map((ports) =>
    ports.map((p): NameObj => {
      if (!p.isPlayer) {
        return { characterName: '', displayName: '', entrantId: 0, participantId: 0, nametag: '' };
      }
      if (!p.override?.entrantId) allEntrantIdsSet = false;
      return {
        characterName: RR_CHARACTER.get(p.character),
        displayName: p.override?.displayName || p.slpName,
        entrantId: p.override?.entrantId ?? 0,
        participantId: p.override?.participantId ?? 0,
        nametag: p.nametag,
      };
    }),
  );
  const combined = combinedNames(nameObjs, allEntrantIdsSet);
  const sides = input.participants.map((parts) =>
    parts.flatMap((part) => combined.filter((c) => c.participantId === part.id).slice(0, 1)),
  );
  const playersOnly = sides.map((s) => s.map(combinedToPlayerOnly).join(' + ')).join(' vs ');
  const playersChars = sides.map((s) => s.map(combinedToPlayerChar).join(' + ')).join(' vs ');
  const roundShort = rrRoundShort(set.fullRoundText);
  const pg = set.phaseGroup;
  const phaseOrEvent = event.eventPhaseCount > 1 && pg ? pg.phase.name : event.eventName;
  // Replay Reporter fills every placeholder it knows, in its order; for its
  // default zip template only these can match: the others come before any
  // value that could contain one.
  const name = rrSanitize(
    rrFill(RR_ZIP_TEMPLATE, [
      ['{roundShort}', roundShort],
      ['{phaseOrEvent}', phaseOrEvent],
      ['{playersOnly}', playersOnly],
      ['{playersChars}', playersChars],
      ['{singlesChars}', combined.length === 4 ? playersOnly : playersChars],
    ]),
  );
  if (!name) throw new Error('the zip name is empty once sanitized');

  const entryNames = nameObjs.map((game, i) => {
    const named = game.filter((n) => n.characterName);
    const only = named.map(nameObjToPlayerOnly).join(', ');
    const chars = named.map(nameObjToPlayerChar).join(', ');
    return rrSanitize(
      rrFill(RR_ENTRY_TEMPLATE, [
        ['{stage}', RR_STAGE.get(infos[i]!.stage) || ''],
        ['{ordinal}', String(i + 1)],
        ['{playersOnly}', only],
        ['{playersChars}', chars],
        ['{singlesChars}', nameObjs.length === 4 ? only : chars],
      ]) + '.slp',
    );
  });

  // ---- times ----

  const { startTimes, startMs } = retime(
    games.map((g, i) => ({ startMs: g.result.replay_id * 1000, lastFrame: infos[i]!.lastFrame! })),
    input.report.completedMs,
  );

  // ---- context.json ----

  // Replay Reporter writes context.json only if every player it puts in a
  // slot has a name.
  const slots = players.map(slotsOf);
  const missingName = slots.findIndex((game) =>
    game.some((slot) => slot.some((p) => !(p.override?.displayName || p.slpName))),
  );
  let note = '';
  let context: Record<string, unknown> | null = null;
  if (missingName >= 0) {
    note = `no context.json (game ${missingName + 1} has a player no L + R claim names)`;
  } else if (input.phaseGroup === null || 'error' in input.phaseGroup || !pg) {
    const why = input.phaseGroup && 'error' in input.phaseGroup ? input.phaseGroup.error : 'none';
    note = `no context.json (start.gg phase group: ${why})`;
  } else {
    context = {
      bestOf: set.bestOf,
      durationMs: infos
        .map((info) => Math.ceil((info.lastFrame! + 124) / FRAME_MS_DIVISOR))
        .reduce((a, b) => a + b, 0),
      ...scores(slots, games),
      players: {
        entrant1: sides[0]!.map((c) => ({ name: c.displayName, characters: c.characterNames })),
        entrant2: sides[1]!.map((c) => ({ name: c.displayName, characters: c.characterNames })),
      },
      startMs,
      startgg: {
        tournament: { name: event.tournamentName, location: event.tournamentLocation },
        event: {
          id: event.eventId,
          name: event.eventName,
          slug: event.eventSlug,
          hasSiblings: event.eventHasSiblings,
        },
        phase: { id: pg.phase.id, name: pg.phase.name, hasSiblings: event.eventPhaseCount > 1 },
        phaseGroup: {
          id: pg.id,
          name: input.phaseGroup.name,
          bracketType: input.phaseGroup.bracketType,
          hasSiblings: (pg.phase.groupCount ?? 0) > 1,
          waveId: input.phaseGroup.waveId,
          winnersTargetPhaseId: input.phaseGroup.winnersTargetPhaseId,
        },
        set: {
          id: set.id,
          internalId: set.id,
          fullRoundText: set.fullRoundText,
          ordinal: input.phaseGroup.ordinal,
          round: rrRound(set),
          stream: input.report.stream,
        },
      },
    };
  }

  // ---- the zip ----

  const entries: ZipEntry[] = games.map((g, i) => ({
    name: entryNames[i]!,
    data: withStartAt(
      withDisplayNames(
        g.replay,
        players[i]!.map((p) => (p.isPlayer && p.override?.displayName) || null),
      ),
      startTimes[i]!,
    ),
    date: now,
  }));
  if (context) {
    entries.unshift({
      name: 'context.json',
      data: Buffer.from(JSON.stringify(context)),
      date: now,
    });
  }
  return { name, zip: buildZip(entries), note };
}

/**
 * context.json's scores and finalScore. Each game has two slots in port
 * order, as in Replay Reporter: the lowest player port, then the next (in a
 * teams game a slot also takes its first player's teammates). A slot's score
 * is its player's games won before that game, finalScore's after the last.
 */
function scores(
  slots: Player[][][],
  games: { result: GameResult }[],
): { scores: unknown[]; finalScore: unknown } {
  const wins = [0, 0, 0]; // by entrant 1, 2 (index 0 unused)
  const winsOf = (slot: Player[]) => (slot[0]?.override ? wins[slot[0].override.entrant]! : 0);
  const out = games.map((g, i) => {
    const row = slots[i]!.map((slot) => ({ ...slotFields(slot), score: winsOf(slot) }));
    const w = g.result.winner_slot;
    if (w === 1 || w === 2) wins[w]!++;
    return { slots: row };
  });
  const last = slots[slots.length - 1]!;
  return {
    scores: out,
    finalScore: { slots: last.map((slot) => ({ ...slotFields(slot), score: winsOf(slot) })) },
  };
}

/** The game's two slots of players (App.tsx onCopy: usedK, teamId). */
function slotsOf(ports: Player[]): Player[][] {
  const used = new Set<number>();
  const teams = ports.some((p) => p.isPlayer && p.teamId !== -1);
  return [0, 1].map(() => {
    const slot: Player[] = [];
    let teamId: number | undefined;
    for (const p of ports) {
      if (!p.isPlayer || used.has(p.port) || (teamId !== undefined && teamId !== p.teamId))
        continue;
      slot.push(p);
      used.add(p.port);
      if (!teams) break;
      if (teamId === undefined) teamId = p.teamId;
    }
    return slot;
  });
}

function slotFields(slot: Player[]) {
  return {
    displayNames: slot.map((p) => p.override?.displayName || p.slpName),
    ports: slot.map((p) => p.port + 1),
    prefixes: slot.map((p) => p.override?.prefix ?? ''),
    pronouns: slot.map((p) => p.override?.pronouns ?? ''),
  };
}

/**
 * Each player of game 1 with their characters (and nametags) over the set,
 * in order of first use (App.tsx onCopy namesObjs). With every player of
 * every game claimed, a later game's player is found by entrant and
 * participant; otherwise Replay Reporter goes by port.
 */
function combinedNames(nameObjs: NameObj[][], allEntrantIdsSet: boolean): CombinedNameObj[] {
  const namesObjs = nameObjs[0]!.map((n) => ({
    characterNames: new Map<string | undefined, number>([[n.characterName, 0]]),
    displayName: n.displayName,
    entrantId: n.entrantId,
    participantId: n.participantId,
    nametags: new Map<string, number>([[n.nametag, 0]]),
  }));
  for (let i = 1; i < nameObjs.length; i++) {
    for (let j = 0; j < nameObjs[i]!.length; j++) {
      const n = nameObjs[i]![j]!;
      if (allEntrantIdsSet) {
        const existing = namesObjs.find(
          (o) => o.entrantId === n.entrantId && o.participantId === n.participantId,
        );
        // Replay Reporter throws on a claimed player game 1 does not have.
        if (!existing) continue;
        if (n.characterName && !existing.characterNames.has(n.characterName)) {
          existing.characterNames.set(n.characterName, i);
        }
        if (n.nametag && !existing.nametags.has(n.nametag)) existing.nametags.set(n.nametag, i);
      } else {
        const o = namesObjs[j]!;
        if (n.characterName) {
          o.displayName = n.displayName;
          o.entrantId = n.entrantId;
          if (!o.characterNames.has(n.characterName)) o.characterNames.set(n.characterName, i);
        }
        // Replay Reporter indexes this by game and orders by port here (and
        // throws past four games); a port's nametags are kept by game.
        if (n.nametag && !o.nametags.has(n.nametag)) o.nametags.set(n.nametag, i);
      }
    }
  }
  return namesObjs
    .map((o) => ({
      displayName: o.displayName,
      entrantId: o.entrantId,
      participantId: o.participantId,
      characterNames: [...o.characterNames.entries()]
        .sort(([, a], [, b]) => a - b)
        .map((e) => e[0]),
      nametags: [...o.nametags.entries()].sort(([, a], [, b]) => a - b).map((e) => e[0]),
    }))
    .filter((o) => o.characterNames.some((c) => c));
}

function nameObjToPlayerOnly(n: NameObj): string {
  if (n.displayName) return n.displayName;
  if (n.nametag) return n.nametag;
  return n.characterName!;
}

function combinedToPlayerOnly(c: CombinedNameObj): string {
  if (c.displayName) return c.displayName;
  if (c.nametags.length > 0) return c.nametags.join(', ');
  return c.characterNames.join(', ');
}

function nameObjToPlayerChar(n: NameObj): string {
  if (n.displayName) return `${n.displayName} (${n.characterName})`;
  if (n.nametag) return `${n.characterName} (${n.nametag})`;
  return n.characterName!;
}

function combinedToPlayerChar(c: CombinedNameObj): string {
  if (c.displayName) return `${c.displayName} (${c.characterNames.join(', ')})`;
  if (c.nametags.length > 0) return `${c.characterNames.join(', ')} (${c.nametags.join(', ')})`;
  return c.characterNames.join(', ');
}
