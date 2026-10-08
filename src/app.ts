// app.ts -- the relay process (architecture.md Relay). The web server comes up
// first and stays up; the night's event runs behind it, in one of four modes:
//
//   setup     no valid settings yet: only the setup page (setup.ts), guarded
//             by a one-time setup code written to <dataDir>/setup-code
//   starting  settings saved: finding tonight's tournament and event
//   failed    the event couldn't be found or started (bad token, short URL on
//             no tournament, start.gg or the internet down, the clock not set
//             yet, another LazyTO relay on the network): the page shows why,
//             with Retry; it also retries by itself after 30 s, 60 s, then
//             every 2 min
//   running   relay.ts startEvent: TCP, beacon, telemetry; the status page
//
// Saving settings rewrites the file and applies it in this process: the
// running event stops and starts again from the new file. Claims survive,
// because the same event replays the same audit log.
//
// One LazyTO per network (guard.ts): with the network side on, the relay
// listens for other relays' beacons from the start, and an event does not
// start while another relay's beacon has been heard.
//
// Two accepted exceptions to fail-fast (CLAUDE.md): without valid settings the
// relay serves only the setup page, and a set-up relay whose event can't be
// resolved keeps its page up and tries again instead of exiting.

import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localAddresses } from './beacon.js';
import { RelayGuard } from './guard.js';
import type { Platform } from './platform.js';
import { STARTGG_ENDPOINT, configPath, loadConfig, saveConfig, type Config } from './config.js';
import type { RawStoreOptions } from './rawstore.js';
import { startEvent, type RunningEvent } from './relay.js';
import { resolveEvent, type Resolved } from './resolve.js';
import { StartggClient, type StartggClientOptions } from './startgg.js';
import { serveCards } from './cards.js';
import { renderStatus, serveAction, serveLog, type StatusView } from './status.js';
import { serveSetup } from './setup.js';
import {
  WebServer,
  age,
  escapeHtml,
  page,
  redirect,
  redirectWithResult,
  requirePassword,
  sendHtml,
  sendText,
} from './web.js';
import { BEACON_PORT } from '../generated/wire.js';

export type UpdateChannel = 'release' | 'main' | 'off';
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['release', 'main', 'off'];

export type Mode =
  | { kind: 'setup'; problems: string[] }
  | { kind: 'starting' }
  | { kind: 'failed'; reason: string; at: number; nextAt: number | null }
  | { kind: 'running'; ev: RunningEvent; resolved: Resolved; view: StatusView };

export interface AppOptions {
  /** Settings, setup code, update channel, audit logs and Wii logs. */
  dataDir: string;
  /** The bundle's wii/ folder, for the SD-card zips (cards.ts); absent when run from a clone. */
  wiiDir?: string;
  httpPort: number;
  tcpPort: number;
  /** Where the web server and TCP listen; default all interfaces. */
  host?: string;
  /** Beacon and telemetry; off in tests. */
  network?: boolean;
  /**
   * The archive folder unless the settings name one (config.ts archiveDir):
   * raw replays, unmatched/, archive.json and the set zips (rawstore.ts,
   * archive.ts). main.ts passes Documents/LazyTO (config.ts
   * defaultArchiveDir), the desktop app its Documents folder's, tests a
   * temporary one, so no test ever writes to the real one.
   */
  archiveDir: string;
  /** Tests stand in a full disk and shorten the download stall timeout. */
  rawStore?: RawStoreOptions;
  stallMs?: number;
  /**
   * The one-relay-per-network guard; by default one on BEACON_PORT with the
   * network side on, none without it. Tests pass one on an ephemeral port.
   */
  guard?: RelayGuard;
  /** start.gg's GraphQL URL; tests point it at the fake. */
  startggEndpoint?: string;
  startggOptions?: Pick<StartggClientOptions, 'limits' | 'retryDelaysMs'>;
  /** Waits before automatic retries of a failed start; the last one repeats. */
  retryDelaysMs?: number[];
  version?: string;
  /** Whether the system clock is set (the weekly fallback picks the weekly nearest "now"). */
  clockSynced?: () => boolean;
  /** The desktop app's view of the laptop (platform.ts); absent when the relay runs on its own. */
  platform?: Platform;
}

const DEFAULT_RETRY_DELAYS_MS = [30_000, 60_000, 120_000];
const CLOCK_RETRY_MS = 5_000;
/** Wrong setup codes allowed per minute before the page stops checking them. */
const SETUP_CODE_TRIES_PER_MINUTE = 10;

