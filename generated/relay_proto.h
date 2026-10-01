/* relay_proto.h -- GENERATED from protocol.yaml by tools/gen_protocol.py -- DO NOT EDIT.
 *
 * Wire protocol between the Wii (Melee decomp / Nintendont kernel) and the
 * relay on the Pi. See design.md section 5.
 *
 * All integers big-endian on the wire; PowerPC is big-endian, so these
 * structs are sent and received as-is with zero byte-swapping.
 * All strings ASCII, NUL-padded, not NUL-terminated if full.
 */
#ifndef RELAY_PROTO_H
#define RELAY_PROTO_H

#include <stddef.h>

/* The melee decomp's MWCC/MSL toolchain ships no <stdint.h>. Its EABI
 * types match these widths exactly; no other TU in that tree defines
 * the uintN_t names. Every other consumer (Nintendont's ARM GCC) has
 * the real header. */
#ifdef __MWERKS__
typedef unsigned char uint8_t;
typedef unsigned short uint16_t;
typedef unsigned long uint32_t;
#else
#include <stdint.h>
#endif

/* Layout guards. C11 gives us _Static_assert; the pre-C11 fallback (the
 * decomp's MWCC toolchain) diagnoses via a negative array size instead. */
#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
#define RELAY_STATIC_ASSERT(cond, tag) _Static_assert((cond), #tag)
#else
#define RELAY_STATIC_ASSERT(cond, tag) \
    typedef char relay_static_assert_##tag[(cond) ? 1 : -1]
#endif

#define RELAY_PROTO_VERSION 1
#define RELAY_MAGIC_0 'M'
#define RELAY_MAGIC_1 'T'

#define MAX_GAMES           5  /* games per set (best of 5) */
#define MAX_SETS            56  /* cap on set_entry rows in a LIST_SETS response; 56 is the most that fits the game's 4 KB poll buffer (4096 - 12 exi_poll_hdr - 8 hdr - 32 resp - 4 fixed = 4040 bytes = 56 rows of 72) */
#define MSG_LEN             30  /* human-readable status text in relay_resp */
#define ROUND_LEN           24  /* round name as the players see it, upper case: "WINNERS QUARTER-FINAL", "LOSERS ROUND 1", "GRAND FINAL RESET" (start.gg fullRoundText, cut to fit) */
#define TAG_LEN             16  /* player tag */
#define BEACON_PORT         7778  /* UDP port the relay broadcasts relay_beacon to and every station listens on (design R15: stations find the relay; tournament.cfg has no relay address) */
#define BEACON_INTERVAL_MS  2000  /* the relay sends one relay_beacon per interval on every IPv4 interface */
#define SECRET_LEN          16  /* relay shared secret, printable ASCII, NUL-padded (design R16) */
#define AUTH_MAGIC_0        77  /* 'M', first byte of relay_auth */
#define AUTH_MAGIC_1        75  /* 'K', second byte of relay_auth; differs from relay_hdr's 'T' so a host that sends no relay_auth is told so */
#define TELEMETRY_PORT      7779  /* UDP port on the relay that stations send telemetry datagrams to (kernel log lines and the module's load status), at the address the beacon came from */
#define TELEMETRY_MAGIC_1   76  /* 'L', second byte of telemetry_hdr ('M','L') */
#define TELEMETRY_TEXT_MAX  480  /* most log text bytes in one TM_LOG datagram; keeps relay_auth + telemetry_hdr + text well under one Ethernet frame */
#define TELEMETRY_STATUS_MS 5000  /* a station sends a TM_STATUS datagram at least this often once it knows the relay */
#define CRASH_MAILBOX_PPC   0xD3003480  /* PPC uncached MEM2 address of the crash_mailbox the game's module writes from its OS error handler; the Nintendont kernel reads it at 0x13003480 (same bytes) and sends a TM_CRASH when seq changes. Between HID_STATUS (0x13003440..0x1300344C) and slippi_settings (0x13003500). Not used by Dolphin. */
#define CRASH_MAGIC         1297367890  /* 'MTCR', first word of crash_mailbox */
#define CRASH_STACK_DEPTH   8  /* LR saves walked up the crashed stack in crash_report */

