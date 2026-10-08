// beamer-config.ts -- a beamer's CONFIG/config.txt, as LazyTO sets it up
// (docs/redesign.md, Flashing and provisioning): the Wi-Fi to join (SSID,
// PASSWORD), LAZYTO = true and the relay's secret (LAZYTO-SECRET). The file is
// the firmware's (slippi-beamer src/config.rs): one KEY=value per line, keys
// in any case, "-" and "_" alike, # comments, a value's surrounding quotes
// stripped, and the last line for a key wins. LazyTO changes only its four
// keys and keeps every other line, so the beamer's own settings and comments
// survive.
//
// Pure functions: desktop/beamers.ts reads and writes the file, the tests
// (test/) check the text.

/** The firmware's WPA2 passphrase limits (config.rs PSK_MIN, PSK_MAX). */
const PSK_MIN = 8;
const PSK_MAX = 63;
const SSID_MAX_BYTES = 32;

/** Why these Wi-Fi settings can't work on a beamer; null when they can. */
export function wifiProblem(ssid: string, password: string): string | null {
  if (ssid.length === 0) return 'Type the Wi-Fi network name.';
  if (new TextEncoder().encode(ssid).length > SSID_MAX_BYTES) {
    return 'A Wi-Fi network name is at most 32 bytes.';
  }
  if (/[\x00-\x1f\x7f]/.test(ssid + password)) return 'The name and password must be on one line.';
  if (password.length > 0 && (password.length < PSK_MIN || password.length > PSK_MAX)) {
    return `A Wi-Fi password is ${PSK_MIN}-${PSK_MAX} characters (empty for an open network).`;
  }
  return null;
}

/** "lazyto_secret" -> "LAZYTO-SECRET": how the firmware compares keys. */
function keyOf(line: string): string | null {
  const t = line.trim();
  if (t === '' || t.startsWith('#')) return null;
  const eq = t.indexOf('=');
  if (eq < 0) return null;
  return t.slice(0, eq).trim().toUpperCase().replace(/_/g, '-');
}

/** A value as the firmware reads it back: quoted when trimming or unquoting would change it. */
function formatValue(v: string): string {
  return v !== v.trim() || v.startsWith('"') || v.startsWith("'") ? `"${v}"` : v;
}

/**
 * The file with each key set to its value: the first line for a key is
 * rewritten in place, later lines for it are dropped, a missing key is
 * appended. Line endings follow the file's own.
 */
export function setConfigValues(text: string, values: Record<string, string>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const want = new Map(
    Object.entries(values).map(([k, v]) => [k.toUpperCase().replace(/_/g, '-'), { k, v }]),
  );
  const done = new Set<string>();
  const lines: string[] = [];
  const src = text.split(/\r?\n/);
  if (src[src.length - 1] === '') src.pop();
  for (const line of src) {
    const key = keyOf(line);
    const w = key === null ? undefined : want.get(key);
    if (!w) {
      lines.push(line);
      continue;
    }
    if (done.has(key!)) continue;
    done.add(key!);
    lines.push(`${w.k}=${formatValue(w.v)}`);
  }
  for (const [key, w] of want) {
    if (!done.has(key)) lines.push(`${w.k}=${formatValue(w.v)}`);
  }
  return lines.join(eol) + eol;
}

/** What LazyTO writes: the Wi-Fi, LazyTO mode on, and the relay's secret. */
export function lazytoValues(
  ssid: string,
  password: string,
  secret: string,
): Record<string, string> {
  return { SSID: ssid, PASSWORD: password, LAZYTO: 'true', 'LAZYTO-SECRET': secret };
}
