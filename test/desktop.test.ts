// The desktop app's own logic (desktop/), the parts that need no Electron:
// which bytes of a firmware image the flasher writes (NVS never), a beamer's
// config.txt, the firmware check, Windows Firewall's verdict, and the crash
// backoff. The Electron shell itself is checked by desktop/scripts/smoke.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flashPlan, readPartitionTable } from '../desktop/flash-layout.js';
import { lazytoValues, setConfigValues, wifiProblem } from '../desktop/beamer-config.js';
import { loadFirmware, provisionDrive } from '../desktop/beamer-files.js';
import {
  FIREWALL_ACTION,
  firewallNotes,
  fixScript,
  elevate,
  type FirewallProbe,
} from '../desktop/firewall.js';
import { CRASH_RESET_MS, nextRestart, parseCrashRecord, restartDelayMs } from '../desktop/crash.js';

/** A merged image like the fork's: bootloader at 0, the table at 0x8000, the app at 0x10000, 0xFF between. */
function mergedImage(opts: { appBytes?: number; nvsData?: boolean } = {}): Uint8Array {
  const appBytes = opts.appBytes ?? 0x2000;
  const img = new Uint8Array(0x10000 + appBytes).fill(0xff);
  const view = new DataView(img.buffer);
  img[0] = 0xe9;
  for (let i = 1; i < 0x5000; i++) img[i] = i & 0x7f;
  const entry = (
    i: number,
    type: number,
    sub: number,
    offset: number,
    size: number,
    label: string,
  ) => {
    const at = 0x8000 + i * 32;
    view.setUint16(at, 0x50aa, true);
    img[at + 2] = type;
    img[at + 3] = sub;
    view.setUint32(at + 4, offset, true);
    view.setUint32(at + 8, size, true);
    img.fill(0, at + 12, at + 32);
    for (let j = 0; j < label.length; j++) img[at + 12 + j] = label.charCodeAt(j);
  };
  // partitions.csv of PranavMin/slippi-beamer
  entry(0, 1, 2, 0x9000, 0x6000, 'nvs');
  entry(1, 1, 1, 0xf000, 0x1000, 'phy_init');
  entry(2, 0, 0, 0x10000, 0x400000, 'factory');
  entry(3, 1, 3, 0x410000, 0x10000, 'coredump');
  entry(4, 1, 2, 0x420000, 0x10000, 'jrnl');
  img[0x10000] = 0xe9;
  for (let i = 0x10001; i < img.length; i++) img[i] = (i * 7) & 0xff;
  if (opts.nvsData) img[0x9010] = 0x42;
  return img;
}

test('the flasher writes the bootloader, table and app, and leaves every NVS partition alone', () => {
  const img = mergedImage();
  assert.deepEqual(
    readPartitionTable(img).map((p) => `${p.label}@${p.offset.toString(16)}`),
    ['nvs@9000', 'phy_init@f000', 'factory@10000', 'coredump@410000', 'jrnl@420000'],
  );
  const plan = flashPlan(img);
  assert.deepEqual(
    plan.segments.map((s) => [s.address, s.data.length]),
    [
      [0, 0x9000],
      [0x10000, 0x2000],
    ],
  );
  assert.equal(plan.segments[1]!.data[0], 0xe9);
  assert.deepEqual(
    plan.kept.map((p) => p.label),
    ['nvs', 'phy_init', 'coredump', 'jrnl'],
  );
  for (const s of plan.segments) {
    assert.ok(
      s.address + s.data.length <= 0x9000 || s.address >= 0x10000,
      'nothing lands on 0x9000-0xFFFF',
    );
  }
});

test('the flasher refuses images it cannot write safely', () => {
  assert.throws(() => flashPlan(new Uint8Array(0x9000)), /not an ESP32 firmware image/);
  const noTable = mergedImage();
  noTable.fill(0xff, 0x8000, 0x9000);
  assert.throws(() => flashPlan(noTable), /no partition table/);
  const damaged = mergedImage();
  damaged[0x8020] = 0x12;
  assert.throws(() => flashPlan(damaged), /entry 1 is damaged/);
  assert.throws(
    () => flashPlan(mergedImage({ nvsData: true })),
    /data at 0x9010 \(partition "nvs"\)/,
  );
});

