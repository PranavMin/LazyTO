#ifndef MELEE_LB_LBTOURNEY_H
#define MELEE_LB_LBTOURNEY_H

#include <Runtime/platform.h>

#include <relay_proto.h>

/* Tournament set state and the CSS score keybinds (design 6.1).
 *
 * Keybinds, active on the CSS only while a set is current (any port):
 *   Z + C-left        P1 wins a game (sends REPORT_SCORE)
 *   Z + C-right       P2 wins a game (sends REPORT_SCORE)
 *   Z + C-down        undo the last game (sends REPORT_SCORE)
 *   Z + C-up (1 s)    end the set (sends END_SET; needs a decided score)
 *   Z + X             flag/unflag the next game as a handwarmer (not scored;
 *                     clears itself after that game)
 *   D-pad up/down     rumble on/off for that port (venue mod, any time)
 *
 * The score is drawn along the bottom of the CSS as "MANGO P1  2 - 1  P3
 * ZAIN" (each entrant's port, known once the player named first has held
 * L + R; the kiosk does not touch Melee's nametags - seeding persistent
 * slots 0/1 at START_SET crashed the CSS Name Entry screen and was removed
 * 2026-09-30), with a status line
 * above it: SENDING... / SCORE SENT / SEND FAILED, else the next game
 * (GAME n or HANDWARMER). Inputs are ignored while a request is in flight.
 * Games carry winners only (R13). */

/* Called by mntourney when START_SET succeeds. Copies the set and resets
 * the game list. */
void lbTourney_SetCurrent(const struct set_entry* set);

void lbTourney_ClearCurrent(void);

/* GS_CSS scene hooks (gmscdata rows): run the tournament keybinds, polls
 * and overlay, then the vanilla mnCharSel handler. */
void lbTourney_CSSFrame(void);
void lbTourney_CSSExit(void* arg);
void lbTourney_SSSEnter(void* arg);

/* GS_VS scene hooks (gmscdata rows): draw the handwarmer overlay during a
 * flagged game, then the vanilla gm_Scene_Vs handler. */
void lbTourney_MatchFrame(void);
void lbTourney_MatchExit(void* arg);

#endif
