// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Kegstand Jesus (PranavMin)
//
// wire.ts -- GENERATED from protocol.yaml by tools/gen_protocol.py -- DO NOT EDIT.
//
// Struct encode/decode for the Wii <-> relay protocol (architecture.md).
// All integers big-endian. Strings are ASCII, NUL-padded, not NUL-terminated
// if full; encode silently truncates over-long strings and replaces
// non-printable-ASCII characters with '?'. _pad and variable-array count
// fields are wire artifacts and do not appear on the interfaces.

export const PROTO_VERSION = 2;
export const MAGIC_0 = 0x4d; // 'M'
export const MAGIC_1 = 0x54; // 'T'

export const MAX_GAMES = 5; // games per set (best of 5)
export const MAX_SETS = 56; // cap on set_entry rows in a LIST_SETS response; 56 is the most that fits the game's 4 KB poll buffer (4096 - 16 exi_poll_hdr - 8 hdr - 32 resp - 4 fixed = 4036 bytes; 56 rows of 72 = 4032)
export const MSG_LEN = 30; // human-readable status text in relay_resp
export const ROUND_LEN = 24; // round name as the players see it, upper case: "WINNERS QUARTER-FINAL", "LOSERS ROUND 1", "GRAND FINAL RESET" (start.gg fullRoundText, cut to fit)
export const TAG_LEN = 16; // player tag
export const EXI_PAYLOAD_MAX = 88; // largest request payload the game hands the host after relay_hdr (report_score_req / end_set_req); the kiosk's request buffer and the kernel's EXI staging buffer are both this size
export const RELAY_REPLY_MAX = 4080; // longest reply (relay_hdr + relay_resp + payload) the relay may send a Wii: the game's 4096-byte poll buffer after the 16-byte exi_poll_hdr. The beamer's response sectors hold 4084; a host treats a longer reply as malformed
export const BEACON_PORT = 29471; // UDP port the relay broadcasts relay_beacon to and every beamer (and the Dolphin forwarder) listens on (decisions.md R15)
export const BEACON_INTERVAL_MS = 2000; // the relay sends one relay_beacon per interval on every IPv4 interface
export const BEACON_STALE_S = 10; // a beamer_hello whose beacon_age_s is above this is a stale beacon: the kernel sets PF_RELAY_STALE (five beacons missed)
export const SECRET_LEN = 16; // relay shared secret, printable ASCII, NUL-padded (decisions.md R16); in v2 it lives on the beamer (CONFIG/config.txt LAZYTO-SECRET), never on the Wii
export const AUTH_MAGIC_0 = 77; // 'M', first byte of relay_auth
export const AUTH_MAGIC_1 = 75; // 'K', second byte of relay_auth; differs from relay_hdr's 'T' so a host that sends no relay_auth is told so
export const TELEMETRY_PORT = 29472; // UDP port on the relay that beamers forward telemetry datagrams to (kernel log lines and the module's load status) and send beacon requests to, at the address the beacon came from
export const TELEMETRY_MAGIC_1 = 76; // 'L', second byte of telemetry_hdr ('M','L')
export const TELEMETRY_TEXT_MAX = 480; // most log text bytes in one TM_LOG datagram; keeps relay_auth + telemetry_hdr + text well under one Ethernet frame
export const TELEMETRY_STATUS_MS = 5000; // a station sends a TM_STATUS datagram at least this often once it knows the relay
export const CRASH_MAILBOX_PPC = 3540006016; // PPC uncached MEM2 address of the crash_mailbox the game's module writes from its OS error handler; the Nintendont kernel reads it at 0x13003480 (same bytes) and sends a TM_CRASH when seq changes. Between HID_STATUS (0x13003440..0x1300344C) and slippi_settings (0x13003500). Not used by Dolphin.
export const CRASH_MAGIC = 1297367890; // 'MTCR', first word of crash_mailbox
export const CRASH_STACK_DEPTH = 8; // LR saves walked up the crashed stack in crash_report
export const RECORD_GATE_PPC = 3540005376; // PPC uncached MEM2 address of the record_gate (64 bytes, two 32-byte cache lines); free as far as the code shows, to be confirmed on hardware (docs/redesign.md Plan, phase 1). Not used by Dolphin.
export const RECORD_GATE_ARM = 318779904; // the same record_gate as the Nintendont kernel addresses it
export const RECORD_THIS_MATCH = 1297371697; // 'MTR1': record_gate.want while the kiosk wants the match whose Game Start is being sent recorded; any other value means do not record
export const RECORD_GATE_HOST_BUILD = 7; // the first Nintendont host_build (exi_poll_hdr.host_build) with the record gate; the kiosk touches RECORD_GATE_PPC only when host_build is at least this (Dolphin sends 0)
export const NO_PORT = 255; // game_result: the CSS port of an entrant is unknown (a game scored by hand without an L + R claim)
export const BEAMER_SECTOR_SIZE = 512; // sector size of the beamer mailbox (the beamer reports its SD card's 512-byte sectors)
export const BEAMER_MB_SECTORS = 16; // sectors in the beamer mailbox window, which starts at the end of the replay partition (LBA = partition end + offset)
export const BEAMER_MB_HELLO = 0; // mailbox sector of beamer_hello (beamer to Wii)
export const BEAMER_MB_REQ = 1; // mailbox sector of the request: beamer_req_hdr + relay_hdr + payload, no relay_auth (Wii to beamer)
export const BEAMER_MB_RESP = 2; // first mailbox sector of the response: beamer_resp_hdr + the relay's reply (beamer to Wii)
export const BEAMER_MB_RESP_SECTORS = 8; // sectors the response spans: 4096 - 12 = 4084 reply bytes, of which a Wii takes at most RELAY_REPLY_MAX
export const BEAMER_MB_TELE = 10; // first mailbox sector of a telemetry datagram: beamer_tele_hdr + telemetry_hdr + payload, no relay_auth (Wii to beamer)
export const BEAMER_MB_TELE_SECTORS = 2; // sectors a telemetry datagram may span (beamer_tele_hdr 12 + telemetry_hdr 16 + TELEMETRY_TEXT_MAX 480 = 508 fits the first; the second is kept from mailbox v1)
export const BEAMER_MB_VERSION = 2; // mailbox layout version in beamer_hello. 2 (2026-10-07): beamer_hello v2, station and secret on the beamer, requests and telemetry without relay_auth
export const BEAMER_FW_MIN = 2; // the lowest beamer_hello.fw_build a v2 kernel accepts (mailbox v2, the beacon checked by magic and length, the scan fix, the sync); below it the kernel reports NB_OLD_FIRMWARE
export const BEAMER_SYNC_VERSION = 1; // FROZEN. relay_hdr.version of a CMD_BEAMER_SYNC request and of its reply, in place of PROTO_VERSION: the sync layout never changes with the Wii protocol
export const SYNC_MAX_FILES = 16; // most sync_file entries in one beamer_sync_req (and sync_answer entries in its reply)
export const SYNC_NAME_LEN = 40; // file name bytes in sync_file: Game_<12 hex MAC>_<YYYYMMDDTHHMMSS>.slp is 37. A beamer never syncs a longer name (it is counted, never acked, never erased)
export const SYNC_ID_LEN = 16; // bytes of a beamer's station_id (its StationId, derived from the MAC; /status shows it as a UUID) and of an archive_id
export const SHA256_LEN = 32; // bytes of a SHA-256 digest and of an HMAC-SHA256

