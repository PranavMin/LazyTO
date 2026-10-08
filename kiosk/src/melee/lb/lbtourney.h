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
 * Every game carries the replay of the set's last match (record gate) when
 * that match was recorded and no earlier game took it. */

/* Called by mntourney when START_SET succeeds, with the poll header of that
 * reply. Copies the set and resets the game list; the header's host_build
 * says whether this host has the record gate (RECORD_GATE_HOST_BUILD). */
void lbTourney_SetCurrent(const struct set_entry* set,
                          const struct exi_poll_hdr* host);

/* No set is current: friendlies, and leaving the set list for the vanilla
 * main menu (a match from there is neither scored nor recorded). */
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

/* GS_VS on_enter (gmscdata row): the record gate. Around vanilla
 * gm_Scene_Vs_OnEnter, whose StartMelee sends Slippi's Game Start, it asks
 * the kernel to record the match when it is a game of the current set (not a
 * handwarmer) and the host has the gate; everything else is not recorded. */
void lbTourney_MatchEnter(void* arg);

/* GS_SUDDEN_DEATH on_exit (gmscdata row): vanilla gm_Scene_Vs_OnExit, then
 * auto-scores the tiebreak game the cards' Gameplay code plays after a tied
 * game (1 stock, 0%, 3:00), when that game was a set game that tied. */
void lbTourney_TiebreakExit(void* arg);

#endif
