# lazyto-bundle: RR goldens small enough for LazyTO's test/

Everything here except `tools/` is generated, mostly by Replay Reporter for Slippi's own code; never hand-edit it. The RR code is jmlee337/replay-manager-for-slippi v2.7.0 at `708b9c912ba92d46aa52e59cc8d91cd6d97a5d2c`, MIT licence. It runs either as `rr-ref/src/rr`, a verbatim copy (see `rr-ref/VERBATIM.md`), or straight from the clone for `startgg.ts`.

The bundle is meant to be copied into LazyTO's `test/rr-conformance/`. `CONFORMANCE-TEST-PLAN.md` says how the tests use it.

| Path | Files | Bytes | What it is |
|---|---|---|---|
| `replays/` | 7 | 9,449 | The 7 real Wii replays (`inputs/replays/`) cut down by `tools/trim.mjs` to what RR reads: the header, Event Payloads, Game Start, the whole last frame through Game End, and the metadata. RR's parse of each equals its parse of the full file (`parse.json`). |
| `full/` | 1 | 166,453 | One untrimmed replay (`…223403.slp`, the smallest), for a parse test on a complete file. Optional. |
| `fixtures/` | 11 | 48,114 | RR renderer-state inputs. `01`-`07` are `inputs/fixtures/` unchanged. `06r` and `06z` are fixture 06 reported with a numeric id, with and without `completedAt`. `08` and `09` take their start.gg side from `rest/` through RR's own start.gg code. |
| `golden/<fixture>/` | 67 | 164,061 | `expected.json` (11 files, 71,685 B), `context.json` (11 files, 17,220 B, the exact bytes), `game-N.slp` (34 files, 46,304 B, RR's exact output .slp) and `rr.zip` (11 files, 28,852 B, RR's zip, clock frozen, TZ=UTC). The real zip and entry names (CJK, emoji, `$`, `{}`) are in `expected.json`, so every file name in the bundle is ASCII. |
| `parse.json` | 1 | 13,003 | RR's `getReplaysInDir` result for each replay: lastFrame, startAt, stage, and per port the type, character, stocks, percent and isWinner. |
| `vectors/display-names.json` | 1 | | 13 cases: the Game Start bytes `0x1A5`-`0x249` after RR's `writeReplays` wrote display names on all four ports. Covers Shift-JIS, trail-byte remapping, astral characters, controls, the exact 31-byte case, and overflow into the next port and into the connect codes. |
| `vectors/sanitize.json` | 1 | | 31 cases of sanitize-filename 1.6.3. Both vector files together are 21,660 bytes. |
| `ordinals/` | 8 | 28,397 | Synthetic REST phase-group responses (`*.input.json`) and the `{setId: ordinal}` that RR's `getPhaseGroup` computes from them (`*.expected.json`). Cases: DE with the reset reachable, the same with it unreachable (everything falls back to `callOrder`), a DE pool with progressions, and SE. |
| `rest/<08,09>/` | 12 | 26,584 | REST tournament, event, phase and phase-group responses for the end-to-end cases; `graphql.json`, the GraphQL answers the stub gave RR; and `rr.json`, RR's location, chain, selected Set with its ordinal, the requests RR made, and every ordinal in the group. |
| `index.json` | 1 | 3,429 | One line per fixture. |

Without `tools/` and `full/`, and counting this file: 110 files, 319,101 bytes.

**Inferred shapes.** The REST JSON in `ordinals/` and `rest/` was authored from what RR's code reads (`startgg.ts:451-1075`); no real response was fetched. RR's results on it are exact. Whether start.gg's live responses look the same is `GAP-LIST.md` D5.

## Regenerating

You need the RR clone at `scratchpad/ext/replay-manager-for-slippi` (708b9c9) and `rr-ref/node_modules` (`npm ci` in `rr-ref`). Nothing here contacts start.gg: the start.gg tools replace `fetch` with a stub that serves only local files and throws on anything else.

```
cd lazyto-bundle
for f in ../inputs/replays/*.slp; do node tools/trim.mjs "$f" "replays/$(basename "$f")"; done
node tools/make-ordinal-inputs.mjs
cd ../rr-ref
npx tsx ../lazyto-bundle/tools/make-ordinals.ts      # ordinals/*.expected.json
npx tsx ../lazyto-bundle/tools/make-e2e.ts           # rest/<case>/*.json, rr.json
npx tsx ../lazyto-bundle/tools/make-bundle.ts        # fixtures/, golden/, parse.json, index.json
npx tsx ../lazyto-bundle/tools/make-vectors.ts       # vectors/
```

`make-bundle.ts` fails unless all of the following hold for fixtures 01-07:
- each zip name, set of entry names and `context.json` (byte for byte) equals `../golden/<fixture>`, which was made from the full replays;
- each trimmed output .slp, with the dropped middle of its raw element restored from the full input, equals the full golden .slp byte for byte.
