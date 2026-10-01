#!/usr/bin/env python3
"""Resolve PPC addresses from a Wii crash report (relay status page, kernel log
or the crash screen) to symbols: module addresses against kiosk/build/obj/module.map
(written by build_module.py), everything else against the decomp's
config/GALE01/symbols.txt.

  python kiosk/tools/resolve_crash.py 817E88D8 801BF94C 801A40B4
  python kiosk/tools/resolve_crash.py --module-load 817E0000 ...   (default 0x817E0000)
"""
import argparse
import bisect
import re
from pathlib import Path

KIOSK = Path(__file__).resolve().parent.parent
MAP = KIOSK / "build" / "obj" / "module.map"
SYMS = KIOSK.parent / "melee" / "config" / "GALE01" / "symbols.txt"


def load_module_map():
    out = []
    if not MAP.exists():
        return out
    for line in MAP.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"\s*[0-9a-f]{8}\s+([0-9a-f]{6})\s+([0-9a-f]{8})\s+\d+\s+(\S+)\s+(\S+)", line)
        if m and not m.group(3).startswith("."):
            out.append((int(m.group(2), 16), int(m.group(1), 16), m.group(3), m.group(4)))
    return sorted(out)


def load_symbols():
    out = []
    for line in SYMS.read_text(encoding="utf-8").splitlines():
        m = re.match(r"(\S+) = \.(\w+):0x([0-9A-Fa-f]+); // type:(\w+)(?: size:0x([0-9A-Fa-f]+))?", line)
        if m:
            out.append((int(m.group(3), 16), int(m.group(5), 16) if m.group(5) else 4, m.group(1), m.group(2)))
    return sorted(out)


def lookup(table, addr):
    keys = [t[0] for t in table]
    i = bisect.bisect_right(keys, addr) - 1
    if i < 0:
        return None
    start, size, name, where = table[i]
    if addr < start + size:
        return f"{name}+0x{addr - start:X} ({where})"
    return f"{name}+0x{addr - start:X} (past its end, {where})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("addrs", nargs="+")
    ap.add_argument("--module-load", default="817E0000")
    a = ap.parse_args()
    mod = load_module_map()
    syms = load_symbols()
    load = int(a.module_load, 16)
    link = mod[0][0] & 0xFFFF0000 if mod else 0x817E0000
    for s in a.addrs:
        addr = int(s.replace("0x", ""), 16)
        if 0x817E0000 <= addr < 0x81800000 or (mod and mod[0][0] <= addr <= mod[-1][0] + mod[-1][1]):
            hit = lookup(mod, addr - load + link)
            print(f"{addr:08X}  module  {hit or '?'}")
        else:
            hit = lookup(syms, addr)
            print(f"{addr:08X}  vanilla {hit or '?'}")


if __name__ == "__main__":
    main()
