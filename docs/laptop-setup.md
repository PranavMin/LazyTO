# Setting up LazyTO on a laptop

This guide installs the LazyTO app on a Windows or macOS laptop and gets it past the warnings
both systems show the first time.

> **Status:** the LazyTO app is built (`desktop/`, [redesign.md](redesign.md)) but not released
> yet, and nothing in it has run at an event. Until it is released, the relay runs on a Raspberry
> Pi: see [pi-setup.md](pi-setup.md). The prompts below are as Windows and macOS document them;
> check them against the packaged app on both systems before the first release.

LazyTO is free and has no paid code signature, like Replay Reporter for Slippi. So Windows and
macOS each ask you to confirm that you trust it. The steps below take a few minutes, once per
laptop. Do them **at home, before the event**, not at the venue.

## What you need

- A laptop running Windows 10 or 11, or macOS 12 or later.
- On Windows, an administrator account, or someone who knows an administrator password. The
  firewall step needs it once.
- On macOS, your login password.
- A start.gg API token from an admin of your tournament: on start.gg, Developer Settings, Personal
  Access Tokens, Create new token.

## Windows

### 1. Download

Download `LazyTO-Setup-<version>.exe` from the
[latest release](https://github.com/PranavMin/LazyTO/releases/latest).

If your browser warns that the file isn't commonly downloaded, keep it. In Edge: the **…** menu on
the download, **Keep**, **Show more**, **Keep anyway**.

### 2. Install: "Windows protected your PC"

Open the file. Windows SmartScreen shows a blue window, **Windows protected your PC**.

1. Click **More info**.
2. Click **Run anyway**.

The installer needs no administrator rights. It installs LazyTO for your user and opens it.

If Windows says **Smart App Control blocked an app**, Smart App Control blocks every app without a
paid signature and has no "run anyway". Turn it off in Windows Security, App & browser control,
Smart App Control settings, then open the installer again.

### 3. The firewall: tick both boxes

The first time LazyTO opens, Windows shows **Windows Security Alert: Windows Defender Firewall has
blocked some features of this app**.

1. Tick **both** boxes: **Private networks** and **Public networks**. Windows calls most new
   networks Public, including the router you bring to the venue. With only Private ticked, every
   beamer is blocked there.
2. Click **Allow access**, and approve the administrator prompt.

Never click Cancel. Cancel makes a rule that blocks LazyTO, and Windows never asks again.

**If you clicked Cancel, or ticked only one box:**

- LazyTO's status page says Windows Firewall blocks LazyTO, with an **Allow LazyTO through the
  firewall** button. It asks for an administrator once, then allows LazyTO on every kind of
  network, for devices on the same network only.
- Or by hand: Windows Security, Firewall & network protection, **Allow an app through firewall**,
  **Change settings**. Tick both **Private** and **Public** for every LazyTO line, then **OK**.

## macOS

### 1. Download and install

Download `LazyTO-<version>-universal.dmg` from the
[latest release](https://github.com/PranavMin/LazyTO/releases/latest). Open it and drag **LazyTO**
into **Applications**. Always run LazyTO from Applications, not from the dmg; if you open it from
the dmg, it moves itself into Applications first.

### 2. Open it: "LazyTO Not Opened"

Open LazyTO from Applications. macOS says **"LazyTO" Not Opened**: Apple could not verify it is
free of malware.

1. Click **Done**. Do not move it to the Bin.
2. Open **System Settings**, **Privacy & Security**, and scroll down to **Security**. It says
   "LazyTO" was blocked to protect your Mac.
3. Click **Open Anyway**, and enter your login password.
4. In the window that follows, click **Open Anyway** again.

The **Open Anyway** button shows for about an hour after macOS blocks the app. If it's gone, open
LazyTO again and repeat from step 1.

You do this again **after every update**.

### 3. Local Network: Allow

macOS asks: **"LazyTO" would like to find and connect to devices on your local network.** Click
**Allow**.

LazyTO needs this to find the beamers and collect replays. It asks on the first launch of each new
version, so open a new version once at home.

**If you clicked Don't Allow:** LazyTO's status page says macOS is blocking it from your network.
Turn it on in System Settings, **Privacy & Security**, **Local Network**, **LazyTO**. LazyTO
picks it up within a few seconds; no restart is needed.

## First start: set LazyTO up

LazyTO opens its setup page with the setup code already filled in. Paste the start.gg token, pick
the tournament and its event, and choose the admin password, as on the Pi. The LazyTO window
answers its own password prompts; a phone on the same network can open the status page too, at
the address at the bottom of the page, and asks for the password for the buttons.

- Settings, the audit logs and the Wii logs are kept in LazyTO's own folder
  (`%APPDATA%\LazyTO` on Windows, `~/Library/Application Support/LazyTO` on macOS).
- Set archives (one zip per finished set, for Lucky Stats) go to `Documents/LazyTO`. Pick another
  folder on the settings page, under **Set archives**; one that OneDrive or iCloud does not sync is
  best, since an event's replays take a few GB.
- **File, Open the log folder** shows LazyTO's log, which has what a Pi's journal had.

## Beamers: flash and Wi-Fi

**File, Beamers: flash, Wi-Fi…** opens the Beamers window.

- **Flash:** unplug the beamer, hold its button while you plug it into the laptop, then click
  **Flash**. LazyTO writes the firmware that came with it. The beamer keeps its station number and
  its replays.
- **Wi-Fi and secret:** plug the beamer in normally and wait for its drive. Type the router's
  network and password, click **Pick the beamer's drive and write**, and pick the drive. LazyTO
  writes them, `LAZYTO = true` and the relay's secret into the beamer's `CONFIG/config.txt`. Eject
  the drive, then plug the beamer into its Wii.

## Updates

When a new version is out, LazyTO's status page says **LazyTO vX is out**, with a link to the
release. LazyTO never updates itself, and the link is off while a station is in a set.

Update at home, not during an event:

- **Windows:** download and run the new installer. SmartScreen may ask again: **More info**,
  **Run anyway**.
- **macOS:** drag the new LazyTO into Applications, replacing the old one. Then **Open Anyway**
  again (step 2) and **Allow** Local Network again (step 3).

Open the new version once at home to get these prompts out of the way.

## On the night

- Keep the laptop on AC power with the lid open. Closing the lid or pressing the power button puts
  it to sleep, and the stations stop reporting until it wakes.
- Connect it to the router the beamers use, by cable if you can.
- Keep LazyTO's window open. Closing it during an event asks first. While an event runs, LazyTO
  keeps the screen from turning off.
- If the status page says **No beamer has reached this laptop**, the beacon has gone out for 2
  minutes and nothing answered: check that the laptop is on the beamers' router, then the firewall
  (Windows) or Local Network (macOS) step above.

The full checklist is in [night-of.md](night-of.md).
