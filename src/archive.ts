// archive.ts -- the set archive: every finished set whose games all have a
// replay becomes one zip of them, named from the config's templates
// (names.ts), each replay labelled with the players' tags, plus a
// context.json that links it to the start.gg set (the format Replay Reporter
// for Slippi writes and Lucky Stats' "Import Tournament Game Data" reads).
//
// How a replay is matched to its game (protocol v2, docs/redesign.md:
// Matching a replay to its game). Every reported game_result carries the
// entrants' ports and replay_id: the gameStartTime of its match's Slippi
// replay, whose file is Game_<Wii MAC>_<replay_id as UTC YYYYMMDDTHHMMSS>.slp
// on the beamer the game was reported through. That beamer is the one whose
// sync came from the report's source address (beamer.ts): its station_id,
// never "whoever is station N now". The beamers' files reach the laptop by
// their own syncs (collect.ts, rawstore.ts), in any order with the reports:
// a game binds when both are there. A game with replay_id 0 has no replay.
// The replay's stage, characters and costumes on their ports, and the
// stocks when the game sent them, are checked against the report and a
// mismatch is flagged, never refused: the id decides. Game N of the zip is
// the replay of game N of the last report.
//
// Placing a stored copy (placeFor): a finished replay a reported game names
// goes to raw/, anything else (a stray, an undone game's recording, an
// incomplete recording) to unmatched/. A late report that names an unmatched
// replay moves it to raw/. Raw copies are never deleted here.
//
// Zips. A set that ended is zipped once every game has a complete replay
// (D12: a set with a game without one gets no zip, so Lucky Stats never sees
// a short set; the status page lists it with the reason per game). A replay
// that arrives later, even at a later event, zips it then, or writes the
// zip again when a game's replay changed. Set records stay on disk in
// <archive>/.sets/<setId>.json for that, each with the event it belongs to.
// The archive never blocks or fails a Wii request: its errors go to the
// status page and the audit log.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NO_PORT, type GameResult } from '../generated/wire.js';
import type { CachedSet } from './cache.js';
import type { Folder, RawStore, StoredReplay } from './rawstore.js';
import { parseSlp, withDisplayNames, humanPorts, type SlpInfo } from './slp.js';
import { buildZip, type ZipEntry } from './zip.js';
import {
  fillName,
  shortCharacter,
  shortStage,
  tournamentNumber,
  type GameFields,
  type SetFields,
} from './names.js';
import { characterName } from './chars.js';
import { stageName } from './stages.js';

/** What the archive needs to know about an event (resolve.ts). */
export interface ArchiveEvent {
  tournamentName: string;
  tournamentLocation: string;
  eventId: number;
  eventName: string;
  eventSlug: string;
  eventHasSiblings: boolean;
  eventPhaseCount: number;
}

export interface BoundReplay {
  /** The stored copy (rawstore.ts StoredReplay.id) and where it was when bound. */
  id: string;
  path: string;
  sha256: string;
  lastFrame: number | null;
  complete: boolean;
  /** What disagrees with the report, or null. */
  mismatch: string | null;
}

export interface GameRecord {
  at: number; // when the relay first had this game (this replay_id) reported
  result: GameResult; // as last reported
  /** station_id of the beamer the game was reported through; null until that beamer has synced. */
  beamer: string | null;
  /** The report's source address: the beamer's, which a later sync names. */
  from: string;
  replay: BoundReplay | null;
}

export interface SetRecord {
  setId: number;
  station: number;
  set: CachedSet; // snapshot at START_SET: the set leaves the cache once completed
  event: ArchiveEvent;
  startedAt: number;
  games: GameRecord[]; // the last reported list, index 0 = game 1
  endedAt: number | null;
  /** The zip's file name in the archive folder, once written. */
  zip: string | null;
  /** The bound replays the zip was written from, to know when to write it again. */
  zipOf: string | null;
}

export interface ArchiveResult {
  setId: number;
  station: number;
  file: string; // zip path
  games: number; // replays in the zip
  at: number;
  note: string;
  /** Written again: a late replay, or a game's replay changed. */
  again: boolean;
}

/** A reported game without a usable replay, and why. */
export interface MissingReplay {
  game: number;
  why: string;
}

