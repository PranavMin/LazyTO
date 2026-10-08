---
name: protocol-change
description: Change the Wii-relay protocol (protocol.yaml) across all three consumers - relay, kiosk module, Nintendont kernel - in the right order. Use for any new message, field, enum value or struct size change.
---

# Change the protocol

`protocol.yaml` defines every message between the Wii and the relay. Three things consume it:
the relay (`generated/wire.ts`), the kiosk (`kiosk/include/relay_proto.h`) and the Nintendont
kernel (`Nintendont/kernel/relay_proto.h`). A Wii whose module and loader come from different
protocol versions shows `NO SETS LOADED YET`.

## Steps

1. Edit `protocol.yaml`.
2. Regenerate:
   ```bash
   python tools/gen_protocol.py
   ```
   This writes `generated/wire.ts` and both header copies. Never edit any of them by hand.
3. Update relay code in `src/`. Import from `generated/wire.ts`; never copy it.
4. Update kiosk code. Check size limits:
   - EXI request payload cap is `EXI_PAYLOAD_MAX` (88 bytes in v2); `lbrelayexi.h` and kernel
     `RelayEXI.c` both use the constant.
   - Keep `exi_poll_hdr` layout stable; the module asserts its offsets.
   - Never edit a FROZEN struct (protocol.yaml header): beamers parse them and have no
     over-the-air update. `test/protocol-frozen.test.ts` pins their bytes.
   - The beamer firmware (`components/beamer_lazyto/include/`) carries a copy of the header; a
     mailbox change is a `BEAMER_MB_VERSION` bump and a firmware update.
5. Update the kernel in the submodule. A submodule checkout is detached, so first:
   ```bash
   git -C Nintendont switch LazyTO
   ```
   ```bash
   git -C Nintendont pull
   ```
   If the loader behaviour changes, bump `RELAY_HOST_BUILD` in `Nintendont/kernel/RelayEXI.c`.
6. Gate:
   ```bash
   npm test
   ```
   It fails if `generated/wire.ts` or either header drifts from `protocol.yaml`.
7. Build the module with the `kiosk-build` skill.
8. Commit order (ask the user before each push):
   1. Commit and push the header and kernel change inside `Nintendont/`.
   2. In this repo, commit `protocol.yaml`, `generated/wire.ts`, `kiosk/include`, the relay and kiosk
      changes, and the new Nintendont position (`git add Nintendont`).
9. Ship together:
   - Loader: CI build only (`gh workflow run build.yml -R PranavMin/Nintendont --ref LazyTO`).
     A locally built loader stops at "Preparing IOS58 Kernel" on a real Wii.
   - Relay: restart any running relay on the new build. The Pi updates itself from `main`.
   - Module: new `lazyto_kiosk.bin` on every card (each station's zip from the relay).
   - Dolphin's relay forwarder (PranavMin/Ishiiruka, `LazyTO`) compiles its own copy of
     `relay_proto.h`: copy the new one and rebuild it when `exi_poll_hdr`, `relay_auth` or
     `relay_beacon` change. Requests and replies pass through it by length.

Record the decision in `docs/decisions.md` if it changes the contract, and add a
`docs/changelog.md` line.