/* request/response command, echoed back in the response header */
enum relay_cmd {
    CMD_LIST_SETS    = 1,
    CMD_START_SET    = 2,
    CMD_REPORT_SCORE = 3,
    CMD_END_SET      = 4,
    CMD_ABANDON_SET  = 5,  /* player-initiated "wrong set"; relay resets it */
};

/* result of a request, first byte of relay_resp */
enum relay_status {
    ST_OK            = 0,
    ST_BAD_VERSION   = 1,
    ST_SET_NOT_FOUND = 2,
    ST_SET_TAKEN     = 3,  /* started on another station */
    ST_NOT_STREAM    = 4,  /* stream flag from non-stream station */
    ST_STARTGG_ERROR = 5,  /* upstream rejected; see status page */
    ST_RATE_LIMITED  = 6,
    ST_INTERNAL      = 7,
    ST_BAD_SECRET    = 8,  /* relay_auth missing or its secret wrong; check secret= on the SD card (design R16) */
};

/* Command byte on the fake relay EXI device. Shared by the game side (lbrelayexi.c), Slippi Dolphin's forwarder, and Nintendont's RelayEXI; not part of the TCP wire format. Values chosen clear of Slippi's EXI command space, which extends to 0xE5 (CMD_GET_RANK_VISIBILITY in EXI_DeviceSlippi.h). */
enum exi_cmd {
    EXI_RELAY_REQ  = 240,  /* write request buffer to the ARM side */
    EXI_RELAY_POLL = 241,  /* read {state, response buffer} */
};

/* bit flags in exi_poll_hdr.flags; set by the host when it already knows a request cannot go out (Nintendont kernel: NetworkStarted, tournament.cfg) */
enum exi_poll_flags {
    PF_NO_NETWORK = 1,  /* the host has no network: the loader's Network option is off, or the Wii failed to join the Wi-Fi at boot */
    PF_NO_CFG     = 2,  /* no usable sd:/tournament.cfg */
    PF_NO_SECRET  = 4,  /* tournament.cfg has no valid secret= */
};

/* bit flags in exi_poll_hdr.host_opts: what the host's settings ask the kiosk to do with Melee's audio (the kiosk forces mono and music off unless told otherwise) */
enum exi_host_opts {
    HO_MUSIC_ON = 1,  /* leave Melee's music on (sound balance untouched) */
    HO_STEREO   = 2,  /* leave Melee in stereo (no OSSetSoundMode(mono)) */
};

/* state byte of exi_poll_hdr, the first thing an EXI_RELAY_POLL read returns */
enum exi_poll_state {
    RELAY_IDLE  = 0,
    RELAY_BUSY  = 1,  /* request in flight on the ARM side */
    RELAY_DONE  = 2,  /* response buffer valid */
    RELAY_ERROR = 3,  /* transport failed; response buffer is zeroed */
};

/* what follows a telemetry_hdr */
enum telemetry_kind {
    TM_LOG    = 1,  /* len bytes of kernel log text, ASCII, lines ending in \n (a line may be split across datagrams) */
    TM_STATUS = 2,  /* one station_status */
    TM_CRASH  = 3,  /* one crash_report: the game took an unhandled exception */
};

/* what the host did with sd:/tournament.bin at game boot (Nintendont kernel LoadTournamentModule) */
enum module_state {
    MOD_PENDING     = 0,  /* no game booted yet */
    MOD_LOADED      = 1,
    MOD_NOT_FOUND   = 2,  /* no sd:/tournament.bin */
    MOD_BAD_FILE    = 3,  /* not a TMOD file */
    MOD_BAD_HEADER  = 4,  /* unsupported version, size or load address */
    MOD_GUARD       = 5,  /* guard word mismatch: the disc is not stock Melee 1.02 */
    MOD_ARENA       = 6,  /* the module would overlap game memory (arena top below the module) */
    MOD_READ_FAILED = 7,
    MOD_NOT_MELEE   = 8,  /* the booted game is not Melee NTSC 1.02 */
};

