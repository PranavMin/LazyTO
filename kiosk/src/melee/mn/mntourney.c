#include "mntourney.h"

#include <Runtime/platform.h>

#include <string.h>

#include <melee/mn/forward.h>
#include <melee/mn/inlines.h>
#include <melee/mn/types.h>
#include <dolphin/os.h>
#include <dolphin/pad.h>
#include <melee/gm/forward.h>
#include <melee/gm/gm_1601.h>
#include <melee/gm/gm_1A36.h>
#include <melee/gm/gmmain_lib.h>
#include <melee/lb/lbbuttonglyph.h>
#include <melee/lb/lbrelayexi.h>
#include <melee/lb/lbtourney.h>
#include <melee/lb/lbwordmark.h>
#include <melee/mn/mnmain.h>
#include <sysdolphin/baselib/gobj.h>
#include <sysdolphin/baselib/gobjplink.h>
#include <sysdolphin/baselib/gobjproc.h>
#include <sysdolphin/baselib/jobj.h>
#include <sysdolphin/baselib/sislib.h>

u16 mnTourney_DescIndices[1] = { 0 };

/* Which menu-kind row hosts the Tournament menu. The vanilla menu table
 * cannot grow, so the module takes over MENU_KIND_TOY ("Trophies": its code
 * region is where the module lives, so that menu must never run anyway) - the
 * loader patches that row's description_indices / selection_count / think
 * (tools/module_hooks.txt). */
#define TM_MENU_KIND MENU_KIND_TOY

/* Menu flow (design 6.1):
 *
 *   [Searching]   no relay known yet: the host learns the relay's address
 *                 from its UDP beacon (decisions.md R15), at most a couple of
 *                 seconds; the first request waits for it
 *   [Loading]     LIST_SETS in flight
 *   Set list      up/down moves, left/right pages, L/R first-letter tag
 *                 filter, X jumps to the set this station is playing, Y
 *                 refreshes (cursor kept on the same set), A confirms, Z
 *                 friendlies, B back to the main menu
 *   Confirm       the list dims, the side pane asks; A sends START_SET
 *   Error         A retries the failed request, B goes back
 *
 * Screen (design of 2026-09-25): the vanilla main-menu
 * panel frames everything. Its left two thirds hold the set list - rows are
 * the two tags on a fixed VS axis, grouped under round-name headers - and
 * its preview box on the right is the detail pane for the highlighted set
 * (round, tags, best-of, state, the primary action). Confirm, loading and
 * error all happen in that same frame instead of swapping screens.
 *
 * The relay device answers within the kernel's 3 s budget; the menu polls
 * once per frame and gives up after 5 s (an absent device reads junk poll
 * states forever, which lands here too). */

enum mnTourney_State {
    TM_OFF, /* menu not active */
    TM_SEARCHING,
    TM_LOADING,
    TM_LIST,
    TM_CONFIRM,
    TM_STARTING,
    TM_ERROR
};

#define TM_TIMEOUT_FRAMES (5 * 60)
#define TM_SEARCH_FRAMES (10 * 60) /* beacons come every 2 s */
/* How long to wait for the host's Wi-Fi join (PF_NET_JOINING) before calling
 * it a failure. The kernel brings the network up on its own thread since
 * Nintendont host build 2 (a stuck join used to hang the whole boot); a join
 * normally takes 5-15 s, one that is still going after a minute never ends. */
#define TM_JOIN_FRAMES (60 * 60)
/* Largest row count that fits the 4 KB poll buffer alongside the headers. */
#define TM_MAX_SETS                                                          \
    ((int) ((sizeof(((struct lbRelayExi_PollBuf*) 0)->payload) -             \
             sizeof(struct list_sets_resp)) /                                \
            sizeof(struct set_entry)))

/* ---- layout, 640x480 screen px (the SIS canvas is 1:1 with the screen) ----
 * Text sizes are SIS scales: cap height = 26 * scale px, so 0.70 = 18 px
 * (the composite-TV floor for anything that matters), 0.50 = 13 px. A glyph
 * of scale s is drawn 32*(1-s) px below its entry's y and every scale shares
 * the line's bottom, so different scales on one y are baseline-aligned. */
/* The TOURNAMENT wordmark (lbwordmark.c, a 256x48 sprite) sits in the
 * panel's own title spot, the top-left tab. */
#define L_WM_X 76.0f
#define L_WM_Y 34.0f
#define L_WM_S 1.0f
#define L_HEAD_Y 80.0f /* filter pill + position: 10 px above the panel rim */
#define L_HEAD_S 0.55f
#define L_LIST_X 58.0f /* scrim and cursor bar */
#define L_LIST_W 326.0f
#define L_LIST_Y 120.0f
#define L_LIST_H 276.0f
#define L_LIST_CX 221.0f
#define L_SLOT_Y 120.0f /* first row/header slot */
#define L_SLOT_H 30.0f
#define L_SLOTS 8
#define L_TEXT_X 70.0f /* headers, filter, error text */
#define L_TAG_L_R 200.0f /* left tag right-aligned here */
#define L_TAG_W 140.0f
#define L_AXIS_X 208.0f /* "VS" */
#define L_TAG_R_X 242.0f
#define L_ROW_S 0.70f
#define L_ROW_MIN_S 0.58f
#define L_HDR_S 0.58f /* round headers: content, one step over the floor */
#define L_VS_S 0.55f
#define L_ACTION_S 0.70f /* the pane's primary action */
#define L_PANE_TAG_S 0.80f /* hero tags in the pane */
#define L_BAR_DY 6.0f /* cursor bar: slot y + 6, 28 tall (row ink is 11..29) */
#define L_BAR_H 28.0f
#define L_MORE_Y 358.0f /* inside the panel, 6 px above its bottom rim */
/* The detail pane sits where the vanilla panel's preview box is (x 395..587);
 * at the frame we hold (10) the box outline itself is not drawn, so the
 * pane gets a scrim of its own, level with the list's. */
#define L_PANE_X 410.0f
#define L_PANE_W 165.0f
#define L_PANE_BOX_X 396.0f
#define L_PANE_BOX_Y 120.0f
#define L_PANE_BOX_W 190.0f
#define L_PANE_BOX_H 276.0f
#define L_HINT_CX 320.0f /* between the panel's two bottom corner boxes */
#define L_HINT_Y 400.0f
#define L_HINT_S 0.50f
#define L_BAR_A 80    /* alpha of the cursor bar */
#define L_PULSE_FRAMES 20

/* The two panes get their contrast over the animated grid from rounded
 * translucent navy panels with a thin light-blue rim and a light fill, plus
 * a drop shadow under every text line (chosen 2026-09-25 among five trial
 * looks). */
/* Dev flag (docs/kiosk.md): with 1 the list auto-confirms and starts its
 * first set two seconds after it is up, so the CSS overlay can be captured
 * in a Dolphin run that has no controller; with 2 it only opens the confirm
 * pane. Must be 0 in a shipped build; sync-card.ps1 refuses otherwise. */
#ifndef TM_DEMO_AUTOSTART
#define TM_DEMO_AUTOSTART 0
#endif
#define L_PANEL_R 12.0f  /* corner radius of the rounded panels */
#define L_SHADOW_DX 2.0f
#define L_SHADOW_A 190

