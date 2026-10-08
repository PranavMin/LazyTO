// archive.ts -- the set archive: every finished set becomes one zip of its
// replays, named from the config's templates (names.ts), each replay
// labelled with the players' tags, plus a context.json that links it to the
// start.gg set (the format Replay Reporter for Slippi writes and Lucky
// Stats' "Import Tournament Game Data" reads).
//
// How a replay is matched to a game (protocol v2, docs/protocol-v2.md). Every
// reported game_result carries the entrants' ports and replay_id: the
// gameStartTime of its match's Slippi replay, whose file on the station's
// beamer (beamer.ts) is Game_<Wii MAC>_<replay_id as UTC YYYYMMDDTHHMMSS>.slp.
// While the station has a set, the relay polls its beamer and downloads the
// file of each reported game it has no replay for yet. A game with replay_id
// 0 has no replay. The replay's stage, characters and costumes are checked
// against the report and a mismatch is logged, never refused: the id
// decides. Game N of the archive is the replay of game N of the last report
// (a game played again after an undo carries the new match's id).
//
// State lives on disk under archiveDir, so a relay restart mid-set loses
// nothing: .sets/<setId>.json per set in progress, .raw/<setId>/ for its
// replays. A zip is written (atomically) when every scored game that has a
// replay_id has its replay, or FINALIZE_TIMEOUT_MS after the set ended with
// what there is.
// The archive never blocks or fails a Wii request: its errors go to the
// status page and the audit log.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { NO_PORT, type GameResult } from '../generated/wire.js';
import type { CachedSet } from './cache.js';
import { BeamerBusy, BeamerClient, type BeamerDirectory } from './beamer.js';
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

export const POLL_MS = 5000;
export const FINALIZE_TIMEOUT_MS = 3 * 60_000;

/** What the archive needs to know about tonight's event (resolve.ts). */
export interface ArchiveEvent {
  tournamentName: string;
  tournamentLocation: string;
  eventId: number;
  eventName: string;
  eventSlug: string;
  eventHasSiblings: boolean;
  eventPhaseCount: number;
}

export interface GameRecord {
  at: number; // when the relay first had this game (this replay_id) reported
  result: GameResult; // as last reported
  replay: { file: string; lastFrame: number | null } | null;
}

export interface SetRecord {
  setId: number;
  station: number;
  set: CachedSet; // snapshot at START_SET: the set leaves the cache once completed
  startedAt: number;
  games: GameRecord[]; // the last reported list, index 0 = game 1
  endedAt: number | null;
}

export interface ArchiveResult {
  setId: number;
  station: number;
  file: string | null; // zip path; null when nothing could be archived
  games: number; // replays in the zip
  missing: number[]; // scored games without a replay
  at: number;
  note: string;
}

export interface ArchiveDeps {
  dir: string;
  setTemplate: string;
  gameTemplate: string;
  beamerHttpPort: number;
  beamers: BeamerDirectory;
  event: ArchiveEvent;
  audit: { record(event: Record<string, unknown>): void };
  /** Tests shorten these. */
  pollMs?: number;
  finalizeTimeoutMs?: number;
}

interface StationWatch {
  unreadable: Set<string>; // replay names that did not parse: not downloaded again
  busyUntil: number;
  running: Promise<void> | null; // the poll in progress
  again: boolean; // asked for while one was in progress: poll once more after it
  lastError: string | null;
  downloaded: number;
}

