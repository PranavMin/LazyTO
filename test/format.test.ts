import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bracketShape, bestOfFor, isBo5Top8q, type ShapeSet } from '../src/format.js';

type Named = readonly [round: number, phaseOrder: number, name: string];

function shapeOf(sets: readonly Named[]) {
  return bracketShape(sets.map(([round, phaseOrder]) => ({ round, phaseOrder })));
}
function bo5Names(sets: readonly Named[]) {
  const shape = shapeOf(sets);
  return sets.filter(([round, phaseOrder]) => isBo5Top8q({ round, phaseOrder }, shape)).map(([, , name]) => name);
}

// The real 16-entrant test event as one phase (scripts/probe.ts --rounds=1613010,
// 2026-10-01): winners 1..5 (Grand Final and its reset both 5), losers -3..-8.
const SIXTEEN: Named[] = [
  [1, 2, 'Winners Round 1'],
  [2, 2, 'Winners Quarter-Final'],
  [3, 2, 'Winners Semi-Final'],
  [4, 2, 'Winners Final'],
  [5, 2, 'Grand Final'],
  [5, 2, 'Grand Final Reset'],
  [-3, 2, 'Losers Round 1'],
  [-4, 2, 'Losers Round 2'],
  [-5, 2, 'Losers Round 3'],
  [-6, 2, 'Losers Quarter-Final'],
  [-7, 2, 'Losers Semi-Final'],
  [-8, 2, 'Losers Final'],
];

// The same event with a Top 8 phase (phaseOrder 3) fed by 4 winners + 4 losers
// from the Bracket phase (phaseOrder 2), probed the same day.
const SIXTEEN_TOP8: Named[] = [
  [1, 2, 'Winners Round 1'],
  [2, 2, 'Winners Quarter-Final'],
  [-3, 2, 'Losers Round 1'],
  [-4, 2, 'Losers Round 2'],
  [1, 3, 'Winners Semi-Final'],
  [2, 3, 'Winners Final'],
  [3, 3, 'Grand Final'],
  [3, 3, 'Grand Final Reset'],
  [-3, 3, 'Losers Round 1'],
  [-4, 3, 'Losers Quarter-Final'],
  [-5, 3, 'Losers Semi-Final'],
  [-6, 3, 'Losers Final'],
];

test('bracketShape takes the extremes per phase', () => {
  const one = shapeOf(SIXTEEN);
  assert.equal(one.finalOrder, 2);
  assert.deepEqual(one.final, { hi: 5, lo: -8 });
  assert.equal(one.feederOrder, null);
  assert.equal(one.feederIsTop8Qualifier, false);

  const two = shapeOf(SIXTEEN_TOP8);
  assert.equal(two.finalOrder, 3);
  assert.deepEqual(two.final, { hi: 3, lo: -6 });
  assert.equal(two.feederOrder, 2);
  assert.deepEqual(two.feeder, { hi: 2, lo: -4 });
  assert.equal(two.feederIsTop8Qualifier, true);

  assert.equal(bracketShape([]).finalOrder, 0);
});

test('top8q, one phase, 16 entrants: Bo5 from WQF and LR2 onward', () => {
  assert.deepEqual(bo5Names(SIXTEEN), [
    'Winners Quarter-Final',
    'Winners Semi-Final',
    'Winners Final',
    'Grand Final',
    'Grand Final Reset',
    'Losers Round 2',
    'Losers Round 3',
    'Losers Quarter-Final',
    'Losers Semi-Final',
    'Losers Final',
  ]);
});

test('top8q, Bracket + Top 8 phases: the same ten sets are Bo5', () => {
  assert.deepEqual(bo5Names(SIXTEEN_TOP8), [
    'Winners Quarter-Final',
    'Losers Round 2',
    'Winners Semi-Final',
    'Winners Final',
    'Grand Final',
    'Grand Final Reset',
    'Losers Round 1',
    'Losers Quarter-Final',
    'Losers Semi-Final',
    'Losers Final',
  ]);
});

test('top8q, one phase, 32 entrants: one more Bo3 round on each side', () => {
  // Winners 1..6 (Grand Final 6), losers -4..-11 (eight losers rounds).
  const rounds = [1, 2, 3, 4, 5, 6, -4, -5, -6, -7, -8, -9, -10, -11];
  const sets: ShapeSet[] = rounds.map((round) => ({ round, phaseOrder: 1 }));
  const shape = bracketShape(sets);
  assert.deepEqual(
    sets.filter((s) => isBo5Top8q(s, shape)).map((s) => s.round),
    [3, 4, 5, 6, -7, -8, -9, -10, -11],
  );
});

test('top8q, pools into a top 16 phase: the qualifiers are inside the final phase', () => {
  // Final phase is a 16-bracket (Grand Final 5): its own WQF/LR2 onward is Bo5,
  // the pools phase is all Bo3 whatever its last rounds are.
  const pools: ShapeSet[] = [1, 2, 3, -1, -2].map((round) => ({ round, phaseOrder: 1 }));
  const top16: ShapeSet[] = [1, 2, 3, 4, 5, -3, -4, -5, -6, -7, -8].map((round) => ({ round, phaseOrder: 2 }));
  const shape = bracketShape([...pools, ...top16]);
  assert.ok(pools.every((s) => !isBo5Top8q(s, shape)));
  assert.deepEqual(
    top16.filter((s) => isBo5Top8q(s, shape)).map((s) => s.round),
    [2, 3, 4, 5, -4, -5, -6, -7, -8],
  );
});

test('top8q, three phases: only the phase before the top 8 has qualifiers', () => {
  const pools: ShapeSet[] = [1, 2, -1, -2].map((round) => ({ round, phaseOrder: 1 }));
  const bracket: ShapeSet[] = [1, 2, -3, -4].map((round) => ({ round, phaseOrder: 2 }));
  const top8: ShapeSet[] = [1, 2, 3, -3, -4, -5, -6].map((round) => ({ round, phaseOrder: 3 }));
  const shape = bracketShape([...pools, ...bracket, ...top8]);
  assert.ok(pools.every((s) => !isBo5Top8q(s, shape)));
  assert.deepEqual(bracket.filter((s) => isBo5Top8q(s, shape)).map((s) => s.round), [2, -4]);
  assert.ok(top8.every((s) => isBo5Top8q(s, shape)));
});

test('top8q, 8 or fewer entrants in one phase is all top 8, all Bo5', () => {
  const sets: ShapeSet[] = [1, 2, 3, -1, -2, -3, -4].map((round) => ({ round, phaseOrder: 1 }));
  const shape = bracketShape(sets);
  assert.ok(sets.every((s) => isBo5Top8q(s, shape)));
});

test('bestOfFor: startgg passes totalGames through, top8q ignores it', () => {
  const shape = shapeOf(SIXTEEN);
  assert.equal(bestOfFor('startgg', { round: 1, phaseOrder: 2, totalGames: 5 }, shape), 5);
  assert.equal(bestOfFor('startgg', { round: 5, phaseOrder: 2, totalGames: 3 }, shape), 3);
  assert.equal(bestOfFor('top8q', { round: 1, phaseOrder: 2, totalGames: 5 }, shape), 3);
  assert.equal(bestOfFor('top8q', { round: 2, phaseOrder: 2, totalGames: 5 }, shape), 5);
  assert.equal(bestOfFor('top8q', { round: -3, phaseOrder: 2, totalGames: 5 }, shape), 3);
  assert.equal(bestOfFor('top8q', { round: -4, phaseOrder: 2, totalGames: 5 }, shape), 5);
});
