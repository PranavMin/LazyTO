// platform.ts -- what the desktop app (desktop/main.ts) knows about the laptop
// that the relay core can't see for itself (docs/laptop-setup.md): whether
// Windows Firewall lets the beamers in, and whether a newer LazyTO is out.
// The app passes one through AppOptions.platform; the relay run from source
// (src/main.ts) and the tests run without one. The status page (status.ts)
// shows the notes, the update and the one action, "Allow LazyTO through the
// firewall", which POST /platform runs behind the admin password (app.ts).

/** One thing about the laptop the TO should fix, and the button that fixes it, if there is one. */
export interface PlatformNote {
  text: string;
  action?: { name: string; label: string };
}

/** A release newer than this build: its version and its page. */
export interface Release {
  version: string;
  url: string;
}

export interface Platform {
  /** The laptop's problems right now; [] when there are none (or nothing was checked yet). */
  notes(): PlatformNote[];
  /** The newest release, when it is newer than this build; null otherwise or when offline. */
  latest(): Release | null;
  /** Run a note's action; msg is shown on the page. */
  act(name: string): Promise<{ ok: boolean; msg: string }>;
}

/** major.minor.patch, an optional -prerelease, an optional +build; a leading "v" is allowed. */
const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Semantic-version precedence (semver.org, item 11): -1, 0 or 1; null when
 * either is not a version (a development build's "dev"). Build metadata is
 * ignored, so 0.9.0+3.gabc1234 ranks equal to 0.9.0.
 */
export function compareVersions(a: string, b: string): number | null {
  const ma = SEMVER_RE.exec(a.trim());
  const mb = SEMVER_RE.exec(b.trim());
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const pa = ma[4]?.split('.') ?? [];
  const pb = mb[4]?.split('.') ?? [];
  // A version without a pre-release ranks above any pre-release of it.
  if (pa.length === 0 || pb.length === 0) return Math.sign(pb.length - pa.length);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (i >= pa.length) return -1;
    if (i >= pb.length) return 1;
    const x = pa[i]!;
    const y = pb[i]!;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (nx !== ny) {
      return nx ? -1 : 1; // numeric identifiers rank below alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** True when `latest` is a version and ranks above `current` (false for a "dev" build). */
export function isNewer(latest: string, current: string): boolean {
  return (compareVersions(latest, current) ?? 0) > 0;
}

/**
 * GitHub's releases/latest answer (the newest full release, never a draft
 * or pre-release) as a Release, when it is newer than `current`.
 */
export function newerRelease(json: unknown, current: string): Release | null {
  if (typeof json !== 'object' || json === null) return null;
  const { tag_name, html_url } = json as { tag_name?: unknown; html_url?: unknown };
  if (typeof tag_name !== 'string' || typeof html_url !== 'string') return null;
  if (!/^https:\/\/github\.com\//.test(html_url)) return null;
  if (!isNewer(tag_name, current)) return null;
  return { version: tag_name.replace(/^v/, ''), url: html_url };
}
