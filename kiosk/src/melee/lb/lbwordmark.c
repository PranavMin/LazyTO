#include "lbwordmark.h"

#include <dolphin/gx/GXEnum.h>
#include <dolphin/os.h>
#include <melee/lb/lbspdisplay.h>
#include <sysdolphin/baselib/gobj.h>
#include <sysdolphin/baselib/gobjplink.h>
#include <sysdolphin/baselib/tobj.h>

/* Texture: 256x48 GX IA8 (alpha byte, intensity byte per texel, 4x4 tiles),
 * 24 KB, 32-byte aligned as GX requires. White glyphs with a baked-in dark
 * drop shadow, so one draw with the helper's plain TEV (colour = texture,
 * alpha = texture alpha x sprite alpha) is the whole effect. */
#define WM_W 256
#define WM_H 48
static const u8 wm_tex[WM_W * WM_H * 2] ATTRIBUTE_ALIGN(32) = {
#include "lbwordmark_tex.inc"
};

/* lb_800138EC makes its sprite as GObj_Create(14, 15, 0): classifier 14 on
 * plink 15, which nothing else in the menu scene uses, so that is how the
 * sprite is found again (the helper's return value is not usable). */
#define WM_CLASS 14
#define WM_PLINK 15

static HSD_ImageDesc wm_img;
static bool wm_shown = false;

void lbWordmark_Show(f32 x, f32 y, f32 scale)
{
    if (wm_shown) {
        return;
    }
    wm_img.image_ptr = (void*) wm_tex;
    wm_img.width = WM_W;
    wm_img.height = WM_H;
    wm_img.format = GX_TF_IA8;
    wm_img.mipmap = 0;
    wm_img.minLOD = 0.0f;
    wm_img.maxLOD = 0.0f;
    /* The blob was written by the loader, not by this CPU, but GX reads main
     * memory: make sure no stale cache line shadows the texture. */
    DCFlushRange((void*) wm_tex, sizeof(wm_tex));
    /* render_func NULL = the helper's own one-quad draw. The sprite is a
     * camera GObj on the "max" GX link, which is the frame's camera pass
     * (gmscene.c HSD_GObj_80390FC0), run in ascending priority: the menu's
     * cameras come first and the kiosk text context's camera is 0x13
     * (mntourney.c), so 0x14 draws the wordmark after the text. The alpha
     * argument is INVERTED: the helper feeds it to the TEV as
     * (1 - alpha) * texture alpha (lbspdisplay.c setTevAlpha puts A0 in the
     * c input), so 0 = the texture's own alpha and 0xFF = invisible. */
    lb_800138EC(&wm_img, NULL, 0x14, 0, x, y, scale, scale);
    wm_shown = true;
}

void lbWordmark_Hide(void)
{
    HSD_GObj* g = plinklow_gobjs[WM_PLINK];
    while (g != NULL) {
        HSD_GObj* prev = g->prev;
        if (g->classifier == WM_CLASS) {
            HSD_GObjFree(g);
        }
        g = prev;
    }
    wm_shown = false;
}

void lbWordmark_Forget(void)
{
    wm_shown = false;
}
