# Wii setup: first run of the kiosk on hardware

Written 2026-09-25 for the first hardware test. Prerequisites you already have:
a Wii with the Homebrew Channel, an SD card (FAT32), and a stock Melee 1.02 image.
Everything below is checked against the source as of melee `0a5c21139`,
Nintendont `52b5a23`, relay `290eb6c`.

## 1. What goes on the SD card

| SD path | From | Notes |
|---|---|---|
| `sd:/apps/Slippi Nintendont/boot.dol` | `P:\Projects\Nintendont\nintendont\boot.dol` (1,581,696 bytes, 2026-09-25 14:03) | Our loader with the relay EXI device, beacon listener, shared secret and module loader built in. Replaces the venue's Slippi Nintendont build for this card. |
| `sd:/apps/Slippi Nintendont/icon.png`, `meta.xml` | `P:\Projects\Nintendont\nintendont\` | So the Homebrew Channel lists it. |
| `sd:/tournament.bin` | `P:\Projects\melee\build\GALE01\tournament.bin` (80,248 bytes) | The kiosk module. Same file on every card. Rebuild with `python tools/build_module.py` in the melee repo; the shipped build must have `TM_DEMO_AUTOSTART`, `LB_TOURNEY_DEMO_CLAIM` and `LB_TOURNEY_TRIGGER_READOUT` all 0 (they are). |
| `sd:/tournament.cfg` | you write it, see below | One per Wii. |
| `sd:/games/GALE01/game.iso` | your stock Melee 1.02 image | Boot the game **from the SD card** for the first test. The kernel only mounts `sd:` when the game boots from SD or Slippi replays are on; from USB with replays off, every relay action says `no tournament.cfg`. |

`tournament.cfg` is plain ASCII, one `key=value` per line, no spaces around `=`, LF or CRLF:

```
station=1
stream=0
secret=<shared secret>
```

- `station`: the number on the physical station label. Any value 0-65535.
- `stream`: `1` on exactly one Wii (the stream station), `0` on every other card.
- `secret`: the relay's shared secret, 8-16 characters of `A-Z a-z 0-9 - _`. It must match
  the relay you are testing against (section 2). Missing or malformed: every action says
  `no secret in tournament.cfg`. Wrong: the kiosk says `RELAY SECRET MISMATCH` and the relay's
  status page counts a refusal.
- No relay address. The Wii finds the relay from its UDP beacon.

## 2. The relay

For the first test use the relay on this PC. It is running now from
`C:\Users\Pranav\AppData\Local\Temp\claude\P--Projects-tournament-reporter\19e72634-3389-4c9c-9a4e-d5fdce10da5c\scratchpad\relay-config-beacon.json`
(TCP 7780, status page http://localhost:8083, beacon on UDP 7778, test tournament
`tournament/sf-melee-discord-test`). Take the `secret` value for the card from that file.
For the venue Pi the secret is `RELAY_SECRET` in `.env`; `deploy/push.ps1` puts it in the
Pi's config, so the cards for the venue carry that one.

To start it again by hand from `P:\Projects\tournament-reporter`:

```bash
CONFIG="C:\Users\Pranav\AppData\Local\Temp\claude\P--Projects-tournament-reporter\19e72634-3389-4c9c-9a4e-d5fdce10da5c\scratchpad\relay-config-beacon.json" node dist/main.js
```

Two network conditions:

- The Wii and the PC must be on the same LAN. The beacon goes to each interface's directed
  broadcast (the log line `beacon: udp :7778 to ...` lists them; `192.168.1.255` is the house LAN).
- Windows Firewall must let node accept inbound TCP 7780. If the kiosk finds the relay (the
  loading pane shows the PC's address) but then says `NO LINK TO THE RELAY`, this is the first
  thing to check.

The status page's footer shows the beacon going out and the set count; the per-station
table shows every request the Wii makes.

## 3. Before Nintendont: the Wii must be online and have IOS58

- **Internet connection.** The Wii keeps one saved connection profile, and only Wii Settings (Wiimote required) can create it; Nintendont's Network option reuses it. The router's 2.4 GHz band must allow 802.11b/g: on an AT&T BGW320 the Wii only joined with mode **B/G/N** and a separate 2.4 GHz network name (error 51330 otherwise). Not the guest network: it isolates the Wii from the relay.
- **IOS58.** Nintendont refuses to start without it (`Failed to load IOS58 from NAND`). Any Wii that already runs Slippi Nintendont has it; otherwise install it once with an IOS58 installer app from the Homebrew Channel.

## 4. Nintendont settings on the Wii

Start our `Slippi Nintendont` from the Homebrew Channel. In its settings:

- **Network: on.** Without it every action says `no network`.
- Boot device: SD, and pick `GALE01` from the list.
- Leave the venue's own toggles (UCF, tournament mods, stages, music/mono) as the venue runs
  them. They are the venue's gecko sets and apply unchanged; the kiosk adds nothing to them.
- Slippi replays: your call. Recording to USB is the Slippi default and is a check in
  section 5.

If you keep a debug log (`SLIPPI_DEBUG`), the boot log should show the Slippi core patch
line, then a `tournament.bin` line with its load address at 0x817E0000, then
`RelayEXI: relay is a.b.c.d:7780 (event N)` once the beacon is heard.

## 5. What to expect, in order

1. **Boot.** No intro, no title: the main menu comes up and the Tournament screen opens on its
   own with `LOOKING FOR THE RELAY` pulsing. Within about 4 s (two beacons) it should switch to
   `LOADING SETS` and then the set list. The loading pane shows `STATION n / RELAY a.b.c.d /
   PORT 7780`.
2. **Set list.** Two panes, TOURNAMENT wordmark top-left, rows grouped by round, the right pane
   describing the highlighted set. Y refreshes, Z is friendlies, B goes to the main menu.
3. **Start a set.** A asks `START THIS SET?` in the pane, A again starts it, and you land on
   the CSS. The banner under MELEE / VS alternates the score with `HOLD L+R IF YOU ARE <name>`.
4. **Who is who.** The player named first holds L + R for one second on their own controller
   (a light analog press counts, raw 49 of 140). The banner says `<NAME> IS Pn`, both port
   labels appear, and the lower port sits on the left. L + R + B clears it.
5. **Play a game** and quit back to the CSS. The banner shows `GAME 1 TO <NAME>`, the digits
   go amber then green, the status page shows the report and start.gg shows the game.
6. **Handwarmer.** Z + X with everyone ready starts a game straight on Battlefield with no
   stage select; the in-match clock counts up top-left and goes red after 1:00. The game is not
   scored and the flag clears itself.
7. **End the set.** Z + C-up held for a second once someone has the winning score. The Wii
   returns to the set list and start.gg shows the set completed.

Also check while you are there (open items from design.md and the checklist):

- A `.slp` is written to the USB stick, and recording survives an unplug/replug.
- The venue striking code: does Y bring struck stages back, and is the stage select limited
  to the six legal stages? The poster's stage-select card assumes both.
- The hint at the top-left (`Z+X WARMUP`) and the banner are visible on the venue TV.
- Both translucent panes on the set list read well on a CRT.

## 6. If it does not work

| Symptom | Meaning | First thing to check |
|---|---|---|
| `NO RELAY FOUND` after 10 s | No beacon heard | Same LAN? Relay log shows the beacon going out? If both yes, suspect the kernel's `recvfromAddr` (never run on hardware before, Nintendont docs/relay-exi-report.md section 3.7). |
| Wii Settings connection test: error 51330 | The Wii can't join the Wi-Fi (password, security type, or the router's 2.4 GHz mode) | Found 2026-09-30 on an AT&T BGW320: with the correct password and WPA2, the Wii failed on mode G/N and joined once the 2.4 GHz band was set to **B/G/N** and given its own name. Check the router's 2.4 GHz mode includes B and G. Router firewall and MTU settings don't matter. |
| Nintendont: `Failed to load IOS58 from NAND` | The Wii has no IOS58 (System Menu older than 4.3) | Install IOS58 once with an IOS58 installer from the Homebrew Channel (needs the Wii online), or update to 4.3. Stock Nintendont check, not ours. |
| `no network` on every action | Nintendont's Network option is off | Turn it on. |
| `no tournament.cfg` | `sd:` not mounted, or the file is malformed | Boot the game from SD (or enable replays); check both `station=` and `stream=` are present with no spaces. |
| `no secret in tournament.cfg` | `secret=` missing or bad characters | 8-16 of `A-Z a-z 0-9 - _`. |
| `RELAY SECRET MISMATCH` | Card and relay disagree | The card's secret must match the relay you are running. |
| `NO LINK TO THE RELAY` with the relay's address shown | Beacon heard, TCP refused | Windows Firewall on TCP 7780 for node. |
| `NO SETS LOADED YET` and the status page shows sets | Game and kernel disagree on the wire protocol | Rebuild the module and the loader from the same `protocol.yaml` copy. |
| Freeze with FPS 0 on entering the set list | SIS text pool exhausted | The module's pool hooks are missing; rebuild the module. |

The kiosk's own version checklist for a per-build walk-through is `melee/docs/version-checklist.md`.