/** request/response command, echoed back in the response header. 6 (CMD_GAME_START, v1) is retired: never reuse it */
export enum RelayCmd {
  CMD_LIST_SETS = 1,
  CMD_START_SET = 2,
  CMD_REPORT_SCORE = 3,
  CMD_END_SET = 4,
  CMD_ABANDON_SET = 5, // player-initiated "wrong set"; never sent, and the relay does not handle it
  CMD_BEAMER_SYNC = 8, // FROZEN value. Sent by a beamer itself (never a Wii) on its relay link, with relay_hdr.version = BEAMER_SYNC_VERSION: its inventory and ack questions (beamer_sync_req); the relay answers beamer_sync_resp, signed. Touches no set and no station row
}

/** result of a request, first byte of relay_resp */
export enum RelayStatus {
  ST_OK = 0,
  ST_BAD_VERSION = 1,
  ST_SET_NOT_FOUND = 2,
  ST_SET_TAKEN = 3, // started on another station
  ST_NOT_STREAM = 4, // no longer sent: the relay picks the stream station itself
  ST_STARTGG_ERROR = 5, // upstream rejected; see status page
  ST_RATE_LIMITED = 6,
  ST_INTERNAL = 7,
  ST_BAD_SECRET = 8, // relay_auth missing or its secret wrong; check LAZYTO-SECRET in the beamer's CONFIG/config.txt (decisions.md R16)
  ST_DUP_STATION = 9, // another beamer (another station_id) already plays as this station number: this one, the newcomer, is refused until one of them is renumbered; msg names the number
}

/** Command byte on the fake relay EXI device. Shared by the game side (lbrelayexi.c), Slippi Dolphin's forwarder, and Nintendont's RelayEXI; not part of the TCP wire format. Values chosen clear of Slippi's EXI command space, which extends to 0xE5 (CMD_GET_RANK_VISIBILITY in EXI_DeviceSlippi.h). */
export enum ExiCmd {
  EXI_RELAY_REQ = 240, // write request buffer to the ARM side
  EXI_RELAY_POLL = 241, // read {state, response buffer}
}

/** bit flags in exi_poll_hdr.flags, set by the Nintendont kernel from the beamer's latest hello so the kiosk can say why a request cannot go out; 0 = nothing known wrong (Dolphin). 1, 2, 4 and 8 (v1: PF_NO_NETWORK, PF_NO_CFG, the card's PF_NO_SECRET, PF_NET_JOINING) are retired: never reuse them */
export enum ExiPollFlags {
  PF_NO_BEAMER = 16, // no valid v2 beamer_hello: no LazyTO beamer on USB; exi_poll_hdr.no_beamer_reason says why
  PF_NO_STATION = 32, // the beamer has no station number (hello without BF_STATION_SET): press its button. Requests are not sent and telemetry is dropped until it has one
  PF_NO_SECRET = 64, // the beamer has no LAZYTO-SECRET in its CONFIG/config.txt (hello without BF_SECRET)
  PF_RELAY_STALE = 128, // the beamer knows a relay address (BF_RELAY) but has not heard its beacon for more than BEACON_STALE_S; requests still go to that address
}

/** exi_poll_hdr.no_beamer_reason: why PF_NO_BEAMER is set. 0 = no reason known, or PF_NO_BEAMER clear */
export enum NoBeamerReason {
  NB_UNKNOWN = 0,
  NB_REPLAYS_OFF = 1, // the loader's Slippi replays option is off or the game is not on SD, so USB is never started
  NB_NO_DRIVE = 2, // no USB mass-storage drive is mounted
  NB_NOT_LAZYTO = 3, // a drive, but no beamer_hello magic past its replay partition: a plain stick, or a beamer without LAZYTO = true
  NB_OLD_FIRMWARE = 4, // a LazyTO beamer whose hello is an older mailbox version or whose fw_build is below BEAMER_FW_MIN: update the beamer
  NB_STARTING = 5, // no hello yet within about 45 s of kernel boot or a USB removal: the beamer may still be booting, erasing or joining the Wi-Fi
  NB_NEW_FIRMWARE = 6, // the beamer's hello is a newer mailbox version than this loader knows: update the SD card
}

/** bit flags in exi_poll_hdr.host_opts: what the host's settings ask the kiosk to do with Melee's audio (the kiosk forces mono and music off unless told otherwise) */
export enum ExiHostOpts {
  HO_MUSIC_ON = 1, // leave Melee's music on (sound balance untouched)
  HO_STEREO = 2, // leave Melee in stereo (no OSSetSoundMode(mono))
}

/** state byte of exi_poll_hdr, the first thing an EXI_RELAY_POLL read returns */
export enum ExiPollState {
  RELAY_IDLE = 0,
  RELAY_BUSY = 1, // request in flight on the ARM side
  RELAY_DONE = 2, // response buffer valid
  RELAY_ERROR = 3, // the request did not reach the relay or its answer did not come back; exi_poll_hdr.last_fail says why; the response buffer is zeroed
}

/** exi_poll_hdr.last_fail: why the last request ended in RELAY_ERROR. 0 = none (the last request completed, or none yet). 1-0x7F are beamer_result values (BR_*), whether the beamer answered with it or the kernel knew it from the hello and did not send; 0x80 and up are the kernel's own */
export enum RelayFail {
  LF_NONE = 0,
  LF_NO_BEAMER = 128, // no valid beamer_hello when the request came (PF_NO_BEAMER)
  LF_USB_WRITE = 129, // writing the request sector failed
  LF_USB_READ = 130, // reading the response sectors failed
  LF_USB_BUSY = 131, // the USB lock stayed taken past the request's budget: the Slippi writer, or a beamer recovering its SD card
  LF_NO_ANSWER = 132, // no response carrying the request's seq within the 3 s budget
  LF_BAD_REPLY = 133, // the beamer's response was malformed: bad magic, len above RELAY_REPLY_MAX, or a relay_hdr that does not echo the request (a bug: tell the TO)
  LF_BAD_REQUEST = 134, // the game's request was malformed or longer than EXI_PAYLOAD_MAX (a bug: tell the TO)
  LF_BEAMER_LOST = 135, // the beamer's hello went invalid while the request was in flight (unplugged or rebooted)
}

/** what follows a telemetry_hdr */
export enum TelemetryKind {
  TM_LOG = 1, // len bytes of kernel log text, ASCII, lines ending in \n (a line may be split across datagrams)
  TM_STATUS = 2, // one station_status
  TM_CRASH = 3, // one crash_report: the game took an unhandled exception
}

