#include "lbtourney.h"

#include <stdio.h>
#include <string.h>

#include <dolphin/pad.h>
#include <melee/ft/forward.h>
#include <melee/gm/forward.h>
#include <melee/gm/gm_1601.h>
#include <melee/gm/gm_1A3F.h>
#include <melee/gm/gmmain_lib.h>
#include <melee/gm/gmscene.h>
#include <melee/gm/gmvs.h>
#include <melee/gm/gmvsmelee.h>
#include <melee/gm/types.h>
#include <melee/gr/forward.h>
#include <melee/if/iftime.h>
#include <melee/lb/lbbuttonglyph.h>
#include <melee/lb/lbrelayexi.h>
#include <melee/mn/mntourney.h>
#include <melee/mn/mncharsel.h>
#include <melee/lb/lbmodule_glue.h>
#include <melee/mn/mnstagesel.h>
#include <melee/mn/types.h>
#include <melee/pl/forward.h>
#include <melee/pl/player.h>
#include <sysdolphin/baselib/controller.h>
#include <sysdolphin/baselib/sislib.h>

#define LB_TOURNEY_TIMEOUT_FRAMES (5 * 60)
#define LB_TOURNEY_END_HOLD_FRAMES 60
#define LB_TOURNEY_SENT_FLASH_FRAMES 75 /* ~1.25 s of "SENT" after a report */
/* C-stick deflection past this (raw, full throw ~80) counts as a direction.
 * The C-stick, not the d-pad: it has no native CSS action and is reachable on
 * standard controllers and box controllers alike (d-pad is not). */
#define LB_TOURNEY_CSTICK_THRESH 56

enum lbTourney_CDir {
    CDIR_NONE = 0,
    CDIR_LEFT,
    CDIR_RIGHT,
    CDIR_UP,
    CDIR_DOWN,
};

static struct set_entry cur_set;
static bool has_set = false;
static struct game_result games[MAX_GAMES];
static u8 game_count;
static u8 pending_cmd; /* 0 = idle, else the relay_cmd in flight */
static bool last_failed;
static u32 timeout;
static u32 end_hold; /* consecutive frames Z + C-up has been held */
static int prev_cdir; /* last frame's aggregate C-stick direction, for edges */
static u32 sent_flash; /* frames left showing the "SENT" confirmation */

/* Score overlay, screen-space SIS canvas like the title-screen timestamp.
 * Recreated per CSS visit; the scene teardown frees the objects and
 * lbTourney_CSSExit forgets them. */
static s32 css_ctx = -1;
static HSD_Text* css_text = NULL;
static HSD_Text* css_shadow = NULL; /* drop shadows */
static bool css_dirty;
static u32 css_frames; /* CSS frames with a set: paces the SEND FAILED flip */

/* Handwarmer flag (2026-09-22): the next game is a warm-up that does
 * not count toward the score. Toggled on the CSS with Z + X (any port),
 * shown on the CSS overlay, drawn in-match as a count-up clock that turns red
 * past 1:00 (architecture.md), and cleared automatically once that game has
 * been played, so it can never linger into a real game. The C-stick score
 * binds are unaffected: they stay the one source of score truth. */
#define LB_TOURNEY_HANDWARMER_RED_FRAMES (60 * 60) /* 1:00 */
static bool handwarmer;

/* Port claim (2026-09-25). Tags are optional - a tag cut to four
 * characters can read badly - so the player named on the LEFT of the set
 * (entrant 1) can instead hold L + R for a second on their own controller;
 * the other human port is then entrant 2. Holding L + R + B clears it, and
 * the right player holding L + R again re-claims (the undo). A claim
 * overrides the tags and lasts for the set. Once both ports are known the
 * scoreboard shows the lower port on the left. */
#define LB_TOURNEY_CLAIM_HOLD_FRAMES 60
/* A trigger counts as held at its digital click OR from this raw analog
 * value (0-140 after the game's clamp, no deadzone subtraction: gmmain.c sets
 * clamp_analogLRMin 0 / Max 140): not every controller has a click, and a
 * light press must do (2026-09-25: a light R press read 50 on the
 * trigger readout). The friction is the two-trigger one-second hold, not the depth. */
#define LB_TOURNEY_CLAIM_PULL_RAW 49
static s8 claim_port = -1;   /* port that claimed entrant 1, or -1 */
static u8 claim_hold[4];     /* frames each port has held L + R */
/* Dev switch (docs/kiosk.md): 1 fakes an L + R claim by port 3 after 150
 * CSS frames and treats port 1 as human, for a Dolphin run with no
 * controller. build_module.py --demo sets it; the source keeps 0. */
#ifndef LB_TOURNEY_DEMO_CLAIM
#define LB_TOURNEY_DEMO_CLAIM 0
#endif
static void setAutoNote(const char* msg);
static int leftEntrant(void);
static bool hw_battlefield;   /* the next stage-select enter forces Battlefield */

/* Auto-score state (see autoScoreFromMatch below). */
static int auto_pending;      /* entrant (1/2) who won the game just played */
static bool auto_lgl;         /* the ledge-grab limit decided that game */
static bool tiebreak_armed;   /* that game tied: score LGL's tiebreak game */
static u8 auto_chars[2];      /* external CharacterKind of entrant 1 and 2 */
static u8 auto_stocks[2];     /* stocks left at the end, entrant 1 and 2 */
static u8 auto_costumes[2];   /* costume (colour) index, entrant 1 and 2 */
static u8 auto_stage;         /* internal StKind the game was played on */
static char auto_note[40];    /* why nothing was scored, or what was */
static u32 auto_note_frames;  /* frames left showing auto_note */

