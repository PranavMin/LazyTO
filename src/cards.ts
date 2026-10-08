// cards.ts -- one zip per station with everything its SD card needs, so the
// TO's whole card setup is: unzip onto a FAT32 card, add the Melee image
// (docs/wii-setup.md). Behind the admin password, because lazyto_station.txt
// carries the Wii secret: /cards is the page, /cards/zip?station=N the zip.
//
// From the bundle's wii/ folder (release.yml), the same build as this relay:
//   apps/LazyTO/        the loader
//   lazyto_kiosk.bin    the kiosk module
// Made here:
//   lazyto_station.txt  station= and secret=
//   lazyto_nincfg.bin   the loader's own settings, fresh: Network and Auto Boot
//                       on, the game at games/GALE01/game.iso, Melee's codes at
//                       their defaults (UCF on) plus Gameplay: Both (LGL and
//                       anti-wobbling). A venue's Slippi Nintendont keeps its
//                       own slippi_nincfg.bin; neither reads the other's.
//   README.txt and games/GALE01/README.txt

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Config } from './config.js';
import { escapeHtml, page, requirePassword, sendHtml, sendText } from './web.js';
import { buildZip, type ZipEntry } from './zip.js';

// The loader's settings file: NIN_CFG and NIN_CFG_FILE in Nintendont
// common/include/CommonConfig.h.
export const LOADER_SETTINGS_FILE = 'lazyto_nincfg.bin';
export const NIN_CFG_MAGIC = 0x01070cf6;
export const NIN_CFG_LOG = 1 << 8;
export const NIN_CFG_AUTO_BOOT = 1 << 10;
export const NIN_CFG_NETWORK = 1 << 13;
export const NIN_CFG_SIZE = 324;
// NIN_CFG_VERSION: the version the loader writes itself.
const NIN_CFG_VERSION = 0xe;
const NIN_LAN_AUTO = 0xffffffff;
const GAME_PATH = '/games/GALE01/game.iso';
const GAME_ID = 0x47414c45; // "GALE", Melee NTSC
// Nintendont common/config/MeleeCodes.c line items 0-7 at their defaultValue
// (Controller Fix UCF, PAL patch off, Convenience stealth, then lag reduction,
// frozen stages, screen and safety at their first option), except Gameplay
// (MELEE_CODES_GAMEPLAY_OPTION_ID 5) = 4, "Both": the kernel (Patch.c) applies
// the option whose value matches, here g_gameplay_both.bin, which is
// g_gameplay_lgl.bin (UnclePunch's ledge-grab limit) followed by
// g_gameplay_wobbling.bin (anti-wobbling). On a time-out LGL takes the player
// ahead on stocks, then lower percent, unless that player is over the
// ledge-grab limit and the other is not, and the kiosk reports the game's own
// winner (docs/architecture.md, Auto-score). 2 would be LGL alone.
const MELEE_CODES = [2, 1, 2, 1, 1, 4, 1, 1];

/** A fresh lazyto_nincfg.bin: what the loader would save after picking the game and turning on Network and Auto Boot. */
export function loaderSettings(): Buffer {
  const b = Buffer.alloc(NIN_CFG_SIZE);
  b.writeUInt32BE(NIN_CFG_MAGIC, 0x00);
  b.writeUInt32BE(NIN_CFG_VERSION, 0x04);
  b.writeUInt32BE(NIN_CFG_NETWORK | NIN_CFG_AUTO_BOOT, 0x08); // Config; Log off
  // 0x0c VideoMode 0: auto
  b.writeUInt32BE(NIN_LAN_AUTO, 0x10); // Language
  b.write(GAME_PATH, 0x14, 'ascii'); // GamePath[255], NUL-padded
  b.writeUInt32BE(GAME_ID, 0x114);
  b.writeUInt8(2, 0x118); // MemCardBlocks: 251 blocks, the loader's default
  // 0x119 VideoScale, 0x11a VideoOffset, 0x11b unused, 0x11c UseUSB (0: SD)
  MELEE_CODES.forEach((v, i) => b.writeUInt32BE(v, 0x120 + 4 * i)); // MeleeCodeOptions
  // 0x140 ReplaysLED: 0
  return b;
}

/** lazyto_station.txt on the card (docs/wii-setup.md), as the kernel parses it. */
export function formatStationFile(c: { station: number; secret: string }): string {
  return `station=${c.station}\nsecret=${c.secret}\n`;
}

function cardReadme(station: number, stream: boolean, version: string): string {
  return `LazyTO SD card for station ${station}${stream ? ' (the stream station)' : ''}

1. Format the SD card as FAT32.
2. Unzip everything in this zip onto the root of the card.
3. Copy your own NTSC 1.02 Melee image onto the card as games/GALE01/game.iso.
4. Put the card in the Wii and start LazyTO from the Homebrew Channel. It boots
   straight into Melee; hold B while it starts for the loader's menu.

What is on the card:
  apps/LazyTO/        the LazyTO loader (Slippi Nintendont with the tournament kiosk)
  lazyto_kiosk.bin    the kiosk module
  lazyto_station.txt  this card's station number and the relay's Wii secret
  lazyto_nincfg.bin   the loader's settings: Network and Auto Boot on, UCF on,
                      Gameplay Both (the ledge-grab limit and anti-wobbling),
                      the game at games/GALE01/game.iso. A venue's own Slippi
                      Nintendont on the same card keeps its own
                      slippi_nincfg.bin.

Keep the card like a password: lazyto_station.txt carries the Wii secret.
Made by the LazyTO ${version} relay.
`;
}