/** True unless timedatectl says the clock is not synchronized yet (no timedatectl: a dev machine). */
function systemClockSynced(): boolean {
  try {
    return (
      execFileSync('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], {
        encoding: 'utf8',
        timeout: 2000,
      }).trim() !== 'no'
    );
  } catch {
    return true;
  }
}

export class App {
  readonly web: WebServer;
  readonly version: string;
  // Until apply() has read the settings: "starting", never a setup page by mistake.
  private mode: Mode = { kind: 'starting' };
  private settings: Config | null = null;
  private generation = 0;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private codeFailures: number[] = [];
  private readonly guard: RelayGuard | null;

  constructor(private readonly opts: AppOptions) {
    this.version = opts.version ?? 'dev';
    this.guard =
      opts.guard ?? (opts.network === false ? null : new RelayGuard({ port: BEACON_PORT }));
    this.web = new WebServer((req, res, url) => this.route(req, res, url));
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    await (
      await this.serve()
    ).applied;
  }

  /**
   * start(), resolved as soon as the web server is up, so the desktop app can
   * show the page while tonight's event is still being found. The mode is
   * already "setup" or "starting" by then; `applied` settles once the event
   * runs or has failed. Throws (EADDRINUSE) when port 29473 is taken.
   */
  async serve(): Promise<{ applied: Promise<void> }> {
    await this.web.listen(this.opts.httpPort, this.opts.host);
    // Listening from the start, so another relay is heard before the event would start.
    await this.guard?.listen();
    return { applied: this.apply() };
  }

  async stop(): Promise<void> {
    this.generation++;
    this.clearRetry();
    const m = this.mode;
    if (m.kind === 'running') {
      m.ev.audit.record({ type: 'shutdown' });
      await m.ev.stop();
    }
    await this.guard?.stop();
    await this.web.close();
  }

  current(): Mode {
    return this.mode;
  }

  /** The saved, valid settings; null until the relay is set up. */
  config(): Config | null {
    return this.settings;
  }

  startgg(token: string): StartggClient {
    return new StartggClient({
      endpoint: this.opts.startggEndpoint ?? STARTGG_ENDPOINT,
      token,
      ...this.opts.startggOptions,
    });
  }

  addresses(): string[] {
    return localAddresses();
  }

  /** Why the saved settings can't be used, in setup mode; [] otherwise. */
  setupProblems(): string[] {
    return this.mode.kind === 'setup' ? this.mode.problems : [];
  }

  /** Stations playing a set right now (a settings save restarts the relay under them). */
  stationsMidSet(): number {
    if (this.mode.kind !== 'running') return 0;
    const state = this.mode.ev.state;
    return state.stations().filter((s) => state.get(s) !== undefined).length;
  }

  /** The archive folder when the settings leave it blank. */
  defaultArchiveDir(): string {
    return this.opts.archiveDir;
  }

  /** Where tonight's set archives go: the settings' folder, or the default one. */
  archiveDir(config: Config): string {
    return config.archiveDir === '' ? this.defaultArchiveDir() : config.archiveDir;
  }

  /** True in the desktop app, which checks for new versions itself (no update channel). */
  updatesByApp(): boolean {
    return this.opts.platform !== undefined;
  }

  /** Save new settings (and the update channel) and apply them now. */
  async save(config: Config, channel: UpdateChannel): Promise<void> {
    saveConfig(configPath(this.opts.dataDir), config);
    writeFileSync(join(this.opts.dataDir, 'update-channel'), `${channel}\n`);
    rmSync(this.setupCodePath(), { force: true });
    await this.apply();
  }

  updateChannel(): UpdateChannel {
    try {
      const v = readFileSync(join(this.opts.dataDir, 'update-channel'), 'utf8').trim();
      if ((UPDATE_CHANNELS as readonly string[]).includes(v)) return v as UpdateChannel;
    } catch {
      // no file: the default
    }
    return 'release';
  }

  /** Try a failed start again now (ignored while one is under way). */
  retryNow(): void {
    if (this.mode.kind !== 'failed' || !this.settings) return;
    this.clearRetry();
    void this.attemptStart(this.generation, this.settings);
  }

  // ---- the setup code: guards the first save ----

  private setupCodePath(): string {
    return join(this.opts.dataDir, 'setup-code');
  }

