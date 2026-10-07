// wii-client.ts -- a minimal Wii impersonator for tests and scripts/sim-wii.ts.
// Speaks the wire protocol the way the kernel does: one TCP connection per
// request, send, read until close, decode.

import { connect } from 'node:net';
import {
  MAGIC_0,
  MAGIC_1,
  PROTO_VERSION,
  RELAY_HDR_SIZE,
  RELAY_RESP_SIZE,
  RelayCmd,
  decodeListSetsResp,
  decodeRelayHdr,
  decodeRelayResp,
  encodeGameStartReq,
  NO_PORT,
  type GameStartReq,
  encodeEndSetReq,
  encodeRelayHdr,
  encodeRelayAuth,
  AUTH_MAGIC_0,
  AUTH_MAGIC_1,
  encodeReportScoreReq,
  encodeStartSetReq,
  type GameResult,
  type ListSetsResp,
  type RelayHdr,
  type RelayResp,
} from '../generated/wire.js';

/** The secret tests and the sim use; a relay under test is configured with it. */
export const TEST_SECRET = 'test-secret-1234';

export interface WireReply {
  hdr: RelayHdr;
  resp: RelayResp;
  payload: Uint8Array;
}

export function rawRequest(
  port: number,
  station: number,
  cmd: number,
  payload: Uint8Array = new Uint8Array(0),
  { version = PROTO_VERSION, host = '127.0.0.1', timeoutMs = 3000, secret = TEST_SECRET } = {},
): Promise<WireReply> {
  const auth = encodeRelayAuth({ magic: new Uint8Array([AUTH_MAGIC_0, AUTH_MAGIC_1]), secret });
  const req = Buffer.concat([
    auth,
    encodeRelayHdr({
      magic: new Uint8Array([MAGIC_0, MAGIC_1]),
      version,
      cmd,
      station,
      len: payload.length,
    }),
    payload,
  ]);
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host });
    const chunks: Buffer[] = [];
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error('relay timeout'));
    });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(req));
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('close', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < RELAY_HDR_SIZE + RELAY_RESP_SIZE) {
        reject(new Error(`short response: ${buf.length} bytes`));
        return;
      }
      resolve({
        hdr: decodeRelayHdr(buf),
        resp: decodeRelayResp(buf, RELAY_HDR_SIZE),
        payload: buf.subarray(RELAY_HDR_SIZE + RELAY_RESP_SIZE),
      });
    });
  });
}

export class WiiClient {
  constructor(
    private readonly port: number,
    readonly station: number,
    private readonly stream: 0 | 1 = 0,
    private readonly host = '127.0.0.1',
    private readonly secret: string = TEST_SECRET,
  ) {}

  private request(cmd: number, payload?: Uint8Array): Promise<WireReply> {
    return rawRequest(this.port, this.station, cmd, payload, {
      host: this.host,
      secret: this.secret,
    });
  }

  async listSets(): Promise<{ resp: RelayResp; sets: ListSetsResp['sets'] }> {
    const r = await this.request(RelayCmd.CMD_LIST_SETS);
    return { resp: r.resp, sets: r.resp.status === 0 ? decodeListSetsResp(r.payload).sets : [] };
  }

  startSet(setId: number, stream = this.stream): Promise<WireReply> {
    return this.request(RelayCmd.CMD_START_SET, encodeStartSetReq({ set_id: setId, stream }));
  }

  reportScore(setId: number, games: GameResult[]): Promise<WireReply> {
    return this.request(
      RelayCmd.CMD_REPORT_SCORE,
      encodeReportScoreReq({ set_id: setId, game_count: games.length, games: padGames(games) }),
    );
  }

  endSet(setId: number, games: GameResult[]): Promise<WireReply> {
    return this.request(
      RelayCmd.CMD_END_SET,
      encodeEndSetReq({ set_id: setId, game_count: games.length, games: padGames(games) }),
    );
  }

  gameStart(req: GameStartReq): Promise<WireReply> {
    return this.request(RelayCmd.CMD_GAME_START, encodeGameStartReq(req));
  }
}

/** A game_start_req: entrant 1 on port e1 with c1, entrant 2 on e2 with c2 (costume 0 each); other ports empty. */
export function gameStartReq(
  setId: number,
  game: number,
  opts: {
    handwarmer?: boolean;
    stage?: number;
    e1?: number;
    e2?: number;
    c1?: number;
    c2?: number;
  } = {},
): GameStartReq {
  const e1 = opts.e1 ?? 0;
  const e2 = opts.e2 ?? 1;
  const chars = new Uint8Array([NO_PORT, NO_PORT, NO_PORT, NO_PORT]);
  const costumes = new Uint8Array([NO_PORT, NO_PORT, NO_PORT, NO_PORT]);
  chars[e1] = opts.c1 ?? 2;
  chars[e2] = opts.c2 ?? 9;
  costumes[e1] = 0;
  costumes[e2] = 0;
  return {
    set_id: setId,
    game,
    handwarmer: opts.handwarmer ? 1 : 0,
    stage: opts.stage ?? 0x1f,
    e1_port: e1,
    e2_port: e2,
    chars,
    costumes,
  };
}

// Defaults are what an auto-scored game carries: Fox (ext 2) vs Marth (ext 9)
// on Battlefield (StKind 0x1F). A hand-scored game sends 0xFF, 0xFF, 0
// (0 is Captain Falcon on the external character scale).
export function game(
  winnerSlot: 1 | 2,
  p1Char = 2,
  p2Char = 9,
  stage = 0x1f,
  stocks: [number, number] = [0xff, 0xff],
  costumes: [number, number] = [0xff, 0xff],
): GameResult {
  return {
    winner_slot: winnerSlot,
    p1_char: p1Char,
    p2_char: p2Char,
    stage,
    p1_stocks: stocks[0],
    p2_stocks: stocks[1],
    p1_costume: costumes[0],
    p2_costume: costumes[1],
  };
}

function padGames(games: GameResult[]): GameResult[] {
  const out = [...games];
  while (out.length < 5)
    out.push({
      winner_slot: 0,
      p1_char: 0,
      p2_char: 0,
      stage: 0,
      p1_stocks: 0,
      p2_stocks: 0,
      p1_costume: 0,
      p2_costume: 0,
    });
  return out;
}