/* What an EXI_RELAY_POLL read starts with (the game's lbRelayExi_PollBuf:
 * this, then relay_hdr, relay_resp and the payload). Not on the TCP wire:
 * filled by the host of the fake EXI device (Nintendont kernel, Slippi
 * Dolphin) on every poll, so the game can show which station it is and which
 * relay it is talking to even while the relay never answers. The response
 * bytes after it are valid only when state == RELAY_DONE.
 */
struct exi_poll_hdr {
    uint8_t  state;  /* enum exi_poll_state */
    uint8_t  flags;  /* exi_poll_flags bits: why the relay cannot be reached yet, so the kiosk can say so instead of waiting for a beacon; 0 = nothing wrong (the Dolphin forwarder leaves it 0) */
    uint16_t station;  /* tournament.cfg station; 0 in Dolphin (design R10) */
    uint32_t relay_ip;  /* relay IPv4 address as a big-endian u32 (10.0.0.2 = 0x0A000002); 0 = unknown */
    uint16_t relay_port;  /* relay TCP port; 0 = unknown */
    uint8_t  host_opts;  /* exi_host_opts bits: venue audio choices from the host's settings (Nintendont loader menu); 0 = the kiosk defaults, mono and music off (Dolphin) */
    uint8_t  host_build;  /* the host's build number for the set list's version text (Nintendont NIN_HOST_BUILD, bumped by hand per loader release); 0 = unknown (Dolphin) */
};  /* 12 bytes */

RELAY_STATIC_ASSERT(sizeof(struct exi_poll_hdr) == 12, exi_poll_hdr_size);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, state) == 0, exi_poll_hdr_state);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, flags) == 1, exi_poll_hdr_flags);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, station) == 2, exi_poll_hdr_station);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, relay_ip) == 4, exi_poll_hdr_relay_ip);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, relay_port) == 8, exi_poll_hdr_relay_port);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, host_opts) == 10, exi_poll_hdr_host_opts);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, host_build) == 11, exi_poll_hdr_host_build);

/* Relay discovery (design R15). Not on the TCP wire: one UDP datagram,
 * broadcast by the relay every BEACON_INTERVAL_MS to each IPv4 interface's
 * directed broadcast address, port BEACON_PORT. A station (Nintendont kernel,
 * Slippi Dolphin forwarder) listens on BEACON_PORT, ignores datagrams whose
 * size, magic or version do not match, and takes the datagram's SOURCE address
 * plus tcp_port as the relay; the latest valid beacon wins, so a relay that
 * changes address is followed. One relay per LAN.
 */
struct relay_beacon {
    uint8_t  magic[2];  /* 'M','T' */
    uint8_t  version;  /* PROTO_VERSION */
    uint8_t  _pad;
    uint16_t tcp_port;  /* the relay's TCP port for relay_hdr requests */
    uint16_t _pad2;
    uint32_t event_id;  /* start.gg event the relay serves; for logs and display only */
};  /* 12 bytes */

RELAY_STATIC_ASSERT(sizeof(struct relay_beacon) == 12, relay_beacon_size);
RELAY_STATIC_ASSERT(offsetof(struct relay_beacon, magic) == 0, relay_beacon_magic);
RELAY_STATIC_ASSERT(offsetof(struct relay_beacon, version) == 2, relay_beacon_version);
RELAY_STATIC_ASSERT(offsetof(struct relay_beacon, _pad) == 3, relay_beacon__pad);
RELAY_STATIC_ASSERT(offsetof(struct relay_beacon, tcp_port) == 4, relay_beacon_tcp_port);
RELAY_STATIC_ASSERT(offsetof(struct relay_beacon, _pad2) == 6, relay_beacon__pad2);
RELAY_STATIC_ASSERT(offsetof(struct relay_beacon, event_id) == 8, relay_beacon_event_id);