/** beamer_resp_hdr.result: how the beamer's round trip to the relay went (also beamer_hello.last_result, and passed through in exi_poll_hdr.last_fail) */
export enum BeamerResult {
  BR_OK = 0, // the relay's reply follows, len bytes
  BR_NO_RELAY = 1, // the beamer has not found the relay (no beacon yet)
  BR_NO_WIFI = 2, // the beamer is not on Wi-Fi
  BR_CONNECT = 3, // TCP connect to the relay failed: the laptop is unreachable or its firewall blocks LazyTO
  BR_TIMEOUT = 4, // the relay did not answer within the budget
  BR_TOO_LARGE = 5, // the relay's reply did not fit the mailbox
  BR_BAD_REQ = 6, // the request sector was malformed (bad magic or length)
  BR_NO_STATION = 7, // the beamer has no station number; refused without contacting the relay
  BR_NO_SECRET = 8, // the beamer has no LAZYTO-SECRET; refused without contacting the relay
}

/** bit flags in beamer_hello.flags */
export enum BeamerFlags {
  BF_WIFI = 1, // joined the Wi-Fi and has an address (exactly when wifi is WIFI_UP)
  BF_RELAY = 2, // has heard the relay's beacon; relay_ip, relay_port and beacon_age_s are valid
  BF_STATION_SET = 4, // station is valid: the beamer has a number (LazyTO mode: saved in its flash, unset until the first click)
  BF_SECRET = 8, // its CONFIG/config.txt has a LAZYTO-SECRET, which it puts in relay_auth
}

/** beamer_hello.wifi, copied as-is into exi_poll_hdr.beamer_wifi: the beamer's Wi-Fi state. 0 = up (in exi_poll_hdr: up or unknown) */
export enum BeamerWifi {
  WIFI_UP = 0,
  WIFI_JOINING = 1, // joining or getting an address; clears by itself (the kiosk waits up to 60 s)
  WIFI_NO_SSID = 2, // no SSID in CONFIG/config.txt
  WIFI_CANT_JOIN = 3, // the network cannot be reached or refused the password (firmware WIFI ISSUE)
  WIFI_NO_ADDRESS = 4, // joined, but DHCP gave no address (firmware WIFI TOO FULL)
  WIFI_RADIO = 5, // the radio failed to start (firmware RADIO FAILURE)
}

/** beamer_hello.storage, copied as-is into exi_poll_hdr.beamer_storage: the beamer's SD card. 0 = fine (in exi_poll_hdr: fine or unknown) */
export enum BeamerStorage {
  STORE_OK = 0,
  STORE_NO_CARD = 1, // no SD card (firmware NO SD CARD)
  STORE_UNREADABLE = 2, // the card cannot be read (SD UNREADABLE, DRIVE FAILING)
  STORE_WRITE_FAILED = 3, // a write failed or the card stayed busy (WRITE FAILED, CARD STUCK)
  STORE_WRONG_FORMAT = 4, // not the FAT32 layout the beamer needs (WRONG FORMAT)
  STORE_FILLING = 5, // 384 files or more, or under 1 GB free: replug the beamer to erase collected replays
  STORE_FULL = 6, // under 64 MB free: the next replay would fail (REPLAYS NOT SAVING)
}

/** FROZEN. bit flags in beamer_sync_req.flags */
export enum BeamerSyncFlags {
  SF_STATION_SET = 1, // station is valid
  SF_COLD_BOOT = 2, // this boot was a cold boot (power-on, first boot since power was applied); the erase report is this boot's
  SF_ERASE_FAILED = 4, // an unlink failed during this boot's erase, which then stopped
  SF_ACKS_DROPPED = 8, // the ack table was dropped at this boot because the card changed (FAT volume serial or SD CID)
  SF_MORE = 16, // more files need an answer than this sync lists; the beamer syncs again soon
}

/** FROZEN. sync_file.kind: what the beamer knows about a file. Files with an ack are never listed (they are counted in to_erase) */
export enum SyncKind {
  SK_FINISHED = 1, // complete: its size covers the raw length in its header
  SK_INCOMPLETE = 2, // not live and not complete: an interrupted recording; the relay keeps it as partial
  SK_LIVE = 3, // being recorded now (raw length 0, the newest file, a host command in the last few seconds); not served yet
}

/** FROZEN. sync_answer.answer. 0 is NOTED so a zero-filled answer never erases or downloads anything */
export enum SyncAnswerKind {
  SA_NOTED = 0, // known; nothing to do now (live, already downloading, disk full, or not wanted yet)
  SA_HELD = 1, // the laptop has stored this file; sha256 is the SHA-256 of its stored copy. The beamer acks the file only if that equals the SHA-256 it computed serving it this boot
  SA_WANTED = 2, // the laptop will download this file (GET from the beamer's HTTP port)
}

/** what the host did with sd:/lazyto_kiosk.bin at game boot (Nintendont kernel LoadTournamentModule) */
export enum ModuleState {
  MOD_PENDING = 0, // no game booted yet
  MOD_LOADED = 1,
  MOD_NOT_FOUND = 2, // no sd:/lazyto_kiosk.bin
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

// ---- exi_poll_hdr (16 bytes) ----

/** What an EXI_RELAY_POLL read starts with (the game's lbRelayExi_PollBuf: this, then relay_hdr, relay_resp and the payload). Not on the TCP wire: filled by the host of the fake EXI device (Nintendont kernel, Slippi Dolphin) on every poll, from the beamer's latest hello, so the game can show which station it is, which relay it is talking to and what is wrong even while the relay never answers. The response bytes after it are valid only when state == RELAY_DONE. Every field after host_build reads 0 as fine or unknown, so the Dolphin forwarder sends zeros. */
export interface ExiPollHdr {
  state: number; // enum exi_poll_state
  flags: number; // exi_poll_flags bits: why a request cannot go out yet; 0 = nothing known wrong (Dolphin)
  station: number; // the beamer's station number from its hello (valid unless PF_NO_STATION or PF_NO_BEAMER); 0 in Dolphin (decisions.md R10)
  relay_ip: number; // relay IPv4 address from the hello, big-endian u32 (10.0.0.2 = 0x0A000002); 0 = unknown (no BF_RELAY)
  relay_port: number; // relay TCP port; 0 = unknown
  host_opts: number; // exi_host_opts bits: venue audio choices from the host's settings (Nintendont loader menu); 0 = the kiosk defaults, mono and music off (Dolphin)
  host_build: number; // the host's build number for the set list's version text and feature gates (Nintendont RELAY_HOST_BUILD, bumped by hand per loader release; RECORD_GATE_HOST_BUILD); 0 = unknown (Dolphin)
  no_beamer_reason: number; // enum no_beamer_reason, with PF_NO_BEAMER; 0 otherwise
  beamer_wifi: number; // enum beamer_wifi from the hello; 0 = up or unknown
  beamer_storage: number; // enum beamer_storage from the hello; 0 = fine or unknown
  last_fail: number; // enum relay_fail (or a beamer_result below 0x80): why the last request ended in RELAY_ERROR; 0 = none
}
export const EXI_POLL_HDR_SIZE = 16;

export function encodeExiPollHdr(v: ExiPollHdr): Uint8Array {
  const bytes = new Uint8Array(EXI_POLL_HDR_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, v.state);
  dv.setUint8(1, v.flags);
  dv.setUint16(2, v.station, false);
  dv.setUint32(4, v.relay_ip, false);
  dv.setUint16(8, v.relay_port, false);
  dv.setUint8(10, v.host_opts);
  dv.setUint8(11, v.host_build);
  dv.setUint8(12, v.no_beamer_reason);
  dv.setUint8(13, v.beamer_wifi);
  dv.setUint8(14, v.beamer_storage);
  dv.setUint8(15, v.last_fail);
  return bytes;
}

export function decodeExiPollHdr(buf: Uint8Array, off = 0): ExiPollHdr {
  checkLen(buf, off, EXI_POLL_HDR_SIZE, 'exi_poll_hdr');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    state: dv.getUint8(off + 0),
    flags: dv.getUint8(off + 1),
    station: dv.getUint16(off + 2, false),
    relay_ip: dv.getUint32(off + 4, false),
    relay_port: dv.getUint16(off + 8, false),
    host_opts: dv.getUint8(off + 10),
    host_build: dv.getUint8(off + 11),
    no_beamer_reason: dv.getUint8(off + 12),
    beamer_wifi: dv.getUint8(off + 13),
    beamer_storage: dv.getUint8(off + 14),
    last_fail: dv.getUint8(off + 15),
  };
}


