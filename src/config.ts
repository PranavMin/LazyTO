// config.ts -- the relay's settings (architecture.md Relay): one JSON file in
// the data directory, written by the setup page (setup.ts) and read at every
// (re)start of the event (app.ts).
//
// The event and stream are named, not numbered: tournament is the start.gg
// short URL (e.g. "mybar") or, for an unpublished tournament, its full slug;
// eventName and streamName pick from it by name; resolve.ts turns them into
// ids, because the ids change every week and the names do not.
// weeklyNamePrefix ("" for none) lets a numbered weekly series be found by
// name when the short URL has not been moved yet (resolve.ts).
//
// Values are validated strictly. Fields fall in two groups: the five
// required ones never change meaning; every other field is optional with a
// default, so a build that adds a field still accepts the file an older build
// wrote and an auto-update never stalls a Pi (test/config.test.ts keeps a
// frozen copy of an old file). Unknown fields are ignored and reported, so a
// field a later build dropped does no harm either.

import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { SET_FORMATS, type SetFormat } from './format.js';

/** Fixed facts of every install; not settings. */
export const STARTGG_ENDPOINT = 'https://api.start.gg/gql/alpha';
export const TCP_PORT = 29470;
export const HTTP_PORT = 29473;
/** Settings, audit logs and Wii logs. LAZYTO_DIR overrides it on a development machine. */
export const DATA_DIR = process.env.LAZYTO_DIR ?? '/var/lib/lazyto';

export function configPath(dataDir: string): string {
  return join(dataDir, 'config.json');
}

export interface Config {
  token: string;
  tournament: string; // start.gg short URL (e.g. "mybar") or full slug ("tournament/<slug>")
  eventName: string; // e.g. "Melee Singles! (7:30 Start)"; matched as a substring
  secret: string; // shared with every station's relay_auth (decisions.md R16)
  adminPassword: string; // the TO's password for the settings and the status page's actions
  weeklyNamePrefix: string; // "" = no weekly fallback; else e.g. "My Bar Weekly #"
  streamName: string; // the stream's name in the tournament's stream settings; "" = no stream
  streamStation: number; // station number (u16 on the wire) of the stream Wii
  setFormat: SetFormat; // "startgg": each set's best-of as start.gg has it; "top8q" (format.ts)
}

const SECRET_RE = /^[A-Za-z0-9_-]{8,16}$/;
const PASSWORD_RE = /^[\x21-\x7e]{8,64}$/;
const TOURNAMENT_RE = /^(tournament\/)?[A-Za-z0-9-]+$/;

/** One row per field: its check (a problem string, or null) and, for an optional field, its default. */
const FIELDS: {
  [K in keyof Config]: { check: (v: unknown) => string | null; default?: Config[K] };
} = {
  token: {
    check: (v) => (typeof v === 'string' && v.length > 0 ? null : 'must be a non-empty string'),
  },
  tournament: {
    check: (v) =>
      typeof v === 'string' && TOURNAMENT_RE.test(v)
        ? null
        : 'must be a start.gg short URL (e.g. "mybar") or full slug ("tournament/<slug>")',
  },
  eventName: {
    check: (v) =>
      typeof v === 'string' && v.trim().length > 0 ? null : 'must be a non-empty string',
  },
  // Letters, digits, - and _ only: it is written onto every SD card as
  // secret=<value> and must survive the kernel's key=value parser. 8 to
  // SECRET_LEN (16) characters.
  secret: {
    check: (v) =>
      typeof v === 'string' && SECRET_RE.test(v) ? null : 'must be 8-16 letters, digits, - or _',
  },
  // Typed into a browser's password prompt, so any printable ASCII.
  adminPassword: {
    check: (v) =>
      typeof v === 'string' && PASSWORD_RE.test(v)
        ? null
        : 'must be 8-64 printable characters, no spaces',
  },
  weeklyNamePrefix: {
    check: (v) => (typeof v === 'string' ? null : 'must be a string ("" for no weekly fallback)'),
    default: '',
  },
  streamName: {
    check: (v) => (typeof v === 'string' ? null : 'must be a string ("" for no stream)'),
    default: '',
  },
  streamStation: {
    check: (v) =>
      typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 0xffff
        ? null
        : 'must be an integer in 1..65535',
    default: 1,
  },
  setFormat: {
    check: (v) =>
      (SET_FORMATS as readonly unknown[]).includes(v)
        ? null
        : `must be one of ${SET_FORMATS.map((f) => `"${f}"`).join(', ')}`,
    default: 'startgg',
  },
};

export type ParsedConfig =
  { ok: true; config: Config; ignored: string[] } | { ok: false; problems: string[] };

/** Validate a parsed JSON value. Every problem is listed at once. */
export function parseConfig(raw: unknown): ParsedConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: ['the settings file must hold a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(FIELDS) as [
    keyof Config,
    { check: (v: unknown) => string | null; default?: unknown },
  ][]) {
    if (!(name in obj)) {
      if (f.default === undefined) problems.push(`missing field "${name}"`);
      else out[name] = f.default;
      continue;
    }
    const problem = f.check(obj[name]);
    if (problem) problems.push(`${name} ${problem}`);
    else out[name] = obj[name];
  }
  const config = out as unknown as Config;
  if (
    typeof obj.weeklyNamePrefix === 'string' &&
    obj.weeklyNamePrefix.length > 0 &&
    typeof obj.tournament === 'string' &&
    obj.tournament.startsWith('tournament/')
  ) {
    problems.push('weeklyNamePrefix only applies to a short URL; set it to "" with a full slug');
  }
  if (typeof obj.adminPassword === 'string' && obj.adminPassword === obj.secret) {
    problems.push('adminPassword must differ from secret (the secret is on every SD card)');
  }
  if (problems.length > 0) return { ok: false, problems };
  const ignored = Object.keys(obj).filter((k) => !(k in FIELDS));
  return { ok: true, config, ignored };
}

export type LoadedConfig =
  | { kind: 'missing' }
  | { kind: 'invalid'; problems: string[] }
  | { kind: 'ok'; config: Config; ignored: string[] };

export function loadConfig(path: string): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', problems: [`cannot read ${path}: ${(e as Error).message}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { kind: 'invalid', problems: [`${path} is not valid JSON: ${(e as Error).message}`] };
  }
  const parsed = parseConfig(raw);
  return parsed.ok
    ? { kind: 'ok', config: parsed.config, ignored: parsed.ignored }
    : { kind: 'invalid', problems: parsed.problems };
}

/** Write atomically (temp file, fsync, rename), readable by the relay's user only. */
export function saveConfig(path: string, config: Config): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(config, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** A new Wii secret: 16 characters of A-Z a-z 0-9 - _ (base64url of 12 random bytes). */
export function newSecret(): string {
  return randomBytes(12).toString('base64url');
}

/** "LazyTO Weekly #160" -> "LazyTO Weekly #"; "" when the name does not end in a number. */
export function weeklyPrefixFrom(tournamentName: string): string {
  const m = /^(.*\D)\d+\s*$/.exec(tournamentName);
  return m ? m[1]! : '';
}
