# Setting up the relay

This guide takes a Raspberry Pi with nothing on it to a running relay. You flash its SD card,
run one command on it, and do everything else in a browser. You never plug a monitor or
keyboard into the Pi, and you need no software on your computer beyond what it already has.

## What you need

- A Raspberry Pi 5 with its official power supply, or another Pi running Raspberry Pi OS. The
  installer supports 64-bit and 32-bit systems.
- A microSD card of 16 GB or more, and a computer to flash it.
- The name and password of a Wi-Fi network your computer is on. Home is fine: you add the
  venue's Wi-Fi later. An Ethernet cable also works.
- A start.gg API token from an admin of your tournament: on start.gg, Developer Settings,
  Personal Access Tokens, Create new token.

## 1. Flash the card

Install Raspberry Pi Imager from https://www.raspberrypi.com/software/. Insert the card and
choose:

| Screen | Choice |
|---|---|
| Device | your Pi model |
| Operating System | Raspberry Pi OS (other), then **Raspberry Pi OS Lite (64-bit)** |
| Storage | the microSD card |

Imager then asks about customisation. Fill in:

| Setting | Value |
|---|---|
| Hostname | `relay`. The guides use `relay.local`. |
| Timezone and keyboard | yours |
| Username and password | `pi` and a password of your choice |
| Wi-Fi | your Wi-Fi network, its password, and your country |
| SSH | on, with password authentication |
| Raspberry Pi Connect | off |

Confirm, accept erasing the card, and wait for "Write successful".

## 2. Install LazyTO

Put the card in the Pi and power it on. Wait about 90 seconds while it resizes its filesystem
and joins the Wi-Fi. Then open a terminal on your computer (PowerShell on Windows, Terminal on
macOS) and log in to the Pi:

```bash
ssh pi@relay.local
```

Answer `yes` to the host key question, then type the password you chose in Imager. If
`relay.local` does not resolve, see Troubleshooting below. On the Pi, paste:

```bash
curl -fsSL https://github.com/PranavMin/LazyTO/releases/latest/download/install.sh | sudo bash
```

Until the first LazyTO release is published, install the development build instead:

```bash
curl -fsSL https://github.com/PranavMin/LazyTO/releases/download/main-build/install.sh | sudo bash -s -- --channel main
```

The installer takes a minute or two. It:

- downloads a pinned Node.js 22 and LazyTO, and checks both,
- turns off Wi-Fi power saving, which adds lag,
- creates an unprivileged `relay` user,
- installs and starts the `lazyto-relay` service.

It ends with the setup page's address and a one-time setup code:

```
LazyTO v1.0.0 is installed. Updates: release.
Finish on the setup page, from a phone or computer on this Pi's network:
  http://relay.local:29473/setup
  http://192.168.1.50:29473/setup   (if the first one does not open)
Setup code: 1234-5678
```

You can close the terminal now.

## 3. Set it up in a browser

Open the address from a phone or computer on the same network. The setup page has three steps.

1. **The setup code and your start.gg token.**
2. **Your tournament.** The page lists the tournaments your token administers:
   - **Follow start.gg/&lt;your short URL&gt; every week**, for a weekly that moves its short URL
     to each new tournament. Nothing changes on the relay from week to week. If the short URL
     has not moved yet when the relay starts, it takes the tournament with the same name and
     the nearest number, starting within 30 days.
   - **Only** one tournament.
   - Or **paste the tournament's start.gg link**. An unpublished tournament, such as a test
     one, needs this: start.gg never lists it.
3. **The rest:**
   - **Event:** your Melee singles event.
   - **Stream:** the stream that the stream station's sets go on, or No stream.
   - **Stream station number:** the station number of the Wii on stream.
   - **Set format:** each set's best-of as start.gg has it, or Bo3 then Bo5 from the top-8
     qualifiers on. start.gg lets an in-person event set only one best-of, so a venue that plays
     Bo3 into Bo5 wants the second.
   - **Updates:** see Updates below. Keep Releases.
   - **Admin password:** for these settings and the status page's buttons. Your browser asks
     for it once; the user name can be anything.

Save checks everything with start.gg first. Then the relay starts and the page becomes the
status page. Its header names your tournament and event.

**A test tournament first.** Create an unpublished tournament on start.gg with a Melee singles
event, some placeholder entrants and your stream. Set the relay up with its link and play a set
on one Wii. When that works, pick your real tournament on the settings page.

**Changing settings later.** A new token, another tournament or event, the format: open the
**settings** link at the top of the status page and enter your admin password. Saving applies
the change at once; sets in progress keep their stations.

## 4. The venue network

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
Wii can reach the relay. Check once before your first night: with your phone on the venue
Wi-Fi, open the status page. If it loads, the network lets devices reach the Pi.

**Ports, if a firewall sits between the Wiis and the Pi:**

| Port | Use |
|---|---|
| TCP 29470 | Wii requests |
| UDP 29471 | the relay's announcement to the Wiis |
| UDP 29472 | Wii logs and announcement requests |
| TCP 29473 | the setup and status pages |

