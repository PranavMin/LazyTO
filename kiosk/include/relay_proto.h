/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 Kegstand Jesus (PranavMin)
 *
 * relay_proto.h -- GENERATED from protocol.yaml by tools/gen_protocol.py -- DO NOT EDIT.
 *
 * Wire protocol between the Wii (kiosk module / Nintendont kernel), the
 * LazyTO beamer and the relay. See docs/protocol-v2.md and
 * docs/architecture.md in PranavMin/LazyTO.
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

#define RELAY_PROTO_VERSION 2
#define RELAY_MAGIC_0 'M'
#define RELAY_MAGIC_1 'T'

#define MAX_GAMES              5  /* games per set (best of 5) */
#define MAX_SETS               56  /* cap on set_entry rows in a LIST_SETS response; 56 is the most that fits the game's 4 KB poll buffer (4096 - 16 exi_poll_hdr - 8 hdr - 32 resp - 4 fixed = 4036 bytes; 56 rows of 72 = 4032) */
#define MSG_LEN                30  /* human-readable status text in relay_resp */
#define ROUND_LEN              24  /* round name as the players see it, upper case: "WINNERS QUARTER-FINAL", "LOSERS ROUND 1", "GRAND FINAL RESET" (start.gg fullRoundText, cut to fit) */
#define TAG_LEN                16  /* player tag */
#define EXI_PAYLOAD_MAX        88  /* largest request payload the game hands the host after relay_hdr (report_score_req / end_set_req); the kiosk's request buffer and the kernel's EXI staging buffer are both this size */
#define RELAY_REPLY_MAX        4080  /* longest reply (relay_hdr + relay_resp + payload) the relay may send a Wii: the game's 4096-byte poll buffer after the 16-byte exi_poll_hdr. The beamer's response sectors hold 4084; a host treats a longer reply as malformed */
#define BEACON_PORT            29471  /* UDP port the relay broadcasts relay_beacon to and every beamer (and the Dolphin forwarder) listens on (decisions.md R15) */
#define BEACON_INTERVAL_MS     2000  /* the relay sends one relay_beacon per interval on every IPv4 interface */
#define BEACON_STALE_S         10  /* a beamer_hello whose beacon_age_s is above this is a stale beacon: the kernel sets PF_RELAY_STALE (five beacons missed) */
#define SECRET_LEN             16  /* relay shared secret, printable ASCII, NUL-padded (decisions.md R16); in v2 it lives on the beamer (CONFIG/config.txt LAZYTO-SECRET), never on the Wii */
#define AUTH_MAGIC_0           77  /* 'M', first byte of relay_auth */
#define AUTH_MAGIC_1           75  /* 'K', second byte of relay_auth; differs from relay_hdr's 'T' so a host that sends no relay_auth is told so */
#define TELEMETRY_PORT         29472  /* UDP port on the relay that beamers forward telemetry datagrams to (kernel log lines and the module's load status) and send beacon requests to, at the address the beacon came from */
#define TELEMETRY_MAGIC_1      76  /* 'L', second byte of telemetry_hdr ('M','L') */
#define TELEMETRY_TEXT_MAX     480  /* most log text bytes in one TM_LOG datagram; keeps relay_auth + telemetry_hdr + text well under one Ethernet frame */
#define TELEMETRY_STATUS_MS    5000  /* a station sends a TM_STATUS datagram at least this often once it knows the relay */
#define CRASH_MAILBOX_PPC      0xD3003480  /* PPC uncached MEM2 address of the crash_mailbox the game's module writes from its OS error handler; the Nintendont kernel reads it at 0x13003480 (same bytes) and sends a TM_CRASH when seq changes. Between HID_STATUS (0x13003440..0x1300344C) and slippi_settings (0x13003500). Not used by Dolphin. */
#define CRASH_MAGIC            0x4D544352  /* 'MTCR', first word of crash_mailbox */
#define CRASH_STACK_DEPTH      8  /* LR saves walked up the crashed stack in crash_report */
#define RECORD_GATE_PPC        0xD3003200  /* PPC uncached MEM2 address of the record_gate (64 bytes, two 32-byte cache lines); free as far as the code shows, to be confirmed on hardware (docs/redesign.md Plan, phase 1). Not used by Dolphin. */
#define RECORD_GATE_ARM        0x13003200  /* the same record_gate as the Nintendont kernel addresses it */
#define RECORD_THIS_MATCH      0x4D545231  /* 'MTR1': record_gate.want while the kiosk wants the match whose Game Start is being sent recorded; any other value means do not record */
#define RECORD_GATE_HOST_BUILD 7  /* the first Nintendont host_build (exi_poll_hdr.host_build) with the record gate; the kiosk touches RECORD_GATE_PPC only when host_build is at least this (Dolphin sends 0) */
#define NO_PORT                255  /* game_result: the CSS port of an entrant is unknown (a game scored by hand without an L + R claim) */
#define BEAMER_SECTOR_SIZE     512  /* sector size of the beamer mailbox (the beamer reports its SD card's 512-byte sectors) */
#define BEAMER_MB_SECTORS      16  /* sectors in the beamer mailbox window, which starts at the end of the replay partition (LBA = partition end + offset) */
#define BEAMER_MB_HELLO        0  /* mailbox sector of beamer_hello (beamer to Wii) */
#define BEAMER_MB_REQ          1  /* mailbox sector of the request: beamer_req_hdr + relay_hdr + payload, no relay_auth (Wii to beamer) */
#define BEAMER_MB_RESP         2  /* first mailbox sector of the response: beamer_resp_hdr + the relay's reply (beamer to Wii) */
#define BEAMER_MB_RESP_SECTORS 8  /* sectors the response spans: 4096 - 12 = 4084 reply bytes, of which a Wii takes at most RELAY_REPLY_MAX */
#define BEAMER_MB_TELE         10  /* first mailbox sector of a telemetry datagram: beamer_tele_hdr + telemetry_hdr + payload, no relay_auth (Wii to beamer) */
#define BEAMER_MB_TELE_SECTORS 2  /* sectors a telemetry datagram may span (beamer_tele_hdr 12 + telemetry_hdr 16 + TELEMETRY_TEXT_MAX 480 = 508 fits the first; the second is kept from mailbox v1) */
#define BEAMER_MB_VERSION      2  /* mailbox layout version in beamer_hello. 2 (2026-10-07): beamer_hello v2, station and secret on the beamer, requests and telemetry without relay_auth */
#define BEAMER_FW_MIN          2  /* the lowest beamer_hello.fw_build a v2 kernel accepts (mailbox v2, the beacon checked by magic and length, the scan fix, the sync); below it the kernel reports NB_OLD_FIRMWARE */
#define BEAMER_SYNC_VERSION    1  /* FROZEN. relay_hdr.version of a CMD_BEAMER_SYNC request and of its reply, in place of PROTO_VERSION: the sync layout never changes with the Wii protocol */
#define SYNC_MAX_FILES         16  /* most sync_file entries in one beamer_sync_req (and sync_answer entries in its reply) */
#define SYNC_NAME_LEN          40  /* file name bytes in sync_file: Game_<12 hex MAC>_<YYYYMMDDTHHMMSS>.slp is 37. A beamer never syncs a longer name (it is counted, never acked, never erased) */
#define SYNC_ID_LEN            16  /* bytes of a beamer's station_id (its StationId, derived from the MAC; /status shows it as a UUID) and of an archive_id */
#define SHA256_LEN             32  /* bytes of a SHA-256 digest and of an HMAC-SHA256 */