test("config.txt: LazyTO's four keys set, everything else kept", () => {
  const before = [
    '# The beamer template',
    'SSID=',
    'PASSWORD=',
    'COUNTRY=US',
    'replay_cap = 512',
    'lazyto=false',
    'LAZYTO=no',
    '',
  ].join('\r\n');
  const after = setConfigValues(
    before,
    lazytoValues('Venue Wi-Fi', ' pass word ', 'abcd-EFGH_1234xy'),
  );
  assert.equal(
    after,
    [
      '# The beamer template',
      'SSID=Venue Wi-Fi',
      'PASSWORD=" pass word "',
      'COUNTRY=US',
      'replay_cap = 512',
      'LAZYTO=true',
      'LAZYTO-SECRET=abcd-EFGH_1234xy',
      '',
    ].join('\r\n'),
    'CRLF kept, duplicate LAZYTO lines collapsed, the secret appended, spaces quoted',
  );
  assert.equal(
    setConfigValues('ssid=old\nLAZYTO_SECRET=old\n', { SSID: "'q'", 'LAZYTO-SECRET': 'new' }),
    `SSID="'q'"\nLAZYTO-SECRET=new\n`,
    '"-" and "_" are the same key; a quoted value is quoted again',
  );
});

test('Wi-Fi settings a beamer can use', () => {
  assert.equal(wifiProblem('Venue', ''), null, 'an open network');
  assert.equal(wifiProblem('Venue', '12345678'), null);
  assert.match(wifiProblem('', 'x')!, /network name/);
  assert.match(wifiProblem('x'.repeat(33), '')!, /32 bytes/);
  assert.match(wifiProblem('Venue', 'short')!, /8-63 characters/);
  assert.match(wifiProblem('Venue', 'a\nb'.padEnd(10, 'c'))!, /one line/);
});

test("a beamer's drive gets the keys; a folder that is not one is refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), 'lazyto-drive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const refused = provisionDrive(root, 'Venue', '12345678', 'abcd-EFGH_1234xy');
  assert.equal(refused.ok, false);
  assert.match(refused.msg, /not a beamer's drive: it has no CONFIG\/config\.txt/);

  mkdirSync(join(root, 'CONFIG'));
  writeFileSync(join(root, 'CONFIG', 'config.txt'), 'SSID=\nPASSWORD=\nDEBUG=false\n');
  const ok = provisionDrive(root, 'Venue', '12345678', 'abcd-EFGH_1234xy');
  assert.equal(ok.ok, true);
  assert.equal(
    readFileSync(join(root, 'CONFIG', 'config.txt'), 'utf8'),
    'SSID=Venue\nPASSWORD=12345678\nDEBUG=false\nLAZYTO=true\nLAZYTO-SECRET=abcd-EFGH_1234xy\n',
  );
});

test('the firmware is handed over only when it matches its SHA-256', (t) => {
  const res = mkdtempSync(join(tmpdir(), 'lazyto-res-'));
  t.after(() => rmSync(res, { recursive: true, force: true }));
  assert.deepEqual(loadFirmware(res), {
    ok: false,
    reason: 'This build of LazyTO carries no beamer firmware.',
  });
  const dir = join(res, 'firmware');
  mkdirSync(dir);
  const img = mergedImage();
  const sha = createHash('sha256').update(img).digest('hex');
  writeFileSync(join(dir, 'beamer.bin'), img);
  writeFileSync(join(dir, 'beamer.bin.sha256'), `${sha}  beamer.bin\n`);
  writeFileSync(join(dir, 'VERSION'), 'lazyto-fw-3\n');
  const fw = loadFirmware(res);
  assert.ok(fw.ok);
  assert.equal(fw.sha256, sha);
  assert.equal(fw.version, 'lazyto-fw-3');
  assert.deepEqual(fw.bytes, img);
  writeFileSync(join(dir, 'beamer.bin.sha256'), `${'0'.repeat(64)}  beamer.bin\n`);
  const bad = loadFirmware(res);
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.reason : '', /does not match its SHA-256/);
});

const PROFILES: FirewallProbe['profiles'] = ['Domain', 'Private', 'Public'].map((Name) => ({
  Name,
  Enabled: 'True',
  DefaultInboundAction: 'NotConfigured',
  AllowInboundRules: 'True',
}));
const VENUE = [{ Name: 'Venue', Category: 'Public' }];
const rule = (Action: string, Profile: string) => ({
  Enabled: 'True',
  Direction: 'Inbound',
  Action,
  Profile,
});