static const GXColor c_white = { 255, 255, 255, 255 };
static const GXColor c_dim = { 169, 188, 230, 255 };  /* secondary */
static const GXColor c_dim2 = { 126, 145, 191, 255 }; /* headers, cues */
static const GXColor c_yel = { 255, 228, 92, 255 };   /* Melee cursor yellow */
static const GXColor c_amb = { 255, 179, 71, 255 };   /* playing here */
static const GXColor c_red = { 255, 106, 92, 255 };
static const GXColor c_grn = { 94, 224, 138, 255 };
static const GXColor c_muted = { 96, 110, 150, 255 }; /* list behind a confirm */
static const GXColor c_scrim = { 18, 28, 72, 255 };  /* translucent navy */
static const GXColor c_rim = { 110, 150, 255, 255 };
static const GXColor c_black = { 0, 0, 0, 255 };
static const GXColor c_tint = { 48, 42, 18, 255 };    /* pane behind a confirm */
static const GXColor c_bar = { 40, 62, 140, 255 }; /* renders far brighter than its alpha suggests; yellow on it must keep 3:1 luma */
static const GXColor c_pill5 = { 90, 82, 184, 255 };  /* Z purple */
static const GXColor c_pill3 = { 110, 112, 125, 255 };

static u8 tm_state = TM_OFF;
static struct set_entry tm_sets[MAX_SETS];
static u16 tm_count;
static u16 tm_sel;    /* cursor, an index into the filtered view */
static u16 tm_top;    /* first visible slot (headers count as slots) */
static u16 tm_chosen; /* tm_sets index picked on the confirm screen */
static char tm_filter; /* 0 = all sets, else 'A'..'Z' */
static u32 tm_timeout;
static u16 tm_join_frames; /* frames spent on JOINING THE WI-FI this search */
static u8 tm_retry_cmd; /* relay_cmd the error screen's A retries */
static char tm_errmsg[MSG_LEN + 1];
static bool tm_err_link; /* the error is ours/transport, not the relay's answer */
static u8 tm_err_status; /* relay_status of the relay's answer when !tm_err_link */
static bool tm_dirty;
static u32 tm_keep_id; /* set_id to put the cursor back on after a reload */
static struct exi_poll_hdr tm_ph; /* station / relay address, host-filled */
static u32 tm_frame;
/* Filtered view and its display slots, rebuilt every frame (<= 56 sets). */
static u8 tm_view[MAX_SETS];
static int tm_nview;
struct tm_slot {
    u8 is_header;
    u8 view_idx;
};
static struct tm_slot tm_slots[2 * MAX_SETS];
static int tm_nslots;
/* When the main-menu think should drop straight into the set list: armed at
 * boot (static init) and whenever the CSS routes back here (END_SET, CSS-B).
 * A manual B-back from the list leaves it clear, so the main menu stays up. */
static bool tm_auto_enter = true;

/* Frames the main menu must run (rendering, so its textures become resident)
 * before an armed auto-enter fires. cooldown==0 alone proved too early on a
 * cold boot -- it still tore the menu down mid-texture-load and crashed in
 * __GXSetSUTexRegs (v9). A manual Z-enter, which happens seconds later, has
 * always been safe; this warm-up reproduces that safe timing. Reset whenever
 * auto-enter is re-armed (a CSS return re-initialises the menu scene). */
#define TM_BOOT_WARMUP_FRAMES 45
static int tm_boot_frames = 0;

/* Venue audio defaults (mono + music-off) are asserted once, the first time the
 * set list is up: a stable, fully-rendered menu frame (so no GX-transition
 * crash), AFTER the memcard save-load (so it isn't overwritten), and before any
 * match. sound_balance = 100 puts the SOUNDS<->MUSIC slider at all-sounds (music
 * off); OSSetSoundMode(0) forces mono. */
static bool tm_audio_set = false;

/* Kiosk: hide/show the main menu's visuals. Its background (class 4, plink 5,
 * MenMainBack_Top) and panel (class 5, plink 6, MenMainPanel_Top; the cursor
 * joints are its children) are fire-and-forget GObjs made by the matched
 * mnMain_Scene_OnEnter, whose returns are discarded - so they are found by
 * walking their plinks (plinklow_gobjs is the low-priority end; prev walks the
 * whole list) and matched by classifier. Only the root JObj's render flag
 * changes: the scene, camera and every proc keep running, so the boot warm-up
 * still does its job. Hidden for the warm-up only (no main-menu flash); shown
 * again the moment the set list comes up (its border frames the list) and on
 * B-back. */
static void setPlinkClassHidden(u8 link, u16 classifier, bool hide)
{
    HSD_GObj* g;
    for (g = plinklow_gobjs[link]; g != NULL; g = g->prev) {
        if (g->classifier != classifier || g->hsd_obj == NULL) {
            continue;
        }
        if (hide) {
            HSD_JObjSetFlagsAll((HSD_JObj*) g->hsd_obj, JOBJ_HIDDEN);
        } else {
            HSD_JObjClearFlagsAll((HSD_JObj*) g->hsd_obj, JOBJ_HIDDEN);
        }
    }
}

static void setMenuVisualsHidden(bool hide)
{
    /* Panel + cursor only. The backdrop (class 4, plink 5, MenMainBack_Top)
     * stays visible from frame 0: it is not the "main menu flash" (that is
     * the options panel), and the set list looks barren without it (user,
     * 2026-09-22). */
    setPlinkClassHidden(6, 5, hide);
}

/* SIS overlay, screen-space like the title screen's build timestamp.
 * Recreated per GS_MENU visit; the scene teardown frees the objects and
 * mnTourney_MenuSceneExit forgets them. Three text objects because glyph
 * alpha is per text (texture alpha x text_color.a, hsd_3A76.c:897): the
 * scrim and the cursor bar are translucent stretched block glyphs, drawn
 * first (creation order is draw order), everything else is opaque. */
static s32 tm_ctx = -1;
static HSD_Text* tm_scrim = NULL;
static HSD_Text* tm_shadow = NULL; /* drop shadows */
static HSD_Text* tm_bar = NULL;
static HSD_Text* tm_text = NULL;

/* Copies up to n chars of a NUL-padded wire string, replacing what the SIS
 * encoder cannot draw (it would swallow the next character) with a space. */
static void copyStr(char* dst, const char* src, int n)
{
    int i;
    for (i = 0; i < n && src[i] != '\0'; i++) {
        char c = src[i];
        dst[i] = (c != '#' && lbButton_Drawable(c)) ? c : ' ';
    }
    dst[i] = '\0';
}

static char* putStr(char* p, const char* s)
{
    while (*s != '\0') {
        *p++ = *s++;
    }
    *p = '\0';
    return p;
}

static char* putInt(char* p, int v)
{
    char tmp[12];
    int n = 0;
    if (v < 0) {
        *p++ = '-';
        v = -v;
    }
    do {
        tmp[n++] = (char) ('0' + v % 10);
        v /= 10;
    } while (v != 0);
    while (n > 0) {
        *p++ = tmp[--n];
    }
    *p = '\0';
    return p;
}

static char upperFirst(const char* tag)
{
    char c = tag[0];
    if (c >= 'a' && c <= 'z') {
        c -= 'a' - 'A';
    }
    return c;
}

static bool setMatchesFilter(const struct set_entry* set)
{
    if (tm_filter == 0) {
        return true;
    }
    return upperFirst(set->p1_tag) == tm_filter ||
           upperFirst(set->p2_tag) == tm_filter;
}

/* Rows group by state first (the set this station is playing is floated to
 * the top by the relay and gets a PLAYING HERE header, not a second copy of
 * its round's header), then by round name. */
