#!/usr/bin/env python3
"""Build the tournament module: the kiosk TUs compiled with the decomp's MWCC,
linked at a fixed address against the VANILLA GALE01 v1.02 symbol map, packed
with the hook table into kiosk/build/tournament.bin for the LazyTO loader. The
game ISO stays stock Melee; see docs/architecture.md.

The kiosk's own sources live in kiosk/src and kiosk/include. Everything else
comes from the unmodified Melee decompilation in the melee/ submodule: its
headers, its compilers (set up by `python configure.py --non-matching` there
once), config/GALE01/symbols.txt and the vanilla main.dol in orig/.

    python kiosk/tools/build_module.py          # from the repo root
    python kiosk/tools/build_module.py --check  # CI: no main.dol, writes no module

--check compiles, links and runs every check that does not need main.dol
(symbols, region, hook targets, gecko collisions). It never opens the DOL, so
it skips the vanilla-address check of each hook and the guard word, and it
writes no tournament.bin. It is a mode you ask for: without it a missing DOL
stops the build.

Output file format (all big-endian):
    "TMOD" u32 version=1  u32 load_addr  u32 blob_len  u32 n_patches
    u32 guard_addr  u32 guard_word          # loaders verify before writing
    n_patches x { u32 addr, u32 value }
    blob                                    # .text .rodata .data .bss (zeroed)

Loader contract: verify guard, require *(u32*)0x80000034 (arena top set by the
apploader) >= load_addr + blob_len, copy the blob to load_addr, apply the
patches, then write load_addr to 0x80000034 so the game's heap stops below the
module. Flush/invalidate caches over both.

Fails fast on: an external that is not a vanilla symbol, a hook symbol missing
from the module, the blob leaving its region, or any overlap with the gecko
codesets Nintendont applies to the venue build.
"""
import argparse
import os
import re
import struct
import subprocess
import sys
from pathlib import Path

KIOSK = Path(__file__).resolve().parent.parent      # kiosk/
REPO = KIOSK.parent                                  # the LazyTO repo
DECOMP = REPO / "melee"                              # doldecomp/melee submodule
OUT_DIR = KIOSK / "build" / "obj"
DOL = DECOMP / "orig" / "GALE01" / "sys" / "main.dol"
SYMBOLS = DECOMP / "config" / "GALE01" / "symbols.txt"
HOOKS = KIOSK / "tools" / "module_hooks.txt"
GECKO_DIR = REPO / "Nintendont" / "kernel" / "gecko"
OUTPUT = KIOSK / "build" / "tournament.bin"

# Where the module lives: the top of MEM1, carved off the game's arena. The
# IPL/apploader places the FST at 0x817FFFFF - max_fst_size (0x817F8AC0 on a
# 1.02 disc, FST 0x7529 bytes) and records that as the arena top at
# 0x80000034, which Melee's OSInit adopts (libs/dolphin/src/dolphin/os/OS.c:177)
# and hands to its heap. The loaders copy the module to LOAD_ADDR and lower
# 0x80000034 to LOAD_ADDR, so the heap never reaches it and nothing else is
# up there (verified: no vanilla code, Nintendont, or venue gecko code touches
# 0x817xxxxx). Costs the heap ~99 KB of ~18 MB. Vanilla text was NOT usable:
# every 20 KB+ stretch (even the trophy code) has callers in the normal flow.
LOAD_ADDR = 0x817E0000
REGION_END = 0x817F8AC0  # FST start on a 1.02 disc; loaders also assert *0x34 >= end
GUARD_ADDR = 0x8016D800  # gm_Scene_Vs_OnFrame's first instruction (not patched)

TUS = [KIOSK / "src" / "melee" / t for t in (
    "mn/mntourney.c",
    "lb/lbtourney.c",
    "lb/lbrelayexi.c",
    "lb/lbbuttonglyph.c",
    "lb/lbmodule_glue.c",
    "lb/lbwordmark.c",
    "lb/lbcrash.c",
)]
# Codesets the venue enables (Nintendont MeleeCodes + Slippi core).
CODESETS = ["g_core.bin", "g_crash_output.bin", "g_ucf_084.bin", "g_ucf.bin",
            "g_mods_tournament.bin", "g_mods_stealth.bin", "g_stages_stadium.bin",
            "g_stages_all.bin"]

