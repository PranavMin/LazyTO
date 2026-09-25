# Tournament Reporter — LAN relay

The relay is the piece of [Tournament Reporter](docs/design.md) that runs on the venue's Raspberry Pi. Players at any Wii pick their set from a list on the console, start it, update the score from the character select screen, and end it; the relay turns each of those button presses into the matching start.gg call (`markSetInProgress`, `assignStream` on the stream station, `reportBracketSet`, `resetSet`) and hands the result straight back to the console. start.gg stays the source of truth; TSH keeps driving the overlay from it. Design: [docs/design.md](docs/design.md), especially §5 (wire protocol), §6.3 (this component), §8 (error table) and §10 (deployment).

It is one Node 22 process with no framework and no runtime dependencies: a TCP server for the Wiis (fixed-size big-endian structs generated from [protocol.yaml](protocol.yaml), one request per connection), a pending-set cache refreshed from start.gg every 20 s, an in-memory station→set map rebuilt from an append-only JSONL audit log after a restart, a rate-limited GraphQL client (retries on 5xx only, max 2), and a server-rendered status page for the TO's phone. Principles from [CLAUDE.md](CLAUDE.md): one path, no fallbacks, fail fast at startup on bad config.

## Dev loop

Needs Node 22+ and, for the protocol drift check, Python 3 on `PATH` as `python` with PyYAML (`pip install pyyaml`).

| Command | What it does |
|---------|--------------|
| `npm test` | The gate: `npm run check` (generated/ matches protocol.yaml), `tsc --noEmit`, then the node test runner over `test/*.test.ts`. Integration tests use [test/fake-startgg.ts](test/fake-startgg.ts), never the real API. |
| `npm run check` | `python tools/check_protocol.py` alone. After editing `protocol.yaml`, run `python tools/gen_protocol.py` and commit `generated/`; never hand-edit anything under `generated/`. |
| `CONFIG=path/to/config.json npm start` | Run from source (tsx). Same config format as production, see below. |
| `npm run build` | `tsc -p tsconfig.build.json` → `dist/`. The source tree is mirrored (`dist/src/…`, `dist/generated/wire.js`) and the root [main.ts](main.ts) lands at `dist/main.js`, which is what the systemd unit runs: `CONFIG=… node dist/main.js`. |
| `npm run sim` | Load test ([scripts/sim-wii.ts](scripts/sim-wii.ts), design §9.2): 12 fake stations run list → start → score ×3 → end for 10 minutes against an in-process relay + fake start.gg, and fail on any non-OK reply or a peak upstream rate ≥ 70/min. Shorter: `npx tsx scripts/sim-wii.ts --duration=60` (npm swallows the flag unless it follows `--`). |
| `npm run fake -- --port=18081` | Serve the fake start.gg as its own process ([scripts/serve-fake.ts](scripts/serve-fake.ts)): token `test-token`, event `1613010`, 400 pending sets. Prints the upstream call rate every 30 s. |
| `npx tsx scripts/probe.ts` | The only thing that touches the real API. Reads `.env` (gitignored): `STARTGG_TOKEN`, `STREAM_ID`, `TEST_SET_ID` for the unpublished test tournament. Mutates that one set and resets it. |

Rehearsing the production build end to end without start.gg (what step 5 of a release does):

```bash
npm run build
npm run fake -- --port=18081
```