export interface ArchiveDeps {
  /** The archive folder: zips, .sets/, and the raw store's files. */
  dir: string;
  store: RawStore;
  /** The station_id of the beamer that synced from an address (beamer.ts). */
  beamerAt(address: string): string | undefined;
  setTemplate: string;
  gameTemplate: string;
  event: ArchiveEvent;
  audit: { record(event: Record<string, unknown>): void };
}

export class SetArchive {
  private readonly sets = new Map<number, SetRecord>(); // by set id
  private readonly results: ArchiveResult[] = [];

  constructor(private readonly deps: ArchiveDeps) {
    mkdirSync(join(deps.dir, '.sets'), { recursive: true });
    for (const f of readdirSync(join(deps.dir, '.sets'))) {
      if (!f.endsWith('.json')) continue;
      try {
        const r: unknown = JSON.parse(readFileSync(join(deps.dir, '.sets', f), 'utf8'));
        // A record an older relay wrote (protocol v1's game starts, or the
        // first v2 archive's per-set raw folder) is reported, not used.
        if (!isSetRecord(r)) throw new Error('not a set record of this relay version');
        this.sets.set(r.setId, r);
      } catch (e) {
        deps.audit.record({
          type: 'archive_error',
          file: f,
          error: `unreadable set record: ${String(e)}`,
        });
      }
    }
  }

  // ---- hooks from tcp.ts (after the request succeeded) ----

  setStarted(station: number, set: CachedSet): void {
    if (this.sets.has(set.id)) return; // a resume
    this.save({
      setId: set.id,
      station,
      set,
      event: this.deps.event,
      startedAt: Date.now(),
      games: [],
      endedAt: null,
      zip: null,
      zipOf: null,
    });
  }

  scored(setId: number, games: GameResult[], from: string): void {
    const r = this.sets.get(setId);
    if (!r) return;
    r.games = reported(r.games, games, from, this.deps.beamerAt(from) ?? null);
    this.bindSet(r);
    this.save(r);
  }

  setEnded(setId: number, games: GameResult[], from: string): void {
    const r = this.sets.get(setId);
    if (!r) return;
    r.games = reported(r.games, games, from, this.deps.beamerAt(from) ?? null);
    r.endedAt = Date.now();
    this.bindSet(r);
    this.save(r);
    this.maybeZip(r);
  }

  /** The set was freed or reset: its record goes, and its replays become strays. */
  setAbandoned(setId: number): void {
    const r = this.sets.get(setId);
    if (!r) return;
    for (const g of r.games) {
      const stored = g.replay && this.deps.store.get(g.replay.id);
      if (stored) this.deps.store.move(stored, 'unmatched');
    }
    this.sets.delete(setId);
    rmSync(join(this.deps.dir, '.sets', `${setId}.json`), { force: true });
  }

  // ---- hooks from collect.ts ----

  /** Where a downloaded copy goes: raw/ when finished and a reported game names it, else unmatched/. */
  placeFor(stationId: string, name: string, complete: boolean): Folder {
    if (!complete) return 'unmatched';
    const stamp = fileStamp(name);
    if (stamp === null) return 'unmatched';
    for (const r of this.sets.values()) {
      for (const g of r.games) {
        if (g.result.replay_id === 0 || replayStamp(g.result.replay_id) !== stamp) continue;
        if (this.beamerOf(g) === stationId) return 'raw';
      }
    }
    return 'unmatched';
  }

  /** A copy was stored: bind it to the game that names it, and zip that set if it is now whole. */
  stored(copy: StoredReplay): void {
    const stamp = fileStamp(copy.name);
    if (stamp === null) return;
    for (const r of this.sets.values()) {
      const names = r.games.some(
        (g) =>
          g.result.replay_id !== 0 &&
          replayStamp(g.result.replay_id) === stamp &&
          this.beamerOf(g) === copy.stationId,
      );
      if (!names) continue;
      if (this.bindSet(r)) {
        this.save(r);
        this.maybeZip(r);
      }
    }
  }

  // ---- status ----

