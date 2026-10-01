# New-version check-yourself list

Manual checks to run **every time a new `tournament.bin` is built** (the kiosk module
injected into stock Melee 1.02, see `kiosk.md`), each one born from a bug we actually hit. If a check fails,
the note says the usual cause and where it's documented. **This is a living list - add a row
whenever a new build issue bites us.** Rows tagged *(venue code)* are behaviours that now come
from Nintendont's own codesets, not our source: verify them, but a difference there is the
venue's behaviour, not a bug in ours.

Legend: each item is something *you* verify by eye on the running build.

---

## 0. Build hygiene (module build)

- [ ] Built with **`python kiosk/tools/build_module.py`** (needs the `melee/` submodule set up:
      `python configure.py --non-matching` once). The tail of its output lists every patch
      and ends with `guard: 0x8016D800 == 0x7C0802A6` and the `.bin` size (~26 KB). *A failed
      external resolution or a gecko overlap stops the build with the symbol/address named -
      never hand-edit `tournament.bin`.*
- [ ] **No non-ASCII in edited C files** before building (scan for em-dash U+2014,
      smart quotes, etc.). *MWCC parses source as Shift-JIS and errors on them.*
- [ ] If any on-screen text looks jammed/wrong after an edit, **delete `kiosk/build/obj/*.o`** and
      rebuild. *A stale `mntourney.o` once rendered "STARTPapa VS Hotel" / wrong confirm text.*
- [ ] For hardware: copy `tournament.bin` to the SD card root next to `tournament.cfg`; the
      Nintendont boot log must show the module line *and* `Patch:Apply Slippi core`.

## 1. Boot & menu flow

- [ ] Boots **straight into the set-selection list** — no intro movie, no title
      sequence, no lingering main menu. *Intro/title skip is the module's `tm_bootOnLoad`,
      branched over vanilla `bootOnLoad` (`kiosk/tools/module_hooks.txt`).*
- [ ] **Panel frame is the plain blue main-menu frame with no title** (no green, no
      "Trophies", no faded "Main Menu"). *The menu hijacks the Trophies row (kind 3); its
      panel-animation rows and its light colour are patched (2026-09-24). Green = the two
      inlined light-colour jump tables were not patched; a title = wrong frame range.*
- [ ] **Trophies is gone from the main menu's reach**: the kiosk never shows the main menu,
      but if it ever does, the Trophies row opens the set list. Expected.
- [ ] **No boot crash.** *v7 crashed (`Invalid read … PC=0x803442f0`, __SetSURegs) because
      it entered the set list on frame 1 before menu graphics initialized; v8 gates on
      `cooldown == 0`. See `kiosk-and-defaults-investigation.md`.*