/* CMD_GAME_START (2026-10-01): sent on a match's first frame so the relay
 * can match the replay the station's beamer records and label who played
 * on which port. Fire and forget: polled during the match only to clear it,
 * never shown, and dropped if it is still in flight back on the CSS. */
static bool gs_flight;
static u32 gs_timeout;
static bool match_seen;   /* a GS_VS frame ran since the last CSS frame */
static u32 match_frames;  /* frames since the match scene began */
static s32 vs_ctx = -1;   /* in-match SIS overlay, per GS_VS visit */
static HSD_Text* vs_text = NULL;
static HSD_Text* vs_shadow = NULL;
static int vs_shown_sec = -1;

/* A port with a player behind it (slot HMN). A Dolphin run with no
 * controller leaves its slots N/A, so the LB_TOURNEY_DEMO_CLAIM build treats
 * port 1 as human. */
static bool portIsHuman(int port)
{
#if LB_TOURNEY_DEMO_CLAIM
    if (port == 0) {
        return true;
    }
#endif
    return mnCharSel_PortSlotType(port) == Gm_PKind_Human;
}

/* The CSS port playing as `entrant` (1 or 2): the L + R claim names
 * entrant 1's port and the other human port is entrant 2; -1 while nobody
 * has claimed. (Until 2026-09-30 picked nametags were the other source; the
 * kiosk no longer touches nametags, see lbtourney.h.) */
static int entrantPort(int entrant)
{
    int port;
    if (claim_port < 0) {
        return -1;
    }
    if (entrant == 1) {
        return claim_port;
    }
    for (port = 0; port < 4; port++) {
        if (port != claim_port && portIsHuman(port)) {
            return port;
        }
    }
    return -1;
}

void lbTourney_SetCurrent(const struct set_entry* set)
{
    cur_set = *set;
    memset(games, 0, sizeof(games));
    game_count = 0;
    pending_cmd = 0;
    last_failed = false;
    end_hold = 0;
    prev_cdir = CDIR_NONE;
    sent_flash = 0;
    handwarmer = false;
    match_seen = false;
    auto_pending = 0;
    tiebreak_armed = false;
    auto_note_frames = 0;
    claim_port = -1;
    memset(claim_hold, 0, sizeof(claim_hold));
    if (gs_flight) {
        lbRelayExi_Abort();
        gs_flight = false;
    }
    has_set = true;
    css_dirty = true;
}

void lbTourney_ClearCurrent(void)
{
    has_set = false;
    pending_cmd = 0;
    claim_port = -1;
    css_dirty = true;
}

static int winsFor(int slot)
{
    int i;
    int n = 0;
    for (i = 0; i < game_count; i++) {
        if (games[i].winner_slot == slot) {
            n++;
        }
    }
    return n;
}

/* v1 reports winners only; per-game character data is deferred to the v2
 * GAME_END hook (decisions.md R13). Reading characters from CSS port order was
 * unreliable: port order need not match entrant order, and a character may
 * not be locked in when the game is reported. So games carry no character. */

static void sendReport(void)
{
    struct report_score_req req;
    memset(&req, 0, sizeof(req));
    req.set_id = cur_set.set_id;
    req.game_count = game_count;
    memcpy(req.games, games, sizeof(req.games));
    if (lbRelayExi_Request(CMD_REPORT_SCORE, &req, sizeof(req))) {
        pending_cmd = CMD_REPORT_SCORE;
        timeout = 0;
        last_failed = false;
    } else {
        last_failed = true;
    }
    css_dirty = true;
}

static void sendEndSet(void)
{
    struct end_set_req req;
    memset(&req, 0, sizeof(req));
    req.set_id = cur_set.set_id;
    req.game_count = game_count;
    memcpy(req.games, games, sizeof(req.games));
    if (lbRelayExi_Request(CMD_END_SET, &req, sizeof(req))) {
        pending_cmd = CMD_END_SET;
        timeout = 0;
        last_failed = false;
    } else {
        last_failed = true;
    }
    css_dirty = true;
}

/* Appends a game. Characters are the entrants' external CharacterKind ids
 * (0 = Captain Falcon, so "unknown" is CHAR_UNKNOWN = 0xFF) and stage the
 * internal StKind (0 = unknown). A game scored by hand sends unknowns: the CSS
 * cannot tell which entrant sat where. The auto-score path fills them from
 * the match standings, where they are authoritative (decisions.md R13); the
 * relay omits anything it cannot map rather than rejecting the report. */
#define CHAR_UNKNOWN 0xFF
#define STOCKS_UNKNOWN 0xFF
#define COSTUME_UNKNOWN 0xFF
/* Stocks and costume per entrant (2026-09-30): the relay folds them into
 * start.gg's per-game score as (costume + 1) * 100 + stocks, the Replay
 * Reporter for Slippi convention, so the set page shows colour and stocks.
 * Unknown (hand-scored) games send 0xFF and get no score. */
static void appendGame(int winner_slot, u8 p1_char, u8 p2_char, u8 stage,
                       const u8* stocks, const u8* costumes)
{
    struct game_result* game;
    if (game_count >= MAX_GAMES) {
        return;
    }
    game = &games[game_count];
    game->winner_slot = winner_slot;
    game->p1_char = p1_char;
    game->p2_char = p2_char;
    game->stage = stage;
    game->p1_stocks = stocks ? stocks[0] : STOCKS_UNKNOWN;
    game->p2_stocks = stocks ? stocks[1] : STOCKS_UNKNOWN;
    game->p1_costume = costumes ? costumes[0] : COSTUME_UNKNOWN;
    game->p2_costume = costumes ? costumes[1] : COSTUME_UNKNOWN;
    game_count++;
    sendReport();
}