  status(): {
    inProgress: { setId: number; station: number; label: string; games: number; bound: number }[];
    /** Sets of this event that ended without a zip, with what is missing. */
    skipped: {
      setId: number;
      station: number;
      label: string;
      endedAt: number;
      missing: MissingReplay[];
    }[];
    /** Games of sets still being played that have no replay or disagree with it. */
    flagged: { setId: number; station: number; game: number; why: string }[];
    recent: ArchiveResult[];
    unmatched: number;
  } {
    const all = [...this.sets.values()];
    const playing = all.filter((r) => r.endedAt === null);
    return {
      inProgress: playing.map((r) => ({
        setId: r.setId,
        station: r.station,
        label: label(r),
        games: r.games.length,
        bound: r.games.filter((g) => g.replay?.complete).length,
      })),
      skipped: all
        .filter(
          (r) =>
            r.endedAt !== null && r.zip === null && r.event.eventId === this.deps.event.eventId,
        )
        .sort((a, b) => b.endedAt! - a.endedAt!)
        .map((r) => ({
          setId: r.setId,
          station: r.station,
          label: label(r),
          endedAt: r.endedAt!,
          missing: this.missing(r),
        })),
      flagged: playing.flatMap((r) =>
        r.games.flatMap((g, i) => {
          if (g.result.replay_id === 0) {
            return [{ setId: r.setId, station: r.station, game: i + 1, why: 'not recorded' }];
          }
          if (g.replay?.mismatch) {
            const why = `replay disagrees: ${g.replay.mismatch}`;
            return [{ setId: r.setId, station: r.station, game: i + 1, why }];
          }
          return [];
        }),
      ),
      recent: this.results.slice(-20).reverse(),
      unmatched: this.deps.store.all().filter((c) => c.path.startsWith('unmatched/')).length,
    };
  }

  /** Each game of the set without a complete replay, and why. */
  missing(r: SetRecord): MissingReplay[] {
    return r.games.flatMap((g, i): MissingReplay[] => {
      if (g.replay?.complete) return [];
      const why =
        g.result.replay_id === 0
          ? 'not recorded'
          : g.replay
            ? 'incomplete recording'
            : this.beamerOf(g) === null
              ? 'its beamer has not synced'
              : 'not collected yet';
      return [{ game: i + 1, why }];
    });
  }

  // ---- binding ----

  private beamerOf(g: GameRecord): string | null {
    return g.beamer ?? this.deps.beamerAt(g.from) ?? null;
  }

  /** Bind every game that names a stored copy it does not have yet. True if anything changed. */
  private bindSet(r: SetRecord): boolean {
    let changed = false;
    r.games.forEach((g, i) => {
      if (g.result.replay_id === 0 || g.replay?.complete) return;
      const beamer = this.beamerOf(g);
      if (beamer === null) return;
      if (g.beamer === null) {
        g.beamer = beamer;
        changed = true;
      }
      const best = this.deps.store
        .byStamp(beamer, replayStamp(g.result.replay_id))
        .sort((a, b) => Number(b.complete) - Number(a.complete) || b.storedAt - a.storedAt)[0];
      if (!best || best.id === g.replay?.id) return;
      this.bind(r, i, best);
      changed = true;
    });
    return changed;
  }

  private bind(r: SetRecord, i: number, copy: StoredReplay): void {
    const g = r.games[i]!;
    const stored = copy.complete ? this.deps.store.move(copy, 'raw') : copy;
    let info: SlpInfo | null = null;
    try {
      info = parseSlp(readFileSync(this.deps.store.absolute(stored)));
    } catch (e) {
      this.deps.audit.record({
        type: 'archive_skip',
        station: r.station,
        replay: stored.name,
        reason: String(e),
      });
    }
    const mismatch = info ? contentMismatch(g.result, info) : null;
    g.replay = {
      id: stored.id,
      path: stored.path,
      sha256: stored.sha256,
      lastFrame: info?.lastFrame ?? null,
      complete: stored.complete && info !== null,
      mismatch,
    };
    this.deps.audit.record({
      type: 'archive_bind',
      station: r.station,
      setId: r.setId,
      game: i + 1,
      replay: stored.name,
      complete: g.replay.complete,
    });
    if (mismatch) {
      this.deps.audit.record({
        type: 'archive_mismatch',
        station: r.station,
        setId: r.setId,
        game: i + 1,
        replay: stored.name,
        mismatch,
      });
    }
  }

