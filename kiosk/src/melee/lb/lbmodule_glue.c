/* Tournament module glue: what the kiosk TUs need from vanilla Melee that is
 * not an exported function. The module is linked against the VANILLA symbol
 * map (config/GALE01/symbols.txt), so file-static variables of the vanilla
 * build are reachable here as absolute symbols; this file declares them with
 * their real types and wraps the few reads/writes the kiosk makes.
 *
 * Only compiled into the module (tools/build_module.py), never into the DOL. */
#include <Runtime/platform.h>

#include <melee/gm/gm_1A3F.h>
#include <melee/gm/forward.h>
#include <melee/gm/types.h>
#include <melee/mn/forward.h>
#include <melee/lb/lbcrash.h>
#include <melee/mn/mncharsel.h>
#include <melee/lb/lbmodule_glue.h>
#include <melee/mn/types.h>
#include <melee/pl/forward.h>

/* mncharsel.c statics (vanilla addresses via symbols.txt: .sbss 0x804D6CB0,
 * 0x804D6CF2/F6/F7). */
extern CSSData* mnCharSel_804D6CB0;
extern u8 mnCharSel_804D6CF2; /* post-confirm lockout */
extern u8 mnCharSel_804D6CF6; /* CSSPendingSceneChangeKind: 1 = go fight */
extern u8 mnCharSel_804D6CF7; /* every present player is ready */

u8 mnCharSel_PortSlotType(int port)
{
    if (port < 0 || port >= 4 || mnCharSel_804D6CB0 == NULL) {
        return Gm_PKind_NA;
    }
    return mnCharSel_804D6CB0->vs.start.players[port].slot_type;
}

bool mnCharSel_TryStartFight(void)
{
    if (mnCharSel_804D6CF2 != 0 || mnCharSel_804D6CF7 == 0) {
        return false;
    }
    mnCharSel_804D6CF6 = 1;
    mnCharSel_804D6CF2 = 0xFF;
    return true;
}

/* Boot hook: the module's `bootOnLoad` replacement (gmboot.c), reached by a
 * branch patched over the vanilla function's first instruction. Skips the
 * opening movie and title screen, landing on GM_MENU, whose main-menu think
 * (mnTourney_MainMenuThink, installed by a table patch) auto-enters the set
 * list. */
struct tm_bootLoadData {
    u32 x0;
    u8 x4;
    u8 mode_id;
};

void tm_bootOnLoad(GameModeState* scene)
{
    struct tm_bootLoadData* d = gm_GetGameModeStateEnterData(scene);
    /* First module code to run: chain the crash recorder in front of Melee's
     * error handlers (installed by gmmain's db_SetupCrashHandler before any
     * scene), so a later crash reaches the relay's status page. */
    lbCrash_Install();
    d->x4 = 0;
    d->x0 = 0;
    d->mode_id = GM_MENU;
}

/* Boot scene exit (gm_Mode_Boot_States[0].on_leave, hooked by pointer).
 * Slippi Nintendont's core codeset (kernel/gecko/g_core.bin) carries the
 * well-known "boot to CSS" code, `04 801BFA20 38600002`: it turns vanilla
 * bootOnLeave's load of mode_id into `li r3, 2` (GM_VS), so on every Slippi
 * Wii the game ignored tm_bootOnLoad's GM_MENU and booted to the VS CSS
 * (first hardware run, 2026-09-30; Dolphin never applies g_core). The 04 code
 * is rewritten every frame by the codehandler, so the instruction itself
 * cannot be taken back. Instead: run the vanilla exit (Pikmin trophy, the
 * memcard game-mode override, its mode request), then request GM_MENU again -
 * gm_ChangeGameModeAfterCurrentScene only stores the pending mode, so the
 * last request wins. */
void bootOnLeave(GameModeState* scene);

void tm_bootOnLeave(GameModeState* scene)
{
    bootOnLeave(scene);
    gm_ChangeGameModeAfterCurrentScene(GM_MENU);
}

/* Menu light colour: mn_8022C010 (mnmain.c) maps the current menu kind to
 * one of five frame colours by a switch; the hijacked Trophies row maps to
 * 2 (green). The function is inlined into the light GObj's create and
 * per-frame lerp (their jump tables are patched directly, see
 * tools/module_hooks.txt); this replacement, branched over the out-of-line
 * copy's first instruction, covers the one remaining bl caller with the same
 * mapping, except that the Tournament menu takes the main menu's plain blue
 * (0). */
int tm_menuLightColor(int menu_kind, int selection)
{
    if (menu_kind == MENU_KIND_MAIN) {
        return selection;
    }
    switch (menu_kind) {
    case MENU_KIND_VS:
    case MENU_KIND_11:
    case MENU_KIND_SPECIAL:
    case MENU_KIND_RULES:
    case MENU_KIND_14:
    case MENU_KIND_RULES_EXTRA:
    case MENU_KIND_RULES_ITEMS:
    case MENU_KIND_RULES_STAGE:
    case MENU_KIND_NAME_ENTRY:
        return 1;
    case MENU_KIND_SETTINGS:
    case MENU_KIND_SETTINGS_RUMBLE:
    case MENU_KIND_SETTINGS_SOUND:
    case MENU_KIND_DISPLAY:
    case MENU_KIND_22:
    case MENU_KIND_SETTINGS_LANG:
    case MENU_KIND_SETTINGS_ERASE:
        return 3;
    case MENU_KIND_DATA:
    case MENU_KIND_DATA_SNAP:
    case MENU_KIND_DATA_ARCHIVES:
    case MENU_KIND_27:
    case MENU_KIND_RECORDS:
    case MENU_KIND_DATA_SPECIAL:
    case MENU_KIND_RECORDS_VS:
    case MENU_KIND_RECORDS_BONUS:
    case MENU_KIND_RECORDS_MISC:
        return 4;
    default: /* 1P, REG, EVENT, 8, STADIUM, 10, MULTI_VS - and TOY = ours */
        return 0;
    }
}