// ---- relay_beacon (12 bytes) ----

/** FROZEN. Relay discovery (decisions.md R15). Not on the TCP wire: one UDP datagram, broadcast by the relay every BEACON_INTERVAL_MS to each IPv4 interface's directed broadcast address, port BEACON_PORT. A beamer (and the Dolphin forwarder) listens on BEACON_PORT, ignores datagrams whose length or magic do not match, never checks version (dongles have no over-the-air update), and takes the datagram's SOURCE address plus tcp_port as the relay; the latest valid beacon wins, so a relay that changes address is followed. One relay per LAN. BEACON REQUEST: some access points do not deliver broadcasts to a power-saving Wi-Fi client, so a beamer that has heard nothing may broadcast this same struct with tcp_port = 0 and event_id = 0 to TELEMETRY_PORT; the relay answers any such 12-byte datagram with magic 'M','T' (whatever its version) with a unicast relay_beacon to the sender's address at BEACON_PORT. */
export interface RelayBeacon {
  magic: Uint8Array; // 'M','T'
  version: number; // PROTO_VERSION of the relay; informational, never checked by a beamer
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

/** FROZEN. Relay shared secret (decisions.md R16). Not part of the game's messages: the beamer writes it on the TCP connection before the kernel's relay_hdr + payload, and in front of each telemetry datagram, with LAZYTO-SECRET from its CONFIG/config.txt (the Dolphin forwarder uses SlippiRelaySecret). The Wii never holds the secret. The relay compares the secret with its config in constant time and answers a missing or wrong one with ST_BAD_SECRET without acting on the request. Responses carry no relay_auth. Plaintext on the LAN: it keeps passers-by on a shared Wi-Fi out, not someone capturing the Wi-Fi traffic. */
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

/** Station telemetry. Not part of the game's messages: the Nintendont kernel writes this header and len payload bytes (TM_LOG text, one station_status or one crash_report) to the beamer's telemetry sectors; the beamer sends relay_auth + those bytes as one UDP datagram to the relay's address from the beacon, port TELEMETRY_PORT. The relay drops datagrams with a wrong secret (counted on the status page), keeps the last log lines and status per station, and never answers. seq counts datagrams from 0 at kernel boot, so a gap is a lost datagram and a smaller seq is a reboot. */
export interface TelemetryHdr {
  magic: Uint8Array; // MAGIC_0, TELEMETRY_MAGIC_1 ('M','L')
  version: number; // PROTO_VERSION
  kind: number; // enum telemetry_kind
  station: number; // stamped by the kernel from the beamer's hello (BF_STATION_SET)
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


// ---- crash_report (84 bytes) ----

/** What the game's module records in its OS error handler (lbcrash.c, installed with OSSetErrorHandler ahead of Melee's own crash screen, which still appears): the exception, the faulting address and the instruction words the PPC READS there through its data cache, the registers that matter and a short walk of the stack's LR saves. The Nintendont kernel forwards it as TM_CRASH; the relay shows it and the addresses are resolved offline against the module map and the vanilla symbol map (melee tools/resolve_crash.py). */
export interface CrashReport {
  error: number; // OSError number: 2 DSI, 3 ISI, 5 alignment, 6 program (illegal instruction), 7 floating point
  count: number; // crashes recorded since boot (normally 1)
  srr0: number; // faulting address
  srr1: number; // MSR at the fault; for a program exception bit 0x80000 = illegal, 0x40000 = privileged, 0x20000 = trap
  dsisr: number;
  dar: number; // data address for DSI / alignment
  lr: number;
  sp: number; // r1
  r3: number;
  r4: number;
  fetched: number[]; // the four words at srr0 as the PPC reads them (0 when srr0 is not a readable MEM1 address): compared with the module file they tell stale cache from overwritten memory
  stack: number[]; // LR saves from the stack frames above sp, 0-filled
}
export const CRASH_REPORT_SIZE = 84;

export function encodeCrashReport(v: CrashReport): Uint8Array {
  const bytes = new Uint8Array(CRASH_REPORT_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, v.error);
  dv.setUint16(2, v.count, false);
  dv.setUint32(4, v.srr0, false);
  dv.setUint32(8, v.srr1, false);
  dv.setUint32(12, v.dsisr, false);
  dv.setUint32(16, v.dar, false);
  dv.setUint32(20, v.lr, false);
  dv.setUint32(24, v.sp, false);
  dv.setUint32(28, v.r3, false);
  dv.setUint32(32, v.r4, false);
  if (v.fetched.length > 4) {
    throw new RangeError(`crash_report.fetched: ${v.fetched.length} entries, max ` + 4);
  }
  for (let i = 0; i < v.fetched.length; i++) {
    dv.setUint32(36 + i * 4, v.fetched[i]!, false);
  }
  if (v.stack.length > CRASH_STACK_DEPTH) {
    throw new RangeError(`crash_report.stack: ${v.stack.length} entries, max ` + CRASH_STACK_DEPTH);
  }
  for (let i = 0; i < v.stack.length; i++) {
    dv.setUint32(52 + i * 4, v.stack[i]!, false);
  }
  return bytes;
}

export function decodeCrashReport(buf: Uint8Array, off = 0): CrashReport {
  checkLen(buf, off, CRASH_REPORT_SIZE, 'crash_report');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    error: dv.getUint8(off + 0),
    count: dv.getUint16(off + 2, false),
    srr0: dv.getUint32(off + 4, false),
    srr1: dv.getUint32(off + 8, false),
    dsisr: dv.getUint32(off + 12, false),
    dar: dv.getUint32(off + 16, false),
    lr: dv.getUint32(off + 20, false),
    sp: dv.getUint32(off + 24, false),
    r3: dv.getUint32(off + 28, false),
    r4: dv.getUint32(off + 32, false),
    fetched: Array.from({ length: 4 }, (_, i) => dv.getUint32(off + 36 + i * 4, false)),
    stack: Array.from({ length: CRASH_STACK_DEPTH }, (_, i) => dv.getUint32(off + 52 + i * 4, false)),
  };
}


// ---- crash_mailbox (92 bytes) ----

/** Not on the wire: the shared-memory slot at CRASH_MAILBOX_PPC. The module writes report then seq (seq last, so a reader that sees a new seq sees a complete report); the kernel polls seq. */
export interface CrashMailbox {
  magic: number; // CRASH_MAGIC
  seq: number; // 0 = nothing recorded; incremented per crash
  report: CrashReport;
}
export const CRASH_MAILBOX_SIZE = 92;

export function encodeCrashMailbox(v: CrashMailbox): Uint8Array {
  const bytes = new Uint8Array(CRASH_MAILBOX_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, v.magic, false);
  dv.setUint32(4, v.seq, false);
  bytes.set(encodeCrashReport(v.report), 8);
  return bytes;
}

export function decodeCrashMailbox(buf: Uint8Array, off = 0): CrashMailbox {
  checkLen(buf, off, CRASH_MAILBOX_SIZE, 'crash_mailbox');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    magic: dv.getUint32(off + 0, false),
    seq: dv.getUint32(off + 4, false),
    report: decodeCrashReport(buf, off + 8),
  };
}