static bool sameGroup(const struct set_entry* a, const struct set_entry* b)
{
    int i;
    if ((a->state != 0) != (b->state != 0)) {
        return false;
    }
    for (i = 0; i < ROUND_LEN; i++) {
        if (a->round[i] != b->round[i]) {
            return false;
        }
        if (a->round[i] == '\0') {
            break;
        }
    }
    return true;
}

/* The filtered view (tm_sets indices) and its slots: every run of equal
 * round names gets a header slot in front of it. */
static void buildView(void)
{
    int i;
    tm_nview = 0;
    tm_nslots = 0;
    for (i = 0; i < tm_count; i++) {
        int v;
        if (!setMatchesFilter(&tm_sets[i])) {
            continue;
        }
        v = tm_nview++;
        tm_view[v] = (u8) i;
        if (v == 0 || !sameGroup(&tm_sets[tm_view[v - 1]], &tm_sets[i])) {
            tm_slots[tm_nslots].is_header = 1;
            tm_slots[tm_nslots].view_idx = (u8) v;
            tm_nslots++;
        }
        tm_slots[tm_nslots].is_header = 0;
        tm_slots[tm_nslots].view_idx = (u8) v;
        tm_nslots++;
    }
    if (tm_sel >= tm_nview) {
        tm_sel = tm_nview > 0 ? tm_nview - 1 : 0;
    }
}

static int slotOf(int view_idx)
{
    int k;
    for (k = 0; k < tm_nslots; k++) {
        if (!tm_slots[k].is_header && tm_slots[k].view_idx == view_idx) {
            return k;
        }
    }
    return 0;
}

/* Scrolls so the cursor's slot is on screen; moving up onto the first row
 * of a group brings its header along. Never leaves blank slots below. */
static void ensureVisible(void)
{
    int s = slotOf(tm_sel);
    int maxtop = tm_nslots - L_SLOTS;
    if (maxtop < 0) {
        maxtop = 0;
    }
    if (s < tm_top) {
        tm_top = (s > 0 && tm_slots[s - 1].is_header) ? s - 1 : s;
    } else if (s >= tm_top + L_SLOTS) {
        tm_top = s - L_SLOTS + 1;
    }
    if (tm_top > maxtop) {
        tm_top = maxtop;
    }
    if (s < tm_top) {
        tm_top = s;
    }
}

/* Steps tm_filter through ALL plus each letter some tag starts with. */
static void stepFilter(int dir)
{
    char letters[27];
    bool seen[26];
    int i, n, cur;

    memset(seen, 0, sizeof(seen));
    for (i = 0; i < tm_count; i++) {
        char a = upperFirst(tm_sets[i].p1_tag);
        char b = upperFirst(tm_sets[i].p2_tag);
        if (a >= 'A' && a <= 'Z') {
            seen[a - 'A'] = true;
        }
        if (b >= 'A' && b <= 'Z') {
            seen[b - 'A'] = true;
        }
    }
    letters[0] = 0; /* ALL */
    n = 1;
    for (i = 0; i < 26; i++) {
        if (seen[i]) {
            letters[n++] = 'A' + i;
        }
    }
    cur = 0;
    for (i = 0; i < n; i++) {
        if (letters[i] == tm_filter) {
            cur = i;
        }
    }
    cur = (cur + dir + n) % n;
    tm_filter = letters[cur];
    tm_sel = 0;
    tm_top = 0;
    buildView();
}

/* Puts the cursor on set_id if the view has it, else on the first row. */
static void selectSet(u32 set_id)
{
    int v;
    tm_sel = 0;
    for (v = 0; v < tm_nview; v++) {
        if (tm_sets[tm_view[v]].set_id == set_id) {
            tm_sel = (u16) v;
            break;
        }
    }
    tm_top = 0;
    ensureVisible();
}

/* The relay refused us over the shared secret (relay_status ST_BAD_SECRET,
 * decisions.md R15): tournament.cfg's secret= does not match the relay's. */
static bool errIsSecret(void)
{
    return !tm_err_link && tm_err_status == ST_BAD_SECRET;
}

/* ------------------------------------------------------------ drawing */

static void destroyText(void)
{
    if (tm_text != NULL) {
        HSD_SisLib_803A5CC4(tm_text);
        tm_text = NULL;
    }
    if (tm_bar != NULL) {
        HSD_SisLib_803A5CC4(tm_bar);
        tm_bar = NULL;
    }
    if (tm_shadow != NULL) {
        HSD_SisLib_803A5CC4(tm_shadow);
        tm_shadow = NULL;
    }
    if (tm_scrim != NULL) {
        HSD_SisLib_803A5CC4(tm_scrim);
        tm_scrim = NULL;
    }
}

static HSD_Text* newText(u8 alpha)
{
    HSD_Text* t = HSD_SisLib_803A6754(lbButton_Font(), tm_ctx);
    t->default_kerning = 1;
    t->text_color.a = alpha;
    return t;
}

/* Every string goes through the icon walker so the punctuation the SIS
 * encoder cannot map ( / + ( ) ! ? ) is translated; wire strings are
 * copyStr'd first, which also drops '#', so no tag can start an icon. */
static void lineC(f32 x, f32 y, f32 scale, const GXColor* c, const char* str)
{
    if (tm_shadow != NULL) {
        lbButton_LineMono(tm_shadow, x + L_SHADOW_DX, y + L_SHADOW_DX, scale,
                          &c_black, str);
    }
    lbButton_LineC(tm_text, x, y, scale, c, str);
}

/* A pane background: a rounded panel built from three blocks and four
 * quarter discs that never overlap (overlaps would double the alpha), with
 * an opaque rim drawn by the main text on top. */
static void paneBox(f32 x, f32 y, f32 w, f32 h, GXColor c, bool rim)
{
    lbButton_Panel(tm_scrim, rim ? tm_text : NULL, x, y, w, h, L_PANEL_R, c,
                   c_rim);
}

static f32 width(f32 scale, const char* str)
{
    return lbButton_Measure(scale, str);
}

static void rightAt(f32 rx, f32 y, f32 scale, const GXColor* c, const char* str)
{
    lineC(rx - width(scale, str), y, scale, c, str);
}

/* A line centred on cx, measured exactly from the font's kerning table; fmt
 * may carry #A/#B/... button icons (lbbuttonglyph.h). */
static void centredAt(f32 cx, f32 y, f32 scale, const GXColor* c,
                      const char* fmt)
{
    f32 w = lbButton_Measure(scale, fmt);
    lineC(cx - 0.5f * w, y, scale, c, fmt);
}

/* Shrinks buf's scale from s0 (not below s_min) until it fits w, then cuts
 * it with a '-' tail if it still does not. Returns the scale to draw at. */
static f32 fitText(char* buf, f32 s0, f32 s_min, f32 w)
{
    f32 s = s0;
    f32 tw = width(s, buf);
    int n;
    if (tw > w) {
        s = s0 * w / tw;
        if (s < s_min) {
            s = s_min;
        }
    }
    while ((n = (int) strlen(buf)) > 1 && width(s, buf) > w) {
        buf[n - 1] = '\0';
        buf[n - 2] = '-';
    }
    return s;
}

/* Two tags share one scale (the wider one decides), then each is cut to
 * its column if the floor scale still overflows. */
static f32 pairScale(char* p1, char* p2, f32 w)
{
    f32 w1 = width(L_ROW_S, p1);
    f32 w2 = width(L_ROW_S, p2);
    f32 wm = w1 > w2 ? w1 : w2;
    f32 s = L_ROW_S;
    if (wm > w) {
        s = L_ROW_S * w / wm;
        if (s < L_ROW_MIN_S) {
            s = L_ROW_MIN_S;
        }
    }
    fitText(p1, s, s, w);
    fitText(p2, s, s, w);
    return s;
}

