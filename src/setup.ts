// setup.ts -- the setup wizard and, once the relay is set up, the settings
// page (app.ts routes /setup here). Three steps, each a plain HTML form; the
// state rides in hidden fields, so the server keeps none:
//
//   1. token       a start.gg token of a tournament admin (first run: plus the
//                  setup code that install.sh printed)
//   2. tournament  one of the token's admin tournaments: follow its short URL
//                  each week, or only that tournament; or a pasted link, for
//                  an unpublished tournament no list returns
//   3. event       its Melee singles event, the stream (or none), the stream
//                  station, the set format, the update channel, the password
//
// Saving checks everything the relay will check at start (config.ts), then
// does the same lookup the relay does (resolve.ts), then app.save() writes the
// file and starts the event with it. The Wii secret is generated on the first
// save and kept after. The saved token is never written into a page: a blank
// token field means "keep the saved one".
//
// First run: every POST needs the setup code. After that: the admin password.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { App, UpdateChannel } from './app.js';
import { UPDATE_CHANNELS } from './app.js';
import { newSecret, parseConfig, weeklyPrefixFrom, type Config } from './config.js';
import { SET_FORMATS, type SetFormat } from './format.js';
import {
  findTournamentSlug,
  listAdminTournaments,
  meleeSinglesEvents,
  resolveEvent,
} from './resolve.js';
import type { AdminTournament, TournamentDetail } from './startgg.js';
import {
  escapeHtml,
  page,
  readForm,
  redirectWithResult,
  requirePassword,
  sendHtml,
  sendText,
} from './web.js';

/** Fields every step carries forward. */
interface Carry {
  code: string; // first run only
  token: string; // a newly entered token; "" = the saved one
}

/** Step 2's choice: what goes in the settings, and which tournament to list events from. */
interface TournamentChoice {
  tournament: string; // short URL or tournament/<slug>
  slug: string; // tournament/<slug> to read events and streams from
  weekly: string; // weekly fallback prefix; "" for none
}

const SET_FORMAT_TEXT: Record<SetFormat, string> = {
  startgg: 'Best-of as start.gg has it (in-person events say Bo5 for every set)',
  top8q: 'Bo3, then Bo5 from the top-8 qualifiers on',
};
const CHANNEL_TEXT: Record<UpdateChannel, string> = {
  release: 'Releases (recommended): the newest published LazyTO release',
  main: 'Development builds: every change to LazyTO, for testing it',
  off: 'Off: keep this version',
};

const RECENT_DAYS = 60;

export async function serveSetup(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const saved = app.config();
  if (saved !== null && !requirePassword(req, res, saved.adminPassword)) return;

  if (req.method === 'GET') {
    if (saved === null || url.searchParams.get('step') === 'token') {
      sendHtml(res, stepToken(app, { code: '', token: '' }));
    } else {
      sendHtml(res, await settingsPage(app, saved));
    }
    return;
  }
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed\n');
    return;
  }

  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch {
    sendText(res, 413, 'form too large\n');
    return;
  }
  const carry: Carry = { code: form.get('code') ?? '', token: (form.get('token') ?? '').trim() };
  if (saved === null && !app.checkSetupCode(carry.code)) {
    sendHtml(
      res,
      stepToken(
        app,
        { code: '', token: '' },
        'That setup code is not right. It was printed when LazyTO was installed, and it is in the relay log.',
      ),
      403,
    );
    return;
  }
  const token = carry.token || saved?.token || '';

  switch (form.get('step')) {
    case 'token':
      if (!token) {
        sendHtml(res, stepToken(app, carry, 'Paste a start.gg token.'));
        return;
      }
      sendHtml(res, await stepTournament(app, carry, token));
      return;
    case 'tournament': {
      const choice = parseTournamentChoice(form);
      if (typeof choice === 'string') {
        sendHtml(res, await stepTournament(app, carry, token, choice));
        return;
      }
      sendHtml(res, await stepEvent(app, carry, token, choice));
      return;
    }
    case 'save':
      await save(app, carry, token, form, res);
      return;
    default:
      sendText(res, 400, 'unknown step\n');
  }
}

// ---- step 1: token ----

