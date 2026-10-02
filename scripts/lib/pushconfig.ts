// What push.ts sends to the Pi: config.json from .env (the only place event
// values live, docs/pi-setup.md "Describe your event") and the relay bundle.
// Everything here is pure or works on a directory you pass, so it is tested
// without ssh.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SET_FORMATS, type SetFormat } from '../../src/format.js';
import type { Config } from '../../src/config.js';
import { fail } from './cli.js';
import { SECRET_RE } from './tcfg.js';

/** The relay's settings file (src/config.ts), written from .env. */
export type RelayConfig = Config;

export interface PushOptions {
  test: boolean;
}

/** Same field set and same checks as the relay's loadConfig expects (test/config.test.ts pins the field list). */
export function relayConfigFromEnv(env: Record<string, string>, opts: PushOptions): RelayConfig {
  if (!env.STARTGG_TOKEN) fail('STARTGG_TOKEN missing from .env');
  // The relay's shared secret (decisions.md R16): the same value is secret= on every
  // Wii's SD card and SlippiRelaySecret in Dolphin.
  if (!SECRET_RE.test(env.RELAY_SECRET ?? ''))
    fail(
      'RELAY_SECRET in .env must be 8-16 letters, digits, - or _ (it goes on every SD card as secret=)',
    );
  const need = (key: string): string => {
    if (!env[key]) fail(`${key} missing from .env (see .env.example)`);
    return env[key];
  };
  // The TO's password for the status page's actions (src/admin.ts).
  const adminPassword = need('ADMIN_PASSWORD');
  if (!/^[!-~]{8,64}$/.test(adminPassword))
    fail('ADMIN_PASSWORD in .env must be 8-64 printable characters, no spaces');
  if (adminPassword === env.RELAY_SECRET)
    fail('ADMIN_PASSWORD in .env must differ from RELAY_SECRET (the secret is on every SD card)');
  const eventName = need('EVENT_NAME');
  const streamName = env.STREAM_NAME ?? ''; // "" = no stream
  const streamStation = env.STREAM_STATION ? Number.parseInt(env.STREAM_STATION, 10) : 1;
  if (!Number.isInteger(streamStation) || streamStation < 1)
    fail(`STREAM_STATION in .env must be a station number, not '${env.STREAM_STATION}'`);
  const setFormat = (env.SET_FORMAT || 'startgg') as SetFormat;
  if (!SET_FORMATS.includes(setFormat))
    fail(`SET_FORMAT in .env must be ${SET_FORMATS.join(' or ')}, not '${setFormat}'`);
  let tournament: string;
  let weeklyNamePrefix: string;
  if (opts.test) {
    tournament = need('TEST_TOURNAMENT');
    if (!tournament.startsWith('tournament/'))
      fail('TEST_TOURNAMENT must be a full slug, tournament/<slug>');
    weeklyNamePrefix = '';
  } else {
    tournament = need('TOURNAMENT');
    weeklyNamePrefix = tournament.startsWith('tournament/') ? '' : (env.WEEKLY_NAME_PREFIX ?? '');
  }
  return {
    token: env.STARTGG_TOKEN,
    tournament,
    eventName,
    streamName,
    weeklyNamePrefix,
    secret: env.RELAY_SECRET,
    adminPassword,
    streamStation,
    setFormat,
  };
}

/** The summary line push prints (token shown as its first 4 characters only). */
export function describeRelayConfig(c: RelayConfig, opts: PushOptions): string {
  return `config: ${c.tournament} (${opts.test ? 'TEST' : 'production'}), event ~ '${c.eventName}', ${c.streamName ? `stream '${c.streamName}' on station ${c.streamStation}` : 'no stream'}, format ${c.setFormat}, token ${c.token.slice(0, 4)}...`;
}

/** dist/, deploy/, package.json ("type": "module", needed beside dist/), README.md and config.json into stageDir (recreated). */
export function stageBundle(repoRoot: string, stageDir: string, config: RelayConfig): void {
  if (!existsSync(join(repoRoot, 'dist', 'main.js'))) fail('build produced no dist/main.js');
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  cpSync(join(repoRoot, 'dist'), join(stageDir, 'dist'), { recursive: true });
  cpSync(join(repoRoot, 'deploy'), join(stageDir, 'deploy'), {
    recursive: true,
    filter: (src) => !/[\\/]\.cache([\\/]|$)/.test(src),
  });
  cpSync(join(repoRoot, 'package.json'), join(stageDir, 'package.json'));
  if (existsSync(join(repoRoot, 'README.md')))
    cpSync(join(repoRoot, 'README.md'), join(stageDir, 'README.md'));
  writeFileSync(join(stageDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
  });
}

/** The command install.sh runs on the Pi, plus the auto-update marker (docs/pi-setup.md "Updates"). */
export function remoteInstallCommand(noAutoUpdate: boolean): string {
  const marker = noAutoUpdate
    ? 'sudo touch /etc/lazyto/no-auto-update'
    : 'sudo rm -f /etc/lazyto/no-auto-update';
  return (
    'rm -rf /tmp/tr && mkdir -p /tmp/tr && tar -xzf /tmp/lazyto.tgz -C /tmp/tr ' +
    `&& sudo bash /tmp/tr/deploy/install.sh /tmp/tr && ${marker} && rm -rf /tmp/tr /tmp/lazyto.tgz`
  );
}
