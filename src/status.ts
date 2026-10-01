// status.ts -- server-rendered status page on :8080 (design.md section 6.3,
// requirement F7). Read-only, no auth: the LAN is the trust boundary, same
// as the TSH laptop. One row per station with its set, score, last action
// (with the status and message the player saw), and any failed start.gg
// call; rows with a failed start.gg call stay flagged until the TO clicks
// ack -- the only interactive element. Plain HTML, no client JS; a meta
// refresh every 5 s. Readable on a phone (viewport meta, wrapping table).
//
// The footer is the "night of" dashboard: event id, cache size and age
// (stale = warning), how many sets are selectable vs on stations, upstream
// call rate, the last refresh error, and the R8 preview-id warning.
//
// "Wii consoles" is each Wii's own report (telemetry.ts): when it was last
// heard, whether its tournament module loaded and why not, and the tail of
// its kernel log; /log?station=N is the whole log as plain text.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SetCache } from './cache.js';
import type { StationState } from './state.js';
import type { StartggClient } from './startgg.js';
import type { BeaconStatus } from './beacon.js';
import type { RefusedStatus } from './tcp.js';
import { crashText, hexAddr, moduleStateText, type StationTelemetryRow, type TelemetryRefused } from './telemetry.js';
import { ModuleState } from '../generated/wire.js';

export interface StatusDeps {
  state: StationState;
  cache: SetCache;
  startgg: StartggClient;
  streamStation: number;
  /** Tonight's tournament and event as resolve.ts found them, shown in the header so the TO can see it is the right week. */
  eventLabel: string;
  /** Discovery beacon (design R15): where it is announcing the relay, and any send error. */
  beacon: { status(): BeaconStatus };
  /** Requests refused for their secret (design R16): a mis-copied SD card, or someone else on the Wi-Fi. */
  tcp: { refused(): RefusedStatus | null };
  /** Each Wii's own boot report: module load status and kernel log (telemetry.ts). */
  telemetry: { stations(): StationTelemetryRow[]; get(station: number): StationTelemetryRow | undefined; refused(): TelemetryRefused | null };
}

/** A Wii not heard from for this long is shown as silent (it sends a status every 5 s). */
export const SILENT_STATION_MS = 20_000;
/** Log lines shown per Wii on the main page; the rest is on /log. */
export const LOG_TAIL_LINES = 6;

