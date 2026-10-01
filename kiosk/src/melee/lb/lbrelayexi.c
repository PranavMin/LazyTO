#include "lbrelayexi.h"

#include <string.h>

#include <dolphin/exi.h>
#include <dolphin/os.h>

/* Transaction shape follows HIORead/HIOWrite (libs/dolphin hio.c): lock ->
 * select -> 4-byte immediate command word -> data -> sync -> deselect ->
 * unlock. Requests go out via EXIImmEx (no alignment or length rule);
 * responses come back in one EXIDma read, which requires the 32-byte-aligned,
 * 32-multiple buffer below. Cache coherency is ours: DCInvalidateRange before
 * the DMA read (ReadSram pattern, OSRtc.c). */

struct lbRelayExi_Req {
    struct relay_hdr hdr;
    u8 payload[LB_RELAY_EXI_MAX_PAYLOAD];
};

RELAY_STATIC_ASSERT(sizeof(struct lbRelayExi_Req) ==
                        sizeof(struct relay_hdr) + LB_RELAY_EXI_MAX_PAYLOAD,
                    lb_req_size);
RELAY_STATIC_ASSERT(LB_RELAY_EXI_MAX_PAYLOAD >=
                        sizeof(struct report_score_req),
                    lb_req_fits_report_score);
RELAY_STATIC_ASSERT(LB_RELAY_EXI_MAX_PAYLOAD >= sizeof(struct end_set_req),
                    lb_req_fits_end_set);
RELAY_STATIC_ASSERT(LB_RELAY_EXI_MAX_PAYLOAD >= sizeof(struct start_set_req),
                    lb_req_fits_start_set);
RELAY_STATIC_ASSERT(LB_RELAY_EXI_MAX_PAYLOAD >=
                        sizeof(struct abandon_set_req),
                    lb_req_fits_abandon_set);
RELAY_STATIC_ASSERT((LB_RELAY_EXI_BUF_SIZE % 32) == 0, lb_resp_dma_multiple);

static struct lbRelayExi_Req req_buf;
static u8 resp_buf[LB_RELAY_EXI_BUF_SIZE] ATTRIBUTE_ALIGN(32);
static bool in_flight = false;

bool lbRelayExi_Request(u8 cmd, const void* payload, u16 len)
{
    int err;
    u32 cmd_word;

    if (in_flight || len > LB_RELAY_EXI_MAX_PAYLOAD ||
        (payload == NULL && len != 0))
    {
        return false;
    }

    req_buf.hdr.magic[0] = RELAY_MAGIC_0;
    req_buf.hdr.magic[1] = RELAY_MAGIC_1;
    req_buf.hdr.version = RELAY_PROTO_VERSION;
    req_buf.hdr.cmd = cmd;
    /* The game does not know the station; the Nintendont kernel / Dolphin
     * forwarder stamps station (and start_set_req.stream) from
     * tournament.cfg before the request reaches the relay. */
    req_buf.hdr.station = 0;
    req_buf.hdr.len = len;
    if (len != 0) {
        memcpy(req_buf.payload, payload, len);
    }

    if (!EXILock(LB_RELAY_EXI_CHAN, LB_RELAY_EXI_DEV, NULL)) {
        return false;
    }
    if (!EXISelect(LB_RELAY_EXI_CHAN, LB_RELAY_EXI_DEV, LB_RELAY_EXI_FREQ)) {
        EXIUnlock(LB_RELAY_EXI_CHAN);
        return false;
    }
    cmd_word = (u32) EXI_RELAY_REQ << 24;
    err = 0;
    err |= !EXIImm(LB_RELAY_EXI_CHAN, &cmd_word, 4, 1, NULL);
    err |= !EXISync(LB_RELAY_EXI_CHAN);
    err |= !EXIImmEx(LB_RELAY_EXI_CHAN, &req_buf,
                     sizeof(struct relay_hdr) + len, 1);
    err |= !EXIDeselect(LB_RELAY_EXI_CHAN);
    EXIUnlock(LB_RELAY_EXI_CHAN);

    if (err) {
        return false;
    }
    in_flight = true;
    return true;
}

/* One EXI_RELAY_POLL transaction: the 4 KB image lands in resp_buf. */
static bool readPollImage(void)
{
    int err;
    u32 cmd_word;

    DCInvalidateRange(resp_buf, sizeof(resp_buf));
    if (!EXILock(LB_RELAY_EXI_CHAN, LB_RELAY_EXI_DEV, NULL)) {
        return false;
    }
    if (!EXISelect(LB_RELAY_EXI_CHAN, LB_RELAY_EXI_DEV, LB_RELAY_EXI_FREQ)) {
        EXIUnlock(LB_RELAY_EXI_CHAN);
        return false;
    }
    cmd_word = (u32) EXI_RELAY_POLL << 24;
    err = 0;
    err |= !EXIImm(LB_RELAY_EXI_CHAN, &cmd_word, 4, 1, NULL);
    err |= !EXISync(LB_RELAY_EXI_CHAN);
    err |= !EXIDma(LB_RELAY_EXI_CHAN, resp_buf, sizeof(resp_buf), 0, NULL);
    err |= !EXISync(LB_RELAY_EXI_CHAN);
    err |= !EXIDeselect(LB_RELAY_EXI_CHAN);
    EXIUnlock(LB_RELAY_EXI_CHAN);
    return !err;
}

s32 lbRelayExi_Poll(void)
{
    s32 state;

    if (!in_flight) {
        return RELAY_IDLE;
    }
    if (!readPollImage()) {
        in_flight = false;
        return -1;
    }
    state = ((struct lbRelayExi_PollBuf*) resp_buf)->ph.state;
    if (state == RELAY_DONE || state == RELAY_ERROR) {
        in_flight = false;
    }
    return state;
}

bool lbRelayExi_Peek(struct exi_poll_hdr* out)
{
    if (in_flight || !readPollImage()) {
        return false;
    }
    *out = ((struct lbRelayExi_PollBuf*) resp_buf)->ph;
    return true;
}

const struct lbRelayExi_PollBuf* lbRelayExi_Response(void)
{
    return (const struct lbRelayExi_PollBuf*) resp_buf;
}

bool lbRelayExi_InFlight(void)
{
    return in_flight;
}

void lbRelayExi_Abort(void)
{
    in_flight = false;
}