MWCC = DECOMP / "build" / "compilers" / "GC" / "1.2.5n" / "mwcceppc.exe"
SJISWRAP = DECOMP / "build" / "tools" / "sjiswrap.exe"
MWLD = DECOMP / "build" / "compilers" / "GC" / "1.3.2" / "mwldeppc.exe"
NM = DECOMP / "build" / "binutils" / "powerpc-eabi-nm.exe"

# The DOL build's C flags (build.ninja, rule mwcc_sjis) plus: no small data
# (the module sits far from r13/r2). The kiosk's own
# directories come first; the rest are the decomp's, relative to DECOMP (the
# compiler runs there).
CFLAGS = [
    "-nowraplines", "-cwd", "source", "-Cpp_exceptions", "off", "-proc", "gekko",
    "-fp", "hardware", "-align", "powerpc", "-nosyspath", "-fp_contract", "on",
    "-multibyte", "-enum", "int", "-nodefaults", "-pragma", "cats off",
    "-pragma", "warn_notinlined off", "-RTTI", "off", "-str", "reuse",
    "-DBUILD_VERSION=0", "-DVERSION_GALE01", "-maxerrors", "1", "-msgstyle",
    "std", "-warn", "off", "-requireprotos",
    "-i", str(KIOSK / "src"), "-i", str(KIOSK / "include"),
    "-i", "src", "-i", "src/MSL",
    "-i", "include", "-i", "libs/dolphin/include", "-i", "libs/doldecomp/include",
    "-i", "build/GALE01/include",
    "-lang=c", "-O4,p", "-DNDEBUG=1", "-inline", "auto", "-sym", "off",
    "-sdata", "0", "-sdata2", "0",
]


def die(msg):
    print("build_module: " + msg, file=sys.stderr)
    sys.exit(1)


