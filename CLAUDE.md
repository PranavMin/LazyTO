This is the LazyTO relay (docs/architecture.md, section Relay).
Node 22, TypeScript, no framework. generated/wire.ts is GENERATED from protocol.yaml by tools/gen_protocol.py — import it from src/, never copy or hand-edit it.
Principles: one path, no fallbacks, fail fast at startup on bad config, no retries except start.gg 5xx (max 2).
npm test must pass. Integration tests use test/fake-startgg.ts, never the real API.
The real API is touched only by scripts/probe.ts (read-only lookups) and scripts/reset-bracket.ts (resets the test event named by EVENT_ID), both using .env (gitignored).

kiosk/ is the Wii-side module (tournament.bin, docs/kiosk.md): C for Melee's MWCC, built by `python kiosk/tools/build_module.py` against the unmodified decomp in the melee/ submodule. Never edit melee/; fix breakage in kiosk/.
Kiosk rules: hooks only through kiosk/tools/module_hooks.txt; vanilla addresses come from melee/config/GALE01/symbols.txt; kiosk/include/relay_proto.h, kiosk/src/melee/lb/lbbuttonglyph_shapes.inc and lbwordmark_tex.inc are generated (docs/kiosk.md), never hand-edit them. No malloc, no string parsing, all buffers static. Hook where the behaviour happens. If the build breaks, fix the cause.
Nintendont/ is the loader fork (branch LazyTO); its own CLAUDE.md applies inside it.