test('Windows Firewall: what blocks the beamers, and what does not', () => {
  // Allowed on Public: nothing to say.
  assert.deepEqual(
    firewallNotes({ networks: VENUE, profiles: PROFILES, rules: [rule('Allow', 'Public')] }),
    [],
  );
  assert.deepEqual(
    firewallNotes({ networks: VENUE, profiles: PROFILES, rules: [rule('Allow', 'Any')] }),
    [],
  );

  // Allowed on Private only, the venue's network is Public: blocked, with the fix.
  const privateOnly = firewallNotes({
    networks: VENUE,
    profiles: PROFILES,
    rules: [rule('Allow', 'Private')],
  });
  assert.equal(privateOnly.length, 1);
  assert.match(privateOnly[0]!.text, /blocks LazyTO on "Venue" \(Public\)/);
  assert.deepEqual(privateOnly[0]!.action, {
    name: FIREWALL_ACTION,
    label: 'Allow LazyTO through the firewall',
  });

  // Cancel on the prompt: Block rules win over any Allow.
  assert.equal(
    firewallNotes({
      networks: VENUE,
      profiles: PROFILES,
      rules: [rule('Allow', 'Public'), rule('Block', 'Private, Public')],
    }).length,
    1,
  );
  // No rule at all, default inbound Block: blocked. A disabled rule counts for nothing.
  assert.equal(firewallNotes({ networks: VENUE, profiles: PROFILES, rules: [] }).length, 1);
  assert.equal(
    firewallNotes({
      networks: VENUE,
      profiles: PROFILES,
      rules: [{ ...rule('Allow', 'Public'), Enabled: 'False' }],
    }).length,
    1,
  );
  // The firewall off for that profile: nothing to say.
  const off = PROFILES.map((p) => (p.Name === 'Public' ? { ...p, Enabled: 'False' } : p));
  assert.deepEqual(firewallNotes({ networks: VENUE, profiles: off, rules: [] }), []);
  // "Block all incoming connections": no rule helps, so no button.
  const shields = PROFILES.map((p) =>
    p.Name === 'Public' ? { ...p, AllowInboundRules: 'False' } : p,
  );
  const notes = firewallNotes({
    networks: VENUE,
    profiles: shields,
    rules: [rule('Allow', 'Any')],
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.text, /blocks every incoming connection on "Venue" \(Public\)/);
  assert.equal(notes[0]!.action, undefined);
  // A domain network maps to the Domain profile.
  assert.deepEqual(
    firewallNotes({
      networks: [{ Name: 'corp', Category: 'DomainAuthenticated' }],
      profiles: PROFILES,
      rules: [rule('Allow', 'Domain')],
    }),
    [],
  );
});

test('the firewall fix: one elevated PowerShell, the path quoted inside it, the rules as specified', () => {
  const script = fixScript("C:\\Users\\O'Brien\\AppData\\Local\\Programs\\LazyTO\\LazyTO.exe");
  assert.match(
    script,
    /\$exe = 'C:\\Users\\O''Brien\\AppData\\Local\\Programs\\LazyTO\\LazyTO\.exe'/,
  );
  assert.match(script, /-Profile Any -RemoteAddress LocalSubnet/);
  assert.match(script, /foreach \(\$protocol in 'TCP', 'UDP'\)/);
  const outer = elevate(script);
  assert.match(outer, /^\$p = Start-Process -FilePath powershell\.exe -Verb RunAs /);
  const encoded = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)![1]!;
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script);
});

test("crash backoff: the systemd unit's 10 s to 2 min over 5 steps, reset after a quiet 10 min", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map(restartDelayMs),
    [10_000, 16_438, 27_019, 44_413, 73_004, 120_000, 120_000],
  );
  let r = nextRestart(null, 1000);
  assert.deepEqual(r, { record: { count: 1, at: 1000 }, delayMs: 10_000 });
  r = nextRestart(r.record, 30_000);
  assert.deepEqual(r, { record: { count: 2, at: 30_000 }, delayMs: 16_438 });
  r = nextRestart(r.record, 30_000 + CRASH_RESET_MS);
  assert.deepEqual(r, { record: { count: 1, at: 30_000 + CRASH_RESET_MS }, delayMs: 10_000 });
  assert.deepEqual(parseCrashRecord('{"count":3,"at":5}'), { count: 3, at: 5 });
  assert.equal(parseCrashRecord('{"count":"x"}'), null);
  assert.equal(parseCrashRecord('not json'), null);
});