/* Relay shared secret (design R16). Not part of the game's messages: the host
 * of the fake EXI device (Nintendont kernel, Slippi Dolphin forwarder) writes
 * it on the TCP connection before the game's relay_hdr + payload, with the
 * secret from its own config (tournament.cfg secret=, Dolphin
 * SlippiRelaySecret). The relay compares the secret with its config in
 * constant time and answers a missing or wrong one with ST_BAD_SECRET without
 * acting on the request. Responses carry no relay_auth. Plaintext on the LAN:
 * it keeps passers-by on a shared Wi-Fi out, not someone capturing the Wi-Fi
 * traffic.
 */
struct relay_auth {
    uint8_t  magic[2];  /* AUTH_MAGIC_0, AUTH_MAGIC_1 ('M','K') */
    uint16_t _pad;
    char     secret[SECRET_LEN];  /* the shared secret, NUL-padded */
};  /* 20 bytes */

RELAY_STATIC_ASSERT(sizeof(struct relay_auth) == 20, relay_auth_size);
RELAY_STATIC_ASSERT(offsetof(struct relay_auth, magic) == 0, relay_auth_magic);
RELAY_STATIC_ASSERT(offsetof(struct relay_auth, _pad) == 2, relay_auth__pad);
RELAY_STATIC_ASSERT(offsetof(struct relay_auth, secret) == 4, relay_auth_secret);

/* Station telemetry. Not part of the game's messages: the host of the fake EXI
 * device (Nintendont kernel) sends one UDP datagram per message to the relay's
 * address from the beacon, port TELEMETRY_PORT: relay_auth (the same shared
 * secret as TCP requests), this header, then len payload bytes (TM_LOG text or
 * one station_status). The relay drops datagrams with a wrong secret (counted
 * on the status page), keeps the last log lines and status per station, and
 * never answers. seq counts datagrams from 0 at kernel boot, so a gap is a
 * lost datagram and a smaller seq is a reboot.
 */
struct telemetry_hdr {
    uint8_t  magic[2];  /* MAGIC_0, TELEMETRY_MAGIC_1 ('M','L') */
    uint8_t  version;  /* PROTO_VERSION */
    uint8_t  kind;  /* enum telemetry_kind */
    uint16_t station;  /* tournament.cfg station */
    uint16_t len;  /* payload bytes after this header */
    uint32_t seq;
    uint32_t uptime_ms;  /* milliseconds since the kernel started */
};  /* 16 bytes */

RELAY_STATIC_ASSERT(sizeof(struct telemetry_hdr) == 16, telemetry_hdr_size);
RELAY_STATIC_ASSERT(offsetof(struct telemetry_hdr, magic) == 0, telemetry_hdr_magic);
RELAY_STATIC_ASSERT(offsetof(struct telemetry_hdr, version) == 2, telemetry_hdr_version);
RELAY_STATIC_ASSERT(offsetof(struct telemetry_hdr, kind) == 3, telemetry_hdr_kind);
RELAY_STATIC_ASSERT(offsetof(struct telemetry_hdr, station) == 4, telemetry_hdr_station);
RELAY_STATIC_ASSERT(offsetof(struct telemetry_hdr, len) == 6, telemetry_hdr_len);
RELAY_STATIC_ASSERT(offsetof(struct telemetry_hdr, seq) == 8, telemetry_hdr_seq);
RELAY_STATIC_ASSERT(offsetof(struct telemetry_hdr, uptime_ms) == 12, telemetry_hdr_uptime_ms);

/* TM_STATUS payload: what the station's host knows about its own boot. */
struct station_status {
    uint8_t  module_state;  /* enum module_state */
    uint8_t  _pad;
    uint16_t module_patches;  /* hook patches applied (MOD_LOADED) */
    uint32_t module_len;  /* module code bytes (MOD_LOADED) */
    uint32_t module_load;  /* module load address (MOD_LOADED) */
    uint32_t arena_hi;  /* the boot-info arena top (0x80000034) the host saw at load time; 0 = unset, the game then uses its built-in default */
    uint32_t log_dropped;  /* log bytes discarded because the host's buffer was full */
};  /* 20 bytes */

