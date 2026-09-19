// status.ts -- server-rendered status page on :8080 (design.md section 6.3).
// Read-only, no auth: the LAN is the trust boundary, same as the TSH laptop.
// One row per station with its set, score, last action, and status; rows
// with a failed start.gg call stay flagged until the TO clicks ack -- the
// only interactive element. Auto-refreshes every 5 s.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SetCache } from './cache.js';
import type { StationState } from './state.js';
import type { StartggClient } from './startgg.js';

export interface StatusDeps {
  state: StationState;
  cache: SetCache;
  startgg: StartggClient;
  streamStation: number;
}

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
    const { state, cache, startgg, streamStation } = this.deps;
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
      const actionText = action ? `${action.cmd.replace('CMD_', '')} ${age(action.at)}` : '—';
      const stationFlags = flags.filter((f) => f.station === station);
      const status = stationFlags.length
        ? stationFlags
            .map(
              (f) =>
                `✗ ${escapeHtml(f.message)} <form method="post" action="/ack?id=${f.id}"><button>ack</button></form>`,
            )
            .join('<br>')
        : 'OK';
      const star = station === streamStation ? ' ★' : '';
      return `<tr><td>${station}${star}</td><td>${escapeHtml(setText)}</td><td>${score}</td><td>${actionText}</td><td>${status}</td></tr>`;
    });

    const cs = cache.status();
    const cacheLine = cs.refreshedAt
      ? `Cache: ${cs.count} sets, refreshed ${age(cs.refreshedAt)} ago.`
      : 'Cache: never refreshed.';
    const errorLine = cs.error ? `<p class="warn">✗ last refresh failed: ${escapeHtml(cs.error)}</p>` : '';
    const warningLines = cs.warnings.map((w) => `<p class="warn">⚠ ${escapeHtml(w)}</p>`).join('');

    return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>Tournament Reporter</title>
<style>
  body { font-family: monospace; margin: 1.5em; }
  table { border-collapse: collapse; }
  td, th { padding: 0.3em 1em; border-bottom: 1px solid #ccc; text-align: left; }
  .warn { color: #a40; }
  form { display: inline; }
</style></head><body>
<h1>Tournament Reporter</h1>
<table>
<tr><th>Station</th><th>Set</th><th>Score</th><th>Last action</th><th>Status</th></tr>
${rows.join('\n')}
</table>
<p>${cacheLine}   Upstream: ${startgg.callsInWindow()} calls last 60s.</p>
${errorLine}${warningLines}
</body></html>`;
  }
}
