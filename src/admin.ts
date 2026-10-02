// admin.ts -- the TO's actions on the status page (status.ts), behind
// adminPassword. Two, for the problems a TO meets mid-bracket without a
// laptop:
//
//   Free a station. A Wii that died mid-set keeps its claim, and the set
//   stays in progress on start.gg, where no other Wii may take it
//   (tcp.ts startSet). Freeing resets the set on start.gg -- the call a
//   Wii's own abandon makes -- and drops the claim, so the set is back on
//   every Wii's list at 0-0. Reported games are discarded: the wire never
//   sends a Wii earlier games, so a half-played set cannot move to another
//   Wii with its score. The page asks first and names the score it drops.
//   A set that has already left the cache (completed or reset on start.gg)
//   only loses its claim.
//
//   Set a set's best-of. 3 or 5, or back to setFormat's answer. Only for a
//   set no station holds: a Wii learns best-of when it lists and starts a
//   set, so changing it under a running set would split the Wii and the
//   relay. Recorded in the audit log and replayed at startup (replayBestOf).

import type { SetCache } from './cache.js';
import type { StationState } from './state.js';
import type { StartggClient } from './startgg.js';
import type { AuditSink } from './tcp.js';

export interface AdminDeps {
  state: StationState;
  cache: SetCache;
  startgg: Pick<StartggClient, 'resetSet'>;
  audit: AuditSink;
}

export interface AdminResult {
  ok: boolean;
  msg: string;
}

export const BEST_OF_CHOICES = [3, 5] as const;

export class Admin {
  constructor(private readonly deps: AdminDeps) {}

  /** setId must be the set the page showed, so a stale page never frees a newer set. */
  async freeStation(station: number, setId: number): Promise<AdminResult> {
    const { state, cache, startgg, audit } = this.deps;
    const claim = state.get(station);
    if (!claim) return { ok: false, msg: `station ${station} has no set` };
    if (claim.setId !== setId) {
      return { ok: false, msg: `station ${station} is on a different set now; reload the page` };
    }

    const live = cache.get(setId) !== undefined;
    if (live) {
      try {
        await startgg.resetSet(setId);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        audit.record({
          type: 'upstream',
          op: 'resetSet',
          setId,
          ok: false,
          error,
          by: 'dashboard',
        });
        return { ok: false, msg: `start.gg reset failed, station not freed: ${error}` };
      }
      audit.record({ type: 'upstream', op: 'resetSet', setId, ok: true, by: 'dashboard' });
      cache.markReset(setId);
    }

    state.release(station);
    audit.record({
      type: 'release',
      station,
      setId,
      reason: 'dashboard',
      gamesDiscarded: live ? claim.games.length : 0,
    });
    state.recordAction(station, 'DASHBOARD_FREE', true, 'ST_OK', 'freed by TO');
    return {
      ok: true,
      msg: live
        ? `station ${station} freed; set reset on start.gg and back on every Wii's list`
        : `station ${station} freed (the set had already left start.gg's pending list)`,
    };
  }

  /** bestOf 3 or 5, or null for setFormat's answer. */
  setBestOf(setId: number, bestOf: number | null): AdminResult {
    const { state, cache, audit } = this.deps;
    if (bestOf !== null && !(BEST_OF_CHOICES as readonly number[]).includes(bestOf)) {
      return { ok: false, msg: `best-of must be ${BEST_OF_CHOICES.join(' or ')}` };
    }
    const set = cache.get(setId);
    if (!set) return { ok: false, msg: `set ${setId} is not pending on start.gg` };
    const holder = state.stationFor(setId);
    if (holder !== undefined) {
      return {
        ok: false,
        msg: `station ${holder} is playing this set; its best-of is fixed until it ends or is freed`,
      };
    }
    cache.setBestOfOverride(setId, bestOf);
    audit.record({ type: 'bestof', setId, bestOf, by: 'dashboard' });
    return {
      ok: true,
      msg: `${set.p1.tag} vs ${set.p2.tag}: ${bestOf === null ? `back to the format (Bo${set.bestOf})` : `Bo${bestOf}`}`,
    };
  }
}