RELAY_STATIC_ASSERT(sizeof(struct station_status) == 20, station_status_size);
RELAY_STATIC_ASSERT(offsetof(struct station_status, module_state) == 0, station_status_module_state);
RELAY_STATIC_ASSERT(offsetof(struct station_status, _pad) == 1, station_status__pad);
RELAY_STATIC_ASSERT(offsetof(struct station_status, module_patches) == 2, station_status_module_patches);
RELAY_STATIC_ASSERT(offsetof(struct station_status, module_len) == 4, station_status_module_len);
RELAY_STATIC_ASSERT(offsetof(struct station_status, module_load) == 8, station_status_module_load);
RELAY_STATIC_ASSERT(offsetof(struct station_status, arena_hi) == 12, station_status_arena_hi);
RELAY_STATIC_ASSERT(offsetof(struct station_status, log_dropped) == 16, station_status_log_dropped);

/* What the game's module records in its OS error handler (lbcrash.c, installed
 * with OSSetErrorHandler ahead of Melee's own crash screen, which still
 * appears): the exception, the faulting address and the instruction words the
 * PPC READS there through its data cache, the registers that matter and a
 * short walk of the stack's LR saves. The Nintendont kernel forwards it as
 * TM_CRASH; the relay shows it and the addresses are resolved offline against
 * the module map and the vanilla symbol map (melee tools/resolve_crash.py).
 */
struct crash_report {
    uint8_t  error;  /* OSError number: 2 DSI, 3 ISI, 5 alignment, 6 program (illegal instruction), 7 floating point */
    uint8_t  _pad;
    uint16_t count;  /* crashes recorded since boot (normally 1) */
    uint32_t srr0;  /* faulting address */
    uint32_t srr1;  /* MSR at the fault; for a program exception bit 0x80000 = illegal, 0x40000 = privileged, 0x20000 = trap */
    uint32_t dsisr;
    uint32_t dar;  /* data address for DSI / alignment */
    uint32_t lr;
    uint32_t sp;  /* r1 */
    uint32_t r3;
    uint32_t r4;
    uint32_t fetched[4];  /* the four words at srr0 as the PPC reads them (0 when srr0 is not a readable MEM1 address): compared with the module file they tell stale cache from overwritten memory */
    uint32_t stack[CRASH_STACK_DEPTH];  /* LR saves from the stack frames above sp, 0-filled */
};  /* 84 bytes */

RELAY_STATIC_ASSERT(sizeof(struct crash_report) == 84, crash_report_size);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, error) == 0, crash_report_error);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, _pad) == 1, crash_report__pad);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, count) == 2, crash_report_count);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, srr0) == 4, crash_report_srr0);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, srr1) == 8, crash_report_srr1);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, dsisr) == 12, crash_report_dsisr);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, dar) == 16, crash_report_dar);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, lr) == 20, crash_report_lr);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, sp) == 24, crash_report_sp);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, r3) == 28, crash_report_r3);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, r4) == 32, crash_report_r4);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, fetched) == 36, crash_report_fetched);
RELAY_STATIC_ASSERT(offsetof(struct crash_report, stack) == 52, crash_report_stack);

/* Not on the wire: the shared-memory slot at CRASH_MAILBOX_PPC. The module
 * writes report then seq (seq last, so a reader that sees a new seq sees a
 * complete report); the kernel polls seq.
 */
struct crash_mailbox {
    uint32_t            magic;  /* CRASH_MAGIC */
    uint32_t            seq;  /* 0 = nothing recorded; incremented per crash */
    struct crash_report report;
};  /* 92 bytes */

RELAY_STATIC_ASSERT(sizeof(struct crash_mailbox) == 92, crash_mailbox_size);
RELAY_STATIC_ASSERT(offsetof(struct crash_mailbox, magic) == 0, crash_mailbox_magic);
RELAY_STATIC_ASSERT(offsetof(struct crash_mailbox, seq) == 4, crash_mailbox_seq);
RELAY_STATIC_ASSERT(offsetof(struct crash_mailbox, report) == 8, crash_mailbox_report);

