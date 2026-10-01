// The loader's own settings file on the card, slippi_nincfg.bin (NIN_CFG in
// Nintendont common/include/CommonConfig.h): magic u32, version u32, then
// the Config bit word, all big-endian. sync-card ORs three bits into Config
// and changes nothing else: Network (the relay needs it), Auto Boot (straight
// into Melee; hold B at the loader for its menu) and Log (the SD log the
// relay's telemetry reads) unless asked not to.
export const NIN_CFG_MAGIC = 0x01070cf6;
export const NIN_CFG_LOG = 1 << 8;
export const NIN_CFG_AUTO_BOOT = 1 << 10;
export const NIN_CFG_NETWORK = 1 << 13;

export type LoaderConfigPatch =
  | { kind: 'patched' | 'unchanged'; oldWord: number; newWord: number; bytes: Uint8Array }
  | { kind: 'unrecognised'; magic: number };

const u32 = (b: Uint8Array, o: number): number =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** Returns the bytes to write back (a copy) and what changed; never touches the input. */
export function patchLoaderConfig(input: Uint8Array, opts: { log: boolean }): LoaderConfigPatch {
  const magic = input.length >= 4 ? u32(input, 0) : 0;
  if (input.length < 12 || magic !== NIN_CFG_MAGIC) return { kind: 'unrecognised', magic };
  let want = NIN_CFG_NETWORK | NIN_CFG_AUTO_BOOT;
  if (opts.log) want |= NIN_CFG_LOG;
  const oldWord = u32(input, 8);
  const newWord = (oldWord | want) >>> 0;
  const bytes = Uint8Array.from(input);
  if (newWord === oldWord) return { kind: 'unchanged', oldWord, newWord, bytes };
  bytes[8] = (newWord >>> 24) & 0xff;
  bytes[9] = (newWord >>> 16) & 0xff;
  bytes[10] = (newWord >>> 8) & 0xff;
  bytes[11] = newWord & 0xff;
  return { kind: 'patched', oldWord, newWord, bytes };
}

export const hex8 = (n: number): string => n.toString(16).toUpperCase().padStart(8, '0');

/** The one-line note sync-card prints for the loader config. */
export function describeLoaderConfig(p: LoaderConfigPatch | null, opts: { log: boolean }): string {
  if (p === null)
    return 'no slippi_nincfg.bin yet (the loader writes it on first save; set Network and Auto Boot in its settings)';
  if (p.kind === 'unrecognised')
    return `slippi_nincfg.bin not recognised (magic ${hex8(p.magic)}); left alone`;
  return `loader config ${hex8(p.oldWord)} -> ${hex8(p.newWord)}: network on, auto boot on, log ${opts.log ? 'on' : 'left as is'}`;
}
