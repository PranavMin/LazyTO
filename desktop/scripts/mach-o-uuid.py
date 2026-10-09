# Gives every slice of a Mach-O executable a new random LC_UUID (mach-o-uuid.cjs
# runs it on the universal LazyTO.app). Copied from jendotpg/slippi-beamer-manager
# .erb/scripts/mach-o-uuid.py (MIT, Copyright (c) 2026 Jen Levy, and Replay
# Reporter's contributors), which took it from PyInstaller:
# https://github.com/pyinstaller/pyinstaller/blob/21f72db2610fa25e9519e54838906e7861435840/PyInstaller/utils/osx.py#L283
# Needs macholib (pip install macholib); release.yml installs it.
import binascii
import secrets
import sys

from macholib.MachO import MachO
from macholib.mach_o import LC_UUID

new_uuids = []
filename = sys.argv[1]
executable = MachO(filename)
for header in executable.headers:
    uuid_cmd = [cmd for cmd in header.commands if cmd[0].cmd == LC_UUID]
    if not uuid_cmd:
        continue
    uuid_cmd = uuid_cmd[0]
    new_uuid = secrets.token_bytes(16)
    uuid_cmd[1].uuid = new_uuid
    new_uuids.append(new_uuid)

with open(filename, "rb+") as fp:
    executable.write(fp)

for new_uuid in new_uuids:
    print(binascii.hexlify(new_uuid))
