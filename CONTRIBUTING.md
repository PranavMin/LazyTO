# Contributing to LazyTO

Bug reports from a venue are the most useful thing you can send. Use the issue templates: they
ask for the status page lines and the Wii's message, which is usually enough to find the cause.
Security problems go through [SECURITY.md](SECURITY.md) instead, never a public issue.
Questions and ideas go in [Discussions](https://github.com/PranavMin/LazyTO/discussions).
Looking for somewhere to start? Try an issue labelled
[good first issue](https://github.com/PranavMin/LazyTO/labels/good%20first%20issue).

## Code

- Set up with [docs/development.md](docs/development.md). The relay needs Node 22; the kiosk
  module needs Windows and a configured Melee decomp.
- Run `npm run format` before opening a pull request. `npm test` must pass. It checks the generated protocol files, type-checks the relay and runs
  every test. CI runs it on every pull request.
- A change to `protocol.yaml` means regenerating with `python tools/gen_protocol.py` and
  rebuilding the module and the loader together. `npm test` fails until the header copies match.
- Keep the relay's rules from [CLAUDE.md](CLAUDE.md): one code path, no fallbacks, no retries
  except start.gg 5xx. A new settings field is optional with a default. Integration tests use
  the fake start.gg in `test/`, never the real API.
- Kiosk code hooks into Melee only through `kiosk/tools/module_hooks.txt`; the decomp in
  `melee/` is never edited.
- Open a pull request against `main`. Describe what changed and how you checked it. A kiosk
  change should say whether it was run on a Wii.

By contributing you agree that your contribution is licensed under the GNU General Public
License, version 2, like the rest of LazyTO.
