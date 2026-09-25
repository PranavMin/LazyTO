# Raspberry Pi setup for the relay

How to take a Raspberry Pi 5 with nothing on it to a running relay, from a Windows 11 PC, with no monitor or keyboard ever plugged into the Pi. Everything after the SD card is one script (`deploy/push.ps1`); that script is also how you update the relay later. Switching tournaments needs no push at all: the relay finds tonight's tournament, event and stream by name when it starts.

Assumption: the Pi runs Raspberry Pi OS Lite (64-bit) and is on Wi-Fi. Windows on the Pi itself is not an option the relay supports (design.md §10: Linux + systemd).

## What you need

- Raspberry Pi 5 and its official 27 W USB-C power supply (a phone charger boots it but limits USB power and can brown out).
- microSD card, 16 GB or more (A2-class is nicer, anything works), and a way to plug it into the PC.
- The name and password of the Wi-Fi this PC is on. The Pi joins it for setup. The venue's Wi-Fi is added later (step 5). An Ethernet cable also works and needs nothing extra.
- This repo with a filled `.env` (`STARTGG_TOKEN`), Node 22+ and npm, which you already have.

## 0. If the card already has something on it

Flashing erases the card. To keep the old system, image it first; Imager cannot read cards, so [deploy/backup-sd.ps1](../deploy/backup-sd.ps1) does it (raw sector read, gzipped on the fly, nothing on the card is touched):

```bash
.\deploy\backup-sd.ps1 -List
```

shows the removable disks; then

```bash
.\deploy\backup-sd.ps1
```

(or `-DiskNumber N -Out <path>.img.gz`) relaunches itself as Administrator, asks you to confirm the disk, and writes `P:\Projects\pi-backups\pi-sd-<date>.img.gz`. It ends with a `done:` line giving the bytes read and the compressed size. To use that system again later: Imager → Operating System → Use custom → the `.img.gz` → a card of the same size or larger → Write.

Two things learned the first time (2026-09-24, 128 GB card, USB 2.0 reader: 2 hours, 1.7 GB compressed):

- Do not click inside the elevated window. A click puts the console in select mode (the title starts with "Select") and freezes the script at its next progress update. Press Esc in that window to resume.
- The reader is the bottleneck; the whole card is read no matter how full it is. A USB 3 reader takes about a quarter of the time. If the old system has ssh enabled, booting it in the Pi and pulling the image over the network is faster still, about 25 minutes for 128 GB over Ethernet: `ssh pi@<host>.local "sudo dd if=/dev/mmcblk0 bs=4M status=none | gzip -1" > <path>.img.gz` from your own terminal (it asks for the Pi's password).

## 1. One-time, on the PC: an SSH key

Windows 11 ships `ssh`, `scp`, `ssh-keygen` and `tar`. In PowerShell:

```bash
ssh-keygen -t ed25519 -N '""' -f $env:USERPROFILE\.ssh\id_ed25519
```

Skip this if `%USERPROFILE%\.ssh\id_ed25519.pub` already exists. Then copy the public key to the clipboard; you paste it into Imager in the next step:

```bash
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard
```

## 2. Flash the card with Raspberry Pi Imager

Install Imager from https://www.raspberrypi.com/software/ (or `winget install RaspberryPiFoundation.RaspberryPiImager`). Insert the card and in Imager choose:

| Screen | Choice |
|--------|--------|
| Raspberry Pi Device | Raspberry Pi 5 |
| Operating System | Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)** |
| Storage | the microSD card |

Click Next. Imager 2.x then walks through customisation pages (in Imager 1.x the same fields sit behind an **Edit Settings** button under two tabs, General and Services). Fill in:

| Page | Field | Value |
|------|-------|-------|
| Hostname | Hostname | `relay` (the guide and scripts assume `relay.local`) |
| Localisation | Timezone / keyboard | yours |
| User | Username / password | `pi` and a password of your choice (only needed if you ever plug in a keyboard) |
| Wi-Fi | Network, password, country | **on**: the Wi-Fi this PC is on, its password, and your country (US). Without it a Pi with no cable never comes online. |
| Remote Access | Enable SSH | on, **Use public key authentication**, paste the key from your clipboard (`Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard` puts it there again) |
| Raspberry Pi Connect | | leave **off**; everything here runs over ssh on your own network |

