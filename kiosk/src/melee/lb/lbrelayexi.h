#ifndef MELEE_LB_LBRELAYEXI_H
#define MELEE_LB_LBRELAYEXI_H

#include <Runtime/platform.h>

#include <relay_proto.h>

/* EXI request/poll helpers for the relay device (docs/architecture.md).
 * This is the game side; the LazyTO Nintendont kernel implements the device
 * side (and the Dolphin development setup emulates it). Those sides must
 * match the channel/device/frequency chosen here. */

/* Slot B, like Slippi's own device; the relay device shares it (the
 * EXI_RELAY_* command bytes sit clear of Slippi's EXI command space,
 * which extends to 0xE5). */
#define LB_RELAY_EXI_CHAN 1
#define LB_RELAY_EXI_DEV 0
#define LB_RELAY_EXI_FREQ 4 /* 16 MHz */

/* Response buffer size fixed by the design (4 KB, EXI-DMA sized). */
#define LB_RELAY_EXI_BUF_SIZE 4096

/* Largest request payload in the protocol (report_score_req/end_set_req). */
#define LB_RELAY_EXI_MAX_PAYLOAD 48 /* report_score_req / end_set_req, 8-byte game_result */

/* What one EXI_RELAY_POLL read returns: the host-filled exi_poll_hdr (state,
 * this station's number, the relay's address - protocol.yaml), then the
 * response message (valid only when ph.state == RELAY_DONE). */
struct lbRelayExi_PollBuf {
    struct exi_poll_hdr ph;
    struct relay_hdr hdr; /* echoes the request's cmd */
    struct relay_resp resp;
    u8 payload[LB_RELAY_EXI_BUF_SIZE - sizeof(struct exi_poll_hdr) -
               sizeof(struct relay_hdr) - sizeof(struct relay_resp)];
};

RELAY_STATIC_ASSERT(sizeof(struct lbRelayExi_PollBuf) == LB_RELAY_EXI_BUF_SIZE,
                    lb_poll_buf_size);
RELAY_STATIC_ASSERT(offsetof(struct lbRelayExi_PollBuf, hdr) == 12,
                    lb_poll_buf_hdr);
RELAY_STATIC_ASSERT(offsetof(struct lbRelayExi_PollBuf, resp) == 20,
                    lb_poll_buf_resp);
RELAY_STATIC_ASSERT(offsetof(struct lbRelayExi_PollBuf, payload) == 52,
                    lb_poll_buf_payload);

/* Start a request: writes header + payload to the device and marks it in
 * flight. One request in flight at a time; returns false (without touching
 * the bus) while one is. Also false on an EXI transport failure. payload may
 * be NULL when len is 0 (CMD_LIST_SETS). */
bool lbRelayExi_Request(u8 cmd, const void* payload, u16 len);

/* Poll the in-flight request. Returns the device state (enum exi_poll_state)
 * or -1 on an EXI transport failure. RELAY_DONE / RELAY_ERROR / -1 clear the
 * in-flight flag; any other value (including junk from an absent device)
 * means keep polling - the caller owns the timeout. Returns RELAY_IDLE
 * without touching the bus when nothing is in flight. */
s32 lbRelayExi_Poll(void);

/* The 4 KB response area the poll DMA lands in. Contents are stable until
 * the next lbRelayExi_Poll. */
const struct lbRelayExi_PollBuf* lbRelayExi_Response(void);

/* Read the poll image without a request in flight, for its exi_poll_hdr:
 * the host fills station and the relay address it has found (decisions.md R15:
 * the relay announces itself by UDP beacon; relay_ip stays 0 until one is
 * heard). False on an EXI failure, or while a request is in flight (use
 * lbRelayExi_Poll then). */
bool lbRelayExi_Peek(struct exi_poll_hdr* out);

/* Forget the in-flight request (caller-side timeout). The next poll after a
 * new request may still race a stale completion; callers check that
 * Response()->hdr.cmd echoes what they sent. */
void lbRelayExi_Abort(void);

#endif
