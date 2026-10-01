# Keeping up with upstream

LazyTO depends on two upstream projects, as submodules of this repo.

| Submodule | Upstream | How LazyTO uses it |
|------|----------|---------------|
| `melee/` | `doldecomp/melee` `master` | unmodified; the kiosk builds against it |
| `Nintendont/` | `project-slippi/Nintendont` `slippi` | forked as PranavMin/Nintendont, branch `LazyTO` |

## melee: move the submodule

The decomp is used as is, so there is nothing to merge.

1. `cd melee`, `git fetch origin`, `git checkout <newer commit>` (usually the tip of `master`).
2. Run `python configure.py --non-matching` and `python -m ninja` there, then
   `python kiosk/tools/build_module.py` from the repo root.
3. Fix what breaks in `kiosk/`, never in `melee/`:
   - **Symbols.** Every vanilla symbol the module links against must still exist under the same
     name in `config/GALE01/symbols.txt`. The build names any that are missing. Hook addresses are
     vanilla addresses and do not move.
   - **Headers.** Upstream may rename or retype structures the kiosk uses. Update the kiosk
     sources, or the include list in `kiosk/tools/build_module.py`.
4. Check the module boots to the set list against a running relay, then commit the new
   submodule position with `git add melee`.

## Nintendont: merge the fork


1. Add the upstream remote once: `git remote add upstream <url>`.
2. `git fetch upstream` and see how far behind you are: `git log --oneline LazyTO..upstream/<branch>`.
3. On a clean `LazyTO`, `git merge upstream/<branch>`. Merge, do not rebase: the fork is shared and its history is public.
4. Resolve conflicts (below), build, check, then commit the merge with a message listing what came in and how each conflict was resolved.

What to expect: a few commits, usually clean.

- **Shared files.** Watch `CommonConfig.h` and the CI workflow. If upstream bumps the config version, confirm LazyTO's own config bits sit outside the migrated fields.
- **Codesets.** If upstream removes or renames a gecko codeset under `kernel/gecko/`, rebuild the melee module so its codeset overlap check runs against the new set.
- **Check:** the kernel and loader build (locally or in CI). Then on a Wii: the loader's settings look right, the module loads, and the set list comes up.

## After merging

- Push the fork branch and let CI build it.
- Re-sync each SD card's loader so the Wiis run the merged kernel.
- If `protocol.yaml` changed in the relay meanwhile, regenerate and copy `relay_proto.h` into both forks as usual; an upstream merge never touches it.
