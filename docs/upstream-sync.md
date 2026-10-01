# Merging upstream into the forks

LazyTO keeps two forks. Each should be brought up to its upstream now and then. The relay has no fork and needs nothing.

| Fork | Upstream | LazyTO branch |
|------|----------|---------------|
| melee | `doldecomp/melee` `master` | `vanilla-module` |
| Nintendont | `project-slippi/Nintendont` `slippi` | `vanilla-module` |

## Procedure (both forks)

1. Add the upstream remote once: `git remote add upstream <url>`.
2. `git fetch upstream` and see how far behind you are: `git log --oneline vanilla-module..upstream/<branch>`.
3. On a clean `vanilla-module`, `git merge upstream/<branch>`. Merge, do not rebase: the fork is shared and its history is public.
4. Resolve conflicts (below), build, check, then commit the merge with a message listing what came in and how each conflict was resolved.

## melee

What to expect: mostly tooling and type changes, across many files, almost none in the module's own source.

- **Conflicts in vanilla files.** Older LazyTO work edited some vanilla files (font atlas, `sislib`, `ifnametag.c`). The module no longer needs those edits, so take upstream's version. Where a header must keep a declaration the module's glue defines (for example in `mncharsel.h`), take upstream's file and re-add just those declarations.
- **Before merging, check symbols.** Every vanilla symbol the module links against must still exist under the same name in upstream's `config/GALE01/symbols.txt`. Hook addresses are vanilla addresses and do not move.
- **Build fixes.** Upstream may add include paths or retype structures the module uses. Fix them in `tools/build_module.py` and the module sources, not in vanilla files.
- **Check:** `python tools/build_module.py` succeeds, and the module boots to the set list against a running relay.

## Nintendont

What to expect: a few commits, usually clean.

- **Shared files.** Watch `CommonConfig.h` and the CI workflow. If upstream bumps the config version, confirm LazyTO's own config bits sit outside the migrated fields.
- **Codesets.** If upstream removes or renames a gecko codeset under `kernel/gecko/`, rebuild the melee module so its codeset overlap check runs against the new set.
- **Check:** the kernel and loader build (locally or in CI). Then on a Wii: the loader's settings look right, the module loads, and the set list comes up.

## After merging

- Push the fork branch and let CI build it.
- Re-sync each SD card's loader so the Wiis run the merged kernel.
- If `protocol.yaml` changed in the relay meanwhile, regenerate and copy `relay_proto.h` into both forks as usual; an upstream merge never touches it.
