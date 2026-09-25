// tcp.ts -- the Wii-facing TCP server (design.md sections 5-8). One request
// per connection: read relay_hdr + payload, dispatch by cmd, write
// relay_hdr + relay_resp (+ payload), close. All business logic for the
// five commands lives here; upstream I/O goes through startgg.ts, the set
// list through cache.ts, station claims through state.ts. Every request,
// response, and upstream call is audited.

import { createServer, type Server, type Socket, type AddressInfo } from 'node:net';
import {
  MAGIC_0,
  MAGIC_1,
  MAX_SETS,
  PROTO_VERSION,
  RELAY_HDR_SIZE,
  RelayCmd,
  RelayStatus,
  decodeRelayHdr,
  decodeStartSetReq,
  decodeReportScoreReq,
  decodeEndSetReq,
  decodeAbandonSetReq,
  encodeRelayHdr,
  encodeRelayResp,
  encodeListSetsResp,
  type GameResult,
  type SetEntry,
} from '../generated/wire.js';
import type { SetCache, CachedSet } from './cache.js';
import { StationState, type Claim } from './state.js';
import { StartggClient, StartggError, RateLimitedError, type GameDataInput } from './startgg.js';
import { toStartggCharacter } from './chars.js';
import { toStartggStage } from './stages.js';

/** Where audit records go; audit.ts is the JSONL implementation. */
export interface AuditSink {
  record(event: Record<string, unknown>): void;
}

export interface RelayDeps {
  cache: SetCache;
  state: StationState;
  startgg: StartggClient;
  audit: AuditSink;
  streamStation: number;
  streamId: number;
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

