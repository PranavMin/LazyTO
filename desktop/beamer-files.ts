// beamer-files.ts -- the files behind the Beamers window (beamers.ts): the
// firmware this build carries, resources/firmware/beamer.bin, checked against
// beamer.bin.sha256 (release.yml pins both) before the page gets a byte; and
// a beamer drive's CONFIG/config.txt, which gets LazyTO's keys
// (beamer-config.ts) and keeps everything else.

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { lazytoValues, setConfigValues } from './beamer-config.js';

export type Firmware =
  { ok: true; bytes: Uint8Array; sha256: string; version: string } | { ok: false; reason: string };

/** The firmware this build carries, verified; or why there is none. */
export function loadFirmware(resources: string): Firmware {
  const dir = join(resources, 'firmware');
  if (!existsSync(join(dir, 'beamer.bin'))) {
    return { ok: false, reason: 'This build of LazyTO carries no beamer firmware.' };
  }
  let bytes: Buffer, want: string, version: string;
  try {
    bytes = readFileSync(join(dir, 'beamer.bin'));
    want = readFileSync(join(dir, 'beamer.bin.sha256'), 'utf8').trim().split(/\s+/)[0]!;
    version = readFileSync(join(dir, 'VERSION'), 'utf8').trim();
  } catch (e) {
    return {
      ok: false,
      reason: `The beamer firmware is incomplete (${String(e)}): reinstall LazyTO.`,
    };
  }
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== want.toLowerCase()) {
    return {
      ok: false,
      reason: `beamer.bin does not match its SHA-256 (${want.slice(0, 12)}…): reinstall LazyTO.`,
    };
  }
  return { ok: true, bytes: new Uint8Array(bytes), sha256: got, version };
}

/** Write a beamer's config.txt with LazyTO's keys; `root` is the drive the TO picked. */
export function provisionDrive(
  root: string,
  ssid: string,
  password: string,
  secret: string,
): { ok: boolean; msg: string } {
  const file = join(root, 'CONFIG', 'config.txt');
  if (!existsSync(file)) {
    return {
      ok: false,
      msg: `${root} is not a beamer's drive: it has no CONFIG/config.txt. Plug the beamer in without holding its button, wait for its drive, and pick the drive itself.`,
    };
  }
  const text = setConfigValues(readFileSync(file, 'utf8'), lazytoValues(ssid, password, secret));
  // A new file renamed over the old one: an unplug mid-write leaves the old file, never half of one.
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  return {
    ok: true,
    msg: `Saved ${file}. Eject the drive, then plug the beamer into its Wii.`,
  };
}
