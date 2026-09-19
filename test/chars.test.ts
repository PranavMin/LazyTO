import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toStartggCharacter, characterName, MELEE_CHARACTER_COUNT } from '../src/chars.js';

test('every Melee external character id 0..25 maps to a distinct start.gg id 1..26', () => {
  assert.equal(MELEE_CHARACTER_COUNT, 26);
  const seen = new Set<number>();
  for (let ext = 0; ext < MELEE_CHARACTER_COUNT; ext++) {
    const sgg = toStartggCharacter(ext);
    assert.ok(sgg !== undefined, `external id ${ext} unmapped`);
    assert.ok(sgg >= 1 && sgg <= 26, `external id ${ext} maps out of range: ${sgg}`);
    assert.ok(!seen.has(sgg), `start.gg id ${sgg} mapped twice`);
    seen.add(sgg);
    assert.ok(characterName(ext), `external id ${ext} has no name`);
  }
});

test('spot checks against known ids', () => {
  assert.equal(toStartggCharacter(2), 6); // Fox
  assert.equal(toStartggCharacter(9), 14); // Marth
  assert.equal(toStartggCharacter(15), 9); // Jigglypuff
  assert.equal(toStartggCharacter(0), 2); // Captain Falcon
  assert.equal(characterName(3), 'Mr. Game & Watch');
});

test('out-of-range ids are undefined', () => {
  assert.equal(toStartggCharacter(26), undefined);
  assert.equal(toStartggCharacter(255), undefined);
  assert.equal(toStartggCharacter(-1), undefined);
});
