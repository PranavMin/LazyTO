---
name: kiosk-build
description: Build the kiosk module (kiosk/build/tournament.bin) with preflight checks, read the build output, and handle hook changes in kiosk/tools/module_hooks.txt. Use whenever kiosk/ C sources or hooks change, before a Dolphin or Wii test, or when the build breaks.
---

# Build the kiosk module

The module is C for Melee's MWCC, built against the unmodified decomp in `melee/`.
Full reference: `docs/kiosk.md`. Per-build QA: `docs/kiosk-checklist.md`.

## Rules

- Never edit `melee/`. Fix breakage in `kiosk/`.
- Never hand-edit generated files: `kiosk/include/relay_proto.h`,
  `kiosk/src/melee/lb/lbbuttonglyph_shapes.inc`, `kiosk/src/melee/lb/lbwordmark_tex.inc`,
  `kiosk/src/melee/lb/lbmodule_version.inc`. Their generators are listed in `docs/kiosk.md`.
- Never hand-edit `tournament.bin`.
- No malloc, no string parsing, all buffers static.
- If the build breaks, fix the cause. Do not work around it.

## Preflight

1. Scan edited C and header files for non-ASCII bytes. MWCC reads source as Shift-JIS and
   sjiswrap rejects em dashes and smart quotes. Use the Grep tool with pattern `[^\x00-\x7F]`
   on `kiosk/src` and `kiosk/include`. Fix every hit.
2. Check the developer flags. Grep for
   `#define (TM_DEMO_AUTOSTART|LB_TOURNEY_DEMO_CLAIM|LB_TOURNEY_TRIGGER_READOUT)\s+[1-9]`
   in `kiosk/src`. A non-zero flag is correct only for a headless Dolphin run (see the
   `dolphin-test` skill). It must be `0` before a commit or an SD card.
3. Do not write C source through a Bash heredoc on this machine: backslash escapes collapse
   (`\x81` becomes a raw byte). Use the Edit or Write tool.

## Build

```bash
python kiosk/tools/build_module.py
```

Run from the repo root. Output: `kiosk/build/tournament.bin`. Windows only.

`--check` builds without `main.dol` (what CI's `kiosk` workflow runs): same compile, link and
checks, minus the DOL address and guard checks, and no `tournament.bin`. Never use it for a
module you will test or ship.

Read the tail of the output:

- the applied patch list (one line per `module_hooks.txt` entry),
- `guard: 0x8016D800 == 0x7C0802A6`,
- the file size. It must stay under 100 KB (load address 0x817E0000, FST at 0x817F8AC0).

A failed external resolution or a gecko overlap stops the build and names the symbol or
address. A missing venue codeset in `Nintendont/kernel/gecko` also stops it: run
`git submodule update --init`.

First-time setup of `melee/` (only if `melee/build` is missing): vanilla `main.dol` at
`melee/orig/GALE01/sys/main.dol`, then `python configure.py --non-matching` and
`python -m ninja` inside `melee/`. `ninja.exe` is not on PATH; use the pip package.

## When on-screen text looks jammed or stale

Delete `kiosk/build/obj/` and rebuild. A stale object once rendered mixed old and new strings.

## Hook changes

- Hooks go only through `kiosk/tools/module_hooks.txt`: `ptr`, `branch` or `word` lines.
- Vanilla addresses come only from `melee/config/GALE01/symbols.txt`.
- Hook where the behaviour happens. A documented matched edit beats an indirect hook.
  Never patch spawn-time behaviour with a post-spawn data hook.
- Before a `branch` hook, check that the function is not inlined at its callers. If it is,
  patch the inlined jump tables with `word` lines instead (`mn_8022C010` was inlined).
- The builder refuses any address a Nintendont gecko codeset also writes, because gecko
  applies after the module and would win silently. Do not reimplement venue codeset
  behaviour (UCF, spawns, striking, stealth tags, rumble, music/mono).

## After the build

- Version text on the set list ends in `+` when the tree is dirty.
- Test in Dolphin with the `dolphin-test` skill, then on hardware with the `wii-test` skill.
- When a new build bug is found and fixed, add a row to `docs/kiosk-checklist.md` with the
  symptom and the usual cause.
- A crash address from a Wii log resolves with `python kiosk/tools/resolve_crash.py <address>`.
