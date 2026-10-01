This is the LazyTO relay (docs/architecture.md, section Relay).
Node 22, TypeScript, no framework. generated/wire.ts is GENERATED from protocol.yaml by tools/gen_protocol.py — import it from src/, never copy or hand-edit it.
Principles: one path, no fallbacks, fail fast at startup on bad config, no retries except start.gg 5xx (max 2).
npm test must pass. Integration tests use test/fake-startgg.ts, never the real API.
The real API is touched only by scripts/probe.ts using .env (gitignored).
