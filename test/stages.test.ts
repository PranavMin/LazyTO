import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toStartggStage, stageName, MELEE_STAGE_COUNT } from '../src/stages.js';

test('stages: the kiosk six map to their start.gg ids', () => {
  assert.equal(toStartggStage(0x1f), 19); // Battlefield
  assert.equal(toStartggStage(0x20), 20); // Final Destination
  assert.equal(toStartggStage(0x02), 11); // Fountain of Dreams
  assert.equal(toStartggStage(0x08), 5); // Yoshi's Story
  assert.equal(toStartggStage(0x1c), 25); // Dream Land
  assert.equal(toStartggStage(0x03), 15); // Pokémon Stadium
  assert.equal(stageName(0x1c), 'Dream Land');
});

test('stages: every start.gg id 1..29 is reached exactly once', () => {
  const seen = new Set<number>();
  for (let st = 0; st < 0x40; st++) {
    const id = toStartggStage(st);
    if (id === undefined) continue;
    assert.ok(!seen.has(id), `start.gg id ${id} mapped twice`);
    seen.add(id);
  }
  assert.equal(seen.size, MELEE_STAGE_COUNT);
  for (let id = 1; id <= MELEE_STAGE_COUNT; id++)
    assert.ok(seen.has(id), `start.gg id ${id} unmapped`);
});

test('stages: unknown (0, hand-scored) and unused ids report as stage-less', () => {
  assert.equal(toStartggStage(0), undefined);
  assert.equal(toStartggStage(0x15), undefined); // Akaneia (unused)
  assert.equal(toStartggStage(0x1a), undefined); // Icetop (unused)
  assert.equal(toStartggStage(0xff), undefined);
});