/* str on up to two lines of width w at scale s0: one line if it fits, or
 * fits shrunk to s_one (so "WINNERS ROUND 1" does not orphan its "1");
 * else broken at the last space that fits, and a line that still overflows
 * (one long word) is shrunk. Returns the number of lines drawn. */
static int wrap2(f32 x, f32 y, f32 dy, f32 s0, f32 s_one, f32 w,
                 const GXColor* c, const char* str)
{
    char a[MSG_LEN + 1];
    char b[MSG_LEN + 1];
    int n = (int) strlen(str);
    int cut = -1;
    int i, k;
    int lines = 0;

    b[0] = '\0';
    if (width(s0, str) <= w) {
        memcpy(a, str, n + 1);
    } else if (width(s_one, str) <= w) {
        memcpy(a, str, n + 1);
        s0 = s0 * w / width(s0, str);
    } else {
        for (i = 1; i < n; i++) {
            if (str[i] == ' ') {
                memcpy(a, str, i);
                a[i] = '\0';
                if (width(s0, a) <= w) {
                    cut = i;
                }
            }
        }
        if (cut < 0) {
            memcpy(a, str, n + 1);
        } else {
            memcpy(a, str, cut);
            a[cut] = '\0';
            memcpy(b, str + cut + 1, n - cut);
        }
    }
    for (k = 0; k < 2; k++) {
        const char* ln = k == 0 ? a : b;
        f32 s = s0;
        f32 tw;
        if (ln[0] == '\0') {
            break;
        }
        tw = width(s, ln);
        if (tw > w) {
            s = s0 * w / tw;
            if (s < 0.36f) {
                s = 0.36f;
            }
        }
        lineC(x, y + k * dy, s, c, ln);
        lines++;
    }
    return lines;
}

/* A small disc in front of a label at text scale s (dot centred on the
 * label's ink line: shape centre y+16S-17s, see lbbuttonglyph.c drawIcon). */
static void dotLabel(f32 x, f32 y, f32 s, const GXColor* c, const char* label)
{
    f32 t = 0.56f * s;
    f32 yy = y + 16.0f * t - 17.0f * s;
    x += lbButton_Shape(tm_text, x, yy, t, LB_SHAPE_DISC, *c) + 4.0f;
    lineC(x, y, s, c, label);
}

/* Three dots, the bright one walking every L_PULSE_FRAMES frames. */
static void pulse(f32 cx, f32 y, f32 s)
{
    f32 adv = lbButton_ShapeAdvance(0.5f * s, LB_SHAPE_DISC) + 6.0f;
    f32 x = cx - 1.5f * adv;
    int on = (int) ((tm_frame / L_PULSE_FRAMES) % 3);
    int i;
    for (i = 0; i < 3; i++) {
        f32 t = 0.5f * s;
        f32 yy = y + 16.0f * t - 17.0f * s;
        lbButton_Shape(tm_text, x, yy, t, LB_SHAPE_DISC, i == on ? c_white : c_dim2);
        x += adv;
    }
}

static void drawRow(f32 y, const struct set_entry* set, bool selected,
                    bool muted)
{
    char p1[TAG_LEN + 1];
    char p2[TAG_LEN + 1];
    const GXColor* c;
    const GXColor* vs;
    f32 s;

    copyStr(p1, set->p1_tag, TAG_LEN);
    copyStr(p2, set->p2_tag, TAG_LEN);
    s = pairScale(p1, p2, L_TAG_W);
    c = muted ? &c_muted : selected ? &c_yel : set->state != 0 ? &c_amb : &c_white;
    vs = muted ? &c_muted : selected ? &c_white : &c_dim;
    if (selected) {
        /* Bar inside the panel's rim; the yellow edge 7 px in, so it does
         * not read as part of the rim. */
        f32 in = 3.0f;
        lbButton_Box(tm_bar, L_LIST_X + in, y + L_BAR_DY, L_LIST_W - 2 * in,
                     L_BAR_H, c_bar);
        lbButton_Box(tm_text, L_LIST_X + 7.0f, y + L_BAR_DY, 4.0f, L_BAR_H,
                     muted ? c_muted : c_yel);
    }
    rightAt(L_TAG_L_R, y, s, c, p1);
    lineC(L_AXIS_X, y, L_VS_S, vs, "VS");
    lineC(L_TAG_R_X, y, s, c, p2);
}

/* Filter pill on the left, position on the right, scroll-up cue. */
/* Version text, top-right at the header row: the module's git hash and build
 * date (lbmodule_version.inc, written by tools/build_module.py), then the
 * host's build when it reports one (exi_poll_hdr.host_build, 0 = unknown:
 * Dolphin). Small and dim: for the TO checking a dozen Wiis, not for players. */
#include "../lb/lbmodule_version.inc"
#define L_VER_X 578.0f /* right edge: the CSS hint's, inside the safe area */
#define L_VER_S 0.40f

static void drawVersion(void)
{
    char buf[48];
    char* p = putStr(buf, TM_MODULE_VERSION);
    if (tm_ph.host_build != 0) {
        p = putStr(p, "  WII ");
        putInt(p, (int) tm_ph.host_build);
    }
    rightAt(L_VER_X, L_HEAD_Y, L_VER_S, &c_dim2, buf);
}

static void drawHeader(void)
{
    char buf[48];
    char* p;
    int k, last, first_row = 0, last_row = 0;
    f32 right = L_TAG_R_X + L_TAG_W - 24.0f; /* 358: the cue fits inside */


    if (tm_filter == 0) {
        lineC(L_TEXT_X, L_HEAD_Y, L_HEAD_S, &c_dim, "#L ALL SETS #R");
    } else {
        p = putStr(buf, "#L NAMES: ");
        *p++ = tm_filter;
        putStr(p, " #R");
        lineC(L_TEXT_X, L_HEAD_Y, L_HEAD_S, &c_dim, buf);
    }
    if (tm_nview == 0) {
        return;
    }
    last = tm_top + L_SLOTS;
    if (last > tm_nslots) {
        last = tm_nslots;
    }
    for (k = tm_top; k < last; k++) {
        if (!tm_slots[k].is_header) {
            if (first_row == 0) {
                first_row = tm_slots[k].view_idx + 1;
            }
            last_row = tm_slots[k].view_idx + 1;
        }
    }
    p = putInt(buf, first_row);
    p = putStr(p, "-");
    p = putInt(p, last_row);
    p = putStr(p, " OF ");
    putInt(p, tm_nview);
    rightAt(right, L_HEAD_Y, L_HEAD_S, &c_dim, buf);
    if (tm_top > 0) {
        lbButton_Shape(tm_text, right + 4.0f, L_HEAD_Y, L_HEAD_S,
                       LB_SHAPE_TRI_UP, c_dim2);
    }
}

