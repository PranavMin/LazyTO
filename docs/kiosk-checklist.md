# New-version check-yourself list

Manual checks to run **every time a new `lazyto_kiosk.bin` is built** (the kiosk module
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
      (30 since the record gate, among them `ptr 0x803DA950 ... lbTourney_MatchEnter`) and
      ends with `guard: 0x8016D800 == 0x7C0802A6` and the `.bin` size (~88 KB, under 100 KB).
      *A failed external resolution or a gecko overlap stops the build with the
      symbol/address named - never hand-edit `lazyto_kiosk.bin`.*
- [ ] **No non-ASCII in edited C files** before building (scan for em-dash U+2014,
      smart quotes, etc.). *MWCC parses source as Shift-JIS and errors on them.*
- [ ] If any on-screen text looks jammed/wrong after an edit, **delete `kiosk/build/obj/*.o`** and
      rebuild. *A stale `mntourney.o` once rendered "STARTPapa VS Hotel" / wrong confirm text.*
- [ ] For hardware: copy `lazyto_kiosk.bin` to the SD card root (protocol v2: no station file;
      the station number and the secret are the beamer's); the Nintendont boot log must show
      the module line *and* `Patch:Apply Slippi core`.

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
- [ ] **The LazyTO title is the wordmark texture** (renamed from TOURNAMENT 2026-09-30) (bold italic, drop shadow) in the
      panel's top-left title tab, not SIS text; it survives redraws and disappears on B-back
      to the main menu. *`lbwordmark.c` + `lbwordmark_tex.inc` (the texture is checked in; the
      generator is a maintainer tool outside the repo, docs/kiosk.md). Invisible wordmark = one of the two `lb_800138EC` traps: its camera priority
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
      pulses for 10 s, then `BEAMER HEARS NO RELAY` / `NO BEACON FOR 10 SECONDS` / `IS THE
      LAPTOP ON THIS WI-FI?` with a red `NO RELAY` dot; A searches again. *The module peeks
      `exi_poll_hdr` first (`lbRelayExi_Peek`, `searchStep` in mntourney.c) and sends
      LIST_SETS only once the beamer is ready and `relay_ip` is known, so a cold boot never
      greets players with an error. In Dolphin the beacon listener starts on the first EXI
      command, so the very first boot after launch may search for up to 2 s.*
- [ ] **Confirm / error stay in the frame:** A dims the list and asks `START THIS SET?` in
      the pane with both tags and `A YES  B BACK`, the hint bar says CHECK BOTH TAGS FIRST;
      a dead relay shows `NO LINK TO THE RELAY` + the message (`THE RELAY DID NOT ANSWER`,
      `CONNECT TO THE LAPTOP FAILED`, ...) + `YOUR LIST IS STILL HERE` or `NO SETS LOADED
      YET` + the hint, and the pane shows `STATION n / RELAY / a.b.c.d / PORT p` with a red
      `NO LINK` dot. A relay-reported error says `THE RELAY SAID NO` / `REFUSED`; a
      shared-secret mismatch `RELAY SECRET MISMATCH` / `THE BEAMER HAS ANOTHER SECRET` /
      `BAD SECRET` (decisions.md R16); a second beamer on a taken number `TWO BEAMERS ARE
      STATION n` / `RENUMBER ONE WITH ITS BUTTON` / `DUPLICATE`. *Station/relay come from
      `exi_poll_hdr`, which the kernel/forwarder fill on every poll; Dolphin shows station 0
      (decisions.md R10), hardware `STATION -` while the beamer has no number. The words are
      picked in `whyFailed` (mntourney.c). The confirm view has not been captured in the dev
      loop (no controller input there) - eyeball it on the Wii.*
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
hide, D-pad rumble toggle; `g_gameplay_both.bin`: LGL and anti-wobbling, set by the station
cards since 2026-10-07) - on hardware by the venue's MeleeCodes toggles, in Dolphin by the
same bytes converted into `GALE01r2.ini`. Our old native ports (`lbucf.c`, `lbneutralspawn.c`) and the
`mnstagesel.c`/`ifnametag.c` edits live only on tag `shifted-dol-final`. History of why they existed: `melee fork, docs/history/ucf-investigation.md`,
`melee fork, docs/history/ucf-readdressing.md`, `melee fork, docs/history/venue-codes-readdressing.md`, and the changelog's 2026-09-21 and 2026-09-24 entries.

- [ ] **UCF feels right** *(venue code)*: dashback, shield-drop, wiggle-out-of-tumble behave
      like UCF 0.84.
- [ ] **Neutral spawns** *(venue code)*: on Battlefield a 2P match starts on the **left and
      right side platforms**, not centre/top. FoD `+/-41.25` on the side platforms is the venue's
      real value, not a bug.
- [ ] **A `.slp` is written for every set game, and only for those** (Wii: the beamer, with a
      loader whose `host_build` is at least 7, the record gate). Friendlies, a Z + X
      handwarmer, LGL's tiebreak game and a match started from the vanilla main menu leave
      no file; the next set game is still recorded. *`lbTourney_MatchEnter` (`ptr
      0x803DA950`) sets the gate's `want` around vanilla `gm_Scene_Vs_OnEnter` (docs/kiosk.md,
      The record gate). If set games stop being recorded, check the hook is in the patch
      list, then that a patch is not colliding with the Slippi core codes -
      `build_module.py` checks overlaps at build time, so look for a changed codeset first.
      Dolphin has no gate (`host_build` 0): it records by its own `SlippiReplayDir`
      settings.*