- [ ] After an **END_SET upload**, it returns to the set list (doesn't sit on the CSS).
- [ ] **B on the CSS** returns to the set list.
- [ ] **Z on the set list** enters the CSS in friendlies mode (no set active, nothing reported).

## 2. Kiosk defaults — rules & unlocks (forced live at boot)

- [ ] Match rules are **4 stocks / 8:00 / items OFF**. *"Items off" is `item_freq = -1`
      (0xFF), not 0 — 0 is the lowest ON setting. Bug fixed; verify it stuck. See `defaults-debug.md`.*
- [ ] **All characters unlocked** on the CSS.
- [ ] **All stages unlocked** on stage select. *Real unlock is `gm_8016468C()`, not
      `stage_mask` (that's only the per-match legal-stage toggle). Bug fixed; verify.*
- [ ] **Random-stage set = the 6 singles legal stages** (BF, FD, FoD, YS, DL, PS).
      *`stage_mask = 0xE70000B0` (Magus "Singles Stages"), forced live in `forceKioskDefaults`.*
- [ ] **Music off + mono.** *Set at **boot**, NOT live at menu-enter. Music-off =
      `gmMainLib_DefaultGamePrefs.sound_balance = 100` (copied into live prefs at the boot
      init-copy). Mono = `OSSetSoundMode(0)` at boot. **Do NOT force `sound_balance` live in
      `forceKioskDefaults`** — writing it at menu-enter re-mixes the BGM mid scene-transition
      and crashes in the GX texture path (`__GXSetSUTexRegs`), deterministically, every boot
      (bisected v12-v15, 2026-09-21). Same caution for any audio-mixing setting: default
      template / boot only.*

## 3. Text & layout (SIS menu text)

- [ ] **Set list is the two-pane screen (2026-09-25):** TOURNAMENT top-left in the
      panel's title tab; header `L ALL SETS R` + position `1-8 OF 24`; rows `tag VS tag`
      on one VS axis (x 208) under round-name headers (the set this station is playing
      sits under an amber `PLAYING HERE` header of its own); the cursor row yellow on a
      translucent light-blue bar with a yellow left edge; the right pane shows the
      highlighted set (round, tags, BEST OF n, READY / PLAYING HERE, `A START` or
      `A RESUME` for the set already running here); hints
      `Z FRIENDLIES  Y REFRESH  B MENU` centred between the panel's bottom corner boxes.
      *Every position is a `L_*` constant at the top of mntourney.c; measured centring
      via `lbButton_Measure`, never by eye. Both panes are rounded translucent navy
      panels with a light-blue rim and every line has a 2 px drop shadow (look 4 of the
      2026-09-25 variants, `TM_LOOK` in mntourney.c). If the panels are missing or sit
      low, the stretched-block rule broke: a glyph taller than a line starts AT its
      entry y, a shorter one 32*(1-sy) below it (lbbuttonglyph.c lbButton_Rect). Seams
      or darker patches in a panel mean two translucent pieces overlap.*
- [ ] **No halt on entering the list.** *The menu scene's SIS text pool is 18 KB in
      vanilla and the two-pane screen needs more; the module patches `preloadState`'s
      size to 30 KB (`word 0x801A3FA8 0x38607800`, kiosk/tools/module_hooks.txt). A freeze
      with FPS 0 and `Memory Empty in "sislib.c"` in Dolphin's log means that hook is
      missing or the screen grew past the pool: cut entries, the `li` immediate cannot
      go above 0x7FFF (0xC000 sign-extends to a negative size and panics at boot).*
- [ ] **The LazyTO title is the wordmark texture** (renamed from TOURNAMENT 2026-09-30, `python kiosk/tools/gen_wordmark.py`) (bold italic, drop shadow) in the
      panel's top-left title tab, not SIS text; it survives redraws and disappears on B-back
      to the main menu. *`lbwordmark.c` + `lbwordmark_tex.inc` (regenerate with
      `python kiosk/tools/gen_wordmark.py`, needs the Franklin Gothic Medium font on the PC that
      builds). Invisible wordmark = one of the two `lb_800138EC` traps: its camera priority
      must be above the text context's 0x13 (we use 0x14) and its alpha argument is inverted
      (0 = opaque; 0xFF drew nothing for an hour on 2026-09-25). Garbled = IA8 tiling/byte
      order (texel = alpha byte, intensity byte, 4x4 tiles).*
- [ ] **Long list:** with more than 8 slots the header shows a small up-triangle after the
      position once scrolled, `n MORE` (the rows left below) with a down-triangle sits
      inside the scrim under the last row, left/right on the stick pages by 7, X jumps to the set marked PLAYING HERE
      (amber), Y keeps the cursor on the same set after the reload. *Tested with the
      400-set fake (56 shown, the wire cap).*
- [ ] **Cold boot waits for the beacon, never errors on it:** with the relay up, the list
      appears without an intermediate error; with the relay down, `LOOKING FOR THE RELAY`
      pulses for 10 s, then `NO RELAY FOUND` / `NO BEACON HEARD FOR 10 SECONDS` / `IS THIS
      SETUP ON THE RELAY'S NETWORK?` with a red `NOT FOUND` dot; A searches again. *The
      kernel/forwarder answer a request sent before their first beacon with a synthetic
      "no relay found yet" (decisions.md R15); the module peeks `exi_poll_hdr.relay_ip` first
      (`lbRelayExi_Peek`) and only then sends LIST_SETS. In Dolphin the beacon listener
      starts on the first EXI command, so the very first boot after launch may search for
      up to 2 s.*
- [ ] **Confirm / error stay in the frame:** A dims the list and asks `START THIS SET?` in
      the pane with both tags and `A YES  B BACK`, the hint bar says CHECK BOTH TAGS FIRST;
      a dead relay shows `NO LINK TO THE RELAY` + the message + `YOUR LIST IS STILL HERE`
      or `NO SETS LOADED YET`, and the pane shows `STATION n / RELAY / a.b.c.d / PORT p`
      with a red `NO LINK` dot (a relay-reported error says `THE RELAY SAID NO` / `REFUSED`;
      a shared-secret mismatch says `RELAY SECRET MISMATCH` / `CHECK THE SECRET ON THIS
      CARD` / `BAD SECRET`, decisions.md R15).
      *Station/relay come from `exi_poll_hdr`, which the kernel/forwarder fill on every
      poll; Dolphin shows station 0 (decisions.md R10). The confirm view has not been captured
      in the dev loop (no controller input there) - eyeball it on the Wii.*
- [ ] **No missing/garbage glyphs.** *The SIS text encoder (hsd_3A64.c) maps only
      these ASCII bytes: space `" ' , - . : 0-9 A-Z a-z`. Any other ASCII byte (`+ ( ) /
      [ ] % & * @ # $ = < > ? !`) is taken as a Shift-JIS lead byte and eats the next
      character - that was the stray "V" from `(L/R)` and the blank from `Z + X`. The
      glyphs DO exist in the font (HSD_SisLib_FontAtlas, 287 glyphs, sheet rendered
      2026-09-22): write them as 2-byte SJIS escapes in the string literal, e.g. `+` =
      `"{"` (0x817B), `(` `)` = `"i"` `"j"`, `/` = `"^"`, `!` = `"I"`,
      `?` = `"H"`, `x` (times) = `"~"`, `=` = `""`, `%` = `""`.
      There are NO controller-button glyphs in the font (digits, Latin, kana, symbols,
      24 kanji only) - icons need textures (architecture.md).*
- [ ] **Round names are full and grouped:** `WINNERS QUARTER-FINAL`, `LOSERS ROUND 1`
      as headers, never `WQF`; a header appears wherever the round changes going down the
      list (the relay sorts earliest round first). In the pane a long round name wraps to
      two lines only when it cannot shrink onto one (`WINNERS ROUND 1` stays one line).
      *Wire: `set_entry.round` is 24 chars of upper-cased fullRoundText (protocol.yaml).*
- [ ] **No swallowed characters:** `1-8 / 24` shows its slash; every kiosk string goes
      through the icon walker (`lbButton_LineC`) so `/ + ( ) ! ?` are translated, and
      wire strings pass `copyStr`, which blanks anything undrawable and `#`.

## 4. Venue mods - the venue's own gecko codesets, NOT our source (since 2026-09-24)

Everything in this section is Nintendont's `kernel/gecko/*.bin` applied to the stock DOL
(`g_ucf_084.bin`, `g_mods_tournament.bin`: neutral spawns, stage striking, stealth nametag
hide, D-pad rumble toggle) - on hardware by the venue's MeleeCodes toggles, in Dolphin by the
same bytes converted into `GALE01r2.ini`. Our old native ports (`lbucf.c`, `lbneutralspawn.c`) and the
`mnstagesel.c`/`ifnametag.c` edits live only on tag `shifted-dol-final`. History of why they existed: `melee fork, docs/history/ucf-investigation.md`,
`melee fork, docs/history/ucf-readdressing.md`, `melee fork, docs/history/venue-codes-readdressing.md`, decisions.md R11/R12.

- [ ] **UCF feels right** *(venue code)*: dashback, shield-drop, wiggle-out-of-tumble behave
      like UCF 0.84.
- [ ] **Neutral spawns** *(venue code)*: on Battlefield a 2P match starts on the **left and
      right side platforms**, not centre/top. FoD `+/-41.25` on the side platforms is the venue's
      real value, not a bug.
- [ ] **A `.slp` is written** for every game (Dolphin: `SlippiReplayDir`; Wii: the USB drive).
      *The whole point of the module architecture; if it stops, a patch is colliding with the
      Slippi core codes - `build_module.py` checks overlaps at build time, so look for a
      changed codeset first.*
- [ ] **Nothing of ours in the DOL**: the Nintendont boot log shows no "Tournament build ...
      skipping" line (that gate is reverted); Dolphin's ISO properties show the plain 1.02 image.

## 5. Relay & start.gg (before the game can list anything)

- [ ] **Relay is running** and its status page loads: http://localhost:29473 .
      *Restart it after a machine reboot.*
- [ ] Status page shows **`Cache: N sets` with N > 0**, and **no "preview-id set(s)
      dropped" warning**. *0 sets or a preview warning = a start.gg pool isn't started.
      Start it: `markSetInProgress` on any set materializes real numeric ids for the whole
      pool (R8). The relay drops preview (string-id) sets by design.*
- [ ] Status page shows the **correct event id** (1613010 for the test tournament).

## 6. Full set flow (end-to-end smoke test)

- [ ] Set list **populates from the relay** (matches the sets on start.gg). *An empty
      list while the relay shows sets = game↔relay protocol mismatch (e.g. an EXI command-byte
      skew from a DOL built before a protocol renumber) — rebuild game and forwarder together.*
- [ ] Select a set → **A asks in the pane, A again starts it** → lands on the CSS.
- [ ] **C-stick score binds** work (Z + C-left = the left name on the banner, C-right =
      the right one, C-down = undo, C-up held = end set) from **any controller port**. *Binds are C-stick, not D-pad —
      some players have no D-pad.*
- [ ] **"SCORE SENT"** confirmation appears after a report; **start.gg reflects the score**.
- [ ] END_SET closes the set on start.gg and returns to the set list.

## 7. CSS / SSS / in-match venue features (v22-v24, native)

- [ ] **D-pad UP/DOWN on the CSS toggles that port's rumble** *(venue code since 2026-09-24;
      the v23 selection-hand shake was ours and is retired)*. *A player who picks a nametag
      gets in-match rumble from the TAG's flag, not the port's (`gm_RumbleEnabledForPlayer`);
      that is stock Melee behaviour and the module does not touch it since v41.*
- [ ] **Set list has the backdrop AND the menu border** around it (v25). *v22 hid
      both (barren), v23 hid the panel; the panel is now hidden only during the boot
      warm-up and shown again the moment the set list is up. If the main-menu row
      text ever shows through behind the list, that is the panel's item children -
      hide those, not the whole panel.*
- [ ] **Nametags are stock (v41).** Open the tag dropdown on the CSS: the list is whatever
      is on the memory card, unchanged by starting a set, and **Name Entry (adding a custom
      tag) works** and returns to the CSS. *Until v40 the kiosk wrote the set's two tags into
      persistent nametag slots 0/1 at START_SET and read picked tags for who-is-who; adding a
      custom tag then crashed the CSS (user, 2026-09-30). Removed outright - the L + R claim
      is the only who-is-who. If Name Entry crashes again, it is not the module's doing.*
- [ ] **Auto-score at game end (v37).** Finish a game (KO or time-out) and, back on
      the CSS, the score line already counts it, `SENDING... / SCORE SENT` runs, and the
      status shows `GAME n TO <TAG>` for 5 s. *Read from the vanilla GS_VS exit data's
      MatchEnd (outcome + per-slot standings) in `lbTourney_MatchExit`, applied on the
      first CSS frame. Winner = more stocks, else less percent. Not scored, with the reason
      in the banner: LRA+Start (`NO CONTEST - NOT SCORED`), a handwarmer, not exactly
      two human players (`AUTO-SCORE NEEDS 2 PLAYERS`), no L + R claim from one of the two
      who played (`HOLD L+R TO AUTO-SCORE`), exact tie (`TIE - SCORE IT MANUALLY`). The C-stick binds remain for
      corrections - do NOT also flick after an auto-scored game (undo with Z + C-down if
      you did).*
- [ ] **Characters and stage reported (v38):** after an auto-scored game the start.gg
      set's game row shows both characters and the stage (check the set page or the
      relay audit log). *Filled from `MatchEnd.player_standings[].ckind` per entrant and
      `gm_GetStartMeleeRules()->stkind` at the VS exit; `game_result.stage` is the old pad
      byte (wire layout unchanged, header re-synced from protocol.yaml). A hand-scored
      correction sends zeros = winner only; the relay omits unmapped values rather than
      failing.*
