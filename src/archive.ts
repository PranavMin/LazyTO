// archive.ts -- the set archive: every finished set becomes one zip of its
// replays, named from the config's templates (names.ts), each replay
// labelled with the players' tags, plus a context.json that links it to the
// start.gg set (the format Replay Reporter for Slippi writes and Lucky
// Stats' "Import Tournament Game Data" reads).
//
// How a replay is matched to a game. The kiosk sends CMD_GAME_START on every
// match's first frame (protocol.yaml game_start_req): set, game number,
// handwarmer flag, stage, and per port the character and costume, plus the
// ports of entrant 1 and 2 from the L + R claim. The station's beamer
// (beamer.ts) lists each replay once it is finished. The relay polls the
// beamer while the station has a set, downloads every new replay, and binds
// it to the earliest unbound game start of that station that came before it
// and has the same human ports, characters, costumes and stage. Handwarmers
// bind too (so they cannot be mistaken for the game after them) but never go
// in the zip. When the set ends, game N of the archive is the replay of the
// LAST game start numbered N that is not a handwarmer (a game played again
// after an undo replaces the first try).
//
// State lives on disk under archiveDir, so a relay restart mid-set loses
// nothing: .sets/<setId>.json per set in progress, .raw/<setId>/ for its
// replays. A zip is written (atomically) when every scored game has its
// replay, or FINALIZE_TIMEOUT_MS after the set ended with what there is.
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
import { NO_PORT, type GameResult, type GameStartReq } from '../generated/wire.js';
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

export interface GameStartRecord {
  at: number;
  game: number;
  handwarmer: boolean;
  stage: number;
  e1Port: number; // NO_PORT = no claim
  e2Port: number;
  chars: number[]; // per port, NO_PORT = no human
  costumes: number[];
  replay: { file: string; lastFrame: number | null } | null;
}

