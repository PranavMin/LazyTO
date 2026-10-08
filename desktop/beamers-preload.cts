// beamers-preload.cts -- the Beamers window's bridge (beamers.ts): the
// sandboxed page gets exactly three calls into the main process, and nothing
// else of Node or Electron. CommonJS, as sandboxed preloads must be.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('lazyto', {
  /** The firmware this build carries, checked against its SHA-256, or why there is none. */
  firmware: () => ipcRenderer.invoke('beamers:firmware'),
  /** Whether LazyTO is set up, so it has a secret to give the beamers. */
  secretSet: () => ipcRenderer.invoke('beamers:secret-set'),
  /** Ask for the beamer's drive and write its config.txt. */
  provision: (ssid: string, password: string) =>
    ipcRenderer.invoke('beamers:provision', ssid, password),
});
