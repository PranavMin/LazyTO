---
name: dolphin-test
description: Run the kiosk module in the development Slippi Dolphin headlessly and capture screenshots without stealing the user's focus. Use to check kiosk UI changes before a Wii test.
---

# Test the kiosk in Dolphin

Dolphin is the development setup from PranavMin/Ishiiruka, branch `LazyTO` (its README covers
the build and settings). It loads `tournament.bin` itself and forwards the relay EXI device.
Hardware is still the final check; use the `wii-test` skill after this.

The helper `dolphin.ps1` in this folder reads `DOLPHIN_DIR` and `MELEE_ISO` from `.env`.
If either is missing, ask the user for the paths and add them to their `.env`.
Never put those paths in committed files.

```powershell
powershell -File .claude/skills/dolphin-test/dolphin.ps1 status
```

Actions: `start [-Wait 30]`, `shot` (prints the PNG path; read it with the Read tool),
`stop`, `status`.

## Loop

1. Build with the `kiosk-build` skill. For a headless run with no controller, set a developer
   flag first (`docs/kiosk.md`): `TM_DEMO_AUTOSTART 1` to reach CSS, `LB_TOURNEY_DEMO_CLAIM 1`
   for a port claim. Set them back to `0` afterwards.
2. Run a relay on fake data, never the live one:
   `npx tsx scripts/preview-status.ts --network --secret=<SlippiRelaySecret>`. It serves the
   beacon, telemetry and TCP 29470 like a real relay, with the status page on port 29480.
3. Dolphin finds a relay by its UDP beacon. If the Pi is up on the LAN, Dolphin may pair with
   it instead. Check the dev relay's status page shows the Dolphin station.
4. `stop` Dolphin, edit `Dolphin.ini` if needed, then `start -Wait 30`. The set list is up
   about 25-30 s after launch.
5. `shot`, read the image, iterate.
6. `stop` when done.

## Traps

- Dolphin rewrites `Dolphin.ini` from memory on exit. Edit the ini only while Dolphin is
  stopped, or the edit is lost.
- Never use `PrintWindow`, `CopyFromScreen` or `SetForegroundWindow`. The first two give black
  images when the window is not composed on screen; the last steals the user's focus. The
  script posts menu commands to the wx frame instead (IDM_STOP 251, IDM_SCREENSHOT 265).
- Never kill processes. Stop only through the script. Never touch a Dolphin the user started
  from another folder.
- The user's keyboard or controller can reach Dolphin while they use the PC. Keep runs short.
- Required settings: `EnableCheats = True` (recording and venue codes), `HLE_BS2 = True`,
  `SlippiTournamentModule` pointing at `kiosk/build/tournament.bin`, `SlippiRelaySecret` set.
  Slippi's General Codes and Slippi Online must stay off. `status` shows these, never the
  secret value.
- Views that need real controller input (the confirm pane) cannot be captured here. Leave them
  for the Wii.