static void undoGame(void)
{
    if (game_count == 0) {
        return;
    }
    game_count--;
    memset(&games[game_count], 0, sizeof(games[game_count]));
    sendReport();
}

/* Cardinal C-stick direction for one pad, or CDIR_NONE when centred. The
 * dominant axis wins so diagonals resolve cleanly. subStickY is +up. */
static int cstickDir(const HSD_PadStatus* pad)
{
    s32 x = pad->subStickX;
    s32 y = pad->subStickY;
    s32 ax = x < 0 ? -x : x;
    s32 ay = y < 0 ? -y : y;

    if (ax < LB_TOURNEY_CSTICK_THRESH && ay < LB_TOURNEY_CSTICK_THRESH) {
        return CDIR_NONE;
    }
    if (ax >= ay) {
        return x < 0 ? CDIR_LEFT : CDIR_RIGHT;
    }
    return y > 0 ? CDIR_UP : CDIR_DOWN;
}

/* "CHARLIE IS P3" */
static void claimNote(int port)
{
    char tag[TAG_LEN + 1];
    char note[40];
    int i, n = 0;
    for (i = 0; i < TAG_LEN && cur_set.p1_tag[i] != '\0'; i++) {
        tag[i] = cur_set.p1_tag[i];
    }
    tag[i] = '\0';
    for (i = 0; tag[i] != '\0' && i < 12; i++) {
        note[n++] = tag[i];
    }
    memcpy(note + n, " IS P", 5);
    n += 5;
    note[n++] = (char) ('1' + port);
    note[n] = '\0';
    setAutoNote(note);
}

static void handleInputs(void)
{
    int port;
    int cdir = CDIR_NONE; /* first non-centred C-stick among Z-held ports */

    /* Port claim: L + R held a second by a human port names it entrant 1
     * (with B as well: clears the claim). Click or a deep pull, per trigger. */
    for (port = 0; port < 4; port++) {
        const HSD_PadStatus* pad = &HSD_PadCopyStatus[port];
        bool l = (pad->button & PAD_TRIGGER_L) != 0 ||
                 pad->analogL >= LB_TOURNEY_CLAIM_PULL_RAW;
        bool r = (pad->button & PAD_TRIGGER_R) != 0 ||
                 pad->analogR >= LB_TOURNEY_CLAIM_PULL_RAW;
        if (!l || !r) {
            claim_hold[port] = 0;
            continue;
        }
        if (claim_hold[port] < 255) {
            claim_hold[port]++;
        }
        if (claim_hold[port] == LB_TOURNEY_CLAIM_HOLD_FRAMES &&
            portIsHuman(port))
        {
            if (pad->button & PAD_BUTTON_B) {
                claim_port = -1;
                setAutoNote("PORTS CLEARED");
            } else {
                claim_port = (s8) port;
                claimNote(port);
            }
            css_dirty = true;
        }
    }

    /* Any controller may drive the set: all four ports are read, and any port
     * holding Z counts. (In Dolphin only port 1 is emulated by default.) */
    for (port = 0; port < 4; port++) {
        const HSD_PadStatus* pad = &HSD_PadCopyStatus[port];
        if (!(pad->button & PAD_TRIGGER_Z)) {
            continue;
        }
        if (pad->trigger & PAD_BUTTON_X) {
            /* Z + X: straight into a handwarmer (2026-09-22). When the
             * CSS is ready the fight starts now on Battlefield (user,
             * 2026-09-25; it was a random legal stage before), no stage
             * select: lbTourney_SSSEnter writes force_stage_id before the
             * vanilla stage-select enter runs, and the SSS skips itself on
             * its first frame. When the CSS is not ready (someone has not
             * picked) the press just arms/disarms the flag. */
            if (mnCharSel_TryStartFight()) {
                handwarmer = true;
                hw_battlefield = true;
            } else {
                handwarmer = !handwarmer;
            }
            css_dirty = true;
        }
        if (cdir == CDIR_NONE) {
            cdir = cstickDir(pad);
        }
    }

    /* End set = Z + C-up held ~1 s (sustained, not a flick). C-stick, not
     * Start: Start is Melee's native "advance to stage select" on the CSS. */
    if (cdir == CDIR_UP) {
        if (++end_hold == LB_TOURNEY_END_HOLD_FRAMES) {
            int need = cur_set.best_of / 2 + 1;
            /* END_SET needs a decided score; ignore the hold otherwise. */
            if (winsFor(1) >= need || winsFor(2) >= need) {
                sendEndSet();
            }
        }
        prev_cdir = cdir;
        return;
    }
    end_hold = 0;

    /* Score / undo fire once per flick: on the edge into a new direction. */
    if (cdir != prev_cdir) {
        if (cdir == CDIR_LEFT) {
            appendGame(leftEntrant(), CHAR_UNKNOWN, CHAR_UNKNOWN, 0, NULL, NULL);
        } else if (cdir == CDIR_RIGHT) {
            appendGame(3 - leftEntrant(), CHAR_UNKNOWN, CHAR_UNKNOWN, 0, NULL, NULL);
        } else if (cdir == CDIR_DOWN) {
            undoGame();
        }
    }
    prev_cdir = cdir;
}

