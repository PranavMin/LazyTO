// status.ts -- the status page while the relay runs (architecture.md Relay,
// requirement F7), served by web.ts. One card per station with its set,
// score, last action (with the status and message the player saw), and any
// failed start.gg call; cards with a failed call stay flagged until the TO
// acks them. A meta refresh every 5 s; readable on a phone.
//
// The TO's actions (admin.ts) -- ack a flag, free a stuck station, set a
// waiting set's best-of -- need the admin password (web.ts). Freeing goes
// through a confirm page that names the set and the score it discards.
//
// The footer is the "night of" dashboard: cache size and age (stale =
// warning), how many sets are selectable vs on stations, upstream call rate,
// the last refresh error, the R8 preview-id warning, the beacon, refusals.
//
// "Wii consoles" is each Wii's own report (telemetry.ts): when it was last
// heard, whether its tournament module loaded and why not, and the tail of
// its kernel log; /log?station=N is the whole log as plain text.
//
// "Beamers" is one row per beamer from its syncs (beamer.ts, collect.ts):
// its number, firmware, Wi-Fi signal, card and free space, the replays on it
// (to collect, to erase, empty, incomplete), when it was last unplugged and
// its last erase, and the downloads. Above it, "All replays collected: safe
// to unplug beamers" once nothing is left to collect, for the end of the
// night. "Replays" lists the sets skipped for Lucky Stats with the game
// that has no replay and why, the zips written, and the strays kept.
//
// At the top, what keeps stations or replays from reaching the relay: two
// beamers on one station number (the newcomer is refused), a beamer with
// another secret, macOS's Local Network switch (the beacon fails with
// EHOSTUNREACH), and beacons answered by no beamer for NO_CONTACT_MS.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SetCache } from './cache.js';
import { wins, type StationState } from './state.js';
import type { StartggClient } from './startgg.js';
import type { BeaconStatus } from './beacon.js';
import type { RefusedStatus } from './tcp.js';
import {
  crashText,
  hexAddr,
  moduleStateText,
  type StationTelemetryRow,
  type TelemetryRefused,
} from './telemetry.js';
import { basename } from 'node:path';
import { BEAMER_FW_MIN, BeamerResult, BeamerStorage, ModuleState } from '../generated/wire.js';
import type { SetArchive } from './archive.js';
import { uuid, type BeamerRegistry, type BeamerRow } from './beamer.js';
import type { Collector } from './collect.js';
import { BEST_OF_CHOICES, type Admin, type AdminResult } from './admin.js';
import {
  age,
  escapeHtml,
  page,
  redirect,
  redirectWithResult,
  requirePassword,
  sendHtml,
  sendText,
} from './web.js';

/** What the status page shows and acts on: the running event (relay.ts) and its labels. */
export interface StatusView {
  state: StationState;
  cache: SetCache;
  startgg: StartggClient;
  /** null = no stream tonight. */
  streamStation: number | null;
  /** Tonight's tournament and event as resolve.ts found them, shown in the header so the TO can see it is the right week. */
  eventLabel: string;
  /** Discovery beacon (decisions.md R15): where it is announcing the relay, and any send error. */
  beacon: { status(): BeaconStatus };
  /** Requests refused for their secret (decisions.md R16): a mis-copied SD card, or someone else on the Wi-Fi. */
  tcp: { refused(): RefusedStatus | null };
  /** Each Wii's own boot report: module load status and kernel log (telemetry.ts). */
  telemetry: {
    stations(): StationTelemetryRow[];
    get(station: number): StationTelemetryRow | undefined;
    refused(): TelemetryRefused | null;
    beaconRequested?(): { count: number; lastAt: number; lastFrom: string } | null;
  };
  /** The set archive (archive.ts), the beamers (beamer.ts) and their downloads (collect.ts). */
  archive: Pick<SetArchive, 'status'>;
  beamers: Pick<BeamerRegistry, 'list' | 'duplicates' | 'wrongSecretBeamers' | 'lastContact'>;
  collector: Pick<Collector, 'status' | 'busy'>;
  /** The archive folder, for the Replays section. */
  store: { dir: string; freeBytes(): number };
  admin: Admin;
  /** The relay's own addresses and version, for the footer. */
  addresses: string[];
  version: string;
}