// ---- record_gate (64 bytes) ----

/** Not on the wire: the shared-memory slot at RECORD_GATE_PPC (kernel: RECORD_GATE_ARM) through which the kiosk chooses which matches Slippi records (docs/redesign.md, Recording only set games). Two 32-byte cache lines, so a PPC-written field and a kernel-written field never share one. Line 0 is written only by the PPC with u32 stores (want: set to RECORD_THIS_MATCH just before vanilla gm_Scene_Vs_OnEnter, whose StartMelee sends Slippi's Game Start, and cleared right after). Line 1 is written only by the kernel, which reads line 0 with sync_before_read in its Game Start EXI handler and keeps {ring cursor, record, seq}. The kernel zeroes both lines at boot. */
export interface RecordGate {
  want: number; // line 0, PPC-written: RECORD_THIS_MATCH while the Game Start being sent belongs to a set game; anything else = do not record (with a kiosk module loaded)
  start_seq: number; // line 1, kernel-written: Game Starts seen since kernel boot, incremented at each one whether recorded or not
  file_seq: number; // the start_seq of the last match a replay file was opened for; 0 = none since boot
  file_id: number; // that file's gameStartTime (Unix seconds, the Wii clock read as UTC): its name is Game_<MAC>_<file_id as YYYYMMDDTHHMMSS>.slp. The kernel writes file_id before file_seq
}
export const RECORD_GATE_SIZE = 64;

export function encodeRecordGate(v: RecordGate): Uint8Array {
  const bytes = new Uint8Array(RECORD_GATE_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, v.want, false);
  dv.setUint32(32, v.start_seq, false);
  dv.setUint32(36, v.file_seq, false);
  dv.setUint32(40, v.file_id, false);
  return bytes;
}

export function decodeRecordGate(buf: Uint8Array, off = 0): RecordGate {
  checkLen(buf, off, RECORD_GATE_SIZE, 'record_gate');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    want: dv.getUint32(off + 0, false),
    start_seq: dv.getUint32(off + 32, false),
    file_seq: dv.getUint32(off + 36, false),
    file_id: dv.getUint32(off + 40, false),
  };
}


// ---- relay_hdr (8 bytes) ----

/** FROZEN layout. Every message (request and response) begins with this header. */
export interface RelayHdr {
  magic: Uint8Array; // 'M','T'
  version: number; // PROTO_VERSION; BEAMER_SYNC_VERSION for CMD_BEAMER_SYNC
  cmd: number; // enum relay_cmd
  station: number; // stamped by the kernel from the beamer's hello (the game sends 0); for CMD_BEAMER_SYNC the beamer's number or 0, which the relay ignores
  len: number; // payload bytes following the header (in a response: relay_resp + payload)
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

/** FROZEN layout. Every response: relay_hdr (same cmd), then this, then an optional command-specific payload (see messages). */
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
  stream: number; // unused: the game sends 0 and the relay ignores it (the stream station is set on the relay)
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


// ---- game_result (16 bytes) ----

/** One completed game. The stock and costume fields feed start.gg's per-game entrant scores the way Replay Reporter for Slippi does: score = (costume + 1) * 100 + stocks remaining, so the set page shows the colour and the stock icons; both stocks 0xFF = no score sent (a game scored by hand, or one the ledge-grab limit or LGL's tiebreak game decided). The ports and replay_id (v2) name the replay: the relay fetches Game_<MAC>_<replay_id as UTC YYYYMMDDTHHMMSS>.slp from the beamer the set was played through, and labels its ports with the entrants' tags. */
export interface GameResult {
  winner_slot: number; // 1 or 2
  p1_char: number; // Melee external character id (CharacterKind, the CSS ckind value: 0 = Captain Falcon .. 25 = Ganondorf) of entrant 1; 0xFF = unknown (a game scored by hand). Anything the relay cannot map is omitted, never rejected.
  p2_char: number;
  stage: number; // Melee internal stage id (StKind, e.g. 0x1F Battlefield, 0x20 Final Destination); 0 = unknown, e.g. a game scored by hand
  p1_stocks: number; // entrant 1's stocks remaining at the end of the game (0 for the player who was KO'd); 0xFF = unknown or not to be sent
  p2_stocks: number;
  p1_costume: number; // entrant 1's costume (colour) index, 0 = the default colour; 0xFF = unknown
  p2_costume: number;
  p1_port: number; // CSS port 0-3 entrant 1 played on (from the L + R claim); NO_PORT = unknown
  p2_port: number; // CSS port 0-3 of entrant 2; NO_PORT = unknown
  replay_id: number; // the game's replay: record_gate.file_id of its match (a tiebreak game reports its main game's); 0 = no replay (no beamer, replays off, a stalled writer, Dolphin, or a hand-scored game whose match was not recorded)
}
export const GAME_RESULT_SIZE = 16;

export function encodeGameResult(v: GameResult): Uint8Array {
  const bytes = new Uint8Array(GAME_RESULT_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, v.winner_slot);
  dv.setUint8(1, v.p1_char);
  dv.setUint8(2, v.p2_char);
  dv.setUint8(3, v.stage);
  dv.setUint8(4, v.p1_stocks);
  dv.setUint8(5, v.p2_stocks);
  dv.setUint8(6, v.p1_costume);
  dv.setUint8(7, v.p2_costume);
  dv.setUint8(8, v.p1_port);
  dv.setUint8(9, v.p2_port);
  dv.setUint32(12, v.replay_id, false);
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
    p1_stocks: dv.getUint8(off + 4),
    p2_stocks: dv.getUint8(off + 5),
    p1_costume: dv.getUint8(off + 6),
    p2_costume: dv.getUint8(off + 7),
    p1_port: dv.getUint8(off + 8),
    p2_port: dv.getUint8(off + 9),
    replay_id: dv.getUint32(off + 12, false),
  };
}


// ---- start_set_resp (88 bytes) ----

/** CMD_START_SET response payload (ST_OK only): the games the relay holds for the set, laid out like end_set_req. game_count is 0 for a set just started. On a resume (the station's own set, asked for again after the Wii rebooted) it is the claim's games as last reported, each with its ports and replay_id, so the kiosk carries on from them instead of 0-0 and its next report does not overwrite the earlier games on start.gg (docs/redesign.md, N3). */
export interface StartSetResp {
  set_id: number;
  game_count: number; // 0-5 valid entries in games
  games: GameResult[];
}
export const START_SET_RESP_SIZE = 88;

