// main.ts -- the LazyTO desktop app (docs/laptop-setup.md): a thin Electron
// shell around the relay core, which runs right here in the main process
// through the same seam as src/main.ts (new App). The main process is where
// Replay Reporter and Beamer Manager do their networking too, and on macOS
// the only process whose identity the build's UUID trick changes
// (scripts/mach-o-uuid.cjs), so Local Network permission follows the app.
//
// The shell adds what a Pi got from systemd and a browser: one copy only,
// a window on the status page that answers its password prompt, the setup
// page with the setup code filled in, a question before closing mid-event,
// the display kept awake while an event runs, a relaunch after a crash with
// the unit's backoff (crash.ts), the update check, the firewall and Local
// Network help (platform.ts), and the menu with the Beamers window (menu.ts).

import { BrowserWindow, app, dialog, powerSaveBlocker, shell } from 'electron';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { App } from '../src/app.js';
import { HTTP_PORT, TCP_PORT } from '../src/config.js';
import { nextRestart, parseCrashRecord } from './crash.js';
import { setMenu } from './menu.js';
import { DesktopPlatform, askLocalNetworkOnce, localNetworkStateFile } from './platform.js';

const ORIGIN = `http://127.0.0.1:${HTTP_PORT}`;
const RESTART_ARG = '--restart-in=';
const LOG_MAX_BYTES = 10_000_000;

let core: App | null = null;
let win: BrowserWindow | null = null;
let quitting = false;

/** Everything the core prints also goes to <logs>/lazyto.log (the Pi had journald). */
function logToFile(): void {
  const dir = app.getPath('logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'lazyto.log');
  try {
    if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, join(dir, 'lazyto.old.log'));
  } catch {
    // no log yet
  }
  for (const level of ['log', 'error'] as const) {
    const print = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      print(...args);
      appendFileSync(file, `${new Date().toISOString()} ${format(...args)}\n`);
    };
  }
}

/** Relaunch after a crash, waiting as the systemd unit did; claims come back from the audit log. */
function crashed(e: unknown): void {
  const file = join(app.getPath('userData'), 'crash.json');
  let prev = null;
  try {
    console.error(`crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    prev = parseCrashRecord(readFileSync(file, 'utf8'));
  } catch {
    // first crash, or the log is unwritable: relaunch all the same
  }
  const { record, delayMs } = nextRestart(prev, Date.now());
  try {
    writeFileSync(file, JSON.stringify(record));
  } catch {
    // the next crash then waits 10 s again
  }
  const args = process.argv.slice(1).filter((a) => !a.startsWith(RESTART_ARG));
  app.relaunch({ args: [...args, `${RESTART_ARG}${delayMs}`] });
  app.exit(1);
}

/** firmware/ and wii/: beside app.asar when packaged, desktop/resources/ in development. */
function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
}

function openOutside(url: string): void {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

function createWindow(c: App): BrowserWindow {
  const w = new BrowserWindow({
    width: 1000,
    height: 820,
    title: 'LazyTO',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(`${ORIGIN}/`)) return;
    e.preventDefault();
    openOutside(url);
  });
  w.webContents.on('render-process-gone', () => w.reload());
  w.on('close', (e) => {
    if (quitting || c.current().kind !== 'running') return;
    const choice = dialog.showMessageBoxSync(w, {
      type: 'warning',
      message: 'Quit LazyTO during the event?',
      detail: 'The stations stop reporting to start.gg until LazyTO is open again.',
      buttons: ['Keep LazyTO open', 'Quit'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 0) e.preventDefault();
    else quitting = true;
  });
  return w;
}

async function main(): Promise<void> {
  await app.whenReady();
  // Run from the dmg (or translocated from Downloads), every launch looks new
  // to macOS: move it to Applications once, which relaunches it.
  if (process.platform === 'darwin' && /^\/Volumes\/|\/AppTranslocation\//.test(process.execPath)) {
    try {
      if (app.moveToApplicationsFolder()) return;
    } catch (e) {
      console.error(`could not move LazyTO to Applications: ${String(e)}`);
    }
  }
  logToFile();
  const userData = app.getPath('userData');
  const version = app.isPackaged ? app.getVersion() : 'dev';
  const platform = new DesktopPlatform({ version, exe: process.execPath, os: process.platform });
  const c = new App({
    dataDir: userData,
    wiiDir: join(resourcesDir(), 'wii'),
    archiveDir: join(app.getPath('documents'), 'LazyTO'),
    httpPort: HTTP_PORT,
    tcpPort: TCP_PORT,
    version,
    platform,
  });
  core = c;

  const restartIn = Number(
    process.argv.find((a) => a.startsWith(RESTART_ARG))?.slice(RESTART_ARG.length) ?? 0,
  );
  if (restartIn > 0) {
    win = createWindow(c);
    const note = `<p style="font:16px system-ui;margin:2em">LazyTO stopped after an error. It starts again in ${Math.round(restartIn / 1000)} s; the stations' sets carry on.</p>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(note)}`);
    await new Promise((resolve) => setTimeout(resolve, restartIn));
  }

  try {
    (await c.serve()).applied.catch(crashed);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    dialog.showErrorBox(
      'LazyTO is already running',
      `Another LazyTO, or a Pi relay, is running on this computer (port ${HTTP_PORT} is in use). Close it, then open LazyTO again.`,
    );
    app.exit(1);
    return;
  }
  console.log(`LazyTO ${version}: data in ${userData}`);
  platform.start();
  if (process.platform === 'darwin') askLocalNetworkOnce(version, localNetworkStateFile(userData));

  if (!win || win.isDestroyed()) win = createWindow(c);
  setMenu(c, win, ORIGIN, resourcesDir());
  const mode = c.current().kind;
  void win.loadURL(mode === 'setup' ? `${ORIGIN}/setup?code=${c.setupCode()}` : `${ORIGIN}/`);

  // The status page's actions and the settings use Basic auth: answer it for
  // this relay only, with the saved password; twice refused, let the page say why.
  const tries = new Map<string, number[]>();
  app.on('login', (event, _wc, details, authInfo, callback) => {
    const password = c.config()?.adminPassword;
    if (
      authInfo.isProxy ||
      authInfo.host !== '127.0.0.1' ||
      authInfo.port !== HTTP_PORT ||
      !password
    )
      return;
    const now = Date.now();
    const recent = (tries.get(details.url) ?? []).filter((t) => now - t < 10_000);
    if (recent.length >= 2) return;
    tries.set(details.url, [...recent, now]);
    event.preventDefault();
    callback('LazyTO', password);
  });

  // Keep the display, and with it the laptop, awake while an event runs.
  let blocker: number | null = null;
  const keepAwake = () => {
    const running = c.current().kind === 'running';
    if (running && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!running && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  };
  keepAwake();
  setInterval(keepAwake, 5_000).unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  process.on('uncaughtException', crashed);
  process.on('unhandledRejection', crashed);
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  let stopped = false;
  app.on('will-quit', (e) => {
    if (stopped || !core) return;
    e.preventDefault();
    quitting = true;
    void core.stop().finally(() => {
      stopped = true;
      app.quit();
    });
  });
  main().catch(crashed);
}
