/* Crash report for the kiosk (protocol.yaml
 * crash_report / crash_mailbox).
 *
 * Melee's own crash screen (db_SetupCrashHandler -> fn_OSErrorHandler, the
 * "UNHANDLED EXCEPTION" panel) needs a camera pointed at a CRT. This handler
 * sits in front of it: it records the exception, the faulting address, the
 * instruction words the PPC reads there, a few registers and the LR saves up
 * the stack into a shared-memory mailbox that the Nintendont kernel polls and
 * forwards to the relay (TM_CRASH), then chains to the previous handler so
 * the screen still appears. The mailbox is in Wii MEM2, which only exists
 * under Nintendont: the kernel pre-writes CRASH_MAGIC there at boot and the
 * handler writes nothing unless it sees it (Dolphin reads 0 and skips). */
#include "lbcrash.h"

#include <stdarg.h>
#include <string.h>

#include <dolphin/base/PPCArch.h>
#include <dolphin/os.h>
#include <dolphin/os/OSContext.h>
#include <dolphin/os/OSError.h>

#include <relay_proto.h>

#define MEM1_LO 0x80000000u
#define MEM1_HI 0x81800000u

static OSErrorHandler prev_handler[16];
static bool installed;
static u16 crash_count;

static volatile struct crash_mailbox* const mailbox =
    (volatile struct crash_mailbox*) CRASH_MAILBOX_PPC;

static bool readable(u32 a)
{
    return a >= MEM1_LO && a < MEM1_HI;
}

static void sync_io(void)
{
    PPCSync();
}

static void onError(OSError error, OSContext* ctx, ...)
{
    struct crash_report r;
    va_list ap;
    u32 dsisr, dar, sp;
    int i;

    va_start(ap, ctx);
    dsisr = va_arg(ap, u32);
    dar = va_arg(ap, u32);
    va_end(ap);

    if (mailbox->magic == CRASH_MAGIC) {
        memset(&r, 0, sizeof(r));
        r.error = (u8) error;
        r.count = ++crash_count;
        r.srr0 = ctx->srr0;
        r.srr1 = ctx->srr1;
        r.dsisr = dsisr;
        r.dar = dar;
        r.lr = ctx->lr;
        r.sp = ctx->gpr[1];
        r.r3 = ctx->gpr[3];
        r.r4 = ctx->gpr[4];
        if (readable(r.srr0) && readable(r.srr0 + 15)) {
            const u32* p = (const u32*) (r.srr0 & ~3u);
            for (i = 0; i < 4; i++) {
                r.fetched[i] = p[i];
            }
        }
        /* The walk Melee's screen prints: each frame's back chain and the LR
         * save beside it, stopping at an unreadable or non-ascending chain. */
        sp = r.sp;
        for (i = 0; i < CRASH_STACK_DEPTH; i++) {
            const u32* frame;
            u32 next;
            if (!readable(sp) || (sp & 3) != 0) {
                break;
            }
            frame = (const u32*) sp;
            next = frame[0];
            r.stack[i] = frame[1];
            if (!readable(next) || next <= sp) {
                break;
            }
            sp = next;
        }
        /* Report first, seq last: a reader that sees the new seq sees all of
         * it. Word by word, never memcpy: MSL's memcpy moves aligned blocks
         * with 64-bit float loads/stores, which the uncached MEM2 window does
         * not support - the first hardware report (2026-09-30) came through
         * with only the top byte of every word intact. */
        {
            volatile u32* dst = (volatile u32*) &mailbox->report;
            const u32* src = (const u32*) &r;
            for (i = 0; i < (int) (sizeof(r) / 4); i++) {
                dst[i] = src[i];
            }
        }
        sync_io();
        mailbox->seq = mailbox->seq + 1;
        sync_io();
    }

    if (prev_handler[error] != NULL) {
        prev_handler[error](error, ctx, dsisr, dar);
    }
}

void lbCrash_Install(void)
{
    static const u8 errors[] = { OS_ERROR_DSI, OS_ERROR_ISI, OS_ERROR_ALIGNMENT,
                                 OS_ERROR_PROGRAM };
    int i;
    if (installed) {
        return;
    }
    installed = true;
    for (i = 0; i < (int) (sizeof(errors) / sizeof(errors[0])); i++) {
        prev_handler[errors[i]] = OSSetErrorHandler(errors[i], onError);
    }
}
