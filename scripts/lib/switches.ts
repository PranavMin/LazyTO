// The kiosk's headless-Dolphin dev switches (docs/kiosk.md). A card must
// never ship a module built with one on, so sync-card reads the sources the
// module was built from and refuses while any is non-zero.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from './cli.js';
import { mtimeMs } from './fsx.js';

export const DEV_SWITCHES: ReadonlyArray<{ file: string; name: string }> = [
  { file: 'mn/mntourney.c', name: 'TM_DEMO_AUTOSTART' },
  { file: 'lb/lbtourney.c', name: 'LB_TOURNEY_DEMO_CLAIM' },
  { file: 'lb/lbtourney.c', name: 'LB_TOURNEY_TRIGGER_READOUT' },
];

/** Throws (ToolError) naming the first switch that is on or missing. */
export function checkDevSwitches(meleeSrc: string): void {
  for (const sw of DEV_SWITCHES) {
    const path = join(meleeSrc, sw.file);
    if (!existsSync(path)) fail(`could not find ${sw.file} under ${meleeSrc}`);
    const m = new RegExp(`^#define ${sw.name} (\\d+)`, 'm').exec(readFileSync(path, 'utf8'));
    if (!m) fail(`could not find #define ${sw.name} in ${sw.file}`);
    if (m[1] !== '0')
      fail(
        `${sw.name} is ${m[1]} in ${sw.file}: set it to 0 and rebuild the module before shipping a card`,
      );
  }
}

/** Kiosk sources (lb/*.c and mn/mntourney.c) edited after the module was built; names only. */
export function sourcesNewerThan(meleeSrc: string, moduleMtime: number): string[] {
  const files = readdirSync(join(meleeSrc, 'lb'))
    .filter((n) => n.endsWith('.c'))
    .map((n) => join(meleeSrc, 'lb', n));
  files.push(join(meleeSrc, 'mn', 'mntourney.c'));
  return files
    .filter((p) => existsSync(p) && mtimeMs(p) > moduleMtime)
    .map((p) => p.split(/[\\/]/).pop() as string);
}