static void pollRelay(void)
{
    const struct lbRelayExi_PollBuf* r;
    s32 state = lbRelayExi_Poll();

    if (state < 0 || state == RELAY_ERROR) {
        pending_cmd = 0;
        last_failed = true;
        css_dirty = true;
        return;
    }
    if (state != RELAY_DONE) {
        if (++timeout > LB_TOURNEY_TIMEOUT_FRAMES) {
            lbRelayExi_Abort();
            pending_cmd = 0;
            last_failed = true;
            css_dirty = true;
        }
        return;
    }
    r = lbRelayExi_Response();
    if (r->hdr.magic[0] == RELAY_MAGIC_0 && r->hdr.magic[1] == RELAY_MAGIC_1 &&
        r->hdr.cmd == pending_cmd && r->resp.status == ST_OK)
    {
        if (pending_cmd == CMD_END_SET) {
            /* Set reported and closed: leave the CSS back to the set list.
             * force_main_menu makes GM_MENU's onEnter land on our menu; the
             * transition pair is the one vanilla CSS-back uses. */
            has_set = false;
            gmMainLib_GetGameRules()->force_main_menu = 1;
            mnTourney_ArmAutoEnter();
            gm_ChangeGameModeAfterCurrentScene(GM_MENU);
            gm_801A4B60();
        } else if (pending_cmd == CMD_REPORT_SCORE) {
            sent_flash = LB_TOURNEY_SENT_FLASH_FRAMES;
        }
        last_failed = false;
    } else {
        last_failed = true;
    }
    pending_cmd = 0;
    css_dirty = true;
}

/* Which entrant is shown on the left: the lower port once both ports are
 * known (2026-09-25), entrant 1 until then. The scoreboard and the
 * C-stick binds (C-left = the left name) follow it. */
static int leftEntrant(void)
{
    int a = entrantPort(1);
    int b = entrantPort(2);
    return (a >= 0 && b >= 0 && b < a) ? 2 : 1;
}

/* Automatic scoring at game end (architecture.md, 2026-09-22). The
 * vanilla GS_VS exit fills the scene's MatchEnd (outcome, per-slot standings:
 * type, stocks, percent, and the game's own winners[] after the cards'
 * Gameplay code, LGL, has ruled on a time-out), so lbTourney_MatchExit reads it
 * after the vanilla handler and reports the winner the game decided; the game
 * is appended and sent on the first CSS frame back (where the relay is
 * polled), unless the game was a handwarmer. A game that tied is not
 * appended: LGL's tiebreak game follows in the Sudden Death scene, and
 * lbTourney_TiebreakExit scores that one instead (2026-10-07), so the set
 * gets one game for the two. The C-stick binds stay for corrections (undo /
 * re-score). The Sudden Death scene's exit data
 * (gmVsMelee_SuddenDeathExitInfo) has the same MatchExitInfo layout. */
struct lbTourney_EndMelee { /* mirrors gmvs.c EndMeleeData */
    u32 x0, x4, x8;
    struct MatchEnd me;
};
#define LB_TOURNEY_AUTO_NOTE_FRAMES (5 * 60)

static void setAutoNote(const char* msg)
{
    int i;
    for (i = 0; i < (int) sizeof(auto_note) - 1 && msg[i] != '\0'; i++) {
        auto_note[i] = msg[i];
    }
    auto_note[i] = '\0';
    auto_note_frames = LB_TOURNEY_AUTO_NOTE_FRAMES;
}