/** Cache older than this (3 missed 20 s refreshes) is flagged as stale. */
export const STALE_CACHE_MS = 60_000;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function age(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`;
}

export class StatusServer {
  private readonly server: Server;

  constructor(private readonly deps: StatusDeps) {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://relay');
      if (req.method === 'POST' && url.pathname === '/ack') {
        const ok = this.deps.state.ack(Number(url.searchParams.get('id')));
        res.writeHead(ok ? 303 : 404, { location: '/' });
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/log') {
        const row = this.deps.telemetry.get(Number(url.searchParams.get('station')));
        res.writeHead(row ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(row ? `station ${row.station} (${row.from}), last heard ${age(row.lastSeenAt)} ago\n\n${row.lines.join('\n')}\n` : 'no telemetry from that station\n');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(this.render());
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  }

  async listen(port: number, host = '0.0.0.0'): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  address(): AddressInfo {
    return this.server.address() as AddressInfo;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((e) => (e ? reject(e) : resolve())));
  }

  render(): string {
    const { state, cache, startgg, streamStation, eventLabel, beacon, tcp, telemetry } = this.deps;
    const flags = state.flags();

    const rows = state.stations().map((station) => {
      const claim = state.get(station);
      const set = claim ? cache.get(claim.setId) : undefined;
      const setText = claim
        ? set
          ? `${set.roundShort}  ${set.p1.tag} vs ${set.p2.tag} (Bo${set.bestOf})`
          : `set ${claim.setId}`
        : '—';
      const score = claim?.games.length
        ? `${claim.games.filter((g) => g.winner_slot === 1).length}–${claim.games.filter((g) => g.winner_slot === 2).length}`
        : '—';

      const action = state.lastAction(station);
      let actionText = '—';
      if (action) {
        const cmd = escapeHtml(action.cmd.replace('CMD_', ''));
        actionText = action.ok
          ? `${cmd} ${age(action.at)} ago`
          : `<span class="warn">✗ ${cmd} ${age(action.at)} ago — ${escapeHtml(action.status)}: ${escapeHtml(action.msg)}</span>`;
      }

      const stationFlags = flags.filter((f) => f.station === station);
      const status = stationFlags.length
        ? stationFlags
            .map(
              (f) =>
                `<span class="warn">✗ ${escapeHtml(f.message)} (${age(f.at)} ago)</span> ` +
                `<form method="post" action="/ack?id=${f.id}"><button>ack</button></form>`,
            )
            .join('<br>')
        : 'OK';
      const star = station === streamStation ? ' ★' : '';
      return `<tr><td>${station}${star}</td><td>${escapeHtml(setText)}</td><td>${score}</td><td>${actionText}</td><td>${status}</td></tr>`;
    });
    if (rows.length === 0) {
      rows.push('<tr><td colspan="5" class="muted">no station has connected yet</td></tr>');
    }

    const cs = cache.status();
    const onStations = state.stations().filter((s) => state.get(s) !== undefined).length;
    const selectable = cache.pending().filter((s) => state.stationFor(s.id) === undefined).length;
    const stale = cs.refreshedAt > 0 && Date.now() - cs.refreshedAt > STALE_CACHE_MS;
    const cacheLine = cs.refreshedAt
      ? `Cache: ${cs.count} sets (${selectable} selectable, ${onStations} on stations), refreshed ${age(cs.refreshedAt)} ago.`
      : 'Cache: never refreshed.';
    const staleLine = stale
      ? `<p class="warn">⚠ cache is stale (last refresh ${age(cs.refreshedAt)} ago; expected every 20 s) — is start.gg reachable?</p>`
      : '';
    const rf = tcp.refused();
    const refusedLine = rf
      ? `<p class="warn">✗ ${rf.count} request(s) refused: ${escapeHtml(rf.lastReason)} — last ${age(rf.lastAt)} ago from ${escapeHtml(rf.lastFrom)} claiming station ${rf.lastStation}. A Wii there needs the relay's secret= on its SD card.</p>`
      : '';
    const bs = beacon.status();
    const beaconLine = bs.lastError
      ? `<p class="warn">✗ discovery beacon: ${escapeHtml(bs.lastError)} — Wiis cannot find the relay</p>`
      : `<p class="muted">Discovery beacon to ${bs.targets.map(escapeHtml).join(', ') || '—'}, last sent ${bs.lastSentAt ? `${age(bs.lastSentAt)} ago` : 'never'}.</p>`;
    const errorLine = cs.error ? `<p class="warn">✗ last refresh failed: ${escapeHtml(cs.error)}</p>` : '';

    const wiiRows = telemetry.stations().map((t) => {
      const silent = Date.now() - t.lastSeenAt > SILENT_STATION_MS;
      const heard = `${age(t.lastSeenAt)} ago${silent ? ' <span class="warn">(silent)</span>' : ''}`;
      const mod = t.status
        ? t.status.module_state === ModuleState.MOD_LOADED || t.status.module_state === ModuleState.MOD_PENDING
          ? escapeHtml(moduleStateText(t.status))
          : `<span class="warn">✗ ${escapeHtml(moduleStateText(t.status))}</span>`
        : '<span class="muted">no status yet</span>';
      const extra = [
        t.lost ? `${t.lost} datagram(s) lost` : '',
        t.reboots ? `${t.reboots} reboot(s)` : '',
        t.status?.log_dropped ? `${t.status.log_dropped} log bytes dropped on the Wii` : '',
      ].filter(Boolean);
      const tail = t.lines.slice(-LOG_TAIL_LINES).map(escapeHtml).join('\n');
      const crash = t.crash
        ? `<br><span class="warn">✗ crashed ${t.crashAt ? `${age(t.crashAt)} ago` : ''}: ${escapeHtml(crashText(t.crash, t.status))}</span>` +
          `<br><span class="muted">words at the fault: ${t.crash.fetched.map((w) => w.toString(16).padStart(8, '0')).join(' ')}; ` +
          `stack: ${[...t.crash.stack].filter(Boolean).map((a) => escapeHtml(hexAddr(a, t.status))).join(' &lt; ') || '—'}</span>`
        : '';
      return (
        `<tr><td>${t.station}</td><td>${heard}<br><span class="muted">${escapeHtml(t.from)}</span></td>` +
        `<td>${mod}${extra.length ? `<br><span class="muted">${escapeHtml(extra.join(', '))}</span>` : ''}${crash}</td>` +
        `<td><pre>${tail || '<span class="muted">no log yet</span>'}</pre><a href="/log?station=${t.station}">full log</a></td></tr>`
      );
    });
    if (wiiRows.length === 0) {
      wiiRows.push('<tr><td colspan="4" class="muted">no Wii has reported yet (needs the telemetry kernel and Nintendont Network on)</td></tr>');
    }
    const trf = telemetry.refused();
    const telemetryRefusedLine = trf
      ? `<p class="warn">✗ ${trf.count} Wii report(s) dropped for a wrong relay secret — last ${age(trf.lastAt)} ago from ${escapeHtml(trf.lastFrom)} claiming station ${trf.lastStation}.</p>`
      : '';
    const warningLines = cs.warnings.map((w) => `<p class="warn">⚠ ${escapeHtml(w)}</p>`).join('');

    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>LazyTO</title>
<style>
  body { font-family: monospace; font-size: 16px; margin: 1em; }
  h1 { font-size: 1.25em; margin: 0 0 0.25em; }
  h2 { font-size: 1.1em; margin: 1.2em 0 0.4em; }
  .sub { margin: 0 0 1em; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  td, th { padding: 0.4em 0.6em; border-bottom: 1px solid #ccc; text-align: left; vertical-align: top; }
  td:first-child, td:nth-child(3) { white-space: nowrap; }
  .warn { color: #a40; }
  .muted { color: #888; }
  form { display: inline; }
  pre { margin: 0 0 0.3em; white-space: pre-wrap; word-break: break-all; font-size: 0.85em; }
  button { font: inherit; padding: 0.3em 0.9em; min-height: 2.2em; }
  @media (max-width: 600px) {
    body { font-size: 14px; margin: 0.5em; }
    td, th { padding: 0.3em 0.4em; }
  }
</style></head><body>
<h1>LazyTO</h1>
<p class="sub"><b>${escapeHtml(eventLabel)}</b> · stream station ${streamStation} ★ · refreshes every 5 s</p>
<div class="scroll"><table>
<tr><th>Station</th><th>Set</th><th>Score</th><th>Last action</th><th>start.gg</th></tr>
${rows.join('\n')}
</table></div>
<h2>Wii consoles</h2>
<div class="scroll"><table>
<tr><th>Station</th><th>Last heard</th><th>Tournament module</th><th>Kernel log</th></tr>
${wiiRows.join('\n')}
</table></div>
${telemetryRefusedLine}
<p>${cacheLine}   Upstream: ${startgg.callsInWindow()} calls last 60s.</p>
${beaconLine}
${refusedLine}
${staleLine}${errorLine}${warningLines}
</body></html>`;
  }
}