## On the Pi

| What | Where |
|---|---|
| LazyTO: the relay and the Wii files | `/opt/lazyto` |
| Node.js | `/opt/node` |
| Settings | `/var/lib/lazyto/config.json`, readable only by the relay. The setup page writes it; the fields are in [architecture.md](architecture.md#startup-and-event-discovery). |
| Action log | `/var/lib/lazyto/<eventId>.jsonl`, and `wii-station-N.log` for each Wii's log |
| Service | `lazyto-relay`, runs as the `relay` user, starts on boot |

## When the relay can't start its event

A wrong token, no internet yet, or an event it can't find: the page says **Not running** with
the reason and a **Retry now** button. The relay also tries again by itself after 30 seconds,
60 seconds, then every 2 minutes, so it recovers once the problem clears. The Wiis show NO
RELAY FOUND meanwhile. Fix the cause on start.gg or on the settings page.

## Day-to-day commands

The status page covers a tournament night. These need `ssh pi@relay.local` and the Pi's
password:

| What | Command |
|---|---|
| Is it running | `ssh pi@relay.local systemctl status lazyto-relay` |
| Live log | `ssh pi@relay.local journalctl -u lazyto-relay -f` |
| Restart, which also finds this week's tournament again | `ssh pi@relay.local sudo systemctl restart lazyto-relay` |
| Add a Wi-Fi network | `ssh -t pi@relay.local sudo bash /opt/lazyto/deploy/add-wifi.sh "Name"` |
| Shut down | `ssh pi@relay.local sudo poweroff`. Pulling the power is also safe. |
| Remove LazyTO | `ssh -t pi@relay.local sudo bash /opt/lazyto/deploy/uninstall.sh` |

## Updates

LazyTO updates itself the way a phone app does: **at every start** (boot, crash, restart), never
while it runs. It follows the update channel picked on the settings page:

| Channel | Follows |
|---|---|
| Releases (default) | the newest published LazyTO release |
| Development builds | every change merged into LazyTO, for testing it |
| Off | nothing: the installed version stays |

At a start, `deploy/update.sh` compares the installed version with the channel's, downloads the
new one, checks its SHA-256 and that it accepts your settings, and swaps it in. The relay and
the Wii files (the loader and `tournament.bin`) always update together. Any failure, including
no internet, logs one `update:` line and the installed version starts. It checks at most once
every 10 minutes.

| What | How |
|---|---|
| Which version is running | the status page's footer |
| Did it update | `ssh pi@relay.local journalctl -u lazyto-relay -b -o cat \| grep ^update:` |
| Update now | `ssh pi@relay.local sudo systemctl restart lazyto-relay`, outside a tournament. Claimed sets come back from the action log. |
| Reinstall | run the install command again. It keeps the settings. |

## Sharing a Pi with other software

The relay can run on a Pi that already does something else, such as a bracket display. It has
no screen, uses its own ports, and installs only its own folders, one `relay` user and one
service. It needs well under 100 MB of memory. If both programs use start.gg, give the relay its
own token, because start.gg limits each token to 80 calls a minute.

Run the install command on that Pi. Its setup page is at `http://<its hostname>.local:29473/setup`.
The remove command above takes away only what the installer added.

## Troubleshooting

- **`relay.local` does not resolve.** Some routers block it. Find the Pi in the router's client
  list and use its address instead: `ssh pi@192.168.x.y`, and the page at
  `http://192.168.x.y:29473`.
- **The Pi never appears after first boot.** It did not join the Wi-Fi: a typo in the network
  name or password, or a 5 GHz-only network. Flash again, or plug in Ethernet once and add the
  network with `add-wifi.sh`.
- **`Permission denied` from ssh.** The user name or password differs from what you set in
  Imager. Flash again if you don't remember them.
- **"No LazyTO release is published yet".** Use the development build command in step 2.
- **Lost the setup code.** `ssh pi@relay.local sudo cat /var/lib/lazyto/setup-code`
- **Forgot the admin password.** `ssh -t pi@relay.local sudo nano /var/lib/lazyto/config.json`,
  change the value of `adminPassword`, save with Ctrl+O, Enter, Ctrl+X, then
  `ssh pi@relay.local sudo systemctl restart lazyto-relay`.
- **Not running: `no tournament with short URL ...`.** No tournament you administer has that
  short URL right now. Move it on start.gg, or check the token belongs to a tournament admin.
  When the relay follows a weekly, this appears only when no weekly with the same name starts
  within 30 days.
- **Not running: `N Melee singles events ... have "<name>" in the name`.** The event was
  renamed or removed on start.gg. Pick it again on the settings page.
- **Not running: `no streams named "<name>"`.** Add the stream in the tournament's stream
  settings, or pick another on the settings page.
- **Not running: a fetch or TLS error, or waiting for the clock.** The Pi has no internet yet.
  Check its Wi-Fi.

For problems on the night, see [night-of.md](night-of.md).