  /** The current setup code, creating one (and logging it) if there is none. */
  setupCode(): string {
    try {
      return readFileSync(this.setupCodePath(), 'utf8').trim();
    } catch {
      const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
      writeFileSync(this.setupCodePath(), `${code}\n`, { mode: 0o600 });
      console.log(`setup code: ${code.slice(0, 4)}-${code.slice(4)}`);
      return code;
    }
  }

  /** Check a typed setup code; false (and counted) when wrong or when too many were wrong this minute. */
  checkSetupCode(given: string): boolean {
    const now = Date.now();
    this.codeFailures = this.codeFailures.filter((t) => now - t < 60_000);
    if (this.codeFailures.length >= SETUP_CODE_TRIES_PER_MINUTE) return false;
    const ok = given.replace(/\D/g, '') === this.setupCode();
    if (!ok) this.codeFailures.push(now);
    return ok;
  }

  // ---- applying settings ----

  private async apply(): Promise<void> {
    const gen = ++this.generation;
    this.clearRetry();
    const prev = this.mode;
    if (prev.kind === 'running') {
      prev.ev.audit.record({ type: 'shutdown', reason: 'settings changed' });
      await prev.ev.stop();
    }
    const loaded = loadConfig(configPath(this.opts.dataDir));
    if (gen !== this.generation) return;
    if (loaded.kind !== 'ok') {
      this.settings = null;
      this.mode = { kind: 'setup', problems: loaded.kind === 'invalid' ? loaded.problems : [] };
      this.setupCode();
      console.log(
        loaded.kind === 'missing'
          ? 'not set up yet: open the setup page'
          : `settings invalid, setup page only: ${loaded.problems.join('; ')}`,
      );
      return;
    }
    if (loaded.ignored.length > 0) {
      console.log(`settings: ignoring unknown fields ${loaded.ignored.join(', ')}`);
    }
    this.settings = loaded.config;
    this.attempt = 0;
    await this.attemptStart(gen, loaded.config);
  }

  private async attemptStart(gen: number, config: Config): Promise<void> {
    this.mode = { kind: 'starting' };
    const synced = (this.opts.clockSynced ?? systemClockSynced)();
    if (!synced) {
      this.fail(
        gen,
        'waiting for the clock to be set from the internet (is the Pi online?)',
        CLOCK_RETRY_MS,
      );
      return;
    }
    const blocked = this.guard ? await this.guard.check() : null;
    if (gen !== this.generation) return;
    if (blocked) {
      this.fail(gen, blocked);
      return;
    }
    let ev: RunningEvent | null = null;
    try {
      const startgg = this.startgg(config.token);
      const resolved = await resolveEvent(startgg, config);
      if (gen !== this.generation) return;
      ev = await startEvent({
        startgg,
        eventId: resolved.eventId,
        setFormat: config.setFormat,
        secret: config.secret,
        stream:
          resolved.streamId === null
            ? null
            : { station: config.streamStation, streamId: resolved.streamId },
        dataDir: this.opts.dataDir,
        tcpPort: this.opts.tcpPort,
        host: this.opts.host,
        network: this.opts.network,
        archive: {
          dir: this.archiveDir(config),
          setName: config.archiveSetName,
          gameName: config.archiveGameName,
          event: resolved,
        },
        rawStore: this.opts.rawStore,
        stallMs: this.opts.stallMs,
      });
      if (gen !== this.generation) {
        await ev.stop();
        return;
      }
      const running = ev;
      const streamStation = resolved.streamId === null ? null : config.streamStation;
      const view: StatusView = {
        state: running.state,
        cache: running.cache,
        startgg,
        streamStation,
        eventLabel: `${resolved.tournamentName} · ${resolved.eventName} (${resolved.eventId})`,
        beacon: running.beacon ?? {
          status: () => ({
            targets: [],
            sent: 0,
            firstSentAt: null,
            lastSentAt: null,
            lastError: null,
            lastErrorCode: null,
          }),
        },
        tcp: running.tcp,
        telemetry: running.telemetry,
        archive: running.archive,
        beamers: running.beamers,
        collector: running.collector,
        store: running.store,
        otherRelay: () => this.guard?.heard() ?? null,
        admin: running.admin,
        addresses: this.addresses(),
        version: this.version,
        platform: this.opts.platform ?? null,
      };
      this.mode = { kind: 'running', ev: running, resolved, view };
      this.attempt = 0;
      running.audit.record({ type: 'startup', ...resolved, sets: running.cache.status().count });
      console.log(
        `resolved "${config.tournament}" by ${resolved.foundBy}: ${resolved.tournamentName} (${resolved.tournamentSlug}), ` +
          `event "${resolved.eventName}" ${resolved.eventId}, ` +
          (streamStation === null
            ? 'no stream'
            : `stream "${resolved.streamName}" ${resolved.streamId} on station ${streamStation}`),
      );
      console.log(
        `relay up: event ${resolved.eventId}, ${running.cache.status().count} sets cached, ` +
          `tcp :${running.tcp.address().port}, status http://localhost:${this.web.address().port}`,
      );
    } catch (e) {
      if (gen !== this.generation) return;
      this.fail(gen, e instanceof Error ? e.message : String(e));
    }
  }

