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
2. Never set the developer flags in the sources: build with `--demo` for a headless Dolphin
   run instead (`docs/kiosk.md`). CI fails on a non-zero default,
   and the version text of a `--demo` module ends in `DEMO`.
3. Do not write C source through a Bash heredoc on this machine: backslash escapes collapse
   (`\x81` becomes a raw byte). Use the Edit or Write tool.

## Build

```bash
python kiosk/tools/build_module.py
```

Run from the repo root. Output: `kiosk/build/tournament.bin`. Windows only.

The build uses no `main.dol`: hook addresses are checked against `splits.txt` and the guard
word is the constant `GUARD_WORD`. CI's `kiosk` workflow runs the same build and uploads
`tournament.bin` as the `tournament-bin` artifact; on every push to `main`, `release.yml` puts
it in the `main-build` bundle.

Read the tail of the output:

- the applied patch list (one line per `module_hooks.txt` entry),
- `guard: 0x8016D800 == 0x7C0802A6`,
- the file size. It must stay under 100 KB (load address 0x817E0000, FST at 0x817F8AC0).

A failed external resolution or a gecko overlap stops the build and names the symbol or
address. A missing venue codeset in `Nintendont/kernel/gecko` also stops it: run
`git submodule update --init`.

First-time setup (only if `melee/build/compilers` is missing): `git submodule update --init`,
`pip install ninja`, then `python kiosk/tools/fetch_decomp_tools.py`. No `main.dol` needed.

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
- Test in Dolphin, then on a Wii ([docs/development.md](../../../docs/development.md) "Testing on a Wii").
- When a new build bug is found and fixed, add a row to `docs/kiosk-checklist.md` with the
  symptom and the usual cause.
- A crash address from a Wii log resolves with `python kiosk/tools/resolve_crash.py <address>`.
