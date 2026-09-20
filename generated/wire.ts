// wire.ts -- GENERATED from protocol.yaml by tools/gen_protocol.py -- DO NOT EDIT.
//
// Struct encode/decode for the Wii <-> relay protocol (design.md section 5).
// All integers big-endian. Strings are ASCII, NUL-padded, not NUL-terminated
// if full; encode silently truncates over-long strings and replaces
// non-printable-ASCII characters with '?'. _pad and variable-array count
// fields are wire artifacts and do not appear on the interfaces.

export const PROTO_VERSION = 1;
export const MAGIC_0 = 0x4d; // 'M'
export const MAGIC_1 = 0x54; // 'T'

export const MAX_GAMES = 5; // games per set (best of 5)
export const MAX_SETS = 63; // cap on set_entry rows in a LIST_SETS response; 63 is the most that fits the game's 4 KB poll buffer (4096 - 4 state - 8 hdr - 32 resp - 4 fixed = 4048 bytes = 63 rows of 64)
export const MSG_LEN = 30; // human-readable status text in relay_resp
export const ROUND_LEN = 16; // round name, e.g. WR2, LF, GF
export const TAG_LEN = 16; // player tag

/** request/response command, echoed back in the response header */
export enum RelayCmd {
  CMD_LIST_SETS = 1,
  CMD_START_SET = 2,
  CMD_REPORT_SCORE = 3,
  CMD_END_SET = 4,
  CMD_ABANDON_SET = 5, // player-initiated "wrong set"; relay resets it
}

/** result of a request, first byte of relay_resp */
export enum RelayStatus {
  ST_OK = 0,
  ST_BAD_VERSION = 1,
  ST_SET_NOT_FOUND = 2,
  ST_SET_TAKEN = 3, // started on another station
  ST_NOT_STREAM = 4, // stream flag from non-stream station
  ST_STARTGG_ERROR = 5, // upstream rejected; see status page
  ST_RATE_LIMITED = 6,
  ST_INTERNAL = 7,
}

/** Command byte on the fake relay EXI device. Shared by the game side (lbrelayexi.c), Slippi Dolphin's forwarder, and Nintendont's RelayEXI; not part of the TCP wire format. Values chosen clear of Slippi's EXI command space, which extends to 0xE5 (CMD_GET_RANK_VISIBILITY in EXI_DeviceSlippi.h). */
export enum ExiCmd {
  EXI_RELAY_REQ = 240, // write request buffer to the ARM side
  EXI_RELAY_POLL = 241, // read {state, response buffer}
}

/** first byte returned by EXI_RELAY_POLL */
export enum ExiPollState {
  RELAY_IDLE = 0,
  RELAY_BUSY = 1, // request in flight on the ARM side
  RELAY_DONE = 2, // response buffer valid
  RELAY_ERROR = 3, // transport failed; see status byte detail
}

// ---- ASCII field helpers ----

function putAscii(bytes: Uint8Array, off: number, len: number, s: string): void {
  for (let i = 0; i < len; i++) {
    let c = i < s.length ? s.charCodeAt(i) : 0;
    if (c !== 0 && (c < 0x20 || c > 0x7e)) c = 0x3f; // '?'
    bytes[off + i] = c;
  }
}

function getAscii(bytes: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && bytes[end] !== 0) end++;
  let s = '';
  for (let i = off; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function checkLen(buf: Uint8Array, off: number, need: number, what: string): void {
  if (off < 0 || off + need > buf.length) {
    throw new RangeError(
      `${what}: need ${need} bytes at offset ${off}, have ${buf.length}`,
    );
  }
}

// ---- relay_hdr (8 bytes) ----

/** Every message (request and response) begins with this header. */
export interface RelayHdr {
  magic: Uint8Array; // 'M','T'
  version: number; // PROTO_VERSION
  cmd: number; // enum relay_cmd
  station: number; // from tournament.cfg
  len: number; // payload bytes following the header
}
export const RELAY_HDR_SIZE = 8;

export function encodeRelayHdr(v: RelayHdr): Uint8Array {
  const bytes = new Uint8Array(RELAY_HDR_SIZE);
  const dv = new DataView(bytes.buffer);
  bytes.set(v.magic.subarray(0, 2), 0);
  dv.setUint8(2, v.version);
  dv.setUint8(3, v.cmd);
  dv.setUint16(4, v.station, false);
  dv.setUint16(6, v.len, false);
  return bytes;
}

export function decodeRelayHdr(buf: Uint8Array, off = 0): RelayHdr {
  checkLen(buf, off, RELAY_HDR_SIZE, 'relay_hdr');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    magic: buf.slice(off + 0, off + 0 + 2),
    version: dv.getUint8(off + 2),
    cmd: dv.getUint8(off + 3),
    station: dv.getUint16(off + 4, false),
    len: dv.getUint16(off + 6, false),
  };
}


// ---- relay_resp (32 bytes) ----

