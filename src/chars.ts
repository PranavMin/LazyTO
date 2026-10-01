// chars.ts -- Melee external character id -> start.gg character id
// (architecture.md Relay). The wire carries the CSS ckind value
// (CharacterKind, the EXTERNAL id ordering, sessions 5's finding); start.gg
// numbers Melee's cast 1..26 alphabetically. Both tables are frozen -- the
// cast has not changed since 2001. Verified against the real API 2026-09-19:
// videogame(id: 1).characters returns exactly ids 1..26 alphabetical, and all
// 26 rows below match. (The API also has 628 "Sheik / Zelda" and 1744 "Random
// Character", which this table never maps to.)

const EXTERNAL_TO_STARTGG: readonly (readonly [external: number, startgg: number, name: string])[] =
  [
    [0, 2, 'Captain Falcon'],
    [1, 3, 'Donkey Kong'],
    [2, 6, 'Fox'],
    [3, 16, 'Mr. Game & Watch'],
    [4, 10, 'Kirby'],
    [5, 1, 'Bowser'],
    [6, 11, 'Link'],
    [7, 12, 'Luigi'],
    [8, 13, 'Mario'],
    [9, 14, 'Marth'],
    [10, 15, 'Mewtwo'],
    [11, 17, 'Ness'],
    [12, 18, 'Peach'],
    [13, 20, 'Pikachu'],
    [14, 8, 'Ice Climbers'],
    [15, 9, 'Jigglypuff'],
    [16, 22, 'Samus'],
    [17, 24, 'Yoshi'],
    [18, 26, 'Zelda'],
    [19, 23, 'Sheik'],
    [20, 5, 'Falco'],
    [21, 25, 'Young Link'],
    [22, 4, 'Dr. Mario'],
    [23, 21, 'Roy'],
    [24, 19, 'Pichu'],
    [25, 7, 'Ganondorf'],
  ];

export const MELEE_CHARACTER_COUNT = 26;

const TABLE = new Map(EXTERNAL_TO_STARTGG.map(([ext, sgg]) => [ext, sgg]));
const NAMES = new Map(EXTERNAL_TO_STARTGG.map(([ext, , name]) => [ext, name]));

/** start.gg character id for a Melee external (CSS ckind) id, or undefined. */
export function toStartggCharacter(externalId: number): number | undefined {
  return TABLE.get(externalId);
}

/** Character name for status-page display, or undefined. */
export function characterName(externalId: number): string | undefined {
  return NAMES.get(externalId);
}
