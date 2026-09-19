// state.ts -- the relay's in-memory station state (design.md section 6.3):
// which station holds which set, plus the per-station last action and the
// sticky error flags the status page shows until the TO acks them.
// Rebuilt after a relay restart by replaying the audit log (audit.ts).

import type { GameResult } from '../generated/wire.js';

export interface Claim {
  setId: number;
  p1Id: number; // entrant ids captured at claim time, so a report still maps
  p2Id: number; // slots -> entrants even if the set has left the cache
  bestOf: number;
  games: GameResult[];
}

export interface Action {
  cmd: string;
  at: number;
  ok: boolean;
}

export interface Flag {
  id: number;
  station: number;
  message: string;
  at: number;
}

export class StationState {
  private claims = new Map<number, Claim>();
  private actions = new Map<number, Action>();
  private flagList: Flag[] = [];
  private nextFlagId = 1;

  claim(station: number, claim: Claim): void {
    this.claims.set(station, claim);
  }

  release(station: number): Claim | undefined {
    const c = this.claims.get(station);
    this.claims.delete(station);
    return c;
  }

  get(station: number): Claim | undefined {
    return this.claims.get(station);
  }

  stationFor(setId: number): number | undefined {
    for (const [station, c] of this.claims) if (c.setId === setId) return station;
    return undefined;
  }

  recordAction(station: number, cmd: string, ok: boolean): void {
    this.actions.set(station, { cmd, at: Date.now(), ok });
  }

  lastAction(station: number): Action | undefined {
    return this.actions.get(station);
  }

  /** Sticky error row for the status page; stays until the TO acks it. */
  flag(station: number, message: string): Flag {
    const f: Flag = { id: this.nextFlagId++, station, message, at: Date.now() };
    this.flagList.push(f);
    return f;
  }

  ack(id: number): boolean {
    const i = this.flagList.findIndex((f) => f.id === id);
    if (i < 0) return false;
    this.flagList.splice(i, 1);
    return true;
  }

  flags(): Flag[] {
    return [...this.flagList];
  }

  /** Every station we have heard from, for the status page rows. */
  stations(): number[] {
    return [...new Set([...this.claims.keys(), ...this.actions.keys()])].sort((a, b) => a - b);
  }
}