export interface SetRecord {
  setId: number;
  station: number;
  set: CachedSet; // snapshot at START_SET: the set leaves the cache once completed
  startedAt: number;
  gameStarts: GameStartRecord[];
  games: GameResult[]; // the last reported list
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
  known: Set<string>; // replay names seen in the beamer's index
  baselined: boolean;
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
        const r = JSON.parse(readFileSync(join(deps.dir, '.sets', f), 'utf8')) as SetRecord;
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
      gameStarts: [],
      games: [],
      endedAt: null,
    });
    // What the beamer holds now (earlier sets, friendlies) is not this set's:
    // look again before its first game starts.
    this.watch(station).baselined = false;
    void this.poll(station);
  }

  gameStarted(station: number, req: GameStartReq): void {
    const r = this.sets.get(req.set_id);
    if (!r || r.station !== station || r.endedAt !== null) return;
    r.gameStarts.push({
      at: Date.now(),
      game: req.game,
      handwarmer: req.handwarmer !== 0,
      stage: req.stage,
      e1Port: req.e1_port,
      e2Port: req.e2_port,
      chars: [...req.chars],
      costumes: [...req.costumes],
      replay: null,
    });
    this.save(r);
  }

  scored(setId: number, games: GameResult[]): void {
    const r = this.sets.get(setId);
    if (!r) return;
    r.games = games;
    this.save(r);
  }

  setEnded(setId: number, games: GameResult[]): void {
    const r = this.sets.get(setId);
    if (!r) return;
    r.games = games;
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
    inProgress: { setId: number; station: number; starts: number; bound: number; ended: boolean }[];
    recent: ArchiveResult[];
    watches: [number, { downloaded: number; lastError: string | null }][];
  } {
    return {
      inProgress: [...this.sets.values()].map((r) => ({
        setId: r.setId,
        station: r.station,
        starts: r.gameStarts.length,
        bound: r.gameStarts.filter((g) => g.replay).length,
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
        known: new Set(),
        baselined: false,
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
   * Read the station's beamer index and download every replay not seen
   * before. One poll per station at a time: a call during a poll makes it
   * run once more, and resolves when that is done.
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
    const beamer = this.deps.beamers.get(station);
    if (!beamer || Date.now() < w.busyUntil) return;
    try {
      const client = BeamerClient.at(beamer.address, this.deps.beamerHttpPort);
      const files = await client.list();
      if (!w.baselined) {
        // First look at this beamer, or a new set started: what it holds
        // now predates the set, unless a set of this station still waits
        // for replays (a relay restart mid-set, or the last replay of the
        // previous set not listed yet).
        w.baselined = true;
        const waiting = [...this.sets.values()].some(
          (r) => r.station === station && r.gameStarts.some((g) => !g.replay),
        );
        if (!waiting) {
          for (const f of files) w.known.add(f.name);
          return;
        }
      }
      for (const f of files) {
        if (w.known.has(f.name)) continue;
        const data = await client.fetchReplay(f.name);
        w.known.add(f.name);
        w.downloaded++;
        this.take(station, f.name, data);
      }
      w.lastError = null;
    } catch (e) {
      if (e instanceof BeamerBusy) w.busyUntil = Date.now() + e.retryAfterMs;
      else w.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  /** A new replay from a station's beamer: bind it to a game start, or let it go. */
  private take(station: number, name: string, data: Buffer): void {
    let info: SlpInfo;
    try {
      info = parseSlp(data);
    } catch (e) {
      this.deps.audit.record({ type: 'archive_skip', station, replay: name, reason: String(e) });
      return;
    }
    const seenAt = Date.now();
    let best: { r: SetRecord; g: GameStartRecord } | null = null;
    for (const r of this.sets.values()) {
      if (r.station !== station) continue;
      for (const g of r.gameStarts) {
        if (g.replay || g.at > seenAt || !matches(g, info)) continue;
        if (!best || g.at < best.g.at) best = { r, g };
      }
    }
    if (!best) {
      this.deps.audit.record({
        type: 'archive_skip',
        station,
        replay: name,
        reason: 'no game start matches',
      });
      return;
    }
    const dir = join(this.deps.dir, '.raw', String(best.r.setId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), data);
    best.g.replay = { file: name, lastFrame: info.lastFrame };
    this.save(best.r);
    this.deps.audit.record({
      type: 'archive_bind',
      station,
      setId: best.r.setId,
      game: best.g.game,
      handwarmer: best.g.handwarmer,
      replay: name,
    });
  }

  // ---- finalizing ----

  private maybeFinalize(r: SetRecord): void {
    if (r.endedAt === null || !this.sets.has(r.setId)) return;
    const chosen = chosenStarts(r);
    const complete = chosen.every((g) => g?.replay);
    if (complete || Date.now() - r.endedAt >= this.finalizeTimeoutMs) this.finalize(r);
  }

  private finalize(r: SetRecord): void {
    const chosen = chosenStarts(r);
    const missing = chosen.flatMap((g, i) => (g?.replay ? [] : [i + 1]));
    const fields = setFields(r, this.deps.event);
    let result: ArchiveResult;
    try {
      const entries: ZipEntry[] = [];
      const used = new Set<string>();
      const slots: ContextSlotGame[] = [];
      chosen.forEach((g, i) => {
        if (!g?.replay) return;
        const raw = readFileSync(join(this.deps.dir, '.raw', String(r.setId), g.replay.file));
        const names: (string | null)[] = [null, null, null, null];
        if (g.e1Port !== NO_PORT && g.e2Port !== NO_PORT) {
          names[g.e1Port] = r.set.p1.tag;
          names[g.e2Port] = r.set.p2.tag;
        }
        const name = unique(
          fillName(this.deps.gameTemplate, gameFields(fields, r, g, i)) + '.slp',
          used,
        );
        entries.push({ name, data: withDisplayNames(raw, names), date: new Date(g.at) });
        slots.push({ g, winnerSlot: r.games[i]?.winner_slot ?? 0 });
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

/** Same human ports, characters, costumes and stage. */
export function matches(g: GameStartRecord, info: SlpInfo): boolean {
  if (g.stage !== info.stage) return false;
  for (const p of info.ports) {
    const human = p.type === 0;
    if (human !== (g.chars[p.port] !== NO_PORT)) return false;
    if (human && (g.chars[p.port] !== p.character || g.costumes[p.port] !== p.costume))
      return false;
  }
  return humanPorts(info).length > 0;
}

/** Per scored game (index 0 = game 1): the last non-handwarmer start with that number, or null. */
export function chosenStarts(r: SetRecord): (GameStartRecord | null)[] {
  return r.games.map((_, i) => {
    let pick: GameStartRecord | null = null;
    for (const g of r.gameStarts)
      if (!g.handwarmer && g.game === i + 1 && (!pick || g.at >= pick.at)) pick = g;
    return pick;
  });
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
  const w1 = r.games.filter((g) => g.winner_slot === 1).length;
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

/** Entrant 1's and 2's character in a game: from the claim, else from the report. */
function entrantChars(r: SetRecord, g: GameStartRecord, i: number): [number, number] {
  if (g.e1Port !== NO_PORT && g.e2Port !== NO_PORT) return [g.chars[g.e1Port]!, g.chars[g.e2Port]!];
  const rep = r.games[i];
  return [rep?.p1_char ?? NO_PORT, rep?.p2_char ?? NO_PORT];
}

export function gameFields(
  set: SetFields,
  r: SetRecord,
  g: GameStartRecord,
  i: number,
): GameFields {
  const [c1, c2] = entrantChars(r, g, i);
  const winner = r.games[i]?.winner_slot;
  return {
    ...set,
    game: String(i + 1),
    stage: shortStage(g.stage, stageName(g.stage)),
    stage_name: stageName(g.stage) ?? '',
    p1_char: shortCharacter(c1),
    p2_char: shortCharacter(c2),
    game_winner: winner === 1 ? r.set.p1.tag : winner === 2 ? r.set.p2.tag : '',
  };
}

// ---- context.json: Replay Reporter for Slippi's Context type
// (src/common/types.ts there), which Lucky Stats reads to link the zip to
// the start.gg set. ----

interface ContextSlotGame {
  g: GameStartRecord;
  winnerSlot: number; // 1 or 2: entrant
}

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

/** null when a game has no L + R claim: then nobody knows whose port was whose. */
export function context(
  r: SetRecord,
  ev: ArchiveEvent,
  games: ContextSlotGame[],
): Record<string, unknown> | null {
  if (games.length === 0 || games.some(({ g }) => g.e1Port === NO_PORT || g.e2Port === NO_PORT))
    return null;
  const tag = (entrant: number) => (entrant === 1 ? r.set.p1.tag : r.set.p2.tag);
  const wins = [0, 0];
  const scores = games.map(({ g, winnerSlot }) => {
    // Slots in port order, like Replay Reporter.
    const order = [
      { entrant: 1, port: g.e1Port },
      { entrant: 2, port: g.e2Port },
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
        .map(({ g }) => characterName(g.chars[entrant === 1 ? g.e1Port : g.e2Port]!) ?? '')
        .filter(Boolean),
    ),
  ];
  const pg = r.set.phaseGroup;
  return {
    bestOf: r.set.bestOf,
    durationMs: games.reduce(
      (ms, { g }) => ms + Math.ceil(((g.replay?.lastFrame ?? -124) + 124) / 0.06),
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
    startMs: games[0]!.g.at,
  };
}

/** True if any set record file exists; for tests. */
export function hasRecord(dir: string, setId: number): boolean {
  return existsSync(join(dir, '.sets', `${setId}.json`));
}