/** Every response: relay_hdr (same cmd), then this, then an optional command-specific payload (see messages). */
export interface RelayResp {
  status: number; // enum relay_status
  msg: string; // short human text for the menu
}
export const RELAY_RESP_SIZE = 32;

export function encodeRelayResp(v: RelayResp): Uint8Array {
  const bytes = new Uint8Array(RELAY_RESP_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, v.status);
  putAscii(bytes, 2, MSG_LEN, v.msg);
  return bytes;
}

export function decodeRelayResp(buf: Uint8Array, off = 0): RelayResp {
  checkLen(buf, off, RELAY_RESP_SIZE, 'relay_resp');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    status: dv.getUint8(off + 0),
    msg: getAscii(buf, off + 2, MSG_LEN),
  };
}


// ---- set_entry (64 bytes) ----

/** One selectable set in a LIST_SETS response. */
export interface SetEntry {
  set_id: number;
  p1_entrant_id: number;
  p2_entrant_id: number;
  round: string; // "WR2", "LF", "GF"
  p1_tag: string;
  p2_tag: string;
  best_of: number; // 3 or 5
  state: number; // 0 = pending, 1 = in progress (this station)
}
export const SET_ENTRY_SIZE = 64;

export function encodeSetEntry(v: SetEntry): Uint8Array {
  const bytes = new Uint8Array(SET_ENTRY_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, v.set_id, false);
  dv.setUint32(4, v.p1_entrant_id, false);
  dv.setUint32(8, v.p2_entrant_id, false);
  putAscii(bytes, 12, ROUND_LEN, v.round);
  putAscii(bytes, 28, TAG_LEN, v.p1_tag);
  putAscii(bytes, 44, TAG_LEN, v.p2_tag);
  dv.setUint8(60, v.best_of);
  dv.setUint8(61, v.state);
  return bytes;
}

export function decodeSetEntry(buf: Uint8Array, off = 0): SetEntry {
  checkLen(buf, off, SET_ENTRY_SIZE, 'set_entry');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    set_id: dv.getUint32(off + 0, false),
    p1_entrant_id: dv.getUint32(off + 4, false),
    p2_entrant_id: dv.getUint32(off + 8, false),
    round: getAscii(buf, off + 12, ROUND_LEN),
    p1_tag: getAscii(buf, off + 28, TAG_LEN),
    p2_tag: getAscii(buf, off + 44, TAG_LEN),
    best_of: dv.getUint8(off + 60),
    state: dv.getUint8(off + 61),
  };
}


// ---- list_sets_resp (4 bytes + variable tail) ----

/** CMD_LIST_SETS response payload. count set_entry rows follow the fixed part. */
export interface ListSetsResp {
  sets: SetEntry[];
}
export const LIST_SETS_RESP_SIZE = 4; // fixed part; sets[] follows

export function encodeListSetsResp(v: ListSetsResp): Uint8Array {
  if (v.sets.length > MAX_SETS) {
    throw new RangeError(`list_sets_resp.sets: ${v.sets.length} entries, max ` + MAX_SETS);
  }
  const bytes = new Uint8Array(LIST_SETS_RESP_SIZE + v.sets.length * SET_ENTRY_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, v.sets.length, false);
  for (let i = 0; i < v.sets.length; i++) {
    bytes.set(encodeSetEntry(v.sets[i]), 4 + i * SET_ENTRY_SIZE);
  }
  return bytes;
}

export function decodeListSetsResp(buf: Uint8Array, off = 0): ListSetsResp {
  checkLen(buf, off, LIST_SETS_RESP_SIZE, 'list_sets_resp');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const count = dv.getUint16(off + 0, false);
  if (count > MAX_SETS) {
    throw new RangeError(`list_sets_resp.count: ${count} entries, max ` + MAX_SETS);
  }
  checkLen(buf, off, LIST_SETS_RESP_SIZE + count * SET_ENTRY_SIZE, 'list_sets_resp');
  return {
    sets: Array.from({ length: count }, (_, i) => decodeSetEntry(buf, off + 4 + i * SET_ENTRY_SIZE)),
  };
}


// ---- start_set_req (8 bytes) ----

/** CMD_START_SET request payload. */
export interface StartSetReq {
  set_id: number;
  stream: number; // from tournament.cfg
}
export const START_SET_REQ_SIZE = 8;

export function encodeStartSetReq(v: StartSetReq): Uint8Array {
  const bytes = new Uint8Array(START_SET_REQ_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, v.set_id, false);
  dv.setUint8(4, v.stream);
  return bytes;
}

export function decodeStartSetReq(buf: Uint8Array, off = 0): StartSetReq {
  checkLen(buf, off, START_SET_REQ_SIZE, 'start_set_req');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    set_id: dv.getUint32(off + 0, false),
    stream: dv.getUint8(off + 4),
  };
}


// ---- game_result (4 bytes) ----

