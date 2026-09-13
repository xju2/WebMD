import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { titleFileName } from '../src/note-title.js';
import {
  checkIndicoAddress,
  decodeHtml,
  IndicoError,
  indicoFetch,
  indicoTokenName,
  tokenForOrigin
} from './indico.js';
import { readCacheFile, writeCacheFile } from './news.js';
import { normalizeWorkspaceFolder, WorkspaceError } from './workspace.js';
import { findZoom, mergeZoom, pageZoom } from './zoom.js';

/**
 * Meetings: Indico categories and events a workspace subscribes to, the
 * upcoming meetings they hold, and the Markdown note that goes with each one.
 *
 * `.webmd/meetings.json` (version 1) holds only what is safe to commit:
 *
 *   {
 *     "version": 1,
 *     "noteFolder": "/meetings",
 *     "sources": [
 *       { "id": "indico.cern.ch-category-1234", "label": "Weekly meetings",
 *         "origin": "https://indico.cern.ch",
 *         "url": "https://indico.cern.ch/category/1234/", "enabled": true }
 *     ]
 *   }
 *
 * Tokens never go here; they stay in the environment or ~/.webmd.conf.
 */
export const MEETINGS_CONFIG_PATH = '/.webmd/meetings.json';
export const DEFAULT_MEETING_FOLDER = '/meetings';
export const MEETINGS_CONFIG_VERSION = 1;
// How far ahead a category is asked for. Two weeks covers This week, Next
// week, and a little of what follows, which is what a triage view is for.
export const MEETING_WINDOW_DAYS = 14;
// How far back a meeting stays listed: long enough for its recording and
// transcript to turn up and be attached to its note.
export const MEETING_PAST_DAYS = 7;
// Enough for a busy category's fortnight without letting one source flood the
// list or the response.
const CATEGORY_LIMIT = 200;
const MAX_SOURCES = 50;
const MAX_LABEL = 120;
const MAX_DESCRIPTION = 4000;
const MAX_AGENDA = 300;
// Meetings whose Zoom room is read off their page for the list's Join button:
// those under way or starting within a day, and never more than a handful.
const ZOOM_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;
const MAX_ZOOM_PAGES = 12;
const ZOOM_PAGE_TIMEOUT_MS = 6000;

// Fresh enough for a list someone glances at a few times a day; Refresh
// bypasses it. Bounded so a long-running server cannot grow it without end.
const CACHE_MS = 10 * 60 * 1000;
const CACHE_ENTRIES = 200;
// Past CACHE_MS a copy is still shown at once, when the caller allows it,
// while a new one is fetched behind it; older than this it is not trusted.
// Also how long an unused cache file is kept.
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const cache = new Map();
const inFlight = new Map();
const prunedDirs = new Set();

/* ------------------------------------------------------------------ sources */

/**
 * `{ origin, kind, indicoId, url, id }` for a category or event link, or a 400
 * that says what to fix. Any page of an event (its timetable, a contribution)
 * is taken to mean the event itself.
 */
export function parseMeetingSource(value, sites = new Map()) {
  const { origin, url } = checkIndicoAddress(value, sites);
  const match =
    /^\/(category|event)\/(\d+)(?:\/.*)?$/.exec(url.pathname) ||
    // Indico serves a category's own page at /category/<id>/overview too, and
    // older links still use categoryDisplay.py?categId=<id>.
    (/^\/categoryDisplay\.py$/.test(url.pathname) &&
    /^\d+$/.test(url.searchParams.get('categId') || '')
      ? [null, 'category', url.searchParams.get('categId')]
      : null);
  if (!match) {
    throw new WorkspaceError(
      400,
      'Paste an Indico category link (…/category/1234/) or event link (…/event/5678/).'
    );
  }
  const [, kind, indicoId] = match;
  return {
    id: sourceId(origin, kind, indicoId),
    origin,
    kind,
    indicoId,
    url: `${origin}/${kind}/${indicoId}/`
  };
}

function sourceId(origin, kind, indicoId) {
  return `${new URL(origin).hostname}-${kind}-${indicoId}`;
}

/**
 * The workspace's meeting configuration, with every entry checked. A bad
 * entry is skipped with a warning naming it, so one typo cannot take the
 * other sources down with it. `raw` keeps the file's own entries so a write
 * never silently drops one the user still means to fix.
 */