static void autoScoreFromMatch(const struct MatchEnd* me)
{
    int slots[GM_MAX_PLAYERS];
    u8 who[2];
    int n = 0;
    int others = 0;
    int i;
    int w;

    auto_pending = 0;
    auto_lgl = false;
    if (me->outcome == OUTCOME_NO_CONTEST) {
        setAutoNote("NO CONTEST - NOT SCORED");
        return;
    }
    /* Team battle decides by team standings, which the Gameplay code never
     * touches, so winners[] need not be the team the results screen names. */
    if (me->is_teams) {
        setAutoNote("TEAMS ON - SCORE BY HAND");
        return;
    }
    if (me->outcome != OUTCOME_TIMEOUT && me->outcome != OUTCOME_ELIMINATION) {
        return;
    }
    /* Exactly two players in the game, both human: a CPU counts in the game's
     * winners[] and in the Gameplay code's leaders. */
    for (i = 0; i < GM_MAX_PLAYERS; i++) {
        if (me->player_standings[i].pkind == Gm_PKind_Human) {
            if (n < GM_MAX_PLAYERS) {
                slots[n] = i;
            }
            n++;
        } else if (me->player_standings[i].pkind != Gm_PKind_NA) {
            others++;
        }
    }
    if (n != 2 || others != 0) {
        setAutoNote("AUTO-SCORE NEEDS 2 PLAYERS");
        return;
    }
    /* Who is who: the L + R claim names entrant 1's port, and it has to be
     * one of the two that played. */
    if (claim_port < 0 || (slots[0] == claim_port) == (slots[1] == claim_port)) {
        setAutoNote("HOLD L+R TO AUTO-SCORE");
        return;
    }
    who[0] = slots[0] == claim_port ? 1 : 2;
    who[1] = slots[1] == claim_port ? 1 : 2;
    /* Per-game character and stage (R13): the standings' ckind is the CSS
     * ckind (external id) and the stage is still in the start rules here. */
    auto_chars[who[0] - 1] = (u8) me->player_standings[slots[0]].ckind;
    auto_chars[who[1] - 1] = (u8) me->player_standings[slots[1]].ckind;
    auto_stocks[who[0] - 1] = me->player_standings[slots[0]].stocks;
    auto_stocks[who[1] - 1] = me->player_standings[slots[1]].stocks;
    /* The costume is not in the standings. It comes from the fighter data the
     * game spawned with (pl's player_slots, reset only by the next match's
     * Player_InitAllPlayers), so it is still right here at GS_VS exit. NOT
     * from gm_GetStartMeleeRules(): that is the bare 0x60-byte rules at the
     * end of VsSceneController, nothing follows it - a StartMeleeData cast
     * read past the controller into zeroed .bss and reported every costume
     * as 0 on the first Wii set (2026-09-30). */
    auto_costumes[who[0] - 1] = (u8) Player_GetCostumeId(slots[0]);
    auto_costumes[who[1] - 1] = (u8) Player_GetCostumeId(slots[1]);
    auto_stage = (u8) gm_GetStartMeleeRules()->stkind;
    /* The game's own winner, never recomputed here. The cards run Gameplay:
     * Both (LGL and anti-wobbling). On a time-out LGL takes the player ahead
     * on stocks, then lower percent; if that player is over the ledge-grab
     * limit (more than 45 grabs at 8:00) and the other is not, the other
     * wins; both over with one ahead, nobody wins. So the results screen,
     * the replay and start.gg all name the same player. */
    {
        const struct MatchPlayerData* a = &me->player_standings[slots[0]];
        const struct MatchPlayerData* b = &me->player_standings[slots[1]];
        const struct MatchPlayerData* wp;
        const struct MatchPlayerData* lp;
        if (me->n_winners == 0) {
            /* Only LGL leaves no winner: both over the limit, one ahead. */
            setAutoNote("BOTH OVER LGL - SCORE BY HAND");
            return;
        }
        if (me->n_winners > 1) {
            /* In a 1v1, LGL never leaves a time-out tied on stocks with
             * different percent, so that card has Gameplay off, and vanilla
             * Sudden Death follows: scored by hand. Otherwise an exact tie or
             * a double KO on the last stocks: LGL's tiebreak game follows,
             * and lbTourney_TiebreakExit scores it (vanilla goes there exactly
             * when gm_MatchHasMultipleWinners). Nothing is appended for this
             * game either way. */
            if (me->outcome == OUTCOME_TIMEOUT && a->stocks == b->stocks &&
                a->percent != b->percent)
            {
                setAutoNote("LGL OFF - SCORE BY HAND");
            } else {
                setAutoNote("TIE - SCORE IT MANUALLY");
                tiebreak_armed = gm_MatchHasMultipleWinners((MatchEnd*) me);
            }
            return;
        }
        if (me->winners[0] != slots[0] && me->winners[0] != slots[1]) {
            setAutoNote("AUTO-SCORE NEEDS 2 PLAYERS");
            return;
        }
        w = me->winners[0] == slots[0] ? 0 : 1;
        wp = w == 0 ? a : b;
        lp = w == 0 ? b : a;
        /* A stock-mode time-out won from behind on stocks, then percent: the
         * limit decided it. Such a game sends no stocks (0xFF, so the relay
         * sends no per-game score): the loser would show more stock icons
         * than the winner. Characters, stage and costumes still go. */
        auto_lgl = me->outcome == OUTCOME_TIMEOUT &&
                   me->match_kind == MatchKind_Stock &&
                   !(wp->stocks > lp->stocks ||
                     (wp->stocks == lp->stocks && wp->percent < lp->percent));
        if (auto_lgl) {
            auto_stocks[0] = STOCKS_UNKNOWN;
            auto_stocks[1] = STOCKS_UNKNOWN;
        }
    }
    auto_pending = who[w];
}

/* The set list's look (mntourney.c): translucent navy panels with a light
 * rim and a 2 px drop shadow under every line. Glyph alpha is per HSD_Text,
 * so the panel fill, the shadows and the opaque text are three objects. */
static const GXColor ov_white = { 255, 255, 255, 255 };
static const GXColor ov_black = { 0, 0, 0, 255 };
static const GXColor ov_grn = { 94, 224, 138, 255 };
static const GXColor ov_red = { 255, 106, 92, 255 };
static const GXColor ov_amb = { 255, 179, 71, 255 };
static const GXColor ov_yel = { 255, 228, 92, 255 };
/* The CSS's own P1..P4 hand colours, for the port labels in the banner. */
static const GXColor ov_port[4] = {
    { 255, 80, 80, 255 }, { 90, 140, 255, 255 }, { 255, 210, 70, 255 }, { 80, 220, 120, 255 }
};
#define OV_SHADOW_DX 2.0f

static HSD_Text* newText(s32 ctx, u8 alpha)
{
    HSD_Text* t = HSD_SisLib_803A6754(lbButton_Font(), ctx);
    t->default_kerning = 1;
    t->text_color.a = alpha;
    return t;
}

static void freeText(HSD_Text** t)
{
    if (*t != NULL) {
        HSD_SisLib_803A5CC4(*t);
        *t = NULL;
    }
}

/* A text that is kept across redraws and emptied in place: its buffer stays
 * at its largest size, so a redraw allocates nothing from the scene's SIS
 * pool, whose allocator never merges freed blocks (mntourney.c redraw). */
static void reuseText(HSD_Text** t, s32 ctx, u8 alpha)
{
    if (*t == NULL) {
        *t = newText(ctx, alpha);
    } else {
        HSD_SisLib_803A7664(*t);
    }
}

/* A line with its shadow; fmt may carry #A-style icons. */
static void ovLine(HSD_Text* shadow, HSD_Text* text, f32 x, f32 y, f32 s,
                   const GXColor* c, const char* fmt)
{
    lbButton_LineMono(shadow, x + OV_SHADOW_DX, y + OV_SHADOW_DX, s, &ov_black,
                      fmt);
    lbButton_LineC(text, x, y, s, c, fmt);
}

/* The CSS's own rules banner ("4-man survival test!") shows the score
 * instead (2026-09-25). The banner is an HSD_Text the CSS binds to
 * premade string slot 0x4A of font 0 (mncharsel.c, SdSlChr's SIS data:
 * pos -12/-23.3, box 450x32, centred, shrink-to-fit) and the renderer walks
 * that slot's bytes every frame. So the slot, and every text bound to it,
 * are pointed at a buffer of ours: the vanilla leading opcodes are kept, the
 * score is encoded behind them with the game's own ASCII-to-SIS encoder, and
 * the box, position, centring and fitting stay exactly vanilla. The CSS
 * reloads its archive on every visit, so the takeover repeats per visit. */
