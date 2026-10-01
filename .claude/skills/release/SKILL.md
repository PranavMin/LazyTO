---
name: release
description: Cut a tagged LazyTO release - version bump, changelog, v* tag, release.yml draft, attaching tournament.bin and the CI loader by hand. Use when the user asks to tag, release or publish a version.
---

# Cut a release

`release.yml` drafts a GitHub release on a `v*` tag with the relay bundle and the Wii kit.
CI cannot build the kiosk (Windows only, needs the vanilla DOL), so the module and the loader
are attached by hand. This procedure has not been run yet; update this skill after the first
release.

Every push and the tag push are outward-facing: confirm each with the user.

## Steps

1. Clean tree on `main`, up to date with origin. `npm test` passes.
2. Kiosk developer flags all `0` (see `kiosk-build` skill).
3. Version: set `version` in `package.json` (for example `0.9.0-beta.1`).
4. Changelog: rename the `## [Unreleased]` heading in `docs/changelog.md` to the version and
   date, and start a new empty `[Unreleased]` section.
5. Public docs must not name the user's venue, router, network or personal paths.
6. Commit, then tag and push (after the user confirms):
   ```bash
   git tag v0.9.0-beta.1
   ```
   ```bash
   git push origin main v0.9.0-beta.1
   ```
7. Wait for the draft: `gh run list --workflow release.yml --limit 1`.
8. Build the module at the tag with the `kiosk-build` skill.
9. Get the loader from the Nintendont CI build of the commit this tag pins
   (`git -C Nintendont rev-parse HEAD`). Download it with `gh run download -R PranavMin/Nintendont`.
10. Attach both:
    ```bash
    gh release upload v0.9.0-beta.1 kiosk/build/tournament.bin apps-LazyTO.zip
    ```
11. Edit the draft notes from the changelog section. The user publishes the release.
