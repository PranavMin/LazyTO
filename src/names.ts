// names.ts -- the set archive's file names (archive.ts), exactly as Replay
// Reporter for Slippi names a copied set with its default settings
// (src/renderer/App.tsx onCopy and src/main/replay.ts writeReplays, v2.7.0):
//   zip:   '{phaseOrEvent} {roundShort} - {playersChars}' + '.zip'
//   entry: '{ordinal} - {playersChars} - {stage}' + '.slp'
// filled one placeholder at a time in Replay Reporter's order, then cleaned
// by sanitize-filename 1.6.3. The tables are Replay Reporter's
// (src/common/constants.ts): its short character names and its stage names.
//
// One Replay Reporter bug is left out: it fills with String.replace and a
// string value, so "$$", "$&", "$`" and "$'" in a tag are replacement
// patterns there ("Ca$$h" becomes "Ca$h"). Here every value is taken
// literally.
//
// Ported from Replay Reporter for Slippi (jmlee337/replay-manager-for-slippi,
// MIT) and sanitize-filename (WTFPL OR ISC).

/** Replay Reporter's short names by external character id (constants.ts characterNames). */
export const RR_CHARACTER: ReadonlyMap<number, string> = new Map([
  [0, 'Falcon'],
  [1, 'DK'],
  [2, 'Fox'],
  [3, 'GW'],
  [4, 'Kirby'],
  [5, 'Bowser'],
  [6, 'Link'],
  [7, 'Luigi'],
  [8, 'Mario'],
  [9, 'Marth'],
  [10, 'Mewtwo'],
  [11, 'Ness'],
  [12, 'Peach'],
  [13, 'Pikachu'],
  [14, 'ICs'],
  [15, 'Puff'],
  [16, 'Samus'],
  [17, 'Yoshi'],
  [18, 'Zelda'],
  [19, 'Sheik'],
  [20, 'Falco'],
  [21, 'YL'],
  [22, 'Doc'],
  [23, 'Roy'],
  [24, 'Pichu'],
  [25, 'Ganon'],
]);

/** Replay Reporter's stage names by the replay's stage id (constants.ts stageNames). */
export const RR_STAGE: ReadonlyMap<number, string> = new Map([
  [2, 'Fountain of Dreams'],
  [3, 'Pokémon Stadium'],
  [4, "Peach's Castle"],
  [5, 'Kongo Jungle'],
  [6, 'Brinstar'],
  [7, 'Corneria'],
  [8, "Yoshi's Story"],
  [9, 'Onett'],
  [10, 'Mute City'],
  [11, 'Rainbow Cruise'],
  [12, 'Jungle Japes'],
  [13, 'Great Bay'],
  [14, 'Temple'],
  [15, 'Brinstar Depths'],
  [16, "Yoshi's Island"],
  [17, 'Green Greens'],
  [18, 'Fourside'],
  [19, 'Mushroom Kingdom'],
  [20, 'Mushroom Kingdom II'],
  [22, 'Venom'],
  [23, 'Poké Floats'],
  [24, 'Big Blue'],
  [25, 'Icicle Mountain'],
  [27, 'Flat Zone'],
  [28, 'Dream Land'],
  [29, "Yoshi's Island N64"],
  [30, 'Kongo Jungle N64'],
  [31, 'Battlefield'],
  [32, 'Final Destination'],
]);

/** Replay Reporter's default zip name template (src/main/ipc.ts). */
export const RR_ZIP_TEMPLATE = '{phaseOrEvent} {roundShort} - {playersChars}';
/** Replay Reporter's default entry name template: '{ordinal}' + its fileNameFormat. */
export const RR_ENTRY_TEMPLATE = '{ordinal} - {playersChars} - {stage}';

/** Every capital letter and digit of start.gg's round text, in order: "Winners Semi-Final" -> "WSF", "Losers Top 8" -> "LT8". */
export function rrRoundShort(fullRoundText: string): string {
  return (fullRoundText.match(/[A-Z0-9]/g) ?? []).join('');
}

/**
 * Fill a template the way Replay Reporter does, one placeholder after another
 * in the given order, each only at its first occurrence in the text so far
 * (so a value that contains a later placeholder's text is filled in too) --
 * but with the value taken literally.
 */
export function rrFill(template: string, fill: readonly (readonly [string, string])[]): string {
  let out = template;
  for (const [placeholder, value] of fill) {
    const at = out.indexOf(placeholder);
    if (at >= 0) out = out.slice(0, at) + value + out.slice(at + placeholder.length);
  }
  return out;
}

/**
 * sanitize-filename 1.6.3 with its default replacement "" (WTFPL OR ISC),
 * with truncate-utf8-bytes 1.0.2 (WTFPL): / ? < > \ : * | " and C0/C1
 * controls removed; a name of only dots, or a Windows reserved name (con,
 * prn, aux, nul, com0-9, lpt0-9, with or without an extension), becomes "";
 * trailing dots and spaces go; then at most 255 UTF-8 bytes, never splitting
 * a surrogate pair.
 */
export function rrSanitize(input: string): string {
  const sanitized = input
    .replace(/[/?<>\\:*|"]/g, '')
    .replace(/[\x00-\x1f\x80-\x9f]/g, '')
    .replace(/^\.+$/, '')
    .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '')
    .replace(/[. ]+$/, '');
  return truncateUtf8(sanitized, 255);
}

function truncateUtf8(s: string, byteLength: number): string {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    let segment = s[i]!;
    const c = s.charCodeAt(i);
    const next = s.charCodeAt(i + 1);
    if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      i++;
      segment += s[i]!;
    }
    bytes += Buffer.byteLength(segment);
    if (bytes === byteLength) return s.slice(0, i + 1);
    if (bytes > byteLength) return s.slice(0, i - segment.length + 1);
  }
  return s;
}