export function encodeStartSetResp(v: StartSetResp): Uint8Array {
  const bytes = new Uint8Array(START_SET_RESP_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, v.set_id, false);
  dv.setUint8(4, v.game_count);
  if (v.games.length > MAX_GAMES) {
    throw new RangeError(`start_set_resp.games: ${v.games.length} entries, max ` + MAX_GAMES);
  }
  for (let i = 0; i < v.games.length; i++) {
    bytes.set(encodeGameResult(v.games[i]), 8 + i * GAME_RESULT_SIZE);
  }
  return bytes;
}

export function decodeStartSetResp(buf: Uint8Array, off = 0): StartSetResp {
  checkLen(buf, off, START_SET_RESP_SIZE, 'start_set_resp');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    set_id: dv.getUint32(off + 0, false),
    game_count: dv.getUint8(off + 4),
    games: Array.from({ length: MAX_GAMES }, (_, i) => decodeGameResult(buf, off + 8 + i * GAME_RESULT_SIZE)),
  };
}


// ---- report_score_req (88 bytes) ----

/** CMD_REPORT_SCORE request payload. Always the full game list; the relay does a full overwrite (idempotent). */
export interface ReportScoreReq {
  set_id: number;
  game_count: number; // 0-5 valid entries in games
  games: GameResult[];
}
export const REPORT_SCORE_REQ_SIZE = 88;

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


// ---- end_set_req (88 bytes) ----

/** CMD_END_SET request payload. Relay derives the winner from the game list. */
export interface EndSetReq {
  set_id: number;
  game_count: number;
  games: GameResult[];
}
export const END_SET_REQ_SIZE = 88;

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


// ---- beamer_hello (32 bytes) ----

/** Beamer mailbox sector BEAMER_MB_HELLO, written by the beamer (a Slippi Beamer running the LazyTO firmware with LAZYTO = true), read by the Nintendont kernel about once a second. The mailbox is BEAMER_MB_SECTORS sectors right after the beamer's replay partition, served from the beamer's RAM: no filesystem covers them on either side. The kernel writes nothing to the mailbox until this sector carries the magic and BEAMER_MB_VERSION. Offsets 0-17 and fw_build at 20 are where mailbox v1 had them, so a kernel can tell old firmware from no beamer. Not on the TCP wire. */
export interface BeamerHello {
  magic: string; // LAZYTOMB
  version: number; // BEAMER_MB_VERSION
  flags: number; // beamer_flags bits
  station: number; // the station number on the beamer's screen; valid only with BF_STATION_SET (unset is a flag, never 0: Dolphin is station 0)
  relay_ip: number; // relay IPv4 address from the beacon, big-endian u32; 0 = unknown
  relay_port: number; // relay TCP port; 0 = unknown
  wifi: number; // enum beamer_wifi
  storage: number; // enum beamer_storage
  fw_build: number; // the beamer firmware's LazyTO build number (at least BEAMER_FW_MIN)
  last_result: number; // enum beamer_result of the last mailbox round trip; 0 = BR_OK or none yet
  beacon_age_s: number; // seconds since the relay's beacon was last heard, saturating at 0xFFFF; valid with BF_RELAY
}
export const BEAMER_HELLO_SIZE = 32;

export function encodeBeamerHello(v: BeamerHello): Uint8Array {
  const bytes = new Uint8Array(BEAMER_HELLO_SIZE);
  const dv = new DataView(bytes.buffer);
  putAscii(bytes, 0, 8, v.magic);
  dv.setUint8(8, v.version);
  dv.setUint8(9, v.flags);
  dv.setUint16(10, v.station, false);
  dv.setUint32(12, v.relay_ip, false);
  dv.setUint16(16, v.relay_port, false);
  dv.setUint8(18, v.wifi);
  dv.setUint8(19, v.storage);
  dv.setUint32(20, v.fw_build, false);
  dv.setUint8(24, v.last_result);
  dv.setUint16(26, v.beacon_age_s, false);
  return bytes;
}

export function decodeBeamerHello(buf: Uint8Array, off = 0): BeamerHello {
  checkLen(buf, off, BEAMER_HELLO_SIZE, 'beamer_hello');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    magic: getAscii(buf, off + 0, 8),
    version: dv.getUint8(off + 8),
    flags: dv.getUint8(off + 9),
    station: dv.getUint16(off + 10, false),
    relay_ip: dv.getUint32(off + 12, false),
    relay_port: dv.getUint16(off + 16, false),
    wifi: dv.getUint8(off + 18),
    storage: dv.getUint8(off + 19),
    fw_build: dv.getUint32(off + 20, false),
    last_result: dv.getUint8(off + 24),
    beacon_age_s: dv.getUint16(off + 26, false),
  };
}


// ---- beamer_req_hdr (12 bytes) ----

/** Start of mailbox sector BEAMER_MB_REQ (Wii to beamer): then len bytes, relay_hdr + payload exactly as the relay is to get them after relay_auth. The beamer refuses the request locally with BR_NO_STATION or BR_NO_SECRET when it has no number or no secret; otherwise it sends relay_auth (its LAZYTO-SECRET) + those bytes to the relay once per seq (a repeated write of the same seq, for example a USB retry, is not sent again) and answers in the response sectors. */
export interface BeamerReqHdr {
  magic: Uint8Array; // 'M','Q'
  seq: number; // nonzero; counts up by one per request. The beamer stays powered across Wii reboots and keeps its last response, so whenever the kernel finds the beamer (first valid beamer_hello after boot or a USB change) it starts one past the seq in the response sector (or at 1 if that is 0)
  len: number; // bytes after this header (relay_hdr + payload), at most BEAMER_SECTOR_SIZE - 12
}
export const BEAMER_REQ_HDR_SIZE = 12;

export function encodeBeamerReqHdr(v: BeamerReqHdr): Uint8Array {
  const bytes = new Uint8Array(BEAMER_REQ_HDR_SIZE);
  const dv = new DataView(bytes.buffer);
  bytes.set(v.magic.subarray(0, 2), 0);
  dv.setUint32(4, v.seq, false);
  dv.setUint16(8, v.len, false);
  return bytes;
}

export function decodeBeamerReqHdr(buf: Uint8Array, off = 0): BeamerReqHdr {
  checkLen(buf, off, BEAMER_REQ_HDR_SIZE, 'beamer_req_hdr');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    magic: buf.slice(off + 0, off + 0 + 2),
    seq: dv.getUint32(off + 4, false),
    len: dv.getUint16(off + 8, false),
  };
}


// ---- beamer_resp_hdr (12 bytes) ----

/** Start of mailbox sector BEAMER_MB_RESP (beamer to Wii): then len bytes of the relay's reply (relay_hdr + relay_resp + payload) when result is BR_OK. Valid for the request whose seq it carries; the kernel polls until seq matches its request. */
export interface BeamerRespHdr {
  magic: Uint8Array; // 'M','R'
  result: number; // enum beamer_result
  seq: number; // the request's seq; 0 = no response yet
  len: number;
}
export const BEAMER_RESP_HDR_SIZE = 12;

