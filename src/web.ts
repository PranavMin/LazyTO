// web.ts -- the relay's one web server on :29473 (architecture.md Relay). It
// starts before anything else and stays up whatever the event is doing, so the
// TO always has a page: the setup wizard before the relay is set up
// (setup.ts), the reason and a Retry button when tonight's event can't be
// found, and the status page with the TO's actions while it runs (status.ts).
// Plain server-rendered HTML, no client JS.
//
// Protection. Reading the status page needs nothing: the LAN is the trust
// boundary. Settings and the TO's actions need the admin password through
// HTTP Basic auth (the browser asks once, any user name); the very first
// setup needs the one-time setup code instead (app.ts). Every POST must also
// come from this page itself: the Origin, when the browser sends one, must be
// this host, and the Host must be this relay by IP, by *.local name or by
// hostname -- so another site can neither use the browser's saved password nor
// reach the relay through a DNS name it controls.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import type { AddressInfo } from 'node:net';

export const FORM_LIMIT_BYTES = 16 * 1024;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function age(at: number): string {
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
  return secretEquals(decoded.slice(colon + 1), password);
}

/** Constant-time string comparison. */
export function secretEquals(given: string, want: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(want, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
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

/** The relay addressed as itself: an IP literal, localhost, a *.local name, or its hostname. */
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let name: string;
  try {
    name = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  return (
    isIP(name) !== 0 ||
    name === 'localhost' ||
    name.endsWith('.local') ||
    name === hostname().toLowerCase()
  );
}

/** Answer 401 with the Basic auth challenge unless the request carries the password. */
export function requirePassword(
  req: IncomingMessage,
  res: ServerResponse,
  password: string,
): boolean {
  if (passwordMatches(req.headers.authorization, password)) return true;
  res.writeHead(401, {
    'www-authenticate': 'Basic realm="LazyTO TO actions", charset="UTF-8"',
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end('The relay admin password (set on the setup page) is needed for this.\n');
  return false;
}

/**
 * The urlencoded body of a POST, at most FORM_LIMIT_BYTES. A bigger body is
 * read to its end but not kept, then refused, so the caller can still answer.
 */
export function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= FORM_LIMIT_BYTES) chunks.push(c);
    });
    req.on('end', () => {
      if (size > FORM_LIMIT_BYTES) reject(new Error('form too large'));
      else resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
  });
}

export function sendHtml(res: ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location });
  res.end();
}

/** Back to the main page with a ✓ or ✗ line on it. */
export function redirectWithResult(res: ServerResponse, ok: boolean, msg: string): void {
  redirect(res, `/?${new URLSearchParams({ [ok ? 'done' : 'error']: msg }).toString()}`);
}

/**
 * One stylesheet for every page. Phone first: the TO runs the night from a
 * phone, so every block is a full-width card, text wraps instead of
 * scrolling sideways, and buttons are at least 44 px tall.
 */
