// format.ts -- the best-of each set is played to (architecture.md Relay).
//
// start.gg stores a best-of per set (totalGames), but an in-person event has
// no place in the admin UI to set it per round: every set reports 5. The
// venue plays Bo3 until top 8, so the relay decides the format itself when
// setFormat is "top8q", from the bracket's shape:
//
//   top 8 in a double-elimination bracket = the four Winners Semi-Final
//   players plus the four in the losers round that feeds Losers Quarter-Final.
//   Their qualifiers are Winners Quarter-Final and the losers round before
//   that. Those sets and everything after them are Bo5; the rest Bo3.
//
// Round numbers (scripts/probe.ts --rounds, test event 2026-10-01): within a
// phase, winners count up to the Grand Final (Grand Final and its reset
// share a number); losers count down to Losers Final and do not start at
// -1. Every phase numbers its rounds from 1 again.
//
// Phases: the final phase (highest phaseOrder) holds the end of the bracket
// and gets the rule above from its own highest and lowest round. Grand Final
// and Losers Final stay pending until the bracket ends, so both extremes are
// visible from the pending-set query for as long as any set of their side
// is left to classify. If the final phase is a top 8 (its Grand Final is
// round 3: Winners Semi-Final, Winners Final, Grand Final), the phase before
// it feeds top 8, and the last winners round and the last losers round of
// that phase are the qualifiers: Bo5. A final phase bigger than that has its
// qualifiers inside itself, and the feeder phase is all Bo3. Any earlier
// phase is Bo3. A single-phase bracket of 8 or fewer is all top 8 and all
// Bo5, which is what the rule gives.

export type SetFormat = 'startgg' | 'top8q';

export const SET_FORMATS: readonly SetFormat[] = ['startgg', 'top8q'];

/** What the format needs to know about a set. */
export interface ShapeSet {
  round: number;
  phaseOrder: number;
}

interface PhaseExtremes {
  hi: number; // highest winners round (Grand Final)
  lo: number; // lowest losers round (Losers Final)
}

export interface BracketShape {
  finalOrder: number; // phaseOrder of the last phase
  final: PhaseExtremes;
  feederOrder: number | null; // the phase just before the final one, if any
  feeder: PhaseExtremes;
  feederIsTop8Qualifier: boolean; // final phase is a top 8: feeder's last rounds are the qualifiers
}

const TOP8_GRAND_FINAL_ROUND = 3;

/** The shape from every set the event query returned, both-entrant or not. */
export function bracketShape(sets: readonly ShapeSet[]): BracketShape {
  const byPhase = new Map<number, PhaseExtremes>();
  for (const s of sets) {
    const p = byPhase.get(s.phaseOrder) ?? { hi: 0, lo: 0 };
    if (s.round > p.hi) p.hi = s.round;
    if (s.round < p.lo) p.lo = s.round;
    byPhase.set(s.phaseOrder, p);
  }
  const orders = [...byPhase.keys()].sort((a, b) => a - b);
  const finalOrder = orders[orders.length - 1] ?? 0;
  const feederOrder = orders.length >= 2 ? orders[orders.length - 2]! : null;
  const final = byPhase.get(finalOrder) ?? { hi: 0, lo: 0 };
  const feeder = feederOrder === null ? { hi: 0, lo: 0 } : byPhase.get(feederOrder)!;
  return {
    finalOrder,
    final,
    feederOrder,
    feeder,
    feederIsTop8Qualifier: feederOrder !== null && final.hi <= TOP8_GRAND_FINAL_ROUND,
  };
}

/** Bo5 from the top-8 qualifiers onward, Bo3 before. */
export function isBo5Top8q(set: ShapeSet, shape: BracketShape): boolean {
  if (set.phaseOrder === shape.finalOrder) {
    if (set.round > 0) return set.round >= shape.final.hi - 3; // WQF, WSF, WF, GF
    return set.round <= shape.final.lo + 4; // LR before LR before LQF, ..., LF
  }
  if (set.phaseOrder === shape.feederOrder && shape.feederIsTop8Qualifier) {
    return set.round === shape.feeder.hi || set.round === shape.feeder.lo;
  }
  return false;
}

export function bestOfFor(
  format: SetFormat,
  set: ShapeSet & { totalGames: number },
  shape: BracketShape,
): number {
  switch (format) {
    case 'startgg':
      return set.totalGames;
    case 'top8q':
      return isBo5Top8q(set, shape) ? 5 : 3;
  }
}
