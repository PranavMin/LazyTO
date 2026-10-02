# The tournament module (`tournament.bin`)

Since 2026-09-24 the kiosk is not a rebuilt Melee: the venue Wiis run a **stock
Melee 1.02 ISO** and our code is a position-fixed blob that the loader copies into RAM at boot
and wires in with a short list of word patches. Design rationale and history:
[architecture.md](architecture.md) and [decisions.md](decisions.md) R11/R12. The shifted-DOL line (v1-v39,
`SmashTournament-vN.iso`) is frozen at tag `shifted-dol-final` in the old melee fork (PranavMin/melee).

## What is in it

| TU | Role |
|---|---|
| `kiosk/src/melee/mn/mntourney.c` | Tournament menu (set list, filter, confirm, error, loading), boot warm-up, `forceKioskDefaults` |
| `kiosk/src/melee/lb/lbtourney.c` | set state, CSS binds, who-is-who (the L+R port claim), Z+X handwarmer, auto-score from `MatchEnd`, the score in the CSS banner, overlays |
| `kiosk/src/melee/lb/lbrelayexi.c` | EXI driver for the relay device (channel 1 / device 0 / freq 4) |
| `kiosk/src/melee/lb/lbbuttonglyph.c` | button icons: 4 I4 32x32 shapes in SIS font slot 4 (`lbbuttonglyph_shapes.inc` from `kiosk/tools/gen_button_glyphs.py`) |
| `kiosk/src/melee/lb/lbmodule_glue.c` | vanilla statics the kiosk reads (`mnCharSel_*`), `tm_bootOnLoad`, `tm_menuLightColor` |

Compiled with the DOL's MWCC flags plus `-sdata 0 -sdata2 0 -DTOURNAMENT_MODULE` (no
small-data sections: r2/r13-relative addressing cannot reach a blob at the top of MEM1). Every
vanilla function/variable the TUs use is resolved from `config/GALE01/symbols.txt` (which *is*
the 1.02 layout) into an absolute `sym = 0xADDR;` line of a generated LCF; an unresolved
external fails the build.

## Build

```
python kiosk/tools/build_module.py        # -> kiosk/build/tournament.bin (about 81 KB, under 100 KB)
```

Prerequisite: the `melee/` submodule (the unmodified decomp) set up once: your vanilla
`main.dol` in `melee/orig/GALE01/sys/`, then `python configure.py --non-matching` and
`python -m ninja` inside `melee/`. That provides the compilers, headers and symbol map. Objects go to `kiosk/build/obj/`;
delete them to force a clean rebuild. The output ends with the applied patch list, the guard
check and the file size.

The build runs on Windows only: the decomp's compilers and `powerpc-eabi-nm` are `.exe` files,
and the wordmark generator uses GDI+.

```
python kiosk/tools/build_module.py --check   # build-check without main.dol; writes no module
```

`--check` is for CI (`.github/workflows/kiosk.yml`), which has no `main.dol`. It compiles,
links and runs every check that does not need the DOL: externals against `symbols.txt`, hook
targets, the region, gecko collisions. It never opens the DOL, so it does not verify that each
hook address is inside the vanilla DOL and does not read the guard word, and it writes no
`tournament.bin`. It is never chosen automatically: without `--check` a missing DOL stops the
build. CI fetches only the decomp's compilers, binutils and sjiswrap (`ninja tools` needs the
DOL, see the workflow).

## Developer flags

Three compile-time switches exist for development runs with no controller, such as a Dolphin
session capturing screenshots. Each is a `#define` that must stay `0` in a shipped build;
`npm run sync-card` refuses to write a card while any is non-zero. Set one to `1`, rebuild,
and set it back before committing.

| Flag | File | With `1` |
|---|---|---|
| `TM_DEMO_AUTOSTART` | `src/melee/mn/mntourney.c` | the set list auto-confirms and starts its first set two seconds after it is up (`2`: only opens the confirm pane) |
| `LB_TOURNEY_DEMO_CLAIM` | `src/melee/lb/lbtourney.c` | fakes an L + R claim by port 3 after 150 CSS frames and treats port 1 as human |
| `LB_TOURNEY_TRIGGER_READOUT` | `src/melee/lb/lbtourney.c` | draws every port's raw L/R trigger values bottom-left, to pick the claim threshold from a real pad |

