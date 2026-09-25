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

#define MAX_GAMES          5  /* games per set (best of 5) */
#define MAX_SETS           56  /* cap on set_entry rows in a LIST_SETS response; 56 is the most that fits the game's 4 KB poll buffer (4096 - 12 exi_poll_hdr - 8 hdr - 32 resp - 4 fixed = 4040 bytes = 56 rows of 72) */
#define MSG_LEN            30  /* human-readable status text in relay_resp */
#define ROUND_LEN          24  /* round name as the players see it, upper case: "WINNERS QUARTER-FINAL", "LOSERS ROUND 1", "GRAND FINAL RESET" (start.gg fullRoundText, cut to fit) */
#define TAG_LEN            16  /* player tag */
#define BEACON_PORT        7778  /* UDP port the relay broadcasts relay_beacon to and every station listens on (design R15: stations find the relay; tournament.cfg has no relay address) */
#define BEACON_INTERVAL_MS 2000  /* the relay sends one relay_beacon per interval on every IPv4 interface */
#define SECRET_LEN         16  /* relay shared secret, printable ASCII, NUL-padded (design R16) */
#define AUTH_MAGIC_0       77  /* 'M', first byte of relay_auth */
#define AUTH_MAGIC_1       75  /* 'K', second byte of relay_auth; differs from relay_hdr's 'T' so a host that sends no relay_auth is told so */

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

/* state byte of exi_poll_hdr, the first thing an EXI_RELAY_POLL read returns */
enum exi_poll_state {
    RELAY_IDLE  = 0,
    RELAY_BUSY  = 1,  /* request in flight on the ARM side */
    RELAY_DONE  = 2,  /* response buffer valid */
    RELAY_ERROR = 3,  /* transport failed; response buffer is zeroed */
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
    uint8_t  _pad;
    uint16_t station;  /* tournament.cfg station; 0 in Dolphin (design R10) */
    uint32_t relay_ip;  /* relay IPv4 address as a big-endian u32 (10.0.0.2 = 0x0A000002); 0 = unknown */
    uint16_t relay_port;  /* relay TCP port; 0 = unknown */
    uint16_t _pad2;
};  /* 12 bytes */

RELAY_STATIC_ASSERT(sizeof(struct exi_poll_hdr) == 12, exi_poll_hdr_size);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, state) == 0, exi_poll_hdr_state);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, _pad) == 1, exi_poll_hdr__pad);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, station) == 2, exi_poll_hdr_station);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, relay_ip) == 4, exi_poll_hdr_relay_ip);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, relay_port) == 8, exi_poll_hdr_relay_port);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, _pad2) == 10, exi_poll_hdr__pad2);

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
