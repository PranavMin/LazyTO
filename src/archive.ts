// archive.ts -- the set archive: every finished set whose games all have a
// replay becomes one zip of them in Replay Reporter for Slippi's format
// (setzip.ts builds it): each replay with the players' tags and re-timed to
// the report, plus a context.json that links it to the start.gg set, which
// Lucky Stats' "Import Tournament Game Data" reads. The values in it are the
// ones LazyTO reported.
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
// What a set's record keeps for its zip: the set as the cache had it and
// its participants (names, prefixes, pronouns) from START_SET's
// markSetInProgress; start.gg's REST phase group, fetched once right after
// START_SET without holding up the Wii's reply (its bracket type, wave,
// winners target phase and the set's ordinal); and from END_SET's report the
// set's completedAt and stream. A failed phase group lookup is not tried
// again: the zip is then written without context.json, and says why.
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
import type { GameResult } from '../generated/wire.js';
import type { CachedSet } from './cache.js';
import { phaseGroupFacts, type PhaseGroupFacts, type RestPhaseGroup } from './phasegroup.js';
import type { Folder, RawStore, StoredReplay } from './rawstore.js';
import {
  buildSetZip,
  entrantPorts,
  rrStream,
  type ArchiveEvent,
  type ContextStream,
} from './setzip.js';
import { parseSlp, playerPorts, type SlpInfo } from './slp.js';
import type { ReportedSet, StartedParticipant, StartedSet } from './startgg.js';

export type { ArchiveEvent } from './setzip.js';

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
  /** Entrant 1's and 2's participants as markSetInProgress gave them at START_SET. */
  participants: [StartedParticipant[], StartedParticipant[]];
  /** start.gg's REST phase group for the set; why there is none; null while it is being fetched. */
  phaseGroup: PhaseGroupFacts | { error: string } | null;
  startedAt: number;
  games: GameRecord[]; // the last reported list, index 0 = game 1
  endedAt: number | null;
  /** From END_SET: the anchor of the re-timed replays (completedAt, else the relay's clock then) and the set's stream. */
  report: { completedMs: number; stream: ContextStream | null } | null;
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
  event: ArchiveEvent;
  audit: { record(event: Record<string, unknown>): void };
  /** start.gg's REST phase group (startgg.ts getPhaseGroupRest), fetched once per START_SET. */
  phaseGroup(id: number): Promise<RestPhaseGroup>;
  /** Now, in ms: the zips' entry times and END_SET's anchor when start.gg gives no completedAt. Tests pin it. */
  clock?: () => number;
}

