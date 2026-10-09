// cards.ts: the SD-card zips. The zip is read back with a reader written here
// against the format (and Node's own crc32), the loader settings are checked
// field by field against NIN_CFG, and the pages over HTTP behind the password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as nodeCrc32, inflateRawSync } from 'node:zlib';
import {
  NIN_CFG_AUTO_BOOT,
  NIN_CFG_MAGIC,
  NIN_CFG_NETWORK,
  NIN_CFG_SIZE,
  NIN_CFG_SLIPPI_REPLAYS,
  LOADER_SETTINGS_FILE,
  loaderSettings,
  cardZip,
} from '../src/cards.js';
import { buildZip, crc32 } from '../src/zip.js';
import { startHarness, TEST_PASSWORD } from './harness.js';
import { TEST_SECRET } from './wii-client.js';

/** Every entry of a zip: checks each local header against the central directory, inflates, checks the CRC. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0 && eocd === buf.length - 22, 'end of central directory, no comment');
  const count = buf.readUInt16LE(eocd + 10);
  assert.equal(buf.readUInt16LE(eocd + 8), count);
  let p = buf.readUInt32LE(eocd + 16);
  assert.equal(p + buf.readUInt32LE(eocd + 12), eocd, 'central directory ends at the end record');
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory header');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `local header of ${name}`);
    assert.equal(buf.readUInt32LE(local + 14), crc, `local CRC of ${name}`);
    assert.equal(buf.readUInt32LE(local + 18), packed);
    assert.equal(buf.readUInt32LE(local + 22), size);
    assert.equal(method, 8, 'deflated');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(start, start + packed));
    assert.equal(data.length, size, `size of ${name}`);
    assert.equal(nodeCrc32(data), crc, `CRC of ${name}`);
    out.set(name, data);
    p += 46 + nameLen + skip;
  }
  return out;
}

function wiiDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lazyto-wii-'));
  mkdirSync(join(d, 'apps', 'LazyTO'), { recursive: true });
  writeFileSync(join(d, 'apps', 'LazyTO', 'boot.dol'), Buffer.alloc(70_000, 7));
  writeFileSync(join(d, 'apps', 'LazyTO', 'icon.png'), 'png');
  writeFileSync(join(d, 'apps', 'LazyTO', 'meta.xml'), '<app/>');
  writeFileSync(join(d, 'lazyto_kiosk.bin'), 'TMOD module');
  return d;
}

function basic(password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`to:${password}`).toString('base64')}` };
}

test('crc32 matches the standard check value and Node', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const b = Buffer.from('LazyTO');
  assert.equal(crc32(b), nodeCrc32(b));
});

test('buildZip round-trips names, empty files and binary data', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir/empty', data: Buffer.alloc(0) },
    { name: 'dir/bin', data: Buffer.from([0, 255, 1, 254]) },
  ];
  const files = unzip(buildZip(entries));
  assert.deepEqual([...files.keys()], ['a.txt', 'dir/empty', 'dir/bin']);
  for (const e of entries) assert.deepEqual(files.get(e.name), e.data);
});

test('loaderSettings is the NIN_CFG the loader saves: version 0xE, Slippi replays, Auto Boot, Network off, the game on SD, UCF, Gameplay Both', () => {
  const b = loaderSettings();
  assert.equal(b.length, NIN_CFG_SIZE);
  assert.equal(b.readUInt32BE(0x00), NIN_CFG_MAGIC);
  assert.equal(b.readUInt32BE(0x04), 0xe, 'the version the loader writes itself');
  assert.equal(b.readUInt32BE(0x08), NIN_CFG_SLIPPI_REPLAYS | NIN_CFG_AUTO_BOOT, 'Log off');
  assert.equal(
    b.readUInt32BE(0x08) & NIN_CFG_NETWORK,
    0,
    'Network off: LazyTO never uses the Wii network',
  );
  assert.equal(b.readUInt32BE(0x0c), 0, 'video: auto');
  assert.equal(b.readUInt32BE(0x10), 0xffffffff, 'language: auto');
  assert.equal(
    b
      .subarray(0x14, 0x14 + 255)
      .toString('ascii')
      .replace(/\0+$/, ''),
    '/games/GALE01/game.iso',
  );
  assert.equal(b.subarray(0x114, 0x118).toString('ascii'), 'GALE');
  assert.equal(b[0x118], 2, 'memory card: 251 blocks');
  assert.equal(b.readUInt32BE(0x11c), 0, 'UseUSB 0: the game on SD, so USB is the beamer');
  const codes = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => b.readUInt32BE(0x120 + 4 * i));
  assert.deepEqual(
    codes,
    [2, 1, 2, 1, 1, 4, 1, 1],
    'Melee codes at their defaults (UCF on) except Gameplay: Both (LGL and anti-wobbling)',
  );
  assert.equal(b.readUInt32BE(0x140), 0);
});

test('one zip for every Wii: the loader, the module, the loader settings, the READMEs; no station file, no secret', () => {
  const dir = wiiDir();
  const zip = cardZip({ wiiDir: dir, version: 'v1.2.3' });
  const files = unzip(zip);
  assert.deepEqual([...files.keys()].sort(), [
    'README.txt',
    'apps/LazyTO/boot.dol',
    'apps/LazyTO/icon.png',
    'apps/LazyTO/meta.xml',
    'games/GALE01/README.txt',
    'lazyto_kiosk.bin',
    'lazyto_nincfg.bin',
  ]);
  assert.deepEqual(files.get('apps/LazyTO/boot.dol'), Buffer.alloc(70_000, 7));
  assert.equal(files.get('lazyto_kiosk.bin')!.toString(), 'TMOD module');
  assert.deepEqual(files.get(LOADER_SETTINGS_FILE), loaderSettings());
  const readme = files.get('README.txt')!.toString();
  assert.match(readme, /Every Wii gets the same card/);
  assert.match(readme, /LazyTO v1\.2\.3 relay/);
  assert.doesNotMatch(readme, /lazyto_station\.txt/);
  assert.equal(
    zip.includes(Buffer.from(TEST_SECRET)),
    false,
    'the secret is on the beamer, never the card',
  );
  assert.deepEqual(cardZip({ wiiDir: dir, version: 'v1.2.3' }), zip, 'identical every time');
});

test('/cards and its zip need the admin password; the zip is the same for every Wii', async (t) => {
  const h = await startHarness({ wiiDir: wiiDir() });
  t.after(h.close);
  const auth = basic(TEST_PASSWORD);

  assert.equal((await fetch(`${h.statusUrl}/cards`)).status, 401);
  assert.equal((await fetch(`${h.statusUrl}/cards/zip`)).status, 401);
  const pageHtml = await (await fetch(`${h.statusUrl}/cards`, { headers: auth })).text();
  assert.match(pageHtml, /One zip for every Wii/);
  assert.match(pageHtml, /href="\/cards\/zip"/);
  assert.doesNotMatch(pageHtml, /Station number/);
  assert.match(await (await fetch(h.statusUrl)).text(), /<a href="\/cards">SD cards<\/a>/);

  const r = await fetch(`${h.statusUrl}/cards/zip`, { headers: auth });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition') ?? '', /filename="lazyto-sd-card\.zip"/);
  const files = unzip(Buffer.from(await r.arrayBuffer()));
  assert.equal(files.has('lazyto_station.txt'), false);
  assert.deepEqual(files.get(LOADER_SETTINGS_FILE), loaderSettings());
});

test('a relay without Wii files says so instead of serving a broken zip', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const auth = basic(TEST_PASSWORD);
  assert.match(
    await (await fetch(`${h.statusUrl}/cards`, { headers: auth })).text(),
    /This relay has no Wii files/,
  );
  assert.equal((await fetch(`${h.statusUrl}/cards/zip`, { headers: auth })).status, 503);
});
