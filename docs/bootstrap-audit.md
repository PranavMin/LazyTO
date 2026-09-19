# Bootstrap audit — vs sessions.md §0

Audited 2026-09-19. Status legend: ✅ done · ❌ not done · ⚠️ wrong. Items marked **[fixed this session]** were corrected on 2026-09-19 during setup.

## 1. Repos and git state

- ⚠️ → ✅ **`tournament-reporter` was not a git repo** — it was an untracked folder inside the repo rooted at `P:\Projects`. **[fixed this session]**: `git init -b main`, initial commit `58e174a`, pushed to a fresh **private** repo `https://github.com/PranavMin/tournament-reporter` (remote `origin`, `main` tracking).
- ⚠️ **`P:\Projects` itself is a git repo** — a clone of `joaorb64/TournamentStreamHelper` (branch `main`) with ~3780 files deleted in the working tree (the TSH files appear to have been moved into the untracked `TournamentStreamHelper\` subfolder) and 22 untracked top-level folders (all your other projects). Out of scope per your instruction; flagged only because every new folder created in `P:\Projects` shows up as untracked there. Suggested fix when you want it: move the TSH clone's `.git` into `P:\Projects\TournamentStreamHelper\` (or re-clone there) and delete `P:\Projects\.git` so `P:\Projects` is a plain folder. **Not touched.**
- ❌ → ✅ **GitHub repo**: neither `PranavMin/tournament-reporter` nor `PranavMin/setcall-relay` existed (nothing to rename — §0's rename step assumed `setcall-relay` existed; it doesn't). **[fixed this session]**: created fresh as private.
- ❌ → ✅ **`melee` fork**: did not exist on GitHub or on disk. **[fixed this session]**: forked to `PranavMin/melee`, cloned to `P:\Projects\melee`, `upstream` = doldecomp/melee, branch `reporter` created and pushed with `CLAUDE.md` + `include\relay_proto.h` (configure.py already passes `-I include`).
- ❌ → ✅ **`Nintendont` fork**: did not exist on GitHub or on disk. **[fixed this session]**: forked to `PranavMin/Nintendont`, cloned to `P:\Projects\Nintendont`, `upstream` = project-slippi/Nintendont, branch `reporter` (off `slippi`) created and pushed with `CLAUDE.md`.
- ❌ **`Ishiiruka` fork**: does not exist. Expected — sessions.md §7 says to create it at session 7, not bootstrap. No action needed.
- ℹ️ **Location differs from §0**: the runbook says the project root is `P:\Projects\Automated Tournament Reporter\`, but the real layout is `P:\Projects\tournament-reporter` with forks as siblings in `P:\Projects`. The relative paths the runbook relies on (`../tournament-reporter/docs/design.md`) still work with this layout. Leftovers in `P:\Projects\Automated Tournament Reporter\`: a stale older `design.md`, empty `generated\` and `tools\` (only `__pycache__`), no `incoming\`. Fix: delete the folder once you confirm nothing in it is needed.

## 2. tournament-reporter layout vs §0

- ✅ `protocol.yaml` at root
- ✅ `docs\design.md`, `docs\sessions.md`
- ✅ `tools\gen_protocol.py`, `tools\check_protocol.py`
- ✅ `generated\relay_proto.h`, `generated\wire.ts`
- ✅ empty `src\`, `test\`, `scripts\`
- ✅ `.gitignore` with exactly `.env`, `node_modules/`, `__pycache__/`, `dist/`
- ✅ extra: `.gitattributes` pinning LF on generated files — deliberate (keeps `check_protocol.py` diffs clean on Windows), keep it
- ✅ **`python tools\check_protocol.py` passes**: "generated/ is up to date with protocol.yaml"

## 3. CLAUDE.md and .env

- ❌ → ✅ `tournament-reporter\CLAUDE.md` missing. **[fixed this session]**: written with the session-2 content from the runbook.
- ❌ → ✅ `.env` missing. **[fixed this session]**: created with empty `STARTGG_TOKEN`, `EVENT_ID`, `STREAM_ID`, `TEST_SET_ID` — **you still need to fill it** (start.gg test tournament + developer token, §0 hand-step 2).
- ✅ `.env` is gitignored (verified with `git check-ignore`).
- ❌ → ✅ Fork `CLAUDE.md` files (melee ← session 5 block, Nintendont ← session 3 block). **[fixed this session]**

## 4. Remaining §0 steps

- [x] §0 step 5: **done 2026-09-19** — `main.dol` extracted from the user's GALE01 v1.02 ISO (SHA-1 verified `08e0bf20...`), `python configure.py` + `ninja` (pip-installed, `%APPDATA%\Python\Python314\Scripts`) → `build/GALE01/main.dol: OK`, 100.00% matched/linked. `orig/` contents are gitignored; nothing game-derived is committed.
- [x] `.env`: token (user), `EVENT_ID=1613010` (Melee Singles! 7:30 Start), `STREAM_ID=1358079` (TWITCH/SFMelee; alt sidestream=1358080). Tournament id 905882.
- [x] `TEST_SET_ID=107949994` (Alpha vs Papa, pool 1 of the Bracket phase, pending). **Done 2026-09-19**: real attendees were replaced with 16 unlinked dummies (Alpha…Papa, Melee Singles only), the stale April bracket was reset, pools re-seeded and saved, and pool 3290148 started via `markSetInProgress` on its preview set (then `resetSet` back to pending). Pool 2 (3292311) is intentionally left unstarted — useful for testing the relay against preview-id sets.
