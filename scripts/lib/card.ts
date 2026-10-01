// Finding and ejecting the Wii's SD card on each OS. The rule is the same
// everywhere: exactly one removable FAT32 volume, or the user names one with
// --drive (a Windows letter like F, or a mount path such as /Volumes/NO NAME
// or /media/me/WII). The parsers are pure so they are tested from canned
// command output; only `findCard` and `ejectCard` touch the system.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fail, type Runner } from './cli.js';

export interface Volume {
  root: string; // mount point, e.g. "F:\\" or "/Volumes/NO NAME"
  label: string;
  device?: string; // what eject needs on Linux/macOS
}

// --- Windows: Get-Volume as JSON (a single object when there is one volume) ---
export const WINDOWS_VOLUMES_PS =
  "Get-Volume | Where-Object { $_.DriveType -eq 'Removable' -and $_.FileSystem -eq 'FAT32' -and $_.DriveLetter } | Select-Object DriveLetter,FileSystemLabel | ConvertTo-Json -Compress";

export function parseWindowsVolumes(json: string): Volume[] {
  const t = json.trim();
  if (!t) return [];
  const v = JSON.parse(t) as { DriveLetter: string; FileSystemLabel: string } | Array<{ DriveLetter: string; FileSystemLabel: string }>;
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => ({ root: `${x.DriveLetter}:\\`, label: x.FileSystemLabel ?? '' }));
}

// --- Linux: lsblk -J ---
export const LSBLK_ARGS = ['-J', '-o', 'NAME,PATH,FSTYPE,MOUNTPOINT,RM,HOTPLUG,LABEL'];

interface LsblkNode {
  name: string;
  path?: string;
  fstype?: string | null;
  mountpoint?: string | null;
  rm?: boolean | string;
  hotplug?: boolean | string;
  label?: string | null;
  children?: LsblkNode[];
}

export function parseLsblk(json: string): Volume[] {
  const out: Volume[] = [];
  const truthy = (v: unknown): boolean => v === true || v === '1' || v === 1;
  const walk = (n: LsblkNode, parentRemovable: boolean): void => {
    const removable = parentRemovable || truthy(n.rm) || truthy(n.hotplug);
    if (removable && n.mountpoint && n.fstype && n.fstype.toLowerCase() === 'vfat') {
      out.push({ root: n.mountpoint, label: n.label ?? '', device: n.path ?? `/dev/${n.name}` });
    }
    for (const c of n.children ?? []) walk(c, removable);
  };
  const root = JSON.parse(json) as { blockdevices: LsblkNode[] };
  for (const d of root.blockdevices ?? []) walk(d, false);
  return out;
}

// --- macOS: `diskutil info <mount>` per /Volumes entry ---
export function parseDiskutilInfo(text: string): { fat32: boolean; removable: boolean; device?: string; label: string } {
  const kv: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^:]+?):\s+(.*)$/.exec(line);
    if (m) kv[m[1].trim()] = m[2].trim();
  }
  const fs = (kv['File System Personality'] ?? kv['Type (Bundle)'] ?? '').toLowerCase();
  const fat32 = fs.includes('fat32') || fs === 'msdos';
  const removable = /removable|yes/i.test(kv['Removable Media'] ?? '') || /yes/i.test(kv['Ejectable'] ?? '');
  const device = kv['Device Node'];
  return { fat32, removable, device, label: kv['Volume Name'] ?? '' };
}

function listVolumes(run: Runner): Volume[] {
  if (process.platform === 'win32') {
    const r = run('powershell', ['-NoProfile', '-Command', WINDOWS_VOLUMES_PS]);
    if (r.status !== 0) fail(`Get-Volume failed: ${r.stderr.trim()}`);
    return parseWindowsVolumes(r.stdout);
  }
  if (process.platform === 'darwin') {
    const ls = run('ls', ['-1', '/Volumes']);
    if (ls.status !== 0) return [];
    const out: Volume[] = [];
    for (const name of ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const mount = `/Volumes/${name}`;
      const info = run('diskutil', ['info', mount]);
      if (info.status !== 0) continue;
      const p = parseDiskutilInfo(info.stdout);
      if (p.fat32 && p.removable) out.push({ root: mount, label: p.label, device: p.device });
    }
    return out;
  }
  const r = run('lsblk', LSBLK_ARGS);
  if (r.status !== 0) fail(`lsblk failed: ${r.stderr.trim()}`);
  return parseLsblk(r.stdout);
}

/** The card's root with a trailing separator, from --drive or by scanning. */
export function findCard(drive: string, run: Runner): Volume {
  if (drive) {
    let root: string;
    if (/^[A-Za-z]:?[\\/]?$/.test(drive)) root = `${drive[0].toUpperCase()}:\\`;
    else root = resolve(drive);
    if (!existsSync(root)) fail(`drive ${drive} is not ready`);
    return { root, label: '' };
  }
  const vols = listVolumes(run);
  if (vols.length === 0) fail('no removable FAT32 card found. Is the card in the reader (and the reader plugged in)?');
  if (vols.length > 1) fail(`more than one removable FAT32 drive (${vols.map((v) => v.root).join(', ')}); pass --drive X`);
  return vols[0];
}

/** Best effort; returns true when the OS reports the volume gone. */
export function ejectCard(vol: Volume, run: Runner): boolean {
  if (process.platform === 'win32') {
    const letter = vol.root.slice(0, 2);
    run('powershell', ['-NoProfile', '-Command', `$s = New-Object -ComObject Shell.Application; $i = $s.Namespace(17).ParseName('${letter}'); if ($i) { $i.InvokeVerb('Eject'); Start-Sleep -Seconds 2 }`]);
    return !existsSync(vol.root);
  }
  if (process.platform === 'darwin') {
    const r = run('diskutil', ['eject', vol.device ?? vol.root]);
    return r.status === 0;
  }
  if (vol.device) {
    const u = run('udisksctl', ['unmount', '-b', vol.device]);
    if (u.status === 0) run('udisksctl', ['power-off', '-b', vol.device.replace(/p?\d+$/, '')]);
    return u.status === 0;
  }
  return run('umount', [vol.root]).status === 0;
}