  // ---- zips ----

  private maybeZip(r: SetRecord): void {
    if (r.endedAt === null || r.games.length === 0) return;
    if (!r.games.every((g) => g.replay?.complete)) return;
    const of = r.games.map((g) => g.replay!.id).join(',');
    if (r.zipOf === of) return;
    this.writeZip(r, of);
  }

  private writeZip(r: SetRecord, of: string): void {
    const fields = setFields(r);
    try {
      const entries: ZipEntry[] = [];
      const used = new Set<string>();
      r.games.forEach((g, i) => {
        const copy = this.deps.store.get(g.replay!.id);
        const raw = readFileSync(
          copy ? this.deps.store.absolute(copy) : join(this.deps.dir, ...g.replay!.path.split('/')),
        );
        const names: (string | null)[] = [null, null, null, null];
        const ports = entrantPorts(g.result);
        if (ports) {
          names[ports[0]] = r.set.p1.tag;
          names[ports[1]] = r.set.p2.tag;
        }
        const name = unique(
          fillName(this.deps.gameTemplate, gameFields(fields, r, g, i)) + '.slp',
          used,
        );
        entries.push({ name, data: withDisplayNames(raw, names), date: new Date(g.at) });
      });
      const ctx = context(r, r.games);
      if (ctx) entries.unshift({ name: 'context.json', data: Buffer.from(JSON.stringify(ctx)) });
      const again = r.zip !== null;
      const zipName =
        r.zip ??
        unique(
          fillName(this.deps.setTemplate, fields) + '.zip',
          new Set(readdirSync(this.deps.dir)),
        );
      const tmp = join(this.deps.dir, `.${zipName}.tmp`);
      writeFileSync(tmp, buildZip(entries));
      renameSync(tmp, join(this.deps.dir, zipName));
      r.zip = zipName;
      r.zipOf = of;
      this.save(r);
      const result: ArchiveResult = {
        setId: r.setId,
        station: r.station,
        file: join(this.deps.dir, zipName),
        games: r.games.length,
        at: Date.now(),
        note: ctx ? '' : 'no context.json (no L + R claim on a game)',
        again,
      };
      this.results.push(result);
      if (this.results.length > 100) this.results.shift();
      this.deps.audit.record({ type: 'archive', ...result });
    } catch (e) {
      this.deps.audit.record({ type: 'archive_error', setId: r.setId, error: String(e) });
    }
  }

  // ---- disk ----