static void drawList(bool muted)
{
    int k;
    int last = tm_top + L_SLOTS;
    int shown = 0; /* rows through the last one drawn; MORE counts the rest */
    if (last > tm_nslots) {
        last = tm_nslots;
    }
    for (k = tm_top; k < last; k++) {
        f32 y = L_SLOT_Y + (f32) (k - tm_top) * L_SLOT_H;
        const struct tm_slot* sl = &tm_slots[k];
        const struct set_entry* set = &tm_sets[tm_view[sl->view_idx]];
        if (sl->is_header) {
            /* A page never ends on a header: it comes with its rows. */
            if (k == last - 1 && last < tm_nslots) {
                break;
            }
            if (set->state != 0) {
                dotLabel(L_TEXT_X, y, L_HDR_S, muted ? &c_muted : &c_amb,
                         "PLAYING HERE");
            } else {
                char r[ROUND_LEN + 1];
                f32 s;
                copyStr(r, set->round, ROUND_LEN);
                s = fitText(r, L_HDR_S, 0.50f, L_LIST_W - 24.0f);
                lineC(L_TEXT_X, y, s, muted ? &c_muted : &c_dim, r);
            }
        } else {
            drawRow(y, set, sl->view_idx == tm_sel, muted);
            shown = sl->view_idx + 1;
        }
    }
    if (last < tm_nslots && !muted) {
        char buf[16];
        f32 w, x;
        putStr(putInt(buf, tm_nview - shown), " MORE");
        w = lbButton_ShapeAdvance(L_HINT_S, LB_SHAPE_TRI_DN) + 6.0f +
            width(L_HINT_S, buf);
        x = L_LIST_CX - 0.5f * w;
        x += lbButton_Shape(tm_text, x, L_MORE_Y, L_HINT_S, LB_SHAPE_TRI_DN,
                            c_dim) +
             6.0f;
        lineC(x, L_MORE_Y, L_HINT_S, &c_dim, buf);
    }
}

static void paneTag(f32 y, const char* tag, const GXColor* c)
{
    char buf[TAG_LEN + 1];
    f32 s;
    copyStr(buf, tag, TAG_LEN);
    s = fitText(buf, L_PANE_TAG_S, L_ROW_MIN_S, L_PANE_W);
    lineC(L_PANE_X, y, s, c, buf);
}

/* BEST OF n as a real rounded pill (quarter-disc ends), Bo5 purple, Bo3 grey. */
static void panePill(f32 y, int best_of)
{
    char buf[16];
    f32 w;
    putInt(putStr(buf, "BEST OF "), best_of);
    w = width(0.55f, buf) + 14.0f;
    lbButton_Panel(tm_text, NULL, L_PANE_X, y + 13.0f, w, 22.0f, 6.0f,
                   best_of == 5 ? c_pill5 : c_pill3, c_pill5);
    lineC(L_PANE_X + 7.0f, y, 0.55f, &c_white, buf);
}

/* The host's own verdict (exi_poll_hdr.flags): a card or network problem it
 * knows about before any beacon could arrive. 0 on Dolphin. */
static bool hostNoNetwork(void)
{
    return (tm_ph.flags & PF_NO_NETWORK) != 0;
}

/* Network is on but the host has not finished joining the Wi-Fi yet. */
static bool hostNetJoining(void)
{
    return (tm_ph.flags & PF_NET_JOINING) != 0;
}
static bool hostNoCard(void)
{
    return (tm_ph.flags & (PF_NO_CFG | PF_NO_SECRET)) != 0;
}

/* STATION n / RELAY / a.b.c.d from the poll header the host fills. */
static void paneWhereAmI(f32 y)
{
    char buf[24];
    char* p;
    u32 ip = tm_ph.relay_ip;
    putInt(putStr(buf, "STATION "), tm_ph.station);
    lineC(L_PANE_X, y, L_HINT_S, &c_dim2, buf);
    if (ip == 0) {
        return;
    }
    lineC(L_PANE_X, y + 24.0f, L_HINT_S, &c_dim2, "RELAY");
    p = putInt(buf, (int) (ip >> 24));
    p = putStr(p, ".");
    p = putInt(p, (int) ((ip >> 16) & 0xFF));
    p = putStr(p, ".");
    p = putInt(p, (int) ((ip >> 8) & 0xFF));
    p = putStr(p, ".");
    putInt(p, (int) (ip & 0xFF));
    lineC(L_PANE_X, y + 48.0f, 0.45f, &c_dim2, buf);
    putInt(putStr(buf, "PORT "), tm_ph.relay_port);
    lineC(L_PANE_X, y + 72.0f, 0.45f, &c_dim2, buf);
}

/* The pane in three groups: context (round, best-of), matchup (tag / VS /
 * tag, hero size), action (state, then the biggest line: what A does). */
static void drawPane(void)
{
    const struct set_entry* set = NULL;
    char round[ROUND_LEN + 1];
    int lines;

    switch (tm_state) {
    case TM_LIST:
        if (tm_nview == 0) {
            lineC(L_PANE_X, 126.0f, L_HINT_S, &c_dim2, "NO SETS");
            paneWhereAmI(174.0f);
            return;
        }
        set = &tm_sets[tm_view[tm_sel]];
        copyStr(round, set->round, ROUND_LEN);
        lines = wrap2(L_PANE_X, 120.0f, 22.0f, 0.55f, 0.45f, L_PANE_W, &c_dim,
                      round);
        panePill(lines > 1 ? 170.0f : 148.0f, set->best_of);
        paneTag(212.0f, set->p1_tag, &c_yel);
        lineC(L_PANE_X, 240.0f, L_HINT_S, &c_dim2, "VS");
        paneTag(268.0f, set->p2_tag, &c_yel);
        if (set->state != 0) {
            dotLabel(L_PANE_X, 308.0f, L_HINT_S, &c_amb, "PLAYING HERE");
            lineC(L_PANE_X, 340.0f, L_ACTION_S, &c_white, "#A RESUME");
        } else {
            dotLabel(L_PANE_X, 308.0f, L_HINT_S, &c_grn, "READY");
            lineC(L_PANE_X, 340.0f, L_ACTION_S, &c_white, "#A START");
        }
        break;
    case TM_CONFIRM:
    case TM_STARTING:
        set = &tm_sets[tm_chosen];
        paneBox(L_PANE_BOX_X, L_PANE_BOX_Y, L_PANE_BOX_W, L_PANE_BOX_H,
                c_tint, false);
        if (set->state != 0) {
            lineC(L_PANE_X, 120.0f, 0.62f, &c_yel, "BACK TO");
            lineC(L_PANE_X, 146.0f, 0.62f, &c_yel, "YOUR SET?");
        } else {
            lineC(L_PANE_X, 120.0f, 0.62f, &c_yel, "START THIS");
            lineC(L_PANE_X, 146.0f, 0.62f, &c_yel, "SET?");
        }
        panePill(170.0f, set->best_of);
        paneTag(212.0f, set->p1_tag, &c_white);
        lineC(L_PANE_X, 240.0f, L_HINT_S, &c_dim2, "VS");
        paneTag(268.0f, set->p2_tag, &c_white);
        if (tm_state == TM_CONFIRM) {
            lineC(L_PANE_X, 340.0f, L_HINT_S, &c_white, "#A YES   #B BACK");
        } else {
            lineC(L_PANE_X, 340.0f, L_HINT_S, &c_dim, "STARTING");
            pulse(L_PANE_X + width(L_HINT_S, "STARTING") + 30.0f, 340.0f,
                  L_HINT_S);
        }
        break;
    case TM_SEARCHING:
        paneWhereAmI(126.0f);
        dotLabel(L_PANE_X, 236.0f, L_HINT_S, &c_amb, "SEARCHING");
        break;
    case TM_LOADING:
        paneWhereAmI(126.0f);
        break;
    case TM_ERROR:
        paneWhereAmI(126.0f);
        dotLabel(L_PANE_X, 236.0f, L_HINT_S, &c_red,
                 hostNetJoining()    ? "NO WI-FI"
                 : hostNoNetwork()   ? "NET OFF"
                 : hostNoCard()      ? "BAD CARD"
                 : tm_ph.relay_ip == 0 ? "NOT FOUND"
                 : tm_err_link       ? "NO LINK"
                 : errIsSecret()     ? "BAD SECRET"
                                     : "REFUSED");
        break;
    default:
        break;
    }
}

