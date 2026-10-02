// status.ts -- server-rendered status page on :29473 (architecture.md Relay,
// requirement F7). Reading needs no auth: the LAN is the trust boundary, same
// as the TSH laptop. One row per station with its set, score, last action
// (with the status and message the player saw), and any failed start.gg
// call; rows with a failed start.gg call stay flagged until the TO clicks
// ack. Plain HTML, no client JS; a meta refresh every 5 s. Readable on a
// phone (viewport meta, wrapping table).
//
// The TO's actions (admin.ts) -- free a stuck station, set a waiting set's
// best-of -- need adminPassword through HTTP Basic auth: the browser asks
// once, any user name. Freeing goes through a confirm page that names the
// set and the score it discards. A POST whose Origin is another site is
// refused, so a page elsewhere cannot use the browser's saved password.
//
// The footer is the "night of" dashboard: event id, cache size and age
// (stale = warning), how many sets are selectable vs on stations, upstream
// call rate, the last refresh error, and the R8 preview-id warning.
//
// "Wii consoles" is each Wii's own report (telemetry.ts): when it was last
// heard, whether its tournament module loaded and why not, and the tail of
// its kernel log; /log?station=N is the whole log as plain text.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { SetCache } from './cache.js';
import type { StationState } from './state.js';
import type { StartggClient } from './startgg.js';
import type { BeaconStatus } from './beacon.js';
import type { RefusedStatus } from './tcp.js';
import {
  crashText,
  hexAddr,
  moduleStateText,
  type StationTelemetryRow,
  type TelemetryRefused,
} from './telemetry.js';
import { ModuleState } from '../generated/wire.js';
import type { Admin, AdminResult } from './admin.js';

export interface StatusDeps {
  state: StationState;
  cache: SetCache;
  startgg: StartggClient;
  streamStation: number;
  /** Tonight's tournament and event as resolve.ts found them, shown in the header so the TO can see it is the right week. */
  eventLabel: string;
  /** Discovery beacon (decisions.md R15): where it is announcing the relay, and any send error. */
  beacon: { status(): BeaconStatus };
  /** Requests refused for their secret (decisions.md R16): a mis-copied SD card, or someone else on the Wi-Fi. */
  tcp: { refused(): RefusedStatus | null };
  /** Each Wii's own boot report: module load status and kernel log (telemetry.ts). */
  telemetry: {
    stations(): StationTelemetryRow[];
    get(station: number): StationTelemetryRow | undefined;
    refused(): TelemetryRefused | null;
    beaconRequested?(): { count: number; lastAt: number; lastFrom: string } | null;
  };
  /** The TO's actions and the password they need; without them the page is read-only. */
  admin?: { actions: Admin; password: string };
}

/** A Wii not heard from for this long is shown as silent (it sends a status every 5 s). */
export const SILENT_STATION_MS = 20_000;
/** Log lines shown per Wii on the main page; the rest is on /log. */
export const LOG_TAIL_LINES = 6;