export async function readMeetingsConfig(workspace, sites = new Map()) {
  // A read-only resolve: opening Meetings must not create .webmd/.
  let text;
  try {
    const absolute = await workspace.resolvePath(MEETINGS_CONFIG_PATH);
    text = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.status === 404) return emptyConfig();
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ...emptyConfig(),
      broken: true,
      warnings: [
        `${MEETINGS_CONFIG_PATH} is not valid JSON (${error.message}). Fix or delete it to use Meetings.`
      ]
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ...emptyConfig(),
      broken: true,
      warnings: [`${MEETINGS_CONFIG_PATH} must hold a JSON object.`]
    };
  }

  const warnings = [];
  if (
    parsed.version !== undefined &&
    parsed.version !== MEETINGS_CONFIG_VERSION
  ) {
    warnings.push(
      `${MEETINGS_CONFIG_PATH} says version ${parsed.version}; this WebMD reads version ${MEETINGS_CONFIG_VERSION}, so some settings may be ignored.`
    );
  }

  let noteFolder = DEFAULT_MEETING_FOLDER;
  if (parsed.noteFolder !== undefined) {
    try {
      noteFolder = normalizeWorkspaceFolder(String(parsed.noteFolder));
    } catch {
      warnings.push(
        `noteFolder "${parsed.noteFolder}" is not a workspace folder; using ${DEFAULT_MEETING_FOLDER}.`
      );
    }
  }

  const raw = Array.isArray(parsed.sources) ? parsed.sources : [];
  if (parsed.sources !== undefined && !Array.isArray(parsed.sources)) {
    warnings.push('"sources" must be a list; no sources were read.');
  }
  const sources = [];
  const seen = new Set();
  raw.slice(0, MAX_SOURCES).forEach((entry, index) => {
    const name = `Source ${index + 1}${entry?.label ? ` (${String(entry.label).slice(0, 40)})` : ''}`;
    try {
      if (!entry || typeof entry !== 'object') throw new Error('not an object');
      const source = parseMeetingSource(entry.url, sites);
      if (entry.origin !== undefined && entry.origin !== source.origin) {
        throw new Error(
          `origin ${entry.origin} does not match its url (${source.origin})`
        );
      }
      if (seen.has(source.id)) throw new Error('duplicates an earlier source');
      seen.add(source.id);
      sources.push({
        ...source,
        // The id is derived, so a hand-edited one cannot collide or drift.
        label: cleanLabel(entry.label) || defaultLabel(source),
        enabled: entry.enabled !== false
      });
    } catch (error) {
      warnings.push(`${name} in ${MEETINGS_CONFIG_PATH} was skipped: ${error.message}`);
    }
  });
  if (raw.length > MAX_SOURCES) {
    warnings.push(`Only the first ${MAX_SOURCES} sources are read.`);
  }

  return { version: MEETINGS_CONFIG_VERSION, noteFolder, sources, raw, warnings, extra: parsed };
}

function emptyConfig() {
  return {
    version: MEETINGS_CONFIG_VERSION,
    noteFolder: DEFAULT_MEETING_FOLDER,
    sources: [],
    raw: [],
    warnings: [],
    extra: {}
  };
}

function cleanLabel(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL)
    : '';
}

function defaultLabel(source) {
  const host = new URL(source.origin).hostname;
  return `${host} ${source.kind} ${source.indicoId}`;
}

const configWrites = new Map();

/**
 * Adds or removes a source by rewriting the file atomically. Entries the
 * reader skipped are written back as they were, and a file that does not parse
 * is refused rather than replaced.
 */
export async function updateMeetingSources(
  workspace,
  change,
  sites = new Map()
) {
  const previous = configWrites.get(workspace.root) || Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(() => applySourceChange(workspace, change, sites));
  configWrites.set(workspace.root, write);
  try {
    return await write;
  } finally {
    if (configWrites.get(workspace.root) === write)
      configWrites.delete(workspace.root);
  }
}