export function encodeBeamerRespHdr(v: BeamerRespHdr): Uint8Array {
  const bytes = new Uint8Array(BEAMER_RESP_HDR_SIZE);
  const dv = new DataView(bytes.buffer);
  bytes.set(v.magic.subarray(0, 2), 0);
  dv.setUint8(2, v.result);
  dv.setUint32(4, v.seq, false);
  dv.setUint16(8, v.len, false);
  return bytes;
}

export function decodeBeamerRespHdr(buf: Uint8Array, off = 0): BeamerRespHdr {
  checkLen(buf, off, BEAMER_RESP_HDR_SIZE, 'beamer_resp_hdr');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    magic: buf.slice(off + 0, off + 0 + 2),
    result: dv.getUint8(off + 2),
    seq: dv.getUint32(off + 4, false),
    len: dv.getUint16(off + 8, false),
  };
}


// ---- beamer_tele_hdr (12 bytes) ----

/** Start of mailbox sector BEAMER_MB_TELE (Wii to beamer): then len bytes of one telemetry datagram (telemetry_hdr + payload), which the beamer sends as relay_auth + those bytes to the relay's TELEMETRY_PORT once per seq. Unanswered. Dropped by a beamer without a number or a secret. */
export interface BeamerTeleHdr {
  magic: Uint8Array; // 'M','E'
  seq: number;
  len: number; // bytes after this header, at most BEAMER_MB_TELE_SECTORS * BEAMER_SECTOR_SIZE - 12
}
export const BEAMER_TELE_HDR_SIZE = 12;

export function encodeBeamerTeleHdr(v: BeamerTeleHdr): Uint8Array {
  const bytes = new Uint8Array(BEAMER_TELE_HDR_SIZE);
  const dv = new DataView(bytes.buffer);
  bytes.set(v.magic.subarray(0, 2), 0);
  dv.setUint32(4, v.seq, false);
  dv.setUint16(8, v.len, false);
  return bytes;
}

export function decodeBeamerTeleHdr(buf: Uint8Array, off = 0): BeamerTeleHdr {
  checkLen(buf, off, BEAMER_TELE_HDR_SIZE, 'beamer_tele_hdr');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    magic: buf.slice(off + 0, off + 0 + 2),
    seq: dv.getUint32(off + 4, false),
    len: dv.getUint16(off + 8, false),
  };
}


// ---- sync_file (84 bytes) ----

/** FROZEN. One file in a beamer_sync_req: a Game_*.slp on the beamer's card that has no ack. Listed in this order, oldest modified time first within each group, until SYNC_MAX_FILES: files served this boot (hashed), then SK_FINISHED, SK_INCOMPLETE, SK_LIVE. */
export interface SyncFile {
  name: string; // file name in the replay folder, without the folder (Game_0017AB12CD34_20261007T201502.slp)
  bytes: number; // file size in bytes, from the directory entry
  mtime: number; // FAT modified date << 16 | FAT modified time, from the directory entry
  kind: number; // enum sync_kind
  hashed: number; // 1 = sha256 is valid: the beamer served the whole file this boot and hashed its raw bytes (before gzip) while serving; 0 = sha256 is zero
  sha256: Uint8Array;
}
export const SYNC_FILE_SIZE = 84;

export function encodeSyncFile(v: SyncFile): Uint8Array {
  const bytes = new Uint8Array(SYNC_FILE_SIZE);
  const dv = new DataView(bytes.buffer);
  putAscii(bytes, 0, SYNC_NAME_LEN, v.name);
  dv.setUint32(40, v.bytes, false);
  dv.setUint32(44, v.mtime, false);
  dv.setUint8(48, v.kind);
  dv.setUint8(49, v.hashed);
  bytes.set(v.sha256.subarray(0, SHA256_LEN), 52);
  return bytes;
}

export function decodeSyncFile(buf: Uint8Array, off = 0): SyncFile {
  checkLen(buf, off, SYNC_FILE_SIZE, 'sync_file');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    name: getAscii(buf, off + 0, SYNC_NAME_LEN),
    bytes: dv.getUint32(off + 40, false),
    mtime: dv.getUint32(off + 44, false),
    kind: dv.getUint8(off + 48),
    hashed: dv.getUint8(off + 49),
    sha256: buf.slice(off + 52, off + 52 + SHA256_LEN),
  };
}


// ---- beamer_sync_req (100 bytes + variable tail) ----

/** FROZEN. CMD_BEAMER_SYNC request payload, sent by a beamer on its relay link (relay_auth + relay_hdr with version BEAMER_SYNC_VERSION + this) when no mailbox request is pending: after each served file, when it finds a new file, and every 30 s. The relay learns the beamer's address from the connection and answers beamer_sync_resp. */
export interface BeamerSyncReq {
  station_id: Uint8Array; // the beamer's StationId (from its MAC)
  archive_id: Uint8Array; // the archive its ack table belongs to (the last verified beamer_sync_resp.archive_id); all zero = none yet
  nonce: Uint8Array; // fresh random bytes for this sync; the reply's hmac covers them
  fw_build: number; // as in beamer_hello
  uptime_s: number; // seconds since this boot ("not unplugged since")
  free_mb: number; // free space on the card in MiB, counted from the FAT (not FSInfo)
  card_mb: number; // size of the replay partition in MiB
  used_mb: number; // MiB held by Game_*.slp files; card_mb - free_mb - used_mb estimates clusters leaked by interrupted recordings
  station: number; // the station number; valid with SF_STATION_SET
  http_port: number; // the beamer's HTTP port, where the relay downloads files
  on_card: number; // Game_*.slp files on the card, all kinds, saturating at 0xFFFF
  to_collect: number; // files without an ack
  to_erase: number; // files with an ack: erased at the next cold boot
  empty: number; // 0-byte Game_*.slp entries (erased at the next cold boot without an ack)
  incomplete: number; // files of kind SK_INCOMPLETE
  acks: number; // ack records stored (at most 1024)
  erased: number; // erase report of this boot (0 unless SF_COLD_BOOT): acked files deleted
  erased_empty: number; // 0-byte entries deleted
  erase_ms: number; // milliseconds the erase took (budget 4000)
  erase_left: number; // acked files the budget left for the next cold boot
  flags: number; // beamer_sync_flags bits
  storage: number; // enum beamer_storage
  last_result: number; // enum beamer_result of the last mailbox round trip
  rssi: number; // Wi-Fi signal as -dBm (67 = -67 dBm); 0 = unknown
  files: SyncFile[];
}
export const BEAMER_SYNC_REQ_SIZE = 100; // fixed part; files[] follows