export class SetArchive {
  private readonly sets = new Map<number, SetRecord>(); // by set id
  private readonly results: ArchiveResult[] = [];
  private readonly clock: () => number;
  /** Phase group lookups under way; idle() waits for them. */
  private readonly lookups = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly deps: ArchiveDeps) {
    this.clock = deps.clock ?? Date.now;
    mkdirSync(join(deps.dir, '.sets'), { recursive: true });
    for (const f of readdirSync(join(deps.dir, '.sets'))) {
      if (!f.endsWith('.json')) continue;
      try {
        const r: unknown = JSON.parse(readFileSync(join(deps.dir, '.sets', f), 'utf8'));
        // A record an older relay wrote (protocol v1's game starts, the
        // first v2 archive's per-set raw folder, or one from before the
        // archive kept start.gg's participants) is reported, not used.
        if (!isSetRecord(r)) throw new Error('not a set record of this relay version');
        // A lookup the last run never heard back from is not made again.
        if (r.phaseGroup === null) {
          r.phaseGroup = { error: 'the relay stopped before start.gg answered' };
        }
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

  /** Every phase group lookup started so far has answered (tests). */
  async idle(): Promise<void> {
    while (this.lookups.size > 0) await Promise.allSettled([...this.lookups]);
  }

  /** The relay is stopping: a lookup that answers from now on is dropped (its audit log is closed). */
  stop(): void {
    this.stopped = true;
  }

  // ---- hooks from tcp.ts (after the request succeeded) ----

  setStarted(station: number, set: CachedSet, started: StartedSet): void {
    if (this.sets.has(set.id)) return; // a resume
    const of = (entrantId: number) =>
      started.entrants.find((e) => e.id === entrantId)?.participants ?? [];
    const r: SetRecord = {
      setId: set.id,
      station,
      set,
      event: this.deps.event,
      participants: [of(set.p1.id), of(set.p2.id)],
      phaseGroup: null,
      startedAt: this.clock(),
      games: [],
      endedAt: null,
      report: null,
      zip: null,
      zipOf: null,
    };
    this.save(r);
    this.lookUpPhaseGroup(r);
  }

  scored(setId: number, games: GameResult[], from: string): void {
    const r = this.sets.get(setId);
    if (!r) return;
    r.games = reported(r.games, games, from, this.deps.beamerAt(from) ?? null);
    this.bindSet(r);
    this.save(r);
  }

  /** reportedSet: the set as start.gg answered the final report (null if it left it out). */
  setEnded(
    setId: number,
    games: GameResult[],
    from: string,
    reportedSet: ReportedSet | null,
  ): void {
    const r = this.sets.get(setId);
    if (!r) return;
    r.games = reported(r.games, games, from, this.deps.beamerAt(from) ?? null);
    r.endedAt = this.clock();
    // Replay Reporter's anchor: completedAt, else the moment it copies,
    // which is right after its report.
    const completedMs = reportedSet?.completedAt ? reportedSet.completedAt * 1000 : 0;
    r.report = { completedMs: completedMs || r.endedAt, stream: rrStream(reportedSet?.stream) };
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

  // ---- start.gg's phase group ----

  /** Fetch the set's phase group once, without holding up anything; the zip waits for the answer. */
  private lookUpPhaseGroup(r: SetRecord): void {
    const id = r.set.phaseGroup?.id;
    const done = (phaseGroup: SetRecord['phaseGroup'], error?: string) => {
      // Dropped when the relay stopped, or the set was abandoned meanwhile.
      if (this.stopped || this.sets.get(r.setId) !== r) return;
      r.phaseGroup = phaseGroup;
      this.deps.audit.record({
        type: 'upstream',
        call: 'phase_group',
        setId: r.setId,
        phaseGroupId: id ?? null,
        ok: error === undefined,
        ...(error === undefined ? {} : { error }),
      });
      this.save(r);
      this.maybeZip(r);
    };
    if (id === undefined) {
      done({ error: 'the set has no phase group' }, 'the set has no phase group');
      return;
    }
    const lookup = this.deps
      .phaseGroup(id)
      .then((json) => phaseGroupFacts(json, r.setId))
      .then(
        (facts) => done(facts),
        (e: unknown) => {
          const why = e instanceof Error ? e.message : String(e);
          done({ error: why }, why);
        },
      )
      .finally(() => this.lookups.delete(lookup));
    this.lookups.add(lookup);
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
    if (r.endedAt === null || r.report === null || r.games.length === 0) return;
    if (r.phaseGroup === null) return; // start.gg has not answered yet: zipped when it does
    if (!r.games.every((g) => g.replay?.complete)) return;
    const of = r.games.map((g) => g.replay!.id).join(',');
    if (r.zipOf === of) return;
    this.writeZip(r, r.report, of);
  }

  private writeZip(r: SetRecord, report: NonNullable<SetRecord['report']>, of: string): void {
    try {
      const built = buildSetZip(
        {
          event: r.event,
          set: r.set,
          participants: r.participants,
          phaseGroup: r.phaseGroup,
          report,
          games: r.games.map((g) => {
            const copy = this.deps.store.get(g.replay!.id);
            const path = copy
              ? this.deps.store.absolute(copy)
              : join(this.deps.dir, ...g.replay!.path.split('/'));
            return { result: g.result, replay: readFileSync(path) };
          }),
        },
        new Date(this.clock()),
      );
      const again = r.zip !== null;
      const zipName = r.zip ?? unique(`${built.name}.zip`, new Set(readdirSync(this.deps.dir)));
      const tmp = join(this.deps.dir, `.${zipName}.tmp`);
      writeFileSync(tmp, built.zip);
      renameSync(tmp, join(this.deps.dir, zipName));
      r.zip = zipName;
      r.zipOf = of;
      this.save(r);
      const result: ArchiveResult = {
        setId: r.setId,
        station: r.station,
        file: join(this.deps.dir, zipName),
        games: r.games.length,
        at: this.clock(),
        note: built.note,
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
    Array.isArray(r.participants) &&
    r.phaseGroup !== undefined &&
    r.report !== undefined &&
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

/**
 * What in the replay disagrees with the report, or null: the stage, and each
 * entrant's character, costume and (only when the game sent them: never for
 * a hand-scored game, or one the ledge-grab limit or the tiebreak game
 * decided) stocks on their port, wherever the report knows them.
 */
export function contentMismatch(g: GameResult, info: SlpInfo): string | null {
  if (playerPorts(info).length === 0) return 'no player';
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
    if (!p || (p.type !== 0 && p.type !== 1)) {
      return `no player on port ${port + 1} (entrant ${entrant})`;
    }
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

/** True if the set's record file exists; for tests. */
export function hasRecord(dir: string, setId: number): boolean {
  return existsSync(join(dir, '.sets', `${setId}.json`));
}