export const PAGE_CSS = `
  :root {
    --bg: #f8fafc; --fg: #0f172a; --card: #ffffff; --line: #e2e8f0;
    --muted: #64748b; --warn: #b45309; --bad: #b91c1c; --ok: #15803d;
    --btn: #f1f5f9; --btnline: #cbd5e1; --link: #1d4ed8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b1120; --fg: #e5e7eb; --card: #111827; --line: #1f2937;
      --muted: #9ca3af; --warn: #fbbf24; --bad: #f87171; --ok: #4ade80;
      --btn: #1f2937; --btnline: #4b5563; --link: #93c5fd;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 12px 16px 32px; max-width: 56rem;
    font: 16px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg); color: var(--fg); overflow-wrap: anywhere;
  }
  h1 { font-size: 1.3em; margin: 0 0 0.2em; }
  h2 { font-size: 1.05em; margin: 1.4em 0 0.5em; }
  .sub { margin: 0 0 0.8em; color: var(--muted); }
  .sub b { color: var(--fg); }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 12px; margin: 0 0 8px;
  }
  .card.bad { border-color: var(--warn); border-left-width: 4px; }
  .row { display: flex; align-items: baseline; gap: 4px 10px; flex-wrap: wrap; }
  .grow { flex: 1 1 10rem; min-width: 0; }
  .st { font-weight: 700; min-width: 2.2em; }
  .score { font-weight: 700; font-size: 1.2em; font-variant-numeric: tabular-nums; }
  .line { margin-top: 4px; }
  .acts { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .item { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid var(--line); }
  .item:first-child { border-top: 0; padding-top: 0; }
  .item:last-child { padding-bottom: 0; }
  .list { padding-top: 10px; padding-bottom: 10px; }
  .btns { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .rd { display: inline-block; min-width: 2.6em; }
  .warn { color: var(--warn); }
  .ok { color: var(--ok); }
  .muted { color: var(--muted); }
  .small { font-size: 0.85em; }
  p.warn, p.ok { font-weight: 600; }
  a { color: var(--link); }
  form { display: inline; margin: 0; }
  form.block { display: block; }
  button, .btnlink {
    font: inherit; font-weight: 600; min-height: 44px; min-width: 44px; padding: 0 14px;
    color: var(--fg); background: var(--btn); border: 1px solid var(--btnline); border-radius: 8px;
    display: inline-flex; align-items: center; justify-content: center; text-decoration: none;
  }
  button.danger { color: #fff; background: #dc2626; border-color: #dc2626; }
  button.primary { color: #fff; background: #2563eb; border-color: #2563eb; }
  label { display: block; margin: 10px 0 4px; font-weight: 600; }
  label.choice { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; margin: 0; padding: 8px 0; border-top: 1px solid var(--line); }
  label.choice:first-of-type { border-top: 0; }
  input[type=radio], input[type=checkbox] { width: 20px; height: 20px; margin: 2px 0 0; flex: none; }
  input[type=text], input[type=password], input[type=number], input[type=url] {
    font: inherit; width: 100%; min-height: 44px; padding: 0 10px; color: var(--fg);
    background: var(--card); border: 1px solid var(--btnline); border-radius: 8px;
  }
  details { margin-top: 6px; }
  summary { color: var(--muted); cursor: pointer; min-height: 32px; }
  pre {
    margin: 4px 0; white-space: pre-wrap; word-break: break-all; font-size: 0.8em;
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .foot { margin-top: 1.5em; font-size: 0.9em; }
  .foot p { margin: 0.4em 0; }
`;

/** A whole page: the shared head, the LazyTO header, and the body. */
export function page(body: string, opts: { refreshSeconds?: number } = {}): string {
  const refresh = opts.refreshSeconds
    ? `\n<meta http-equiv="refresh" content="${opts.refreshSeconds};url=/">`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refresh}
<title>LazyTO</title>
<style>${PAGE_CSS}</style></head><body>
<h1>LazyTO</h1>
${body}
</body></html>`;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

/**
 * The HTTP server. `handle` routes every request; this class adds what every
 * request needs: the POST checks (same origin, this relay's Host) and the
 * close that drops open browser connections.
 */
export class WebServer {
  private readonly server: Server;

  constructor(handle: Handler) {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://relay');
      if (req.method === 'POST' && (!sameOrigin(req) || !hostAllowed(req.headers.host))) {
        sendText(res, 403, 'refused: request from another site\n');
        return;
      }
      Promise.resolve(handle(req, res, url)).catch((e: unknown) => {
        console.error(`web: ${req.method} ${url.pathname}: ${String(e)}`);
        if (!res.headersSent) sendText(res, 500, 'internal error\n');
        else res.end();
      });
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

  /**
   * Stop listening and drop every open connection. server.close() alone waits
   * for a connection that has not sent a whole request yet, and nothing ever
   * times it out once the server is closing: a phone's browser holds such a
   * socket open between meta refreshes. Pages are rebuilt on every request,
   * so a dropped one costs nothing.
   */
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
    this.server.closeAllConnections();
    await closed;
  }
}
