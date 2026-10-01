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
export const MAX_SETS = 56; // cap on set_entry rows in a LIST_SETS response; 56 is the most that fits the game's 4 KB poll buffer (4096 - 12 exi_poll_hdr - 8 hdr - 32 resp - 4 fixed = 4040 bytes = 56 rows of 72)
export const MSG_LEN = 30; // human-readable status text in relay_resp
export const ROUND_LEN = 24; // round name as the players see it, upper case: "WINNERS QUARTER-FINAL", "LOSERS ROUND 1", "GRAND FINAL RESET" (start.gg fullRoundText, cut to fit)
export const TAG_LEN = 16; // player tag
export const BEACON_PORT = 7778; // UDP port the relay broadcasts relay_beacon to and every station listens on (design R15: stations find the relay; tournament.cfg has no relay address)
export const BEACON_INTERVAL_MS = 2000; // the relay sends one relay_beacon per interval on every IPv4 interface
export const SECRET_LEN = 16; // relay shared secret, printable ASCII, NUL-padded (design R16)
export const AUTH_MAGIC_0 = 77; // 'M', first byte of relay_auth
export const AUTH_MAGIC_1 = 75; // 'K', second byte of relay_auth; differs from relay_hdr's 'T' so a host that sends no relay_auth is told so
export const TELEMETRY_PORT = 7779; // UDP port on the relay that stations send telemetry datagrams to (kernel log lines and the module's load status), at the address the beacon came from
export const TELEMETRY_MAGIC_1 = 76; // 'L', second byte of telemetry_hdr ('M','L')
export const TELEMETRY_TEXT_MAX = 480; // most log text bytes in one TM_LOG datagram; keeps relay_auth + telemetry_hdr + text well under one Ethernet frame
export const TELEMETRY_STATUS_MS = 5000; // a station sends a TM_STATUS datagram at least this often once it knows the relay

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
  ST_BAD_SECRET = 8, // relay_auth missing or its secret wrong; check secret= on the SD card (design R16)
}

/** Command byte on the fake relay EXI device. Shared by the game side (lbrelayexi.c), Slippi Dolphin's forwarder, and Nintendont's RelayEXI; not part of the TCP wire format. Values chosen clear of Slippi's EXI command space, which extends to 0xE5 (CMD_GET_RANK_VISIBILITY in EXI_DeviceSlippi.h). */
export enum ExiCmd {
  EXI_RELAY_REQ = 240, // write request buffer to the ARM side
  EXI_RELAY_POLL = 241, // read {state, response buffer}
}

/** state byte of exi_poll_hdr, the first thing an EXI_RELAY_POLL read returns */
export enum ExiPollState {
  RELAY_IDLE = 0,
  RELAY_BUSY = 1, // request in flight on the ARM side
  RELAY_DONE = 2, // response buffer valid
  RELAY_ERROR = 3, // transport failed; response buffer is zeroed
}

/** what follows a telemetry_hdr */
export enum TelemetryKind {
  TM_LOG = 1, // len bytes of kernel log text, ASCII, lines ending in \n (a line may be split across datagrams)
  TM_STATUS = 2, // one station_status
}

/** what the host did with sd:/tournament.bin at game boot (Nintendont kernel LoadTournamentModule) */
export enum ModuleState {
  MOD_PENDING = 0, // no game booted yet
  MOD_LOADED = 1,
  MOD_NOT_FOUND = 2, // no sd:/tournament.bin
  MOD_BAD_FILE = 3, // not a TMOD file
  MOD_BAD_HEADER = 4, // unsupported version, size or load address
  MOD_GUARD = 5, // guard word mismatch: the disc is not stock Melee 1.02
  MOD_ARENA = 6, // the module would overlap game memory (arena top below the module)
  MOD_READ_FAILED = 7,
  MOD_NOT_MELEE = 8, // the booted game is not Melee NTSC 1.02
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

// ---- exi_poll_hdr (12 bytes) ----

/** What an EXI_RELAY_POLL read starts with (the game's lbRelayExi_PollBuf: this, then relay_hdr, relay_resp and the payload). Not on the TCP wire: filled by the host of the fake EXI device (Nintendont kernel, Slippi Dolphin) on every poll, so the game can show which station it is and which relay it is talking to even while the relay never answers. The response bytes after it are valid only when state == RELAY_DONE. */
export interface ExiPollHdr {
  state: number; // enum exi_poll_state
  station: number; // tournament.cfg station; 0 in Dolphin (design R10)
  relay_ip: number; // relay IPv4 address as a big-endian u32 (10.0.0.2 = 0x0A000002); 0 = unknown
  relay_port: number; // relay TCP port; 0 = unknown
}
export const EXI_POLL_HDR_SIZE = 12;

export function encodeExiPollHdr(v: ExiPollHdr): Uint8Array {
  const bytes = new Uint8Array(EXI_POLL_HDR_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, v.state);
  dv.setUint16(2, v.station, false);
  dv.setUint32(4, v.relay_ip, false);
  dv.setUint16(8, v.relay_port, false);
  return bytes;
}

export function decodeExiPollHdr(buf: Uint8Array, off = 0): ExiPollHdr {
  checkLen(buf, off, EXI_POLL_HDR_SIZE, 'exi_poll_hdr');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    state: dv.getUint8(off + 0),
    station: dv.getUint16(off + 2, false),
    relay_ip: dv.getUint32(off + 4, false),
    relay_port: dv.getUint16(off + 8, false),
  };
}


