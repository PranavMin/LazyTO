# Setting up the relay

This guide takes a Raspberry Pi with nothing on it to a running relay, from a PC (Windows, macOS or Linux). You
never plug a monitor or keyboard into the Pi. After the SD card is flashed, one script,
`npm run push`, installs the relay. The same command changes its config later.

You set your event up once. The relay looks your tournament, event and stream up by name each
time it starts, so a new week needs no push.

## What you need

- A Raspberry Pi 5 with its official power supply, or another Pi running Raspberry Pi OS. The
  installer supports 64-bit and 32-bit systems.
- A microSD card of 16 GB or more, and a way to plug it into the PC.
- The name and password of a Wi-Fi network the PC is on. The Pi joins it for setup. You add the
  venue's Wi-Fi later. An Ethernet cable also works.
- On the PC: Windows 10 or 11, macOS or Linux, with Git, Node.js 22 or newer, and a clone of this repo.
- A start.gg API token from an admin of your tournament: start.gg, Developer Settings, Personal
  Access Tokens.

## 1. Make an SSH key on the PC

Windows 10+, macOS and Linux all include `ssh`, `scp`, `ssh-keygen` and `tar`. Skip this step
if `~/.ssh/id_ed25519.pub` (`%USERPROFILE%\.ssh\id_ed25519.pub` on Windows) already exists:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
```

Then copy the public key to the clipboard. You paste it into Imager in the next step. Windows
PowerShell:

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard
```

macOS: `pbcopy < ~/.ssh/id_ed25519.pub`. Linux: open the file and copy it.

## 2. Flash the card

Install Raspberry Pi Imager from https://www.raspberrypi.com/software/ or with
`winget install RaspberryPiFoundation.RaspberryPiImager`. Insert the card and choose:

| Screen | Choice |
|---|---|
| Device | your Pi model |
| Operating System | Raspberry Pi OS (other), then **Raspberry Pi OS Lite (64-bit)** |
| Storage | the microSD card |

Imager then asks about customisation. Fill in:

| Setting | Value |
|---|---|
| Hostname | `relay`. The guides and scripts use `relay.local`. |
| Timezone and keyboard | yours |
| Username and password | `pi` and a password of your choice |
| Wi-Fi | the PC's Wi-Fi network, its password, and your country |
| SSH | on, with **public key authentication**, and paste the key from your clipboard |
| Raspberry Pi Connect | off |

Confirm, accept erasing the card, and wait for "Write successful". A card in a USB reader may
appear under the reader's name.

## 3. First boot

Put the card in the Pi and power it on. Wait about 90 seconds while it resizes its filesystem
and joins the Wi-Fi. Then, in a terminal:

```bash
ssh pi@relay.local hostname
```

Answer `yes` to the host key prompt once. It prints `relay` with no password prompt. If
`relay.local` does not resolve, see Troubleshooting below.

## 4. Describe your event

In the repo folder, copy `.env.example` to `.env` and fill it in. `.env` is never committed.

| Key | What it is |
|---|---|
| `STARTGG_TOKEN` | your start.gg API token |
| `RELAY_SECRET` | a shared secret of 8 to 16 letters, digits, `-` or `_`. Every Wii's SD card carries the same value. Treat it like a password. |
| `ADMIN_PASSWORD` | your password for the status page's buttons (free a station, change a set's best-of): 8 to 64 characters, no spaces, not the same as `RELAY_SECRET`. The browser asks once; the user name can be anything. |
| `TOURNAMENT` | your tournament's start.gg short URL, the part after `start.gg/`. For one fixed tournament you can instead give its full slug, `tournament/<slug>`. |
| `EVENT_NAME` | text that appears in your Melee singles event's name, for example `Melee Singles`. It must match exactly one singles event. |
| `STREAM_NAME` | your stream's name exactly as in the tournament's stream settings |
| `STREAM_STATION` | optional. The station number of the Wii on stream. Default 1. |
| `SET_FORMAT` | optional. `startgg` (default): each set's best-of as start.gg has it. `top8q`: Bo3, then Bo5 from the top-8 qualifiers onward. start.gg lets an in-person event set only one best-of, so a venue that plays Bo3 into Bo5 wants `top8q`. |
| `WEEKLY_NAME_PREFIX` | optional, for a numbered weekly. See below. |
| `TEST_TOURNAMENT` | optional. A test tournament's full slug, used by `npm run push -- --test`. |

**A weekly that moves its short URL.** Many weeklies keep one short URL and move it to the new
tournament each week. The relay finds the tournament the short URL is on when it starts, so it
follows the move with no push. If you also set `WEEKLY_NAME_PREFIX` to the weekly's name without
its number, for example `My Bar Weekly #`, the relay has a backup. When the short URL is not
moved yet, it takes the tournament named `My Bar Weekly #<number>` that starts nearest to now,
within 30 days.