/** A Wii not heard from for this long is shown as silent (it sends a status every 5 s). */
const SILENT_STATION_MS = 20_000;
/** Log lines shown per Wii on the main page; the rest is on /log. */
const LOG_TAIL_LINES = 6;

/** Cache older than this (3 missed 20 s refreshes) is flagged as stale. */
export const STALE_CACHE_MS = 60_000;

/** Beacons answered by no beamer for this long: a firewall, or the laptop on the wrong network. */
export const NO_CONTACT_MS = 120_000;
/** A beamer not synced for this long is shown as silent (it syncs every 30 s). */
const SILENT_BEAMER_MS = 90_000;
/** A beamer up this long with collected replays waiting to be erased was never unplugged after an event. */
const NOT_UNPLUGGED_MS = 12 * 3600_000;

/** GET /log?station=N: one Wii's whole kernel log as plain text. */
export function serveLog(v: StatusView, res: ServerResponse, url: URL): void {
  const row = v.telemetry.get(Number(url.searchParams.get('station')));
  sendText(
    res,
    row ? 200 : 404,
    row
      ? `station ${row.station} (${row.from}), last heard ${age(row.lastSeenAt)} ago\n\n${row.lines.join('\n')}\n`
      : 'no telemetry from that station\n',
  );
}

/** /ack, /free, /bestof: the admin password, then the action, then back to the page. */
export async function serveAction(
  v: StatusView,
  password: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (!requirePassword(req, res, password)) return;
  if (url.pathname === '/ack' && req.method === 'POST') {
    const ok = v.state.ack(Number(url.searchParams.get('id')));
    if (ok) redirect(res, '/');
    else sendText(res, 404, 'no such flag\n');
    return;
  }
  const station = Number(url.searchParams.get('station'));
  if (url.pathname === '/free' && req.method === 'GET') {
    sendHtml(res, renderFreeConfirm(v, station));
    return;
  }
  let result: AdminResult;
  if (url.pathname === '/free' && req.method === 'POST') {
    result = await v.admin.freeStation(station, Number(url.searchParams.get('set')));
  } else if (url.pathname === '/bestof' && req.method === 'POST') {
    const bo = url.searchParams.get('bo');
    result = v.admin.setBestOf(
      Number(url.searchParams.get('set')),
      bo === 'auto' ? null : Number(bo),
    );
  } else {
    sendText(res, 405, 'method not allowed\n');
    return;
  }
  redirectWithResult(res, result.ok, result.msg);
}