// ---- relay_beacon (12 bytes) ----

/** Relay discovery (design R15). Not on the TCP wire: one UDP datagram, broadcast by the relay every BEACON_INTERVAL_MS to each IPv4 interface's directed broadcast address, port BEACON_PORT. A station (Nintendont kernel, Slippi Dolphin forwarder) listens on BEACON_PORT, ignores datagrams whose size, magic or version do not match, and takes the datagram's SOURCE address plus tcp_port as the relay; the latest valid beacon wins, so a relay that changes address is followed. One relay per LAN. */
export interface RelayBeacon {
  magic: Uint8Array; // 'M','T'
  version: number; // PROTO_VERSION
  tcp_port: number; // the relay's TCP port for relay_hdr requests
  event_id: number; // start.gg event the relay serves; for logs and display only
}
export const RELAY_BEACON_SIZE = 12;

export function encodeRelayBeacon(v: RelayBeacon): Uint8Array {
  const bytes = new Uint8Array(RELAY_BEACON_SIZE);
  const dv = new DataView(bytes.buffer);
  bytes.set(v.magic.subarray(0, 2), 0);
  dv.setUint8(2, v.version);
  dv.setUint16(4, v.tcp_port, false);
  dv.setUint32(8, v.event_id, false);
  return bytes;
}

export function decodeRelayBeacon(buf: Uint8Array, off = 0): RelayBeacon {
  checkLen(buf, off, RELAY_BEACON_SIZE, 'relay_beacon');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    magic: buf.slice(off + 0, off + 0 + 2),
    version: dv.getUint8(off + 2),
    tcp_port: dv.getUint16(off + 4, false),
    event_id: dv.getUint32(off + 8, false),
  };
}


// ---- relay_auth (20 bytes) ----

/** Relay shared secret (design R16). Not part of the game's messages: the host of the fake EXI device (Nintendont kernel, Slippi Dolphin forwarder) writes it on the TCP connection before the game's relay_hdr + payload, with the secret from its own config (tournament.cfg secret=, Dolphin SlippiRelaySecret). The relay compares the secret with its config in constant time and answers a missing or wrong one with ST_BAD_SECRET without acting on the request. Responses carry no relay_auth. Plaintext on the LAN: it keeps passers-by on a shared Wi-Fi out, not someone capturing the Wi-Fi traffic. */
export interface RelayAuth {
  magic: Uint8Array; // AUTH_MAGIC_0, AUTH_MAGIC_1 ('M','K')
  secret: string; // the shared secret, NUL-padded
}
export const RELAY_AUTH_SIZE = 20;

export function encodeRelayAuth(v: RelayAuth): Uint8Array {
  const bytes = new Uint8Array(RELAY_AUTH_SIZE);
  const dv = new DataView(bytes.buffer);
  bytes.set(v.magic.subarray(0, 2), 0);
  putAscii(bytes, 4, SECRET_LEN, v.secret);
  return bytes;
}

export function decodeRelayAuth(buf: Uint8Array, off = 0): RelayAuth {
  checkLen(buf, off, RELAY_AUTH_SIZE, 'relay_auth');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    magic: buf.slice(off + 0, off + 0 + 2),
    secret: getAscii(buf, off + 4, SECRET_LEN),
  };
}


// ---- telemetry_hdr (16 bytes) ----

/** Station telemetry. Not part of the game's messages: the host of the fake EXI device (Nintendont kernel) sends one UDP datagram per message to the relay's address from the beacon, port TELEMETRY_PORT: relay_auth (the same shared secret as TCP requests), this header, then len payload bytes (TM_LOG text or one station_status). The relay drops datagrams with a wrong secret (counted on the status page), keeps the last log lines and status per station, and never answers. seq counts datagrams from 0 at kernel boot, so a gap is a lost datagram and a smaller seq is a reboot. */
export interface TelemetryHdr {
  magic: Uint8Array; // MAGIC_0, TELEMETRY_MAGIC_1 ('M','L')
  version: number; // PROTO_VERSION
  kind: number; // enum telemetry_kind
  station: number; // tournament.cfg station
  len: number; // payload bytes after this header
  seq: number;
  uptime_ms: number; // milliseconds since the kernel started
}
export const TELEMETRY_HDR_SIZE = 16;