- [ ] **Stocks and costume reported (v39):** after an auto-scored game the start.gg set
      page shows each entrant's stock icons in the right colour - a non-default costume
      must NOT show as the default, and the score field reads `(costume + 1) * 100 +
      stocks` (e.g. `203` = third colour, 3 stocks). *Stocks from
      `MatchEnd.player_standings[].stocks`; costume from `Player_GetCostumeId(slot)`, the
      fighter data the game spawned with. The first Wii set (2026-09-30) reported every
      costume as 0 (`10X`): the module read `players[]` behind `gm_GetStartMeleeRules()`,
      but that is the bare 0x60-byte rules at the end of `VsSceneController` with nothing
      after it, so the read landed in zeroed .bss. Fixed in the build after `34db7bd`.*
- [ ] **Joining the Wi-Fi is a wait, not a hang (v40):** power on with the Wi-Fi slow or
      refused (or the router off). The loader must get past `Slippi network init...` at once,
      Melee boots, and the Tournament screen pulses `JOINING THE WI-FI` with the pane dot
      `NO WI-FI`; B still returns to the menu. When the join completes the search continues
      on its own (`LOOKING FOR THE RELAY`, then the list). After 60 s without it: `THIS WII
      COULD NOT JOIN THE WI-FI / POWER CYCLE THE WII, THEN CHECK THE ROUTER`. With Network
      off in the loader: `NETWORK IS OFF IN THE LOADER` immediately. *Poll flag
      `PF_NET_JOINING` from Nintendont host build 2, whose kernel runs `NCDInit()` on its own
      thread; `TM_JOIN_FRAMES` in mntourney.c. Dolphin sends flags 0, so this is hardware-only.*
