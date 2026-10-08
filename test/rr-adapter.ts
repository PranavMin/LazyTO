// rr-adapter.ts -- Replay Reporter's conformance bundle (test/rr-conformance/,
// see its BUNDLE.md) for rr-conformance.test.ts: its files, and RR's parse
// of each replay.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUNDLE = join(import.meta.dirname, 'rr-conformance');

export function bundleJson<T = any>(...path: string[]): T {
  return JSON.parse(readFileSync(join(BUNDLE, ...path), 'utf8')) as T;
}

export function bundleFile(...path: string[]): Buffer {
  return readFileSync(join(BUNDLE, ...path));
}

/** RR's parse of a replay (parse.json). */
export interface RrReplay {
  fileName: string;
  sha256: string;
  startAt: string;
  lastFrame: number;
  stageId: number;
  isTeams: boolean;
  players: {
    port: number;
    playerType: number;
    externalCharacterId: number | null;
    costumeIndex: number | null;
    teamId: number;
    isWinner: boolean;
    nametag: string;
    displayName: string;
  }[];
}

/** A replay's file name stamp as its replay_id: the gameStartTime, UTC (archive.ts replayStamp). */
export function replayId(fileName: string): number {
  const m = /_(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)\.slp$/.exec(fileName);
  if (!m) throw new Error(`no stamp in ${fileName}`);
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) / 1000;
}