const GAME_README = `Copy your own NTSC 1.02 Melee image into this folder, named game.iso.
`;

function hasWiiFiles(wiiDir: string | null): wiiDir is string {
  return (
    wiiDir !== null &&
    existsSync(join(wiiDir, 'lazyto_kiosk.bin')) &&
    existsSync(join(wiiDir, 'apps', 'LazyTO', 'boot.dol'))
  );
}

export interface CardOptions {
  wiiDir: string;
  station: number;
  streamStation: number | null;
  secret: string;
  version: string;
}

export function stationZip(o: CardOptions): Buffer {
  const loader = join(o.wiiDir, 'apps', 'LazyTO');
  const stream = o.station === o.streamStation;
  const entries: ZipEntry[] = [
    ...readdirSync(loader)
      .sort()
      .map((f) => ({ name: `apps/LazyTO/${f}`, data: readFileSync(join(loader, f)) })),
    { name: 'lazyto_kiosk.bin', data: readFileSync(join(o.wiiDir, 'lazyto_kiosk.bin')) },
    {
      name: 'lazyto_station.txt',
      data: Buffer.from(formatStationFile({ station: o.station, secret: o.secret })),
    },
    { name: LOADER_SETTINGS_FILE, data: loaderSettings() },
    { name: 'games/GALE01/README.txt', data: Buffer.from(GAME_README) },
    { name: 'README.txt', data: Buffer.from(cardReadme(o.station, stream, o.version)) },
  ];
  return buildZip(entries);
}

export interface CardsView {
  /** The bundle's wii/ folder; null when the relay runs from a clone. */
  wiiDir: string | null;
  config: Config;
  /** The stream station tonight, or null for no stream. */
  streamStation: number | null;
  version: string;
}

/** /cards and /cards/zip, behind the admin password. */
export function serveCards(
  v: CardsView,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  if (req.method !== 'GET') return sendText(res, 404, 'not found\n');
  if (!requirePassword(req, res, v.config.adminPassword)) return;
  if (url.pathname === '/cards') return sendHtml(res, renderCards(v));

  if (!hasWiiFiles(v.wiiDir)) {
    return sendText(res, 503, 'this relay has no Wii files (see the SD cards page)\n');
  }
  const raw = url.searchParams.get('station') ?? '';
  const station = /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
  if (station < 1 || station > 65535) {
    return sendText(res, 400, 'station must be a number from 1 to 65535\n');
  }
  const zip = stationZip({
    wiiDir: v.wiiDir,
    station,
    streamStation: v.streamStation,
    secret: v.config.secret,
    version: v.version,
  });
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="lazyto-station-${station}.zip"`,
    'content-length': zip.length,
  });
  res.end(zip);
}

function renderCards(v: CardsView): string {
  if (!hasWiiFiles(v.wiiDir)) {
    return page(
      `<h2>SD cards</h2>
<p class="warn">This relay has no Wii files${v.wiiDir ? ` in <code>${escapeHtml(v.wiiDir)}</code>` : ''}. A relay installed with the install command has them; one run from a clone of the repo does not.</p>
<div class="acts"><a class="btnlink" href="/">back</a></div>`,
    );
  }
  const streamNote =
    v.streamStation === null
      ? 'There is no stream tonight.'
      : `Station ${v.streamStation} is the stream station.`;
  return page(
    `<h2>SD cards</h2>
<p>One zip per Wii. For each station:</p>
<ol>
<li>Download its zip below.</li>
<li>Unzip everything onto the root of a FAT32 SD card.</li>
<li>Copy your own NTSC 1.02 Melee image onto the card as <code>games/GALE01/game.iso</code>.</li>
<li>Start LazyTO from the Homebrew Channel. It boots straight into Melee; hold B as it starts for the loader's menu.</li>
</ol>
<form method="get" action="/cards/zip" class="block">
<label for="station">Station number</label>
<input type="number" id="station" name="station" min="1" max="65535" value="1" required>
<p class="muted small">The number on the station's label at the venue. ${escapeHtml(streamNote)}</p>
<div class="acts"><button class="primary">Download the zip</button><a class="btnlink" href="/">back</a></div>
</form>
<p class="muted small">Each zip holds the Wii secret: keep the cards like a password. The loader's settings are its own <code>lazyto_nincfg.bin</code>, so a venue's Slippi Nintendont on the same card keeps its settings. The zips carry the Wii files of this relay's version, LazyTO ${escapeHtml(v.version)}.</p>`,
  );
}
