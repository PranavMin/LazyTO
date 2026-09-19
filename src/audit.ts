// audit.ts -- append-only JSONL audit log (design.md section 6.3): every
// request, response, and upstream call, one JSON object per line with a
// timestamp. Named <eventId>.jsonl so each tournament gets its own file
// (section 10). Writes are synchronous appends -- the request rate is a few
// per second at worst and a crash must not lose the tail.
//
// The log is also the relay's persistence (section 8, relay restart):
// replayClaims() folds claim / score / release events back into the
// station -> set map. main.ts drops any replayed claim whose set is no
// longer live in the cache.

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameResult } from '../generated/wire.js';
import type { AuditSink } from './tcp.js';
import type { Claim } from './state.js';

export function auditPath(auditDir: string, eventId: number): string {
  return join(auditDir, `${eventId}.jsonl`);
}

export class AuditLog implements AuditSink {
  private readonly fd: number;

  constructor(readonly path: string) {
    mkdirSync(join(path, '..'), { recursive: true });
    this.fd = openSync(path, 'a');
  }

  record(event: Record<string, unknown>): void {
    appendFileSync(this.fd, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  }

  close(): void {
    closeSync(this.fd);
  }
}

/**
 * Rebuild station claims from an audit log. A missing file means a fresh
 * tournament (empty map). A torn FINAL line (crash mid-write) is tolerated;
 * a corrupt line anywhere else is a damaged log and an error.
 */
export function replayClaims(path: string): Map<number, Claim> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw e;
  }

  const lines = text.split('\n').filter((l) => l.length > 0);
  const claims = new Map<number, Claim>();

  for (let i = 0; i < lines.length; i++) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      if (i === lines.length - 1) break; // torn final line: crash mid-write
      throw new Error(`${path}: corrupt audit line ${i + 1}`);
    }

    const station = event.station as number;
    switch (event.type) {
      case 'claim':
        claims.set(station, {
          setId: event.setId as number,
          p1Id: event.p1Id as number,
          p2Id: event.p2Id as number,
          bestOf: event.bestOf as number,
          games: (event.games as GameResult[]) ?? [],
        });
        break;
      case 'score': {
        const claim = claims.get(station);
        if (claim && claim.setId === event.setId) claim.games = event.games as GameResult[];
        break;
      }
      case 'release':
        claims.delete(station);
        break;
    }
  }
  return claims;
}
