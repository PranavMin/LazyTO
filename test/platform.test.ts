// The desktop app's hooks in the relay core (src/platform.ts): version
// comparison for the update check, and what the status page and setup page
// show and do with a Platform -- the laptop's notes and their one action
// behind the admin password, the update link withheld mid-set, the
// "no beamer has reached this laptop" heuristic, macOS's Local Network hint,
// the archive folder, and the setup code the app fills in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.js';
import { compareVersions, isNewer, newerRelease, type Platform } from '../src/platform.js';
import { NO_CONTACT_MS, beaconProblem, noContact, type StatusView } from '../src/status.js';
import type { BeaconStatus } from '../src/beacon.js';
import { configPath, loadConfig } from '../src/config.js';
import { startHarness, TEST_PASSWORD } from './harness.js';
import { makeFake, FIXTURE_TOKEN } from './fake-startgg.js';
import { WiiClient } from './wii-client.js';

function basic(password: string): string {
  return `Basic ${Buffer.from(`to:${password}`).toString('base64')}`;
}

/** A Platform whose answers the test sets, recording the actions it was asked to run. */
function fakePlatform(): Platform & {
  notesNow: ReturnType<Platform['notes']>;
  release: ReturnType<Platform['latest']>;
  acted: string[];
} {
  const p = {
    notesNow: [] as ReturnType<Platform['notes']>,
    release: null as ReturnType<Platform['latest']>,
    acted: [] as string[],
    notes: () => p.notesNow,
    latest: () => p.release,
    act: async (name: string) => {
      p.acted.push(name);
      return { ok: true, msg: `ran ${name}` };
    },
  };
  return p;
}

const BEACON: BeaconStatus = {
  targets: ['192.168.1.255'],
  sent: 60,
  firstSentAt: null,
  lastSentAt: null,
  lastError: null,
  lastErrorCode: null,
};

test('versions compare by semver precedence; anything else is never newer', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('v1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('0.9.0', '0.9.0-beta.1'), 1, 'a release ranks above its betas');
  assert.equal(compareVersions('0.9.0-beta.2', '0.9.0-beta.10'), -1, 'numeric identifiers');
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1, 'fewer identifiers first');
  assert.equal(
    compareVersions('1.0.0-alpha.beta', '1.0.0-alpha.1'),
    1,
    'alphanumeric above numeric',
  );
  assert.equal(compareVersions('0.9.0+3.gabc1234', '0.9.0'), 0, 'build metadata is ignored');
  assert.equal(compareVersions('dev', '1.0.0'), null);
  assert.equal(compareVersions('1.0', '1.0.0'), null);
  assert.equal(isNewer('v1.0.1', '1.0.0'), true);
  assert.equal(
    isNewer('v1.0.0', '1.0.0+5.gdeadbee'),
    false,
    'a branch build is not behind its tag',
  );
  assert.equal(isNewer('v9.9.9', 'dev'), false, 'a development build never offers an update');
});

test("GitHub's releases/latest answer becomes a Release only when newer", () => {
  const json = {
    tag_name: 'v1.2.0',
    html_url: 'https://github.com/PranavMin/LazyTO/releases/tag/v1.2.0',
  };
  assert.deepEqual(newerRelease(json, '1.1.9'), {
    version: '1.2.0',
    url: 'https://github.com/PranavMin/LazyTO/releases/tag/v1.2.0',
  });
  assert.equal(newerRelease(json, '1.2.0'), null);
  assert.equal(newerRelease({ ...json, html_url: 'https://evil.example/x' }, '1.0.0'), null);
  assert.equal(newerRelease({ message: 'API rate limit exceeded' }, '1.0.0'), null);
  assert.equal(newerRelease(null, '1.0.0'), null);
});

