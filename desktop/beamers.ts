// beamers.ts -- the Beamers window (beamers/index.html, beamers/page.ts):
// flash a beamer with the firmware this build carries, and write a beamer's
// CONFIG/config.txt (Wi-Fi, LAZYTO = true, the relay's secret). Main-process
// side: the window, its serial-port picker, and the two things the sandboxed
// page asks for through beamers-preload.cts.
//
// Flashing is Web Serial in the page (esptool-js). Electron has no port
// picker of its own: select-serial-port takes the one Espressif port (USB
// vendor 0x303a, a beamer plugged in with its button held), asks which one
// when there are several, and refuses when there is none, so the page can
// say how to put the beamer in download mode.
//
// The firmware and the drive's config.txt are read and written by
// beamer-files.ts.

import { BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import { wifiProblem } from './beamer-config.js';
import { loadFirmware, provisionDrive } from './beamer-files.js';

/** Espressif's USB vendor id. Electron reports it as a decimal string ("12346"); hex accepted too. */
const ESPRESSIF_VID = 0x303a;

function isEspressif(vendorId: string | undefined): boolean {
  if (!vendorId) return false;
  return Number(vendorId) === ESPRESSIF_VID || vendorId.toLowerCase() === '303a';
}

let window: BrowserWindow | null = null;

export interface BeamersDeps {
  parent: BrowserWindow;
  /** Where the packaged resources are (firmware/ and wii/). */
  resources: string;
  /** The page's own file (beamers/index.html in the app). */
  page: string;
  preload: string;
  /** The relay's Wii secret; null until LazyTO is set up. */
  secret: () => string | null;
}

/** Open the Beamers window, or bring it forward. */
export function openBeamersWindow(d: BeamersDeps): void {
  if (window) {
    window.focus();
    return;
  }
  const ses = session.fromPartition('beamers');
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'serial');
  ses.setDevicePermissionHandler((details) => details.deviceType === 'serial');
  ses.removeAllListeners('select-serial-port');
  ses.on('select-serial-port', (event, ports, _wc, callback) => {
    event.preventDefault();
    const esp = ports.filter((p) => isEspressif(p.vendorId));
    if (esp.length <= 1 || !window) return callback(esp[0]?.portId ?? '');
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question',
      message: 'More than one beamer is plugged in. Which one?',
      buttons: [...esp.map((p) => p.displayName || p.portName), 'Cancel'],
      cancelId: esp.length,
    });
    callback(choice < esp.length ? esp[choice]!.portId : '');
  });

  const win = new BrowserWindow({
    parent: d.parent,
    width: 720,
    height: 760,
    title: 'LazyTO: beamers',
    webPreferences: {
      session: ses,
      preload: d.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window = win;
  win.on('closed', () => {
    window = null;
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const fromPage = (e: IpcMainInvokeEvent) => e.sender === win.webContents;
  ipcMain.removeHandler('beamers:firmware');
  ipcMain.handle('beamers:firmware', (e) => (fromPage(e) ? loadFirmware(d.resources) : null));
  ipcMain.removeHandler('beamers:secret-set');
  ipcMain.handle('beamers:secret-set', (e) => fromPage(e) && d.secret() !== null);
  ipcMain.removeHandler('beamers:provision');
  ipcMain.handle('beamers:provision', async (e, ssid: unknown, password: unknown) => {
    if (!fromPage(e) || typeof ssid !== 'string' || typeof password !== 'string') return null;
    const secret = d.secret();
    if (secret === null)
      return { ok: false, msg: 'Set LazyTO up first: the beamer needs its secret.' };
    const problem = wifiProblem(ssid, password);
    if (problem) return { ok: false, msg: problem };
    const pick = await dialog.showOpenDialog(win, {
      title: "Pick the beamer's drive",
      buttonLabel: 'Write config.txt',
      properties: ['openDirectory'],
    });
    if (pick.canceled || pick.filePaths.length === 0) return { ok: false, msg: 'Nothing written.' };
    try {
      return provisionDrive(pick.filePaths[0]!, ssid, password, secret);
    } catch (err) {
      return {
        ok: false,
        msg: `Could not write the beamer's config.txt: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
  void win.loadFile(d.page);
}
