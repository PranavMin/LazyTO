#include "lbbuttonglyph.h"

#include <string.h>

#include <sysdolphin/baselib/sislib.h>
#include <sysdolphin/baselib/sislib_font.h>

/* How sislib lays glyphs out with kerning on (hsd_3A76.c, our overlays use
 * default_kerning = 1): every glyph is a 32-unit cell scaled by s; the
 * kerning table HSD_SisLib_8040CB00 holds {left, right} blank columns per
 * glyph index; the quad is drawn at pen - (left-1)*s, so ink starts at
 * pen + 1*s, and the pen advances (34 - left - right)*s. */
#define CELL 32.0f

/* The button shapes live in a SIS font slot of our own. Glyph codes below
 * 0x4000 always come from the built-in atlas; codes 0x4000+n are drawn from
 * the text's font table (HSD_SisLib_804D1124[font_idx]): the texture from
 * (u8*)sis->kerning + n*0x200 and the {left,right} kerning pair from
 * sis->textures->data[n*2] (the two fields are named the other way round
 * from how the draw code uses them - hsd_3A76.c:834/842). Font index 4 is
 * never loaded by the game, so it is ours; the scene teardown clears the
 * table, so it is re-installed whenever a kiosk text context is created. */
#define TM_FONT 4
#define SH_DISC LB_SHAPE_DISC
#define SH_RSQ LB_SHAPE_RSQ
#define SH_COUNT LB_SHAPE_COUNT
static const u8 shape_tex[SH_COUNT][512] ATTRIBUTE_ALIGN(32) = {
#include "lbbuttonglyph_shapes.inc"
};
/* {left, right} blank columns of each shape (tools/gen_button_glyphs.py). */
static const u8 shape_kern[SH_COUNT][2] = {
    { 2, 2 }, { 3, 3 },           /* DISC RSQ */
    { 0, 0 }, { 4, 4 }, { 4, 4 }, /* BLOCK TRI_UP TRI_DN */
    { 0, 0 }, { 0, 0 }, { 0, 0 }, { 0, 0 }, /* QD_TL QD_TR QD_BL QD_BR */
    { 0, 0 }, { 0, 0 }, { 0, 0 }, { 0, 0 }, /* QR_TL QR_TR QR_BL QR_BR */
};
/* The vanilla font table entry (sislib.h's old `SIS`: kerning pointer, then
 * glyph textures; upstream dropped the typedef and types the table as
 * u8**). Same byte layout as the game's four fonts; the game reads it through
 * font_idx 4 = TM_FONT. */
struct tm_sis_font {
    const void* kerning;  /* the game indexes this by glyph: our 2-byte margins */
    const void* textures; /* 512-byte I4 glyph tiles */
};
static const struct tm_sis_font tm_font = { shape_tex, shape_kern };

int lbButton_Font(void)
{
    return TM_FONT;
}

void lbButton_InstallFont(void)
{
    HSD_SisLib_804D1124[TM_FONT] = (u8**) &tm_font;
}

/* Icons are drawn a bit larger than the text they sit in (2026-09-24)
 * and re-centred on the text's ink line; the letter over the shape is a
 * fraction of the shape's scale. */
#define ICON_SCALE 1.25f
#define LETTER_SCALE 0.58f

struct lbButton_Def {
    char marker;
    u8 shape;
    const char* letters; /* "" = none */
    GXColor fill;
    GXColor ink;
};

/* GameCube controller colours. X/Y are light, so their letter is dark. */
/* Macros, not const objects: MWCC (C89) wants literal aggregates here. */
#define WHITE { 255, 255, 255, 255 }
#define DARK { 30, 30, 40, 255 }
static const struct lbButton_Def defs[] = {
    { 'A', SH_DISC, "A", { 63, 174, 109, 255 }, WHITE },
    { 'B', SH_DISC, "B", { 217, 69, 61, 255 }, WHITE },
    { 'X', SH_DISC, "X", { 210, 211, 220, 255 }, DARK },
    { 'Y', SH_DISC, "Y", { 210, 211, 220, 255 }, DARK },
    { 'Z', SH_RSQ, "Z", { 90, 82, 184, 255 }, WHITE },
    { 'L', SH_RSQ, "L", { 138, 140, 153, 255 }, WHITE },
    { 'R', SH_RSQ, "R", { 138, 140, 153, 255 }, WHITE },
};

