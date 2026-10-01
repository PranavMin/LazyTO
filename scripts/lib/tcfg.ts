// tournament.cfg on the card: station=N, stream=0|1, secret=... (docs/wii-setup.md).
import { fail } from './cli.js';

/** 8-16 of A-Z a-z 0-9 - _ (decisions.md R16; the kernel parses the same). */
export const SECRET_RE = /^[A-Za-z0-9_-]{8,16}$/;

export function parseTournamentCfg(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\w+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function formatTournamentCfg(c: { station: number; stream: number; secret: string }): string {
  return `station=${c.station}\nstream=${c.stream}\nsecret=${c.secret}\n`;
}

/**
 * Station and stream for the new file: the flags when given, else what the
 * card already has; a card with no station anywhere is an error (the first
 * sync of a card must say which station it is).
 */
export function resolveStationStream(old: Record<string, string>, station: number, stream: number): { station: number; stream: number } {
  let s = station;
  if (s < 0) {
    if (old.station === undefined) fail('this card has no tournament.cfg yet: pass --station N (and --stream 1 for the stream setup)');
    s = Number.parseInt(old.station, 10);
  }
  let st = stream;
  if (st < 0) st = old.stream === undefined ? 0 : Number.parseInt(old.stream, 10);
  return { station: s, stream: st };
}

/** True when the card's file says exactly this station/stream/secret (the post-write check). */
export function tournamentCfgMatches(text: string, c: { station: number; stream: number; secret: string }): boolean {
  return (
    new RegExp(`^station=${c.station}$`, 'm').test(text) &&
    new RegExp(`^stream=${c.stream}$`, 'm').test(text) &&
    text.includes(`secret=${c.secret}`)
  );
}
