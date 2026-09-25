// cache.ts -- the pending-set cache (design.md section 6.3). One upstream
// query, refreshed every 20 s; everything the Wiis can see comes from here.
//
// Preview set ids (design.md R8, option a): a set in an unstarted pool has a
// string id like preview_3292311_1_1, which cannot be a uint32 on the wire.
// The cache DROPS those sets and records a warning for the status page; the
// per-tournament setup checklist says to start all pools before doors.

import { ROUND_LEN } from '../generated/wire.js';
import type { StartggClient, UpstreamSet } from './startgg.js';

export interface CachedGame {
  orderNum: number;
  winnerSlot: 1 | 2;
}

export interface CachedSet {
  id: number; // fits uint32
  state: number; // 1 pending, 2 in progress (upstream's view)
  round: number;
  roundShort: string; // "WR2", "LF", "GF" -- the status page
  roundName: string; // "WINNERS QUARTER-FINAL" -- the wire field the Wii shows (ROUND_LEN chars)
  bestOf: number;
  p1: { id: number; tag: string };
  p2: { id: number; tag: string };
  games: CachedGame[]; // reloaded from upstream, for state rebuild after reboots
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

  constructor(
    private readonly client: StartggClient,
    private readonly eventId: number,
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

      const games: CachedGame[] = [];
      for (const g of s.games ?? []) {
        if (g.winnerId === e1.id) games.push({ orderNum: g.orderNum, winnerSlot: 1 });
        else if (g.winnerId === e2.id) games.push({ orderNum: g.orderNum, winnerSlot: 2 });
        else warnings.push(`set ${s.id}: game ${g.orderNum} winner ${g.winnerId} is neither entrant, skipped`);
      }
      games.sort((a, b) => a.orderNum - b.orderNum);

      next.set(s.id, {
        id: s.id,
        state: s.state,
        round: s.round,
        roundShort: abbreviateRound(s.fullRoundText),
        roundName: wireRoundName(s.fullRoundText),
        bestOf: s.totalGames,
        p1: { id: e1.id, tag: e1.name },
        p2: { id: e2.id, tag: e2.name },
        games,
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

  /** Selectable sets: upstream-pending with both entrants, earliest rounds first. */
  pending(): CachedSet[] {
    return [...this.sets.values()]
      .filter((s) => s.state === 1)
      .sort(
        (a, b) =>
          Math.abs(a.round) - Math.abs(b.round) || b.round - a.round || a.id - b.id,
      );
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