#define BANNER_FONT 0
#define BANNER_SLOT 0x4A
static u8 banner_buf[256];
static int banner_prefix;     /* vanilla opcode bytes kept in front */
static const u8* banner_orig; /* the archive's slot buffer this visit */

/* Byte length of a SIS opcode (HSD_SisLib_803A6478's copy rule). */
static int sisOpLen(u8 op)
{
    switch (op) {
    case 6:
    case 7:
    case 8:
    case 9:
    case 10:
    case 14:
        return 5;
    case 12:
        return 4;
    case 5:
        return 3;
    default:
        return 1;
    }
}

/* Banner content is built in segments so runs can be coloured with the SIS
 * colour opcode (0C r g b ... 0D, hsd_3A76.c case 12/13): bannerBegin takes
 * the slot over (once per CSS visit, keeping the vanilla leading opcodes),
 * bannerText appends plain glyph codes (0x2000 + atlas index: the game's
 * encoder was avoided because its fixed-width digit run crushes letters
 * and isolates '-'), bannerEnd terminates and re-binds the banner text. */
static u8* banner_cur;

static void bannerBegin(void)
{
    u8** table = (u8**) HSD_SisLib_804D1124[BANNER_FONT];
    banner_cur = NULL;
    if (table == NULL) {
        return;
    }
    if (table[BANNER_SLOT] != banner_buf) {
        const u8* p = table[BANNER_SLOT];
        u8* dst = banner_buf;
        while (*p != 0 && *p < 0x20 && dst - banner_buf < 64) {
            int n = sisOpLen(*p);
            memcpy(dst, p, n);
            dst += n;
            p += n;
        }
        banner_prefix = (int) (dst - banner_buf);
        banner_orig = table[BANNER_SLOT];
        table[BANNER_SLOT] = banner_buf;
    }
    banner_cur = banner_buf + banner_prefix;
}

static bool bannerRoom(int n)
{
    return banner_cur != NULL &&
           banner_cur + n < banner_buf + sizeof(banner_buf) - 1;
}

static void bannerText(const char* ascii)
{
    for (; *ascii != '\0' && bannerRoom(2); ascii++) {
        int g = lbButton_GlyphCode(*ascii);
        if (g >= 0) {
            *banner_cur++ = (u8) (g >> 8);
            *banner_cur++ = (u8) g;
        }
    }
}

static void bannerColor(const GXColor* c)
{
    if (bannerRoom(4)) {
        *banner_cur++ = 0x0C;
        *banner_cur++ = c->r;
        *banner_cur++ = c->g;
        *banner_cur++ = c->b;
    }
}

static void bannerPop(void)
{
    if (bannerRoom(1)) {
        *banner_cur++ = 0x0D;
    }
}

/* A tag cut to 12 characters ('-' tail), so the vanilla shrink-to-fit never
 * takes the digits down with two long names. */
static void bannerName(const char* tag)
{
    char buf[13];
    int i;
    for (i = 0; i < 12 && tag[i] != '\0'; i++) {
        buf[i] = tag[i];
    }
    if (i == 12 && tag[12] != '\0') {
        buf[11] = '-';
    }
    buf[i] = '\0';
    bannerText(buf);
}

/* " P3" after the left name / "P3 " before the right one, in the port's
 * hand colour; nothing while the entrant's port is unknown. */
static void bannerPort(int port, bool before_name)
{
    static const char* const labels[4] = { "P1", "P2", "P3", "P4" };
    if (port < 0 || port > 3) {
        return;
    }
    if (!before_name) {
        bannerText(" ");
    }
    bannerColor(&ov_port[port]);
    bannerText(labels[port]);
    bannerPop();
    if (before_name) {
        bannerText(" ");
    }
}

static void bannerEnd(void)
{
    HSD_Text* t;
    if (banner_cur == NULL) {
        return;
    }
    *banner_cur = 0;
    for (t = HSD_SisLib_804D7978; t != NULL; t = t->next) {
        if (t->font_idx == BANNER_FONT &&
            ((const u8*) t->sis_buffer == banner_orig ||
             (u8*) t->sis_buffer == banner_buf))
        {
            HSD_SisLib_803A6368(t, BANNER_SLOT);
        }
    }
}