- [ ] **Nothing of ours in the DOL**: the Nintendont boot log shows no "Tournament build ...
      skipping" line (that gate is reverted); Dolphin's ISO properties show the plain 1.02 image.

## 5. Relay & start.gg (before the game can list anything)

- [ ] **Relay is running** and its status page loads: http://localhost:29473 .
      *Restart it after a machine reboot.*
- [ ] Status page shows **`Cache: N sets` with N > 0**, and **no "could not be started"
      warning**. *The relay starts a pool itself once one of its preview (string-id) sets
      has both players (R8); the warning means start.gg refused, so start that pool by hand.*
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
      MatchEnd (outcome, per-slot standings, the game's own `winners[]`/`n_winners`) in
      `lbTourney_MatchExit`, applied on the first CSS frame. Winner = the game's: with the
      card's Gameplay: Both (LGL) that is the player ahead on stocks, then less percent,
      unless that player is over the ledge-grab limit and the other is not (since 2026-10-07;
      before, the kiosk recomputed stocks then percent itself). Not scored, with the reason in
      the banner: LRA+Start (`NO CONTEST - NOT SCORED`), a handwarmer, not exactly two
      players or a CPU in the game (`AUTO-SCORE NEEDS 2 PLAYERS`), Team battle on (`TEAMS ON -
      SCORE BY HAND`), no L + R claim from one of the two who played (`HOLD L+R TO
      AUTO-SCORE`), both over the limit with one ahead (`BOTH OVER LGL - SCORE BY HAND`), a
      time-out tied on stocks but not on percent on a card with Gameplay Off or Wobbling
      (`LGL OFF - SCORE BY HAND`). The C-stick binds remain for
      corrections - do NOT also flick after an auto-scored game (undo with Z + C-down if
      you did).*
- [ ] **Ledge-grab limit (2026-10-07):** a time-out where the player ahead on stocks has
      grabbed the ledge more than the limit (45 at 8:00; it scales with the timer, 5 at
      1:00) and the other has not: the other player is scored, the banner
      reads `GAME n TO <TAG> - LGL`, and the start.gg game has the characters and stage but
      no per-game score. Both over the limit with one ahead: `BOTH OVER LGL - SCORE BY
      HAND`, nothing appended. *LGL is a codeset (`g_gameplay_both.bin`); the module only
      reads `winners[]`. A Dolphin run without Gameplay: Both in its ini plays with the
      limit off and shows `LGL OFF` instead.*
- [ ] **Tiebreak game (2026-10-07):** an exact tie at a time-out (nobody moves, 0% each) or
      a double KO on the last stocks: the game plays LGL's tiebreak (1 stock, 0%, 3:00), and
      back on the CSS the score counts ONE game, to the tiebreak's winner (`GAME n TO
      <TAG>`). A tiebreak that ties again: `TIE - SCORE IT MANUALLY`, nothing appended.
      The game is reported with the main game's replay id (the relay log shows it), and no
      second `.slp` appears for the tiebreak. *Scored by `lbTourney_TiebreakExit` (`ptr
      0x803DA968`, the GS_SUDDEN_DEATH exit), armed only by a set game's tie; the tiebreak's
      scene does not touch the record gate, so the main game stays the set's last match.*
- [ ] **Replay ids in the reports (record gate):** on a Wii with a beamer, every auto-scored
      game's `game_result.replay_id` names its `.slp` (`Game_<MAC>_<UTC stamp>.slp` on the
      beamer; the relay log and the set archive show the binding), with both ports. A game
      scored by hand after a recorded match takes that match's id once: flicking the same
      game twice gives the second copy 0, undo (Z + C-down) frees the id, and a hand-scored
      handwarmer gets 0. Dolphin reports 0 throughout. *`lastMatchReplay` in lbtourney.c,
      read from the gate's `file_seq` / `file_id` when the game is appended.*
- [ ] **Beamer card full on the CSS and the set list:** with the beamer's storage FULL (or
      a card fault), the CSS banner alternates with `REPLAYS NOT SAVING - TELL THE TO` (red)
      every 2 s and the set list's pane shows a red `REPLAYS NOT SAVING` instead of READY /
      PLAYING HERE; play is not blocked. FILLING shows nothing. Unplugging the beamer
      mid-set makes the banner say `WAITING FOR THE BEAMER` (amber) while the kernel reports
      it starting. *Both screens peek `exi_poll_hdr` every 2 s while idle; hardware only
      (Dolphin sends 0).*
- [ ] **B from the set list leaves the set:** start a set, go back to the list with B on
      the CSS, then B again to the vanilla main menu and start a VS match from there: no
      score banner, nothing scored, nothing recorded. Z back into the list shows the set as
      PLAYING HERE, and A RESUME starts it again (at 0-0 on the Wii: the resume gap N3 in
      redesign.md). *`exitToMainMenu` calls `lbTourney_ClearCurrent`.*
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
- [ ] **The beamer's state on the search screen (protocol v2; the Wii's own network is not
      used):** each wait pulses with B back to the menu and a pane dot, each error is
      immediate with A to retry. Waits: boot or replug the beamer: `WAITING FOR THE BEAMER` /
      `IT MAY BE STARTING OR ERASING` (dot `STARTING`), until the kernel finds it or, after
      about 45 s, names the reason; a beamer without a number: `THIS BEAMER HAS NO NUMBER` /
      `PRESS THE BEAMER BUTTON` (dot `NO NUMBER`), until the first click; Wi-Fi joining:
      `BEAMER JOINING THE WI-FI` (dot `JOINING`), then after 60 s `BEAMER STILL JOINING
      WI-FI` / `STILL JOINING AFTER 60 SECONDS`. Errors (title / hint / dot): replays off or
      the game not on SD `REPLAYS ARE OFF IN THE LOADER` / `TURN ON REPLAYS, GAME ON SD` /
      `NO BEAMER`; no drive `NO BEAMER ON THIS WII` / `PLUG THE BEAMER INTO THIS WII`; a
      plain stick or `LAZYTO` off `NOT A LAZYTO BEAMER`; old firmware `UPDATE THE BEAMER` /
      `OLD BEAMER`; a newer mailbox `UPDATE THE SD CARD` / `OLD CARD`; no secret `THE
      BEAMER HAS NO SECRET`; Wi-Fi `NO WI-FI NAME ON THE BEAMER`, `THE BEAMER CANNOT JOIN
      WI-FI`, `THE WI-FI GAVE NO ADDRESS`, `THE BEAMER RADIO FAILED` (dot `NO WI-FI`); a
      stale beacon after a failed request `BEAMER HEARS NO RELAY`. A request that fails over
      USB says `NO LINK TO THE BEAMER`; a stalled USB cycle `TIMEOUT - RELAY NOT ANSWERING`
      with the beamer card's state as the hint. Every title fits the list panel (a long one
      shrinks) and no line loses characters. *`searchStep` / `whyFailed` in mntourney.c, in
      the check order of docs/protocol-v2.md. Dolphin sends 0 in every field, so this is
      hardware-only; the texts need the LazyTO kernel with mailbox v2.*
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
      END_SET; a `build_module.py --demo` build fakes a claim by port 3 for the headless
      Dolphin loop (its slots stay N/A, so the demo also treats port 1 as human).*
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
