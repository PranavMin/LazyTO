// config.ts -- load and validate /etc/tournament-reporter/config.json
// (design.md section 6.3). Every field is required, every field is checked,
// there are no defaults; any problem is a ConfigError listing everything
// wrong so one restart fixes it all. main.ts turns that into a non-zero exit.
//
// Two fields beyond the design's example: auditDir, the directory the audit
// log <eventId>.jsonl is written to (section 10 hardcodes a Linux path; a
// hardcoded path is a hidden default, so it lives in the config instead),
// and startggEndpoint, the GraphQL URL -- https://api.start.gg/gql/alpha in
// production, the in-process fake (test/fake-startgg.ts) when the built
// relay is exercised on a dev machine. Same reasoning: explicit, not hidden.

import { readFileSync } from 'node:fs';

export interface Config {
  startggEndpoint: string; // GraphQL URL, http(s)
  token: string;
  eventId: number;
  streamId: number;
  streamStation: number; // station number (u16 on the wire) of the stream Wii
  tcpPort: number;
  httpPort: number;
  auditDir: string;
}

const FIELDS = [
  'startggEndpoint',
  'token',
  'eventId',
  'streamId',
  'streamStation',
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

  const { startggEndpoint, token, eventId, streamId, streamStation, tcpPort, httpPort, auditDir } = obj;

  if ('startggEndpoint' in obj && !isHttpUrl(startggEndpoint)) {
    problems.push('startggEndpoint must be an http(s) URL');
  }
  if ('token' in obj && (typeof token !== 'string' || token.length === 0)) {
    problems.push('token must be a non-empty string');
  }
  if ('eventId' in obj && !isPositiveInt(eventId)) {
    problems.push('eventId must be a positive integer');
  }
  if ('streamId' in obj && !isPositiveInt(streamId)) {
    problems.push('streamId must be a positive integer');
  }
  if ('streamStation' in obj && (!isPositiveInt(streamStation) || streamStation > 0xffff)) {
    problems.push('streamStation must be an integer in 1..65535');
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
    eventId: eventId as number,
    streamId: streamId as number,
    streamStation: streamStation as number,
    tcpPort: tcpPort as number,
    httpPort: httpPort as number,
    auditDir: auditDir as string,
  };
}