async function applySourceChange(workspace, change, sites) {
  const config = await readMeetingsConfig(workspace, sites);
  if (config.broken) {
    throw new WorkspaceError(409, config.warnings[0]);
  }
  let raw = [...config.raw];

  if (change.add) {
    const source = parseMeetingSource(change.add.url, sites);
    if (config.sources.some((item) => item.id === source.id)) {
      throw new WorkspaceError(409, 'That source is already in the list.');
    }
    if (raw.length >= MAX_SOURCES) {
      throw new WorkspaceError(400, `A workspace can hold ${MAX_SOURCES} sources.`);
    }
    raw.push({
      id: source.id,
      label: cleanLabel(change.add.label) || defaultLabel(source),
      origin: source.origin,
      url: source.url,
      enabled: true
    });
  } else if (change.remove) {
    const before = raw.length;
    raw = raw.filter((entry) => {
      try {
        return parseMeetingSource(entry?.url, sites).id !== change.remove;
      } catch {
        return entry?.id !== change.remove;
      }
    });
    if (raw.length === before) {
      throw new WorkspaceError(404, 'No such source.');
    }
  } else {
    throw new WorkspaceError(400, 'Nothing to change.');
  }

  const next = {
    ...config.extra,
    version: MEETINGS_CONFIG_VERSION,
    noteFolder: config.extra.noteFolder ?? DEFAULT_MEETING_FOLDER,
    sources: raw
  };
  await writeAtomic(
    workspace,
    MEETINGS_CONFIG_PATH,
    `${JSON.stringify(next, null, 2)}\n`
  );
  return readMeetingsConfig(workspace, sites);
}

