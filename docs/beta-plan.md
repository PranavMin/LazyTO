# LazyTO beta plan

Goal: anyone with the setup docs can run a weekly without the author present.
Exit: two consecutive weeklies with zero manual start.gg edits and no card reflash mid-night, then tag v1.0.0.

## 1. Hardware verification (blocks release)

- [ ] Full set lifecycle on a real Wii: START, L+R port claim, auto score, END, set completes on start.gg.
- [ ] `.slp` written to USB; recording survives unplug/replug.
- [ ] Venue striking code: Y un-strike, stage select limited to six legal stages, Frozen Stadium parity with the Dolphin ini.
- [ ] Loader shows "UCF 0.84" after the 2026-09-30 upstream sync.
- [ ] Wi-Fi association flake (one boot in four): retest on a Pi access point.
- [ ] Relay on a real Pi, overnight soak with `npm run sim`.
- [ ] Dress rehearsal: 2 Wiis, Pi, test tournament, start to finish.

## 2. GitHub organization (user account, all repos public)

- [x] Relay repo public (forks already were).
- [x] Descriptions, topics and homepage on all four repos.
- [x] Fork READMEs: a header naming the LazyTO changes and the upstream sync procedure.
- [x] Umbrella README in this repo: what each repo does, how they fit.
- [x] Default branch `vanilla-module` on the forks; stale branches pruned, `shifted-dol-final` kept as a tag.
- [x] CI on this repo: `npm test` on push and PR, Node 22; protect `main`.
- [ ] Decide renames (repo `tournament-reporter`, Pi service name) once, before docs cleanup.

## 3. Branding

- [ ] Homebrew app metadata (`meta.xml`: name, coder, version, short/long description) and icon.
- [ ] Replace the Slippi logo in the Nintendont loader with a LazyTO logo.

## 4. Cleanup

- [ ] Review all documentation for accuracy against the shipped build.
- [ ] Split `docs/design.md`: architecture and protocol stay; R1-R16 to `decisions.md`; dated progress to `changelog.md`; `sessions.md`, `bootstrap-audit.md`, upstream-sync notes to `docs/history/`.
- [ ] Split dev tools from user-facing builds: dev-only switches, diagnostics and scripts out of the release loader, module and Pi bundle; dev tools from session scratchpads into `tools/`.
- [ ] `.env.example` covering every key; config errors name the `.env` key.
- [ ] General code cleanup across the four repos.

## 5. Release packaging

- [ ] Lockstep version tags across the four repos; relay `package.json` to `0.9.0-beta.1`.
- [ ] Release workflow bundling loader app, `tournament.bin`, `tournament.cfg` template, `sync-card.ps1`, relay Pi tarball, Dolphin ini.
- [ ] Document the `PROTO_VERSION` rule: a bump means module and kernel are rebuilt together.

## 6. Operator docs

- [ ] `setup.md`: Pi flash to first beacon.
- [ ] `night-of.md`: arrival, status page checks, failure table.
- [ ] Kiosk poster verified against the shipped build and printed once.
