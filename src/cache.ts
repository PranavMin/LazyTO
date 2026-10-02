// cache.ts -- the pending-set cache (architecture.md Relay). One upstream
// query, refreshed every 20 s; everything the Wiis can see comes from here.
//
// Preview set ids (decisions.md R8, option a): a set in an unstarted pool has a
// string id like preview_3292311_1_1, which cannot be a uint32 on the wire.
// The cache DROPS those sets and records a warning for the status page; the
// per-tournament setup checklist says to start all pools before doors.

import { ROUND_LEN } from '../generated/wire.js';
import { bestOfFor, bracketShape, type SetFormat } from './format.js';
import type { StartggClient, UpstreamSet } from './startgg.js';

export interface CachedSet {
  id: number; // fits uint32
  state: number; // 1 pending, 2 in progress (upstream's view)
  round: number;
  roundShort: string; // "WR2", "LF", "GF" -- the status page
  roundName: string; // "WINNERS QUARTER-FINAL" -- the wire field the Wii shows (ROUND_LEN chars)
  bestOf: number; // what the Wiis are sent: the TO's override if any, else autoBestOf
  autoBestOf: number; // setFormat's answer (format.ts)
  bestOfOverridden: boolean; // the TO set it on the status page (admin.ts)
  p1: { id: number; tag: string };
  p2: { id: number; tag: string };
}

const WORD_ABBREV: Record<string, string> = {
  winners: 'W',
  losers: 'L',
  grand: 'G',
  round: 'R',
  final: 'F',
  finals: 'F',
  reset: 'R',
  'quarter-final': 'QF',
  'semi-final': 'SF',
};

/** "Winners Round 2" -> "WR2", "Losers Quarter-Final" -> "LQF", "Grand Final Reset" -> "GFR". */
export function abbreviateRound(fullRoundText: string): string {
  const parts: string[] = [];
  for (const word of fullRoundText.split(/\s+/)) {
    const mapped = WORD_ABBREV[word.toLowerCase()];
    if (mapped) parts.push(mapped);
    else if (/^\d+$/.test(word)) parts.push(word);
    else return fullRoundText.slice(0, 16); // unrecognized wording: ship it verbatim
  }
  return parts.join('');
}

/** "Winners Quarter-Final" -> "WINNERS QUARTER-FINAL": what the kiosk prints, cut to the wire field. */
export function wireRoundName(fullRoundText: string): string {
  return fullRoundText.toUpperCase().slice(0, ROUND_LEN);
}

const U32_MAX = 0xffff_ffff;

export class SetCache {
  private sets = new Map<number, CachedSet>();
  private warningList: string[] = [];
  private refreshedAt = 0;
  private refreshError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshing = false;
  /** TO overrides from the status page, set id -> best-of; outlive refreshes (admin.ts). */
  private bestOfOverrides = new Map<number, number>();

  constructor(
    private readonly client: StartggClient,
    private readonly eventId: number,
    private readonly setFormat: SetFormat,
    private readonly onRefreshError: (e: Error) => void = () => {},
  ) {}

  /** Fetch and rebuild. Throws on upstream failure; the old data is kept. */
  async refresh(): Promise<void> {
    let upstream: UpstreamSet[];
    try {
      upstream = await this.client.getEventSets(this.eventId);
    } catch (e) {
      this.refreshError = (e as Error).message;
      throw e;
    }

    const next = new Map<number, CachedSet>();
    const warnings: string[] = [];
    let previewCount = 0;

    const shape = bracketShape(
      upstream.map((s) => ({ round: s.round, phaseOrder: s.phaseGroup.phase.phaseOrder })),
    );

    for (const s of upstream) {
      if (typeof s.id === 'string') {
        previewCount++;
        continue;
      }
      if (!Number.isInteger(s.id) || s.id < 1 || s.id > U32_MAX) {
        warnings.push(`set ${s.id}: id does not fit uint32, dropped`);
        continue;
      }
      const e1 = s.slots[0]?.entrant;
      const e2 = s.slots[1]?.entrant;
      if (!e1 || !e2) continue; // entrants TBD: not selectable, normal bracket state
      if (e1.id > U32_MAX || e2.id > U32_MAX) {
        warnings.push(`set ${s.id}: entrant id does not fit uint32, dropped`);
        continue;
      }

      next.set(s.id, {
        id: s.id,
        state: s.state,
        round: s.round,
        roundShort: abbreviateRound(s.fullRoundText),
        roundName: wireRoundName(s.fullRoundText),
        ...this.withOverride(
          s.id,
          bestOfFor(
            this.setFormat,
            { round: s.round, phaseOrder: s.phaseGroup.phase.phaseOrder, totalGames: s.totalGames },
            shape,
          ),
        ),
        p1: { id: e1.id, tag: e1.name },
        p2: { id: e2.id, tag: e2.name },
      });
    }

    if (previewCount > 0) {
      warnings.unshift(
        `${previewCount} preview-id set(s) dropped -- a pool has not been started; start all pools on start.gg (R8)`,
      );
    }

    this.sets = next;
    this.warningList = warnings;
    this.refreshedAt = Date.now();
    this.refreshError = null;
  }

  /** Refresh every intervalMs; errors keep the old data and go to onRefreshError. */
  start(intervalMs = 20_000): void {
    if (this.timer) throw new Error('cache already started');
    this.timer = setInterval(() => {
      // Skip the tick while a refresh (including its 5xx retries) is still in
      // flight: refreshes never overlap, and the retry budget stays per-refresh.
      if (this.refreshing) return;
      this.refreshing = true;
      this.refresh()
        .catch((e) => this.onRefreshError(e as Error))
        .finally(() => {
          this.refreshing = false;
        });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(setId: number): CachedSet | undefined {
    return this.sets.get(setId);
  }

  private withOverride(
    setId: number,
    autoBestOf: number,
  ): Pick<CachedSet, 'bestOf' | 'autoBestOf' | 'bestOfOverridden'> {
    const o = this.bestOfOverrides.get(setId);
    return { bestOf: o ?? autoBestOf, autoBestOf, bestOfOverridden: o !== undefined };
  }

  /** The TO's best-of for one set (3 or 5), or null to go back to setFormat's. Applies now and on every refresh. */
  setBestOfOverride(setId: number, bestOf: number | null): void {
    if (bestOf === null) this.bestOfOverrides.delete(setId);
    else this.bestOfOverrides.set(setId, bestOf);
    const s = this.sets.get(setId);
    if (s) Object.assign(s, this.withOverride(setId, s.autoBestOf));
  }

  /** After the relay reset a set on start.gg: pending again, without waiting for the next refresh. */
  markReset(setId: number): void {
    const s = this.sets.get(setId);
    if (s) s.state = 1;
  }

  /** Selectable sets: upstream-pending with both entrants, earliest rounds first. */
  pending(): CachedSet[] {
    return [...this.sets.values()]
      .filter((s) => s.state === 1)
      .sort((a, b) => Math.abs(a.round) - Math.abs(b.round) || b.round - a.round || a.id - b.id);
  }

  status(): { count: number; refreshedAt: number; error: string | null; warnings: string[] } {
    return {
      count: this.sets.size,
      refreshedAt: this.refreshedAt,
      error: this.refreshError,
      warnings: [...this.warningList],
    };
  }
}
