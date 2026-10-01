# LazyTO beta plan

Goal: anyone with the setup docs can run a weekly without the author present.
Exit: two consecutive weeklies with zero manual start.gg edits and no card reflash mid-night, then tag v1.0.0.

## 1. Hardware verification (blocks release)

- [ ] Full set lifecycle on a real Wii: START, L+R port claim, auto score, END, set completes on start.gg.
- [ ] `.slp` written to USB; recording survives unplug/replug.
- [ ] Venue striking code on hardware: Z brings every struck stage back (the poster says so), which stages the stage select shows.
- [ ] Loader shows "UCF 0.84" after the 2026-09-30 upstream sync.
- [ ] Wi-Fi association flake (one boot in four): retest on a Pi access point.
- [ ] Relay on a real Pi, overnight soak with `npm run sim`.
- [ ] Dress rehearsal: 2 Wiis, Pi, test tournament, start to finish.

## 2. GitHub organization (user account, all repos public)

- [x] Relay repo public (forks already were).
- [x] Descriptions, topics and homepage on the repos.
- [x] Fork READMEs: a header naming the LazyTO changes and the upstream sync procedure.
- [x] Umbrella README in this repo: what each repo does, how they fit.
- [x] Default branch `vanilla-module` (renamed `LazyTO` 2026-10-01) on the forks; stale branches pruned, `shifted-dol-final` kept as a tag.
- [x] CI on this repo: `npm test` on push and PR, Node 22; protect `main`.
- [x] Rename: repo `tournament-reporter` to `LazyTO`, Pi service to `lazyto-relay`, Pi paths to `/opt|/etc|/var/lib/lazyto`.

## 3. Branding

- [ ] Homebrew app metadata (`meta.xml`: name, coder, version, short/long description) and icon.
- [ ] Replace the Slippi logo in the Nintendont loader with a LazyTO logo.

## 4. Cleanup

- [x] Review all documentation; rewrite for a general audience (no personal paths or venue names).
- [x] Split the old design doc into `architecture.md`, `decisions.md` and `changelog.md`; build-history docs removed.
- [x] Dev tools separated: developer flags documented in kiosk.md and refused by sync-card; probe.ts read-only; wiiload.ps1 and reset-bracket.ts documented as developer tools.
- [x] `.env.example` covering every key; venue values moved from the code to `.env`.
- [x] Code cleanup for release (2026-10-01): kiosk dead code, read-only probe.ts, venue names out of comments, GPL-2.0 licence files.

## 5. Release packaging

- [ ] Version tags in LazyTO and Nintendont together; `package.json` is `0.9.0-beta.1`, tag `v0.9.0-beta.1` when the hardware checks pass.
- [x] Release workflow (`.github/workflows/release.yml`): a tag `v*` creates a draft release with the Wii kit zip (cfg template, sync-card, poster, guides) and the relay bundle; `tournament.bin` and the loader are attached by hand, then the draft is published.
- [ ] Document the `PROTO_VERSION` rule: a bump means module and kernel are rebuilt together.

## 6. Operator docs

- [x] `pi-setup.md`: Pi flash to first beacon.
- [x] `night-of.md`: arrival, status page checks, failure table.
- [ ] Kiosk poster: character select cards verified on a real Wii, then printed once.
- [ ] Publish the first release so operators don't need to build `tournament.bin` and the loader (`wii-setup.md` points at it).