/* request/response command, echoed back in the response header. 6 (CMD_GAME_START, v1) is retired: never reuse it */
enum relay_cmd {
    CMD_LIST_SETS    = 1,
    CMD_START_SET    = 2,
    CMD_REPORT_SCORE = 3,
    CMD_END_SET      = 4,
    CMD_ABANDON_SET  = 5,  /* player-initiated "wrong set"; never sent, and the relay does not handle it */
    CMD_BEAMER_SYNC  = 8,  /* FROZEN value. Sent by a beamer itself (never a Wii) on its relay link, with relay_hdr.version = BEAMER_SYNC_VERSION: its inventory and ack questions (beamer_sync_req); the relay answers beamer_sync_resp, signed. Touches no set and no station row */
};

/* result of a request, first byte of relay_resp */
enum relay_status {
    ST_OK            = 0,
    ST_BAD_VERSION   = 1,
    ST_SET_NOT_FOUND = 2,
    ST_SET_TAKEN     = 3,  /* started on another station */
    ST_NOT_STREAM    = 4,  /* no longer sent: the relay picks the stream station itself */
    ST_STARTGG_ERROR = 5,  /* upstream rejected; see status page */
    ST_RATE_LIMITED  = 6,
    ST_INTERNAL      = 7,
    ST_BAD_SECRET    = 8,  /* relay_auth missing or its secret wrong; check LAZYTO-SECRET in the beamer's CONFIG/config.txt (decisions.md R16) */
    ST_DUP_STATION   = 9,  /* another beamer (another station_id) already plays as this station number: this one, the newcomer, is refused until one of them is renumbered; msg names the number */
};

/* Command byte on the fake relay EXI device. Shared by the game side (lbrelayexi.c), Slippi Dolphin's forwarder, and Nintendont's RelayEXI; not part of the TCP wire format. Values chosen clear of Slippi's EXI command space, which extends to 0xE5 (CMD_GET_RANK_VISIBILITY in EXI_DeviceSlippi.h). */
enum exi_cmd {
    EXI_RELAY_REQ  = 240,  /* write request buffer to the ARM side */
    EXI_RELAY_POLL = 241,  /* read {state, response buffer} */
};

/* bit flags in exi_poll_hdr.flags, set by the Nintendont kernel from the beamer's latest hello so the kiosk can say why a request cannot go out; 0 = nothing known wrong (Dolphin). 1, 2, 4 and 8 (v1: PF_NO_NETWORK, PF_NO_CFG, the card's PF_NO_SECRET, PF_NET_JOINING) are retired: never reuse them */
enum exi_poll_flags {
    PF_NO_BEAMER   = 16,  /* no valid v2 beamer_hello: no LazyTO beamer on USB; exi_poll_hdr.no_beamer_reason says why */
    PF_NO_STATION  = 32,  /* the beamer has no station number (hello without BF_STATION_SET): press its button. Requests are not sent and telemetry is dropped until it has one */
    PF_NO_SECRET   = 64,  /* the beamer has no LAZYTO-SECRET in its CONFIG/config.txt (hello without BF_SECRET) */
    PF_RELAY_STALE = 128,  /* the beamer knows a relay address (BF_RELAY) but has not heard its beacon for more than BEACON_STALE_S; requests still go to that address */
};

/* exi_poll_hdr.no_beamer_reason: why PF_NO_BEAMER is set. 0 = no reason known, or PF_NO_BEAMER clear */
enum no_beamer_reason {
    NB_UNKNOWN      = 0,
    NB_REPLAYS_OFF  = 1,  /* the loader's Slippi replays option is off or the game is not on SD, so USB is never started */
    NB_NO_DRIVE     = 2,  /* no USB mass-storage drive is mounted */
    NB_NOT_LAZYTO   = 3,  /* a drive, but no beamer_hello magic past its replay partition: a plain stick, or a beamer without LAZYTO = true */
    NB_OLD_FIRMWARE = 4,  /* a LazyTO beamer whose hello is an older mailbox version or whose fw_build is below BEAMER_FW_MIN: update the beamer */
    NB_STARTING     = 5,  /* no hello yet within about 45 s of kernel boot or a USB removal: the beamer may still be booting, erasing or joining the Wi-Fi */
    NB_NEW_FIRMWARE = 6,  /* the beamer's hello is a newer mailbox version than this loader knows: update the SD card */
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
    RELAY_ERROR = 3,  /* the request did not reach the relay or its answer did not come back; exi_poll_hdr.last_fail says why; the response buffer is zeroed */
};