function stepToken(app: App, carry: Carry, error?: string): string {
  const firstRun = app.config() === null;
  const problems = app.setupProblems();
  return page(
    `${banner(error)}${
      problems.length
        ? `<p class="warn">The saved settings can't be used: ${problems.map(escapeHtml).join('; ')}. Set the relay up again.</p>`
        : ''
    }<h2>${firstRun ? 'Set up LazyTO' : 'Replace the start.gg token'}</h2>
<form method="post" action="/setup" class="block card">
<input type="hidden" name="step" value="token">
${
  firstRun
    ? `<label for="code">Setup code</label>
<input type="text" id="code" name="code" inputmode="numeric" autocomplete="off" value="${escapeHtml(carry.code)}" required>
<p class="muted small">Printed when LazyTO was installed on this Pi.</p>`
    : ''
}
<label for="token">start.gg token</label>
<input type="password" id="token" name="token" autocomplete="off" required>
<p class="muted small">On start.gg, signed in as an admin of your tournament: Developer Settings, Personal Access Tokens, Create new token. LazyTO keeps it on this Pi only.</p>
<div class="acts"><button class="primary">Next</button>${firstRun ? '' : '<a class="btnlink" href="/setup">cancel</a>'}</div>
</form>`,
  );
}

// ---- step 2: tournament ----

async function stepTournament(
  app: App,
  carry: Carry,
  token: string,
  error?: string,
): Promise<string> {
  let list: AdminTournament[];
  try {
    list = await listAdminTournaments(app.startgg(token));
  } catch (e) {
    return stepToken(
      app,
      { code: carry.code, token: '' },
      `start.gg refused the token: ${message(e)}`,
    );
  }
  const now = Date.now() / 1000;
  const recent = (t: AdminTournament) =>
    t.startAt === null || t.startAt > now - RECENT_DAYS * 86400;
  const sorted = [...list].sort((a, b) => (b.startAt ?? Infinity) - (a.startAt ?? Infinity));
  const choice = (t: AdminTournament) => {
    const when = t.startAt
      ? ` <span class="muted small">${new Date(t.startAt * 1000).toDateString()}</span>`
      : '';
    const follow = t.shortSlug
      ? `<label class="choice"><input type="radio" name="choice" value="${escapeHtml(`follow|${t.shortSlug}|${t.slug}`)}"><span>Follow <b>start.gg/${escapeHtml(t.shortSlug)}</b> every week<br><span class="muted small">now ${escapeHtml(t.name)}</span>${when}</span></label>`
      : '';
    return (
      follow +
      `<label class="choice"><input type="radio" name="choice" value="${escapeHtml(`only|${t.slug}`)}"><span>Only <b>${escapeHtml(t.name)}</b>${when}</span></label>`
    );
  };
  const recentList = sorted.filter(recent);
  const older = sorted.filter((t) => !recent(t));
  return page(
    `${banner(error)}<h2>Which tournament?</h2>
<form method="post" action="/setup" class="block">
${hidden(carry)}<input type="hidden" name="step" value="tournament">
<div class="card list">
${recentList.map(choice).join('\n') || '<p class="muted">No recent tournaments for this token.</p>'}
${older.length ? `<details><summary>${older.length} older</summary>${older.map(choice).join('\n')}</details>` : ''}
</div>
<label for="link">Or paste the tournament's start.gg link</label>
<input type="url" id="link" name="link" placeholder="https://www.start.gg/tournament/...">
<p class="muted small">Needed for an unpublished tournament, which start.gg never lists.</p>
<div class="acts"><button class="primary">Next</button></div>
</form>`,
  );
}

function parseTournamentChoice(form: URLSearchParams): TournamentChoice | string {
  const link = (form.get('link') ?? '').trim();
  if (link) {
    const m = /(?:^|\/)tournament\/([A-Za-z0-9-]+)/.exec(link);
    if (!m) return 'That link is not a start.gg tournament link (…/tournament/<name>/…).';
    const slug = `tournament/${m[1]!.toLowerCase()}`;
    return { tournament: slug, slug, weekly: '' };
  }
  const v = form.get('choice') ?? '';
  let m = /^follow\|([A-Za-z0-9-]+)\|(tournament\/[A-Za-z0-9-]+)$/.exec(v);
  if (m) return { tournament: m[1]!, slug: m[2]!, weekly: '' };
  m = /^only\|(tournament\/[A-Za-z0-9-]+)$/.exec(v);
  if (m) return { tournament: m[1]!, slug: m[1]!, weekly: '' };
  return 'Pick a tournament, or paste its link.';
}

// ---- step 3: event, stream and the rest ----

interface Prefill {
  eventName?: string;
  streamName?: string;
  streamStation?: number;
  setFormat?: SetFormat;
  channel?: UpdateChannel;
}

async function stepEvent(
  app: App,
  carry: Carry,
  token: string,
  choice: TournamentChoice,
  error?: string,
  prefill: Prefill = {},
): Promise<string> {
  let t: TournamentDetail;
  try {
    t = await app.startgg(token).getTournament(choice.slug);
  } catch (e) {
    return stepTournament(
      app,
      carry,
      token,
      `Couldn't read ${choice.slug} from start.gg: ${message(e)}`,
    );
  }
  const events = meleeSinglesEvents(t);
  if (events.length === 0) {
    return stepTournament(app, carry, token, `${t.name} has no Melee singles event.`);
  }
  // A followed short URL moves to next week's tournament; the weekly fallback
  // finds it by this tournament's name minus its number if it hasn't moved yet.
  const weekly = choice.tournament.startsWith('tournament/') ? '' : weeklyPrefixFrom(t.name);
  const saved = app.config();
  const firstRun = saved === null;

  const wantEvent = prefill.eventName?.toLowerCase();
  const eventChecked = (name: string, i: number) =>
    wantEvent ? name.toLowerCase().includes(wantEvent) : events.length === 1 && i === 0;
  const eventRadios = events
    .map(
      (e, i) =>
        `<label class="choice"><input type="radio" name="event" value="${escapeHtml(e.name)}"${eventChecked(e.name, i) ? ' checked' : ''} required><span>${escapeHtml(e.name)}</span></label>`,
    )
    .join('\n');

  const wantStream =
    prefill.streamName !== undefined
      ? prefill.streamName.toLowerCase()
      : t.streams.length === 1
        ? t.streams[0]!.streamName.toLowerCase()
        : '';
  const streamRadios = [
    ...t.streams.map(
      (s) =>
        `<label class="choice"><input type="radio" name="stream" value="${escapeHtml(s.streamName)}"${s.streamName.toLowerCase() === wantStream ? ' checked' : ''}><span>${escapeHtml(s.streamName)}</span></label>`,
    ),
    `<label class="choice"><input type="radio" name="stream" value=""${wantStream === '' ? ' checked' : ''}><span>No stream</span></label>`,
  ].join('\n');

  const format = prefill.setFormat ?? 'startgg';
  const formatRadios = SET_FORMATS.map(
    (f) =>
      `<label class="choice"><input type="radio" name="setFormat" value="${f}"${f === format ? ' checked' : ''}><span>${escapeHtml(SET_FORMAT_TEXT[f])}</span></label>`,
  ).join('\n');
  const channel = prefill.channel ?? app.updateChannel();
  const channelRadios = UPDATE_CHANNELS.map(
    (c) =>
      `<label class="choice"><input type="radio" name="channel" value="${c}"${c === channel ? ' checked' : ''}><span>${escapeHtml(CHANNEL_TEXT[c])}</span></label>`,
  ).join('\n');

  const following = !choice.tournament.startsWith('tournament/');
  const midSet = app.stationsMidSet();

  return page(
    `${banner(error)}<h2>${escapeHtml(t.name)}</h2>
<p class="sub">${
      following
        ? `Following <b>start.gg/${escapeHtml(choice.tournament)}</b> each week.${weekly ? ` If it hasn't moved to the new week's tournament yet, LazyTO takes the nearest "${escapeHtml(weekly)}&lt;number&gt;".` : ''}`
        : 'This tournament only.'
    }${firstRun ? '' : ' <a href="/setup?step=token">Replace the token</a>'}</p>
<form method="post" action="/setup" class="block">
${hidden(carry)}<input type="hidden" name="step" value="save">
<input type="hidden" name="tournament" value="${escapeHtml(choice.tournament)}">
<input type="hidden" name="slug" value="${escapeHtml(choice.slug)}">
<input type="hidden" name="weekly" value="${escapeHtml(weekly)}">
<h2>Event</h2>
<div class="card list">${eventRadios}</div>
<h2>Stream</h2>
<div class="card list">${streamRadios}</div>
<label for="station">Stream station number</label>
<input type="number" id="station" name="station" min="1" max="65535" value="${prefill.streamStation ?? 1}">
<p class="muted small">The Wii on stream. Its sets go on the stream above.</p>
<h2>Set format</h2>
<div class="card list">${formatRadios}</div>
<h2>Updates</h2>
<div class="card list">${channelRadios}</div>
<h2>Admin password</h2>
<label for="password">${firstRun ? 'Password' : 'New password (empty: keep the current one)'}</label>
<input type="password" id="password" name="password" autocomplete="new-password"${firstRun ? ' required' : ''}>
<label for="password2">Again</label>
<input type="password" id="password2" name="password2" autocomplete="new-password"${firstRun ? ' required' : ''}>
<p class="muted small">For these settings and the status page's buttons. 8 or more characters, no spaces. Your browser asks for it; the user name can be anything.</p>
${midSet ? `<p class="warn">${midSet} station(s) are mid-set. Saving restarts the relay for a second; their sets carry on.</p>` : ''}
<div class="acts"><button class="primary">Save</button>${firstRun ? '' : '<a class="btnlink" href="/">cancel</a>'}</div>
</form>
${firstRun ? '' : `<form method="post" action="/setup" class="block"><input type="hidden" name="step" value="token"><div class="acts"><button>Change tournament</button></div></form>`}`,
  );
}