/* Glyph index of an ASCII char exactly as the SIS encoder maps it
 * (hsd_3A64.c), plus the punctuation we translate to Shift-JIS ourselves.
 * -1 = not drawable. */
static int glyphIndex(char c)
{
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'A' && c <= 'Z') {
        return 10 + (c - 'A');
    }
    if (c >= 'a' && c <= 'z') {
        return 36 + (c - 'a');
    }
    switch (c) {
    case ' ':
        return 227;
    case ',':
        return 230;
    case '.':
        return 231;
    case ':':
        return 233;
    case '?':
        return 235;
    case '!':
        return 236;
    case '/':
        return 240;
    case '\'':
        return 243;
    case '"':
        return 244;
    case '(':
        return 245;
    case ')':
        return 246;
    case '+':
        return 251;
    case '-':
        return 252;
    }
    return -1;
}

/* Second byte of the Shift-JIS pair (lead 0x81) for punctuation the encoder
 * does not map from ASCII; 0 = pass the ASCII byte through. */
static char sjisLow(char c)
{
    switch (c) {
    case '+':
        return '{';
    case '(':
        return 'i';
    case ')':
        return 'j';
    case '/':
        return '^';
    case '!':
        return 'I';
    case '?':
        return 'H';
    }
    return 0;
}

bool lbButton_Drawable(char c)
{
    return glyphIndex(c) >= 0;
}

int lbButton_GlyphCode(char c)
{
    int g = glyphIndex(c);
    if (g < 0) {
        return -1;
    }
    /* Codes below 0x4000 are 0x2000 + the atlas index (hsd_3A76.c:833);
     * the encoder's code table is indexed by its own lookup order, not by
     * atlas index, so it is not usable here. */
    return 0x2000 + g;
}

static f32 kernLeft(int g)
{
    return (f32) HSD_SisLib_8040CB00[g].left;
}

static f32 kernRight(int g)
{
    return (f32) HSD_SisLib_8040CB00[g].right;
}

static f32 advance(int g, f32 s)
{
    return (CELL + 2.0f - kernLeft(g) - kernRight(g)) * s;
}

/* Width of a plain text run. */
static f32 textWidth(const char* str, int n, f32 s)
{
    f32 w = 0.0f;
    int i;
    for (i = 0; i < n; i++) {
        int g = glyphIndex(str[i]);
        if (g >= 0) {
            w += advance(g, s);
        }
    }
    return w;
}

/* Offset from the pen to the centre of a run's ink. A glyph's quad sits at
 * pen - (left-1)*s, so its ink runs from pen + 1*s to pen + (33-left-right)*s;
 * for a run, the last glyph's ink end is offset by the advances before it. */
static f32 inkCentre(const char* str, f32 s)
{
    f32 end = 0.0f;
    int n = (int) strlen(str);
    int last = glyphIndex(str[n - 1]);
    int i;
    for (i = 0; i < n - 1; i++) {
        end += advance(glyphIndex(str[i]), s);
    }
    end += (CELL + 1.0f - kernLeft(last) - kernRight(last)) * s;
    return 0.5f * (1.0f * s + end);
}

static const struct lbButton_Def* findDef(char marker)
{
    int i;
    for (i = 0; i < (int) (sizeof(defs) / sizeof(defs[0])); i++) {
        if (defs[i].marker == marker) {
            return &defs[i];
        }
    }
    return NULL;
}

static f32 shapeAdvance(int shape, f32 s)
{
    return (CELL + 2.0f - shape_kern[shape][0] - shape_kern[shape][1]) * s *
           ICON_SCALE;
}

/* One entry holding a single shape glyph, code 0x4000+shape. The ASCII
 * encoder cannot produce that code, so the entry is created with a
 * placeholder digit - encoded as "0A F4 00 00 00 20 00 0B" (spacing push,
 * glyph, spacing pop; hsd_3A64.c sisBeginLine/sisEndKerning) right after the
 * 14-byte entry header (07 x y / 0C rgb / 0E scale) - and those 8 bytes are
 * rewritten in place: the glyph code, then 0x1F fillers, an opcode neither
 * the draw nor the measure loop knows and both step over one byte at a
 * time. Same length, so the entry walker is unaffected. */