export function encodeBeamerSyncReq(v: BeamerSyncReq): Uint8Array {
  if (v.files.length > SYNC_MAX_FILES) {
    throw new RangeError(`beamer_sync_req.files: ${v.files.length} entries, max ` + SYNC_MAX_FILES);
  }
  const bytes = new Uint8Array(BEAMER_SYNC_REQ_SIZE + v.files.length * SYNC_FILE_SIZE);
  const dv = new DataView(bytes.buffer);
  bytes.set(v.station_id.subarray(0, SYNC_ID_LEN), 0);
  bytes.set(v.archive_id.subarray(0, SYNC_ID_LEN), 16);
  bytes.set(v.nonce.subarray(0, SYNC_ID_LEN), 32);
  dv.setUint32(48, v.fw_build, false);
  dv.setUint32(52, v.uptime_s, false);
  dv.setUint32(56, v.free_mb, false);
  dv.setUint32(60, v.card_mb, false);
  dv.setUint32(64, v.used_mb, false);
  dv.setUint16(68, v.station, false);
  dv.setUint16(70, v.http_port, false);
  dv.setUint16(72, v.on_card, false);
  dv.setUint16(74, v.to_collect, false);
  dv.setUint16(76, v.to_erase, false);
  dv.setUint16(78, v.empty, false);
  dv.setUint16(80, v.incomplete, false);
  dv.setUint16(82, v.acks, false);
  dv.setUint16(84, v.erased, false);
  dv.setUint16(86, v.erased_empty, false);
  dv.setUint16(88, v.erase_ms, false);
  dv.setUint16(90, v.erase_left, false);
  dv.setUint8(92, v.flags);
  dv.setUint8(93, v.storage);
  dv.setUint8(94, v.last_result);
  dv.setUint8(95, v.rssi);
  dv.setUint8(96, v.files.length);
  for (let i = 0; i < v.files.length; i++) {
    bytes.set(encodeSyncFile(v.files[i]), 100 + i * SYNC_FILE_SIZE);
  }
  return bytes;
}

export function decodeBeamerSyncReq(buf: Uint8Array, off = 0): BeamerSyncReq {
  checkLen(buf, off, BEAMER_SYNC_REQ_SIZE, 'beamer_sync_req');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const count = dv.getUint8(off + 96);
  if (count > SYNC_MAX_FILES) {
    throw new RangeError(`beamer_sync_req.file_count: ${count} entries, max ` + SYNC_MAX_FILES);
  }
  checkLen(buf, off, BEAMER_SYNC_REQ_SIZE + count * SYNC_FILE_SIZE, 'beamer_sync_req');
  return {
    station_id: buf.slice(off + 0, off + 0 + SYNC_ID_LEN),
    archive_id: buf.slice(off + 16, off + 16 + SYNC_ID_LEN),
    nonce: buf.slice(off + 32, off + 32 + SYNC_ID_LEN),
    fw_build: dv.getUint32(off + 48, false),
    uptime_s: dv.getUint32(off + 52, false),
    free_mb: dv.getUint32(off + 56, false),
    card_mb: dv.getUint32(off + 60, false),
    used_mb: dv.getUint32(off + 64, false),
    station: dv.getUint16(off + 68, false),
    http_port: dv.getUint16(off + 70, false),
    on_card: dv.getUint16(off + 72, false),
    to_collect: dv.getUint16(off + 74, false),
    to_erase: dv.getUint16(off + 76, false),
    empty: dv.getUint16(off + 78, false),
    incomplete: dv.getUint16(off + 80, false),
    acks: dv.getUint16(off + 82, false),
    erased: dv.getUint16(off + 84, false),
    erased_empty: dv.getUint16(off + 86, false),
    erase_ms: dv.getUint16(off + 88, false),
    erase_left: dv.getUint16(off + 90, false),
    flags: dv.getUint8(off + 92),
    storage: dv.getUint8(off + 93),
    last_result: dv.getUint8(off + 94),
    rssi: dv.getUint8(off + 95),
    files: Array.from({ length: count }, (_, i) => decodeSyncFile(buf, off + 100 + i * SYNC_FILE_SIZE)),
  };
}


// ---- sync_answer (36 bytes) ----

/** FROZEN. The relay's answer about files[i] of the request, at answers[i]. */
export interface SyncAnswer {
  answer: number; // enum sync_answer_kind
  sha256: Uint8Array; // with SA_HELD: the SHA-256 of the laptop's stored copy; zero otherwise
}
export const SYNC_ANSWER_SIZE = 36;

export function encodeSyncAnswer(v: SyncAnswer): Uint8Array {
  const bytes = new Uint8Array(SYNC_ANSWER_SIZE);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, v.answer);
  bytes.set(v.sha256.subarray(0, SHA256_LEN), 4);
  return bytes;
}

export function decodeSyncAnswer(buf: Uint8Array, off = 0): SyncAnswer {
  checkLen(buf, off, SYNC_ANSWER_SIZE, 'sync_answer');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  return {
    answer: dv.getUint8(off + 0),
    sha256: buf.slice(off + 4, off + 4 + SHA256_LEN),
  };
}


// ---- beamer_sync_resp (52 bytes + variable tail) ----

/** FROZEN. CMD_BEAMER_SYNC response payload after relay_resp (ST_OK only). hmac = HMAC-SHA256 keyed with the secret's SECRET_LEN bytes exactly as relay_auth carries them (NUL-padded), over the request's nonce (16 bytes), then the request's station_id (16 bytes), then this payload from archive_id to its end (20 + 36 * answer_count bytes). A beamer drops a reply whose hmac does not verify, whose answer_count differs from its file_count, or whose archive_id is all zero. A verified reply with another archive_id than the ack table's drops every ack and adopts the new id before its answers are applied. */
export interface BeamerSyncResp {
  hmac: Uint8Array;
  archive_id: Uint8Array; // the laptop's archive (archive.json in its archive folder); never all zero
  answers: SyncAnswer[];
}
export const BEAMER_SYNC_RESP_SIZE = 52; // fixed part; answers[] follows

export function encodeBeamerSyncResp(v: BeamerSyncResp): Uint8Array {
  if (v.answers.length > SYNC_MAX_FILES) {
    throw new RangeError(`beamer_sync_resp.answers: ${v.answers.length} entries, max ` + SYNC_MAX_FILES);
  }
  const bytes = new Uint8Array(BEAMER_SYNC_RESP_SIZE + v.answers.length * SYNC_ANSWER_SIZE);
  const dv = new DataView(bytes.buffer);
  bytes.set(v.hmac.subarray(0, SHA256_LEN), 0);
  bytes.set(v.archive_id.subarray(0, SYNC_ID_LEN), 32);
  dv.setUint8(48, v.answers.length);
  for (let i = 0; i < v.answers.length; i++) {
    bytes.set(encodeSyncAnswer(v.answers[i]), 52 + i * SYNC_ANSWER_SIZE);
  }
  return bytes;
}

export function decodeBeamerSyncResp(buf: Uint8Array, off = 0): BeamerSyncResp {
  checkLen(buf, off, BEAMER_SYNC_RESP_SIZE, 'beamer_sync_resp');
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const count = dv.getUint8(off + 48);
  if (count > SYNC_MAX_FILES) {
    throw new RangeError(`beamer_sync_resp.answer_count: ${count} entries, max ` + SYNC_MAX_FILES);
  }
  checkLen(buf, off, BEAMER_SYNC_RESP_SIZE + count * SYNC_ANSWER_SIZE, 'beamer_sync_resp');
  return {
    hmac: buf.slice(off + 0, off + 0 + SHA256_LEN),
    archive_id: buf.slice(off + 32, off + 32 + SYNC_ID_LEN),
    answers: Array.from({ length: count }, (_, i) => decodeSyncAnswer(buf, off + 52 + i * SYNC_ANSWER_SIZE)),
  };
}

