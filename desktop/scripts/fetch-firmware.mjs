// fetch-firmware.mjs -- puts the pinned beamer firmware into
// resources/firmware before CI packages the app (release.yml): the merged
// image from a PranavMin/slippi-beamer release, checked against its pinned
// SHA-256, as beamer.bin, beamer.bin.sha256 and VERSION (beamer-files.ts
// checks the hash again before flashing). The pin is three environment
// variables release.yml sets; with no URL pinned the build carries no
// firmware, and the Beamers window says so.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const {
  BEAMER_FIRMWARE_URL: url,
  BEAMER_FIRMWARE_SHA256: sha,
  BEAMER_FIRMWARE_VERSION: version,
} = process.env;
const dir = join(import.meta.dirname, '..', 'resources', 'firmware');

if (!url) {
  console.log('no beamer firmware pinned: this build carries none');
} else {
  if (!/^[0-9a-f]{64}$/.test(sha ?? '') || !version) {
    throw new Error('BEAMER_FIRMWARE_SHA256 and BEAMER_FIRMWARE_VERSION must be set with the URL');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha) throw new Error(`${url}: SHA-256 ${got}, pinned ${sha}`);
  writeFileSync(join(dir, 'beamer.bin'), bytes);
  writeFileSync(join(dir, 'beamer.bin.sha256'), `${sha}  beamer.bin\n`);
  writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  console.log(`beamer firmware ${version}: ${bytes.length} bytes, SHA-256 ${sha}`);
}