static void redraw(void)
{
    destroyText();
    tm_scrim = newText(70);
    tm_shadow = newText(L_SHADOW_A);
    tm_bar = newText(L_BAR_A);
    tm_text = newText(255);

    paneBox(L_LIST_X, L_LIST_Y, L_LIST_W, L_LIST_H, c_scrim, true);
    paneBox(L_PANE_BOX_X, L_PANE_BOX_Y, L_PANE_BOX_W, L_PANE_BOX_H, c_scrim,
            true);
    /* The LazyTO title is the wordmark sprite (lbWordmark_Show), which
     * lives across redraws. The version text is drawn in every state, so a
     * station that cannot reach the relay still says which build it runs. */
    drawVersion();

    switch (tm_state) {
    case TM_SEARCHING:
        centredAt(L_LIST_CX, 214.0f, 0.62f, &c_dim,
                  hostNetJoining() ? "JOINING THE WI-FI" : "LOOKING FOR THE RELAY");
        pulse(L_LIST_CX, 250.0f, 0.62f);
        centredAt(L_HINT_CX, L_HINT_Y, L_HINT_S, &c_white, "#B MENU");
        break;
    case TM_LOADING:
        centredAt(L_LIST_CX, 214.0f, 0.62f, &c_dim, "LOADING SETS");
        pulse(L_LIST_CX, 250.0f, 0.62f);
        centredAt(L_HINT_CX, L_HINT_Y, L_HINT_S, &c_white, "#B MENU");
        break;
    case TM_LIST:
        drawHeader();
        if (tm_nview == 0) {
            centredAt(L_LIST_CX, 200.0f, 0.62f, &c_dim, "NO SETS RIGHT NOW");
            centredAt(L_LIST_CX, 236.0f, L_HINT_S, &c_dim2,
                      "#Y REFRESHES THE LIST");
        } else {
            drawList(false);
        }
        centredAt(L_HINT_CX, L_HINT_Y, L_HINT_S, &c_white,
                  "#Z FRIENDLIES   #Y REFRESH   #B MENU");
        break;
    case TM_CONFIRM:
    case TM_STARTING:
        /* A second scrim over the first dims the list further; the rows go
         * muted as well. */
        paneBox(L_LIST_X, L_LIST_Y, L_LIST_W, L_LIST_H, c_scrim, false);
        drawHeader();
        drawList(true);
        if (tm_state == TM_CONFIRM) {
            centredAt(L_HINT_CX, L_HINT_Y, L_HINT_S, &c_dim,
                      "CHECK BOTH TAGS FIRST");
        }
        break;
    case TM_ERROR:
        lineC(L_TEXT_X, 150.0f, 0.62f, &c_red,
              hostNetJoining()    ? "THIS WII COULD NOT JOIN THE WI-FI"
              : hostNoNetwork()   ? "NETWORK IS OFF IN THE LOADER"
              : hostNoCard()      ? "THIS CARD IS NOT SET UP"
              : tm_ph.relay_ip == 0 ? "NO RELAY FOUND"
              : tm_err_link       ? "NO LINK TO THE RELAY"
              : errIsSecret()     ? "RELAY SECRET MISMATCH"
                                  : "THE RELAY SAID NO");
        wrap2(L_TEXT_X, 190.0f, 26.0f, L_HDR_S, 0.45f, L_LIST_W - 24.0f, &c_white,
              tm_errmsg);
        lineC(L_TEXT_X, 262.0f, 0.45f, &c_dim,
              tm_count > 0 ? "YOUR LIST IS STILL HERE" : "NO SETS LOADED YET");
        lineC(L_TEXT_X, 286.0f, 0.45f, &c_dim,
              hostNetJoining()    ? "POWER CYCLE THE WII, THEN CHECK THE ROUTER"
              : hostNoNetwork()   ? "TURN ON NETWORK IN THE LOADER'S SETTINGS"
              : hostNoCard()      ? "PUT TOURNAMENT.CFG WITH A SECRET ON THE SD CARD"
              : tm_ph.relay_ip == 0 ? "IS THIS SETUP ON THE RELAY'S NETWORK?"
              : errIsSecret()     ? "CHECK THE SECRET ON THIS CARD"
                                  : "TELL THE TO IF THIS REPEATS");
        centredAt(L_HINT_CX, L_HINT_Y, L_HINT_S, &c_white,
                  "#A RETRY   #B BACK");
        break;
    default:
        break;
    }
    drawPane();
}

/* ------------------------------------------------------------ relay */

static void fail(const char* msg)
{
    copyStr(tm_errmsg, msg, MSG_LEN);
    tm_err_link = true;
    tm_err_status = 0;
    tm_state = TM_ERROR;
    tm_dirty = true;
}

static void failFromResp(const struct relay_resp* resp)
{
    copyStr(tm_errmsg, resp->msg, MSG_LEN);
    if (tm_errmsg[0] == '\0') {
        copyStr(tm_errmsg, "RELAY ERROR", MSG_LEN);
    }
    tm_err_link = false;
    tm_err_status = resp->status;
    tm_state = TM_ERROR;
    tm_dirty = true;
}

static void sendList(void)
{
    tm_retry_cmd = CMD_LIST_SETS;
    tm_timeout = 0;
    tm_join_frames = 0;
    if (lbRelayExi_Request(CMD_LIST_SETS, NULL, 0)) {
        tm_state = TM_LOADING;
    } else {
        fail("EXI ERROR");
    }
    tm_dirty = true;
}

/* Has the host found the relay yet? Reads the poll image for its
 * exi_poll_hdr (kept for the pane). -1 = EXI failure, 0 = no beacon heard,
 * 1 = relay known. */
static int peekRelay(void)
{
    struct exi_poll_hdr ph;
    if (!lbRelayExi_Peek(&ph)) {
        return -1;
    }
    tm_ph = ph;
    return tm_ph.relay_ip != 0 ? 1 : 0;
}

/* The list request, held back until the host knows the relay: a request
 * sent before the first beacon is answered "no relay found yet" by the
 * host itself, which on a cold boot would greet every player with an
 * error. Searching shows its own view and gives up after TM_SEARCH_FRAMES. */
static void startList(void)
{
    int r = peekRelay();
    if (r < 0) {
        fail("EXI ERROR");
    } else if (r > 0) {
        sendList();
    } else {
        tm_retry_cmd = CMD_LIST_SETS;
        tm_timeout = 0;
        tm_join_frames = 0;
        tm_state = TM_SEARCHING;
        tm_dirty = true;
    }
}

static void sendStart(void)
{
    struct start_set_req req;
    req.set_id = tm_sets[tm_chosen].set_id;
    /* The kernel overwrites stream (and hdr.station) from tournament.cfg. */
    req.stream = 0;
    req._pad[0] = req._pad[1] = req._pad[2] = 0;

    tm_retry_cmd = CMD_START_SET;
    tm_timeout = 0;
    tm_join_frames = 0;
    if (lbRelayExi_Request(CMD_START_SET, &req, sizeof(req))) {
        tm_state = TM_STARTING;
    } else {
        fail("EXI ERROR");
    }
    tm_dirty = true;
}