async function writeAtomic(workspace, filePath, content) {
  const absolute = await workspace.resolvePath(filePath, { forWrite: true });
  const temp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${randomUUID()}.tmp`
  );
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, absolute);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/** What the browser may know about a source: never the token, only whether one is set. */
export function publicSource(source, sites = new Map()) {
  return {
    id: source.id,
    label: source.label,
    origin: source.origin,
    url: source.url,
    kind: source.kind,
    enabled: source.enabled,
    configured: Boolean(tokenForOrigin(source.origin, sites)),
    tokenVariable: indicoTokenName(source.origin, sites)
  };
}

/* ------------------------------------------------------------------- fetching */

/**
 * Upcoming meetings from every enabled source, normalized, deduplicated by
 * origin and event id, and sorted by start. One failing source is reported
 * beside the others rather than failing the whole list. With `allowStale`, an
 * out-of-date copy is answered at once and marked `stale: true` while a new
 * one is fetched; `cacheDir` keeps copies across a restart.
 */
export async function listMeetings(
  sources,
  {
    sites = new Map(),
    fetchImpl = fetch,
    refresh = false,
    allowStale = false,
    cacheDir,
    now = Date.now,
    days = MEETING_WINDOW_DAYS
  } = {}
) {
  const enabled = sources.filter((source) => source.enabled);
  const window = meetingWindow(now(), days);
  const stale = allowStale && !refresh ? { served: false } : undefined;
  const terms = { refresh, cacheDir, stale, now };
  const results = await Promise.all(
    enabled.map(async (source) => {
      try {
        const events = await sourceEvents(source, window, {
          sites,
          fetchImpl,
          terms
        });
        return { source, events };
      } catch (error) {
        return { source, error };
      }
    })
  );

  const byKey = new Map();
  const statuses = [];
  for (const { source, events, error } of results) {
    const token = tokenForOrigin(source.origin, sites);
    if (error) {
      statuses.push({
        id: source.id,
        state: 'error',
        kind: error.kind || 'upstream',
        message: error.message || 'Indico request failed.'
      });
      continue;
    }

    const upcoming = events.filter((event) => event.endsAt >= window.cutoff);
    for (const event of upcoming) {
      const existing = byKey.get(event.key);
      if (existing) {
        if (!existing.sources.includes(source.id)) existing.sources.push(source.id);
      } else {
        byKey.set(event.key, { ...event, sources: [source.id] });
      }
    }
    statuses.push({
      id: source.id,
      state: upcoming.length ? 'ok' : 'empty',
      count: upcoming.length,
      // Without a token Indico answers a protected category or event with an
      // empty list, not a refusal, so an empty answer is the only hint.
      ...(upcoming.length || token
        ? {}
        : {
            kind: 'maybe_protected',
            message:
              source.kind === 'event'
                ? `Indico returned nothing for this event. If it is protected, set ${indicoTokenName(source.origin, sites)} and restart WebMD.`
                : `No upcoming meetings visible without a login. If this category is protected, set ${indicoTokenName(source.origin, sites)} and restart WebMD.`
          })
    });
  }

  const meetings = [...byKey.values()].sort(
    (a, b) => a.startsAt - b.startsAt || a.title.localeCompare(b.title)
  );
  // Joining is about the next day: only those meetings' pages are read.
  const soon = meetings
    .filter(
      (meeting) =>
        meeting.endsAt >= now() &&
        meeting.startsAt <= now() + ZOOM_LOOKAHEAD_MS &&
        !meeting.allDay &&
        meeting.endsAt - meeting.startsAt <= 12 * 60 * 60 * 1000
    )
    .slice(0, MAX_ZOOM_PAGES);
  await Promise.all(
    soon.map(async (meeting) => {
      const found = await eventPageZoom(meeting.origin, meeting.eventId, {
        sites,
        fetchImpl,
        ...terms
      });
      meeting.zoom = mergeZoom(meeting.zoom, found);
    })
  );
  return {
    from: new Date(window.cutoff).toISOString(),
    to: new Date(window.until).toISOString(),
    fetchedAt: new Date(now()).toISOString(),
    meetings: meetings.map(publicMeeting),
    statuses,
    ...(stale?.served ? { stale: true } : {})
  };
}

/**
 * Asks Indico for the past week and the coming fortnight with a day to spare
 * either side, in UTC, and leaves the browser to decide what "today" is: the
 * server and the reader need not share a timezone. Anything that ended before
 * the past week began is dropped here.
 */
export function meetingWindow(
  nowMs,
  days = MEETING_WINDOW_DAYS,
  pastDays = MEETING_PAST_DAYS
) {
  const day = 24 * 60 * 60 * 1000;
  const from = new Date(nowMs - (pastDays + 1) * day);
  const to = new Date(nowMs + (days + 1) * day);
  return {
    from: isoDate(from),
    to: isoDate(to),
    cutoff: nowMs - pastDays * day,
    until: nowMs + days * day
  };
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function sourceEvents(source, window, { sites, fetchImpl, terms }) {
  const token = tokenForOrigin(source.origin, sites);
  const params = new URLSearchParams(
    source.kind === 'category'
      ? {
          from: window.from,
          to: window.to,
          order: 'start',
          limit: String(CATEGORY_LIMIT)
        }
      : {}
  );
  // With a token, onlyauthed makes Indico refuse outright instead of quietly
  // answering with what an anonymous visitor would see.
  if (token) params.set('oa', 'yes');
  const exportPath = `/export/${source.kind === 'category' ? 'categ' : 'event'}/${source.indicoId}.json`;
  const body = await exportJson(source.origin, exportPath, params, {
    sites,
    fetchImpl,
    token,
    terms
  });
  return (Array.isArray(body?.results) ? body.results : [])
    .map((raw) => normalizeEvent(raw, source.origin))
    .filter(Boolean);
}

/**
 * One event with its agenda, for the detail pane and for a new note. Takes the
 * whole contribution list in one request; `occ=no` leaves out the per-day
 * occurrence table the view does not use. `allowStale` and `cacheDir` work as
 * in listMeetings.
 */
export async function fetchMeeting(
  origin,
  eventId,
  {
    sites = new Map(),
    fetchImpl = fetch,
    refresh = false,
    allowStale = false,
    cacheDir,
    now = Date.now
  } = {}
) {
  const stale = allowStale && !refresh ? { served: false } : undefined;
  const terms = { refresh, cacheDir, stale, now };
  if (!/^\d+$/.test(String(eventId ?? ''))) {
    throw new WorkspaceError(400, 'An Indico event id is required.');
  }
  const { origin: checked } = checkIndicoAddress(`${origin}/`, sites);
  const token = tokenForOrigin(checked, sites);
  const params = new URLSearchParams({ detail: 'contributions', occ: 'no' });
  if (token) params.set('oa', 'yes');
  const body = await exportJson(
    checked,
    `/export/event/${eventId}.json`,
    params,
    { sites, fetchImpl, token, terms }
  );
  const raw = Array.isArray(body?.results) ? body.results[0] : null;
  const event = raw && normalizeEvent(raw, checked);
  if (!event) {
    throw token
      ? new IndicoError(
          'not_found',
          `Indico has no event ${eventId} that ${indicoTokenName(checked, sites)} can see.`,
          404
        )
      : new IndicoError(
          'config',
          `Indico returned nothing for event ${eventId}. If it is protected, set ${indicoTokenName(checked, sites)} and restart WebMD.`,
          404
        );
  }
  const found = await eventPageZoom(checked, eventId, {
    sites,
    fetchImpl,
    ...terms
  });
  return {
    ...publicMeeting({ ...event, zoom: mergeZoom(event.zoom, found) }),
    agenda: normalizeAgenda(raw.contributions, checked, event.timezone),
    unscheduled: Array.isArray(raw.contributions)
      ? raw.contributions.filter((item) => !item?.startDate).length
      : 0,
    ...(stale?.served ? { stale: true } : {})
  };
}

/**
 * The Zoom room on an event's page, or null. The page is asked for with the
 * token first; a token scoped to the export API alone is turned away from
 * HTML views, and a public event's room is on its anonymous page too, so that
 * is tried next. Never fails the caller: a page that cannot be read just means
 * no Zoom from it. Cached like the exports, on the same terms (`refresh`,
 * `cacheDir`, and a `stale` tracker).
 */
export async function eventPageZoom(
  origin,
  eventId,
  { sites = new Map(), fetchImpl = fetch, ...terms } = {}
) {
  const url = `${origin}/event/${eventId}/`;
  const token = tokenForOrigin(origin, sites);
  const key = `zoom ${token ? 'auth' : 'anon'} ${url}`;
  return cached(key, terms, async () => {
    const read = (withToken) =>
      indicoFetch(url, {
        fetchImpl,
        sites,
        token: withToken,
        accept: 'text/html',
        timeoutMs: ZOOM_PAGE_TIMEOUT_MS
      }).then((response) => response.text());
    try {
      return pageZoom(await read(token));
    } catch (error) {
      if (!token || !['auth', 'redirect'].includes(error.kind)) return null;
    }
    try {
      return pageZoom(await read(''));
    } catch {
      return null;
    }
  });
}

/**
 * One cached, shared request per key. `terms` carries the caller's terms:
 * `refresh` asks again; `cacheDir` keeps answers across a restart, under
 * `folder`; `stale`, an object, accepts an out-of-date answer at once (setting
 * `stale.served`) while a new one is fetched behind it for the next caller.
 * The key is written into the file, so it must not be a secret.
 */
export async function cached(key, terms, load) {
  const {
    refresh = false,
    cacheDir,
    folder = 'indico',
    stale,
    now = Date.now
  } = terms || {};
  const file =
    cacheDir &&
    path.join(
      cacheDir,
      folder,
      `${createHash('sha1').update(key).digest('hex')}.json`
    );
  if (!refresh) {
    let hit = cache.get(key);
    if (!hit && file) {
      const saved = await readCacheFile(file);
      if (saved?.key === key && 'value' in saved) hit = remember(key, saved);
    }
    if (hit && hit.expiresAt > now()) return hit.value;
    const pending = inFlight.get(key);
    if (stale && hit && now() - hit.fetchedAt < STALE_MS) {
      // A failed revalidation keeps the copy for next time.
      if (!pending) fetchInto(key, load, file, now).catch(() => {});
      stale.served = true;
      return hit.value;
    }
    if (pending) return await pending;
  }
  return fetchInto(key, load, file, now);
}

function fetchInto(key, load, file, now) {
  const request = load()
    .then(async (value) => {
      const entry = { key, value, fetchedAt: now(), expiresAt: now() + CACHE_MS };
      remember(key, entry);
      if (file) {
        // Protected meetings (and their Zoom passcodes), and private
        // calendars, land here too.
        await writeCacheFile(file, entry, { mode: 0o600 });
        await pruneCacheDir(path.dirname(file));
      }
      return value;
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

function remember(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return entry;
}

/** Once per directory per process: files nobody has refreshed in a week go. */
async function pruneCacheDir(dir) {
  if (prunedDirs.has(dir)) return;
  prunedDirs.add(dir);
  try {
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      const { mtimeMs } = await fs.stat(file);
      if (Date.now() - mtimeMs > STALE_MS) await fs.rm(file, { force: true });
    }
  } catch {
    // Best effort: a leftover file is only a little disk.
  }
}

async function exportJson(origin, exportPath, params, options) {
  const query = params.toString();
  const url = `${origin}${exportPath}${query ? `?${query}` : ''}`;
  // Keyed with whether a token went along, so a list fetched anonymously is
  // never served as the authenticated one. A category's date window is left
  // out: it moves every day, and yesterday's list is a fine stand-in while
  // today's is fetched.
  const keyParams = new URLSearchParams(params);
  keyParams.delete('from');
  keyParams.delete('to');
  const keyQuery = keyParams.toString();
  const key = `${options.token ? 'auth' : 'anon'} ${origin}${exportPath}${keyQuery ? `?${keyQuery}` : ''}`;
  return cached(key, options.terms, async () => {
    const response = await indicoFetch(url, {
      fetchImpl: options.fetchImpl,
      sites: options.sites,
      token: options.token,
      accept: 'application/json'
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      // A sign-in page served with a 200 is the usual culprit.
      throw new IndicoError(
        options.token ? 'upstream' : 'config',
        options.token
          ? `${new URL(origin).hostname} did not answer with JSON.`
          : `${new URL(origin).hostname} did not answer with JSON; it may need a login. Set ${indicoTokenName(origin, options.sites)} and restart WebMD.`
      );
    }
  });
}

/* -------------------------------------------------------------- normalization */

/**
 * The application's own shape for an Indico event. Only what the view and the
 * note use, only from fields Indico actually sent: nothing is made up when a
 * field is missing. Times keep the event's own timezone beside an absolute
 * instant, so the browser can place them in its local day.
 */
export function normalizeEvent(raw, origin) {
  const eventId = String(raw?.id ?? '');
  if (!/^\d+$/.test(eventId)) return null;
  // A category export states times in the server's zone, not the event's, so
  // every time is re-read in the event's own zone: a Tokyo workshop listed by
  // CERN is at 09:00 Asia/Tokyo, not 02:00 Europe/Zurich.
  const timezone = validZone(raw.timezone) || validZone(raw.startDate?.tz) || 'UTC';
  const start = inZone(indicoTime(raw.startDate, timezone), timezone);
  if (!start) return null;
  const end = inZone(indicoTime(raw.endDate, timezone), timezone) || start;
  const title = decodeHtml(raw.title || '') || `Indico event ${eventId}`;

  return {
    key: meetingKey(origin, eventId),
    origin,
    eventId,
    url: `${origin}/event/${eventId}/`,
    title,
    type: typeof raw.type === 'string' ? raw.type : '',
    category: typeof raw.category === 'string' ? decodeHtml(raw.category) : '',
    timezone,
    start,
    end,
    startsAt: start.at,
    endsAt: Math.max(end.at, start.at),
    allDay: isAllDay(start, end),
    location: placeText(raw.location),
    room: placeText(raw.roomFullname) || placeText(raw.room),
    address: placeText(raw.address),
    description: htmlToText(raw.description).slice(0, MAX_DESCRIPTION),
    zoom: findZoom(raw),
    protected: raw.hasAnyProtection === true
  };
}

/** The same instant as wall-clock time in `tz`. */
function inZone(time, tz) {
  if (!time) return null;
  if (time.tz === tz) return time;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
      .formatToParts(new Date(time.at))
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    tz,
    at: time.at,
    iso: time.iso
  };
}

function publicMeeting(event) {
  const { startsAt: _s, endsAt: _e, ...rest } = event;
  return rest;
}

/** `https://indico.cern.ch/event/123/`: the one name a meeting has everywhere. */
export function meetingKey(origin, eventId) {
  return `${origin}/event/${eventId}/`;
}

function normalizeAgenda(contributions, origin, timezone) {
  if (!Array.isArray(contributions)) return [];
  return contributions
    .map((item) => {
      const start = inZone(indicoTime(item?.startDate, timezone), timezone);
      if (!start) return null;
      const end = inZone(indicoTime(item.endDate, timezone), timezone);
      const url = sameOriginUrl(item.url, origin);
      return {
        id: String(item.db_id ?? item.id ?? ''),
        title: decodeHtml(item.title || '') || 'Untitled contribution',
        start,
        end,
        startsAt: start.at,
        duration: Number.isFinite(item.duration) ? item.duration : null,
        speakers: (Array.isArray(item.speakers) ? item.speakers : [])
          .map(personName)
          .filter(Boolean),
        session: typeof item.session === 'string' ? decodeHtml(item.session) : '',
        room: placeText(item.roomFullname) || placeText(item.room),
        ...(url ? { url } : {})
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startsAt - b.startsAt || a.title.localeCompare(b.title))
    .slice(0, MAX_AGENDA)
    .map(({ startsAt: _s, ...rest }) => rest);
}

/** "First Last", from Indico's split fields or its "Last, First" full name. */
function personName(person) {
  if (!person || typeof person !== 'object') return '';
  const split = [person.first_name, person.last_name]
    .map((part) => decodeHtml(part || ''))
    .filter(Boolean)
    .join(' ');
  if (split) return split;
  const full = decodeHtml(person.fullName || '');
  const comma = /^([^,]+),\s*(.+)$/.exec(full);
  return comma ? `${comma[2]} ${comma[1]}` : full;
}

/** Only a link back to the same Indico is passed on; anything else is dropped. */
function sameOriginUrl(value, origin) {
  try {
    const url = new URL(String(value ?? ''), `${origin}/`);
    return url.origin === origin ? url.href : '';
  } catch {
    return '';
  }
}

function placeText(value) {
  return typeof value === 'string' ? decodeHtml(value) : '';
}

/** Readable text from an event description: paragraphs kept, markup dropped. */
export function htmlToText(html) {
  if (typeof html !== 'string' || !html.trim()) return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    // A link whose text is not its address keeps the address beside it.
    .replace(
      /<a\b[^>]*\bhref="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, text) =>
        decodeHtml(text.replace(/<[^>]+>/g, '')) === decodeHtml(href)
          ? href
          : `${text} (${href})`
    )
    // Inline tags sit inside words and sentences: "<b>analysis</b>." has no space.
    .replace(/<\/?(?:a|b|i|u|em|strong|span|font|code|small|sup|sub)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map((line) => decodeHtml(line))
    .filter(Boolean)
    .join('\n');
}

/**
 * `{ date, time, tz, at }` from Indico's `{ date, time, tz }`, where `at` is
 * the absolute instant in milliseconds. Indico states wall-clock time in the
 * named zone, so the offset is worked out for that date (daylight saving
 * included) rather than assumed.
 */
export function indicoTime(value, fallbackZone) {
  if (!value || typeof value !== 'object') return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value.date : '';
  if (!date) return null;
  const time = /^\d{2}:\d{2}/.test(value.time || '')
    ? value.time.slice(0, 5)
    : '00:00';
  const tz = validZone(value.tz) || validZone(fallbackZone) || 'UTC';
  const at = zonedToEpoch(date, time, tz);
  if (!Number.isFinite(at)) return null;
  return { date, time, tz, at, iso: new Date(at).toISOString() };
}

function validZone(zone) {
  if (typeof zone !== 'string' || !zone) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return '';
  }
}

export function zonedToEpoch(date, time, tz) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset even across a daylight-saving change.
  let at = guess - zoneOffset(guess, tz);
  at = guess - zoneOffset(at, tz);
  return at;
}

function zoneOffset(at, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value])
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/** Indico has no all-day flag; a day that runs midnight to 23:59 is one. */
function isAllDay(start, end) {
  return start.time === '00:00' && (end.time === '23:59' || end.time === '00:00') && end.at > start.at;
}

/* ---------------------------------------------------------------------- notes */

/**
 * Paths of notes already tied to a meeting, by meeting key. A note belongs to
 * a meeting through its `indico:` frontmatter, not its name, so the file can
 * be retitled (and renamed with it) and still be found.
 */
export function meetingNotes(files) {
  const notes = new Map();
  for (const [key, found] of meetingFiles(files)) {
    if (found.notePath) notes.set(key, found.notePath);
  }
  return notes;
}

/**
 * Everything the workspace holds for each meeting, by meeting key:
 * `{ notePath, recording, transcriptPath }`. A transcript is a note of its own
 * (`type: transcript`) carrying the same `indico:` link, so it never stands in
 * for the meeting's note. A recording is the note's `recording:` link, passed
 * on only when it is a web address.
 */
export function meetingFiles(files) {
  const found = new Map();
  const entry = (key) => {
    if (!found.has(key))
      found.set(key, { notePath: '', recording: '', transcriptPath: '' });
    return found.get(key);
  };
  for (const file of files) {
    const key = noteMeetingKey(file.metadata?.indico);
    if (!key) continue;
    const item = entry(key);
    if (file.metadata?.type === 'transcript') {
      item.transcriptPath ||= file.path;
    } else if (!item.notePath) {
      item.notePath = file.path;
      item.recording = webLink(file.metadata?.recording);
    }
  }
  return found;
}

/** An http(s) address, or '' for anything else a note's field might hold. */
export function webLink(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

/** The meeting key a note's `indico:` field names, tolerant of how it was typed. */
export function noteMeetingKey(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value.trim());
    const match = /^\/event\/(\d+)(?:\/|$)/.exec(url.pathname);
    if (url.protocol !== 'https:' || !match) return '';
    return meetingKey(url.origin, match[1]);
  } catch {
    return '';
  }
}