  private fail(gen: number, reason: string, delayMs?: number): void {
    const delays = this.opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const wait = delayMs ?? delays[Math.min(this.attempt, delays.length - 1)]!;
    this.attempt++;
    const now = Date.now();
    this.mode = { kind: 'failed', reason, at: now, nextAt: now + wait };
    console.log(`not running: ${reason} (trying again in ${Math.round(wait / 1000)} s)`);
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (gen === this.generation && this.settings) void this.attemptStart(gen, this.settings);
    }, wait);
    this.retryTimer.unref();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  // ---- routes ----

  private async route(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    url: URL,
  ): Promise<void> {
    if (url.pathname === '/setup') return serveSetup(this, req, res, url);
    if (url.pathname === '/retry' && req.method === 'POST') {
      this.retryNow();
      redirect(res, '/');
      return;
    }
    // The desktop app's one action (platform.ts): the firewall fix, behind the admin password.
    if (url.pathname === '/platform' && req.method === 'POST' && this.opts.platform) {
      if (!this.settings) return redirect(res, '/setup');
      if (!requirePassword(req, res, this.settings.adminPassword)) return;
      const r = await this.opts.platform.act(url.searchParams.get('action') ?? '');
      redirectWithResult(res, r.ok, r.msg);
      return;
    }
    // SD cards need only the settings, so they work before tonight's event resolves.
    if (url.pathname === '/cards' || url.pathname === '/cards/zip') {
      if (!this.settings) return redirect(res, '/setup');
      return serveCards(
        { wiiDir: this.opts.wiiDir ?? null, config: this.settings, version: this.version },
        req,
        res,
        url,
      );
    }
    const m = this.mode;
    if (m.kind === 'running') {
      if (req.method === 'GET' && url.pathname === '/') {
        sendHtml(
          res,
          renderStatus(m.view, url.searchParams.get('done'), url.searchParams.get('error')),
        );
        return;
      }
      if (req.method === 'GET' && url.pathname === '/log') return serveLog(m.view, res, url);
      if (['/ack', '/free', '/bestof'].includes(url.pathname)) {
        return serveAction(m.view, this.settings!.adminPassword, req, res, url);
      }
    } else if (req.method === 'GET' && url.pathname === '/') {
      if (m.kind === 'setup') redirect(res, '/setup');
      else sendHtml(res, this.renderNotRunning(m, url.searchParams.get('done')));
      return;
    }
    sendText(res, 404, 'not found\n');
  }

  private renderNotRunning(
    m: Extract<Mode, { kind: 'starting' } | { kind: 'failed' }>,
    done: string | null,
  ): string {
    const banner = done ? `<p class="ok">✓ ${escapeHtml(done)}</p>` : '';
    const where = `<p class="muted small">LazyTO ${escapeHtml(this.version)} · this relay: ${
      this.addresses()
        .map((a) => `http://${escapeHtml(a)}:29473`)
        .join(', ') || '—'
    }</p>`;
    if (m.kind === 'starting') {
      return page(`${banner}<p>Finding tonight's event on start.gg…</p>${where}`, {
        refreshSeconds: 3,
      });
    }
    const next = m.nextAt ? Math.max(0, Math.round((m.nextAt - Date.now()) / 1000)) : null;
    return page(
      `${banner}<div class="card bad"><p><b class="warn">Not running.</b> ${escapeHtml(m.reason)}</p>` +
        `<p class="muted">Tried ${age(m.at)} ago${next !== null ? `; trying again in ${next} s` : ''}. ` +
        `The beamers hear no relay until this is fixed.</p>` +
        `<div class="acts"><form method="post" action="/retry"><button class="primary">Retry now</button></form>` +
        `<a class="btnlink" href="/setup">Settings</a></div></div>${where}`,
      { refreshSeconds: 10 },
    );
  }
}