export function renderStatus(
  v: StatusView,
  done: string | null = null,
  error: string | null = null,
): string {
  const { state, cache, startgg, streamStation, eventLabel, beacon, tcp, telemetry } = v;
  const flags = state.flags();
  const archiveStatus = v.archive.status();

  const cards = state.stations().map((station) => {
    const claim = state.get(station);
    const set = claim ? cache.get(claim.setId) : undefined;
    const setText = claim
      ? set
        ? `${set.roundShort}  ${set.p1.tag} vs ${set.p2.tag} (Bo${set.bestOf})`
        : `set ${claim.setId}`
      : 'no set';
    const score = claim?.games.length ? wins(claim.games).join('–') : '';

    const action = state.lastAction(station);
    let actionText = '<span class="muted">no action yet</span>';
    if (action) {
      const cmd = escapeHtml(action.cmd.replace('CMD_', ''));
      actionText = action.ok
        ? `${cmd} ${age(action.at)} ago`
        : `<span class="warn">✗ ${cmd} ${age(action.at)} ago — ${escapeHtml(action.status)}: ${escapeHtml(action.msg)}</span>`;
    }

    const stationFlags = flags.filter((f) => f.station === station);
    const replayLines = archiveStatus.flagged
      .filter((f) => f.station === station && claim?.setId === f.setId)
      .map(
        (f) =>
          `<div class="line warn">⚠ game ${f.game}: ${escapeHtml(f.why)}${f.why === 'not recorded' ? ' (no replay: this set gets no Lucky Stats zip)' : ''}</div>`,
      )
      .join('');
    const flagLines = stationFlags
      .map(
        (f) =>
          `<div class="line row"><span class="warn grow">✗ ${escapeHtml(f.message)} (${age(f.at)} ago)</span>` +
          `<form method="post" action="/ack?id=${f.id}"><button>ack</button></form></div>`,
      )
      .join('');
    const star = station === streamStation ? ' ★' : '';
    const free = claim
      ? `<div class="acts"><form method="get" action="/free"><input type="hidden" name="station" value="${station}"><button>free station</button></form></div>`
      : '';
    return (
      `<div class="card${stationFlags.length ? ' bad' : ''}">` +
      `<div class="row"><span class="st">${station}${star}</span>` +
      `<span class="grow${claim ? '' : ' muted'}">${escapeHtml(setText)}</span>` +
      `${score ? `<span class="score">${score}</span>` : ''}</div>` +
      `<div class="line">${actionText}</div>${replayLines}${flagLines}${free}</div>`
    );
  });
  if (cards.length === 0) {
    cards.push(
      '<p class="muted">no station has connected yet. Each Wii needs the SD card (<a href="/cards">SD cards</a>) and its beamer.</p>',
    );
  }

  const cs = cache.status();
  const onStations = state.stations().filter((s) => state.get(s) !== undefined).length;
  const selectable = cache.pending().filter((s) => state.stationFor(s.id) === undefined).length;
  const stale = cs.refreshedAt > 0 && Date.now() - cs.refreshedAt > STALE_CACHE_MS;
  const cacheLine = cs.refreshedAt
    ? `Cache: ${cs.count} sets (${selectable} selectable, ${onStations} on stations), refreshed ${age(cs.refreshedAt)} ago.`
    : 'Cache: never refreshed.';
  const staleLine = stale
    ? `<p class="warn">⚠ cache is stale (last refresh ${age(cs.refreshedAt)} ago; expected every 20 s) — is start.gg reachable?</p>`
    : '';
  const rf = tcp.refused();
  const refusedLine = rf
    ? `<p class="warn">✗ ${rf.count} request(s) refused: ${escapeHtml(rf.lastReason)} — last ${age(rf.lastAt)} ago from ${escapeHtml(rf.lastFrom)} claiming station ${rf.lastStation}. The beamer there needs this relay's secret in its config.txt.</p>`
    : '';
  const bs = beacon.status();
  const beaconLine = bs.lastError
    ? `<p class="warn">✗ ${escapeHtml(beaconProblem(bs))}</p>`
    : `<p class="muted">Discovery beacon to ${bs.targets.map(escapeHtml).join(', ') || '—'}, last sent ${bs.lastSentAt ? `${age(bs.lastSentAt)} ago` : 'never'}.</p>`;
  const errorLine = cs.error
    ? `<p class="warn">✗ last refresh failed: ${escapeHtml(cs.error)}</p>`
    : '';

  const wiiCards = telemetry.stations().map((t) => {
    const silent = Date.now() - t.lastSeenAt > SILENT_STATION_MS;
    const heard = `heard ${age(t.lastSeenAt)} ago${silent ? ' <span class="warn">(silent)</span>' : ''}`;
    const moduleBad =
      t.status !== null &&
      t.status.module_state !== ModuleState.MOD_LOADED &&
      t.status.module_state !== ModuleState.MOD_PENDING;
    const mod = t.status
      ? moduleBad
        ? `<span class="warn">✗ ${escapeHtml(moduleStateText(t.status))}</span>`
        : escapeHtml(moduleStateText(t.status))
      : '<span class="muted">no status yet</span>';
    const extra = [
      t.lost ? `${t.lost} datagram(s) lost` : '',
      t.reboots ? `${t.reboots} reboot(s)` : '',
      t.status?.log_dropped ? `${t.status.log_dropped} log bytes dropped on the Wii` : '',
    ].filter(Boolean);
    const tail = t.lines.slice(-LOG_TAIL_LINES).map(escapeHtml).join('\n');
    const crash = t.crash
      ? `<div class="line warn">✗ crashed ${t.crashAt ? `${age(t.crashAt)} ago` : ''}: ${escapeHtml(crashText(t.crash, t.status))}</div>` +
        `<div class="line muted small">words at the fault: ${t.crash.fetched.map((w) => w.toString(16).padStart(8, '0')).join(' ')}; ` +
        `stack: ${
          [...t.crash.stack]
            .filter(Boolean)
            .map((a) => escapeHtml(hexAddr(a, t.status)))
            .join(' &lt; ') || '—'
        }</div>`
      : '';
    const bad = silent || t.crash !== null || moduleBad;
    return (
      `<div class="card${bad ? ' bad' : ''}">` +
      `<div class="row"><span class="st">${t.station}</span><span class="grow">${heard}</span>` +
      `<span class="muted small">${escapeHtml(t.from)}</span></div>` +
      `<div class="line">${mod}</div>` +
      `${extra.length ? `<div class="line muted small">${escapeHtml(extra.join(', '))}</div>` : ''}${crash}` +
      `<details><summary>kernel log</summary><pre>${tail || '<span class="muted">no log yet</span>'}</pre>` +
      `<a href="/log?station=${t.station}">full log</a></details></div>`
    );
  });
  if (wiiCards.length === 0) {
    wiiCards.push('<p class="muted">no Wii has reported yet (each reports through its beamer)</p>');
  }
  const br = telemetry.beaconRequested?.() ?? null;
  const beaconRequestLine = br
    ? `<p class="muted">${br.count} beacon request(s) answered — a beamer that could not hear the broadcast asked instead; last ${age(br.lastAt)} ago from ${escapeHtml(br.lastFrom)}.</p>`
    : '';
  const trf = telemetry.refused();
  const telemetryRefusedLine = trf
    ? `<p class="warn">✗ ${trf.count} Wii report(s) dropped for a wrong relay secret — last ${age(trf.lastAt)} ago from ${escapeHtml(trf.lastFrom)} claiming station ${trf.lastStation}.</p>`
    : '';
  const warningLines = cs.warnings.map((w) => `<p class="warn">⚠ ${escapeHtml(w)}</p>`).join('');
  const banner = error
    ? `<p class="warn">✗ ${escapeHtml(error)}</p>`
    : done
      ? `<p class="ok">✓ ${escapeHtml(done)}</p>`
      : '';

  return page(
    `${banner}${renderReach(v)}<p class="sub"><b>${escapeHtml(eventLabel)}</b><br>${streamStation === null ? 'no stream' : `stream station ${streamStation} ★`} · refreshes every 5 s · <a href="/setup">settings</a> · <a href="/cards">SD cards</a></p>
<h2>Stations</h2>
${cards.join('\n')}
${renderWaiting(v)}
<h2>Wii consoles</h2>
${wiiCards.join('\n')}
${renderBeamers(v)}
${renderReplays(v, archiveStatus)}
<div class="foot">
${telemetryRefusedLine}
${beaconRequestLine}
<p>${cacheLine} Upstream: ${startgg.callsInWindow()} calls last 60s.</p>
${beaconLine}
${refusedLine}
${staleLine}${errorLine}${warningLines}
<p class="muted">LazyTO ${escapeHtml(v.version)} · this relay: ${v.addresses.map((a) => `http://${escapeHtml(a)}:29473`).join(', ') || '—'}</p>
</div>`,
    { refreshSeconds: 5 },
  );
}

const STORAGE_TEXT: Record<number, string> = {
  [BeamerStorage.STORE_OK]: 'card OK',
  [BeamerStorage.STORE_NO_CARD]: 'NO SD CARD',
  [BeamerStorage.STORE_UNREADABLE]: 'SD card unreadable',
  [BeamerStorage.STORE_WRITE_FAILED]: 'SD card write failed',
  [BeamerStorage.STORE_WRONG_FORMAT]: 'SD card in the wrong format',
  [BeamerStorage.STORE_FILLING]: 'card filling: replug the beamer to erase collected replays',
  [BeamerStorage.STORE_FULL]: 'card FULL: replays are not saving',
};

function dateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** A beamer as the TO knows it: its number, or its station_id when it has none. */
function beamerName(b: { station: number | null; stationId: string }): string {
  return b.station === null
    ? `beamer ${uuid(b.stationId).slice(0, 8)} (no number)`
    : `beamer ${b.station}`;
}

/** One card per beamer, from its syncs, and whether everything has been collected. */
function renderBeamers(v: StatusView, now = Date.now()): string {
  const rows = v.beamers.list();
  const work = new Map(v.collector.status().map((w) => [w.stationId, w]));
  const cards = rows.map((b) => beamerCard(b, work.get(b.stationId), now));
  if (cards.length === 0) {
    cards.push(
      '<p class="muted">no beamer has synced yet (each one syncs with the relay every 30 s once it hears the beacon)</p>',
    );
  }
  const left = rows.filter((b) => b.toCollect > 0);
  let collected = '';
  if (rows.length > 0) {
    collected =
      left.length === 0 && !v.collector.busy()
        ? '<p class="ok">✓ All replays collected: safe to unplug beamers.</p>'
        : `<p class="muted">Still to collect: ${
            left.map((b) => `${escapeHtml(beamerName(b))}: ${b.toCollect}`).join(', ') ||
            'downloads in progress'
          }. Wait for "All replays collected" before unplugging beamers at the end of the night.</p>`;
  }
  return `<h2>Beamers</h2>
${collected}
${cards.join('\n')}`;
}

function beamerCard(
  b: BeamerRow,
  w: ReturnType<StatusView['collector']['status']>[number] | undefined,
  now: number,
): string {
  const warns: string[] = [];
  const silent = now - b.lastSyncAt > SILENT_BEAMER_MS;
  if (silent) warns.push(`not heard for ${age(b.lastSyncAt)} (unplugged, off, or off the Wi-Fi)`);
  if (b.storage !== BeamerStorage.STORE_OK)
    warns.push(STORAGE_TEXT[b.storage] ?? `storage state ${b.storage}`);
  if (b.fwBuild < BEAMER_FW_MIN)
    warns.push(`firmware build ${b.fwBuild} is too old: update the beamer`);
  if (now - b.bootAt > NOT_UNPLUGGED_MS && b.toErase > 0) {
    warns.push(
      `not unplugged since ${dateTime(b.bootAt)}: ${b.toErase} collected replay(s) wait to be erased; replug it between sets`,
    );
  }
  if (b.erase?.failed) warns.push('its last erase stopped on a failed delete');
  if (w?.diskFull) warns.push("this laptop's disk is too full to collect its replays");
  if (w?.lastError)
    warns.push(
      `download failed ${w.lastErrorAt ? `${age(w.lastErrorAt)} ago` : ''}: ${w.lastError}`,
    );
  if (b.lastResult !== BeamerResult.BR_OK) {
    warns.push(`its last Wii round trip: ${BeamerResult[b.lastResult] ?? b.lastResult}`);
  }
  const leaked = b.cardMb - b.freeMb - b.usedMb;
  const card = `${b.freeMb} MB free of ${b.cardMb} MB${leaked > 64 ? `, ${leaked} MB lost to interrupted recordings` : ''}`;
  const signal = b.rssi ? `Wi-Fi -${b.rssi} dBm` : 'Wi-Fi signal unknown';
  const erase = b.erase
    ? `last erase (cold boot ${age(b.erase.at)} ago): ${b.erase.erased} replay(s) and ${b.erase.erasedEmpty} empty file(s) in ${b.erase.eraseMs} ms${b.erase.eraseLeft ? `, ${b.erase.eraseLeft} left for the next one` : ''}`
    : 'no erase this boot';
  const renumbered =
    b.renumberedAt !== null && now - b.renumberedAt < 10 * 60_000
      ? `<div class="line muted small">renumbered ${age(b.renumberedAt)} ago, from ${b.previousStation ?? 'no number'}</div>`
      : '';
  const downloads = w
    ? `${w.downloaded} downloaded${w.current ? `, downloading ${escapeHtml(w.current)}` : ''}${w.queued ? `, ${w.queued} queued` : ''}`
    : 'nothing downloaded yet';
  return (
    `<div class="card${warns.length ? ' bad' : ''}">` +
    `<div class="row"><span class="st">${b.station ?? '–'}</span>` +
    `<span class="grow">${b.station === null ? '<span class="warn">no station number: press its button</span>' : `synced ${age(b.lastSyncAt)} ago`}</span>` +
    `<span class="muted small">${escapeHtml(b.address)}</span></div>` +
    `<div class="line">${b.onCard} replay(s) on the card: ${b.toCollect} to collect, ${b.toErase} to erase` +
    `${b.empty ? `, ${b.empty} empty` : ''}${b.incomplete ? `, ${b.incomplete} incomplete` : ''}</div>` +
    `<div class="line muted small">${escapeHtml(card)} · ${signal} · firmware ${b.fwBuild} · up since ${escapeHtml(dateTime(b.bootAt))}</div>` +
    `<div class="line muted small">${escapeHtml(erase)} · ${downloads}</div>` +
    renumbered +
    warns.map((t) => `<div class="line warn">⚠ ${escapeHtml(t)}</div>`).join('') +
    `<div class="line muted small">${escapeHtml(uuid(b.stationId))}</div></div>`
  );
}

/** Sets skipped for Lucky Stats and why, the zips written, the strays kept. */
function renderReplays(v: StatusView, as: ReturnType<StatusView['archive']['status']>): string {
  const skipped = as.skipped
    .map(
      (s) =>
        `<p class="warn">✗ ${escapeHtml(s.label)} (station ${s.station}, ended ${age(s.endedAt)} ago): no zip for Lucky Stats yet — ${s.missing
          .map((m) => `game ${m.game} ${escapeHtml(m.why)}`)
          .join('; ')}</p>`,
    )
    .join('');
  const inProgress = as.inProgress
    .filter((s) => s.games > 0)
    .map(
      (s) =>
        `<p class="muted">${escapeHtml(s.label)} on station ${s.station}: ${s.bound}/${s.games} game(s) have their replay</p>`,
    )
    .join('');
  const recent = as.recent
    .map(
      (r) =>
        `<p>✓ station ${r.station}, ${age(r.at)} ago: ${escapeHtml(basename(r.file))} (${r.games} game(s))${r.again ? ' — written again' : ''}${r.note ? ` <span class="muted">${escapeHtml(r.note)}</span>` : ''}</p>`,
    )
    .join('');
  let free = '';
  try {
    free = ` · ${Math.floor(v.store.freeBytes() / 1024 ** 3)} GB free`;
  } catch {
    // statfs unavailable: say nothing
  }
  return `<h2>Replays</h2>
${skipped}${inProgress}${recent || '<p class="muted">no set zipped yet</p>'}
${as.unmatched ? `<p class="muted">${as.unmatched} stray or incomplete recording(s) kept in unmatched/.</p>` : ''}
<p class="muted small">Archive folder: ${escapeHtml(v.store.dir)}${free}. A set is zipped for Lucky Stats once every game has its replay.</p>`;
}

/** The beacon's send error as the TO should read it. */
export function beaconProblem(bs: BeaconStatus, os: NodeJS.Platform = process.platform): string {
  if (os === 'darwin' && bs.lastErrorCode === 'EHOSTUNREACH') {
    return 'macOS is blocking LazyTO from your network: System Settings > Privacy & Security > Local Network > LazyTO on';
  }
  return `discovery beacon: ${bs.lastError ?? ''} — beamers cannot find the relay`;
}

/**
 * True when beacons have gone out for NO_CONTACT_MS and no beamer has come
 * back: no sync, no Wii request or telemetry, no beacon request, not even a
 * refused one.
 */
export function noContact(v: StatusView, now = Date.now()): boolean {
  const first = v.beacon.status().firstSentAt;
  if (first === null || now - first < NO_CONTACT_MS) return false;
  return (
    v.beamers.lastContact() === null &&
    v.tcp.refused() === null &&
    v.telemetry.refused() === null &&
    !v.telemetry.beaconRequested?.()
  );
}

/** What keeps stations or replays from reaching the relay, most basic first; "" when nothing does. */
function renderReach(
  v: StatusView,
  now = Date.now(),
  os: NodeJS.Platform = process.platform,
): string {
  const lines: string[] = [];
  const bs = v.beacon.status();
  if (os === 'darwin' && bs.lastErrorCode === 'EHOSTUNREACH') {
    lines.push(`<p class="warn">✗ ${escapeHtml(beaconProblem(bs, os))}</p>`);
  }
  if (noContact(v, now)) {
    const mins = Math.floor((now - bs.firstSentAt!) / 60_000);
    lines.push(
      `<p class="warn">⚠ No beamer has reached this relay: its beacon has gone out for ${mins} min and nothing has answered. Are the beamers on this Wi-Fi, and is LazyTO allowed through this computer's firewall?</p>`,
    );
  }
  const name = (b: { address: string; stationId: string | null }) =>
    `${b.address}${b.stationId ? ` (${uuid(b.stationId).slice(0, 8)})` : ''}`;
  for (const d of v.beamers.duplicates(now)) {
    lines.push(
      `<p class="warn">✗ Two beamers are station ${d.station}: ${escapeHtml(name(d.holder))} keeps playing; ${escapeHtml(name(d.newcomer))} is refused (${d.refused} time(s), last ${age(d.lastAt)} ago). Renumber one with its button.</p>`,
    );
  }
  for (const w of v.beamers.wrongSecretBeamers(now)) {
    lines.push(
      `<p class="warn">✗ The beamer at ${escapeHtml(w.address)} has another secret: its syncs are refused (${w.count}, last ${age(w.lastAt)} ago), so its replays are not collected. Write its config.txt again from the LazyTO app.</p>`,
    );
  }
  return lines.length ? `<div class="card bad">${lines.join('')}</div>` : '';
}