const noteWrites = new Map();

/**
 * Opens the note for a meeting, creating it the first time. Creation never
 * replaces a file: a name already taken falls back to one that names the
 * event, and a note already tied to the meeting is simply returned. Serialized
 * per workspace so two quick clicks cannot make two notes.
 */
export async function ensureMeetingNote(workspace, meeting, { noteFolder, day }) {
  const previous = noteWrites.get(workspace.root) || Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      // Checked again inside the queue: the call before this one may have just
      // created it (createFile refreshes the walk). Callers forget the cached
      // walk first, so notes moved outside WebMD are seen too.
      const existing = meetingNotes(await workspace.markdownFiles()).get(
        meeting.key
      );
      if (existing) return { path: existing, created: false };

      const folder = normalizeWorkspaceFolder(noteFolder || DEFAULT_MEETING_FOLDER);
      const names = meetingNoteNames(meeting);
      for (const { name, heading } of names) {
        const notePath = `${folder === '/' ? '' : folder}/${name}`;
        try {
          await workspace.createFile(
            notePath,
            meetingNoteMarkdown(meeting, heading, { day })
          );
          return { path: notePath, created: true };
        } catch (error) {
          if (error.status !== 409) throw error;
        }
      }
      throw new WorkspaceError(
        409,
        `Could not create a note for "${meeting.title}": ${names.map((item) => item.name).join(' and ')} already exist in ${folder}.`
      );
    });
  noteWrites.set(workspace.root, run);
  try {
    return await run;
  } finally {
    if (noteWrites.get(workspace.root) === run) noteWrites.delete(workspace.root);
  }
}