test('macOS EHOSTUNREACH on the beacon names the Local Network switch; other errors stay as they are', () => {
  const denied = {
    ...BEACON,
    lastError: '192.168.1.255: send EHOSTUNREACH',
    lastErrorCode: 'EHOSTUNREACH',
  };
  assert.match(
    beaconProblem(denied, 'darwin'),
    /System Settings > Privacy & Security > Local Network/,
  );
  assert.match(
    beaconProblem(denied, 'win32'),
    /discovery beacon: 192\.168\.1\.255: send EHOSTUNREACH/,
  );
  assert.match(
    beaconProblem(
      { ...BEACON, lastError: 'x: send ENETUNREACH', lastErrorCode: 'ENETUNREACH' },
      'darwin',
    ),
    /discovery beacon/,
  );
});

test('status page with the desktop app: laptop notes, their action, the update link', async (t) => {
  const platform = fakePlatform();
  const h = await startHarness({ platform });
  t.after(h.close);
  const page = async () => (await fetch(h.statusUrl)).text();

  let html = await page();
  assert.doesNotMatch(html, /is out/, 'no update known yet');
  assert.doesNotMatch(html, /\/platform\?action/);

  platform.notesNow = [
    {
      text: 'Windows Firewall blocks LazyTO on "Venue" (Public).',
      action: { name: 'firewall', label: 'Allow LazyTO through the firewall' },
    },
    { text: 'Windows Firewall blocks every incoming connection on Public networks.' },
  ];
  platform.release = {
    version: '1.4.0',
    url: 'https://github.com/PranavMin/LazyTO/releases/tag/v1.4.0',
  };
  html = await page();
  assert.match(html, /⚠ Windows Firewall blocks LazyTO on &quot;Venue&quot; \(Public\)\./);
  assert.match(
    html,
    /<form method="post" action="\/platform\?action=firewall"><button>Allow LazyTO through the firewall<\/button><\/form>/,
  );
  assert.match(html, /blocks every incoming connection on Public networks/);
  assert.match(
    html,
    /LazyTO v1\.4\.0 is out: <a href="https:\/\/github\.com\/PranavMin\/LazyTO\/releases\/tag\/v1\.4\.0" target="_blank"/,
  );

  // The action needs the admin password, then runs and reports back.
  const post = (headers: Record<string, string>) =>
    fetch(`${h.statusUrl}/platform?action=firewall`, {
      method: 'POST',
      headers,
      redirect: 'manual',
    });
  assert.equal((await post({})).status, 401);
  assert.deepEqual(platform.acted, []);
  const ok = await post({ authorization: basic(TEST_PASSWORD) });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/?done=ran+firewall');
  assert.deepEqual(platform.acted, ['firewall']);

  // A station mid-set: the release is named, its link withheld.
  const wii = h.wii(3);
  await wii.startSet(107949995);
  html = await page();
  assert.match(html, /LazyTO v1\.4\.0 is out\. Its link is here when no station is in a set/);
  assert.doesNotMatch(html, /releases\/tag\/v1\.4\.0/);
});

test('without the desktop app there is no /platform route and nothing about a laptop', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const r = await fetch(`${h.statusUrl}/platform?action=firewall`, {
    method: 'POST',
    headers: { authorization: basic(TEST_PASSWORD) },
    redirect: 'manual',
  });
  assert.equal(r.status, 404);
  assert.doesNotMatch(await (await fetch(h.statusUrl)).text(), /is out|laptop/);
});

test('"no beamer has reached this laptop": beacons out for 2 min and nothing back', async (t) => {
  const h = await startHarness({ platform: fakePlatform() });
  t.after(h.close);
  const now = Date.now();
  const view = (firstSentAt: number | null): StatusView => ({
    ...h.view,
    beacon: { status: () => ({ ...BEACON, firstSentAt }) },
  });
  assert.equal(noContact(view(null), now), false, 'no beacon (network off): nothing to say');
  assert.equal(noContact(view(now - NO_CONTACT_MS + 1000), now), false, 'not 2 minutes yet');
  assert.equal(noContact(view(now - NO_CONTACT_MS), now), true);

  // Anything that reaches the relay ends it, even a request it refuses.
  const stranger = new WiiClient(h.ev.tcp.address().port, 5, 0, '127.0.0.1', 'wrong-secret-123');
  await stranger.listSets().catch(() => undefined);
  assert.equal(noContact(view(now - NO_CONTACT_MS), now), false);
});