- [ ] **Who is who, inferred (v37, claim-only since v41):** with exactly two human doors,
      the L + R hold by the player named first places both (the other human door is the
      other entrant) - the score line shows both port labels after the one hold, and
      auto-score works off it. *`entrantPort`; CPU doors are ignored
      (`mnCharSel_PortSlotType`). Picked tags no longer count.*
- [ ] **Button icons in the overlays (v35).** The set-list hint bar reads
      `(A) START  (Z) FRIENDLIES  (Y) REFRESH  (B) MENU` with real GameCube-coloured
      button discs (A green, B red, X/Y light grey, Z purple square, L/R grey squares,
      Start grey pill, C-stick yellow), the confirm/error hints `(A) YES (B) BACK`, the
      filter line `(L) (R)`, and the CSS hint `(Z)+(X) WARMUP` / `(Z)+(X) CANCELS`
      (top-left corner, x 10 y -8, since 2026-09-25 evening - it was top-right beside BACK
      for a few hours; the short wording stays). *Mechanism (module era): 4 shape glyphs in a module-owned SIS font slot
      (index 4, `lbbuttonglyph_shapes.inc` from `kiosk/tools/gen_button_glyphs.py`, glyph codes
      0x4000-0x4003, installed into `HSD_SisLib_804D1124[4]` whenever a kiosk text context is
      created; icons drawn at 1.25x the text scale since 2026-09-24); `lbbuttonglyph.c` draws an icon as a coloured shape entry with the
      font's own letter over it, all positioned from the kerning table, and translates
      `+ ( ) / ! ?` to their SJIS pairs so callers write plain ASCII with `#A`-style
      markers. `lbButton_Measure` gives exact widths, so the title and hint bars are now
      centred by measurement, not by eye. Things to eyeball: letter centred in its disc,
      icon baseline level with the text, the hint bar not clipped at either edge, and
      the CSS hint in the top-left corner.*
