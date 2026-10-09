// menu.ts -- the app menu (desktop/main.ts): the relay's pages in the
// window, the Beamers window, and the two folders a TO looks in (the set
// archives, the log).

import { BrowserWindow, Menu, app, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../src/app.js';
import { openBeamersWindow } from './beamers.js';

export function setMenu(c: App, w: BrowserWindow, origin: string, resources: string): void {
  const go = (path: string) => () => void w.loadURL(`${origin}${path}`);
  const openDir = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  };
  const beamers = () =>
    openBeamersWindow({
      parent: w,
      resources,
      page: join(app.getAppPath(), 'beamers', 'index.html'),
      preload: join(import.meta.dirname, 'beamers-preload.cjs'),
      secret: () => c.config()?.secret ?? null,
    });
  const archive = () => {
    const cfg = c.config();
    openDir(cfg ? c.archiveDir(cfg) : c.defaultArchiveDir());
  };
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'Status page', accelerator: 'CmdOrCtrl+1', click: go('/') },
          { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: go('/setup') },
          { label: 'SD cards', click: go('/cards') },
          { label: 'Beamers: flash, Wi-Fi…', accelerator: 'CmdOrCtrl+B', click: beamers },
          { type: 'separator' },
          { label: 'Open the archive folder', click: archive },
          { label: 'Open the log folder', click: () => openDir(app.getPath('logs')) },
          ...(mac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}