**A test tournament first.** Create an unpublished tournament on start.gg with a Melee singles
event, some placeholder entrants and your stream. Put its full slug in `TEST_TOURNAMENT`. An
unpublished tournament is never listed by start.gg, so it always needs the full slug.

## 5. Install the relay

From the repo folder (after `npm ci` once):

```bash
npm run push -- --test
```

`--test` points the relay at `TEST_TOURNAMENT`, so no Wii can touch a real bracket while you
test. Leave it off to use `TOURNAMENT`. It needs `ssh`, `scp` and `tar` on your PATH, which
Windows 10+, macOS and Linux all ship.

The script builds the relay, writes its config from `.env`, copies it to the Pi, and runs the
installer there. The installer:

- downloads a pinned Node.js 22 and checks it,
- turns off Wi-Fi power saving, which adds lag,
- creates an unprivileged `relay` user,
- installs and starts the `lazyto-relay` service.

It ends with `OK` and the status page address, or `FAILED` and the last log lines. The relay's
first log lines say what it found:

```
resolved "tournament/<slug>" by full slug: <name> (...), event "<event>" <id>, stream "<stream>" <id>
relay up: event <id>, N sets cached, ...
```

Check it from the PC without a Wii. This lists sets over the real Wii protocol and fetches the
status page:

```bash
npx tsx scripts/smoke.ts relay.local
```

Then open http://relay.local:29473 in a browser. The header names your tournament and event.

When testing is done, push once without `--test` to go live:

```bash
npm run push
```

## 6. The venue network

**Add the venue's Wi-Fi.** Do this once, from home. The Pi keeps every saved network and joins
whichever is in range:

```bash
ssh -t pi@relay.local sudo bash /opt/lazyto/deploy/add-wifi.sh "Venue Network Name"
```

It asks for the password. Press Enter for an open network.

**The Pi's address does not matter.** The relay announces itself every 2 seconds on UDP port
29471, and each Wii uses the address the announcement came from. Some routers drop these
broadcasts. A Wii that hears nothing asks the relay directly on UDP port 29472 and gets an
answer back. There is no fixed IP address to set up.

**Devices must be able to reach each other.** Guest networks often isolate clients, and then no
Wii can reach the relay. With the PC and the Pi both on the venue Wi-Fi,
`npx tsx scripts/smoke.ts relay.local` passing means the network allows it. Check this once
before your first night.

**Ports, if a firewall sits between the Wiis and the Pi:**

| Port | Use |
|---|---|
| TCP 29470 | Wii requests |
| UDP 29471 | the relay's announcement to the Wiis |
| UDP 29472 | Wii logs and announcement requests |
| TCP 29473 | the status page |

## Relay settings reference

`npm run push` writes the relay's config to `/etc/lazyto/config.json` on the Pi. Don't edit it
there: change `.env` and push again. Every field is required and checked at startup. Any problem
stops the relay with a list of everything wrong.

| Field | Meaning | Set from |
|---|---|---|
| `startggEndpoint` | start.gg's API address | always the production address |
| `token` | start.gg API token | `STARTGG_TOKEN` |
| `tournament` | short URL, or `tournament/<slug>` | `TOURNAMENT`, or `TEST_TOURNAMENT` with `--test` |
| `eventName` | picks the one Melee singles event whose name contains it | `EVENT_NAME` |
| `streamName` | picks the stream with exactly this name | `STREAM_NAME` |
| `weeklyNamePrefix` | the weekly backup described above. Empty turns it off. | `WEEKLY_NAME_PREFIX` |
| `secret` | the shared secret every Wii must send | `RELAY_SECRET` |
| `adminPassword` | the password for the status page's buttons | `ADMIN_PASSWORD` |
| `streamStation` | station number of the stream Wii | `STREAM_STATION`, default 1 |
| `setFormat` | how each set's best-of is decided | `SET_FORMAT`, default `startgg` |
| `tcpPort` | port for Wii requests. The Wiis learn it from the announcement. | 29470 |
| `httpPort` | status page port | 29473 |
| `auditDir` | folder for the per-event log of every action | `/var/lib/lazyto` |

## On the Pi

| What | Where |
|---|---|
| Relay code | `/opt/lazyto` |
| Node.js | `/opt/node` |
| Config | `/etc/lazyto/config.json`, readable only by root and the relay |
| Action log | `/var/lib/lazyto/<eventId>.jsonl`, and `wii-station-N.log` for each Wii's log |
| Service | `lazyto-relay`, runs as the `relay` user, starts on boot |

## Day-to-day commands