export class SetArchive {
  private readonly sets = new Map<number, SetRecord>(); // by set id
  private readonly watches = new Map<number, StationWatch>(); // by station
  private readonly results: ArchiveResult[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly pollMs: number;
  private readonly finalizeTimeoutMs: number;

  constructor(private readonly deps: ArchiveDeps) {
    this.pollMs = deps.pollMs ?? POLL_MS;
    this.finalizeTimeoutMs = deps.finalizeTimeoutMs ?? FINALIZE_TIMEOUT_MS;
    mkdirSync(join(deps.dir, '.sets'), { recursive: true });
    mkdirSync(join(deps.dir, '.raw'), { recursive: true });
    for (const f of readdirSync(join(deps.dir, '.sets'))) {
      if (!f.endsWith('.json')) continue;
      try {
        const r: unknown = JSON.parse(readFileSync(join(deps.dir, '.sets', f), 'utf8'));
        // A record a protocol v1 relay wrote (game starts, bare game results)
        // would throw in every poll; it is reported here instead.
        if (!isSetRecord(r)) throw new Error('not a protocol v2 set record');
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

  start(): void {
    if (this.timer) throw new Error('archive already started');
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- hooks from tcp.ts (after the request succeeded) ----

  setStarted(station: number, set: CachedSet): void {
    if (this.sets.has(set.id)) return; // a resume
    this.save({
      setId: set.id,
      station,
      set,
      startedAt: Date.now(),
      games: [],
      endedAt: null,
    });
  }

  scored(setId: number, games: GameResult[]): void {
    const r = this.sets.get(setId);
    if (!r) return;
    r.games = reported(r.games, games);
    this.save(r);
    void this.poll(r.station);
  }

  setEnded(setId: number, games: GameResult[]): void {
    const r = this.sets.get(setId);
    if (!r) return;
    r.games = reported(r.games, games);
    r.endedAt = Date.now();
    this.save(r);
    void this.poll(r.station).then(() => this.maybeFinalize(r));
  }

  setAbandoned(setId: number): void {
    const r = this.sets.get(setId);
    if (!r) return;
    this.drop(r);
  }

  /** A beamer announced a game event: look at its index now rather than at the next tick. */
  onAnnounce(station: number): void {
    if (this.activeStations().has(station)) void this.poll(station);
  }

  // ---- status ----

  status(): {
    inProgress: { setId: number; station: number; games: number; bound: number; ended: boolean }[];
    recent: ArchiveResult[];
    watches: [number, { downloaded: number; lastError: string | null }][];
  } {
    return {
      inProgress: [...this.sets.values()].map((r) => ({
        setId: r.setId,
        station: r.station,
        games: r.games.length,
        bound: r.games.filter((g) => g.replay).length,
        ended: r.endedAt !== null,
      })),
      recent: this.results.slice(-20).reverse(),
      watches: [...this.watches.entries()].map(([s, w]) => [
        s,
        { downloaded: w.downloaded, lastError: w.lastError },
      ]),
    };
  }

  // ---- polling ----

  private activeStations(): Set<number> {
    return new Set([...this.sets.values()].map((r) => r.station));
  }

  /** One tick: poll every station with a set, then finalize what is due. */
  async tick(): Promise<void> {
    for (const station of this.activeStations()) await this.poll(station);
    for (const r of [...this.sets.values()]) this.maybeFinalize(r);
  }

  private watch(station: number): StationWatch {
    let w = this.watches.get(station);
    if (!w) {
      w = {
        unreadable: new Set(),
        busyUntil: 0,
        running: null,
        again: false,
        lastError: null,
        downloaded: 0,
      };
      this.watches.set(station, w);
    }
    return w;
  }

  /**
   * Read the station's beamer index and download the replay of every reported
   * game that has none yet. One poll per station at a time: a call during a
   * poll makes it run once more, and resolves when that is done.
   */
  poll(station: number): Promise<void> {
    const w = this.watch(station);
    if (w.running) {
      w.again = true;
      return w.running;
    }
    w.running = (async () => {
      do {
        w.again = false;
        await this.pollOnce(station, w);
      } while (w.again);
      w.running = null;
    })();
    return w.running;
  }

  private async pollOnce(station: number, w: StationWatch): Promise<void> {
    // The station's reported games still waiting for their replay, by the
    // replay's time stamp.
    const wanted = new Map<string, { r: SetRecord; i: number }>();
    for (const r of this.sets.values()) {
      if (r.station !== station) continue;
      r.games.forEach((g, i) => {
        if (!g.replay && g.result.replay_id !== 0)
          wanted.set(replayStamp(g.result.replay_id), { r, i });
      });
    }
    // A replay already stored for its set (a game undone, then reported
    // again with the same id) binds from disk.
    for (const [stamp, hit] of wanted) {
      const dir = join(this.deps.dir, '.raw', String(hit.r.setId));
      const name = existsSync(dir)
        ? readdirSync(dir).find((n) => fileStamp(n) === stamp)
        : undefined;
      if (name === undefined) continue;
      this.take(station, hit.r, hit.i, name, readFileSync(join(dir, name)));
      wanted.delete(stamp);
    }
    const beamer = this.deps.beamers.get(station);
    if (wanted.size === 0 || !beamer || Date.now() < w.busyUntil) return;
    try {
      const client = BeamerClient.at(beamer.address, this.deps.beamerHttpPort);
      for (const f of await client.list()) {
        const hit = wanted.get(fileStamp(f.name) ?? '');
        if (!hit || w.unreadable.has(f.name)) continue;
        const data = await client.fetchReplay(f.name);
        w.downloaded++;
        if (!this.take(station, hit.r, hit.i, f.name, data)) w.unreadable.add(f.name);
      }
      w.lastError = null;
    } catch (e) {
      if (e instanceof BeamerBusy) w.busyUntil = Date.now() + e.retryAfterMs;
      else w.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  /** The replay named by game i's replay_id: bind it, flagging a content mismatch. False if it does not parse. */
  private take(station: number, r: SetRecord, i: number, name: string, data: Buffer): boolean {
    let info: SlpInfo;
    try {
      info = parseSlp(data);
    } catch (e) {
      this.deps.audit.record({ type: 'archive_skip', station, replay: name, reason: String(e) });
      return false;
    }
    const g = r.games[i]!;
    if (!matches(g.result, info)) {
      this.deps.audit.record({
        type: 'archive_mismatch',
        station,
        setId: r.setId,
        game: i + 1,
        replay: name,
      });
    }
    const dir = join(this.deps.dir, '.raw', String(r.setId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), data);
    g.replay = { file: name, lastFrame: info.lastFrame };
    this.save(r);
    this.deps.audit.record({
      type: 'archive_bind',
      station,
      setId: r.setId,
      game: i + 1,
      replay: name,
    });
    return true;
  }

  // ---- finalizing ----

  private maybeFinalize(r: SetRecord): void {
    if (r.endedAt === null || !this.sets.has(r.setId)) return;
    const complete = r.games.every((g) => g.replay || g.result.replay_id === 0);
    if (complete || Date.now() - r.endedAt >= this.finalizeTimeoutMs) this.finalize(r);
  }

  private finalize(r: SetRecord): void {
    const missing = r.games.flatMap((g, i) => (g.replay ? [] : [i + 1]));
    const fields = setFields(r, this.deps.event);
    let result: ArchiveResult;
    try {
      const entries: ZipEntry[] = [];
      const used = new Set<string>();
      const slots: GameRecord[] = [];
      r.games.forEach((g, i) => {
        if (!g.replay) return;
        const raw = readFileSync(join(this.deps.dir, '.raw', String(r.setId), g.replay.file));
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
        slots.push(g);
      });
      if (entries.length === 0) {
        result = {
          setId: r.setId,
          station: r.station,
          file: null,
          games: 0,
          missing,
          at: Date.now(),
          note: 'no replays',
        };
      } else {
        const ctx = context(r, this.deps.event, slots);
        if (ctx) entries.unshift({ name: 'context.json', data: Buffer.from(JSON.stringify(ctx)) });
        const zipName = unique(
          fillName(this.deps.setTemplate, fields) + '.zip',
          new Set(readdirSync(this.deps.dir)),
        );
        const tmp = join(this.deps.dir, `.${zipName}.tmp`);
        writeFileSync(tmp, buildZip(entries));
        renameSync(tmp, join(this.deps.dir, zipName));
        const notes = [
          ctx ? '' : 'no context.json (no L + R claim on a game)',
          missing.length ? `missing game ${missing.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; ');
        result = {
          setId: r.setId,
          station: r.station,
          file: join(this.deps.dir, zipName),
          games: slots.length,
          missing,
          at: Date.now(),
          note: notes,
        };
      }
    } catch (e) {
      result = {
        setId: r.setId,
        station: r.station,
        file: null,
        games: 0,
        missing,
        at: Date.now(),
        note: `failed: ${String(e)}`,
      };
    }
    this.results.push(result);
    if (this.results.length > 100) this.results.shift();
    this.deps.audit.record({ type: 'archive', ...result });
    this.drop(r);
  }

  // ---- disk ----

  private save(r: SetRecord): void {
    this.sets.set(r.setId, r);
    const path = join(this.deps.dir, '.sets', `${r.setId}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(r));
    renameSync(`${path}.tmp`, path);
  }

  private drop(r: SetRecord): void {
    this.sets.delete(r.setId);
    rmSync(join(this.deps.dir, '.sets', `${r.setId}.json`), { force: true });
    rmSync(join(this.deps.dir, '.raw', String(r.setId)), { recursive: true, force: true });
  }
}

// ---- pure helpers (exported for tests) ----

/** The shape this relay writes to .sets: every game a GameRecord with its result. */
function isSetRecord(x: unknown): x is SetRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Partial<SetRecord>;
  return (
    typeof r.setId === 'number' &&
    typeof r.station === 'number' &&
    Array.isArray(r.games) &&
    r.games.every(
      (g: Partial<GameRecord> | null) =>
        typeof g === 'object' && g !== null && typeof g.result?.replay_id === 'number',
    )
  );
}

/** A new report over the old list: a game keeps its replay and first-report time while its replay_id stays. */
export function reported(old: GameRecord[], games: GameResult[], now = Date.now()): GameRecord[] {
  return games.map((result, i) => {
    const prev = old[i];
    const same = prev !== undefined && prev.result.replay_id === result.replay_id;
    return { at: same ? prev.at : now, result, replay: same ? prev.replay : null };
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
 * The replay agrees with the report: the stage, and each entrant's character
 * and costume on their port, wherever the report knows them. Stocks are not
 * compared (the replay's end is not parsed).
 */
export function matches(g: GameResult, info: SlpInfo): boolean {
  if (g.stage !== 0 && g.stage !== info.stage) return false;
  const ports = entrantPorts(g);
  if (ports) {
    const known: [number, number, number][] = [
      [ports[0], g.p1_char, g.p1_costume],
      [ports[1], g.p2_char, g.p2_costume],
    ];
    for (const [port, char, costume] of known) {
      const p = info.ports.find((q) => q.port === port);
      if (!p || p.type !== 0) return false;
      if (char !== 0xff && p.character !== char) return false;
      if (costume !== 0xff && p.costume !== costume) return false;
    }
  }
  return humanPorts(info).length > 0;
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

export function setFields(r: SetRecord, ev: ArchiveEvent): SetFields {
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
export function context(
  r: SetRecord,
  ev: ArchiveEvent,
  games: GameRecord[],
): Record<string, unknown> | null {
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

/** True if any set record file exists; for tests. */
export function hasRecord(dir: string, setId: number): boolean {
  return existsSync(join(dir, '.sets', `${setId}.json`));
}
