// platform.ts -- the desktop app's Platform (src/platform.ts): what the
// status page says about the laptop, and its one action.
//
//   updates    GitHub's releases/latest for PranavMin/LazyTO at start and
//              every 6 h, as Replay Reporter and Beamer Manager check; offline
//              or rate-limited means nothing is shown. The app never updates
//              or quits by itself.
//   Windows    the firewall probe every 30 s (firewall.ts) and its fix, one
//              elevated PowerShell behind one UAC prompt.
//   macOS      the Local Network alert, triggered on the first launch of each
//              version so it comes up at home, not at the venue (TN3179:
//              connecting a UDP socket to a broadcast address asks).

import { execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEACON_PORT } from '../generated/wire.js';
import { directedBroadcasts } from '../src/beacon.js';
import { newerRelease, type Platform, type PlatformNote, type Release } from '../src/platform.js';
import {
  FIREWALL_ACTION,
  PROBE_SCRIPT,
  elevate,
  firewallNotes,
  fixScript,
  type FirewallProbe,
} from './firewall.js';

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/PranavMin/LazyTO/releases/latest';
const UPDATE_EVERY_MS = 6 * 60 * 60_000;
const FIREWALL_EVERY_MS = 30_000;
const POWERSHELL_TIMEOUT_MS = 30_000;
const FIX_TIMEOUT_MS = 5 * 60_000;

/** Run a PowerShell script; resolves with its stdout, rejects with its error output. */
function powershell(
  script: string,
  o: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: { ...process.env, ...o.env },
        timeout: o.timeoutMs ?? POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const why = stderr.trim() || (err.killed ? 'timed out' : `exit code ${String(err.code)}`);
        reject(new Error(why));
      },
    );
  });
}

export class DesktopPlatform implements Platform {
  private release: Release | null = null;
  private firewall: PlatformNote[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly o: {
      /** This build's version; a development build ("dev") never checks. */
      version: string;
      /** The app's executable: what Windows Firewall rules name. */
      exe: string;
      os: NodeJS.Platform;
    },
  ) {}

  start(): void {
    if (this.o.version !== 'dev') {
      void this.checkUpdate();
      this.timers.push(setInterval(() => void this.checkUpdate(), UPDATE_EVERY_MS));
    }
    if (this.o.os === 'win32') {
      void this.probeFirewall();
      this.timers.push(setInterval(() => void this.probeFirewall(), FIREWALL_EVERY_MS));
    }
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  notes(): PlatformNote[] {
    return this.firewall;
  }

  latest(): Release | null {
    return this.release;
  }

  async act(name: string): Promise<{ ok: boolean; msg: string }> {
    if (name !== FIREWALL_ACTION || this.o.os !== 'win32') {
      return { ok: false, msg: `nothing to do for "${name}"` };
    }
    try {
      // Waits while Windows asks for an administrator.
      await powershell(elevate(fixScript(this.o.exe)), { timeoutMs: FIX_TIMEOUT_MS });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        msg: /cancel/i.test(msg)
          ? 'The firewall was not changed: Windows asked for an administrator and got No.'
          : `The firewall was not changed: ${msg}`,
      };
    }
    await this.probeFirewall();
    return this.firewall.some((n) => n.action)
      ? { ok: false, msg: 'LazyTO is allowed now, but something else still blocks it: see above.' }
      : { ok: true, msg: 'LazyTO is allowed through the firewall on every network.' };
  }

  private async checkUpdate(): Promise<void> {
    try {
      const res = await fetch(LATEST_RELEASE_URL, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `LazyTO/${this.o.version}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return; // rate-limited or no release yet: say nothing
      this.release = newerRelease(await res.json(), this.o.version);
    } catch {
      // offline: keep what we knew
    }
  }

  private async probeFirewall(): Promise<void> {
    try {
      const out = await powershell(PROBE_SCRIPT, { env: { LAZYTO_EXE: this.o.exe } });
      this.firewall = firewallNotes(JSON.parse(out) as FirewallProbe);
    } catch (e) {
      // Constrained PowerShell or a policy that hides the rules: the
      // "no beamer has reached this laptop" heuristic is all that is left.
      console.error(`firewall probe: ${e instanceof Error ? e.message : String(e)}`);
      this.firewall = [];
    }
  }
}

/**
 * macOS: ask for Local Network on the first launch of each version, by
 * connecting a UDP socket to every interface's directed broadcast (the
 * beacon's port). The alert comes up then, at home; the answer is macOS's.
 * `stateFile` remembers the version that last asked.
 */
export function askLocalNetworkOnce(version: string, stateFile: string): void {
  let asked = '';
  try {
    asked = readFileSync(stateFile, 'utf8').trim();
  } catch {
    // never asked
  }
  if (asked === version) return;
  writeFileSync(stateFile, `${version}\n`);
  for (const address of directedBroadcasts()) {
    const socket = createSocket('udp4');
    let open = true;
    const close = () => {
      if (open) socket.close();
      open = false;
    };
    socket.on('error', close); // denied, or no route: macOS has asked either way
    socket.bind(0, () => {
      socket.setBroadcast(true);
      socket.connect(BEACON_PORT, address, close);
    });
  }
}

/** Where askLocalNetworkOnce keeps the version that last asked. */
export function localNetworkStateFile(userData: string): string {
  return join(userData, 'local-network-asked');
}