- [ ] **The score is in the CSS's own rules banner** (the chevron box under MELEE / VS that
      vanilla fills with "4-man survival test!"): `MANGO P1  0 - 0  P3 ZAIN`, centred, shrunk
      to fit if long; it updates on every score change and is back to vanilla text in
      friendlies. *lbtourney.c writeBanner: font 0's premade slot 0x4A and the text bound to
      it are repointed at a module buffer (vanilla opcodes kept, then glyph codes 0x2000 +
      atlas index). Garbage glyphs = a wrong code table; crushed letters = the encoder's
      fixed-width "0A F4" run wrapped around letters; text stuck at "4-man survival test!"
      = the slot was not retaken after the CSS reloaded its archive.*
- [ ] **The banner is the status too (2026-09-25, review round 2; the bottom-left status
      line is gone):** score digits yellow, amber while a report is in flight, green for
      2 s after SCORE SENT, red after a failure; `SEND FAILED - TELL THE TO` (red)
      alternates with the score every 2 s until a send succeeds; `HANDWARMER - NOT SCORED`
      (amber) while the flag is armed; auto-score notes (`GAME 2 TO MANGO`, amber) for
      5 s. The hint and the in-match handwarmer clock keep their shadows. *The CSS scene's
      SIS pool is raised 9 -> 18 KB (`word 0x801A3F9C 0x38604800`), so a "Memory Empty"
      halt on the CSS means that hook.*