test('the archive folder: the app default, or the folder the settings name', async (t) => {
  const appDir = mkdtempSync(join(tmpdir(), 'lazyto-archive-app-'));
  t.after(() => rmSync(appDir, { recursive: true, force: true }));
  const h = await startHarness({ archiveDir: appDir });
  t.after(h.close);
  assert.ok(existsSync(join(appDir, '.sets')), 'the set archive lives in the app folder');
  assert.ok(!existsSync(join(h.dataDir, 'archive')), 'not in the data folder');
  assert.equal(h.app.defaultArchiveDir(), appDir);
});

test('setup in the desktop app: the code filled in, no update channel, an archive folder', async (t) => {
  const fake = makeFake();
  await fake.start();
  const dir = mkdtempSync(join(tmpdir(), 'lazyto-app-setup-'));
  const archive = join(dir, 'My Archive');
  const app = new App({
    dataDir: dir,
    httpPort: 0,
    tcpPort: 0,
    host: '127.0.0.1',
    network: false,
    startggEndpoint: fake.url,
    startggOptions: { retryDelaysMs: [0, 0] },
    clockSynced: () => true,
    retryDelaysMs: [60_000],
    platform: fakePlatform(),
    // The app's own default; the settings below name another folder.
    archiveDir: join(dir, 'default-archive'),
  });
  await app.start();
  t.after(async () => {
    await app.stop();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.web.address().port}`;
  const code = readFileSync(join(dir, 'setup-code'), 'utf8').trim();

  const step1 = await (
    await fetch(`${url}/setup?code=${code.slice(0, 4)}-${code.slice(4)}`)
  ).text();
  assert.match(step1, new RegExp(`name="code" [^>]*value="${code}"`), 'the code is filled in');

  const form = {
    step: 'save',
    code,
    token: FIXTURE_TOKEN,
    tournament: 'tournament/lazyto-test',
    slug: 'tournament/lazyto-test',
    weekly: '',
    event: 'Melee Singles! (7:30 Start)',
    stream: '',
    station: '1',
    setFormat: 'startgg',
    channel: 'release',
    archiveDir: archive,
    password: 'my-to-password',
    password2: 'my-to-password',
  };
  const stepEvent = await (
    await fetch(`${url}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        step: 'tournament',
        code,
        token: FIXTURE_TOKEN,
        link: 'https://www.start.gg/tournament/lazyto-test/details',
      }).toString(),
    })
  ).text();
  assert.match(stepEvent, /<h2>Set archives<\/h2>/);
  assert.doesNotMatch(stepEvent, /<h2>Updates<\/h2>/, 'the app checks for updates itself');
  assert.match(stepEvent, /<input type="hidden" name="channel" value="release">/);

  const saved = await fetch(`${url}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  });
  assert.equal(saved.status, 303);
  const loaded = loadConfig(configPath(dir));
  assert.equal(loaded.kind, 'ok');
  if (loaded.kind !== 'ok') return;
  assert.equal(loaded.config.archiveDir, archive);
  assert.equal(app.current().kind, 'running');
  assert.ok(existsSync(join(archive, '.sets')), "tonight's archive is in the chosen folder");

  // A relative folder is refused with the reason.
  const bad = await fetch(`${url}/setup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basic('my-to-password'),
    },
    body: new URLSearchParams({
      ...form,
      code: '',
      token: '',
      password: '',
      password2: '',
      archiveDir: 'relative',
    }).toString(),
  });
  assert.equal(bad.status, 400);
  assert.match(
    await bad.text(),
    /archiveDir must be &quot;&quot; \(the default folder\) or a full path/,
  );
});