  constructor(private readonly deps: RelayDeps) {
    this.server = createServer((socket) => this.onConnection(socket));
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

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((e) => (e ? reject(e) : resolve())));
  }

  // ---- framing ----

  private onConnection(socket: Socket): void {
    const chunks: Buffer[] = [];
    let received = 0;
    let handled = false;
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      chunks.push(chunk);
      received += chunk.length;
      if (received < RELAY_HDR_SIZE) return;

      const buf = Buffer.concat(chunks);
      if (buf[0] !== MAGIC_0 || buf[1] !== MAGIC_1) {
        // Not our protocol; there is no framing to answer within.
        socket.destroy();
        return;
      }
      const hdr = decodeRelayHdr(buf);
      if (received < RELAY_HDR_SIZE + hdr.len) return;

      handled = true;
      void this.handle(hdr.cmd, hdr.version, hdr.station, buf.subarray(RELAY_HDR_SIZE, RELAY_HDR_SIZE + hdr.len))
        .then((reply) => {
          const payload = reply.payload ?? new Uint8Array(0);
          const resp = encodeRelayResp({ status: reply.status, msg: reply.msg });
          const out = Buffer.concat([
            encodeRelayHdr({
              magic: new Uint8Array([MAGIC_0, MAGIC_1]),
              version: PROTO_VERSION,
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

  // ---- dispatch ----

  private async handle(cmd: number, version: number, station: number, payload: Uint8Array): Promise<Reply> {
    const { audit, state } = this.deps;
    audit.record({ type: 'request', station, cmd: RelayCmd[cmd] ?? cmd, len: payload.length });

    let reply: Reply;
    if (version !== PROTO_VERSION) {
      reply = { status: RelayStatus.ST_BAD_VERSION, msg: `relay speaks v${PROTO_VERSION}` };
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
            reply = await this.reportScore(station, decodeReportScoreReq(payload));
            break;
          case RelayCmd.CMD_END_SET:
            reply = await this.endSet(station, decodeEndSetReq(payload));
            break;
          case RelayCmd.CMD_ABANDON_SET:
            reply = await this.abandonSet(station, decodeAbandonSetReq(payload));
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
  private async upstream(station: number, call: string, detail: Record<string, unknown>, fn: () => Promise<void>): Promise<Reply | null> {
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
        // TO -- design.md R6): the claim is stale, drop it.
        state.release(station);
        audit.record({ type: 'release', station, setId: claim.setId, reason: 'set left cache' });
      }
    }

    for (const s of cache.pending()) {
      if (entries.length >= MAX_SETS) break;
      if (state.stationFor(s.id) !== undefined) continue; // claimed elsewhere
      entries.push(toEntry(s, 0));
    }

    return { status: RelayStatus.ST_OK, msg: `${entries.length} sets`, payload: encodeListSetsResp({ sets: entries }) };
  }

  // ---- CMD_START_SET ----

  private async startSet(station: number, req: { set_id: number; stream: number }): Promise<Reply> {
    const { cache, state, startgg, audit, streamStation, streamId } = this.deps;

    const claim = state.get(station);
    if (claim?.setId === req.set_id) {
      // Rebooted station resuming its own set: no upstream call (section 7.1).
      audit.record({ type: 'resume', station, setId: req.set_id });
      return { status: RelayStatus.ST_OK, msg: 'resumed' };
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
    if (req.stream === 1 && station !== streamStation) {
      return { status: RelayStatus.ST_NOT_STREAM, msg: 'not the stream station' };
    }

    const markFailure = await this.upstream(station, 'markSetInProgress', { setId: req.set_id }, () =>
      startgg.markSetInProgress(req.set_id),
    );
    if (markFailure) return markFailure;

    // From here the set IS in progress upstream, so the station gets the
    // claim even if the stream assignment below fails (section 5.3).
    this.recordClaim(station, set);

    if (req.stream === 1) {
      const assignFailure = await this.upstream(station, 'assignStream', { setId: req.set_id, streamId }, () =>
        startgg.assignStream(req.set_id, streamId),
      );
      if (assignFailure) {
        return { status: RelayStatus.ST_STARTGG_ERROR, msg: 'stream assign failed - ask TO' };
      }
    }

    return { status: RelayStatus.ST_OK, msg: 'set started' };
  }

  private recordClaim(station: number, set: CachedSet): void {
    const claim: Claim = {
      setId: set.id,
      p1Id: set.p1.id,
      p2Id: set.p2.id,
      bestOf: set.bestOf,
      games: set.games.map((g) => ({ winner_slot: g.winnerSlot, p1_char: 0xff, p2_char: 0xff, stage: 0 })),
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
  }

  // ---- CMD_REPORT_SCORE ----

  private async reportScore(station: number, req: { set_id: number; game_count: number; games: GameResult[] }): Promise<Reply> {
    const { state, startgg, audit } = this.deps;

    const claim = state.get(station);
    if (!claim || claim.setId !== req.set_id) {
      return { status: RelayStatus.ST_SET_NOT_FOUND, msg: 'no such set on this station' };
    }

    const games = validGames(req, claim);
    if (typeof games === 'string') return { status: RelayStatus.ST_INTERNAL, msg: games };

    const failure = await this.upstream(station, 'reportBracketSet', { setId: req.set_id, games: games.list.length }, () =>
      startgg.reportGames(req.set_id, games.data),
    );
    if (failure) return failure;

    claim.games = games.list;
    audit.record({ type: 'score', station, setId: req.set_id, games: games.list });
    return { status: RelayStatus.ST_OK, msg: scoreText(games.list) };
  }

  // ---- CMD_END_SET ----

  private async endSet(station: number, req: { set_id: number; game_count: number; games: GameResult[] }): Promise<Reply> {
    const { state, startgg, audit } = this.deps;

    const claim = state.get(station);
    if (!claim || claim.setId !== req.set_id) {
      return { status: RelayStatus.ST_SET_NOT_FOUND, msg: 'no such set on this station' };
    }

    const games = validGames(req, claim);
    if (typeof games === 'string') return { status: RelayStatus.ST_INTERNAL, msg: games };

    const wins1 = games.list.filter((g) => g.winner_slot === 1).length;
    const wins2 = games.list.length - wins1;
    const needed = Math.floor(claim.bestOf / 2) + 1;
    const winnerId = wins1 >= needed ? claim.p1Id : wins2 >= needed ? claim.p2Id : null;
    if (winnerId === null) {
      return { status: RelayStatus.ST_INTERNAL, msg: `no winner at ${wins1}-${wins2} bo${claim.bestOf}` };
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
    return { status: RelayStatus.ST_OK, msg: `final ${scoreText(games.list)}` };
  }

  // ---- CMD_ABANDON_SET ----

  private async abandonSet(station: number, req: { set_id: number }): Promise<Reply> {
    const { state, startgg, audit } = this.deps;

    const claim = state.get(station);
    if (!claim || claim.setId !== req.set_id) {
      return { status: RelayStatus.ST_SET_NOT_FOUND, msg: 'no such set on this station' };
    }
    if (claim.games.length > 0) {
      // Undoing a set with reported games is a TO decision (section 5.6).
      return { status: RelayStatus.ST_INTERNAL, msg: 'set has games - ask TO' };
    }

    const failure = await this.upstream(station, 'resetSet', { setId: req.set_id }, () => startgg.resetSet(req.set_id));
    if (failure) return failure;

    state.release(station);
    audit.record({ type: 'release', station, setId: req.set_id, reason: 'abandon' });
    return { status: RelayStatus.ST_OK, msg: 'set abandoned' };
  }
}

// ---- pure helpers ----

function toEntry(s: CachedSet, state: 0 | 1): SetEntry {
  return {
    set_id: s.id,
    p1_entrant_id: s.p1.id,
    p2_entrant_id: s.p2.id,
    round: s.roundShort,
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
 * from the match standings; a hand-scored game sends zeros (design.md R13).
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
    // Characters and stage (design.md R13): sent when the Wii knew them
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
    data.push(entry);
  }
  return { list, data };
}

function scoreText(games: GameResult[]): string {
  const wins1 = games.filter((g) => g.winner_slot === 1).length;
  return `${wins1}-${games.length - wins1}`;
}
