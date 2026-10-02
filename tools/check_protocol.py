#!/usr/bin/env python3
"""Fail if the generated protocol files are out of date with protocol.yaml (the CI drift check).

Regenerates generated/wire.ts and the two relay_proto.h copies (kiosk/include and
the Nintendont submodule) in memory and compares them against the committed files.
Prints a unified diff and exits non-zero on any mismatch, so a PR that touches
protocol.yaml without regenerating (or hand-edits a generated file) fails CI.

Usage:
    python tools/check_protocol.py

Exit codes: 0 up to date, 1 drift, 2 committed output missing.
"""

from __future__ import annotations

import difflib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gen_protocol import ROOT, ProtocolError, generate


def main() -> int:
    try:
        expected = generate()
    except ProtocolError as e:
        print(f"protocol.yaml: {e}", file=sys.stderr)
        return 1

    rc = 0
    for path, want in expected.items():
        rel = path.relative_to(ROOT).as_posix()
        if not path.exists():
            print(f"MISSING: {rel} — run: git submodule update --init, then python tools/gen_protocol.py",
                  file=sys.stderr)
            rc = max(rc, 2)
            continue
        # Normalize line endings so a CRLF checkout doesn't false-positive.
        got = path.read_text(encoding="utf-8").replace("\r\n", "\n")
        if got != want:
            print(f"STALE: {rel} does not match protocol.yaml", file=sys.stderr)
            sys.stderr.writelines(difflib.unified_diff(
                got.splitlines(keepends=True), want.splitlines(keepends=True),
                fromfile=f"{rel} (committed)", tofile=f"{rel} (regenerated)"))
            rc = max(rc, 1)

    if rc == 0:
        print("generated/wire.ts and both relay_proto.h copies are up to date with protocol.yaml")
    else:
        print("\nfix: python tools/gen_protocol.py  (then commit generated/wire.ts, kiosk/include and the Nintendont header)",
              file=sys.stderr)
    return rc


if __name__ == "__main__":
    sys.exit(main())