/* exi_poll_hdr.last_fail: why the last request ended in RELAY_ERROR. 0 = none (the last request completed, or none yet). 1-0x7F are beamer_result values (BR_*), whether the beamer answered with it or the kernel knew it from the hello and did not send; 0x80 and up are the kernel's own */
enum relay_fail {
    LF_NONE        = 0,
    LF_NO_BEAMER   = 128,  /* no valid beamer_hello when the request came (PF_NO_BEAMER) */
    LF_USB_WRITE   = 129,  /* writing the request sector failed */
    LF_USB_READ    = 130,  /* reading the response sectors failed */
    LF_USB_BUSY    = 131,  /* the USB lock stayed taken past the request's budget: the Slippi writer, or a beamer recovering its SD card */
    LF_NO_ANSWER   = 132,  /* no response carrying the request's seq within the 3 s budget */
    LF_BAD_REPLY   = 133,  /* the beamer's response was malformed: bad magic, len above RELAY_REPLY_MAX, or a relay_hdr that does not echo the request (a bug: tell the TO) */
    LF_BAD_REQUEST = 134,  /* the game's request was malformed or longer than EXI_PAYLOAD_MAX (a bug: tell the TO) */
    LF_BEAMER_LOST = 135,  /* the beamer's hello went invalid while the request was in flight (unplugged or rebooted) */
};

/* what follows a telemetry_hdr */
enum telemetry_kind {
    TM_LOG    = 1,  /* len bytes of kernel log text, ASCII, lines ending in \n (a line may be split across datagrams) */
    TM_STATUS = 2,  /* one station_status */
    TM_CRASH  = 3,  /* one crash_report: the game took an unhandled exception */
};

/* beamer_resp_hdr.result: how the beamer's round trip to the relay went (also beamer_hello.last_result, and passed through in exi_poll_hdr.last_fail) */
enum beamer_result {
    BR_OK         = 0,  /* the relay's reply follows, len bytes */
    BR_NO_RELAY   = 1,  /* the beamer has not found the relay (no beacon yet) */
    BR_NO_WIFI    = 2,  /* the beamer is not on Wi-Fi */
    BR_CONNECT    = 3,  /* TCP connect to the relay failed: the laptop is unreachable or its firewall blocks LazyTO */
    BR_TIMEOUT    = 4,  /* the relay did not answer within the budget */
    BR_TOO_LARGE  = 5,  /* the relay's reply did not fit the mailbox */
    BR_BAD_REQ    = 6,  /* the request sector was malformed (bad magic or length) */
    BR_NO_STATION = 7,  /* the beamer has no station number; refused without contacting the relay */
    BR_NO_SECRET  = 8,  /* the beamer has no LAZYTO-SECRET; refused without contacting the relay */
};

/* bit flags in beamer_hello.flags */
enum beamer_flags {
    BF_WIFI        = 1,  /* joined the Wi-Fi and has an address (exactly when wifi is WIFI_UP) */
    BF_RELAY       = 2,  /* has heard the relay's beacon; relay_ip, relay_port and beacon_age_s are valid */
    BF_STATION_SET = 4,  /* station is valid: the beamer has a number (LazyTO mode: saved in its flash, unset until the first click) */
    BF_SECRET      = 8,  /* its CONFIG/config.txt has a LAZYTO-SECRET, which it puts in relay_auth */
};

/* beamer_hello.wifi, copied as-is into exi_poll_hdr.beamer_wifi: the beamer's Wi-Fi state. 0 = up (in exi_poll_hdr: up or unknown) */
enum beamer_wifi {
    WIFI_UP         = 0,
    WIFI_JOINING    = 1,  /* joining or getting an address; clears by itself (the kiosk waits up to 60 s) */
    WIFI_NO_SSID    = 2,  /* no SSID in CONFIG/config.txt */
    WIFI_CANT_JOIN  = 3,  /* the network cannot be reached or refused the password (firmware WIFI ISSUE) */
    WIFI_NO_ADDRESS = 4,  /* joined, but DHCP gave no address (firmware WIFI TOO FULL) */
    WIFI_RADIO      = 5,  /* the radio failed to start (firmware RADIO FAILURE) */
};

/* beamer_hello.storage, copied as-is into exi_poll_hdr.beamer_storage: the beamer's SD card. 0 = fine (in exi_poll_hdr: fine or unknown) */
enum beamer_storage {
    STORE_OK           = 0,
    STORE_NO_CARD      = 1,  /* no SD card (firmware NO SD CARD) */
    STORE_UNREADABLE   = 2,  /* the card cannot be read (SD UNREADABLE, DRIVE FAILING) */
    STORE_WRITE_FAILED = 3,  /* a write failed or the card stayed busy (WRITE FAILED, CARD STUCK) */
    STORE_WRONG_FORMAT = 4,  /* not the FAT32 layout the beamer needs (WRONG FORMAT) */
    STORE_FILLING      = 5,  /* 384 files or more, or under 1 GB free: replug the beamer to erase collected replays */
    STORE_FULL         = 6,  /* under 64 MB free: the next replay would fail (REPLAYS NOT SAVING) */
};

/* FROZEN. bit flags in beamer_sync_req.flags */
enum beamer_sync_flags {
    SF_STATION_SET  = 1,  /* station is valid */
    SF_COLD_BOOT    = 2,  /* this boot was a cold boot (power-on, first boot since power was applied); the erase report is this boot's */
    SF_ERASE_FAILED = 4,  /* an unlink failed during this boot's erase, which then stopped */
    SF_ACKS_DROPPED = 8,  /* the ack table was dropped at this boot because the card changed (FAT volume serial or SD CID) */
    SF_MORE         = 16,  /* more files need an answer than this sync lists; the beamer syncs again soon */
};

/* FROZEN. sync_file.kind: what the beamer knows about a file. Files with an ack are never listed (they are counted in to_erase) */
enum sync_kind {
    SK_FINISHED   = 1,  /* complete: its size covers the raw length in its header */
    SK_INCOMPLETE = 2,  /* not live and not complete: an interrupted recording; the relay keeps it as partial */
    SK_LIVE       = 3,  /* being recorded now (raw length 0, the newest file, a host command in the last few seconds); not served yet */
};

/* FROZEN. sync_answer.answer. 0 is NOTED so a zero-filled answer never erases or downloads anything */
enum sync_answer_kind {
    SA_NOTED  = 0,  /* known; nothing to do now (live, already downloading, disk full, or not wanted yet) */
    SA_HELD   = 1,  /* the laptop has stored this file; sha256 is the SHA-256 of its stored copy. The beamer acks the file only if that equals the SHA-256 it computed serving it this boot */
    SA_WANTED = 2,  /* the laptop will download this file (GET from the beamer's HTTP port) */
};

