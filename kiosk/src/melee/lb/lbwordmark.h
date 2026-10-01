#ifndef MELEE_LB_LBWORDMARK_H
#define MELEE_LB_LBWORDMARK_H

#include <Runtime/platform.h>

/* The kiosk's "TOURNAMENT" wordmark: a 256x48 IA8 texture carried in the
 * module (lbwordmark_tex.inc, tools/gen_wordmark.py) and drawn as a
 * screen-space sprite by the vanilla sprite helper lb_800138EC - its own
 * ortho camera GObj on the last GX link, so it lands on top of the SIS text.
 * One instance at a time. Hide frees the sprite (B-back to the main menu
 * inside the same scene); Forget just drops the state after a scene teardown
 * has freed every GObj. */
void lbWordmark_Show(f32 x, f32 y, f32 scale);
void lbWordmark_Hide(void);
void lbWordmark_Forget(void);

#endif