Confirm, Yes to erase the card, wait for "Write successful". The storage entry for a card in a USB reader shows up under the reader's name (for example "Mass Storage Device USB Device"), not the card's.

## 3. First boot

Card in the Pi, power in. Give it about 90 seconds (the first boot resizes the filesystem and reboots once, then joins the Wi-Fi). Then from PowerShell:

```bash
ssh pi@relay.local hostname
```

Answer `yes` to the host-key prompt once. It should print `relay` with no password prompt. If `relay.local` does not resolve, see Troubleshooting.

## 4. Install the relay

From the repo root in PowerShell:

```bash
.\deploy\push.ps1
```

This compiles the relay (`npm run build`), writes a `config.json` (the token from `.env`; the tournament, event name and stream name from the script's parameters; stream station 1, ports 7777/8080, the production start.gg endpoint, audit dir `/var/lib/tournament-reporter`; every field is described in the README's Config table), bundles it with `dist/`, `deploy/` and `package.json`, copies it to the Pi and runs `deploy/install.sh` there with sudo. The installer downloads the pinned Node 22 (sha256-checked), turns off Wi-Fi power saving, creates the unprivileged `relay` user, installs the systemd unit, starts it and waits for the relay's `relay up:` line. It ends with either `OK` and the status page URL or `FAILED` plus the last log lines.

Until go-live the tournament parameter defaults to the unpublished test tournament (`tournament/sf-melee-discord-test`). The relay's first log lines show what it found:

```
resolved "tournament/sf-melee-discord-test": SF Melee Discord Test (...), event "Melee Singles! (7:30 Start)" 1613010, stream "SFMelee" 1358079
relay up: event 1613010, N sets cached, ...
```

Then prove it from this PC without a Wii (it lists sets over the real wire protocol and fetches the status page):

```bash
npx tsx scripts/smoke.ts relay.local
```

and open http://relay.local:8080 in a browser. Its header names the tournament and event.

If PowerShell refuses to run the script ("running scripts is disabled"), run it once as:

```bash
powershell -ExecutionPolicy Bypass -File .\deploy\push.ps1
```

## 5. The venue network

**The venue's Wi-Fi.** Add it once, from home; the Pi keeps both networks and joins whichever is in range when it boots:

```bash
ssh -t pi@relay.local sudo bash /opt/tournament-reporter/deploy/add-wifi.sh "Venue Network Name"
```

It asks for the password (press Enter for an open network) and lists the saved networks.

**Check once at the venue that a Wii can reach the Pi at all.** Guest Wi-Fi often has client isolation, which blocks device-to-device traffic: a Wii would then never reach the relay, whatever its address. With the Pi and this PC both on the venue Wi-Fi, `npx tsx scripts/smoke.ts relay.local` passing means the network allows it.

**The address the Wiis use.** Decided 2026-09-25 (design.md R15): the Wiis will find the relay themselves. The relay already broadcasts a small discovery beacon every 2 s on UDP port 7778 to every network it is on; the status page footer shows where ("Discovery beacon to 192.168.1.255, last sent 1s ago"). Once the Wii side listens for it (Nintendont kernel and the Dolphin forwarder, not done yet), `tournament.cfg` drops `relay_ip` and `relay_port` and the Pi's address stops mattering.

Until then each Wii's `tournament.cfg` still needs `relay_ip=`, so the stopgaps are:

- A DHCP reservation for the Pi on the venue router, if you can get it set once (it is the same venue every week). Nothing to do on the Pi.
- A fixed second address the Pi adds on top of DHCP. Pick one inside the venue's subnet and outside its DHCP pool, and run this at the venue, on the venue Wi-Fi:

  ```bash
  ssh pi@relay.local sudo bash /opt/tournament-reporter/deploy/set-static-ip.sh 192.168.1.10/24 wlan0
  ```

  It is saved with that Wi-Fi network, so it comes back every week; `relay.local` keeps working because DHCP stays on. Re-run with a different address to change it, or with `none` to drop it.

Put the address in each SD card's `tournament.cfg` (`relay_ip=192.168.1.10`, `relay_port=7777`).

## 6. Per tournament