/**
 * File names to try, with the heading each implies. WebMD keeps a note's file
 * name on its heading, so the two always match: a later save does not rename
 * the note out from under the association, and a recurring meeting's weekly
 * notes differ by date.
 */
export function meetingNoteNames(meeting, suffix = '') {
  const base = `${meeting.title} (${meeting.start.date})${suffix}`;
  const fallback = `${meeting.title} (${meeting.start.date}, event ${meeting.eventId})${suffix}`;
  return [base, fallback]
    .map((heading) => ({ heading, name: titleFileName(heading) }))
    .filter((item) => item.name);
}

/**
 * The note a meeting starts with. After this it belongs to the user.
 *
 * `day` is the reader's own calendar day for the meeting, sent by the browser,
 * which is the day whose daily note it belongs in: a Geneva meeting at 08:00
 * is the evening before in California. The link points there, so the daily
 * note lists the meeting among its backlinks without WebMD writing into it.
 */
export function meetingNoteMarkdown(
  meeting,
  heading = `${meeting.title} (${meeting.start.date})`,
  { day } = {}
) {
  const lines = [
    '---',
    'type: meeting',
    `indico: ${meeting.key}`,
    `date: ${meeting.start.date}`,
    'tags: [meeting]',
    '---',
    '',
    `# ${heading.replace(/\s+/g, ' ').trim()}`,
    '',
    `- **When:** ${noteWhen(meeting)}`,
    `- **Day:** [[${/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') ? day : meeting.start.date}]]`,
    `- **Indico:** <${meeting.url}>`
  ];
  const place = [meeting.room, meeting.location].filter(Boolean);
  if (place.length) lines.push(`- **Where:** ${escapeInline([...new Set(place)].join(', '))}`);
  if (meeting.zoom?.url) {
    const passcode = meeting.zoom.passcode
      ? ` (passcode ${escapeInline(meeting.zoom.passcode)})`
      : '';
    lines.push(`- **Zoom:** <${meeting.zoom.url}>${passcode}`);
  }

  const agenda = meeting.agenda || [];
  if (agenda.length) {
    lines.push('', '## Agenda', '');
    for (const item of agenda) {
      const time = item.start.date === meeting.start.date
        ? item.start.time
        : `${item.start.date} ${item.start.time}`;
      const title = item.url
        ? `[${escapeLinkText(item.title)}](${item.url})`
        : escapeInline(item.title);
      const speakers = item.speakers.length
        ? ` — ${escapeInline(item.speakers.join(', '))}`
        : '';
      lines.push(`- ${time} ${title}${speakers}`);
    }
  }

  // Action items starts empty: a blank "- [ ]" would be an open task with no
  // text in the Tasks view for every meeting note.
  lines.push('', '## Notes', '', '', '## Action items', '', '');
  return lines.join('\n');
}

function noteWhen(meeting) {
  const { start, end, timezone } = meeting;
  if (meeting.allDay) {
    return start.date === end.date
      ? `${start.date} (all day)`
      : `${start.date} – ${end.date}`;
  }
  const until = end.date === start.date ? end.time : `${end.date} ${end.time}`;
  return `${start.date} ${start.time} – ${until} (${timezone})`;
}

export function escapeInline(text) {
  return String(text).replace(/([\\`*_[\]<>|])/g, '\\$1');
}

function escapeLinkText(text) {
  return String(text).replace(/([\\[\]])/g, '\\$1');
}

/** Test seam: the module-level caches outlive a single test. */
export function resetMeetingsCache() {
  cache.clear();
  inFlight.clear();
}
