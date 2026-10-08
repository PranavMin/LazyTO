// tcp.ts -- the relay's TCP server (architecture.md (Wire protocol, Error
// handling)). Everything arrives through a beamer: a Wii's request, with
// the relay_auth its beamer puts in front, or the beamer's own sync. One
// request per connection: read relay_auth + relay_hdr + payload, dispatch by
// cmd, write relay_hdr + relay_resp (+ payload), close. All business logic
// for the set commands lives here; upstream I/O goes through startgg.ts, the
// set list through cache.ts, station claims through state.ts. A Wii request
// from a beamer that is the newcomer on a station number another beamer
// holds gets ST_DUP_STATION (beamer.ts). Every request, response, and
// upstream call is audited -- except CMD_BEAMER_SYNC, a beamer's own sync
// (docs/protocol-v2.md, collect.ts), whose header carries
// BEAMER_SYNC_VERSION instead of PROTO_VERSION.

import { createServer, type Server, type Socket, type AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import {
  AUTH_MAGIC_0,
  AUTH_MAGIC_1,
  BEAMER_SYNC_VERSION,
  MAGIC_0,
  MAGIC_1,
  MAX_SETS,
  RELAY_AUTH_SIZE,
  SECRET_LEN,
  PROTO_VERSION,
  RELAY_HDR_SIZE,
  RelayCmd,
  RelayStatus,
  decodeRelayHdr,
  decodeBeamerSyncReq,
  decodeStartSetReq,
  decodeReportScoreReq,
  decodeEndSetReq,
  encodeRelayHdr,
  encodeRelayResp,
  encodeListSetsResp,
  encodeStartSetResp,
  type BeamerSyncReq,
  type GameResult,
  type SetEntry,
} from '../generated/wire.js';
import type { SetCache, CachedSet } from './cache.js';
import { StationState, wins, type Claim } from './state.js';
import { StartggClient, StartggError, RateLimitedError, type GameDataInput } from './startgg.js';
import { toStartggCharacter } from './chars.js';
import { toStartggStage } from './stages.js';

/** Where audit records go; audit.ts is the JSONL implementation. */
export interface AuditSink {
  record(event: Record<string, unknown>): void;
}

/** The set archive (archive.ts), told about each successful set action and the beamer address it came from. */
export interface ArchiveHooks {
  setStarted(station: number, set: CachedSet): void;
  scored(setId: number, games: GameResult[], from: string): void;
  setEnded(setId: number, games: GameResult[], from: string): void;
  setAbandoned(setId: number): void;
}

/** The beamers (beamer.ts): who may use a station number, and whose syncs were refused. */
export interface BeamerGate {
  admit(station: number, from: string): boolean;
  wrongSecret(from: string): void;
}

/** The beamer sync (collect.ts): a verified sync in, the signed reply payload out. */
export interface SyncHandler {
  sync(req: BeamerSyncReq, from: string): Promise<Uint8Array>;
}

export interface RelayDeps {
  cache: SetCache;
  state: StationState;
  startgg: StartggClient;
  audit: AuditSink;
  archive: ArchiveHooks;
  beamers: BeamerGate;
  collector: SyncHandler;
  /**
   * The stream setup: its station's sets go on this start.gg stream. Decided by
   * station, not by start_set_req.stream, so one setting can't disagree with
   * another. null = no stream tonight.
   */
  stream: { station: number; streamId: number } | null;
  /** Shared secret every request's relay_auth must carry (decisions.md R16). */
  secret: string;
}

/** Requests refused for a missing or wrong secret, for the status page. */
export interface RefusedStatus {
  count: number;
  lastAt: number;
  lastFrom: string;
  lastStation: number; // as claimed by the request; unauthenticated
  lastReason: string;
}

/** A dead connection must not hold the one-request socket open forever. */
const SOCKET_TIMEOUT_MS = 5000;

interface Reply {
  status: RelayStatus;
  msg: string;
  payload?: Uint8Array;
}

export class RelayTcpServer {
  private readonly server: Server;
  private readonly expectedSecret: Buffer; // SECRET_LEN bytes, NUL-padded, as relay_auth carries it
  private refusals: RefusedStatus | null = null;
  /** Connections that have not sent a whole request yet; close() drops them. */
  private readonly waiting = new Set<Socket>();

  constructor(private readonly deps: RelayDeps) {
    this.expectedSecret = Buffer.alloc(SECRET_LEN);
    this.expectedSecret.write(deps.secret, 'ascii');
    this.server = createServer((socket) => this.onConnection(socket));
  }

  /** null until a request has been refused for its secret. */
  refused(): RefusedStatus | null {
    return this.refusals && { ...this.refusals };
  }

  async listen(port: number, host = '0.0.0.0'): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  address(): AddressInfo {
    return this.server.address() as AddressInfo;
  }

  /**
   * Stop listening, drop connections still waiting for their request, and let
   * a request already received send its reply (SOCKET_TIMEOUT_MS bounds it).
   */
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
    for (const socket of this.waiting) socket.destroy();
    await closed;
  }

  // ---- framing ----

  // A request is relay_auth (the host's shared secret, decisions.md R16), then the
  // game's relay_hdr + payload. Anything else is not our protocol and is dropped.
  private onConnection(socket: Socket): void {
    const chunks: Buffer[] = [];
    let received = 0;
    let handled = false;
    this.waiting.add(socket);
    socket.on('close', () => this.waiting.delete(socket));
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      chunks.push(chunk);
      received += chunk.length;
      if (received < 2) return;

      const buf = Buffer.concat(chunks);
      if (buf[0] !== AUTH_MAGIC_0 || buf[1] !== AUTH_MAGIC_1) {
        // Not our protocol; there is no framing to answer within.
        socket.destroy();
        return;
      }
      const hdrOff = RELAY_AUTH_SIZE;
      if (received < hdrOff + RELAY_HDR_SIZE) return;
      if (buf[hdrOff] !== MAGIC_0 || buf[hdrOff + 1] !== MAGIC_1) {
        socket.destroy();
        return;
      }
      const hdr = decodeRelayHdr(buf, hdrOff);
      const payloadOff = hdrOff + RELAY_HDR_SIZE;
      if (received < payloadOff + hdr.len) return;

      handled = true;
      this.waiting.delete(socket);
      const secretOk = timingSafeEqual(buf.subarray(4, 4 + SECRET_LEN), this.expectedSecret);
      const payload = buf.subarray(payloadOff, payloadOff + hdr.len);
      const from = socket.remoteAddress ?? '?';
      const pending: Promise<Reply> = !secretOk
        ? Promise.resolve(this.refuse(hdr.cmd, hdr.station, from))
        : hdr.cmd === RelayCmd.CMD_BEAMER_SYNC
          ? this.beamerSync(hdr.version, payload, from)
          : this.handle(hdr.cmd, hdr.version, hdr.station, payload, from);
      void pending
        .then((reply) => {
          const payload = reply.payload ?? new Uint8Array(0);
          const resp = encodeRelayResp({ status: reply.status, msg: reply.msg });
          const out = Buffer.concat([
            encodeRelayHdr({
              magic: new Uint8Array([MAGIC_0, MAGIC_1]),
              version: hdr.cmd === RelayCmd.CMD_BEAMER_SYNC ? BEAMER_SYNC_VERSION : PROTO_VERSION,
              cmd: hdr.cmd,
              station: hdr.station,
              len: resp.length + payload.length,
            }),
            resp,
            payload,
          ]);
          socket.end(out);
        })
        .catch(() => socket.destroy()); // handle() never throws; belt and braces
    });
  }

  // ---- CMD_BEAMER_SYNC ----

  /**
   * A beamer's own sync (protocol.yaml beamer_sync_req). Its layout is frozen
   * under BEAMER_SYNC_VERSION, never PROTO_VERSION. collect.ts answers it
   * with a signed beamer_sync_resp. It touches no station row, and it is
   * never refused as a duplicate: collection goes on.
   */
  private async beamerSync(version: number, payload: Uint8Array, from: string): Promise<Reply> {
    if (version !== BEAMER_SYNC_VERSION) {
      return { status: RelayStatus.ST_BAD_VERSION, msg: `sync speaks v${BEAMER_SYNC_VERSION}` };
    }
    let req: BeamerSyncReq;
    try {
      req = decodeBeamerSyncReq(payload);
    } catch {
      return { status: RelayStatus.ST_INTERNAL, msg: 'bad payload' };
    }
    try {
      return {
        status: RelayStatus.ST_OK,
        msg: 'synced',
        payload: await this.deps.collector.sync(req, from),
      };
    } catch (e) {
      this.deps.audit.record({ type: 'error', cmd: 'CMD_BEAMER_SYNC', from, error: String(e) });
      return { status: RelayStatus.ST_INTERNAL, msg: 'internal error' };
    }
  }

  // ---- refused: wrong secret ----

  /** Answer without acting. The claimed station is not trusted, so no station row is touched. */
  private refuse(cmd: number, station: number, from: string): Reply {
    const reason = 'wrong relay secret';
    const prev = this.refusals?.count ?? 0;
    this.refusals = {
      count: prev + 1,
      lastAt: Date.now(),
      lastFrom: from,
      lastStation: station,
      lastReason: reason,
    };
    this.deps.audit.record({ type: 'refused', reason, from, station, cmd: RelayCmd[cmd] ?? cmd });
    if (cmd === RelayCmd.CMD_BEAMER_SYNC) this.deps.beamers.wrongSecret(from);
    return { status: RelayStatus.ST_BAD_SECRET, msg: reason };
  }

  // ---- dispatch ----

  private async handle(
    cmd: number,
    version: number,
    station: number,
    payload: Uint8Array,
    from: string,
  ): Promise<Reply> {
    const { audit, state } = this.deps;
    audit.record({ type: 'request', station, cmd: RelayCmd[cmd] ?? cmd, len: payload.length });

    let reply: Reply;
    if (version !== PROTO_VERSION) {
      reply = { status: RelayStatus.ST_BAD_VERSION, msg: `relay speaks v${PROTO_VERSION}` };
    } else if (!this.deps.beamers.admit(station, from)) {
      // Another beamer holds this number: this one is refused, and the
      // station row stays the holder's (the status page names both).
      audit.record({
        type: 'refused',
        reason: 'duplicate station',
        from,
        station,
        cmd: RelayCmd[cmd] ?? cmd,
      });
      return { status: RelayStatus.ST_DUP_STATION, msg: `two beamers are station ${station}` };
    } else {
      try {
        switch (cmd) {
          case RelayCmd.CMD_LIST_SETS:
            reply = this.listSets(station);
            break;
          case RelayCmd.CMD_START_SET:
            reply = await this.startSet(station, decodeStartSetReq(payload));
            break;
          case RelayCmd.CMD_REPORT_SCORE:
            reply = await this.reportScore(station, decodeReportScoreReq(payload), from);
            break;
          case RelayCmd.CMD_END_SET:
            reply = await this.endSet(station, decodeEndSetReq(payload), from);
            break;
          default:
            reply = { status: RelayStatus.ST_INTERNAL, msg: 'unknown command' };
        }
      } catch (e) {
        if (e instanceof RangeError) {
          reply = { status: RelayStatus.ST_INTERNAL, msg: 'bad payload' };
        } else {
          audit.record({ type: 'error', station, cmd: RelayCmd[cmd] ?? cmd, error: String(e) });
          reply = { status: RelayStatus.ST_INTERNAL, msg: 'internal error' };
        }
      }
    }

    state.recordAction(
      station,
      RelayCmd[cmd] ?? String(cmd),
      reply.status === RelayStatus.ST_OK,
      RelayStatus[reply.status] ?? String(reply.status),
      reply.msg,
    );
    audit.record({
      type: 'response',
      station,
      cmd: RelayCmd[cmd] ?? cmd,
      status: RelayStatus[reply.status],
      msg: reply.msg,
    });
    return reply;
  }

  // ---- upstream helper ----

  /** Run one upstream call; on failure audit it, flag the station row, and map to a Reply. */
  private async upstream(
    station: number,
    call: string,
    detail: Record<string, unknown>,
    fn: () => Promise<void>,
  ): Promise<Reply | null> {
    const { audit, state } = this.deps;
    try {
      await fn();
      audit.record({ type: 'upstream', call, ...detail, ok: true });
      return null;
    } catch (e) {
      audit.record({ type: 'upstream', call, ...detail, ok: false, error: String(e) });
      if (e instanceof RateLimitedError) {
        return { status: RelayStatus.ST_RATE_LIMITED, msg: 'rate limited; retry' };
      }
      if (e instanceof StartggError) {
        state.flag(station, `${call} failed: ${e.message}`);
        if (e.kind === 'rejected') {
          return { status: RelayStatus.ST_STARTGG_ERROR, msg: 'start.gg rejected - ask TO' };
        }
        return { status: RelayStatus.ST_STARTGG_ERROR, msg: 'start.gg error - retry' };
      }
      throw e;
    }
  }

  // ---- CMD_LIST_SETS ----

  private listSets(station: number): Reply {
    const { cache, state, audit } = this.deps;

    const entries: SetEntry[] = [];
    const claim = state.get(station);
    if (claim) {
      const own = cache.get(claim.setId);
      if (own) {
        entries.push(toEntry(own, 1));
      } else {
        // The set left the cache (completed or reset upstream, e.g. by the
        // TO -- decisions.md R6): the claim is stale, drop it.
        state.release(station);
        audit.record({ type: 'release', station, setId: claim.setId, reason: 'set left cache' });
        this.deps.archive.setAbandoned(claim.setId);
      }
    }

    for (const s of cache.pending()) {
      if (entries.length >= MAX_SETS) break;
      if (state.stationFor(s.id) !== undefined) continue; // claimed elsewhere
      entries.push(toEntry(s, 0));
    }

    return {
      status: RelayStatus.ST_OK,
      msg: `${entries.length} sets`,
      payload: encodeListSetsResp({ sets: entries }),
    };
  }

  // ---- CMD_START_SET ----

  // req.stream is decoded but not used (current loaders send the game's 0;
  // older ones sent the card's stream= line): the stream setup is the
  // configured station (RelayDeps.stream).
  private async startSet(station: number, req: { set_id: number; stream: number }): Promise<Reply> {
    const { cache, state, startgg, audit, stream } = this.deps;

    const claim = state.get(station);
    if (claim?.setId === req.set_id) {
      // Rebooted station resuming its own set: no upstream call. The reply
      // carries the claim's games, so the kiosk goes on from them instead of
      // 0-0 and its next report keeps them (redesign.md, N3).
      audit.record({ type: 'resume', station, setId: req.set_id, games: claim.games.length });
      return { status: RelayStatus.ST_OK, msg: 'resumed', payload: setGames(claim) };
    }
    if (claim) {
      return { status: RelayStatus.ST_INTERNAL, msg: 'finish current set first' };
    }

    const set = cache.get(req.set_id);
    if (!set) return { status: RelayStatus.ST_SET_NOT_FOUND, msg: 'unknown set' };

    const holder = state.stationFor(req.set_id);
    if (holder !== undefined) {
      return { status: RelayStatus.ST_SET_TAKEN, msg: `started on station ${holder}` };
    }
    if (set.state !== 1) {
      // In progress upstream but claimed by no station: the TO started it
      // by hand on start.gg. Not ours to take.
      return { status: RelayStatus.ST_SET_TAKEN, msg: 'in progress on start.gg' };
    }
    const markFailure = await this.upstream(
      station,
      'markSetInProgress',
      { setId: req.set_id },
      () => startgg.markSetInProgress(req.set_id),
    );
    if (markFailure) return markFailure;

    // From here the set IS in progress upstream, so the station gets the
    // claim even if the stream assignment below fails.
    const claimed = this.recordClaim(station, set);
    this.deps.archive.setStarted(station, set);

    if (stream !== null && station === stream.station) {
      const assignFailure = await this.upstream(
        station,
        'assignStream',
        { setId: req.set_id, streamId: stream.streamId },
        () => startgg.assignStream(req.set_id, stream.streamId),
      );
      if (assignFailure) {
        return { status: RelayStatus.ST_STARTGG_ERROR, msg: 'stream assign failed - ask TO' };
      }
    }

    return { status: RelayStatus.ST_OK, msg: 'set started', payload: setGames(claimed) };
  }

  private recordClaim(station: number, set: CachedSet): Claim {
    const claim: Claim = {
      setId: set.id,
      p1Id: set.p1.id,
      p2Id: set.p2.id,
      bestOf: set.bestOf,
      games: [], // only pending (unplayed) sets are claimed
    };
    this.deps.state.claim(station, claim);
    this.deps.audit.record({
      type: 'claim',
      station,
      setId: claim.setId,
      p1Id: claim.p1Id,
      p2Id: claim.p2Id,
      bestOf: claim.bestOf,
      games: claim.games,
    });
    return claim;
  }

  // ---- CMD_REPORT_SCORE ----

  private async reportScore(
    station: number,
    req: { set_id: number; game_count: number; games: GameResult[] },
    from: string,
  ): Promise<Reply> {
    const { state, startgg, audit } = this.deps;

    const claim = state.get(station);
    if (!claim || claim.setId !== req.set_id) {
      return { status: RelayStatus.ST_SET_NOT_FOUND, msg: 'no such set on this station' };
    }

    const games = validGames(req, claim);
    if (typeof games === 'string') return { status: RelayStatus.ST_INTERNAL, msg: games };

    const failure = await this.upstream(
      station,
      'reportBracketSet',
      { setId: req.set_id, games: games.list.length },
      () => startgg.reportGames(req.set_id, games.data),
    );
    if (failure) return failure;

    claim.games = games.list;
    audit.record({ type: 'score', station, setId: req.set_id, games: games.list });
    this.deps.archive.scored(req.set_id, games.list, from);
    return { status: RelayStatus.ST_OK, msg: scoreText(games.list) };
  }

  // ---- CMD_END_SET ----

  private async endSet(
    station: number,
    req: { set_id: number; game_count: number; games: GameResult[] },
    from: string,
  ): Promise<Reply> {
    const { state, startgg, audit } = this.deps;

    const claim = state.get(station);
    if (!claim || claim.setId !== req.set_id) {
      return { status: RelayStatus.ST_SET_NOT_FOUND, msg: 'no such set on this station' };
    }

    const games = validGames(req, claim);
    if (typeof games === 'string') return { status: RelayStatus.ST_INTERNAL, msg: games };

    const [wins1, wins2] = wins(games.list);
    const needed = Math.floor(claim.bestOf / 2) + 1;
    const winnerId = wins1 >= needed ? claim.p1Id : wins2 >= needed ? claim.p2Id : null;
    if (winnerId === null) {
      return {
        status: RelayStatus.ST_INTERNAL,
        msg: `no winner at ${wins1}-${wins2} bo${claim.bestOf}`,
      };
    }

    const failure = await this.upstream(
      station,
      'reportBracketSet',
      { setId: req.set_id, winnerId, games: games.list.length },
      () => startgg.reportWinner(req.set_id, winnerId, games.data),
    );
    if (failure) return failure;

    state.release(station);
    audit.record({ type: 'release', station, setId: req.set_id, reason: 'end_set', winnerId });
    this.deps.archive.setEnded(req.set_id, games.list, from);
    return { status: RelayStatus.ST_OK, msg: `final ${scoreText(games.list)}` };
  }
}