/* what the host did with sd:/lazyto_kiosk.bin at game boot (Nintendont kernel LoadTournamentModule) */
enum module_state {
    MOD_PENDING     = 0,  /* no game booted yet */
    MOD_LOADED      = 1,
    MOD_NOT_FOUND   = 2,  /* no sd:/lazyto_kiosk.bin */
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
 * Dolphin) on every poll, from the beamer's latest hello, so the game can show
 * which station it is, which relay it is talking to and what is wrong even
 * while the relay never answers. The response bytes after it are valid only
 * when state == RELAY_DONE. Every field after host_build reads 0 as fine or
 * unknown, so the Dolphin forwarder sends zeros.
 */
struct exi_poll_hdr {
    uint8_t  state;  /* enum exi_poll_state */
    uint8_t  flags;  /* exi_poll_flags bits: why a request cannot go out yet; 0 = nothing known wrong (Dolphin) */
    uint16_t station;  /* the beamer's station number from its hello (valid unless PF_NO_STATION or PF_NO_BEAMER); 0 in Dolphin (decisions.md R10) */
    uint32_t relay_ip;  /* relay IPv4 address from the hello, big-endian u32 (10.0.0.2 = 0x0A000002); 0 = unknown (no BF_RELAY) */
    uint16_t relay_port;  /* relay TCP port; 0 = unknown */
    uint8_t  host_opts;  /* exi_host_opts bits: venue audio choices from the host's settings (Nintendont loader menu); 0 = the kiosk defaults, mono and music off (Dolphin) */
    uint8_t  host_build;  /* the host's build number for the set list's version text and feature gates (Nintendont RELAY_HOST_BUILD, bumped by hand per loader release; RECORD_GATE_HOST_BUILD); 0 = unknown (Dolphin) */
    uint8_t  no_beamer_reason;  /* enum no_beamer_reason, with PF_NO_BEAMER; 0 otherwise */
    uint8_t  beamer_wifi;  /* enum beamer_wifi from the hello; 0 = up or unknown */
    uint8_t  beamer_storage;  /* enum beamer_storage from the hello; 0 = fine or unknown */
    uint8_t  last_fail;  /* enum relay_fail (or a beamer_result below 0x80): why the last request ended in RELAY_ERROR; 0 = none */
};  /* 16 bytes */

RELAY_STATIC_ASSERT(sizeof(struct exi_poll_hdr) == 16, exi_poll_hdr_size);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, state) == 0, exi_poll_hdr_state);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, flags) == 1, exi_poll_hdr_flags);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, station) == 2, exi_poll_hdr_station);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, relay_ip) == 4, exi_poll_hdr_relay_ip);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, relay_port) == 8, exi_poll_hdr_relay_port);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, host_opts) == 10, exi_poll_hdr_host_opts);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, host_build) == 11, exi_poll_hdr_host_build);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, no_beamer_reason) == 12, exi_poll_hdr_no_beamer_reason);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, beamer_wifi) == 13, exi_poll_hdr_beamer_wifi);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, beamer_storage) == 14, exi_poll_hdr_beamer_storage);
RELAY_STATIC_ASSERT(offsetof(struct exi_poll_hdr, last_fail) == 15, exi_poll_hdr_last_fail);

/* FROZEN. Relay discovery (decisions.md R15). Not on the TCP wire: one UDP
 * datagram, broadcast by the relay every BEACON_INTERVAL_MS to each IPv4
 * interface's directed broadcast address, port BEACON_PORT. A beamer (and the
 * Dolphin forwarder) listens on BEACON_PORT, ignores datagrams whose length or
 * magic do not match, never checks version (dongles have no over-the-air
 * update), and takes the datagram's SOURCE address plus tcp_port as the relay;
 * the latest valid beacon wins, so a relay that changes address is followed.
 * One relay per LAN. BEACON REQUEST: some access points do not deliver
 * broadcasts to a power-saving Wi-Fi client, so a beamer that has heard
 * nothing may broadcast this same struct with tcp_port = 0 and event_id = 0 to
 * TELEMETRY_PORT; the relay answers any such 12-byte datagram with magic
 * 'M','T' (whatever its version) with a unicast relay_beacon to the sender's
 * address at BEACON_PORT.
 */