async function save(
  app: App,
  carry: Carry,
  token: string,
  form: URLSearchParams,
  res: ServerResponse,
): Promise<void> {
  const saved = app.config();
  const choice: TournamentChoice = {
    tournament: form.get('tournament') ?? '',
    slug: form.get('slug') ?? '',
    weekly: form.get('weekly') ?? '',
  };
  const setFormat = (form.get('setFormat') ?? 'startgg') as SetFormat;
  const channel = (form.get('channel') ?? 'release') as UpdateChannel;
  const prefill: Prefill = {
    eventName: form.get('event') ?? undefined,
    streamName: form.get('stream') ?? '',
    streamStation: Number(form.get('station')),
    setFormat,
    channel,
  };
  const again = async (error: string) =>
    sendHtml(res, await stepEvent(app, carry, token, choice, error, prefill), 400);

  const password = form.get('password') ?? '';
  if (password !== (form.get('password2') ?? '')) return again('The two passwords differ.');
  if (!password && !saved) return again('Choose an admin password.');
  if (!(UPDATE_CHANNELS as readonly string[]).includes(channel))
    return again('Pick an update channel.');

  const parsed = parseConfig({
    token,
    tournament: choice.tournament,
    eventName: prefill.eventName ?? '',
    secret: saved?.secret ?? newSecret(),
    adminPassword: password || saved?.adminPassword,
    weeklyNamePrefix: choice.weekly,
    streamName: prefill.streamName,
    streamStation: prefill.streamStation,
    setFormat,
  });
  if (!parsed.ok) return again(parsed.problems.join('; '));
  const config: Config = parsed.config;
  try {
    await resolveEvent(app.startgg(token), config); // the same lookup the relay does at start
  } catch (e) {
    return again(message(e));
  }
  await app.save(config, channel);
  redirectWithResult(res, true, saved ? 'Settings saved.' : 'LazyTO is set up.');
}

