// config.ts -- load and validate /etc/lazyto/config.json
// (architecture.md Relay). Every field is required, every field is checked,
// there are no defaults; any problem is a ConfigError listing everything
// wrong so one restart fixes it all. main.ts turns that into a non-zero exit.
//
// The event and stream are named, not numbered: tournament is the start.gg
// short URL (e.g. "mybar") or, for an unpublished tournament, its full slug;
// eventName and streamName pick from it by name; resolve.ts turns them into
// ids at startup, because the ids change every week and the names do not.
// weeklyNamePrefix ("" for none) lets a numbered weekly series be found by
// name when the short URL has not been moved yet (resolve.ts).
//
// Two fields beyond the design's example: auditDir, the directory the audit
// log <eventId>.jsonl is written to (section 10 hardcodes a Linux path; a
// hardcoded path is a hidden default, so it lives in the config instead),
// and startggEndpoint, the GraphQL URL -- https://api.start.gg/gql/alpha in
// production, the in-process fake (test/fake-startgg.ts) when the built
// relay is exercised on a dev machine. Same reasoning: explicit, not hidden.

import { readFileSync } from 'node:fs';
import { SET_FORMATS, type SetFormat } from './format.js';

export interface Config {
  startggEndpoint: string; // GraphQL URL, http(s)
  token: string;
  tournament: string; // start.gg short URL (e.g. "mybar") or full slug ("tournament/<slug>")
  eventName: string; // e.g. "Melee Singles"
  streamName: string; // the stream's name in the tournament's stream settings
  weeklyNamePrefix: string; // "" = no weekly fallback; else e.g. "My Bar Weekly #"
  secret: string; // shared with every station's relay_auth (decisions.md R16)
  adminPassword: string; // the TO's password for the status page's actions (admin.ts); never the secret
  streamStation: number; // station number (u16 on the wire) of the stream Wii
  setFormat: SetFormat; // "startgg": each set's best-of as start.gg has it; "top8q": Bo3, Bo5 from the top-8 qualifiers (format.ts)
  tcpPort: number;
  httpPort: number;
  auditDir: string;
}

const FIELDS = [
  'startggEndpoint',
  'token',
  'tournament',
  'eventName',
  'streamName',
  'weeklyNamePrefix',
  'secret',
  'adminPassword',
  'streamStation',
  'setFormat',
  'tcpPort',
  'httpPort',
  'auditDir',
] as const;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid config:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const { protocol } = new URL(v);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError([`cannot read ${path}: ${(e as Error).message}`]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError([`${path} is not valid JSON: ${(e as Error).message}`]);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError([`${path} must be a JSON object`]);
  }
  const obj = raw as Record<string, unknown>;

  const problems: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      problems.push(`unknown field "${key}"`);
    }
  }
  for (const key of FIELDS) {
    if (!(key in obj)) problems.push(`missing field "${key}"`);
  }

  const {
    startggEndpoint,
    token,
    tournament,
    eventName,
    streamName,
    weeklyNamePrefix,
    secret,
    adminPassword,
    streamStation,
    setFormat,
    tcpPort,
    httpPort,
    auditDir,
  } = obj;

  if ('startggEndpoint' in obj && !isHttpUrl(startggEndpoint)) {
    problems.push('startggEndpoint must be an http(s) URL');
  }
  if ('token' in obj && (typeof token !== 'string' || token.length === 0)) {
    problems.push('token must be a non-empty string');
  }
  if (
    'tournament' in obj &&
    (typeof tournament !== 'string' || !/^(tournament\/)?[A-Za-z0-9-]+$/.test(tournament))
  ) {
    problems.push(
      'tournament must be a start.gg short URL (e.g. "mybar") or full slug ("tournament/<slug>")',
    );
  }
  if ('weeklyNamePrefix' in obj && typeof weeklyNamePrefix !== 'string') {
    problems.push('weeklyNamePrefix must be a string ("" for no weekly fallback)');
  }
  if (
    typeof weeklyNamePrefix === 'string' &&
    weeklyNamePrefix.length > 0 &&
    typeof tournament === 'string' &&
    tournament.startsWith('tournament/')
  ) {
    problems.push('weeklyNamePrefix only applies to a short URL; set it to "" with a full slug');
  }
  for (const [name, v] of [
    ['eventName', eventName],
    ['streamName', streamName],
  ] as const) {
    if (name in obj && (typeof v !== 'string' || v.trim().length === 0)) {
      problems.push(`${name} must be a non-empty string`);
    }
  }
  // Letters, digits, - and _ only: it is typed onto every SD card as
  // secret=<value> and must survive the kernel's key=value parser. 8 to
  // SECRET_LEN (16) characters.
  if ('secret' in obj && (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{8,16}$/.test(secret))) {
    problems.push('secret must be 8-16 letters, digits, - or _');
  }
  // Typed into a browser's password prompt, so any printable ASCII; never the
  // secret, which is printed on every SD card.
  if (
    'adminPassword' in obj &&
    (typeof adminPassword !== 'string' || !/^[\x21-\x7e]{8,64}$/.test(adminPassword))
  ) {
    problems.push('adminPassword must be 8-64 printable characters, no spaces');
  }
  if (typeof adminPassword === 'string' && adminPassword === secret) {
    problems.push('adminPassword must differ from secret (the secret is on every SD card)');
  }
  if ('streamStation' in obj && (!isPositiveInt(streamStation) || streamStation > 0xffff)) {
    problems.push('streamStation must be an integer in 1..65535');
  }
  if ('setFormat' in obj && !(SET_FORMATS as readonly unknown[]).includes(setFormat)) {
    problems.push(`setFormat must be one of ${SET_FORMATS.map((f) => `"${f}"`).join(', ')}`);
  }
  for (const [name, v] of [
    ['tcpPort', tcpPort],
    ['httpPort', httpPort],
  ] as const) {
    if (name in obj && (!isPositiveInt(v) || v > 65535)) {
      problems.push(`${name} must be an integer in 1..65535`);
    }
  }
  if (isPositiveInt(tcpPort) && tcpPort === httpPort) {
    problems.push('tcpPort and httpPort must differ');
  }
  if ('auditDir' in obj && (typeof auditDir !== 'string' || auditDir.length === 0)) {
    problems.push('auditDir must be a non-empty string');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    startggEndpoint: startggEndpoint as string,
    token: token as string,
    tournament: tournament as string,
    eventName: eventName as string,
    streamName: streamName as string,
    weeklyNamePrefix: weeklyNamePrefix as string,
    secret: secret as string,
    adminPassword: adminPassword as string,
    streamStation: streamStation as number,
    setFormat: setFormat as SetFormat,
    tcpPort: tcpPort as number,
    httpPort: httpPort as number,
    auditDir: auditDir as string,
  };
}
