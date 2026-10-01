#ifndef MELEE_LB_LBBUTTONGLYPH_H
#define MELEE_LB_LBBUTTONGLYPH_H

#include <Runtime/platform.h>

#include <sysdolphin/baselib/sislib.h>

/* Shape glyphs in the module's SIS font slot (tools/gen_button_glyphs.py):
 * the button bodies, plus flat UI shapes for the kiosk menus. */
enum lbButton_Shape {
    LB_SHAPE_DISC,
    LB_SHAPE_RSQ,
    LB_SHAPE_PILL,
    LB_SHAPE_CROSS,
    LB_SHAPE_BLOCK, /* solid cell: stretched into bars and scrims */
    LB_SHAPE_TRI_UP,
    LB_SHAPE_TRI_DN,
    LB_SHAPE_TRI_RT,
    LB_SHAPE_QD_TL, /* quarter discs: rounded-panel corners */
    LB_SHAPE_QD_TR,
    LB_SHAPE_QD_BL,
    LB_SHAPE_QD_BR,
    LB_SHAPE_QR_TL, /* quarter rings: a rounded rim's corners */
    LB_SHAPE_QR_TR,
    LB_SHAPE_QR_BL,
    LB_SHAPE_QR_BR,
    LB_SHAPE_COUNT
};

/* Kiosk overlay text with inline GameCube button icons.
 *
 * fmt is ASCII (what HSD_SisLib_803A6B98 accepts) plus icon markers:
 *   #A #B #X #Y #Z #L #R      the buttons
 *   #S                        Start (pill with "ST")
 *   #C                        C-stick (yellow disc with "C")
 *   #D                        D-pad (grey cross)
 * and the ASCII punctuation the SIS encoder cannot map on its own
 * ( + ( ) / ! ? ) is translated to its Shift-JIS glyph, so callers write
 * plain "#Z+#X FOR HANDWARMER".
 *
 * An icon is two SIS entries: a coloured shape glyph (extra atlas glyphs
 * 287-290, tools/gen_button_glyphs.py) and the font's own letter laid over
 * it. Everything is positioned from the font's kerning table, so the return
 * value is the exact drawn width and lbButton_Measure lets a caller centre a
 * line: x = (640 - lbButton_Measure(s, fmt)) / 2. Text segments keep the
 * HSD_Text's default colour. */
f32 lbButton_Line(HSD_Text* text, f32 x, f32 y, f32 scale, const char* fmt);
/* Same, with the text runs in colour ink (NULL = the text's default). */
f32 lbButton_LineC(HSD_Text* text, f32 x, f32 y, f32 scale,
                   const GXColor* ink, const char* fmt);
f32 lbButton_Measure(f32 scale, const char* fmt);

/* True when the SIS encoder (plus our Shift-JIS translations) can draw c;
 * anything else is swallowed as a lead byte and eats the next character. */
bool lbButton_Drawable(char c);
/* The 2-byte SIS glyph code the built-in font uses for c, or -1. */
int lbButton_GlyphCode(char c);

/* One shape glyph at pen x / entry y with the SIS line semantics of a letter
 * of scale s (its ink centred on that text line), colour c; returns the
 * advance. Alpha comes from the HSD_Text (text_color.a), not from c. */
f32 lbButton_Shape(HSD_Text* text, f32 x, f32 y, f32 s, int shape, GXColor c);
f32 lbButton_ShapeAdvance(f32 s, int shape);

/* A flat rectangle, top-left (x, y), w by h screen pixels: the solid block
 * glyph stretched by per-entry x/y scale. Alpha is the HSD_Text's. */
void lbButton_Box(HSD_Text* text, f32 x, f32 y, f32 w, f32 h, GXColor c);
/* A rounded panel of corner radius r: three blocks and four quarter discs
 * that never overlap (a translucent fill stays even) into fill_text, and,
 * when rim_text is not NULL, a rim 6/32 of r thick into it (edges from
 * blocks, corners from the quarter rings). */
void lbButton_Panel(HSD_Text* fill_text, HSD_Text* rim_text, f32 x, f32 y,
                    f32 w, f32 h, f32 r, GXColor fill, GXColor rim);
/* Same placement for any shape whose ink fills its cell edge to edge (the
 * block, the quarter discs and rings). */
void lbButton_Rect(HSD_Text* text, f32 x, f32 y, f32 w, f32 h, int shape,
                   GXColor c);
/* Monochrome line: text runs AND icon shapes in ink, no letters over the
 * shapes - a drop shadow drawn under a normal line. */
f32 lbButton_LineMono(HSD_Text* text, f32 x, f32 y, f32 scale,
                      const GXColor* ink, const char* fmt);

/* Every kiosk text context and text object must be created on this SIS font
 * index (a slot the game never loads) and the font installed right after the
 * context is made - the button shapes are served through it. */
int lbButton_Font(void);
void lbButton_InstallFont(void);

#endif
