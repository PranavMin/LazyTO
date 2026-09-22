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

then a config with `"startggEndpoint": "http://127.0.0.1:18081/gql/alpha"`, `"token": "test-token"`, `"eventId": 1613010` and non-default ports, `CONFIG=that.json node dist/main.js`, and `npm run sim -- --relay=127.0.0.1:<tcpPort>`. The sim reports Wii-side request rate and errors; the fake reports the upstream call rate.

## Config

One JSON file, every field required, unknown fields rejected, every problem reported at once, exit 1 on any of them (so the systemd unit ends up `failed` rather than half-running). [deploy/config.example.json](deploy/config.example.json) is the template; [src/config.ts](src/config.ts) is the rule book.

| Field | Meaning | Where it comes from |
|-------|---------|---------------------|
| `startggEndpoint` | GraphQL URL, http(s). | `https://api.start.gg/gql/alpha` in production; the `npm run fake` URL in a rehearsal. |
| `token` | start.gg API token. | start.gg → Developer Settings → Personal Access Tokens. Lives only in `/etc/tournament-reporter/config.json` (mode 0600) on the Pi and in `.env` on the dev machine. Never in the repo. |
| `eventId` | Numeric id of the event (e.g. Melee Singles), not the tournament. | GraphQL `event(slug: "tournament/<t>/event/<e>") { id }`, or the id in the event's admin URL. |
| `streamId` | Numeric id of the stream to assign sets to. | GraphQL `tournament(slug: "<t>") { streams { id streamName } }` (the stream must exist in the tournament's stream settings). |
| `streamStation` | Station number (1–65535) of the Wii whose `tournament.cfg` has `stream=1`. | Physical station label. |
| `tcpPort` | Port the Wiis connect to; matches `tournament.cfg` on every SD card. | `7777` unless something else owns it. |
| `httpPort` | Status page port; must differ from `tcpPort`. | `8080`. |
| `auditDir` | Directory for the audit log, written as `<eventId>.jsonl`; one file per tournament. | `/var/lib/tournament-reporter` on the Pi. |

## Pi install

Target: Raspberry Pi 4 (or Zero 2 W), Raspberry Pi OS, wired Ethernet with a static IP, the default `pi` user. [deploy/install.sh](deploy/install.sh) is idempotent and does exactly one thing per step; re-run it after `git pull` to redeploy or after editing the config to restart.

```bash
sudo apt install -y git curl
git clone <this repo> ~/tournament-reporter
cd ~/tournament-reporter && deploy/install.sh
```

The first run installs nvm + Node 22 into `/home/pi/.nvm`, builds, copies `dist/` and `package.json` to `/opt/tournament-reporter`, installs the example config as `/etc/tournament-reporter/config.json`, and **stops with exit 1** telling you to edit it. Fill in `token`, `eventId`, `streamId`, then:

```bash
deploy/install.sh
```

which renders [deploy/tournament-reporter.service](deploy/tournament-reporter.service) with the exact Node binary path, creates `/var/lib/tournament-reporter`, enables and (re)starts the unit, waits 3 s and reports whether it is running. The relay validates the config and does one start.gg refresh before it listens, so a bad token or event id shows up right there as `failed`, with the reason in the journal. The script refuses to run as any user but `pi`, on a non-Linux box, or with the `REPLACE_ME` token still in place.

| On the Pi | |
|-----------|--|
| Code | `/opt/tournament-reporter/dist/main.js` (root-owned) |
| Config | `/etc/tournament-reporter/config.json` (pi, 0600) |
| Audit log | `/var/lib/tournament-reporter/<eventId>.jsonl` |
| Unit | `/etc/systemd/system/tournament-reporter.service`, `Restart=on-failure`, logs to journald |
| Logs | `journalctl -u tournament-reporter -f` |
| Status | `systemctl status tournament-reporter`; status page `http://<pi>:8080/` |

## Per-tournament checklist (design §10)

1. Edit `/etc/tournament-reporter/config.json`: `eventId`, `streamId` (and `streamStation` if the stream setup moved). `sudo systemctl restart tournament-reporter`. Open the status page on your phone: the header shows the event id, the footer shows `Cache: N sets`. N must be > 0 and the id must be tonight's event.
2. **Start every pool and every phase on start.gg** (bracket page → each phase, later phases included). Unstarted ones have preview-id sets the relay cannot represent and drops (design R8); the status page shows `⚠ N preview-id set(s) dropped -- start all pools on start.gg` until they are all started (it clears within 20 s).
3. Every SD card's `tournament.cfg` has the station number on the physical label, the Pi's IP and `tcpPort`. Exactly one card has `stream=1`, and it is the one at station `streamStation`.
4. Boot one Wii, open the Tournament menu, confirm the set list loads. Its station row appears on the status page with `LIST_SETS … ago`.

## The night of

What the status page shows, what it means, what to do. Rows with ✗ stay until you press **ack** on them; that is the only button.

| Status page shows | Meaning | Do |
|-------------------|---------|----|
| Page does not load | Relay not running, Pi off, or wrong IP. | On the Pi: `systemctl status tournament-reporter`, then `journalctl -u tournament-reporter -n 50`. A config problem is listed there line by line; fix it and `sudo systemctl restart tournament-reporter`. |
| `Cache: 0 sets` | Wrong `eventId`, or no set in the event has both entrants yet (bracket not started). | Check the event id in the header against start.gg; start the bracket. |
| `⚠ N preview-id set(s) dropped` | A pool or later phase is not started on start.gg (R8). | Start it. The warning clears on the next refresh. |
| `⚠ cache is stale` and/or `✗ last refresh failed: start.gg unreachable` | The venue's internet is down or the Pi lost it. Wiis keep seeing the last list; every START/REPORT will fail until it is back. | Check the uplink and the Pi's cable. Nothing to do on the relay; it recovers on the next successful refresh. |
| `✗ last refresh failed: start.gg rejected: Invalid authentication token` | Token revoked or expired. | New token into the config, restart. |
| `no station has connected yet` after a Wii is booted | The Wii cannot reach the relay: wrong IP or port in `tournament.cfg`, wrong VLAN, Wi-Fi. The Wii shows `relay timeout`. | Fix the card or the cable; the Pi and the stream Wii must be on Ethernet. |
| Station row: `✗ assignStream failed: …` | The set **is** in progress on start.gg but not on the stream, so TSH has no names. | Assign the set to the stream by hand in start.gg, press ack. |
| Station row: `✗ reportBracketSet failed: start.gg rejected: …` (last action `ST_STARTGG_ERROR: start.gg rejected - ask TO`) | start.gg refused the score — usually the TO already reported or reset that set by hand (R6). The Wii showed "start.gg rejected — ask TO". | Sort it out on start.gg; press ack. The station clears itself on its next LIST_SETS once the set is gone from the cache. |
| Station row: `✗ … start.gg HTTP 5xx after 3 attempts` (last action `start.gg error - retry`) | start.gg outage; the relay already retried twice. | Player retries the score later; every report is a full overwrite, so nothing is lost. ack when it goes through. |
| Last action `ST_RATE_LIMITED` | More than 70 upstream calls in 60 s. Should not happen with 12 stations; the footer's `Upstream: N calls last 60s` tells you how close it is. | Wait a minute. If it repeats, something is looping; check the audit log. |
| Last action `ST_SET_TAKEN: started on station N` / `in progress on start.gg` | Two stations picked the same set, or the TO started it by hand. | Nothing; the player picks another set. |
| Last action `ST_NOT_STREAM` | A non-stream card has `stream=1`. | Fix that card's `tournament.cfg`. |
| Set column shows `set 12345` instead of names | The set left the cache mid-set (completed or reset upstream). | Station clears on its next LIST_SETS; check start.gg if the players did not finish it. |
| Relay restarted mid-tournament (`systemctl` shows a recent start) | Fine: claims are replayed from the audit log; a rebooted Wii sees its current set first and resumes with START. The CSS overlay restarts at 0–0; the player re-enters the score (design §8). | Nothing, unless the audit log was deleted. |

Fallback for anything else: the TO runs the set on start.gg by hand as before. The relay never blocks that.