// ---- pure helpers ----

/** start_set_resp: the games the relay holds for the claimed set (none for a set just started). */
function setGames(claim: Claim): Uint8Array {
  return encodeStartSetResp({
    set_id: claim.setId,
    game_count: claim.games.length,
    games: claim.games,
  });
}

function toEntry(s: CachedSet, state: 0 | 1): SetEntry {
  return {
    set_id: s.id,
    p1_entrant_id: s.p1.id,
    p2_entrant_id: s.p2.id,
    round: s.roundName,
    p1_tag: s.p1.tag,
    p2_tag: s.p2.tag,
    best_of: s.bestOf,
    state,
  };
}

/**
 * Validate the wire game list against the claim and translate it for
 * start.gg: winner slots -> entrant ids, plus characters (chars.ts) and the
 * stage (stages.ts) when the Wii knew them -- the auto-score path fills them
 * from the match standings; a hand-scored game sends zeros (decisions.md R13).
 * Returns an error msg string on bad data.
 */
function validGames(
  req: { game_count: number; games: GameResult[] },
  claim: Claim,
): { list: GameResult[]; data: GameDataInput[] } | string {
  if (req.game_count > claim.bestOf) return `more games than bo${claim.bestOf}`;
  const list = req.games.slice(0, req.game_count);
  const data: GameDataInput[] = [];
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    if (g.winner_slot !== 1 && g.winner_slot !== 2) return `game ${i + 1}: bad winner slot`;
    const entry: GameDataInput = {
      gameNum: i + 1,
      winnerId: g.winner_slot === 1 ? claim.p1Id : claim.p2Id,
    };
    // Characters and stage (decisions.md R13): sent when the Wii knew them
    // (auto-scored games), omitted when it did not (0 / ChKind_None from a
    // hand-scored game) or when the value has no start.gg mapping. An
    // unmapped value never blocks the report -- the winner is what matters.
    const selections: { entrantId: number; characterId: number }[] = [];
    const c1 = toStartggCharacter(g.p1_char);
    const c2 = toStartggCharacter(g.p2_char);
    if (c1 !== undefined) selections.push({ entrantId: claim.p1Id, characterId: c1 });
    if (c2 !== undefined) selections.push({ entrantId: claim.p2Id, characterId: c2 });
    if (selections.length) entry.selections = selections;
    const stage = toStartggStage(g.stage);
    if (stage !== undefined) entry.stageId = stage;
    // Stocks remaining as the per-game score, with the costume (colour) index
    // folded in as hundreds, the way Replay Reporter for Slippi reports:
    // 204 = second costume, 4 stocks. start.gg shows colour and stock icons
    // from it. Only when the Wii knew the stocks (auto-scored games).
    const s1 = packedScore(g.p1_stocks, g.p1_costume);
    const s2 = packedScore(g.p2_stocks, g.p2_costume);
    if (s1 !== undefined && s2 !== undefined) {
      entry.entrant1Score = s1;
      entry.entrant2Score = s2;
    }
    data.push(entry);
  }
  return { list, data };
}

/** (costume + 1) * 100 + stocks; undefined when the stocks are unknown (0xFF). A costume of 0xFF leaves the hundreds off. */
function packedScore(stocks: number, costume: number): number | undefined {
  if (stocks === 0xff || stocks > 99) return undefined;
  return (costume === 0xff ? 0 : (costume + 1) * 100) + stocks;
}

function scoreText(games: GameResult[]): string {
  return wins(games).join('-');
}