/** One completed game. */
export interface GameResult {
  winner_slot: number; // 1 or 2
  p1_char: number; // Melee external character id (CharacterKind, the CSS ckind value)
  p2_char: number;
}
export const GAME_RESULT_SIZE = 4;

export function encodeGameResult(v: GameResult): Uint8Array {
  const bytes = new Uint8Array(GAME_RESULT_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, v.winner_slot);
  dv.setUint8(1, v.p1_char);
  dv.setUint8(2, v.p2_char);
  return bytes;
}

export function decodeGameResult(buf: Uint8Array, off = 0): GameResult {
  checkLen(buf, off, GAME_RESULT_SIZE, 'game_result');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    winner_slot: dv.getUint8(off + 0),
    p1_char: dv.getUint8(off + 1),
    p2_char: dv.getUint8(off + 2),
  };
}


// ---- report_score_req (28 bytes) ----

/** CMD_REPORT_SCORE request payload. Always the full game list; the relay does a full overwrite (idempotent). */
export interface ReportScoreReq {
  set_id: number;
  game_count: number; // 0-5 valid entries in games
  games: GameResult[];
}
export const REPORT_SCORE_REQ_SIZE = 28;

export function encodeReportScoreReq(v: ReportScoreReq): Uint8Array {
  const bytes = new Uint8Array(REPORT_SCORE_REQ_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, v.set_id, false);
  dv.setUint8(4, v.game_count);
  if (v.games.length > MAX_GAMES) {
    throw new RangeError(`report_score_req.games: ${v.games.length} entries, max ` + MAX_GAMES);
  }
  for (let i = 0; i < v.games.length; i++) {
    bytes.set(encodeGameResult(v.games[i]), 8 + i * GAME_RESULT_SIZE);
  }
  return bytes;
}

export function decodeReportScoreReq(buf: Uint8Array, off = 0): ReportScoreReq {
  checkLen(buf, off, REPORT_SCORE_REQ_SIZE, 'report_score_req');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    set_id: dv.getUint32(off + 0, false),
    game_count: dv.getUint8(off + 4),
    games: Array.from({ length: MAX_GAMES }, (_, i) => decodeGameResult(buf, off + 8 + i * GAME_RESULT_SIZE)),
  };
}


// ---- end_set_req (28 bytes) ----

/** CMD_END_SET request payload. Relay derives the winner from the game list. */
export interface EndSetReq {
  set_id: number;
  game_count: number;
  games: GameResult[];
}
export const END_SET_REQ_SIZE = 28;

export function encodeEndSetReq(v: EndSetReq): Uint8Array {
  const bytes = new Uint8Array(END_SET_REQ_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, v.set_id, false);
  dv.setUint8(4, v.game_count);
  if (v.games.length > MAX_GAMES) {
    throw new RangeError(`end_set_req.games: ${v.games.length} entries, max ` + MAX_GAMES);
  }
  for (let i = 0; i < v.games.length; i++) {
    bytes.set(encodeGameResult(v.games[i]), 8 + i * GAME_RESULT_SIZE);
  }
  return bytes;
}

export function decodeEndSetReq(buf: Uint8Array, off = 0): EndSetReq {
  checkLen(buf, off, END_SET_REQ_SIZE, 'end_set_req');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    set_id: dv.getUint32(off + 0, false),
    game_count: dv.getUint8(off + 4),
    games: Array.from({ length: MAX_GAMES }, (_, i) => decodeGameResult(buf, off + 8 + i * GAME_RESULT_SIZE)),
  };
}


// ---- abandon_set_req (4 bytes) ----

/** CMD_ABANDON_SET request payload. Only valid if the set has no reported games. */
export interface AbandonSetReq {
  set_id: number;
}
export const ABANDON_SET_REQ_SIZE = 4;

export function encodeAbandonSetReq(v: AbandonSetReq): Uint8Array {
  const bytes = new Uint8Array(ABANDON_SET_REQ_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, v.set_id, false);
  return bytes;
}

export function decodeAbandonSetReq(buf: Uint8Array, off = 0): AbandonSetReq {
  checkLen(buf, off, ABANDON_SET_REQ_SIZE, 'abandon_set_req');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    set_id: dv.getUint32(off + 0, false),
  };
}


// ---- message map (design.md section 5): request struct after relay_hdr,
// ---- payload struct after relay_resp in an ST_OK response ----

export const REQUEST_DECODERS = {
  [RelayCmd.CMD_START_SET]: decodeStartSetReq,
  [RelayCmd.CMD_REPORT_SCORE]: decodeReportScoreReq,
  [RelayCmd.CMD_END_SET]: decodeEndSetReq,
  [RelayCmd.CMD_ABANDON_SET]: decodeAbandonSetReq,
} as const;

export const RESPONSE_PAYLOAD_DECODERS = {
  [RelayCmd.CMD_LIST_SETS]: decodeListSetsResp,
} as const;