  private save(r: SetRecord): void {
    this.sets.set(r.setId, r);
    const path = join(this.deps.dir, '.sets', `${r.setId}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(r));
    renameSync(`${path}.tmp`, path);
  }
}

// ---- pure helpers (exported for tests) ----

/** The shape this relay writes to .sets: the event, and every game a GameRecord with its result and source. */
function isSetRecord(x: unknown): x is SetRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Partial<SetRecord>;
  return (
    typeof r.setId === 'number' &&
    typeof r.station === 'number' &&
    typeof r.event === 'object' &&
    r.event !== null &&
    Array.isArray(r.games) &&
    r.games.every(
      (g: Partial<GameRecord> | null) =>
        typeof g === 'object' &&
        g !== null &&
        typeof g.result?.replay_id === 'number' &&
        typeof g.from === 'string',
    )
  );
}

function label(r: SetRecord): string {
  return `${r.set.roundShort} ${r.set.p1.tag} vs ${r.set.p2.tag}`;
}

/**
 * A new report over the old list: a game keeps its beamer and first-report
 * time while its replay_id stays, and its bound replay while the rest of its
 * result stays too (a changed result binds again from the stored copy, so
 * the content check sees the new one); a new or replayed game takes the
 * reporting beamer.
 */
export function reported(
  old: GameRecord[],
  games: GameResult[],
  from: string,
  beamer: string | null,
  now = Date.now(),
): GameRecord[] {
  return games.map((result, i) => {
    const prev = old[i];
    if (prev !== undefined && prev.result.replay_id === result.replay_id) {
      const same = (Object.keys(result) as (keyof GameResult)[]).every(
        (k) => prev.result[k] === result[k],
      );
      return { ...prev, result, replay: same ? prev.replay : null };
    }
    return { at: now, result, beamer, from, replay: null };
  });
}

/** A replay_id (gameStartTime, Unix seconds) as the YYYYMMDDTHHMMSS of its file name: UTC, like Nintendont's gmtime. */
export function replayStamp(replayId: number): string {
  return new Date(replayId * 1000).toISOString().slice(0, 19).replace(/[-:]/g, '');
}

/** The YYYYMMDDTHHMMSS of a Game_<MAC>_<stamp>.slp name, or null. */
export function fileStamp(name: string): string | null {
  return /_(\d{8}T\d{6})\.slp$/.exec(name)?.[1] ?? null;
}

/** Entrant 1's and 2's CSS ports, or null unless both are known (0-3) and differ. */
function entrantPorts(g: GameResult): [number, number] | null {
  const ok = (p: number) => p !== NO_PORT && p >= 0 && p <= 3;
  return ok(g.p1_port) && ok(g.p2_port) && g.p1_port !== g.p2_port ? [g.p1_port, g.p2_port] : null;
}

/**
 * What in the replay disagrees with the report, or null: the stage, and each
 * entrant's character, costume and (only when the game sent them: never for
 * a hand-scored game, or one the ledge-grab limit or the tiebreak game
 * decided) stocks on their port, wherever the report knows them.
 */
export function contentMismatch(g: GameResult, info: SlpInfo): string | null {
  if (humanPorts(info).length === 0) return 'no human player';
  if (g.stage !== 0 && g.stage !== info.stage) return `stage ${info.stage}, reported ${g.stage}`;
  const ports = entrantPorts(g);
  if (!ports) return null;
  const sentStocks = g.p1_stocks !== 0xff && g.p2_stocks !== 0xff;
  const known: [number, number, number, number, number][] = [
    [1, ports[0], g.p1_char, g.p1_costume, g.p1_stocks],
    [2, ports[1], g.p2_char, g.p2_costume, g.p2_stocks],
  ];
  for (const [entrant, port, char, costume, stocks] of known) {
    const p = info.ports.find((q) => q.port === port);
    if (!p || p.type !== 0) return `no player on port ${port + 1} (entrant ${entrant})`;
    if (char !== 0xff && p.character !== char) return `port ${port + 1} character`;
    if (costume !== 0xff && p.costume !== costume) return `port ${port + 1} costume`;
    const left = info.stocks[port];
    if (sentStocks && left !== null && left !== undefined && left !== stocks) {
      return `port ${port + 1} ended with ${left} stock(s), reported ${stocks}`;
    }
  }
  return null;
}

function unique(name: string, used: Set<string>): string {
  let out = name;
  const dot = name.lastIndexOf('.');
  for (let n = 2; used.has(out); n++) out = `${name.slice(0, dot)} ${n}${name.slice(dot)}`;
  used.add(out);
  return out;
}

function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function setFields(r: SetRecord): SetFields {
  const ev = r.event;
  const w1 = r.games.filter((g) => g.result.winner_slot === 1).length;
  const w2 = r.games.length - w1;
  const p1 = r.set.p1.tag;
  const p2 = r.set.p2.tag;
  return {
    tournament: ev.tournamentName,
    number: tournamentNumber(ev.tournamentName),
    event: ev.eventName,
    round: r.set.fullRoundText,
    round_short: r.set.roundShort,
    p1,
    p2,
    winner: w1 > w2 ? p1 : w2 > w1 ? p2 : '',
    loser: w1 > w2 ? p2 : w2 > w1 ? p1 : '',
    score: `${w1}-${w2}`,
    date: localDate(r.startedAt),
    set_id: String(r.setId),
  };
}

export function gameFields(set: SetFields, r: SetRecord, g: GameRecord, i: number): GameFields {
  const { stage, p1_char, p2_char, winner_slot: winner } = g.result;
  return {
    ...set,
    game: String(i + 1),
    stage: shortStage(stage, stageName(stage)),
    stage_name: stageName(stage) ?? '',
    p1_char: shortCharacter(p1_char),
    p2_char: shortCharacter(p2_char),
    game_winner: winner === 1 ? r.set.p1.tag : winner === 2 ? r.set.p2.tag : '',
  };
}

// ---- context.json: Replay Reporter for Slippi's Context type
// (src/common/types.ts there), which Lucky Stats reads to link the zip to
// the start.gg set. ----

interface ContextSlot {
  displayNames: string[];
  ports: number[]; // 1-based
  prefixes: string[];
  pronouns: string[];
  score: number; // games won before this game (finalScore: in total)
}

const BRACKET_TYPE: Record<string, number> = {
  SINGLE_ELIMINATION: 1,
  DOUBLE_ELIMINATION: 2,
  ROUND_ROBIN: 3,
  SWISS: 4,
  CUSTOM_SCHEDULE: 6,
  MATCHMAKING: 7,
};

/** null when a game's ports are unknown (no L + R claim): then nobody knows whose port was whose. */
export function context(r: SetRecord, games: GameRecord[]): Record<string, unknown> | null {
  const ev = r.event;
  if (games.length === 0 || games.some((g) => !entrantPorts(g.result))) return null;
  const tag = (entrant: number) => (entrant === 1 ? r.set.p1.tag : r.set.p2.tag);
  const wins = [0, 0];
  const scores = games.map((g) => {
    const [p1, p2] = entrantPorts(g.result)!;
    const winnerSlot = g.result.winner_slot;
    // Slots in port order, like Replay Reporter.
    const order = [
      { entrant: 1, port: p1 },
      { entrant: 2, port: p2 },
    ].sort((a, b) => a.port - b.port);
    const slots = order.map((o): ContextSlot => ({
      displayNames: [tag(o.entrant)],
      ports: [o.port + 1],
      prefixes: [''],
      pronouns: [''],
      score: wins[o.entrant - 1]!,
    }));
    if (winnerSlot === 1 || winnerSlot === 2) wins[winnerSlot - 1]!++;
    return { slots, order };
  });
  const last = scores[scores.length - 1]!;
  const finalScore = {
    slots: last.order.map((o, j) => ({ ...last.slots[j]!, score: wins[o.entrant - 1]! })),
  };
  const charsOf = (entrant: number) => [
    ...new Set(
      games
        .map((g) => characterName(entrant === 1 ? g.result.p1_char : g.result.p2_char) ?? '')
        .filter(Boolean),
    ),
  ];
  const pg = r.set.phaseGroup;
  return {
    bestOf: r.set.bestOf,
    durationMs: games.reduce(
      (ms, g) => ms + Math.ceil(((g.replay?.lastFrame ?? -124) + 124) / 0.06),
      0,
    ),
    scores: scores.map((s) => ({ slots: s.slots })),
    finalScore,
    players: {
      entrant1: [{ name: r.set.p1.tag, characters: charsOf(1) }],
      entrant2: [{ name: r.set.p2.tag, characters: charsOf(2) }],
    },
    startgg: {
      tournament: { name: ev.tournamentName, location: ev.tournamentLocation },
      event: {
        id: ev.eventId,
        name: ev.eventName,
        slug: ev.eventSlug,
        hasSiblings: ev.eventHasSiblings,
      },
      phase: {
        id: pg?.phase?.id ?? 0,
        name: pg?.phase?.name ?? '',
        hasSiblings: ev.eventPhaseCount > 1,
      },
      phaseGroup: {
        id: pg?.id ?? 0,
        name: pg?.displayIdentifier ?? '',
        bracketType: BRACKET_TYPE[pg?.bracketType ?? ''] ?? 2,
        hasSiblings: (pg?.phase?.groupCount ?? 1) > 1,
        waveId: pg?.wave?.id ?? null,
        winnersTargetPhaseId: null,
      },
      set: {
        id: r.setId,
        internalId: r.setId,
        fullRoundText: r.set.fullRoundText,
        ordinal: null,
        round: r.set.round,
        stream: null,
      },
    },
    startMs: games[0]!.at,
  };
}

/** True if the set's record file exists; for tests. */
export function hasRecord(dir: string, setId: number): boolean {
  return existsSync(join(dir, '.sets', `${setId}.json`));
}