static void exitToMainMenu(void)
{
    destroyText();
    lbWordmark_Hide();
    tm_state = TM_OFF;
    /* B-back: the player wants the real main menu, so show its visuals again
     * before its think takes over. */
    setMenuVisualsHidden(false);
    /* Frees this think GObj and spawns the main-menu think. */
    mn_80229894(MENU_KIND_MAIN, 0, 3);
}

static void acceptList(const struct lbRelayExi_PollBuf* r)
{
    const struct list_sets_resp* list =
        (const struct list_sets_resp*) r->payload;
    int count = list->count;
    if (count > MAX_SETS) {
        count = MAX_SETS;
    }
    if (count > TM_MAX_SETS) {
        count = TM_MAX_SETS;
    }
    tm_count = count;
    memcpy(tm_sets, list->sets, count * sizeof(struct set_entry));
    tm_state = TM_LIST;
    /* Keep the filter if it still matches something, and the cursor on the
     * set it was on (a refresh must not lose the player's place). */
    buildView();
    if (tm_nview == 0 && tm_filter != 0) {
        tm_filter = 0;
        buildView();
    }
    selectSet(tm_keep_id);
    tm_dirty = true;
}

static void pollRelay(void)
{
    const struct lbRelayExi_PollBuf* r;
    s32 state = lbRelayExi_Poll();

    if (state < 0) {
        fail("EXI ERROR");
        return;
    }
    /* Every poll image starts with where we are (host-filled, even while the
     * relay is silent) - keep the latest for the side pane. */
    tm_ph = lbRelayExi_Response()->ph;
    if (state == RELAY_ERROR) {
        fail("RELAY LINK ERROR");
        return;
    }
    if (state != RELAY_DONE) {
        if (++tm_timeout > TM_TIMEOUT_FRAMES) {
            lbRelayExi_Abort();
            fail("TIMEOUT - RELAY NOT ANSWERING");
        }
        return;
    }
    r = lbRelayExi_Response();
    if (r->hdr.magic[0] != RELAY_MAGIC_0 || r->hdr.magic[1] != RELAY_MAGIC_1 ||
        r->hdr.cmd != tm_retry_cmd)
    {
        fail("BAD RESPONSE");
        return;
    }
    if (r->resp.status != ST_OK) {
        failFromResp(&r->resp);
        return;
    }
    if (tm_retry_cmd == CMD_LIST_SETS) {
        acceptList(r);
    } else {
        /* START_SET accepted: hand the set to lbtourney and enter the CSS.
         * The scene teardown frees this think and the overlay. */
        lbTourney_SetCurrent(&tm_sets[tm_chosen]);
        tm_state = TM_OFF;
        mn_80229860(GM_VS);
    }
}

/* ------------------------------------------------------------ think */

static void moveCursor(int delta)
{
    int v = (int) tm_sel + delta;
    if (v < 0) {
        v = 0;
    }
    if (v > tm_nview - 1) {
        v = tm_nview - 1;
    }
    if (v != (int) tm_sel) {
        sfxMove();
        tm_sel = (u16) v;
        ensureVisible();
        tm_dirty = true;
    }
}

static void listInputs(u64 buttons)
{
    u32 pressed = gm_GetButtonsTriggered(4);

    if (pressed & PAD_TRIGGER_Z) {
        /* Friendlies: enter the CSS with no set active, so nothing is
         * reported. B on the CSS still returns here (kiosk routing). */
        sfxForward();
        lbTourney_ClearCurrent();
        tm_state = TM_OFF;
        mn_80229860(GM_VS);
        return;
    }
    if (pressed & PAD_BUTTON_Y) {
        /* Refresh; the cursor goes back onto the same set afterwards. */
        sfxForward();
        tm_keep_id = tm_nview > 0 ? tm_sets[tm_view[tm_sel]].set_id : 0;
        startList();
        return;
    }
    if (buttons & MenuInput_Back) {
        sfxBack();
        exitToMainMenu();
        return;
    }
    if ((buttons & MenuInput_Confirm) && tm_nview > 0) {
        sfxForward();
        tm_chosen = tm_view[tm_sel];
        tm_state = TM_CONFIRM;
        tm_dirty = true;
    } else if (pressed & PAD_BUTTON_X) {
        /* Jump to the set this station is playing (back from a game), else
         * to the top. */
        int v, target = 0;
        for (v = 0; v < tm_nview; v++) {
            if (tm_sets[tm_view[v]].state != 0) {
                target = v;
                break;
            }
        }
        moveCursor(target - (int) tm_sel);
    } else if (buttons & MenuInput_Up) {
        moveCursor(-1);
    } else if (buttons & MenuInput_Down) {
        moveCursor(1);
    } else if (buttons & MenuInput_Left) {
        moveCursor(-(L_SLOTS - 1));
    } else if (buttons & MenuInput_Right) {
        moveCursor(L_SLOTS - 1);
    } else if (buttons & MenuInput_LTrigger) {
        sfxMove();
        stepFilter(-1);
        tm_dirty = true;
    } else if (buttons & MenuInput_RTrigger) {
        sfxMove();
        stepFilter(1);
        tm_dirty = true;
    }
}

void mnTourney_Think(HSD_GObj* gobj)
{
    u64 buttons;
    UNUSED u8 _pad[8];

    (void) gobj;
    buttons = Menu_GetAllInputs();
    tm_frame++;

    if (tm_ctx < 0) {
        tm_ctx = HSD_SisLib_803A611C(lbButton_Font(), NULL, 9, 0xD, 0, 0xE, 0,
                                     0x13);
        lbButton_InstallFont();
        lbWordmark_Show(L_WM_X, L_WM_Y, L_WM_S);
        tm_dirty = true;
    }

    /* Venue audio defaults, once the set list is stably up (see tm_audio_set).
     * Not in forceKioskDefaults: that runs inside the menu-enter transition,
     * where touching the mix crashed the GX texture path (bisected v12-v15). */
    if (!tm_audio_set && tm_state == TM_LIST) {
        /* The host's settings can keep stereo / music (exi_poll_hdr.host_opts,
         * from the LazyTO loader menu; Dolphin sends 0 = both forced). */
        tm_audio_set = true;
        if (!(tm_ph.host_opts & HO_STEREO)) {
            OSSetSoundMode(0); /* mono */
        }
        if (!(tm_ph.host_opts & HO_MUSIC_ON)) {
            gmMainLib_GetGamePrefs()->sound_balance = 100; /* music off */
        }
    }

    switch (tm_state) {
    case TM_SEARCHING: {
        int r = peekRelay();
        if (r < 0) {
            fail("EXI ERROR");
        } else if (r > 0) {
            sendList();
        } else if (hostNetJoining()) {
            /* The host is still joining the Wi-Fi (its network comes up on
             * its own thread): wait, keep B working, and only give up after
             * TM_JOIN_FRAMES. The beacon timeout below starts once it is on. */
            if (buttons & MenuInput_Back) {
                sfxBack();
                exitToMainMenu();
                return;
            }
            if (++tm_join_frames > TM_JOIN_FRAMES) {
                fail("NO WI-FI AFTER 60 SECONDS");
            }
        } else if (hostNoNetwork()) {
            /* The loader's Network option is off: no beacon will ever come,
             * say so now. */
            fail("NETWORK IS OFF IN THE LOADER");
        } else if (hostNoCard()) {
            fail((tm_ph.flags & PF_NO_CFG) ? "NO TOURNAMENT.CFG ON THE CARD"
                                           : "NO SECRET IN TOURNAMENT.CFG");
        } else if (buttons & MenuInput_Back) {
            sfxBack();
            exitToMainMenu();
            return;
        } else if (++tm_timeout > TM_SEARCH_FRAMES) {
            fail("NO BEACON HEARD FOR 10 SECONDS");
        } else if (tm_frame % L_PULSE_FRAMES == 0) {
            tm_dirty = true;
        }
        break;
    }
    case TM_LOADING:
        pollRelay();
        if (tm_state == TM_LOADING && (buttons & MenuInput_Back)) {
            sfxBack();
            lbRelayExi_Abort();
            exitToMainMenu();
            return;
        }
        if (tm_state == TM_LOADING && tm_frame % L_PULSE_FRAMES == 0) {
            tm_dirty = true; /* the dots walk */
        }
        break;
    case TM_STARTING:
        /* The request is committed; B is ignored until it resolves. */
        pollRelay();
        if (tm_state == TM_STARTING && tm_frame % L_PULSE_FRAMES == 0) {
            tm_dirty = true;
        }
        break;
    case TM_LIST:
        buildView();
#if TM_DEMO_AUTOSTART
        if (tm_nview > 0 && tm_frame % 600 == 120) {
            buttons |= MenuInput_Confirm;
        }
#endif
        listInputs(buttons);
        if (tm_state == TM_OFF) {
            return;
        }
        break;
    case TM_CONFIRM:
#if TM_DEMO_AUTOSTART == 1
        if (tm_frame % 600 == 180) {
            buttons |= MenuInput_Confirm;
        }
#endif
        if (buttons & MenuInput_Back) {
            sfxBack();
            tm_state = TM_LIST;
            tm_dirty = true;
        } else if (buttons & MenuInput_Confirm) {
            sfxForward();
            sendStart();
        }
        break;
    case TM_ERROR:
        if (buttons & MenuInput_Back) {
            sfxBack();
            if (tm_count > 0) {
                tm_state = TM_LIST;
                buildView();
                ensureVisible();
                tm_dirty = true;
            } else {
                exitToMainMenu();
                return;
            }
        } else if (buttons & MenuInput_Confirm) {
            sfxForward();
            if (tm_retry_cmd == CMD_LIST_SETS) {
                startList();
            } else {
                sendStart();
            }
        }
        break;
    default:
        break;
    }

    if (tm_dirty) {
        tm_dirty = false;
        redraw();
    }
}

