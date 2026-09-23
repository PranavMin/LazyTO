// stages.ts -- Melee internal stage id (StKind) -> start.gg stage id
// (design.md section 6.3 / R13). The wire carries the game's own StKind (the
// value in the start rules, melee/src/melee/gr/forward.h); start.gg numbers
// Melee's 29 selectable stages 1..29. Both tables are frozen. The start.gg side
// was read from the real API 2026-09-22 (`node scripts/probe.ts --stages`:
// videogame(id: 1).stages, 29 rows) and matched by name below.

const STKIND_TO_STARTGG: readonly (readonly [stkind: number, startgg: number, name: string])[] = [
  [0x02, 11, 'Fountain of Dreams'],
  [0x03, 15, 'Pokémon Stadium'],
  [0x04, 2, "Princess Peach's Castle"],
  [0x05, 6, 'Kongo Jungle'],
  [0x06, 10, 'Brinstar'],
  [0x07, 13, 'Corneria'],
  [0x08, 5, "Yoshi's Story"],
  [0x09, 17, 'Onett'],
  [0x0a, 16, 'Mute City'],
  [0x0b, 3, 'Rainbow Cruise'],
  [0x0c, 7, 'Jungle Japes'],
  [0x0d, 8, 'Great Bay'],
  [0x0e, 9, 'Temple'],
  [0x0f, 24, 'Brinstar Depths'],
  [0x10, 4, "Yoshi's Island"],
  [0x11, 12, 'Green Greens'],
  [0x12, 28, 'Fourside'],
  [0x13, 1, 'Mushroom Kingdom'],
  [0x14, 21, 'Mushroom Kingdom II'],
  [0x16, 14, 'Venom'],
  [0x17, 26, 'Poké Floats'],
  [0x18, 27, 'Big Blue'],
  [0x19, 18, 'Icicle Mountain'],
  [0x1b, 29, 'Flat Zone'],
  [0x1c, 25, 'Dream Land'],
  [0x1d, 22, "Yoshi's Island 64"],
  [0x1e, 23, 'Kongo Jungle 64'],
  [0x1f, 19, 'Battlefield'],
  [0x20, 20, 'Final Destination'],
];
// Not mapped on purpose: 0x00 Dummy, 0x01 Test, 0x15 Akaneia and 0x1A Icetop
// (unused in the shipped game) -- and 0, which the Wii sends for "unknown"
// (a game scored by hand). All of those report as stage-less games.

export const MELEE_STAGE_COUNT = 29;

const TABLE = new Map(STKIND_TO_STARTGG.map(([st, sgg]) => [st, sgg]));
const NAMES = new Map(STKIND_TO_STARTGG.map(([st, , name]) => [st, name]));

/** start.gg stage id for a Melee StKind, or undefined (unknown / unmapped). */
export function toStartggStage(stkind: number): number | undefined {
  return TABLE.get(stkind);
}

/** Stage name for status-page display, or undefined. */
export function stageName(stkind: number): string | undefined {
  return NAMES.get(stkind);
}