static int shapeEntry(HSD_Text* text, f32 x, f32 y, int shape)
{
    int entry = HSD_SisLib_803A6B98(text, x, y, "0");
    u8* e = fn_803A6FEC((u8*) text->sis_buffer, entry, NULL);
    if (e != NULL && e[0] == 7 && e[14] == 0x0A && e[19] == 0x20 && e[20] == 0x00) {
        e[14] = 0x40;
        e[15] = (u8) shape;
        memset(e + 16, 0x1F, 6);
    }
    return entry;
}

/* Draws one icon at pen (x, y); returns its advance. mono: the shape in
 * *mono and no letter (a shadow). */
static f32 drawIcon(HSD_Text* text, f32 x, f32 y, f32 s,
                    const struct lbButton_Def* d, const GXColor* mono)
{
    const u8* k = shape_kern[d->shape];
    f32 S = s * ICON_SCALE; /* the shape's own scale */
    f32 cx = x + (1.0f + 0.5f * (CELL - k[0] - k[1])) * S;
    /* Vertical: every entry's scale opcode is pushed at its start and popped
     * at its end, so each line is measured against the text's default scale
     * (1.0) and a glyph at scale s is drawn 32*(1-s) below the entry's y
     * (bottom-aligned to a 32-unit line). A letter's ink (rows 2..28,
     * centre 15) at the text scale s is therefore centred at y + 32 - 17s;
     * the shape (ink centre 16) at scale S is given sy = y + 16S - 17s so
     * its centre lands on that same line. The letter over it, at scale t,
     * is given ly = cy - 32 + 16.5t. */
    f32 cy = y + CELL - 17.0f * s; /* the text line's ink centre on screen */
    f32 sy = y + 16.0f * S - 17.0f * s;
    GXColor c;
    int entry;

    entry = shapeEntry(text, x, sy, d->shape);
    HSD_SisLib_803A7548(text, entry, S, S);
    c = mono != NULL ? *mono : d->fill;
    HSD_SisLib_803A74F0(text, entry, &c);

    if (mono == NULL && d->letters[0] != '\0') {
        f32 t = S * LETTER_SCALE;
        f32 lx = cx - inkCentre(d->letters, t);
        f32 ly = cy - CELL + 16.5f * t;
        entry = HSD_SisLib_803A6B98(text, lx, ly, "%s", d->letters);
        HSD_SisLib_803A7548(text, entry, t, t);
        c = d->ink;
        HSD_SisLib_803A74F0(text, entry, &c);
    }
    return shapeAdvance(d->shape, s);
}

f32 lbButton_ShapeAdvance(f32 s, int shape)
{
    return (CELL + 2.0f - shape_kern[shape][0] - shape_kern[shape][1]) * s;
}

f32 lbButton_Shape(HSD_Text* text, f32 x, f32 y, f32 s, int shape, GXColor c)
{
    int entry = shapeEntry(text, x, y, shape);
    HSD_SisLib_803A7548(text, entry, s, s);
    HSD_SisLib_803A74F0(text, entry, &c);
    return lbButton_ShapeAdvance(s, shape);
}

void lbButton_Rect(HSD_Text* text, f32 x, f32 y, f32 w, f32 h, int shape,
                   GXColor c)
{
    /* Per-entry scale is 8.8 fixed point, so a 32-unit cell stretches to any
     * size up to 8191 px in 1/8 px steps. A full-cell shape has no blank
     * columns (left = 0), so its quad starts at pen + 1*sx (hsd_3A76.c:838-842).
     * A line is measured at least 32 units tall and a glyph is bottom-aligned
     * to it, so a glyph shorter than that (sy < 1) is drawn 32*(1-sy) below
     * its entry's y, and a taller one (sy >= 1) starts right at y (seen
     * 2026-09-25: a 262 px scrim landed 230 px low with the short-glyph
     * rule). */
    f32 sx = w / CELL;
    f32 sy = h / CELL;
    f32 drop = sy < 1.0f ? CELL * (1.0f - sy) : 0.0f;
    int entry = shapeEntry(text, x - sx, y - drop, shape);
    HSD_SisLib_803A7548(text, entry, sx, sy);
    HSD_SisLib_803A74F0(text, entry, &c);
}

