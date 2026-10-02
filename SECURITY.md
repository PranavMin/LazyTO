# Security

## Reporting a problem

Report security problems privately through GitHub's private vulnerability reporting:
[open a report](https://github.com/PranavMin/LazyTO/security/advisories/new). Please don't open a
public issue for them. You should get a reply within a week.

Only the newest beta and `main` get fixes.

## What to keep in mind

- **The relay holds secrets.** The Pi keeps a start.gg API token from a tournament admin, the
  admin password, and the Wii secret every card sends (`secret=` in each card's
  `tournament.cfg`, in every station zip). Anyone with the token can edit that admin's
  tournaments on start.gg. Use a token from an account that is admin only where it needs to be,
  and revoke it if a Pi goes missing; make a new Wii secret on the settings page if a card does.
- **Setup happens over plain HTTP on the LAN.** The token crosses the network once, when you
  paste it on the setup page, so set the relay up at home rather than on a venue network. The
  first setup needs the one-time code the installer printed; after that the settings, the
  status page's actions and the SD-card zips need the admin password. The page never shows the
  token again, and the settings file is readable only by the relay.
- **The relay trusts its network.** The Wii protocol (TCP 29470), the beacon (UDP 29471), the
  telemetry and beacon requests (UDP 29472) and the status page (TCP 29473) are unencrypted and
  meant for a venue LAN. The shared secret stops a stray device from reporting sets; it does not
  protect against someone who can watch the network. Don't expose these ports to the internet.
- **The Pi updates itself.** At every relay start, `deploy/update.sh` downloads the newest
  build of its update channel from this repository's releases (the newest full release by
  default) and checks it against its `.sha256`. The checksum catches a broken download, not a
  compromised repository. Updates can be turned off on the settings page.
