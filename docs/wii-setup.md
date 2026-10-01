# Wii setup: LazyTO on hardware

Written 2026-09-25 for the first hardware test. Prerequisites you already have:
a Wii with the Homebrew Channel, an SD card (FAT32), and a stock Melee 1.02 image.
Everything below is checked against the source as of melee `0a5c21139`,
Nintendont `52b5a23`, relay `290eb6c`.

## 1. What goes on the SD card

**The quick way:** with the card in the PC, one command installs and checks everything below
except the Melee image, then ejects the card:

```
powershell -ExecutionPolicy Bypass -File deploy/sync-card.ps1 -Station 1 -Stream 0
```

Station and stream default to what the card already has. The secret comes from `.env`
`RELAY_SECRET` (the venue relay), or from a dev relay's config with `-RelayConfig <file>`; it is
never printed. The script uses the newest successful GitHub build of the loader and refuses a
module built with a dev switch on.

By hand:

| SD path | From | Notes |
|---|---|---|
| `sd:/apps/LazyTO/boot.dol` | the **CI-built** loader: `release-*` artifact of the fork's "CI Slippi Nintendont Builds" workflow on `vanilla-module` (`gh workflow run build.yml -R PranavMin/Nintendont --ref vanilla-module`; e.g. run 36795094785, commit 648cf92) | Our loader with the relay EXI device, beacon listener, shared secret and module loader built in. Never the locally built `nintendont/boot.dol`: it stops at the IOS58 step on hardware (see section 6). |
| `sd:/apps/LazyTO/icon.png`, `meta.xml` | the same `release-*` artifact (CI fills in version and git hash) | The Homebrew Channel lists it as **LazyTO** (renamed from Kegstand's Tournament Mod on 2026-09-30), so it is never confused with stock Slippi Nintendont; the venue's own Slippi Nintendont can stay installed beside it. The loader finds its files from wherever it is launched, so the folder name is free. |
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
- **IOS58.** Nintendont needs it. Any Wii that runs plain or Slippi Nintendont has it (the Homebrew Channel itself runs on it). A `-4352` IOS58 error means the loader build, not the Wii; see section 6.

## 4. Nintendont settings on the Wii

Start **LazyTO** from the Homebrew Channel (not Slippi Nintendont).
`sync-card.ps1` already sets the two settings that matter in the loader's config file; if you
set up a card by hand, in the loader's settings:

- **Network: on.** Without it the kiosk only ever says `NO RELAY FOUND` (no beacon can arrive).
- **Auto Boot: on.** The loader then starts Melee by itself; hold B while it starts to get its
  menu back. With Priiloader autobooting the Homebrew Channel this makes power-on -> kiosk a
  single click; a forwarder installed in Priiloader would remove even that.
- **Melee Music / Melee Audio** (Slippi settings page, below Custom Cheats): the kiosk forces
  music off and mono unless these say On / Stereo. They reach the game through the relay EXI
  poll header (`exi_poll_hdr.host_opts`), so they apply on the next boot; Dolphin always gets the
  defaults.

The set list shows the module's version top-right (`66d01ab 2026-09-30 WII 1`: module git hash and
build date, then the loader's hand-bumped build number). A `+` after the hash means the module was
built from an uncommitted tree.
- Boot device: SD, and pick `GALE01` from the list.
- Leave the venue's own toggles (UCF, tournament mods, stages, music/mono) as the venue runs
  them. They are the venue's gecko sets and apply unchanged; the kiosk adds nothing to them.
- Slippi replays: your call. Recording to USB is the Slippi default and is a check in
  section 5.

If you keep a debug log (`SLIPPI_DEBUG`), the boot log should show the Slippi core patch
line, then a `tournament.bin` line with its load address at 0x817E0000, then
`RelayEXI: relay is a.b.c.d:7780 (event N)` once the beacon is heard.

## 5. What to expect, in order

**First confirmed end to end on 2026-09-30** (loader from Nintendont `1851533`, module from melee
`3f19a12b6`): station 1 heard the beacon, loaded the module, listed the sets in 55 ms and showed
the Tournament screen. The Wi-Fi join is not always quick: one boot in four never associated and
the kiosk timed out; a power cycle fixed it. Since Nintendont host build 2 (2026-09-30 evening)
the join no longer blocks the boot: Melee starts, the kiosk shows `JOINING THE WI-FI` while the
kernel's network thread waits on IOS, and it gives up after 60 s with `THIS WII COULD NOT JOIN THE
WI-FI`. Before that build the loader itself sat at `Slippi network init...` with no timeout.

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

**Loader changes without the card:** with the Wii on the Homebrew Channel (its IP is bottom-left),
`powershell -ExecutionPolicy Bypass -File deploy/wiiload.ps1 -Wii <ip>` boots the newest
GitHub-built loader over Wi-Fi. The card still supplies the module, the config and the game.

**Look at the relay's status page first** (http://<relay>:8083). Since Nintendont 140bb77 every
Wii sends its own kernel log and its module load result to the relay, so the **Wii consoles**
table says whether the module loaded and why not, with the last log lines; "full log" shows the
whole boot. The lines are also saved as `wii-station-N.log` in the relay's audit folder. A Wii
appears there once it has heard the beacon and has the right `secret=`; a Wii with a wrong secret
shows as "dropped for a wrong relay secret". If a Wii never appears at all, fall back to the SD
log: turn on **Log** in the loader's settings, boot once, and read `slippi_ndebug.log` on the card.


| Symptom | Meaning | First thing to check |
|---|---|---|
| `NO RELAY FOUND` after 10 s | No beacon heard | Same LAN? Relay log shows the beacon going out? If both yes, suspect the kernel's `recvfromAddr` (never run on hardware before, Nintendont docs/relay-exi-report.md section 3.7). |
| Wii Settings connection test: error 51330 | The Wii can't join the Wi-Fi (password, security type, or the router's 2.4 GHz mode) | Found 2026-09-30 on an AT&T BGW320: with the correct password and WPA2, the Wii failed on mode G/N and joined once the 2.4 GHz band was set to **B/G/N** and given its own name. Check the router's 2.4 GHz mode includes B and G. Router firewall and MTU settings don't matter. |
| Status page: `NOT LOADED: module overlaps game memory (arena top 0x0)`, or the SD log says `TMOD:arena top 00000000 below module end` | A kernel older than Nintendont 140bb77 | Use the current loader (sync-card.ps1 installs it). |
| Crash `Illegal instruction at 817E88D8` (the module's first instruction) a second after boot; the RAM watch shows the module zeroed | A loader older than Nintendont f32740f: the apploader's arena top (the FST base) stayed above the module, so Melee's heap setup zeroed it. The kernel could not see or fix that word (it sits in the PPC's data cache), so the PPC entry stub lowers it now | Current loader. The status page's crash line and `melee/tools/resolve_crash.py` name the address if it ever recurs. |
| Loader stuck at `Slippi network init...` | A loader older than host build 2 (2026-09-30 evening): IOS's socket start-up blocked the boot until the Wi-Fi joined, with no timeout | Power cycle to get this boot going; put the current loader on the card. |
| `JOINING THE WI-FI` pulsing (kiosk) | The kernel's network thread is still waiting on the Wi-Fi join / DHCP (poll flag `PF_NET_JOINING`); normal for 5-15 s after boot | Wait. After 60 s it becomes `THIS WII COULD NOT JOIN THE WI-FI`: power cycle, then check the router (2.4 GHz mode B/G/N, password). |
| `NETWORK IS OFF IN THE LOADER` (kiosk) | The loader's Network option is off (poll flag `PF_NO_NETWORK`), so no beacon will ever come; said at once, no 10 s wait | Turn on Network in the loader settings (sync-card.ps1 sets it). |
| `THIS CARD IS NOT SET UP` (kiosk) | No usable `tournament.cfg`, or no `secret=` in it | Fix the card (sync-card.ps1 writes it). |
| `NO RELAY FOUND` with the Wii online | No beacon heard in 10 s | Relay down, or a different network / client isolation. The Wii shows on the status page only after a beacon. |
| Boots to the VS character select, not the Tournament screen | A module older than melee 7f88d95f0: Slippi's core codes force VS mode at boot (`04 801BFA20 38600002`) | Use the current `tournament.bin`; it re-requests the main menu after the boot scene. |
| Nintendont: `Failed to load IOS58 from NAND` | With `ES_GetStoredTMDSize() returned -4352`: a **locally built loader** (libogc "ES not initialised"), not a missing IOS58; the title bar then already says IOS58. Other codes: the Wii really lacks IOS58 | -4352: put the CI-built loader on the card. Test: if plain Nintendont reaches its game list, IOS58 is fine. Genuinely missing IOS58: an IOS58 installer from the Homebrew Channel; avoid a full system update on a softmodded Wii. |
| `no network` on every action | Nintendont's Network option is off | Turn it on. |
| `no tournament.cfg` | `sd:` not mounted, or the file is malformed | Boot the game from SD (or enable replays); check both `station=` and `stream=` are present with no spaces. |
| `no secret in tournament.cfg` | `secret=` missing or bad characters | 8-16 of `A-Z a-z 0-9 - _`. |
| `RELAY SECRET MISMATCH` | Card and relay disagree | The card's secret must match the relay you are running. |
| `NO LINK TO THE RELAY` with the relay's address shown | Beacon heard, TCP refused | Windows Firewall on TCP 7780 for node. |
| `NO SETS LOADED YET` and the status page shows sets | Game and kernel disagree on the wire protocol | Rebuild the module and the loader from the same `protocol.yaml` copy. |
| Freeze with FPS 0 on entering the set list | SIS text pool exhausted | The module's pool hooks are missing; rebuild the module. |

The kiosk's own version checklist for a per-build walk-through is `melee/docs/version-checklist.md`.