1. Power the Pi on at the venue (or `sudo systemctl restart tournament-reporter`). The relay looks the tournament up again at every start, so there is nothing to push. Open the status page and check the header names tonight's tournament and event and the footer shows a set count.
2. On start.gg, start every pool and phase (design.md §10); unstarted ones have preview-id sets the relay drops, and the status page warns until it is done.
3. Check each Wii's `tournament.cfg` station number against its physical label; exactly one has `stream=1`, and that station number is the relay's `streamStation` (1 unless you pass `-StreamStation`).
4. Boot one Wii and confirm the set list loads, or run the smoke test again.

**Going live on Abbey** is one push, once:

```bash
.\deploy\push.ps1 -Tournament abbey
```

(or change the `-Tournament` default in `push.ps1` so later pushes keep it). From then on the relay follows start.gg/abbey: every week's tournament gets that short URL, and the relay picks its Melee singles event whose name contains "Melee Singles" and the stream named "SFMelee". Verified against the real API on 2026-09-25: `abbey` resolved to Melee @ Abbey Tavern #160. Two things it depends on: the token belongs to an admin of the Abbey tournaments, and the short URL has moved to tonight's tournament before the relay starts.

## Day-to-day commands

| What | Command |
|------|---------|
| Is it running, last lines | `ssh pi@relay.local systemctl status tournament-reporter` |
| Live log | `ssh pi@relay.local journalctl -u tournament-reporter -f` |
| Restart (also re-finds tonight's tournament) | `ssh pi@relay.local sudo systemctl restart tournament-reporter` |
| Audit log of the current event | `ssh pi@relay.local sudo cat /var/lib/tournament-reporter/<eventId>.jsonl` |
| Update the relay after a code change | `.\deploy\push.ps1` (pass `-Tournament abbey` after go-live unless you changed the default) |
| Add a Wi-Fi network | `ssh -t pi@relay.local sudo bash /opt/tournament-reporter/deploy/add-wifi.sh "Name"` |
| Shut down cleanly | `ssh pi@relay.local sudo poweroff` (pulling power is also fine; claims replay from the audit log on boot) |

The relay starts on boot and restarts on failure. A wrong token, a short URL that has not moved to tonight's tournament yet, or an event name that matches no event or several makes it exit immediately, and systemd retries every 5 s. So `systemctl status` shows `activating (auto-restart)` and the journal shows the exact problem.

## Troubleshooting

- **`relay.local` does not resolve.** Some routers block mDNS. Find the Pi's address in the router's client list (hostname `relay`) or, on the PC, `arp -a` after a `ping relay.local`, then use the address: `.\deploy\push.ps1 -PiHost 192.168.1.10`.
- **The Pi never shows up after first boot.** It did not join the Wi-Fi: a mistyped network name or password in Imager, or a 5 GHz-only network name it could not see. Re-flash with the right values, or plug in an Ethernet cable once and add the network with `add-wifi.sh`.
- **`Permission denied (publickey)`.** The key pasted into Imager is not the one `ssh` is offering. Check `type $env:USERPROFILE\.ssh\id_ed25519.pub` matches what you pasted; if the card was flashed without a key, re-flash (fastest) or plug in a keyboard and add it to `~/.ssh/authorized_keys`.
- **FAILED with `no tournament with short URL "abbey"`.** The short URL is not on any tournament your token administers right now: it has not been moved to tonight's tournament yet, or the token belongs to someone who is not an admin. Move it on start.gg, then restart the relay.
- **FAILED with `N Melee singles events ... have "Melee Singles" in the name`** (or `no ...`). Tonight's tournament has zero or several singles events with that in the name; the message lists them. Rename one on start.gg, or push a more specific `-EventName`.
- **FAILED with `no streams named "SFMelee"`.** The stream was not added to tonight's tournament; add it under the tournament's stream settings, then restart.
- **FAILED with "cannot read ..." or "must be ..." lines.** The generated config failed validation; fix the parameter you passed and push again.
- **FAILED with a fetch or TLS error.** The Pi has no internet, or its clock is wrong right after first boot. Check `ssh pi@relay.local curl -sI https://api.start.gg` and `timedatectl`; then `sudo systemctl restart tournament-reporter`.
- **Status page shows 0 sets.** No pool or phase is started on start.gg yet. The relay refreshes every 20 s; no restart needed after starting pools.
- **A Wii shows "relay timeout".** The Wii's `relay_ip` does not match the Pi's address, the Wi-Fi isolates clients, or they are on different networks. `ssh pi@relay.local ip -4 addr show wlan0` shows what the Pi has.
