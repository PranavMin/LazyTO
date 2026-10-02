#!/usr/bin/env python3
"""Fetch the three things from the Melee decomp that the kiosk build uses --
the GameCube compilers (MWCC/MWLD), binutils (powerpc-eabi-nm) and sjiswrap --
into melee/build/, without a main.dol.

The decomp's usual setup, `python -m ninja` in melee/, first regenerates
build.ninja, and that splits the DOL, so it cannot run without one. This
script runs `configure.py` and then only the download commands build.ninja
lists for those three outputs (`ninja -t commands` does not regenerate the
manifest). Already-present tools are kept. Used by developers and by
.github/workflows/kiosk.yml.

    pip install ninja
    python kiosk/tools/fetch_decomp_tools.py      # from the repo root
"""
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
DECOMP = REPO / "melee"
BUILD = DECOMP / "build"
# What kiosk/tools/build_module.py runs, and the ninja outputs that provide them.
NEEDED = {
    "build/compilers": [BUILD / "compilers" / "GC" / "1.2.5n" / "mwcceppc.exe",
                        BUILD / "compilers" / "GC" / "1.3.2" / "mwldeppc.exe"],
    "build/binutils": [BUILD / "binutils" / "powerpc-eabi-nm.exe"],
    "build/tools/sjiswrap.exe": [BUILD / "tools" / "sjiswrap.exe"],
}


def die(msg):
    print(f"fetch_decomp_tools: {msg}", file=sys.stderr)
    sys.exit(1)


def main():
    if not (DECOMP / "configure.py").exists():
        die("melee/ is empty: run `git submodule update --init melee`")
    missing = [target for target, files in NEEDED.items() if not all(f.exists() for f in files)]
    if not missing:
        print("decomp tools already present")
        return
    try:
        import ninja  # noqa: F401  (the pip package provides `python -m ninja`)
    except ImportError:
        die("needs the ninja Python package: pip install ninja")

    subprocess.run([sys.executable, "configure.py", "--non-matching"], cwd=DECOMP, check=True)
    # ninja makes an output's directory before running its command; we run the
    # commands ourselves, so make it here (download_tool.py writes sjiswrap.exe into it).
    (BUILD / "tools").mkdir(parents=True, exist_ok=True)
    commands = subprocess.run([sys.executable, "-m", "ninja", "-t", "commands", *missing],
                              cwd=DECOMP, check=True, capture_output=True, text=True).stdout
    for cmd in filter(None, commands.splitlines()):
        print(cmd)
        subprocess.run(cmd, cwd=DECOMP, shell=True, check=True)

    still = [str(f) for files in NEEDED.values() for f in files if not f.exists()]
    if still:
        die("still missing after the download: " + ", ".join(still))
    print("decomp tools ready: " + ", ".join(missing))


if __name__ == "__main__":
    main()