| What | Command |
|---|---|
| Is it running | `ssh pi@relay.local systemctl status lazyto-relay` |
| Live log | `ssh pi@relay.local journalctl -u lazyto-relay -f` |
| Restart, which also finds this week's tournament again | `ssh pi@relay.local sudo systemctl restart lazyto-relay` |
| Update the relay by hand | `npm run push` (needed only for a config change; code updates itself, see Updates) |
| Add a Wi-Fi network | `ssh -t pi@relay.local sudo bash /opt/lazyto/deploy/add-wifi.sh "Name"` |
| Shut down | `ssh pi@relay.local sudo poweroff`. Pulling the power is also safe. |
| Remove the relay | `ssh -t pi@relay.local sudo bash /opt/lazyto/deploy/uninstall.sh` |

The relay restarts by itself on failure. A wrong token, no Wi-Fi yet, or an event it can't find
stops it at startup with a clear message in the log. It then retries every 10 seconds, slowing to
every 2 minutes, so it recovers once the problem clears. After fixing something, restart it to
try at once.

## Updates

The relay updates itself, the way a phone app does: **at every start**, never while running.
Each push to `main` on GitHub runs the tests and publishes the relay as a bundle on the moving
prerelease tag `latest`. When the relay starts (boot, crash, `systemctl restart lazyto-relay`),
`deploy/update.sh` runs first: it compares the installed `/opt/lazyto/VERSION` with the
published one, downloads the bundle, checks its SHA-256, runs the **new** build's config check
against `/etc/lazyto/config.json`, and swaps the code in. Then the relay starts. Any failure,
including no internet, logs one `update:` line and the installed version starts as before. It
checks at most once every 10 minutes, so the restart pacing above costs nothing.

What it never does: change `config.json`. Your event, token, ports and secret only move with
`npm run push`. If a new version needs a config field that your `config.json` does not have, the
updater refuses that version (`update: bundle ... rejects /etc/lazyto/config.json`) and keeps
the old one until you push; the relay stays up throughout.

| What | How |
|---|---|
| Which version is running | `ssh pi@relay.local cat /opt/lazyto/VERSION` (a commit hash, or `local-<date>` for a build pushed from your PC) |
| Did it update | `ssh pi@relay.local journalctl -u lazyto-relay -b -o cat \| grep ^update:` |
| Update now | `ssh pi@relay.local sudo systemctl restart lazyto-relay` (outside a tournament; the restart itself is safe, claimed sets come back from the action log) |
| Keep a build pushed from this PC | `npm run push -- --no-auto-update`; the next push without the flag turns updates back on |
| Turn it off on the Pi | `ssh pi@relay.local sudo touch /etc/lazyto/no-auto-update`; `sudo rm` that file to turn it on |

Only the relay updates itself. The Wii side (`tournament.bin`, the loader) ships by hand with
`npm run sync-card`.

## Sharing a Pi with other software

The relay can run on a Pi that already does something else, such as a bracket display. It has
no screen, uses its own ports, and installs only its own folders, one `relay` user and one
service. It needs well under 100 MB of memory. If both programs use start.gg, give the relay its
own token, because start.gg limits each token to 80 calls a minute.

Put your SSH key on that Pi (`ssh-copy-id <user>@<hostname>.local` on macOS/Linux; on Windows
PowerShell the line below), then push with its name and user:

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | ssh <user>@<hostname>.local "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

```bash
npm run push -- --test --pi-host <hostname>.local --user <user>
```

The uninstall command above removes only what the relay installed.

## Troubleshooting

- **`relay.local` does not resolve.** Some routers block it. Find the Pi in the router's client
  list, or run `ping relay.local` then `arp -a`, and use the address instead:
  `npm run push -- --pi-host 192.168.x.y`.
- **The Pi never appears after first boot.** It did not join the Wi-Fi: a typo in the network
  name or password, or a 5 GHz-only network. Flash again, or plug in Ethernet once and add the
  network with `add-wifi.sh`.
- **`Permission denied (publickey)`.** The key in Imager is not the one `ssh` offers. Compare
  `Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub` with what you pasted, and flash again if
  needed.
- **`FAILED` with `no tournament with short URL ...`.** No tournament you administer has that
  short URL right now. Move it on start.gg, or check the token belongs to a tournament admin.
  With `WEEKLY_NAME_PREFIX` set, this appears only when no matching weekly starts within 30 days.
- **`FAILED` with `N Melee singles events ... have "<name>" in the name`.** `EVENT_NAME` matches
  zero events or several. The message lists them. Make `EVENT_NAME` more specific and push again.
- **`FAILED` with `no streams named "<name>"`.** Add the stream in the tournament's stream
  settings, then restart the relay.
- **`FAILED` with a fetch or TLS error.** The Pi has no internet, or its clock is wrong just
  after first boot. Check `ssh pi@relay.local timedatectl`, then restart the relay.
- **A config error from `npm run push`.** A key is missing or malformed in `.env`. The message names
  it.

For problems on the night, see [night-of.md](night-of.md).