- [ ] **Port claim (2026-09-25, user requirement - tags are optional):** on the CSS with a
      set active, a human port holding **L + R for 1 s** (each trigger at its click OR
      any analog press, raw 49 of 140 (the user's light R press reads 50) - not every controller
      clicks) becomes the player named first on the set (banner `ALPHA IS P3` for 5 s); the other human port is the other player, so
      both port labels appear. **L + R + B** held 1 s clears it (`PORTS CLEARED`); the
      other controller holding L + R moves the claim (the undo). While nobody is placed
      the banner alternates every 2 s with `HOLD L+R IF YOU ARE <name>`. Once both ports
      are known the **lower port is on the left** (`BRAVO P1  0 - 0  P3 ALPHA`), and
      Z + C-left / C-right give the game to the left / right name AS SHOWN. Auto-score
      uses the claim over the tags. *`claim_port` in lbtourney.c, reset at START_SET and
      END_SET; `LB_TOURNEY_DEMO_CLAIM 1` fakes a claim by port 3 for the headless Dolphin
      loop (its slots stay N/A, so the demo also treats port 1 as human) - must be 0 in a
      shipped build.*
- [ ] **(superseded 2026-09-25: the score and status live in the banner and the hint is
      top-left) CSS overlay layout (v31, tuned live by the user):** score `MANGO P1  0 - 0  P3
      ZAIN` top centre (x 188, y -4, 0.62); hint `Z + X FOR HANDWARMER` (the `+` is the SJIS escape `{`, v34) bottom right
      (x 456, y 446, 0.43); status (`SENDING... / SCORE SENT / SEND FAILED`) bottom left (x 2,
      y 446, 0.45). (v32)
      *`ZX`, not `Z + X`: the SIS font has no `+` (nor `(` `)` `/`). History: v25-v29
      were placed by rebuild-and-look; v30 added **layout tune mode** so that never
      happens again; **compiled out since v33** (`LB_TOURNEY_LAYOUT_TUNE 0` in lbtourney.c -
      set it to 1 to get it back). With it on, on the CSS with a set active, hold **L + R**: D-pad nudges the
      selected element 2 px (10 with Z), **X** cycles SCORE / HINT / STATUS, **Y** grows
      the scale by 0.02 (shrinks with Z), and a mid-screen readout `TUNE SCORE X 212 Y 4
      S 52` shows the live values for 3 s. Read them off and hardcode them in `el[]`
      (lbtourney.c). The rumble D-pad toggle is suppressed while the chord is held.*
- [ ] **SIS vertical rule (found fixing the icon letters, v36):** a glyph drawn at
      entry scale s lands **32*(1-s) px below the entry's y**. Each entry pushes its
      scale opcode at its start and pops it at its end, so every entry is measured as a
      32-unit line at the text's default scale 1.0 and bottom-aligned to it. That is the
      "~12 px lower" seen at 0.63 and why the icon letters (scale 0.58*s) sat 13 px
      low in v35. Position two entries of different scale relative to each other with
      this rule, never by eye.
- [ ] **Z + X on the CSS starts a handwarmer straight away** when every present player
      is ready: no stage select, the game begins on **Battlefield** (user, 2026-09-25;
      a random legal stage before): the module's GS_SSS on_enter wrapper
      `lbTourney_SSSEnter` (hook `ptr 0x803DA9C8`) writes `force_stage_id = St_Kind_Battle`
      after `gm_80167FC4` has filled it from the rules, and the SSS skips itself on its
      first frame exactly as it does for a Random pick. A handwarmer on any other stage,
      or a stage select appearing, means that hook is missing. Not ready yet -> the press only arms/disarms the
      flag (banner `HANDWARMER - NOT SCORED`, top-left hint `Z+X CANCELS`), and Start goes
      through the SSS as usual. In the game a `HANDWARMER m:ss` clock counts up **in the
      top-left corner** and **turns red past 1:00**, and **the HUD's own countdown is
      hidden** (v27, `ifTime_HideTimers()` re-asserted after every vanilla frame; the
      match timer still runs underneath, so the 8:00 limit still ends the game). Back on
      the CSS the flag is **cleared automatically**. *Informational: the C-stick score binds still decide
      what is scored. `forceKioskDefaults` pins `stage_sel = 0` so a memcard with
      "random stage" mode cannot skip the SSS for real games.*
- [ ] **SSS legal-stage filter** *(venue code - VERIFY)*: the v25 six-only filter
      (`sssIsLegal`, hidden/unhoverable icons) was ours and is retired; the random set is still
      the six legal stages via `stage_mask`. Check what the venue's striking code shows on the
      SSS and rewrite this row to match; update the poster if the six-only claim is no longer true.
- [ ] **Stage striking** *(venue code since 2026-09-24)*: X over a stage strikes it
      (works, 2026-09-24). **VERIFY that Z brings every struck stage back**: the venue code's
      SSS hook tests only pad masks 0x400 (X) and 0x10 (Z); the poster says Z resets. The old
      Y reset was ours and is gone.
      *History: v24-v26 native striking in `mnstagesel.c` (hover outline bug, Y reset).*
- [ ] **Sheik's nametag vanishes during Vanish** (up-B) *(venue code - the stealth
      nametag hook in `g_mods_tournament.bin`, verified 2026-09-24)*. *Our `ifnametag.c` edit
      is retired.*

