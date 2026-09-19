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

#define MAX_GAMES 5  /* games per set (best of 5) */
#define MAX_SETS  64  /* cap on set_entry rows in a LIST_SETS response (4 KB) */
#define MSG_LEN   30  /* human-readable status text in relay_resp */
#define ROUND_LEN 16  /* round name, e.g. WR2, LF, GF */
#define TAG_LEN   16  /* player tag */

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
};

/* Command byte on the fake relay EXI device. Shared by the game side (lbrelayexi.c), Slippi Dolphin's forwarder, and Nintendont's RelayEXI; not part of the TCP wire format. Values chosen clear of Slippi's 0x35-0x3D EXI command range. */
enum exi_cmd {
    EXI_RELAY_REQ  = 208,  /* write request buffer to the ARM side */
    EXI_RELAY_POLL = 209,  /* read {state, response buffer} */
};

/* first byte returned by EXI_RELAY_POLL */
enum exi_poll_state {
    RELAY_IDLE  = 0,
    RELAY_BUSY  = 1,  /* request in flight on the ARM side */
    RELAY_DONE  = 2,  /* response buffer valid */
    RELAY_ERROR = 3,  /* transport failed; see status byte detail */
};

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

/* One selectable set in a LIST_SETS response. */
struct set_entry {
    uint32_t set_id;
    uint32_t p1_entrant_id;
    uint32_t p2_entrant_id;
    char     round[ROUND_LEN];  /* "WR2", "LF", "GF" */
    char     p1_tag[TAG_LEN];
    char     p2_tag[TAG_LEN];
    uint8_t  best_of;  /* 3 or 5 */
    uint8_t  state;  /* 0 = pending, 1 = in progress (this station) */
    uint8_t  _pad[2];
};  /* 64 bytes */

RELAY_STATIC_ASSERT(sizeof(struct set_entry) == 64, set_entry_size);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, set_id) == 0, set_entry_set_id);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, p1_entrant_id) == 4, set_entry_p1_entrant_id);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, p2_entrant_id) == 8, set_entry_p2_entrant_id);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, round) == 12, set_entry_round);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, p1_tag) == 28, set_entry_p1_tag);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, p2_tag) == 44, set_entry_p2_tag);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, best_of) == 60, set_entry_best_of);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, state) == 61, set_entry_state);
RELAY_STATIC_ASSERT(offsetof(struct set_entry, _pad) == 62, set_entry__pad);

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
    uint8_t p1_char;  /* Melee external character id (CharacterKind, the CSS ckind value) */
    uint8_t p2_char;
    uint8_t _pad;
};  /* 4 bytes */

RELAY_STATIC_ASSERT(sizeof(struct game_result) == 4, game_result_size);
RELAY_STATIC_ASSERT(offsetof(struct game_result, winner_slot) == 0, game_result_winner_slot);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p1_char) == 1, game_result_p1_char);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p2_char) == 2, game_result_p2_char);
RELAY_STATIC_ASSERT(offsetof(struct game_result, _pad) == 3, game_result__pad);

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
