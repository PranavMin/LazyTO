This is the LazyTO relay (docs/architecture.md, section Relay).
Node 22, TypeScript, no framework. generated/wire.ts is GENERATED from protocol.yaml by tools/gen_protocol.py — import it from src/, never copy or hand-edit it.
Principles: one path, no fallbacks, no retries except start.gg 5xx (max 2). Two accepted exceptions (src/app.ts): without valid settings the relay serves only its setup page, and a set-up relay whose event can't be resolved keeps its page up with the reason and tries again (30 s, 60 s, then every 2 min). Settings (src/config.ts): a new field must be optional with a default, so an update never stalls a Pi.
npm test must pass. Integration tests use test/fake-startgg.ts, never the real API.
Nothing in this repo touches the real start.gg API except the relay itself. The maintainer's own tools (read-only lookups, test-bracket resets, pushing an unmerged build to a Pi, writing SD cards from local builds, Dolphin) live in a private repo checked out as private/ (git-ignored), with its own README.

kiosk/ is the Wii-side module (lazyto_kiosk.bin, docs/kiosk.md): C for Melee's MWCC, built by `python kiosk/tools/build_module.py` against the unmodified decomp in the melee/ submodule. Never edit melee/; fix breakage in kiosk/.
Kiosk rules: hooks only through kiosk/tools/module_hooks.txt; vanilla addresses come from melee/config/GALE01/symbols.txt; kiosk/include/relay_proto.h, kiosk/src/melee/lb/lbbuttonglyph_shapes.inc and lbwordmark_tex.inc are generated (docs/kiosk.md), never hand-edit them. No malloc, no string parsing, all buffers static. Hook where the behaviour happens. If the build breaks, fix the cause.
Nintendont/ is the loader fork (branch LazyTO); its own CLAUDE.md applies inside it.