/** Cache older than this (3 missed 20 s refreshes) is flagged as stale. */
export const STALE_CACHE_MS = 60_000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function age(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/** HTTP Basic: any user name, the password compared in constant time. */
export function passwordMatches(header: string | undefined, password: string): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header ?? '');
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  const given = Buffer.from(decoded.slice(colon + 1), 'utf8');
  const want = Buffer.from(password, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

/** A POST with an Origin header must come from this page's own host. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
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
      if (url.pathname === '/free' || url.pathname === '/bestof') {
        void this.adminRoute(req, res, url);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/log') {
        const row = this.deps.telemetry.get(Number(url.searchParams.get('station')));
        res.writeHead(row ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(
          row
            ? `station ${row.station} (${row.from}), last heard ${age(row.lastSeenAt)} ago\n\n${row.lines.join('\n')}\n`
            : 'no telemetry from that station\n',
        );
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(this.render(url.searchParams.get('done'), url.searchParams.get('error')));
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
    await new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
  }

  render(done: string | null = null, error: string | null = null): string {
    const { state, cache, startgg, streamStation, eventLabel, beacon, tcp, telemetry, admin } =
      this.deps;
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
      const free =
        admin && claim
          ? ` <form method="get" action="/free"><input type="hidden" name="station" value="${station}"><button>free</button></form>`
          : '';
      return `<tr><td>${station}${star}</td><td>${escapeHtml(setText)}${free}</td><td>${score}</td><td>${actionText}</td><td>${status}</td></tr>`;
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
    const errorLine = cs.error
      ? `<p class="warn">✗ last refresh failed: ${escapeHtml(cs.error)}</p>`
      : '';

    const wiiRows = telemetry.stations().map((t) => {
      const silent = Date.now() - t.lastSeenAt > SILENT_STATION_MS;
      const heard = `${age(t.lastSeenAt)} ago${silent ? ' <span class="warn">(silent)</span>' : ''}`;
      const mod = t.status
        ? t.status.module_state === ModuleState.MOD_LOADED ||
          t.status.module_state === ModuleState.MOD_PENDING
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
          `stack: ${
            [...t.crash.stack]
              .filter(Boolean)
              .map((a) => escapeHtml(hexAddr(a, t.status)))
              .join(' &lt; ') || '—'
          }</span>`
        : '';
      return (
        `<tr><td>${t.station}</td><td>${heard}<br><span class="muted">${escapeHtml(t.from)}</span></td>` +
        `<td>${mod}${extra.length ? `<br><span class="muted">${escapeHtml(extra.join(', '))}</span>` : ''}${crash}</td>` +
        `<td><pre>${tail || '<span class="muted">no log yet</span>'}</pre><a href="/log?station=${t.station}">full log</a></td></tr>`
      );
    });
    if (wiiRows.length === 0) {
      wiiRows.push(
        '<tr><td colspan="4" class="muted">no Wii has reported yet (needs the telemetry kernel and Nintendont Network on)</td></tr>',
      );
    }
    const br = telemetry.beaconRequested?.() ?? null;
    const beaconRequestLine = br
      ? `<p class="muted">${br.count} beacon request(s) answered — a Wii that could not hear the broadcast asked instead; last ${age(br.lastAt)} ago from ${escapeHtml(br.lastFrom)}.</p>`
      : '';
    const trf = telemetry.refused();
    const telemetryRefusedLine = trf
      ? `<p class="warn">✗ ${trf.count} Wii report(s) dropped for a wrong relay secret — last ${age(trf.lastAt)} ago from ${escapeHtml(trf.lastFrom)} claiming station ${trf.lastStation}.</p>`
      : '';
    const warningLines = cs.warnings.map((w) => `<p class="warn">⚠ ${escapeHtml(w)}</p>`).join('');
    const banner = error
      ? `<p class="warn">✗ ${escapeHtml(error)}</p>`
      : done
        ? `<p class="ok">✓ ${escapeHtml(done)}</p>`
        : '';
    const waiting = admin ? this.renderWaiting() : '';

    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5;url=/">
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
  .ok { color: #070; }
  .muted { color: #888; }
  form { display: inline; }
  pre { margin: 0 0 0.3em; white-space: pre-wrap; word-break: break-all; font-size: 0.85em; }
  button { font: inherit; padding: 0.3em 0.9em; min-height: 2.2em; }
  @media (prefers-color-scheme: dark) {
    body { background: #111827; color: #e5e7eb; }
    td, th { border-bottom-color: #374151; }
    .warn { color: #fbbf24; }
    .ok { color: #4ade80; }
    .muted { color: #9ca3af; }
    a { color: #93c5fd; }
    button {
      color: #f9fafb;
      background: #1f2937;
      border: 1px solid #4b5563;
    }
  }
  @media (max-width: 600px) {
    body { font-size: 14px; margin: 0.5em; }
    td, th { padding: 0.3em 0.4em; }
  }
</style></head><body>
<h1>LazyTO</h1>
${banner}<p class="sub"><b>${escapeHtml(eventLabel)}</b> · stream station ${streamStation} ★ · refreshes every 5 s</p>
<div class="scroll"><table>
<tr><th>Station</th><th>Set</th><th>Score</th><th>Last action</th><th>start.gg</th></tr>
${rows.join('\n')}
</table></div>
${waiting}
<h2>Wii consoles</h2>
<div class="scroll"><table>
<tr><th>Station</th><th>Last heard</th><th>Tournament module</th><th>Kernel log</th></tr>
${wiiRows.join('\n')}
</table></div>
${telemetryRefusedLine}
${beaconRequestLine}
<p>${cacheLine}   Upstream: ${startgg.callsInWindow()} calls last 60s.</p>
${beaconLine}
${refusedLine}
${staleLine}${errorLine}${warningLines}
</body></html>`;
  }

  /** Sets waiting for a station, with the TO's best-of buttons. */
  private renderWaiting(): string {
    const { cache, state } = this.deps;
    const sets = cache.pending().filter((s) => state.stationFor(s.id) === undefined);
    const rows = sets.map((s) => {
      const buttons = [3, 5]
        .filter((bo) => bo !== s.bestOf)
        .map(
          (bo) =>
            `<form method="post" action="/bestof?set=${s.id}&amp;bo=${bo}"><button>Bo${bo}</button></form>`,
        );
      if (s.bestOfOverridden) {
        buttons.push(
          `<form method="post" action="/bestof?set=${s.id}&amp;bo=auto"><button>auto (Bo${s.autoBestOf})</button></form>`,
        );
      }
      const mark = s.bestOfOverridden ? ' <span class="muted">set by TO</span>' : '';
      return (
        `<tr><td>${escapeHtml(s.roundShort)}</td><td>${escapeHtml(s.p1.tag)} vs ${escapeHtml(s.p2.tag)}</td>` +
        `<td>Bo${s.bestOf}${mark}</td><td>${buttons.join(' ')}</td></tr>`
      );
    });
    if (rows.length === 0) {
      rows.push('<tr><td colspan="4" class="muted">no set is waiting</td></tr>');
    }
    return `<h2>Waiting sets</h2>
<div class="scroll"><table>
<tr><th>Round</th><th>Set</th><th>Best of</th><th>Change</th></tr>
${rows.join('\n')}
</table></div>`;
  }

  /** /free and /bestof: password first, then same-origin for POSTs, then the action. */
  private async adminRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const admin = this.deps.admin;
    if (!admin) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (!passwordMatches(req.headers.authorization, admin.password)) {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="LazyTO TO actions", charset="UTF-8"',
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('The TO password (ADMIN_PASSWORD in .env) is needed for this.\n');
      return;
    }
    if (req.method === 'POST' && !sameOrigin(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('refused: request from another site\n');
      return;
    }

    const station = Number(url.searchParams.get('station'));
    if (url.pathname === '/free' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(this.renderFreeConfirm(station));
      return;
    }
    let result: AdminResult;
    if (url.pathname === '/free' && req.method === 'POST') {
      result = await admin.actions.freeStation(station, Number(url.searchParams.get('set')));
    } else if (url.pathname === '/bestof' && req.method === 'POST') {
      const bo = url.searchParams.get('bo');
      result = admin.actions.setBestOf(
        Number(url.searchParams.get('set')),
        bo === 'auto' ? null : Number(bo),
      );
    } else {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    const q = new URLSearchParams({ [result.ok ? 'done' : 'error']: result.msg });
    res.writeHead(303, { location: `/?${q.toString()}` });
    res.end();
  }

  private renderFreeConfirm(station: number): string {
    const { state, cache } = this.deps;
    const claim = state.get(station);
    let body: string;
    if (!claim) {
      body = `<p>Station ${station} has no set.</p>`;
    } else {
      const set = cache.get(claim.setId);
      const w1 = claim.games.filter((g) => g.winner_slot === 1).length;
      const w2 = claim.games.length - w1;
      const name = set
        ? `${escapeHtml(set.roundShort)} ${escapeHtml(set.p1.tag)} vs ${escapeHtml(set.p2.tag)}`
        : `set ${claim.setId}`;
      const effect = set
        ? claim.games.length > 0
          ? `<p class="warn">This resets the set on start.gg and discards its score, ${w1}–${w2}. The players replay it from 0–0 on any setup.</p>`
          : `<p>This resets the set on start.gg. It goes back on every Wii's list.</p>`
        : `<p>The set has already left start.gg's pending list; this only frees the station.</p>`;
      body =
        `<p>Free station ${station}, playing <b>${name}</b>?</p>${effect}` +
        `<form method="post" action="/free?station=${station}&amp;set=${claim.setId}"><button>Free station ${station}</button></form> ` +
        `<a href="/">cancel</a>`;
    }
    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LazyTO</title>
<style>
  body { font-family: monospace; font-size: 16px; margin: 1em; }
  .warn { color: #a40; }
  form { display: inline; }
  button { font: inherit; padding: 0.3em 0.9em; min-height: 2.2em; }
  @media (prefers-color-scheme: dark) {
    body { background: #111827; color: #e5e7eb; }
    .warn { color: #fbbf24; }
    a { color: #93c5fd; }
    button { color: #f9fafb; background: #1f2937; border: 1px solid #4b5563; }
  }
</style></head><body>
<h1>LazyTO</h1>
${body}
</body></html>`;
  }
}