struct relay_beacon {
    uint8_t  magic[2];  /* 'M','T' */
    uint8_t  version;  /* PROTO_VERSION of the relay; informational, never checked by a beamer */
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

/* FROZEN. Relay shared secret (decisions.md R16). Not part of the game's
 * messages: the beamer writes it on the TCP connection before the kernel's
 * relay_hdr + payload, and in front of each telemetry datagram, with LAZYTO-
 * SECRET from its CONFIG/config.txt (the Dolphin forwarder uses
 * SlippiRelaySecret). The Wii never holds the secret. The relay compares the
 * secret with its config in constant time and answers a missing or wrong one
 * with ST_BAD_SECRET without acting on the request. Responses carry no
 * relay_auth. Plaintext on the LAN: it keeps passers-by on a shared Wi-Fi out,
 * not someone capturing the Wi-Fi traffic.
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

/* Station telemetry. Not part of the game's messages: the Nintendont kernel
 * writes this header and len payload bytes (TM_LOG text, one station_status or
 * one crash_report) to the beamer's telemetry sectors; the beamer sends
 * relay_auth + those bytes as one UDP datagram to the relay's address from the
 * beacon, port TELEMETRY_PORT. The relay drops datagrams with a wrong secret
 * (counted on the status page), keeps the last log lines and status per
 * station, and never answers. seq counts datagrams from 0 at kernel boot, so a
 * gap is a lost datagram and a smaller seq is a reboot.
 */
struct telemetry_hdr {
    uint8_t  magic[2];  /* MAGIC_0, TELEMETRY_MAGIC_1 ('M','L') */
    uint8_t  version;  /* PROTO_VERSION */
    uint8_t  kind;  /* enum telemetry_kind */
    uint16_t station;  /* stamped by the kernel from the beamer's hello (BF_STATION_SET) */
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

/* Not on the wire: the shared-memory slot at RECORD_GATE_PPC (kernel:
 * RECORD_GATE_ARM) through which the kiosk chooses which matches Slippi
 * records (docs/redesign.md, Recording only set games). Two 32-byte cache
 * lines, so a PPC-written field and a kernel-written field never share one.
 * Line 0 is written only by the PPC with u32 stores (want: set to
 * RECORD_THIS_MATCH just before vanilla gm_Scene_Vs_OnEnter, whose StartMelee
 * sends Slippi's Game Start, and cleared right after). Line 1 is written only
 * by the kernel, which reads line 0 with sync_before_read in its Game Start
 * EXI handler and keeps {ring cursor, record, seq}. The kernel zeroes both
 * lines at boot.
 */
struct record_gate {
    uint32_t want;  /* line 0, PPC-written: RECORD_THIS_MATCH while the Game Start being sent belongs to a set game; anything else = do not record (with a kiosk module loaded) */
    uint32_t _pad[7];
    uint32_t start_seq;  /* line 1, kernel-written: Game Starts seen since kernel boot, incremented at each one whether recorded or not */
    uint32_t file_seq;  /* the start_seq of the last match a replay file was opened for; 0 = none since boot */
    uint32_t file_id;  /* that file's gameStartTime (Unix seconds, the Wii clock read as UTC): its name is Game_<MAC>_<file_id as YYYYMMDDTHHMMSS>.slp. The kernel writes file_id before file_seq */
    uint32_t _pad2[5];
};  /* 64 bytes */

RELAY_STATIC_ASSERT(sizeof(struct record_gate) == 64, record_gate_size);
RELAY_STATIC_ASSERT(offsetof(struct record_gate, want) == 0, record_gate_want);
RELAY_STATIC_ASSERT(offsetof(struct record_gate, _pad) == 4, record_gate__pad);
RELAY_STATIC_ASSERT(offsetof(struct record_gate, start_seq) == 32, record_gate_start_seq);
RELAY_STATIC_ASSERT(offsetof(struct record_gate, file_seq) == 36, record_gate_file_seq);
RELAY_STATIC_ASSERT(offsetof(struct record_gate, file_id) == 40, record_gate_file_id);
RELAY_STATIC_ASSERT(offsetof(struct record_gate, _pad2) == 44, record_gate__pad2);

/* FROZEN layout. Every message (request and response) begins with this header. */
struct relay_hdr {
    uint8_t  magic[2];  /* 'M','T' */
    uint8_t  version;  /* PROTO_VERSION; BEAMER_SYNC_VERSION for CMD_BEAMER_SYNC */
    uint8_t  cmd;  /* enum relay_cmd */
    uint16_t station;  /* stamped by the kernel from the beamer's hello (the game sends 0); for CMD_BEAMER_SYNC the beamer's number or 0, which the relay ignores */
    uint16_t len;  /* payload bytes following the header (in a response: relay_resp + payload) */
};  /* 8 bytes */

RELAY_STATIC_ASSERT(sizeof(struct relay_hdr) == 8, relay_hdr_size);
RELAY_STATIC_ASSERT(offsetof(struct relay_hdr, magic) == 0, relay_hdr_magic);
RELAY_STATIC_ASSERT(offsetof(struct relay_hdr, version) == 2, relay_hdr_version);
RELAY_STATIC_ASSERT(offsetof(struct relay_hdr, cmd) == 3, relay_hdr_cmd);
RELAY_STATIC_ASSERT(offsetof(struct relay_hdr, station) == 4, relay_hdr_station);
RELAY_STATIC_ASSERT(offsetof(struct relay_hdr, len) == 6, relay_hdr_len);

/* FROZEN layout. Every response: relay_hdr (same cmd), then this, then an
 * optional command-specific payload (see messages).
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
    uint8_t  stream;  /* unused: the game sends 0 and the relay ignores it (the stream station is set on the relay) */
    uint8_t  _pad[3];
};  /* 8 bytes */

RELAY_STATIC_ASSERT(sizeof(struct start_set_req) == 8, start_set_req_size);
RELAY_STATIC_ASSERT(offsetof(struct start_set_req, set_id) == 0, start_set_req_set_id);
RELAY_STATIC_ASSERT(offsetof(struct start_set_req, stream) == 4, start_set_req_stream);
RELAY_STATIC_ASSERT(offsetof(struct start_set_req, _pad) == 5, start_set_req__pad);

/* One completed game. The stock and costume fields feed start.gg's per-game
 * entrant scores the way Replay Reporter for Slippi does: score = (costume +
 * 1) * 100 + stocks remaining, so the set page shows the colour and the stock
 * icons; both stocks 0xFF = no score sent (a game scored by hand, or one the
 * ledge-grab limit or LGL's tiebreak game decided). The ports and replay_id
 * (v2) name the replay: the relay fetches Game_<MAC>_<replay_id as UTC
 * YYYYMMDDTHHMMSS>.slp from the beamer the set was played through, and labels
 * its ports with the entrants' tags.
 */
struct game_result {
    uint8_t  winner_slot;  /* 1 or 2 */
    uint8_t  p1_char;  /* Melee external character id (CharacterKind, the CSS ckind value: 0 = Captain Falcon .. 25 = Ganondorf) of entrant 1; 0xFF = unknown (a game scored by hand). Anything the relay cannot map is omitted, never rejected. */
    uint8_t  p2_char;
    uint8_t  stage;  /* Melee internal stage id (StKind, e.g. 0x1F Battlefield, 0x20 Final Destination); 0 = unknown, e.g. a game scored by hand */
    uint8_t  p1_stocks;  /* entrant 1's stocks remaining at the end of the game (0 for the player who was KO'd); 0xFF = unknown or not to be sent */
    uint8_t  p2_stocks;
    uint8_t  p1_costume;  /* entrant 1's costume (colour) index, 0 = the default colour; 0xFF = unknown */
    uint8_t  p2_costume;
    uint8_t  p1_port;  /* CSS port 0-3 entrant 1 played on (from the L + R claim); NO_PORT = unknown */
    uint8_t  p2_port;  /* CSS port 0-3 of entrant 2; NO_PORT = unknown */
    uint16_t _pad;
    uint32_t replay_id;  /* the game's replay: record_gate.file_id of its match (a tiebreak game reports its main game's); 0 = no replay (no beamer, replays off, a stalled writer, Dolphin, or a hand-scored game whose match was not recorded) */
};  /* 16 bytes */

RELAY_STATIC_ASSERT(sizeof(struct game_result) == 16, game_result_size);
RELAY_STATIC_ASSERT(offsetof(struct game_result, winner_slot) == 0, game_result_winner_slot);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p1_char) == 1, game_result_p1_char);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p2_char) == 2, game_result_p2_char);
RELAY_STATIC_ASSERT(offsetof(struct game_result, stage) == 3, game_result_stage);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p1_stocks) == 4, game_result_p1_stocks);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p2_stocks) == 5, game_result_p2_stocks);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p1_costume) == 6, game_result_p1_costume);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p2_costume) == 7, game_result_p2_costume);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p1_port) == 8, game_result_p1_port);
RELAY_STATIC_ASSERT(offsetof(struct game_result, p2_port) == 9, game_result_p2_port);
RELAY_STATIC_ASSERT(offsetof(struct game_result, _pad) == 10, game_result__pad);
RELAY_STATIC_ASSERT(offsetof(struct game_result, replay_id) == 12, game_result_replay_id);