## 8. Dolphin (development setup)

Only for testing the module in the patched Slippi Dolphin kept as a separate development
setup. Paths are inside that Dolphin's folder. Venue Wiis never run it.

- [ ] **Dolphin picked up the new file**: `SlippiTournamentModule` in
      `User/Config/Dolphin.ini` points at `kiosk/build/tournament.bin`
      and `HLE_BS2 = True`; restart the game after every build (the module is read at boot).
      *An old module + new expectations looks exactly like a silent no-op.*
- [ ] **Gecko list is the generated one**: `Data/Sys/GameSettings/GALE01r2.ini` (and
      the `Binary/x64/Sys` copy) from `Tools/make_venue_ini.py` - `[Gecko_Enabled]` =
      `Required: Slippi Recording`, `Venue: UCF 0.84`, `Venue: Tournament Mods`, nothing else.
      *Slippi's General Codes / Slippi Online blank the kiosk text and run the netplay CSS
      (2026-09-24); a `[creator]` suffix on an enabled name silently disables it.* `EnableCheats
      = True` and no per-ISO `User/GameSettings/GALE01.ini` override.
- [ ] **No "missing memory card" popup.** *Slot A = Memory Card, Slot B = the relay EXI
      device. This is config, not a code hack (the game edit was reverted).*

History: before 2026-09-24 this list was run per `SmashTournament-vN.iso` (the retired
shifted-DOL build).