/* Every message (request and response) begins with this header. */
struct relay_hdr {
    uint8_t  magic[2];  /* 'M','T' */
    uint8_t  version;  /* PROTO_VERSION */
    uint8_t  cmd;  /* enum relay_cmd */
    uint16_t station;  /* from tournament.cfg */
    uint16_t len;  /* payload bytes following the header */
};  /* 8 bytes */

RELAY_STATIC_ASSERT(sizeof(struct relay_hdr) == 8, relay_hdr_size);
RELAY_STATIC_ASSERT(offsetof(struct relay_hdr, magic) == 0, relay_hdr_magic);
RELAY_STATIC_ASSERT(offsetof(struct relay_hdr, version) == 2, relay_hdr_version);
RELAY_STATIC_ASSERT(offsetof(struct relay_hdr, cmd) == 3, relay_hdr_cmd);
RELAY_STATIC_ASSERT(offsetof(struct relay_hdr, station) == 4, relay_hdr_station);
RELAY_STATIC_ASSERT(offsetof(struct relay_hdr, len) == 6, relay_hdr_len);

/* Every response: relay_hdr (same cmd), then this, then an optional command-
 * specific payload (see messages).
 */
struct relay_resp {
    uint8_t status;  /* enum relay_status */
    uint8_t _pad;
    char    msg[MSG_LEN];  /* short human text for the menu */
};  /* 32 bytes */

RELAY_STATIC_ASSERT(sizeof(struct relay_resp) == 32, relay_resp_size);
RELAY_STATIC_ASSERT(offsetof(struct relay_resp, status) == 0, relay_resp_status);
RELAY_STATIC_ASSERT(offsetof(struct relay_resp, _pad) == 1, relay_resp__pad);
RELAY_STATIC_ASSERT(offsetof(struct relay_resp, msg) == 2, relay_resp_msg);

/* One selectable set in a LIST_SETS response. The relay sends them earliest
 * round first, so equal round names are adjacent (the menu groups them under
 * one header).
 */
struct set_entry {
    uint32_t set_id;
    uint32_t p1_entrant_id;
    uint32_t p2_entrant_id;
    char     round[ROUND_LEN];  /* "WINNERS QUARTER-FINAL", "LOSERS ROUND 1" */
    char     p1_tag[TAG_LEN];
    char     p2_tag[TAG_LEN];
    uint8_t  best_of;  /* 3 or 5 */
    uint8_t  state;  /* 0 = pending, 1 = in progress (this station) */
    uint8_t  _pad[2];
};  /* 72 bytes */

RELAY_STATIC_ASSERT(sizeof(struct set_entry) == 72, set_entry_size);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, set_id) == 0, set_entry_set_id);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, p1_entrant_id) == 4, set_entry_p1_entrant_id);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, p2_entrant_id) == 8, set_entry_p2_entrant_id);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, round) == 12, set_entry_round);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, p1_tag) == 36, set_entry_p1_tag);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, p2_tag) == 52, set_entry_p2_tag);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, best_of) == 68, set_entry_best_of);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, state) == 69, set_entry_state);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, _pad) == 70, set_entry__pad);

/* CMD_LIST_SETS response payload. count set_entry rows follow the fixed part. */
struct list_sets_resp {
    uint16_t         count;  /* number of sets following */
    uint16_t         _pad;
    struct set_entry sets[];
};  /* 4 bytes + variable tail */

RELAY_STATIC_ASSERT(sizeof(struct list_sets_resp) == 4, list_sets_resp_size);
RELAY_STATIC_ASSERT(offsetof(struct list_sets_resp, count) == 0, list_sets_resp_count);
RELAY_STATIC_ASSERT(offsetof(struct list_sets_resp, _pad) == 2, list_sets_resp__pad);
RELAY_STATIC_ASSERT(offsetof(struct list_sets_resp, sets) == 4, list_sets_resp_sets);

/* CMD_START_SET request payload. */
struct start_set_req {
    uint32_t set_id;
    uint8_t  stream;  /* from tournament.cfg */
    uint8_t  _pad[3];
};  /* 8 bytes */