export function encodeTelemetryHdr(v: TelemetryHdr): Uint8Array {
  const bytes = new Uint8Array(TELEMETRY_HDR_SIZE);
  const dv = new DataView(bytes.buffer);
  bytes.set(v.magic.subarray(0, 2), 0);
  dv.setUint8(2, v.version);
  dv.setUint8(3, v.kind);
  dv.setUint16(4, v.station, false);
  dv.setUint16(6, v.len, false);
  dv.setUint32(8, v.seq, false);
  dv.setUint32(12, v.uptime_ms, false);
  return bytes;
}

export function decodeTelemetryHdr(buf: Uint8Array, off = 0): TelemetryHdr {
  checkLen(buf, off, TELEMETRY_HDR_SIZE, 'telemetry_hdr');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    magic: buf.slice(off + 0, off + 0 + 2),
    version: dv.getUint8(off + 2),
    kind: dv.getUint8(off + 3),
    station: dv.getUint16(off + 4, false),
    len: dv.getUint16(off + 6, false),
    seq: dv.getUint32(off + 8, false),
    uptime_ms: dv.getUint32(off + 12, false),
  };
}


// ---- station_status (20 bytes) ----

/** TM_STATUS payload: what the station's host knows about its own boot. */
export interface StationStatus {
  module_state: number; // enum module_state
  module_patches: number; // hook patches applied (MOD_LOADED)
  module_len: number; // module code bytes (MOD_LOADED)
  module_load: number; // module load address (MOD_LOADED)
  arena_hi: number; // the boot-info arena top (0x80000034) the host saw at load time; 0 = unset, the game then uses its built-in default
  log_dropped: number; // log bytes discarded because the host's buffer was full
}
export const STATION_STATUS_SIZE = 20;

export function encodeStationStatus(v: StationStatus): Uint8Array {
  const bytes = new Uint8Array(STATION_STATUS_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, v.module_state);
  dv.setUint16(2, v.module_patches, false);
  dv.setUint32(4, v.module_len, false);
  dv.setUint32(8, v.module_load, false);
  dv.setUint32(12, v.arena_hi, false);
  dv.setUint32(16, v.log_dropped, false);
  return bytes;
}

export function decodeStationStatus(buf: Uint8Array, off = 0): StationStatus {
  checkLen(buf, off, STATION_STATUS_SIZE, 'station_status');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    module_state: dv.getUint8(off + 0),
    module_patches: dv.getUint16(off + 2, false),
    module_len: dv.getUint32(off + 4, false),
    module_load: dv.getUint32(off + 8, false),
    arena_hi: dv.getUint32(off + 12, false),
    log_dropped: dv.getUint32(off + 16, false),
  };
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


// ---- set_entry (72 bytes) ----

/** One selectable set in a LIST_SETS response. The relay sends them earliest round first, so equal round names are adjacent (the menu groups them under one header). */
export interface SetEntry {
  set_id: number;
  p1_entrant_id: number;
  p2_entrant_id: number;
  round: string; // "WINNERS QUARTER-FINAL", "LOSERS ROUND 1"
  p1_tag: string;
  p2_tag: string;
  best_of: number; // 3 or 5
  state: number; // 0 = pending, 1 = in progress (this station)
}
export const SET_ENTRY_SIZE = 72;

export function encodeSetEntry(v: SetEntry): Uint8Array {
  const bytes = new Uint8Array(SET_ENTRY_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, v.set_id, false);
  dv.setUint32(4, v.p1_entrant_id, false);
  dv.setUint32(8, v.p2_entrant_id, false);
  putAscii(bytes, 12, ROUND_LEN, v.round);
  putAscii(bytes, 36, TAG_LEN, v.p1_tag);
  putAscii(bytes, 52, TAG_LEN, v.p2_tag);
  dv.setUint8(68, v.best_of);
  dv.setUint8(69, v.state);
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
    p1_tag: getAscii(buf, off + 36, TAG_LEN),
    p2_tag: getAscii(buf, off + 52, TAG_LEN),
    best_of: dv.getUint8(off + 68),
    state: dv.getUint8(off + 69),
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
  p1_char: number; // Melee external character id (CharacterKind, the CSS ckind value: 0 = Captain Falcon .. 25 = Ganondorf) of entrant 1; 0xFF = unknown (a game scored by hand). Anything the relay cannot map is omitted, never rejected.
  p2_char: number;
  stage: number; // Melee internal stage id (StKind, e.g. 0x1F Battlefield, 0x20 Final Destination); 0 = unknown, e.g. a game scored by hand
}
export const GAME_RESULT_SIZE = 4;

export function encodeGameResult(v: GameResult): Uint8Array {
  const bytes = new Uint8Array(GAME_RESULT_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, v.winner_slot);
  dv.setUint8(1, v.p1_char);
  dv.setUint8(2, v.p2_char);
  dv.setUint8(3, v.stage);
  return bytes;
}

export function decodeGameResult(buf: Uint8Array, off = 0): GameResult {
  checkLen(buf, off, GAME_RESULT_SIZE, 'game_result');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    winner_slot: dv.getUint8(off + 0),
    p1_char: dv.getUint8(off + 1),
    p2_char: dv.getUint8(off + 2),
    stage: dv.getUint8(off + 3),
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