## Generated files

Never edit these by hand:

| File | Generator |
|---|---|
| `kiosk/include/relay_proto.h` | `python tools/gen_protocol.py` from `protocol.yaml` (checked by `npm test`) |
| `kiosk/src/melee/lb/lbbuttonglyph_shapes.inc` | `python kiosk/tools/gen_button_glyphs.py` (the button and UI shapes) |
| `kiosk/src/melee/lb/lbwordmark_tex.inc` | the LazyTO title texture, 256x48 GX IA8. Made by a maintainer tool outside the repo (GDI+, Franklin Gothic Medium); the file is checked in and changes only with the artwork |
| `kiosk/src/melee/lb/lbmodule_version.inc` | written by every build, git-ignored |

## File format

```
"TMOD"  u32 version=1  u32 load_addr  u32 blob_len  u32 n_patches
u32 guard_addr (0x8016D800)  u32 guard_word (0x7C0802A6)
n_patches x { u32 addr, u32 value }
blob  (.text + .rodata + .data + .bss zero-filled), copied to load_addr
```

Load address `0x817E0000`: top of MEM1, below the FST (`0x817F8AC0`); ~100 KB of room. The
loader must (1) find `guard_word` at `guard_addr` - stock 1.02 in RAM, nothing else gets
patched; (2) require `*(0x80000034) >= load_addr + blob_len` (BootInfo arenaHi, which Melee's
`OSInit` adopts), (3) copy the blob, (4) write the patches, (5) write `load_addr` to
`0x80000034` so the arena stops below the module, (6) invalidate the icache over both ranges.
The loader is Nintendont `kernel/Patch.c LoadTournamentModule` (reads `sd:/tournament.bin`
in the full-DOL patch pass). A development setup in Dolphin uses an equivalent loader.

## Patches (`kiosk/tools/module_hooks.txt`)

One line per patch: `ptr <addr> <symbol>` (write the module symbol's address), `branch <addr>
<symbol>` (write `b symbol` over a vanilla function's first instruction), `word <addr> <hex>`.
Today: scene-table rows (GS_MENU exit, GS_VS frame/exit, GS_CSS frame/exit, GS_SSS enter), the main-menu
think, the hijacked Trophies row (kind 3: think, description indices, selection count,
anim/start_frame, panel-animation rows, light-colour jump-table entries), `bootOnLoad` and
`mn_8022C010` branches. The builder decodes every Nintendont codeset in `kernel/gecko/` and
refuses a patch or blob range that a gecko `04`/`C2` also touches - gecko codes are applied
after the module and would win silently.

## Rules

- No new files on the disc, ever. New assets go into the blob or are streamed from the SD card
  through the relay EXI device (both loaders' hosts already own that device).
- Vanilla addresses only, from `symbols.txt`; verify a hook is really reached (inlining! the
  light-colour function was inlined at both real call sites - 2026-09-24).
- Nothing the venue's codesets already do is re-implemented here: UCF, neutral spawns,
  striking, stealth tags, rumble toggle, music/mono are theirs.
- Per-build QA: `kiosk-checklist.md`.

## Compiler and engine pitfalls

- MWCC is C89 and MSL has no `<stdint.h>`. `gen_protocol.py` emits `__MWERKS__`-guarded
  typedefs instead.
- MWCC wants literal aggregates for `const GXColor` initialisers. Use macros.
- Sources must be plain ASCII. sjiswrap rejects em dashes and smart quotes.
- Each scene has a fixed SIS text pool. The module raises the menu's pool with a `li` patch to
  `0x7800`, the largest value one `li` holds (`0xC000` sign-extends negative).
- Do not draw letters through `HSD_SisLib_803A67EC`: its opcode run is a fixed-width digit
  mode, so letters crush inside it.
- Hardware boots differ from Dolphin in low memory: the ARM kernel cannot fix BootInfo
  `0x80000034` (the apploader's value sits in the PPC data cache), so only PPC code at entry
  may lower it. Suspect boot-environment differences first when something works in Dolphin
  but not on a Wii.
