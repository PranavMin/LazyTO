// tournament.cfg on the card: station=N, stream=0|1, secret=... (docs/wii-setup.md).
// The format and the secret's pattern are the relay's (src/cards.ts, src/config.ts).
import { fail } from './cli.js';

export { formatTournamentCfg } from '../../src/cards.js';
export { SECRET_RE } from '../../src/config.js';

export function parseTournamentCfg(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\w+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Station and stream for the new file: the flags when given, else what the
 * card already has; a card with no station anywhere is an error (the first
 * sync of a card must say which station it is).
 */
export function resolveStationStream(
  old: Record<string, string>,
  station: number,
  stream: number,
): { station: number; stream: number } {
  let s = station;
  if (s < 0) {
    if (old.station === undefined)
      fail(
        'this card has no tournament.cfg yet: pass --station N (and --stream 1 for the stream setup)',
      );
    s = Number.parseInt(old.station, 10);
  }
  let st = stream;
  if (st < 0) st = old.stream === undefined ? 0 : Number.parseInt(old.stream, 10);
  return { station: s, stream: st };
}

/** True when the card's file says exactly this station/stream/secret (the post-write check). */
export function tournamentCfgMatches(
  text: string,
  c: { station: number; stream: number; secret: string },
): boolean {
  return (
    new RegExp(`^station=${c.station}$`, 'm').test(text) &&
    new RegExp(`^stream=${c.stream}$`, 'm').test(text) &&
    text.includes(`secret=${c.secret}`)
  );
}