RELAY_STATIC_ASSERT(sizeof(struct start_set_req) == 8, start_set_req_size);
RELAY_STATIC_ASSERT(offsetof(struct start_set_req, set_id) == 0, start_set_req_set_id);
RELAY_STATIC_ASSERT(offsetof(struct start_set_req, stream) == 4, start_set_req_stream);
RELAY_STATIC_ASSERT(offsetof(struct start_set_req, _pad) == 5, start_set_req__pad);

/* One completed game. */
struct game_result {
    uint8_t winner_slot;  /* 1 or 2 */
    uint8_t p1_char;  /* Melee external character id (CharacterKind, the CSS ckind value: 0 = Captain Falcon .. 25 = Ganondorf) of entrant 1; 0xFF = unknown (a game scored by hand). Anything the relay cannot map is omitted, never rejected. */
    uint8_t p2_char;
    uint8_t stage;  /* Melee internal stage id (StKind, e.g. 0x1F Battlefield, 0x20 Final Destination); 0 = unknown, e.g. a game scored by hand */
};  /* 4 bytes */

RELAY_STATIC_ASSERT(sizeof(struct game_result) == 4, game_result_size);
RELAY_STATIC_ASSERT(offsetof(struct game_result, winner_slot) == 0, game_result_winner_slot);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p1_char) == 1, game_result_p1_char);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p2_char) == 2, game_result_p2_char);
RELAY_STATIC_ASSERT(offsetof(struct game_result, stage) == 3, game_result_stage);

/* CMD_REPORT_SCORE request payload. Always the full game list; the relay does
 * a full overwrite (idempotent).
 */
struct report_score_req {
    uint32_t           set_id;
    uint8_t            game_count;  /* 0-5 valid entries in games */
    uint8_t            _pad[3];
    struct game_result games[MAX_GAMES];
};  /* 28 bytes */

RELAY_STATIC_ASSERT(sizeof(struct report_score_req) == 28, report_score_req_size);
RELAY_STATIC_ASSERT(offsetof(struct report_score_req, set_id) == 0, report_score_req_set_id);
RELAY_STATIC_ASSERT(offsetof(struct report_score_req, game_count) == 4, report_score_req_game_count);
RELAY_STATIC_ASSERT(offsetof(struct report_score_req, _pad) == 5, report_score_req__pad);
RELAY_STATIC_ASSERT(offsetof(struct report_score_req, games) == 8, report_score_req_games);

/* CMD_END_SET request payload. Relay derives the winner from the game list. */
struct end_set_req {
    uint32_t           set_id;
    uint8_t            game_count;
    uint8_t            _pad[3];
    struct game_result games[MAX_GAMES];
};  /* 28 bytes */

RELAY_STATIC_ASSERT(sizeof(struct end_set_req) == 28, end_set_req_size);
RELAY_STATIC_ASSERT(offsetof(struct end_set_req, set_id) == 0, end_set_req_set_id);
RELAY_STATIC_ASSERT(offsetof(struct end_set_req, game_count) == 4, end_set_req_game_count);
RELAY_STATIC_ASSERT(offsetof(struct end_set_req, _pad) == 5, end_set_req__pad);
RELAY_STATIC_ASSERT(offsetof(struct end_set_req, games) == 8, end_set_req_games);

/* CMD_ABANDON_SET request payload. Only valid if the set has no reported
 * games.
 */
struct abandon_set_req {
    uint32_t set_id;
};  /* 4 bytes */

RELAY_STATIC_ASSERT(sizeof(struct abandon_set_req) == 4, abandon_set_req_size);
RELAY_STATIC_ASSERT(offsetof(struct abandon_set_req, set_id) == 0, abandon_set_req_set_id);

/* Message map: payload struct after relay_hdr (request) and after
 * relay_resp (ST_OK response).
 *
 *   CMD_LIST_SETS     req: -                  resp payload: list_sets_resp
 *   CMD_START_SET     req: start_set_req      resp payload: -
 *   CMD_REPORT_SCORE  req: report_score_req   resp payload: -
 *   CMD_END_SET       req: end_set_req        resp payload: -
 *   CMD_ABANDON_SET   req: abandon_set_req    resp payload: -
 */

#endif /* RELAY_PROTO_H */
