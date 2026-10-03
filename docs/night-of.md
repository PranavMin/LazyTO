# Running a tournament

Everything here works from your phone: the status page at http://relay.local:29473.

## Before players arrive

1. **Power on the Pi.** The relay looks your tournament up at every start, so there is nothing
   to change from week to week. Open the status page. The header must name tonight's tournament
   and event, and the line under the tables must show `Cache: N sets`.
2. **Start every pool and phase on start.gg**, later phases included. Sets in a pool that hasn't
   started can't be reported. The status page shows `⚠ N preview-id set(s) dropped` until every
   pool is started.
3. **Check the stations.** Each Wii's card comes from its own station's zip, so its station
   number matches its label.
4. **Boot every Wii.** Each one shows the set list and appears in the status page's **Wii
   consoles** table.

If the relay can't start its event, the page says **Not running** with the reason and a
**Retry now** button. The usual causes are a short URL not moved to tonight's tournament, an
event renamed on start.gg, or a missing stream: fix it on start.gg or on the settings page, then
tap Retry now.

## The status page

It refreshes every 5 seconds. Lines marked ✗ stay until you press **ack** on them. The page's
buttons (ack, free station, a set's best-of) and the **settings** and **SD cards** pages need
your admin password; your browser asks for it once.

**Stations table.** One row per Wii that has made a request: the set it is playing, the score,
its last action, and the result of its last start.gg call. ★ marks the stream station.

**Wii consoles table.** One row per Wii that has sent its log: when it was last heard, whether
the kiosk module loaded, and its last log lines. "full log" shows everything since boot.

**Lines below the tables:**

| Line | Meaning |
|---|---|
| `Cache: N sets (... selectable, ... on stations), refreshed ... ago` | Normal. Sets refresh from start.gg every 20 seconds. |
| `Discovery beacon to <addresses>, last sent ... ago` | Normal. Where the relay is announcing itself. |
| `N beacon request(s) answered` | Normal. A Wii couldn't hear the announcement and asked directly. |
| `LazyTO <version> · this relay: <addresses>` | The installed version, and the page's addresses if `relay.local` doesn't open. |

## When something goes wrong

| Status page shows | Meaning | Do |
|---|---|---|
| Page does not load | Pi off, not on the network, or `relay.local` not resolving | Use the Pi's address from the router, or the one the page footer showed before. If the Pi is on, `ssh pi@relay.local systemctl status lazyto-relay`. |
| **Not running** with a reason | The relay couldn't start tonight's event | Fix what the reason names, on start.gg or on the settings page, then tap Retry now. [pi-setup.md](pi-setup.md#troubleshooting) explains each reason. |
| Header names the wrong week | The short URL had not moved when the relay started | Move the short URL on start.gg, then open **settings** and press Save: the relay looks the tournament up again. |
| `Cache: 0 sets` | No set has both players yet | Start the bracket. |
| `⚠ N preview-id set(s) dropped` | A pool or phase isn't started | Start it. The warning clears within 20 seconds. |
| `⚠ cache is stale` or `✗ last refresh failed: start.gg unreachable` | The venue internet is down | Fix the uplink. Wiis keep the last set list, but every action fails until it is back. The relay recovers by itself. |
| `✗ last refresh failed: ... Invalid authentication token` | The token was revoked or expired | Make a new token and paste it on the settings page (Replace the token). |
| `✗ discovery beacon: ...` | The relay can't announce itself | The Pi has lost its network. Check its Wi-Fi. |
| `no station has connected yet` with Wiis booted | No Wii can reach the relay | Wiis and Pi on different networks, or a guest network isolating them. See the Wii's own message. |
| `no Wii has reported yet` | No Wii log reached the relay | Same causes as above, or the loader's Network setting is off: turn it on in the loader's menu (hold B as it starts), or copy `lazyto_nincfg.bin` from the station's zip onto the card again. |
| Wii consoles: `(silent)` | That Wii stopped sending its log | It is off, rebooting, or lost the Wi-Fi. |
| Wii consoles: `✗ crashed` | That Wii's game crashed | Power cycle it. Note the crash line for a bug report. |
| Wii consoles: module not loaded, with a reason | The kiosk didn't start on that Wii | Unzip the station's zip onto the card again. |
| `✗ N request(s) refused: wrong relay secret` or `✗ N Wii report(s) dropped for a wrong relay secret` | A card has the wrong `secret=`, or something else on the network is trying the relay. Nothing reached start.gg. | Copy `lazyto_station.txt` from the station's zip onto that card. If it is not one of your Wiis, tick "Make a new Wii secret" on the settings page, save, and remake the cards. |
| Station: `✗ assignStream failed` | The set started on start.gg but is not on stream | Assign it to the stream on start.gg, then ack. |
| Station: `✗ reportBracketSet failed: start.gg rejected` | start.gg refused the score, usually because the set was changed by hand | Sort it out on start.gg, then ack. The station clears on its next refresh. |
| Station: `✗ ... start.gg HTTP 5xx after 3 attempts` | start.gg had an outage. The relay already retried twice. | The player tries again later. Each report overwrites the last, so nothing is lost. |
| Last action `ST_RATE_LIMITED` | More than 70 start.gg calls in a minute | Wait a minute. If it repeats, something is looping: check the log. |
| Last action `ST_SET_TAKEN` | Two stations picked the same set, or it was started by hand | Nothing to do. The players pick another set. |
| Set shows as `set 12345` | The set left start.gg's pending list mid-set | The station clears on its next refresh. Check start.gg if the players didn't finish. |
| A Wii died or froze mid-set and its station still shows the set | The set is in progress on start.gg, so no other Wii can take it | Tap **free station**. The page shows the set and the score it will discard; confirm. The set goes back on every Wii's list at 0-0. |
| A set needs a different best-of | The format rule is wrong for this set, or start.gg won't take a short set | Under **Waiting sets**, tap Bo3 or Bo5. **auto** goes back to the rule. A set already on a station can't change; free it first if you must. |
| The relay restarted mid-tournament | Fine. Claimed sets come back from the action log. | Nothing to do. A rebooted Wii shows its current set again. |

For problems on a single Wii, see the table in [wii-setup.md](wii-setup.md).

**Anything else:** run the set on start.gg by hand, as you would without LazyTO. The relay
never blocks that.
