# Upstream sync, 2026-09-30

All three forks were brought up to their upstreams in one pass. Nothing in LazyTO's own
behaviour changes; this records what came in, where it touched our work, and how each
merge was checked.

| Fork | Upstream | Behind by | Merge | Checked by |
|---|---|---|---|---|
| Nintendont `vanilla-module` | project-slippi/Nintendont `slippi` (v1.13.1) | 3 commits | clean | kernel builds locally; CI loader built (run 36814186778) |
| Ishiiruka `vanilla-module` | project-slippi/Ishiiruka `slippi` | 1 commit | clean | not rebuilt (netplay-only change, see below) |
| melee `vanilla-module` | doldecomp/melee `master` | 46 commits, 985 files | 5 conflicts, resolved | module builds; set list boots in Dolphin |

## Nintendont (Slippi Nintendont v1.13.1)

What came in:

- **"bye bye ucf08"**: the Controller Fix option loses the UCF 0.8 and 0.84-RC entries; it is now
  Off / UCF 0.84 / Stealth 0.84. `NIN_CFG_VERSION` goes 0xD -> 0xE and the loader migrates an
  old config on first run (old value 4 "UCF 0.84 RC" becomes 2 "UCF 0.84", which is what the venue
  card had). The gecko bins we read (`g_ucf_084.bin`, `g_mods_tournament.bin`) are unchanged.
- **Replay write fix**: `SlippiFileWriter.c` batches `.slp` writes to spare the USB stick's flash.
  Pure win for a station recording all night; no overlap with our kernel code.
- **CI on every branch** with cancel-in-progress. Our `apps/LazyTO` packaging merged alongside
  it, so pushes to `vanilla-module` now build the loader without `gh workflow run`.

Seamlessness: the two files both sides touched (`CommonConfig.h`, `build.yml`) merged without
conflict; our config bits 16/17 (Melee Music / Audio) sit outside the fields the version bump
covers; `sync-card.ps1` only ORs bits into the config word, so the migration and our bits coexist;
`build_module.py`'s codeset check tolerates the removed `g_ucf.bin` (it skips missing files).
To verify on the Wii: boot once, confirm the loader shows "UCF 0.84" under Controller Fix and the
set list still loads.

## Ishiiruka (Slippi Dolphin)

One upstream commit, "fix desync recovery bugs", in `SlippiNetplay.cpp` and the netplay part of
`EXI_DeviceSlippi.cpp` (lines ~2565-2600). Our relay forwarder lives at the end of that file
(~3600+) and in the header; the merge was clean and the hunks are 1000 lines apart. The dev-loop
Dolphin binary was not rebuilt: the kiosk never uses netplay, and the forwarder's wire handling is
length-driven (it needed no rebuild for the 48-byte game record either). Rebuild when the next
forwarder change needs it.

## melee (doldecomp)

46 upstream commits, mostly tooling and type hygiene: dat-file annotations and a clang pipeline
for them, the PPC DWARF debug build, "name all anonymous types and ban their usage", item enum
reorganisation, nix cleanups. 985 files changed, but almost all outside the module's six TUs.

Conflicts (5), all in files our old shifted-DOL branch had edited:

- `ifnametag.c`, `hsd_3A76.c`, `sislib.h`, `sislib_font.h`: our edits extended the vanilla font
  atlas by four glyphs for the shifted DOL. The module carries its glyphs in its own font slot
  now and the DOL is stock, so **upstream's version was taken** for all four.
- `mncharsel.h`: upstream's version plus our four declarations (`mnCharSel_CursorHandOffset`,
  `PortNametag`, `TryStartFight`, `PortSlotType`), which the module's glue defines.

Build fixes the merge needed (module code, not behaviour):

- `tools/build_module.py` gains `-i libs/doldecomp/include` (upstream's new `dat_macros.h`).
- `lbbuttonglyph.c`: upstream removed the `SIS` font typedef and types the font table as
  `u8**`; the module now declares the same two-pointer layout itself. The vanilla glyph-width
  table is `TextGlyphMetrics[]` (`.left` / `.right`) instead of a byte array.

Seamlessness: every one of the 68 vanilla symbols the module links against still exists under the
same name in upstream's `symbols.txt` (checked before merging); hook addresses are vanilla DOL
addresses and never move. The module built from the merged tree boots to the set list in Dolphin
against the live relay. The other legacy edits to vanilla TUs (`gmboot.c`, `gmvs.c`,
`mncharsel.c`, `mnstagesel.c`, `mnmain.c`, `gmmain_lib.c`) merged without conflict and remain
dead code on this branch; a later cleanup can revert them to upstream to shrink future merges.

## Not done here

- The Pi relay and the SD cards need nothing from this sync. The card's loader should be
  re-synced once so the Wii runs the v1.13.1 kernel with the replay-write fix.
- Dolphin dev-loop binary: rebuild only when a forwarder change needs it.