/* CMD_REPORT_SCORE request payload. Always the full game list; the relay does
 * a full overwrite (idempotent).
 */
struct report_score_req {
    uint32_t           set_id;
    uint8_t            game_count;  /* 0-5 valid entries in games */
    uint8_t            _pad[3];
    struct game_result games[MAX_GAMES];
};  /* 88 bytes */

RELAY_STATIC_ASSERT(sizeof(struct report_score_req) == 88, report_score_req_size);
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
};  /* 88 bytes */

RELAY_STATIC_ASSERT(sizeof(struct end_set_req) == 88, end_set_req_size);
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

/* Beamer mailbox sector BEAMER_MB_HELLO, written by the beamer (a Slippi
 * Beamer running the LazyTO firmware with LAZYTO = true), read by the
 * Nintendont kernel about once a second. The mailbox is BEAMER_MB_SECTORS
 * sectors right after the beamer's replay partition, served from the beamer's
 * RAM: no filesystem covers them on either side. The kernel writes nothing to
 * the mailbox until this sector carries the magic and BEAMER_MB_VERSION.
 * Offsets 0-17 and fw_build at 20 are where mailbox v1 had them, so a kernel
 * can tell old firmware from no beamer. Not on the TCP wire.
 */
struct beamer_hello {
    char     magic[8];  /* LAZYTOMB */
    uint8_t  version;  /* BEAMER_MB_VERSION */
    uint8_t  flags;  /* beamer_flags bits */
    uint16_t station;  /* the station number on the beamer's screen; valid only with BF_STATION_SET (unset is a flag, never 0: Dolphin is station 0) */
    uint32_t relay_ip;  /* relay IPv4 address from the beacon, big-endian u32; 0 = unknown */
    uint16_t relay_port;  /* relay TCP port; 0 = unknown */
    uint8_t  wifi;  /* enum beamer_wifi */
    uint8_t  storage;  /* enum beamer_storage */
    uint32_t fw_build;  /* the beamer firmware's LazyTO build number (at least BEAMER_FW_MIN) */
    uint8_t  last_result;  /* enum beamer_result of the last mailbox round trip; 0 = BR_OK or none yet */
    uint8_t  _pad;
    uint16_t beacon_age_s;  /* seconds since the relay's beacon was last heard, saturating at 0xFFFF; valid with BF_RELAY */
    uint32_t _pad2;
};  /* 32 bytes */

RELAY_STATIC_ASSERT(sizeof(struct beamer_hello) == 32, beamer_hello_size);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, magic) == 0, beamer_hello_magic);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, version) == 8, beamer_hello_version);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, flags) == 9, beamer_hello_flags);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, station) == 10, beamer_hello_station);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, relay_ip) == 12, beamer_hello_relay_ip);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, relay_port) == 16, beamer_hello_relay_port);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, wifi) == 18, beamer_hello_wifi);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, storage) == 19, beamer_hello_storage);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, fw_build) == 20, beamer_hello_fw_build);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, last_result) == 24, beamer_hello_last_result);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, _pad) == 25, beamer_hello__pad);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, beacon_age_s) == 26, beamer_hello_beacon_age_s);
RELAY_STATIC_ASSERT(offsetof(struct beamer_hello, _pad2) == 28, beamer_hello__pad2);

/* Start of mailbox sector BEAMER_MB_REQ (Wii to beamer): then len bytes,
 * relay_hdr + payload exactly as the relay is to get them after relay_auth.
 * The beamer refuses the request locally with BR_NO_STATION or BR_NO_SECRET
 * when it has no number or no secret; otherwise it sends relay_auth (its
 * LAZYTO-SECRET) + those bytes to the relay once per seq (a repeated write of
 * the same seq, for example a USB retry, is not sent again) and answers in the
 * response sectors.
 */
struct beamer_req_hdr {
    uint8_t  magic[2];  /* 'M','Q' */
    uint16_t _pad;
    uint32_t seq;  /* nonzero; counts up by one per request. The beamer stays powered across Wii reboots and keeps its last response, so whenever the kernel finds the beamer (first valid beamer_hello after boot or a USB change) it starts one past the seq in the response sector (or at 1 if that is 0) */
    uint16_t len;  /* bytes after this header (relay_hdr + payload), at most BEAMER_SECTOR_SIZE - 12 */
    uint16_t _pad2;
};  /* 12 bytes */

RELAY_STATIC_ASSERT(sizeof(struct beamer_req_hdr) == 12, beamer_req_hdr_size);
RELAY_STATIC_ASSERT(offsetof(struct beamer_req_hdr, magic) == 0, beamer_req_hdr_magic);
RELAY_STATIC_ASSERT(offsetof(struct beamer_req_hdr, _pad) == 2, beamer_req_hdr__pad);
RELAY_STATIC_ASSERT(offsetof(struct beamer_req_hdr, seq) == 4, beamer_req_hdr_seq);
RELAY_STATIC_ASSERT(offsetof(struct beamer_req_hdr, len) == 8, beamer_req_hdr_len);
RELAY_STATIC_ASSERT(offsetof(struct beamer_req_hdr, _pad2) == 10, beamer_req_hdr__pad2);