then a config with `"startggEndpoint": "http://127.0.0.1:18081/gql/alpha"`, `"token": "test-token"`, `"tournament": "tournament/sf-melee-discord-test"`, `"eventName": "Melee Singles"`, `"streamName": "SFMelee"` (the fake's copy of the test tournament) and non-default ports, `CONFIG=that.json node dist/main.js`, and `npm run sim -- --relay=127.0.0.1:<tcpPort>`. The sim reports Wii-side request rate and errors; the fake reports the upstream call rate.

## Config

One JSON file, every field required, unknown fields rejected, every problem reported at once, exit 1 on any of them (so the systemd unit ends up `failed` rather than half-running). On the Pi it is written by [deploy/push.ps1](deploy/push.ps1) from `.env`, never by hand; [src/config.ts](src/config.ts) is the rule book.

| Field | Meaning | Where it comes from |
|-------|---------|---------------------|
| `startggEndpoint` | GraphQL URL, http(s). | `https://api.start.gg/gql/alpha` in production; the `npm run fake` URL in a rehearsal. |
| `token` | start.gg API token. | start.gg → Developer Settings → Personal Access Tokens. Lives only in `/etc/tournament-reporter/config.json` (root:relay, mode 0640) on the Pi and in `.env` on the dev machine. Never in the repo. |
| `tournament` | The tournament, as its start.gg short URL (`abbey`, looked up among the token owner's admin tournaments) or full slug (`tournament/<slug>`, fetched directly; needed for an unpublished tournament). Resolved once at startup (design §6.3). | `abbey` in production; `tournament/sf-melee-discord-test` until go-live. `npx tsx scripts/probe.ts --resolve=<value>` shows what it resolves to. |
| `eventName` | Picks the event: the one Melee singles event whose name contains this, case-insensitively. Zero or several matches stops the relay with the list. | `Melee Singles` (matches "Melee Singles! (7:30 Start)", not Doubles or the waitlist). |
| `streamName` | Picks the stream to assign stream-station sets to, by exact name (case-insensitive). | `SFMelee`. |
| `streamStation` | Station number (1–65535) of the Wii whose `tournament.cfg` has `stream=1`. | Physical station label. |
| `tcpPort` | Port the Wiis connect to; matches `tournament.cfg` on every SD card. | `7777` unless something else owns it. |
| `httpPort` | Status page port; must differ from `tcpPort`. | `8080`. |
| `auditDir` | Directory for the audit log, written as `<eventId>.jsonl`; one file per tournament. | `/var/lib/tournament-reporter` on the Pi. |

## Pi install

Step by step, from a Windows PC and a blank Pi 5, in [docs/pi-setup.md](docs/pi-setup.md). The short version: flash Raspberry Pi OS Lite (64-bit) with Imager (hostname `relay`, user `pi`, your Wi-Fi, your ssh public key), power it on, then from this repo:

```bash
.\deploy\push.ps1
```

[deploy/push.ps1](deploy/push.ps1) runs `npm run build` here, writes `config.json` (token from `.env`; `-Tournament`/`-EventName`/`-StreamName`, defaulting to the test tournament until go-live), and ships `dist/`, `package.json`, `deploy/` and the config to the Pi over scp, where [deploy/install.sh](deploy/install.sh) (sudo, idempotent) installs a pinned Node 22 tarball at `/opt/node`, creates the unprivileged `relay` user, installs [deploy/tournament-reporter.service](deploy/tournament-reporter.service), restarts it and waits for the relay's `relay up:` line, reporting `OK` with the status page URL or `FAILED` with the journal. The Pi never needs git, npm or a GitHub credential. `npx tsx scripts/smoke.ts relay.local` then lists sets over the real wire protocol from the PC. [deploy/add-wifi.sh](deploy/add-wifi.sh) saves the venue's Wi-Fi; [deploy/set-static-ip.sh](deploy/set-static-ip.sh) adds a fixed address the Wiis' `tournament.cfg` can point at (how Wiis find the relay without a fixed address is open, design R15).

| On the Pi | |
|-----------|--|
| Code | `/opt/tournament-reporter/dist/main.js` (root-owned), Node at `/opt/node/bin/node` |
| Config | `/etc/tournament-reporter/config.json` (root:relay, 0640) |
| Audit log | `/var/lib/tournament-reporter/<eventId>.jsonl` |
| Unit | `/etc/systemd/system/tournament-reporter.service`, runs as `relay`, `Restart=on-failure`, logs to journald |
| Logs | `journalctl -u tournament-reporter -f` |
| Status | `systemctl status tournament-reporter`; status page `http://relay.local:8080/` |

## Per-tournament checklist (design §10)

1. Power the Pi on at the venue (or `sudo systemctl restart tournament-reporter`); the relay finds tonight's tournament from its short URL at startup, so nothing is pushed per tournament. Open the status page on your phone: the header names the tournament and event, the footer shows `Cache: N sets`. N must be > 0 and the header must be tonight's. If the relay will not start, `journalctl -u tournament-reporter -n 20` says why (short URL not moved yet, event name matching zero or several events, stream missing).
2. **Start every pool and every phase on start.gg** (bracket page → each phase, later phases included). Unstarted ones have preview-id sets the relay cannot represent and drops (design R8); the status page shows `⚠ N preview-id set(s) dropped -- start all pools on start.gg` until they are all started (it clears within 20 s).
3. Every SD card's `tournament.cfg` has the station number on the physical label, the Pi's IP and `tcpPort`. Exactly one card has `stream=1`, and it is the one at station `streamStation`.
4. Boot one Wii, open the Tournament menu, confirm the set list loads. Its station row appears on the status page with `LIST_SETS … ago`.

## The night of

What the status page shows, what it means, what to do. Rows with ✗ stay until you press **ack** on them; that is the only button.

| Status page shows | Meaning | Do |
|-------------------|---------|----|
| Page does not load | Relay not running, Pi off, or wrong IP. | On the Pi: `systemctl status tournament-reporter`, then `journalctl -u tournament-reporter -n 50`. A config problem is listed there line by line; fix it and `sudo systemctl restart tournament-reporter`. |
| `Cache: 0 sets` | No set in the event has both entrants yet (bracket not started), or the header names the wrong week (the short URL had not moved when the relay started). | Start the bracket. For a wrong week: move the short URL on start.gg, restart the relay. |
| `⚠ N preview-id set(s) dropped` | A pool or later phase is not started on start.gg (R8). | Start it. The warning clears on the next refresh. |
| `⚠ cache is stale` and/or `✗ last refresh failed: start.gg unreachable` | The venue's internet is down or the Pi lost it. Wiis keep seeing the last list; every START/REPORT will fail until it is back. | Check the uplink and the Pi's cable. Nothing to do on the relay; it recovers on the next successful refresh. |
| `✗ last refresh failed: start.gg rejected: Invalid authentication token` | Token revoked or expired. | New token into the config, restart. |
| `✗ discovery beacon: …` | The relay cannot broadcast its beacon (no network interface, or sending failed), so Wiis that find the relay by beacon cannot find it (design R15). | Check the Pi is on the Wi-Fi (`ip -4 addr`); it recovers on the next beacon, every 2 s. |
| `no station has connected yet` after a Wii is booted | The Wii cannot reach the relay: wrong IP or port in `tournament.cfg`, wrong VLAN, Wi-Fi. The Wii shows `relay timeout`. | Fix the card or the cable. If the address is right, the venue Wi-Fi may isolate clients (design R15). |
| Station row: `✗ assignStream failed: …` | The set **is** in progress on start.gg but not on the stream, so TSH has no names. | Assign the set to the stream by hand in start.gg, press ack. |
| Station row: `✗ reportBracketSet failed: start.gg rejected: …` (last action `ST_STARTGG_ERROR: start.gg rejected - ask TO`) | start.gg refused the score — usually the TO already reported or reset that set by hand (R6). The Wii showed "start.gg rejected — ask TO". | Sort it out on start.gg; press ack. The station clears itself on its next LIST_SETS once the set is gone from the cache. |
| Station row: `✗ … start.gg HTTP 5xx after 3 attempts` (last action `start.gg error - retry`) | start.gg outage; the relay already retried twice. | Player retries the score later; every report is a full overwrite, so nothing is lost. ack when it goes through. |
| Last action `ST_RATE_LIMITED` | More than 70 upstream calls in 60 s. Should not happen with 12 stations; the footer's `Upstream: N calls last 60s` tells you how close it is. | Wait a minute. If it repeats, something is looping; check the audit log. |
| Last action `ST_SET_TAKEN: started on station N` / `in progress on start.gg` | Two stations picked the same set, or the TO started it by hand. | Nothing; the player picks another set. |
| Last action `ST_NOT_STREAM` | A non-stream card has `stream=1`. | Fix that card's `tournament.cfg`. |
| Set column shows `set 12345` instead of names | The set left the cache mid-set (completed or reset upstream). | Station clears on its next LIST_SETS; check start.gg if the players did not finish it. |
| Relay restarted mid-tournament (`systemctl` shows a recent start) | Fine: claims are replayed from the audit log; a rebooted Wii sees its current set first and resumes with START. The CSS overlay restarts at 0–0; the player re-enters the score (design §8). | Nothing, unless the audit log was deleted. |

Fallback for anything else: the TO runs the set on start.gg by hand as before. The relay never blocks that.
