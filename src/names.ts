// names.ts -- file names for the set archives (archive.ts), from the two
// templates in the config (archiveSetName, archiveGameName; .env
// ARCHIVE_SET_NAME / ARCHIVE_GAME_NAME). A template is text with {field}
// placeholders. The fields are fixed here, and config.ts refuses a template
// that names any other, so a typo fails at startup instead of in a file name.

/** Fields both templates may use. */
export const SET_FIELDS = [
  'tournament', // start.gg tournament name, e.g. "My Bar Weekly #60"
  'number', // the last number in the tournament name ("60"), "" if none
  'event', // event name
  'round', // "Winners Semi-Final"
  'round_short', // "WSF"
  'p1', // entrant 1's tag (start.gg order)
  'p2', // entrant 2's tag
  'winner',
  'loser',
  'score', // games won, p1-p2: "3-1"
  'date', // the set's start, local date: 2026-10-01
  'set_id',
] as const;

/** Extra fields only the per-game template may use. */
export const GAME_FIELDS = [
  'game', // 1-based game number
  'stage', // short stage name: "BF"
  'stage_name', // "Battlefield"
  'p1_char', // entrant 1's character, short: "Fox"
  'p2_char',
  'game_winner', // tag of the game's winner
] as const;

export type SetFields = Record<(typeof SET_FIELDS)[number], string>;
export type GameFields = SetFields & Record<(typeof GAME_FIELDS)[number], string>;

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Placeholders in a template that are not among `allowed`. */
export function unknownFields(template: string, allowed: readonly string[]): string[] {
  const bad: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) if (!allowed.includes(m[1]!)) bad.push(m[1]!);
  return bad;
}

/** Fill a template and make the result a safe file name (no extension). */
export function fillName(template: string, fields: Record<string, string>): string {
  const filled = template.replace(PLACEHOLDER, (_, k: string) => fields[k] ?? '');
  return safeFileName(filled);
}

/** Windows' and Linux's forbidden characters out, runs of spaces folded, no leading/trailing dots or spaces. */
export function safeFileName(s: string): string {
  const cleaned = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  return cleaned.slice(0, 180) || 'set';
}

/** "My Bar Weekly #60" -> "60". */
export function tournamentNumber(name: string): string {
  const m = name.match(/(\d+)\D*$/);
  return m ? m[1]! : '';
}

const SHORT_CHARACTER: Record<number, string> = {
  0: 'Falcon',
  1: 'DK',
  2: 'Fox',
  3: 'G&W',
  4: 'Kirby',
  5: 'Bowser',
  6: 'Link',
  7: 'Luigi',
  8: 'Mario',
  9: 'Marth',
  10: 'Mewtwo',
  11: 'Ness',
  12: 'Peach',
  13: 'Pikachu',
  14: 'ICs',
  15: 'Puff',
  16: 'Samus',
  17: 'Yoshi',
  18: 'Zelda',
  19: 'Sheik',
  20: 'Falco',
  21: 'YLink',
  22: 'Doc',
  23: 'Roy',
  24: 'Pichu',
  25: 'Ganon',
};

/** Short character name for file names, by external character id; "" if unknown. */
export function shortCharacter(externalId: number): string {
  return SHORT_CHARACTER[externalId] ?? '';
}

const SHORT_STAGE: Record<number, string> = {
  0x02: 'FoD',
  0x03: 'PS',
  0x08: 'YS',
  0x1c: 'DL',
  0x1f: 'BF',
  0x20: 'FD',
};

/** Short stage name for file names: the legal stages' usual abbreviations, else the full name without spaces. */
export function shortStage(stkind: number, fullName: string | undefined): string {
  return SHORT_STAGE[stkind] ?? (fullName ?? '').replace(/[^A-Za-z0-9]/g, '');
}
