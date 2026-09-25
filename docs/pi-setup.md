# Raspberry Pi setup for the relay

How to take a Raspberry Pi 5 with nothing on it to a running relay, from a Windows 11 PC, with no monitor or keyboard ever plugged into the Pi. Everything after the SD card is one script (`deploy/push.ps1`); that script is also how you update the relay and switch tournaments later.

Assumption: the Pi runs Raspberry Pi OS Lite (64-bit). Windows on the Pi itself is not an option the relay supports (design.md §10: Linux + systemd).

## What you need

- Raspberry Pi 5 and its official 27 W USB-C power supply (a phone charger boots it but limits USB power and can brown out).
- microSD card, 16 GB or more (A2-class is nicer, anything works), and a way to plug it into the PC.
- Ethernet cable from the Pi to the same switch/router as this PC. The Pi never uses Wi-Fi.
- This repo with a filled `.env` (`STARTGG_TOKEN`, `EVENT_ID`, `STREAM_ID`), Node 22+ and npm, which you already have.

## 0. If the card already has something on it

Flashing erases the card. To keep the old system, image it first; Imager cannot read cards, so [deploy/backup-sd.ps1](deploy/backup-sd.ps1) does it (raw sector read, gzipped on the fly, nothing on the card is touched):

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
- The reader is the bottleneck; the whole card is read no matter how full it is. A USB 3 reader takes about a quarter of the time. If the old system has ssh enabled, booting it in the Pi and pulling the image over Ethernet is faster still, about 25 minutes for 128 GB: `ssh pi@<host>.local "sudo dd if=/dev/mmcblk0 bs=4M status=none | gzip -1" > <path>.img.gz` from your own terminal (it asks for the Pi's password).

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
| Wi-Fi | | leave it **off** or skip; the Pi is wired |
| Remote Access | Enable SSH | on, **Use public key authentication**, paste the key from your clipboard (`Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard` puts it there again) |

Confirm, Yes to erase the card, wait for "Write successful". The storage entry for a card in a USB reader shows up under the reader's name (for example "Mass Storage Device USB Device"), not the card's.

## 3. First boot

Card in the Pi, Ethernet in, power in. Give it about 90 seconds (the first boot resizes the filesystem and reboots once). Then from PowerShell:

```bash
ssh pi@relay.local hostname
```

Answer `yes` to the host-key prompt once. It should print `relay` with no password prompt. If `relay.local` does not resolve, see Troubleshooting.

## 4. Install the relay

From the repo root in PowerShell:

```bash
.\deploy\push.ps1
```

This compiles the relay (`npm run build`), writes a `config.json` from `.env` (token, event and stream ids, stream station 1, ports 7777/8080, the production start.gg endpoint, audit dir `/var/lib/tournament-reporter`; every field is described in the README's Config table), bundles it with `dist/`, `deploy/` and `package.json`, copies it to the Pi and runs `deploy/install.sh` there with sudo. The installer downloads the pinned Node 22 (sha256-checked), creates the unprivileged `relay` user, installs the systemd unit, starts it and waits for the relay's `relay up:` line. It ends with either `OK` and the status page URL or `FAILED` plus the last log lines.

Then prove it from this PC without a Wii (it lists sets over the real wire protocol and fetches the status page):

```bash
npx tsx scripts/smoke.ts relay.local
```

and open http://relay.local:8080 in a browser.

If PowerShell refuses to run the script ("running scripts is disabled"), run it once as:

```bash
powershell -ExecutionPolicy Bypass -File .\deploy\push.ps1
```

## 5. Fixed address for the Wiis

Every Wii's `tournament.cfg` carries `relay_ip=`, so the Pi needs an address that never changes on the venue LAN. Pick one inside the venue's subnet and outside its DHCP pool (look at the venue router; if the router lets you reserve an address for the Pi's MAC instead, that also works and needs nothing on the Pi). Then:

```bash
ssh pi@relay.local sudo bash /opt/tournament-reporter/deploy/set-static-ip.sh 192.168.1.10/24
```

This keeps DHCP and adds the fixed address as a second one, so `relay.local` keeps working at home and at the venue while the Wiis use the fixed address. The command prints the addresses now on `eth0`. Re-run with a different address to change it, or with `none` to drop it. Put the same address in each SD card's `tournament.cfg` (`relay_ip=192.168.1.10`, `relay_port=7777`).

## 6. Per tournament

1. Push the event and stream ids (this restarts the relay and prints the cached set count):

   ```bash
   .\deploy\push.ps1 -EventId 123456 -StreamId 7890
   ```

2. On start.gg, start every pool and phase (design.md §10); unstarted ones have preview-id sets the relay drops, and the status page warns until it is done.
3. Check each Wii's `tournament.cfg` station number against its physical label; exactly one has `stream=1`, and that station number is the relay's `streamStation` (1 unless you pass `-StreamStation`).
4. Boot one Wii and confirm the set list loads, or run the smoke test again.

## Day-to-day commands

| What | Command |
|------|---------|
| Is it running, last lines | `ssh pi@relay.local systemctl status tournament-reporter` |
| Live log | `ssh pi@relay.local journalctl -u tournament-reporter -f` |
| Restart | `ssh pi@relay.local sudo systemctl restart tournament-reporter` |
| Audit log of the current event | `ssh pi@relay.local sudo cat /var/lib/tournament-reporter/<eventId>.jsonl` |
| Update the relay after a code change | `.\deploy\push.ps1` (keeps the ids from `.env`) |
| Shut down cleanly | `ssh pi@relay.local sudo poweroff` (pulling power is also fine; claims replay from the audit log on boot) |

The relay starts on boot and restarts on failure. A wrong token or event id makes it exit immediately and systemd retries every 5 s, so `systemctl status` shows `activating (auto-restart)` and the journal shows the exact problem, one line per bad field.

## Troubleshooting

- **`relay.local` does not resolve.** Some venue routers block mDNS. Find the Pi's address in the router's client list (hostname `relay`) or, on the PC, `arp -a` after a `ping relay.local`, then use the address: `.\deploy\push.ps1 -PiHost 192.168.1.10`. Once step 5 is done you can always use the fixed address.
- **`Permission denied (publickey)`.** The key pasted into Imager is not the one `ssh` is offering. Check `type $env:USERPROFILE\.ssh\id_ed25519.pub` matches what you pasted; if the card was flashed without a key, re-flash (fastest) or plug in a keyboard and add it to `~/.ssh/authorized_keys`.
- **`install.sh` prints FAILED with "cannot read ..." or "must be ..." lines.** The generated config failed validation; fix `.env` or the `-EventId`/`-StreamId` you passed and push again.
- **FAILED with a fetch or TLS error.** The Pi has no internet, or its clock is wrong right after first boot. Check `ssh pi@relay.local curl -sI https://api.start.gg` and `timedatectl`; then `sudo systemctl restart tournament-reporter`.
- **Status page shows 0 sets.** The event id is right but no pool or phase is started on start.gg, or the event id is wrong. The relay refreshes every 20 s; no restart needed after starting pools.
- **A Wii shows "relay timeout".** The Wii's `relay_ip` does not match the Pi's fixed address, or they are on different subnets. `ssh pi@relay.local ip -4 addr show eth0` shows what the Pi has.