def run(cmd, **kw):
    r = subprocess.run(cmd, cwd=DECOMP, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        die("command failed: " + " ".join(str(c) for c in cmd[:3]) + " ...")
    return r.stdout


def load_symbols():
    syms = {}
    for line in SYMBOLS.read_text(encoding="utf-8").splitlines():
        m = re.match(r"(\S+) = \.(\w+):0x([0-9A-Fa-f]+);", line)
        if m:
            syms[m.group(1)] = int(m.group(3), 16)
    return syms


def write_version_inc():
    """kiosk/src/melee/lb/lbmodule_version.inc: the module's own version for the set
    list's top-right corner: short git hash (+ when the tree is dirty) and the
    build date. Rewritten only when the text changes, so an unchanged tree does
    not recompile."""
    import datetime
    try:
        h = subprocess.run(["git", "rev-parse", "--short=7", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "kiosk/src", "kiosk/include", "kiosk/tools"], cwd=REPO, capture_output=True, text=True).stdout.strip() != ""
    except Exception:
        h, dirty = "nogit", False
    text = f"{h}{'+' if dirty else ''} {datetime.date.today().isoformat()}"
    inc = KIOSK / "src" / "melee" / "lb" / "lbmodule_version.inc"
    body = f'/* generated by tools/build_module.py */\n#define TM_MODULE_VERSION "{text}"\n'
    if not inc.exists() or inc.read_text(encoding="utf-8") != body:
        inc.write_text(body, encoding="utf-8")
    return text


def compile_tus():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    objs = []
    for tu in TUS:
        obj = OUT_DIR / (Path(tu).stem + ".o")
        run([str(SJISWRAP), str(MWCC)] + CFLAGS + ["-c", str(tu), "-o", str(obj)])
        objs.append(obj)
    return objs


def externals(objs):
    undef, defined = set(), set()
    for o in objs:
        for line in run([str(NM), str(o)]).splitlines():
            p = line.split()
            if len(p) == 2 and p[0] == "U":
                undef.add(p[1])
            elif len(p) == 3 and p[1] in "TDBRSGtdbrsgC":
                defined.add(p[2])
    return sorted(undef - defined), defined


def parse_hooks():
    hooks = []
    for raw in HOOKS.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        kind, addr, target = line.split()[:3]
        hooks.append((kind, int(addr, 16), target))
    return hooks


def write_lcf(ext, syms, hook_syms):
    missing = [s for s in ext if s not in syms]
    if missing:
        die("externals with no vanilla symbol: " + ", ".join(missing))
    lines = ["MEMORY", "{", f"    text : origin = 0x{LOAD_ADDR:08X}", "}", "",
             "SECTIONS", "{", "    GROUP:", "    {"]
    for sec in (".init", ".text", ".ctors", ".dtors", ".rodata", ".data", ".bss",
                ".sdata", ".sbss", ".sdata2", ".sbss2"):
        lines.append(f"        {sec} ALIGN(0x20):{{}}")
    lines += ["    } > text", ""]
    for s in ext:
        lines.append(f"    {s} = 0x{syms[s]:08X};")
    lines += ["}", "", "FORCEACTIVE", "{"]
    lines += [f"    {s}" for s in sorted(hook_syms)]
    lines += ["}", ""]
    lcf = OUT_DIR / "module.lcf"
    lcf.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return lcf


def link(objs, lcf):
    elf = OUT_DIR / "module.elf"
    rsp = OUT_DIR / "module.rsp"
    rsp.write_text("\n".join(str(o) for o in objs) + "\n", encoding="utf-8")
    # -m: the linker wants an entry symbol even though nothing jumps to it;
    # the boot hook is as good as any.
    run([str(MWLD), "-fp", "hardware", "-nodefaults", "-warn", "off", "-msgstyle",
         "std", "-m", "tm_bootOnLoad", "-lcf", str(lcf), "-map",
         str(OUT_DIR / "module.map"), "-o", str(elf), "@" + str(rsp)])
    return elf


def read_elf(elf):
    d = elf.read_bytes()
    assert d[:4] == b"\x7fELF"
    shoff = struct.unpack(">I", d[0x20:0x24])[0]
    shentsize, shnum, shstrndx = struct.unpack(">HHH", d[0x2E:0x34])
    secs = [struct.unpack(">IIIIIIIIII", d[shoff + i * shentsize: shoff + i * shentsize + 40])
            for i in range(shnum)]
    shstr = secs[shstrndx]

    def name(off):
        return d[shstr[4] + off: d.index(b"\0", shstr[4] + off)].decode()

    # blob: every SHF_ALLOC section (flag 2), NOBITS (type 8) as zeros
    lo, hi = None, 0
    parts = []
    for s in secs:
        sname, stype, flags, addr, off, size = name(s[0]), s[1], s[2], s[3], s[4], s[5]
        if not (flags & 2) or size == 0:
            continue
        data = b"\0" * size if stype == 8 else d[off: off + size]
        parts.append((addr, data, sname))
        lo = addr if lo is None else min(lo, addr)
        hi = max(hi, addr + size)
    blob = bytearray(hi - lo)
    for addr, data, _ in parts:
        blob[addr - lo: addr - lo + len(data)] = data
    # symbols
    sym = [s for s in secs if s[1] == 2][0]
    strtab = secs[sym[6]]
    symbols = {}
    for i in range(sym[5] // 16):
        o = sym[4] + i * 16
        n, v, size, info, other, shndx = struct.unpack(">IIIBBH", d[o: o + 16])
        nm = d[strtab[4] + n: d.index(b"\0", strtab[4] + n)].decode()
        if shndx != 0 and nm:
            symbols[nm] = v
    return lo, bytes(blob), symbols, parts


def dol_word(addr):
    d = DOL.read_bytes()
    offs = struct.unpack(">18I", d[0:0x48])
    addrs = struct.unpack(">18I", d[0x48:0x90])
    sizes = struct.unpack(">18I", d[0x90:0xD8])
    for o, a, sz in zip(offs, addrs, sizes):
        if sz and a <= addr < a + sz:
            return struct.unpack(">I", d[o + (addr - a): o + (addr - a) + 4])[0]
    die(f"0x{addr:08X} is not inside the vanilla DOL")


def gecko_touches():
    """Every address a venue codeset writes or hooks."""
    touched = {}
    for name in CODESETS:
        p = GECKO_DIR / name
        if not p.exists():
            die(f"venue codeset {p} missing (git submodule update --init)")
        b = p.read_bytes()
        i = 0
        while i + 8 <= len(b):
            code, val = struct.unpack(">II", b[i: i + 8])
            t = code >> 24
            addr = 0x80000000 | (code & 0x01FFFFFF)
            if t in (0xC2, 0xC3):
                touched.setdefault(addr, set()).add(name + ":C2")
                i += 8 + val * 8
            elif t in (0x06, 0x07):
                for k in range(0, val, 4):
                    touched.setdefault(addr + k, set()).add(name + ":06")
                i += 8 + ((val + 7) // 8) * 8
            elif t <= 0x07:
                touched.setdefault(addr, set()).add(name + ":%02X" % t)
                i += 8
            elif code == 0xF0000000:
                break
            else:
                i += 8
    return touched


def main():
    ap = argparse.ArgumentParser(description="Build kiosk/build/tournament.bin.")
    ap.add_argument("--check", action="store_true",
                    help="build-check without main.dol: skip the DOL checks, write no module")
    check = ap.parse_args().check

    needs = (SYMBOLS, MWCC, SJISWRAP, MWLD, NM) if check else (DOL, SYMBOLS, MWCC, SJISWRAP, MWLD, NM)
    for need in needs:
        if not need.exists():
            die(f"{need} missing: run `git submodule update --init`, put the vanilla "
                "main.dol in melee/orig/GALE01/sys/, and run `python configure.py "
                "--non-matching` and `python -m ninja` in melee/ once")
    print("module version:", write_version_inc())
    syms = load_symbols()
    hooks = parse_hooks()
    hook_syms = {t for k, _, t in hooks if k in ("ptr", "branch")}

    objs = compile_tus()
    ext, defined = externals(objs)
    for s in hook_syms:
        if s not in defined:
            die(f"hook target {s} is not defined by the module")
    lcf = write_lcf(ext, syms, hook_syms)
    elf = link(objs, lcf)
    lo, blob, msyms, parts = read_elf(elf)

    if lo != LOAD_ADDR:
        die(f"module linked at 0x{lo:08X}, expected 0x{LOAD_ADDR:08X}")
    end = lo + len(blob)
    if end > REGION_END:
        die(f"module ends at 0x{end:08X}, past the region end 0x{REGION_END:08X}")

    patches = []
    for kind, addr, target in hooks:
        if kind == "word":
            patches.append((addr, int(target, 16)))
        elif kind == "ptr":
            patches.append((addr, msyms[target]))
        elif kind == "branch":
            delta = (msyms[target] - addr) & 0x03FFFFFC
            patches.append((addr, 0x48000000 | delta))
        else:
            die("bad hook kind " + kind)
        if not check:
            dol_word(addr)  # must be a vanilla DOL address

    touched = gecko_touches()
    for addr, _ in patches:
        if addr in touched:
            die(f"patch at 0x{addr:08X} collides with gecko codeset {touched[addr]}")
    inside = sorted(a for a in touched if lo <= a < end)
    if inside:
        die("gecko codesets write inside the module region: " +
            ", ".join(f"0x{a:08X} {touched[a]}" for a in inside[:5]))

    if check:
        print(f"check: module 0x{lo:08X}-0x{end:08X} ({len(blob)} bytes, "
              f"{REGION_END - end} spare), {len(ext)} externals, {len(patches)} patches")
        print("check: hook addresses and the guard word NOT verified (no main.dol); "
              "no tournament.bin written")
        return

    guard_word = dol_word(GUARD_ADDR)
    out = bytearray(b"TMOD")
    out += struct.pack(">IIIIII", 1, lo, len(blob), len(patches), GUARD_ADDR, guard_word)
    for addr, val in patches:
        out += struct.pack(">II", addr, val)
    out += blob
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(out)

    print(f"module: 0x{lo:08X}-0x{end:08X} ({len(blob)} bytes, "
          f"{REGION_END - end} spare in the region)")
    for addr, data, sname in sorted(parts):
        print(f"  {sname:8s} 0x{addr:08X} +0x{len(data):x}")
    print(f"externals: {len(ext)} resolved to vanilla symbols")
    print(f"patches: {len(patches)}")
    for (kind, addr, target), (_, val) in zip(hooks, patches):
        print(f"  {kind:6s} 0x{addr:08X} = 0x{val:08X}  {target}")
    print(f"guard: 0x{GUARD_ADDR:08X} == 0x{guard_word:08X}")
    print(f"wrote {OUTPUT} ({len(out)} bytes)")


if __name__ == "__main__":
    main()
