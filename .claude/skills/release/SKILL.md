---
name: release
description: Cut a tagged LazyTO release - version bump, changelog, v* tag, release.yml draft with the one bundle (relay, loader, tournament.bin), publishing it as a full release. Use when the user asks to tag, release or publish a version.
---

# Cut a release

`release.yml` drafts a GitHub release on a `v*` tag with the one bundle, `lazyto.tgz`: the
relay, the loader (built from the pinned Nintendont commit) and `tournament.bin` (built by
`kiosk.yml` on Windows CI, no DOL needed), plus `lazyto.tgz.sha256`, `VERSION` and
`install.sh`. Publishing it as a full release is what every Pi on the default update channel
installs at its next start, and what the README's install command fetches. This procedure has
not been run yet; update this skill after the first release.

Every push and the tag push are outward-facing: confirm each with the user.

## Steps

1. Clean tree on `main`, up to date with origin. `npm test` passes.
2. Version: set `version` in `package.json` (for example `0.9.0-beta.1`).
3. Changelog: rename the `## [Unreleased]` heading in `docs/changelog.md` to the version and
   date, and start a new empty `[Unreleased]` section.
4. Public docs must not name the user's venue, router, network or personal paths.
5. Commit, then tag and push (after the user confirms):
   ```bash
   git tag v0.9.0-beta.1
   ```
   ```bash
   git push origin main v0.9.0-beta.1
   ```
6. Wait for the draft: `gh run list --workflow release.yml --limit 1`.
7. Check the draft has the four assets, and that `lazyto.tgz` holds `wii/tournament.bin` and
   `wii/apps/LazyTO/boot.dol` (the run's `lazyto.tgz` step lists the contents).
8. Install the draft's bundle on a test Pi before publishing:
   `sudo bash install.sh --bundle lazyto.tgz` with both files from the draft.
9. Edit the draft notes from the changelog section. The user publishes the release, as a full
    release: `/releases/latest`, which Pis follow, skips pre-releases and drafts.