/* Start of mailbox sector BEAMER_MB_RESP (beamer to Wii): then len bytes of
 * the relay's reply (relay_hdr + relay_resp + payload) when result is BR_OK.
 * Valid for the request whose seq it carries; the kernel polls until seq
 * matches its request.
 */
struct beamer_resp_hdr {
    uint8_t  magic[2];  /* 'M','R' */
    uint8_t  result;  /* enum beamer_result */
    uint8_t  _pad;
    uint32_t seq;  /* the request's seq; 0 = no response yet */
    uint16_t len;
    uint16_t _pad2;
};  /* 12 bytes */

RELAY_STATIC_ASSERT(sizeof(struct beamer_resp_hdr) == 12, beamer_resp_hdr_size);
RELAY_STATIC_ASSERT(offsetof(struct beamer_resp_hdr, magic) == 0, beamer_resp_hdr_magic);
RELAY_STATIC_ASSERT(offsetof(struct beamer_resp_hdr, result) == 2, beamer_resp_hdr_result);
RELAY_STATIC_ASSERT(offsetof(struct beamer_resp_hdr, _pad) == 3, beamer_resp_hdr__pad);
RELAY_STATIC_ASSERT(offsetof(struct beamer_resp_hdr, seq) == 4, beamer_resp_hdr_seq);
RELAY_STATIC_ASSERT(offsetof(struct beamer_resp_hdr, len) == 8, beamer_resp_hdr_len);
RELAY_STATIC_ASSERT(offsetof(struct beamer_resp_hdr, _pad2) == 10, beamer_resp_hdr__pad2);

/* Start of mailbox sector BEAMER_MB_TELE (Wii to beamer): then len bytes of
 * one telemetry datagram (telemetry_hdr + payload), which the beamer sends as
 * relay_auth + those bytes to the relay's TELEMETRY_PORT once per seq.
 * Unanswered. Dropped by a beamer without a number or a secret.
 */
struct beamer_tele_hdr {
    uint8_t  magic[2];  /* 'M','E' */
    uint16_t _pad;
    uint32_t seq;
    uint16_t len;  /* bytes after this header, at most BEAMER_MB_TELE_SECTORS * BEAMER_SECTOR_SIZE - 12 */
    uint16_t _pad2;
};  /* 12 bytes */

RELAY_STATIC_ASSERT(sizeof(struct beamer_tele_hdr) == 12, beamer_tele_hdr_size);
RELAY_STATIC_ASSERT(offsetof(struct beamer_tele_hdr, magic) == 0, beamer_tele_hdr_magic);
RELAY_STATIC_ASSERT(offsetof(struct beamer_tele_hdr, _pad) == 2, beamer_tele_hdr__pad);
RELAY_STATIC_ASSERT(offsetof(struct beamer_tele_hdr, seq) == 4, beamer_tele_hdr_seq);
RELAY_STATIC_ASSERT(offsetof(struct beamer_tele_hdr, len) == 8, beamer_tele_hdr_len);
RELAY_STATIC_ASSERT(offsetof(struct beamer_tele_hdr, _pad2) == 10, beamer_tele_hdr__pad2);

/* FROZEN. One file in a beamer_sync_req: a Game_*.slp on the beamer's card
 * that has no ack. Listed in this order, oldest modified time first within
 * each group, until SYNC_MAX_FILES: files served this boot (hashed), then
 * SK_FINISHED, SK_INCOMPLETE, SK_LIVE.
 */
struct sync_file {
    char     name[SYNC_NAME_LEN];  /* file name in the replay folder, without the folder (Game_0017AB12CD34_20261007T201502.slp) */
    uint32_t bytes;  /* file size in bytes, from the directory entry */
    uint32_t mtime;  /* FAT modified date << 16 | FAT modified time, from the directory entry */
    uint8_t  kind;  /* enum sync_kind */
    uint8_t  hashed;  /* 1 = sha256 is valid: the beamer served the whole file this boot and hashed its raw bytes (before gzip) while serving; 0 = sha256 is zero */
    uint16_t _pad;
    uint8_t  sha256[SHA256_LEN];
};  /* 84 bytes */

RELAY_STATIC_ASSERT(sizeof(struct sync_file) == 84, sync_file_size);
RELAY_STATIC_ASSERT(offsetof(struct sync_file, name) == 0, sync_file_name);
RELAY_STATIC_ASSERT(offsetof(struct sync_file, bytes) == 40, sync_file_bytes);
RELAY_STATIC_ASSERT(offsetof(struct sync_file, mtime) == 44, sync_file_mtime);
RELAY_STATIC_ASSERT(offsetof(struct sync_file, kind) == 48, sync_file_kind);
RELAY_STATIC_ASSERT(offsetof(struct sync_file, hashed) == 49, sync_file_hashed);
RELAY_STATIC_ASSERT(offsetof(struct sync_file, _pad) == 50, sync_file__pad);
RELAY_STATIC_ASSERT(offsetof(struct sync_file, sha256) == 52, sync_file_sha256);

/* FROZEN. CMD_BEAMER_SYNC request payload, sent by a beamer on its relay link
 * (relay_auth + relay_hdr with version BEAMER_SYNC_VERSION + this) when no
 * mailbox request is pending: after each served file, when it finds a new
 * file, and every 30 s. The relay learns the beamer's address from the
 * connection and answers beamer_sync_resp.
 */