// ---- settings: step 3 for the saved tournament ----

async function settingsPage(app: App, saved: Config): Promise<string> {
  const carry: Carry = { code: '', token: '' };
  let slug: string;
  try {
    slug = saved.tournament.startsWith('tournament/')
      ? saved.tournament
      : (
          await findTournamentSlug(
            app.startgg(saved.token),
            saved.tournament,
            saved.weeklyNamePrefix,
          )
        ).slug;
  } catch (e) {
    return stepTournament(
      app,
      carry,
      saved.token,
      `Couldn't find the saved tournament: ${message(e)}`,
    );
  }
  return stepEvent(
    app,
    carry,
    saved.token,
    { tournament: saved.tournament, slug, weekly: saved.weeklyNamePrefix },
    undefined,
    {
      eventName: saved.eventName,
      streamName: saved.streamName,
      streamStation: saved.streamStation,
      setFormat: saved.setFormat,
    },
  );
}

// ---- helpers ----

function hidden(carry: Carry): string {
  return (
    (carry.code ? `<input type="hidden" name="code" value="${escapeHtml(carry.code)}">` : '') +
    (carry.token ? `<input type="hidden" name="token" value="${escapeHtml(carry.token)}">` : '')
  );
}

function banner(error?: string): string {
  return error ? `<p class="warn">✗ ${escapeHtml(error)}</p>` : '';
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