static void redraw(void)
{
    char p1[TAG_LEN + 1];
    char p2[TAG_LEN + 1];

    if (!has_set) {
        freeText(&css_text);
        freeText(&css_shadow);
        return;
    }
    memcpy(p1, cur_set.p1_tag, TAG_LEN);
    p1[TAG_LEN] = '\0';
    memcpy(p2, cur_set.p2_tag, TAG_LEN);
    p2[TAG_LEN] = '\0';

    reuseText(&css_shadow, css_ctx, 190);
    reuseText(&css_text, css_ctx, 255);

    /* Handwarmer hint at the top-left corner (2026-09-25; it sat
     * top-right beside BACK before). */
    {
        const char* fmt = handwarmer ? "#Z+#X CANCELS" : "#Z+#X WARMUP";
        ovLine(css_shadow, css_text, 10.0f, -8.0f, 0.50f,
               handwarmer ? &ov_amb : &ov_white, fmt);
    }

    /* The CSS's own rules banner carries the score and the status: score
     * "NAME P1   0 - 0   P3 NAME" (entrant 1 left, digits yellow, amber
     * while a report is in flight, green just after one landed, red after a
     * failure), or a timed message: the auto-score note, HANDWARMER - NOT
     * SCORED while the flag is armed, and SEND FAILED - TELL THE TO
     * alternating with the red score every two seconds. */
    bannerBegin();
    if (handwarmer) {
        bannerColor(&ov_amb);
        bannerText("HANDWARMER - NOT SCORED");
        bannerPop();
    } else if (auto_note_frames > 0) {
        bannerColor(&ov_amb);
        bannerText(auto_note);
        bannerPop();
    } else if (last_failed && ((css_frames / 120) & 1) != 0) {
        bannerColor(&ov_red);
        bannerText("SEND FAILED - TELL THE TO");
        bannerPop();
    } else if ((entrantPort(1) < 0 || entrantPort(2) < 0) &&
               ((css_frames / 120) & 1) != 0)
    {
        /* Nobody is placed yet: every other two seconds the banner says how
         * (the L + R hold by the player named first). */
        bannerColor(&ov_amb);
        bannerText("HOLD L+R IF YOU ARE ");
        bannerName(p1);
        bannerPop();
    } else {
        char num[16];
        int le = leftEntrant();
        int re = 3 - le;
        const GXColor* digits = pending_cmd != 0 ? &ov_amb
                                : last_failed    ? &ov_red
                                : sent_flash > 0 ? &ov_grn
                                                 : &ov_yel;
        bannerName(le == 1 ? p1 : p2);
        bannerPort(entrantPort(le), false);
        bannerText("   ");
        sprintf(num, "%d - %d", winsFor(le), winsFor(re));
        bannerColor(digits);
        bannerText(num);
        bannerPop();
        bannerText("   ");
        bannerPort(entrantPort(re), true);
        bannerName(re == 1 ? p1 : p2);
    }
    bannerEnd();
}

/* In-match handwarmer clock: "HANDWARMER 0:42" in the top-left corner (the
 * HUD timer owns top-centre), counting up from the scene start, red once it
 * passes 1:00. Redrawn once a second. */
static void redrawMatch(void)
{
    static const GXColor red = { 255, 64, 64, 255 };
    int sec = match_frames / 60;
    char line[32];

    reuseText(&vs_shadow, vs_ctx, 190);
    reuseText(&vs_text, vs_ctx, 255);
    sprintf(line, "HANDWARMER %d:%02d", sec / 60, sec % 60);
    ovLine(vs_shadow, vs_text, 34.0f, 24.0f, 0.6f,
           match_frames >= LB_TOURNEY_HANDWARMER_RED_FRAMES ? &red : &ov_white,
           line);
    vs_shown_sec = sec;
}

/* GS_SSS on_enter (scene table hook). gm_80167FC4 has already filled
 * force_stage_id from the rules (-1 = choose on the SSS); a Z + X start
 * overrides it here so the SSS hands the match to Battlefield on its first
 * frame, the same skip path it takes for a Random pick. */
void lbTourney_SSSEnter(void* arg)
{
    if (hw_battlefield) {
        ((SSSData*) arg)->force_stage_id = St_Kind_Battle;
        hw_battlefield = false;
    }
    mnStageSel_Scene_OnEnter(arg);
}

/* CMD_GAME_START on the match's first frame: the players, characters and
 * costumes are spawned and the stage is in the start rules by now. */
static void sendGameStart(void)
{
    struct game_start_req req;
    int port;
    int e1 = entrantPort(1);
    int e2 = entrantPort(2);
    memset(&req, 0, sizeof(req));
    req.set_id = cur_set.set_id;
    req.game = (u8) (game_count + 1);
    req.handwarmer = handwarmer ? 1 : 0;
    req.stage = (u8) gm_GetStartMeleeRules()->stkind;
    req.e1_port = e1 >= 0 ? (u8) e1 : NO_PORT;
    req.e2_port = e2 >= 0 ? (u8) e2 : NO_PORT;
    for (port = 0; port < 4; port++) {
        if (Player_GetPlayerSlotType(port) == Gm_PKind_Human) {
            req.chars[port] = (u8) Player_GetPlayerCharacter(port);
            req.costumes[port] = (u8) Player_GetCostumeId(port);
        } else {
            req.chars[port] = NO_PORT;
            req.costumes[port] = NO_PORT;
        }
    }
    if (pending_cmd == 0 &&
        lbRelayExi_Request(CMD_GAME_START, &req, sizeof(req)))
    {
        gs_flight = true;
        gs_timeout = 0;
    }
}

static void pollGameStart(void)
{
    s32 state = lbRelayExi_Poll();
    if (state < 0 || state == RELAY_DONE || state == RELAY_ERROR ||
        ++gs_timeout > LB_TOURNEY_TIMEOUT_FRAMES)
    {
        lbRelayExi_Abort();
        gs_flight = false;
    }
}

void lbTourney_MatchFrame(void)
{
    hw_battlefield = false; /* consumed by the SSS enter; never carry it over */
    if (has_set) {
        if (!match_seen) {
            match_seen = true;
            match_frames = 0;
            sendGameStart();
        } else {
            match_frames++;
            if (gs_flight) {
                pollGameStart();
            }
        }
        if (handwarmer) {
            if (vs_ctx < 0) {
                vs_ctx = HSD_SisLib_803A611C(lbButton_Font(), NULL, 9, 0xD,
                                             0, 0xE, 0, 0x13);
                lbButton_InstallFont();
                vs_shown_sec = -1;
            }
            if ((int) (match_frames / 60) != vs_shown_sec) {
                redrawMatch();
            }
        }
    }
    gm_Scene_Vs_OnFrame();
    if (has_set && handwarmer) {
        /* One clock only: the HUD's countdown is hidden for a handwarmer
         * (2026-09-22). Done after the vanilla frame and re-asserted
         * every frame because the HUD shows its timers again on its own
         * (gmvs.c:1135, ifall.c:51 - pause/HUD toggles); the flag is
         * idempotent and the timer itself keeps running underneath. */
        ifTime_HideTimers();
    }
}

