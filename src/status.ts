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
// "Beamers and set archives" is the experimental set archive (archive.ts):
// each station's beamer as its announces placed it, and the zips written.
//
// At the top, what keeps stations from reaching the relay at all: macOS's
// Local Network switch (the beacon fails with EHOSTUNREACH), the desktop
// app's notes about the laptop (platform.ts: Windows Firewall, with its fix
// button), and beacons answered by nobody for NO_CONTACT_MS. In the footer,
// a newer LazyTO release, whose link is withheld while a station is mid-set.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SetCache } from './cache.js';
import { wins, type StationState } from './state.js';
import type { StartggClient } from './startgg.js';
import type { BeaconStatus } from './beacon.js';
import type { Platform } from './platform.js';
import type { RefusedStatus } from './tcp.js';
import {
  crashText,
  hexAddr,
  moduleStateText,
  type StationTelemetryRow,
  type TelemetryRefused,
} from './telemetry.js';
import { basename } from 'node:path';
import { ModuleState } from '../generated/wire.js';
import type { SetArchive } from './archive.js';
import type { BeamerDirectory } from './beamer.js';
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
  /** The set archive (archive.ts) and the beamers it reads replays from (beamer.ts). */
  archive: Pick<SetArchive, 'status'>;
  beamers: Pick<BeamerDirectory, 'status'>;
  admin: Admin;
  /** The relay's own addresses and version, for the footer. */
  addresses: string[];
  version: string;
  /** The desktop app's view of the laptop (platform.ts); null when the relay runs on its own. */
  platform: Pick<Platform, 'notes' | 'latest'> | null;
}

/** A Wii not heard from for this long is shown as silent (it sends a status every 5 s). */
const SILENT_STATION_MS = 20_000;
/** Log lines shown per Wii on the main page; the rest is on /log. */
const LOG_TAIL_LINES = 6;

/** Cache older than this (3 missed 20 s refreshes) is flagged as stale. */
export const STALE_CACHE_MS = 60_000;