/** Sets waiting for a station, with the TO's best-of buttons. */
function renderWaiting(v: StatusView): string {
  const { cache, state } = v;
  const sets = cache.pending().filter((s) => state.stationFor(s.id) === undefined);
  const items = sets.map((s) => {
    const buttons = BEST_OF_CHOICES.filter((bo) => bo !== s.bestOf).map(
      (bo) =>
        `<form method="post" action="/bestof?set=${s.id}&amp;bo=${bo}"><button>Bo${bo}</button></form>`,
    );
    if (s.bestOfOverridden) {
      buttons.push(
        `<form method="post" action="/bestof?set=${s.id}&amp;bo=auto"><button>auto (Bo${s.autoBestOf})</button></form>`,
      );
    }
    const mark = s.bestOfOverridden ? ' <span class="muted small">set by TO</span>' : '';
    return (
      `<div class="item"><div class="grow"><span class="muted rd">${escapeHtml(s.roundShort)}</span> ` +
      `${escapeHtml(s.p1.tag)} vs ${escapeHtml(s.p2.tag)}<br><b>Bo${s.bestOf}</b>${mark}</div>` +
      `<div class="btns">${buttons.join('')}</div></div>`
    );
  });
  if (items.length === 0) {
    items.push('<p class="muted">no set is waiting</p>');
  }
  return `<h2>Waiting sets</h2>
<div class="card list">
${items.join('\n')}
</div>`;
}

function renderFreeConfirm(v: StatusView, station: number): string {
  const { state, cache } = v;
  const claim = state.get(station);
  if (!claim) return page(`<p>Station ${station} has no set.</p><p><a href="/">back</a></p>`);
  const set = cache.get(claim.setId);
  const [w1, w2] = wins(claim.games);
  const name = set
    ? `${escapeHtml(set.roundShort)} ${escapeHtml(set.p1.tag)} vs ${escapeHtml(set.p2.tag)}`
    : `set ${claim.setId}`;
  const effect = set
    ? claim.games.length > 0
      ? `<p class="warn">This resets the set on start.gg and discards its score, ${w1}–${w2}. The players replay it from 0–0 on any setup.</p>`
      : `<p>This resets the set on start.gg. It goes back on every Wii's list.</p>`
    : `<p>The set has already left start.gg's pending list; this only frees the station.</p>`;
  return page(
    `<p>Free station ${station}, playing <b>${name}</b>?</p>${effect}` +
      `<div class="acts"><form method="post" action="/free?station=${station}&amp;set=${claim.setId}"><button class="danger">Free station ${station}</button></form>` +
      `<a class="btnlink" href="/">cancel</a></div>`,
  );
}