void lbTourney_MatchExit(void* arg)
{
    /* The scene teardown frees the canvas and text GObjs; just forget them. */
    vs_ctx = -1;
    vs_text = NULL;
    vs_shadow = NULL;
    vs_shown_sec = -1;
    /* Vanilla first: it fills the exit data's MatchEnd (outcome, standings). */
    gm_Scene_Vs_OnExit(arg);
    if (has_set && !handwarmer && arg != NULL) {
        autoScoreFromMatch(&((struct lbTourney_EndMelee*) arg)->me);
    }
}

/* LGL's tiebreak game (2026-10-07). After a set game the game left with two
 * winners (an exact tie, or a double KO on the last stocks), vanilla plays
 * GS_SUDDEN_DEATH, which the cards' Gameplay code turns into 1 stock each at
 * 0% for 3:00 (its own time-out goes through LGL with a limit of 17). That
 * scene has its own scene-table row; its exit is the same vanilla
 * gm_Scene_Vs_OnExit, filling gmVsMelee_SuddenDeathExitInfo, so the tiebreak
 * is scored like any game and stands for the tied game, which appended
 * nothing. A tiebreak that ties again is not replayed (vanilla goes to the
 * results screen): its TIE note asks for hand scoring. */
void lbTourney_TiebreakExit(void* arg)
{
    bool armed = tiebreak_armed;
    tiebreak_armed = false;
    gm_Scene_Vs_OnExit(arg);
    if (armed && has_set && !handwarmer && arg != NULL) {
        autoScoreFromMatch(&((struct lbTourney_EndMelee*) arg)->me);
        tiebreak_armed = false;
    }
}

void lbTourney_CSSFrame(void)
{
    /* Kiosk: every CSS visit comes from our menu (a tournament set or
     * friendlies), so any B-back returns to the set list, not the VS menu.
     * Keep force_main_menu set so when vanilla's B-back leaves the CSS,
     * GM_MENU's onEnter lands on our Tournament menu. */
    gmMainLib_GetGameRules()->force_main_menu = 1;
    mnTourney_ArmAutoEnter();
    /* A tiebreak follows its tied game directly; the CSS ends that chance. */
    tiebreak_armed = false;
    /* Venue mods (UCF, neutral spawns, striking, stealth nametag, the D-pad
     * rumble toggle, audio) are Nintendont's / Dolphin's gecko codes on the
     * vanilla DOL; the module adds nothing there. */
    if (has_set) {
        if (css_ctx < 0) {
            css_ctx = HSD_SisLib_803A611C(lbButton_Font(), NULL, 9, 0xD, 0,
                                          0xE, 0, 0x13);
            lbButton_InstallFont();
            css_dirty = true;
        }
        if (match_seen) {
            /* Back from a game: a handwarmer flag covered exactly that game;
             * a decided game is scored now (sends REPORT_SCORE). */
            match_seen = false;
            handwarmer = false;
            css_dirty = true;
            if (gs_flight) {
                /* A game shorter than the round trip: the score report
                 * below needs the device. */
                lbRelayExi_Abort();
                gs_flight = false;
            }
            if (auto_pending != 0) {
                char note[40];
                char tag[TAG_LEN + 1];
                int i;
                const char* src =
                    auto_pending == 1 ? cur_set.p1_tag : cur_set.p2_tag;
                appendGame(auto_pending, auto_chars[0], auto_chars[1],
                           auto_stage, auto_stocks, auto_costumes);
                memcpy(tag, src, TAG_LEN);
                tag[TAG_LEN] = '\0';
                /* "GAME 3 TO MANGO", "GAME 3 TO MANGO - LGL" */
                memcpy(note, "GAME ", 5);
                note[5] = (char) ('0' + game_count);
                memcpy(note + 6, " TO ", 4);
                for (i = 0; tag[i] != '\0' && i < TAG_LEN; i++) {
                    note[10 + i] = tag[i];
                }
                if (auto_lgl) {
                    memcpy(note + 10 + i, " - LGL", 7);
                } else {
                    note[10 + i] = '\0';
                }
                setAutoNote(note);
                auto_pending = 0;
            }
        }
        if (auto_note_frames > 0 && --auto_note_frames == 0) {
            css_dirty = true;
        }
        css_frames++;
        if ((last_failed || entrantPort(1) < 0 || entrantPort(2) < 0) &&
            css_frames % 120 == 0)
        {
            css_dirty = true; /* the banner flips between score and message */
        }
#if LB_TOURNEY_DEMO_CLAIM
        if (css_frames == 150 && claim_port < 0) {
            claim_port = 2;
            claimNote(2);
            css_dirty = true;
        }
#endif
        if (pending_cmd != 0) {
            /* Ignore inputs while a request is in flight. */
            end_hold = 0;
            pollRelay();
        } else {
            handleInputs();
        }
        if (sent_flash > 0) {
            sent_flash--;
            css_dirty = true; /* keep "SCORE SENT" up, then clear it */
        }
        if (css_dirty) {
            css_dirty = false;
            redraw();
        }
    }
    mnCharSel_Scene_OnFrame();
}

void lbTourney_CSSExit(void* arg)
{
    /* The scene teardown frees the canvas and text GObjs; just forget
     * them. */
    css_ctx = -1;
    css_text = NULL;
    css_shadow = NULL;
    mnCharSel_Scene_OnExit(arg);
}