struct beamer_sync_req {
    uint8_t          station_id[SYNC_ID_LEN];  /* the beamer's StationId (from its MAC) */
    uint8_t          archive_id[SYNC_ID_LEN];  /* the archive its ack table belongs to (the last verified beamer_sync_resp.archive_id); all zero = none yet */
    uint8_t          nonce[SYNC_ID_LEN];  /* fresh random bytes for this sync; the reply's hmac covers them */
    uint32_t         fw_build;  /* as in beamer_hello */
    uint32_t         uptime_s;  /* seconds since this boot ("not unplugged since") */
    uint32_t         free_mb;  /* free space on the card in MiB, counted from the FAT (not FSInfo) */
    uint32_t         card_mb;  /* size of the replay partition in MiB */
    uint32_t         used_mb;  /* MiB held by Game_*.slp files; card_mb - free_mb - used_mb estimates clusters leaked by interrupted recordings */
    uint16_t         station;  /* the station number; valid with SF_STATION_SET */
    uint16_t         http_port;  /* the beamer's HTTP port, where the relay downloads files */
    uint16_t         on_card;  /* Game_*.slp files on the card, all kinds, saturating at 0xFFFF */
    uint16_t         to_collect;  /* files without an ack */
    uint16_t         to_erase;  /* files with an ack: erased at the next cold boot */
    uint16_t         empty;  /* 0-byte Game_*.slp entries (erased at the next cold boot without an ack) */
    uint16_t         incomplete;  /* files of kind SK_INCOMPLETE */
    uint16_t         acks;  /* ack records stored (at most 1024) */
    uint16_t         erased;  /* erase report of this boot (0 unless SF_COLD_BOOT): acked files deleted */
    uint16_t         erased_empty;  /* 0-byte entries deleted */
    uint16_t         erase_ms;  /* milliseconds the erase took (budget 4000) */
    uint16_t         erase_left;  /* acked files the budget left for the next cold boot */
    uint8_t          flags;  /* beamer_sync_flags bits */
    uint8_t          storage;  /* enum beamer_storage */
    uint8_t          last_result;  /* enum beamer_result of the last mailbox round trip */
    uint8_t          rssi;  /* Wi-Fi signal as -dBm (67 = -67 dBm); 0 = unknown */
    uint8_t          file_count;  /* sync_file entries following, at most SYNC_MAX_FILES */
    uint8_t          _pad[3];
    struct sync_file files[];
};  /* 100 bytes + variable tail */

RELAY_STATIC_ASSERT(sizeof(struct beamer_sync_req) == 100, beamer_sync_req_size);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, station_id) == 0, beamer_sync_req_station_id);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, archive_id) == 16, beamer_sync_req_archive_id);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, nonce) == 32, beamer_sync_req_nonce);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, fw_build) == 48, beamer_sync_req_fw_build);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, uptime_s) == 52, beamer_sync_req_uptime_s);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, free_mb) == 56, beamer_sync_req_free_mb);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, card_mb) == 60, beamer_sync_req_card_mb);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, used_mb) == 64, beamer_sync_req_used_mb);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, station) == 68, beamer_sync_req_station);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, http_port) == 70, beamer_sync_req_http_port);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, on_card) == 72, beamer_sync_req_on_card);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, to_collect) == 74, beamer_sync_req_to_collect);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, to_erase) == 76, beamer_sync_req_to_erase);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, empty) == 78, beamer_sync_req_empty);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, incomplete) == 80, beamer_sync_req_incomplete);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, acks) == 82, beamer_sync_req_acks);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, erased) == 84, beamer_sync_req_erased);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, erased_empty) == 86, beamer_sync_req_erased_empty);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, erase_ms) == 88, beamer_sync_req_erase_ms);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, erase_left) == 90, beamer_sync_req_erase_left);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, flags) == 92, beamer_sync_req_flags);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, storage) == 93, beamer_sync_req_storage);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, last_result) == 94, beamer_sync_req_last_result);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, rssi) == 95, beamer_sync_req_rssi);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, file_count) == 96, beamer_sync_req_file_count);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, _pad) == 97, beamer_sync_req__pad);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_req, files) == 100, beamer_sync_req_files);

/* FROZEN. The relay's answer about files[i] of the request, at answers[i]. */
struct sync_answer {
    uint8_t answer;  /* enum sync_answer_kind */
    uint8_t _pad[3];
    uint8_t sha256[SHA256_LEN];  /* with SA_HELD: the SHA-256 of the laptop's stored copy; zero otherwise */
};  /* 36 bytes */

RELAY_STATIC_ASSERT(sizeof(struct sync_answer) == 36, sync_answer_size);
RELAY_STATIC_ASSERT(offsetof(struct sync_answer, answer) == 0, sync_answer_answer);
RELAY_STATIC_ASSERT(offsetof(struct sync_answer, _pad) == 1, sync_answer__pad);
RELAY_STATIC_ASSERT(offsetof(struct sync_answer, sha256) == 4, sync_answer_sha256);

/* FROZEN. CMD_BEAMER_SYNC response payload after relay_resp (ST_OK only). hmac
 * = HMAC-SHA256 keyed with the secret's SECRET_LEN bytes exactly as relay_auth
 * carries them (NUL-padded), over the request's nonce (16 bytes), then the
 * request's station_id (16 bytes), then this payload from archive_id to its
 * end (20 + 36 * answer_count bytes). A beamer drops a reply whose hmac does
 * not verify, whose answer_count differs from its file_count, or whose
 * archive_id is all zero. A verified reply with another archive_id than the
 * ack table's drops every ack and adopts the new id before its answers are
 * applied.
 */
struct beamer_sync_resp {
    uint8_t            hmac[SHA256_LEN];
    uint8_t            archive_id[SYNC_ID_LEN];  /* the laptop's archive (archive.json in its archive folder); never all zero */
    uint8_t            answer_count;  /* equals the request's file_count */
    uint8_t            _pad[3];
    struct sync_answer answers[];
};  /* 52 bytes + variable tail */

RELAY_STATIC_ASSERT(sizeof(struct beamer_sync_resp) == 52, beamer_sync_resp_size);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_resp, hmac) == 0, beamer_sync_resp_hmac);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_resp, archive_id) == 32, beamer_sync_resp_archive_id);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_resp, answer_count) == 48, beamer_sync_resp_answer_count);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_resp, _pad) == 49, beamer_sync_resp__pad);
RELAY_STATIC_ASSERT(offsetof(struct beamer_sync_resp, answers) == 52, beamer_sync_resp_answers);

/* Message map: payload struct after relay_hdr (request) and after
 * relay_resp (ST_OK response).
 *
 *   CMD_LIST_SETS     req: -                  resp payload: list_sets_resp
 *   CMD_START_SET     req: start_set_req      resp payload: -
 *   CMD_REPORT_SCORE  req: report_score_req   resp payload: -
 *   CMD_END_SET       req: end_set_req        resp payload: -
 *   CMD_ABANDON_SET   req: abandon_set_req    resp payload: -
 *   CMD_BEAMER_SYNC   req: beamer_sync_req    resp payload: beamer_sync_resp
 */

#endif /* RELAY_PROTO_H */