/* Force the venue's tournament state live each time we pass the main menu, so
 * it holds regardless of what the memory-card save has (decisions.md, Stock
 * Melee plus a module): all
 * characters unlocked, Stock mode, 4 stocks, 8:00, no items. Stages already
 * default to all-unlocked but we set the mask too for good measure. */
static void forceKioskDefaults(void)
{
    GameRules* rules = gmMainLib_GetGameRules();
    struct GamePrefs* prefs = gmMainLib_GetGamePrefs();

    rules->mode = 1;             /* Stock */
    rules->stock_count = 4;
    rules->stock_time_limit = 8; /* 8:00 in Stock mode (reads stock_time_limit) */
    rules->stage_sel = 0;        /* Choose: the SSS is shown (lbtourney flips
                                  * this to Random for a Z+X handwarmer start) */

    prefs->item_freq = 0xFF;     /* -1 (read as s8) = items OFF; 0 is lowest ON */
    prefs->item_mask = 0;
    /* Random-stage set = the singles legal six (Battlefield, Final Destination,
     * Fountain of Dreams, Yoshi's Story, Dream Land, Pokemon Stadium). This is
     * Magus's "Singles Stages" value for stage_mask (04 write of 0xE70000B0 to
     * DefaultGamePrefs+0x18). Manual stage picks are unaffected. */
    prefs->stage_mask = 0xE70000B0;

    /* NOTE: audio venue defaults are NOT forced here. Writing sound_balance to
     * LIVE prefs at this menu-enter point flips the music mix mid
     * scene-transition and crashes in the GX texture path (bisected v12-v15).
     * Both are asserted instead in mnTourney_Think once the set list is stably
     * up (tm_audio_set): a stable frame, after the memcard save-load (which
     * overwrites the boot default), before any match. The default template also
     * carries sound_balance = 100 as a no-memcard fallback. */

    gm_8016468C();               /* unlock all stages (the real unlock mask) */
    *gmMainLib_GetUnlockedCharactersBitmaskPtr() = 0xFFFF; /* all characters */
}

/* Leave the main menu for the Tournament submenu (sound-test style): assert
 * the kiosk rules/unlocks, swap cur_menu, spawn our think, free this think. */
static void enterTournament(HSD_GObj* gobj)
{
    HSD_GObjProc* proc;

    forceKioskDefaults();
    /* Entering the set list: show the menu panel again. It was hidden only
     * for the boot warm-up (no main-menu flash); on the tournament screen its
     * border frames the list (2026-09-22). */
    setMenuVisualsHidden(false);
    mn_804D6BC8.cooldown = 5;
    mn_804A04F0.prev_menu = mn_804A04F0.cur_menu;
    mn_804A04F0.cur_menu = TM_MENU_KIND;
    mn_804A04F0.hovered_selection = 0;
    proc = HSD_GObj_SetupProc(GObj_Create(0, 1, 0x80), mnTourney_Think, 0);
    proc->flags_3 = HSD_GObj_804D783C;
    HSD_GObjFree(gobj);
    startList();
}

void mnTourney_ArmAutoEnter(void)
{
    tm_auto_enter = true;
    tm_boot_frames = 0;
}

void mnTourney_MainMenuThink(HSD_GObj* gobj)
{
    /* Boot and every return from the CSS drop straight into the set list --
     * but only once the menu is ready (cooldown hits 0). Entering on the very
     * first frame renders half-initialised menu graphics and crashes in the
     * GX texture path; waiting for cooldown==0 is the safe point (a brief
     * main-menu flash; a zero-frame version needs the panel GObj hidden). */
    if (tm_auto_enter) {
        /* Let the menu render for a while first: entering the instant cooldown
         * hits 0 catches half-loaded menu textures and crashes in the GX
         * texture path (__GXSetSUTexRegs) on a cold boot. */
        if (tm_boot_frames < TM_BOOT_WARMUP_FRAMES) {
            if (tm_boot_frames == 0) {
                /* First warm-up frame: the menu visuals exist (made by the
                 * scene's OnEnter) but must never be seen. */
                setMenuVisualsHidden(true);
            }
            tm_boot_frames++;
            mn_8022DB10(gobj);
            return;
        }
        if (mn_804D6BC8.cooldown == 0) {
            tm_auto_enter = false;
            enterTournament(gobj);
            return;
        }
    }
    /* Otherwise the main menu is shown (the player backed out with B); Z
     * re-enters the Tournament screen. (A visible main-menu row needs an
     * MnMaAll asset edit -- deferred; Z is the interim entry.) */
    if (mn_804D6BC8.cooldown == 0 && (gm_GetButtonsTriggered(4) & PAD_TRIGGER_Z))
    {
        sfxForward();
        enterTournament(gobj);
        return;
    }
    mn_8022DB10(gobj);
}

void mnTourney_MenuSceneExit(void* exit_data)
{
    (void) exit_data;
    /* The scene teardown frees the canvas and text GObjs; just forget them. */
    tm_ctx = -1;
    tm_text = NULL;
    tm_bar = NULL;
    tm_shadow = NULL;
    tm_scrim = NULL;
    lbWordmark_Forget();
    tm_state = TM_OFF;
}
