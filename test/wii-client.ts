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
  decodeStartSetResp,
  decodeRelayHdr,
  decodeRelayResp,
  NO_PORT,
  encodeEndSetReq,
  encodeRelayHdr,
  encodeRelayAuth,
  AUTH_MAGIC_0,
  AUTH_MAGIC_1,
  encodeReportScoreReq,
  encodeStartSetReq,
  type GameResult,
  type ListSetsResp,
  type StartSetResp,
  type RelayHdr,
  type RelayResp,
} from '../generated/wire.js';
import { relayAuthKey } from '../src/sync.js';

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
  {
    version = PROTO_VERSION,
    host = '127.0.0.1',
    timeoutMs = 3000,
    secret = TEST_SECRET,
    localAddress = undefined as string | undefined,
  } = {},
): Promise<WireReply> {
  const auth = encodeRelayAuth({
    magic: new Uint8Array([AUTH_MAGIC_0, AUTH_MAGIC_1]),
    key: relayAuthKey(secret),
  });
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
    // A Wii's request reaches the relay from its beamer's address: tests give a second beamer 127.0.0.2.
    const socket = connect({ port, host, localAddress });
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
    /** The address of the beamer this Wii's requests come through. */
    private readonly localAddress?: string,
  ) {}

  private request(cmd: number, payload?: Uint8Array): Promise<WireReply> {
    return rawRequest(this.port, this.station, cmd, payload, {
      host: this.host,
      secret: this.secret,
      localAddress: this.localAddress,
    });
  }

  async listSets(): Promise<{ resp: RelayResp; sets: ListSetsResp['sets'] }> {
    const r = await this.request(RelayCmd.CMD_LIST_SETS);
    return { resp: r.resp, sets: r.resp.status === 0 ? decodeListSetsResp(r.payload).sets : [] };
  }

  startSet(setId: number, stream = this.stream): Promise<WireReply> {
    return this.request(RelayCmd.CMD_START_SET, encodeStartSetReq({ set_id: setId, stream }));
  }

  /** START_SET, with the games the relay holds for the set (none unless it is a resume). */
  async startSetGames(
    setId: number,
    stream = this.stream,
  ): Promise<{ resp: RelayResp; games: GameResult[] | null; reply: StartSetResp | null }> {
    const r = await this.startSet(setId, stream);
    if (r.resp.status !== 0) return { resp: r.resp, games: null, reply: null };
    const reply = decodeStartSetResp(r.payload);
    return { resp: r.resp, games: reply.games.slice(0, reply.game_count), reply };
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
}

// Defaults are what an auto-scored game carries: Fox (ext 2) vs Marth (ext 9)
// on Battlefield (StKind 0x1F). A hand-scored game sends 0xFF, 0xFF, 0
// (0 is Captain Falcon on the external character scale). Ports and the
// replay id default to unknown and none; `more` sets them.
export function game(
  winnerSlot: 1 | 2,
  p1Char = 2,
  p2Char = 9,
  stage = 0x1f,
  stocks: [number, number] = [0xff, 0xff],
  costumes: [number, number] = [0xff, 0xff],
  more: Partial<Pick<GameResult, 'p1_port' | 'p2_port' | 'replay_id'>> = {},
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
    p1_port: NO_PORT,
    p2_port: NO_PORT,
    replay_id: 0,
    ...more,
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
      p1_port: 0,
      p2_port: 0,
      replay_id: 0,
    });
  return out;
}