void lbButton_Panel(HSD_Text* fill_text, HSD_Text* rim_text, f32 x, f32 y,
                    f32 w, f32 h, f32 r, GXColor fill, GXColor rim)
{
    lbButton_Rect(fill_text, x + r, y, w - 2 * r, h, LB_SHAPE_BLOCK, fill);
    lbButton_Rect(fill_text, x, y + r, r, h - 2 * r, LB_SHAPE_BLOCK, fill);
    lbButton_Rect(fill_text, x + w - r, y + r, r, h - 2 * r, LB_SHAPE_BLOCK,
                  fill);
    lbButton_Rect(fill_text, x, y, r, r, LB_SHAPE_QD_TL, fill);
    lbButton_Rect(fill_text, x + w - r, y, r, r, LB_SHAPE_QD_TR, fill);
    lbButton_Rect(fill_text, x, y + h - r, r, r, LB_SHAPE_QD_BL, fill);
    lbButton_Rect(fill_text, x + w - r, y + h - r, r, r, LB_SHAPE_QD_BR, fill);
    if (rim_text != NULL) {
        f32 t = r * 6.0f / 32.0f; /* the quarter rings' thickness */
        lbButton_Rect(rim_text, x + r, y, w - 2 * r, t, LB_SHAPE_BLOCK, rim);
        lbButton_Rect(rim_text, x + r, y + h - t, w - 2 * r, t, LB_SHAPE_BLOCK,
                      rim);
        lbButton_Rect(rim_text, x, y + r, t, h - 2 * r, LB_SHAPE_BLOCK, rim);
        lbButton_Rect(rim_text, x + w - t, y + r, t, h - 2 * r, LB_SHAPE_BLOCK,
                      rim);
        lbButton_Rect(rim_text, x, y, r, r, LB_SHAPE_QR_TL, rim);
        lbButton_Rect(rim_text, x + w - r, y, r, r, LB_SHAPE_QR_TR, rim);
        lbButton_Rect(rim_text, x, y + h - r, r, r, LB_SHAPE_QR_BL, rim);
        lbButton_Rect(rim_text, x + w - r, y + h - r, r, r, LB_SHAPE_QR_BR, rim);
    }
}

/* Copies a text run into buf, translating the punctuation the SIS encoder
 * cannot map from ASCII into its Shift-JIS pair. */
static void encodeRun(char* buf, int cap, const char* str, int n)
{
    int i;
    int o = 0;
    for (i = 0; i < n && o < cap - 3; i++) {
        char lo = sjisLow(str[i]);
        if (lo != 0) {
            buf[o++] = (char) 0x81;
            buf[o++] = lo;
        } else {
            buf[o++] = str[i];
        }
    }
    buf[o] = '\0';
}

/* Shared walker: draw == NULL measures only; ink colours the text runs;
 * mono also paints the icon shapes in ink and drops their letters. */
static f32 walk(HSD_Text* text, f32 x, f32 y, f32 s, const GXColor* ink,
                const char* fmt, bool draw, bool mono)
{
    f32 pen = x;
    const char* p = fmt;
    char buf[96];

    while (*p != '\0') {
        const struct lbButton_Def* d = NULL;
        const char* run = p;
        int n = 0;
        /* Text run up to the next marker. */
        while (p[n] != '\0' && !(p[n] == '#' && findDef(p[n + 1]) != NULL)) {
            n++;
        }
        if (n > 0) {
            if (draw) {
                int entry;
                encodeRun(buf, sizeof(buf), run, n);
                entry = HSD_SisLib_803A6B98(text, pen, y, "%s", buf);
                HSD_SisLib_803A7548(text, entry, s, s);
                if (ink != NULL) {
                    GXColor c = *ink;
                    HSD_SisLib_803A74F0(text, entry, &c);
                }
            }
            pen += textWidth(run, n, s);
            p += n;
        }
        if (*p == '#') {
            d = findDef(p[1]);
            if (draw) {
                pen += drawIcon(text, pen, y, s, d, mono ? ink : NULL);
            } else {
                pen += shapeAdvance(d->shape, s);
            }
            p += 2;
        }
    }
    return pen - x;
}

f32 lbButton_LineC(HSD_Text* text, f32 x, f32 y, f32 scale,
                   const GXColor* ink, const char* fmt)
{
    return walk(text, x, y, scale, ink, fmt, true, false);
}

f32 lbButton_LineMono(HSD_Text* text, f32 x, f32 y, f32 scale,
                      const GXColor* ink, const char* fmt)
{
    return walk(text, x, y, scale, ink, fmt, true, true);
}

f32 lbButton_Measure(f32 scale, const char* fmt)
{
    return walk(NULL, 0.0f, 0.0f, scale, NULL, fmt, false, false);
}
