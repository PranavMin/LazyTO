// phasegroup.ts -- what the set archive's context.json takes from start.gg's
// REST phase group (GET /phase_group/<id>?expand[]=sets&expand[]=entrants
// &expand[]=seeds&bustCache=true, startgg.ts getPhaseGroupRest), read the way
// Replay Reporter for Slippi reads it (src/main/startgg.ts getPhaseGroup,
// v2.7.0, MIT): the group's bracket type, display name, wave and winners
// target phase, and each set's ordinal.
//
// The ordinal (startgg.ts:575-681 there): a double-elimination group's sets
// are stacked in reverse play order -- grand final reset, grand final, then
// the losers final, walking back through the losers bracket and pushing the
// winners sets that feed it -- and a set's ordinal is minus its place in that
// stack. Without both grand finals reachable the stack starts from the sets
// that progress out of the group. Any other set, and every set of another
// bracket type, takes its callOrder; without one, null. Unreachable sets are
// left out first; byes take places in the stack but get no ordinal. The
// GraphQL API has none of callOrder, isGF, unreachable or the prerequisite
// conditions, which is why the relay makes Replay Reporter's REST call.

import type { RestPhaseGroup } from './startgg.js';

export type { RestPhaseGroup } from './startgg.js';

export type SetId = number | string;

/** The phase group facts context.json carries (startgg.phaseGroup and startgg.set.ordinal). */
export interface PhaseGroupFacts {
  bracketType: number; // groupTypeId: 1 SE, 2 DE, 3 round robin, 4 Swiss, 6 custom, 7 matchmaking
  name: string; // displayIdentifier, e.g. "1" or "A2"
  waveId: number | null;
  winnersTargetPhaseId: number | null;
  /** This set's ordinal: null when the group gives it none. */
  ordinal: number | null;
}

/** A set of the REST group, as loose as the API is. */
type ApiSet = Record<string, any>;

/** The facts for one set of the group. */
export function phaseGroupFacts(json: RestPhaseGroup, setId: SetId): PhaseGroupFacts {
  const g = json.entities.groups;
  return {
    bracketType: g.groupTypeId,
    name: g.displayIdentifier,
    waveId: g.waveId,
    winnersTargetPhaseId: g.winnersTargetPhaseId,
    ordinal: rrOrdinals(json).get(setId) ?? null,
  };
}

/** Every set's ordinal as Replay Reporter records it when it loads the group (byes and unreachable sets have none). */
export function rrOrdinals(json: RestPhaseGroup): Map<SetId, number | null> {
  const ordinals = new Map<SetId, number | null>();
  const bracketType = json.entities.groups.groupTypeId;
  // A matchmaking group (7) and a group of another type or without seeds
  // load no ordinals at all there.
  const valid = [1, 2, 3, 4, 6].includes(bracketType);
  const seeds = json.entities.seeds;
  if (!valid || !Array.isArray(seeds) || seeds.length === 0) return ordinals;
  const sets = json.entities.sets;
  if (!Array.isArray(sets)) return ordinals;

  // A shallow copy per set, so the grand final reset's round + 1 stays here.
  const reachable = sets.filter((s) => !s.unreachable).map((s) => ({ ...s }));
  const gfr = reachable.find((s) => s.fullRoundText === 'Grand Final Reset');
  if (gfr) gfr.round += 1;

  const idToDEOrdinal = new Map<SetId, number>();
  if (bracketType === 2) {
    const byId = new Map<SetId, ApiSet>();
    reachable.forEach((s) => byId.set(s.id, s));
    const prereq = (id: SetId): ApiSet => {
      const s = byId.get(id);
      // Replay Reporter fails to load such a group (it reads a field of undefined).
      if (!s) throw new Error(`phase group: prerequisite set ${id} is not in the group`);
      return s;
    };

    const stack: ApiSet[] = [];
    const winnersQueue: ApiSet[] = [];
    let losersQueue: ApiSet[] = [];
    const gfs = reachable.filter((s) => s.isGF).sort((a, b) => b.round - a.round);
    if (gfs.length === 2) {
      stack.push(gfs[0]!, gfs[1]!);
      if (gfs[1]!.entrant2PrereqType === 'set') losersQueue.push(prereq(gfs[1]!.entrant2PrereqId));
    } else {
      reachable
        .filter((s) => s.wProgressionSeedId && s.lProgressionSeedId)
        .forEach((s) => stack.push(s));
      reachable
        .filter((s) => s.wProgressionSeedId && s.round < 0)
        .sort((a, b) => a.round - b.round)
        .forEach((s) => losersQueue.push(s));
    }
    while (losersQueue.length > 0) {
      const newLosersQueue: ApiSet[] = [];
      while (losersQueue.length > 0) {
        const curr = losersQueue.shift()!;
        stack.push(curr);
        for (const n of [1, 2]) {
          if (curr[`entrant${n}PrereqType`] !== 'set') continue;
          const pushSet = prereq(curr[`entrant${n}PrereqId`]);
          if (curr[`entrant${n}PrereqCondition`] === 'winner') newLosersQueue.push(pushSet);
          else winnersQueue.push(pushSet);
        }
      }
      while (winnersQueue.length > 0) stack.push(winnersQueue.shift()!);
      losersQueue = newLosersQueue;
    }
    stack.forEach((s, i) => idToDEOrdinal.set(s.id, -i));
  }

  for (const s of reachable) {
    if (s.entrant1PrereqType === 'bye' || s.entrant2PrereqType === 'bye') continue;
    ordinals.set(s.id, idToDEOrdinal.get(s.id) ?? s.callOrder ?? null);
  }
  return ordinals;
}