/** Beacons answered by nobody for this long: a firewall, or the laptop on the wrong network. */
export const NO_CONTACT_MS = 120_000;

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
      `<div class="line">${actionText}</div>${flagLines}${free}</div>`
    );
  });
  if (cards.length === 0) {
    cards.push(
      '<p class="muted">no station has connected yet. Each Wii needs its SD card: <a href="/cards">SD cards</a>.</p>',
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
    ? `<p class="warn">✗ ${rf.count} request(s) refused: ${escapeHtml(rf.lastReason)} — last ${age(rf.lastAt)} ago from ${escapeHtml(rf.lastFrom)} claiming station ${rf.lastStation}. A Wii there needs this relay's SD card files.</p>`
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
    wiiCards.push(
      '<p class="muted">no Wii has reported yet (needs the telemetry kernel and Nintendont Network on)</p>',
    );
  }
  const br = telemetry.beaconRequested?.() ?? null;
  const beaconRequestLine = br
    ? `<p class="muted">${br.count} beacon request(s) answered — a Wii that could not hear the broadcast asked instead; last ${age(br.lastAt)} ago from ${escapeHtml(br.lastFrom)}.</p>`
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
${renderArchive(v)}
<div class="foot">
${telemetryRefusedLine}
${beaconRequestLine}
<p>${cacheLine} Upstream: ${startgg.callsInWindow()} calls last 60s.</p>
${beaconLine}
${refusedLine}
${staleLine}${errorLine}${warningLines}
<p class="muted">LazyTO ${escapeHtml(v.version)} · this relay: ${v.addresses.map((a) => `http://${escapeHtml(a)}:29473`).join(', ') || '—'}</p>
${renderUpdate(v, onStations)}
</div>`,
    { refreshSeconds: 5 },
  );
}

/** Each station's beamer and the set archives in progress and written. */
function renderArchive(v: StatusView): string {
  const as = v.archive.status();
  const bs = v.beamers.status();
  const watch = new Map(as.watches);
  const cards = bs.beamers.map(([station, b]) => {
    const w = watch.get(station);
    const err = w?.lastError ? `<div class="line warn">✗ ${escapeHtml(w.lastError)}</div>` : '';
    return (
      `<div class="card${w?.lastError ? ' bad' : ''}">` +
      `<div class="row"><span class="st">${station}</span><span class="grow">heard ${age(b.lastSeen)} ago</span>` +
      `<span class="muted small">${escapeHtml(b.address)}</span></div>` +
      `<div class="line">${w?.downloaded ?? 0} replay(s) pulled</div>${err}</div>`
    );
  });
  if (cards.length === 0) {
    cards.push(
      '<p class="muted">no beamer heard yet (each one announces itself when a game starts or ends)</p>',
    );
  }
  const inProgress = as.inProgress
    .map(
      (s) =>
        `set ${s.setId} on station ${s.station}: ${s.bound}/${s.starts} game(s) matched to a replay${s.ended ? ' — ended, writing the archive' : ''}`,
    )
    .map((l) => `<p class="muted">${escapeHtml(l)}</p>`)
    .join('');
  const recent = as.recent
    .map((r) => {
      const what = r.file
        ? `${escapeHtml(basename(r.file))} (${r.games} game(s))`
        : `set ${r.setId}: not archived`;
      const note = r.note
        ? ` <span class="${r.file && r.missing.length === 0 ? 'muted' : 'warn'}">${escapeHtml(r.note)}</span>`
        : '';
      return `<p>${r.file ? '✓' : '✗'} station ${r.station}, ${age(r.at)} ago: ${what}${note}</p>`;
    })
    .join('');
  const odd = bs.unnamed
    ? `<p class="warn">⚠ ${bs.unnamed} announce(s) from a beamer whose name is not "Station N" — set its number with its button.</p>`
    : '';
  return `<h2>Beamers and set archives</h2>
${cards.join('\n')}
${odd}${inProgress}${recent || '<p class="muted">no set archived yet</p>'}`;
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

/** The beacon's send error as the TO should read it. */
export function beaconProblem(bs: BeaconStatus, os: NodeJS.Platform = process.platform): string {
  if (os === 'darwin' && bs.lastErrorCode === 'EHOSTUNREACH') {
    return 'macOS is blocking LazyTO from your network: System Settings > Privacy & Security > Local Network > LazyTO on';
  }
  return `discovery beacon: ${bs.lastError ?? ''} — Wiis cannot find the relay`;
}

/**
 * True when beacons have gone out for NO_CONTACT_MS and nothing has come back:
 * no request, no Wii report, no beacon request, no beamer announce, not even
 * a refused one.
 */
export function noContact(v: StatusView, now = Date.now()): boolean {
  const first = v.beacon.status().firstSentAt;
  if (first === null || now - first < NO_CONTACT_MS) return false;
  const b = v.beamers.status();
  return (
    v.state.stations().length === 0 &&
    v.tcp.refused() === null &&
    v.telemetry.stations().length === 0 &&
    v.telemetry.refused() === null &&
    !v.telemetry.beaconRequested?.() &&
    b.beamers.length === 0 &&
    b.unnamed === 0 &&
    b.bad === 0
  );
}

/** What keeps stations from reaching the relay, most basic first; "" when nothing does. */
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
  for (const n of v.platform?.notes() ?? []) {
    const button = n.action
      ? ` <form method="post" action="/platform?action=${encodeURIComponent(n.action.name)}"><button>${escapeHtml(n.action.label)}</button></form>`
      : '';
    lines.push(`<p class="warn">⚠ ${escapeHtml(n.text)}${button}</p>`);
  }
  if (noContact(v, now)) {
    const mins = Math.floor((now - bs.firstSentAt!) / 60_000);
    lines.push(
      `<p class="warn">⚠ No beamer has reached this ${v.platform ? 'laptop' : 'relay'}: its beacon has gone out for ${mins} min and nothing has answered. Is it on the stations' Wi-Fi, and allowed through its firewall?</p>`,
    );
  }
  return lines.length ? `<div class="card bad">${lines.join('')}</div>` : '';
}

/** "LazyTO vX is out", with its link only while no station is mid-set: never update during a set. */
function renderUpdate(v: StatusView, midSet: number): string {
  const r = v.platform?.latest() ?? null;
  if (!r) return '';
  const name = `LazyTO v${escapeHtml(r.version)} is out`;
  return midSet > 0
    ? `<p class="muted">${name}. Its link is here when no station is in a set; update at home, not during an event.</p>`
    : `<p>${name}: <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">release page</a>. Update at home, not during an event.</p>`;
}
