import { htmlToText, webLink, zonedToEpoch } from './meetings.js';
import { WorkspaceError } from './workspace.js';

/**
 * Google Calendar (or any iCal feed) on the daily-notes calendar, read from the
 * feed's secret address: Google Calendar → Settings → your calendar →
 * "Secret address in iCal format". No OAuth, no API key.
 *
 * `GOOGLE_CALENDAR_ICS` in the environment or ~/.webmd.conf holds one or more
 * addresses separated by spaces. The address is a password in all but name, so
 * it stays in this process; the browser only gets the events.
 */
export function calendarFeeds(env = process.env) {
  return String(env.GOOGLE_CALENDAR_ICS || '')
    .split(/\s+/)
    .map((value) => value.replace(/^webcal:/i, 'https:'))
    .filter((value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    });
}

const CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const DAY = 24 * 60 * 60 * 1000;
const cache = new Map();

/** Every occurrence in the feeds that touches [from, to), sorted by start. */
export async function calendarEvents(
  feeds,
  { from, to, fetchImpl = fetch, refresh = false }
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new WorkspaceError(400, 'from and to must be YYYY-MM-DD dates.');
  }
  // A day either side: the browser, not the server, decides which local day
  // an event falls on.
  const window = {
    from: Date.parse(`${from}T00:00:00Z`) - DAY,
    to: Date.parse(`${to}T00:00:00Z`) + DAY
  };
  if (!(window.to > window.from) || window.to - window.from > 100 * DAY) {
    throw new WorkspaceError(
      400,
      'Ask for at most about three months at once.'
    );
  }
  const results = await Promise.all(
    feeds.map(async (feed) => {
      try {
        const events = await feedEvents(feed, { fetchImpl, refresh });
        return { occurrences: expandEvents(events, window) };
      } catch (error) {
        return { error: error.message || 'Calendar request failed.' };
      }
    })
  );
  return {
    events: results
      .flatMap((result) => result.occurrences || [])
      .sort((a, b) => a.sortAt - b.sortAt || a.title.localeCompare(b.title))
      .map(({ sortAt: _s, ...event }) => event),
    errors: results.map((result) => result.error).filter(Boolean)
  };
}

async function feedEvents(feed, { fetchImpl, refresh }) {
  const hit = cache.get(feed);
  if (!refresh && hit && hit.expiresAt > Date.now()) return hit.events;
  let response;
  try {
    response = await fetchImpl(feed, {
      headers: { accept: 'text/calendar' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch {
    // Never echo the address: it is the credential.
    throw new Error(`${new URL(feed).hostname} did not answer.`);
  }
  if (!response.ok) {
    throw new Error(
      `${new URL(feed).hostname} answered ${response.status}. Check GOOGLE_CALENDAR_ICS is the secret (not public) iCal address, and restart WebMD after changing it.`
    );
  }
  const events = parseIcs(await response.text());
  cache.set(feed, { events, expiresAt: Date.now() + CACHE_MS });
  return events;
}

/* ------------------------------------------------------------------ parsing */

/** The VEVENTs of an iCal file, with only the properties the calendar uses. */
export function parseIcs(text) {
  const lines = String(text)
    .replace(/\r?\n[ \t]/g, '')
    .split(/\r?\n/);
  const events = [];
  const stack = [];
  let event = null;
  for (const line of lines) {
    const { name, params, value } = parseLine(line);
    if (name === 'BEGIN') {
      stack.push(value);
      if (value === 'VEVENT' && stack.length === 2) {
        event = { exdates: [], attendees: [] };
      }
      continue;
    }
    if (name === 'END') {
      if (value === 'VEVENT' && event && stack.length === 2) {
        if (event.start) events.push(event);
        event = null;
      }
      stack.pop();
      continue;
    }
    // Only the event's own lines: an alarm inside it has a DESCRIPTION too.
    if (!event || stack.at(-1) !== 'VEVENT') continue;
    if (name === 'UID') event.uid = value;
    else if (name === 'SUMMARY') event.title = unescapeText(value);
    else if (name === 'LOCATION') event.location = unescapeText(value);
    else if (name === 'DESCRIPTION') event.description = unescapeText(value);
    else if (name === 'URL') event.url = value;
    else if (name === 'ORGANIZER') event.organizer = personName(params, value);
    else if (name === 'ATTENDEE' && event.attendees.length < MAX_ATTENDEES) {
      event.attendees.push(personName(params, value));
    } else if (name === 'X-GOOGLE-CONFERENCE') event.conference = value;
    else if (name === 'STATUS') event.status = value.toUpperCase();
    else if (name === 'RRULE') event.rrule = value;
    else if (name === 'DURATION') event.duration = value;
    else if (name === 'DTSTART') event.start = icsTime(value, params);
    else if (name === 'DTEND') event.end = icsTime(value, params);
    else if (name === 'RECURRENCE-ID')
      event.recurrenceId = icsTime(value, params);
    else if (name === 'EXDATE') {
      for (const part of value.split(',')) {
        const time = icsTime(part, params);
        if (time) event.exdates.push(time);
      }
    }
  }
  return events;
}

function parseLine(line) {
  // The first colon outside quotes ends the parameters: TZID="a:b" is one.
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    else if (line[index] === ':' && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon < 0) return { name: '', params: {}, value: '' };
  const [name, ...rest] = line.slice(0, colon).split(';');
  const params = {};
  for (const part of rest) {
    const equals = part.indexOf('=');
    if (equals > 0) {
      params[part.slice(0, equals).toUpperCase()] = part
        .slice(equals + 1)
        .replace(/^"|"$/g, '');
    }
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** The CN a calendar gives a person, else their address without mailto:. */
function personName(params, value) {
  return params.CN || value.replace(/^mailto:/i, '');
}

function unescapeText(value) {
  return value.replace(/\\([nN,;\\])/g, (_, char) =>
    char === 'n' || char === 'N' ? '\n' : char
  );
}

/**
 * `{ allDay, date, time, tz, at }`. `at` is the instant for a timed value and
 * UTC midnight for a date, which keeps date arithmetic free of daylight saving.
 */
export function icsTime(value, params = {}) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z?))?$/.exec(
    String(value).trim()
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, utc] = match;
  const date = `${year}-${month}-${day}`;
  if (hour === undefined) {
    return { allDay: true, date, at: Date.parse(`${date}T00:00:00Z`) };
  }
  // ponytail: IANA zone names only (what Google writes); an Outlook invite's
  // "Pacific Standard Time" falls back to the server's zone. Map Windows
  // names here if such invites land an hour off.
  const tz = utc ? 'UTC' : validZone(params.TZID) || localZone();
  const time = `${hour}:${minute}`;
  return { allDay: false, date, time, tz, at: zonedToEpoch(date, time, tz) };
}

function validZone(zone) {
  if (!zone) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return '';
  }
}

function localZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/* ---------------------------------------------------------------- expansion */

const MAX_OCCURRENCES_PER_EVENT = 1000;
const MAX_ATTENDEES = 50;
const MAX_DESCRIPTION = 4000;

/**
 * Occurrences touching `window` ({ from, to } in ms): one-off events, every
 * instance of a recurring one that is not excluded or moved, and the moved
 * instances themselves. Cancelled ones are left out.
 */
export function expandEvents(events, window) {
  // A moved or cancelled instance of a series is its own VEVENT carrying the
  // series' UID and the start it replaces.
  const replaced = new Set();
  for (const event of events) {
    if (event.recurrenceId && event.uid) {
      replaced.add(`${event.uid} ${event.recurrenceId.at}`);
    }
  }

  const found = [];
  for (const event of events) {
    if (event.status === 'CANCELLED') continue;
    const length = eventLength(event);
    const starts =
      event.rrule && !event.recurrenceId
        ? recurrenceStarts(event, window.from - Math.max(length, 1), window.to)
        : [event.start];
    const skipped = new Set(event.exdates.map((time) => time.at));
    for (const start of starts) {
      if (skipped.has(start.at)) continue;
      if (
        event.rrule &&
        !event.recurrenceId &&
        replaced.has(`${event.uid} ${start.at}`)
      )
        continue;
      if (
        start.at >= window.to ||
        start.at + Math.max(length, 1) <= window.from
      )
        continue;
      found.push(occurrence(event, start, length));
    }
  }
  return found;
}

function eventLength(event) {
  if (event.end && event.end.at > event.start.at)
    return event.end.at - event.start.at;
  const match =
    /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      event.duration || ''
    );
  if (match) {
    const [, w = 0, d = 0, h = 0, m = 0, s = 0] = match.map(Number);
    const ms = ((((w * 7 + d) * 24 + h) * 60 + m) * 60 + s) * 1000;
    if (ms > 0) return ms;
  }
  return event.start.allDay ? DAY : 0;
}

function occurrence(event, start, length) {
  const base = {
    title: event.title || '(No title)',
    allDay: start.allDay,
    location: event.location || '',
    url: eventLink(event),
    // Google writes HTML descriptions for events made on the web.
    description: htmlToText(event.description || '').slice(0, MAX_DESCRIPTION),
    organizer: event.organizer || '',
    attendees: event.attendees,
    sortAt: start.at
  };
  if (start.allDay) {
    return {
      ...base,
      date: start.date,
      // Exclusive, as in iCal: a one-day event ends the next day.
      endDate: isoDay(start.at + Math.max(length, DAY))
    };
  }
  return {
    ...base,
    startsAt: new Date(start.at).toISOString(),
    endsAt: new Date(start.at + length).toISOString()
  };
}

/** Where to join: the Meet room, else a link in the location or description. */
function eventLink(event) {
  const candidates = [
    event.conference,
    ...(event.location?.match(/https?:\/\/\S+/g) || []),
    ...(event.description?.match(
      /https?:\/\/[^\s<>"]*(?:zoom\.us|zoomgov\.com|meet\.google\.com|teams\.microsoft\.com)[^\s<>"]*/gi
    ) || []),
    event.url
  ];
  for (const candidate of candidates) {
    const link = webLink(candidate || '');
    if (link) return link;
  }
  return '';
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * The starts of a recurring event in [from, until] (ms).
 * Dates are stepped as civil days and each is placed in the event's own zone,
 * so a 10:00 weekly stays at 10:00 across daylight saving.
 *
 * ponytail: covers what Google's repeat menu writes (FREQ, INTERVAL, COUNT,
 * UNTIL, BYDAY with ordinals, BYMONTHDAY, BYMONTH, WKST). A rule with
 * BYSETPOS, BYYEARDAY, BYWEEKNO or BYHOUR shows its first instance only;
 * reach for ical.js if such feeds turn up.
 */
export function recurrenceStarts(event, from, until) {
  const rule = Object.fromEntries(
    event.rrule.split(';').map((part) => {
      const [key, value = ''] = part.split('=');
      return [key.toUpperCase(), value.toUpperCase()];
    })
  );
  const { start } = event;
  const unsupported = [
    'BYSETPOS',
    'BYYEARDAY',
    'BYWEEKNO',
    'BYHOUR',
    'BYMINUTE',
    'BYSECOND'
  ];
  const freq = rule.FREQ;
  if (
    !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq) ||
    unsupported.some((key) => key in rule)
  ) {
    return [start];
  }

  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = Number(rule.COUNT) || Infinity;
  const ruleUntil = rule.UNTIL ? icsTime(rule.UNTIL, { TZID: start.tz }) : null;
  const byDay = (rule.BYDAY ? rule.BYDAY.split(',') : [])
    .map((item) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item))
    .filter(Boolean)
    .map(([, n, day]) => ({ n: Number(n) || 0, day: WEEKDAYS.indexOf(day) }));
  const byMonthDay = (rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',') : [])
    .map(Number)
    .filter(Boolean);
  const byMonth = (rule.BYMONTH ? rule.BYMONTH.split(',') : [])
    .map(Number)
    .filter(Boolean);
  const weekStart = WEEKDAYS.indexOf(rule.WKST || 'MO');

  const first = new Date(Date.parse(`${start.date}T00:00:00Z`));
  const starts = [];
  const limit = ruleUntil
    ? Math.min(until, ruleUntil.at + (ruleUntil.allDay ? DAY - 1 : 0))
    : until;
  let seen = 0;

  // Enough periods for a daily series thirty years old.
  for (let period = 0; period < 12000; period += 1) {
    const days = periodDays(freq, period * interval, first, {
      byDay,
      byMonthDay,
      byMonth,
      weekStart
    });
    for (const day of days) {
      if (day < first) continue;
      const date = day.toISOString().slice(0, 10);
      if (byMonth.length && !byMonth.includes(day.getUTCMonth() + 1)) continue;
      const next = start.allDay
        ? { allDay: true, date, at: day.getTime() }
        : { ...start, date, at: zonedToEpoch(date, start.time, start.tz) };
      // COUNT counts from DTSTART, so instances before the window still count.
      seen += 1;
      if (
        next.at > limit ||
        seen > count ||
        starts.length >= MAX_OCCURRENCES_PER_EVENT
      ) {
        return starts;
      }
      if (next.at >= from) starts.push(next);
    }
  }
  return starts;
}

/** The candidate civil days (UTC Dates) in the `offset`-th period of the rule. */
function periodDays(
  freq,
  offset,
  first,
  { byDay, byMonthDay, byMonth, weekStart }
) {
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth();
  const d = first.getUTCDate();
  if (freq === 'DAILY') {
    const day = new Date(Date.UTC(y, m, d + offset));
    const weekdays = byDay.map((item) => item.day);
    if (weekdays.length && !weekdays.includes(day.getUTCDay())) return [];
    if (byMonthDay.length && !matchesMonthDay(day, byMonthDay)) return [];
    return [day];
  }
  if (freq === 'WEEKLY') {
    const back = (first.getUTCDay() - weekStart + 7) % 7;
    const weekdays = byDay.length
      ? byDay.map((item) => item.day)
      : [first.getUTCDay()];
    return weekdays
      .map(
        (weekday) =>
          new Date(
            Date.UTC(
              y,
              m,
              d - back + offset * 7 + ((weekday - weekStart + 7) % 7)
            )
          )
      )
      .sort((a, b) => a - b);
  }
  const months =
    freq === 'MONTHLY'
      ? [new Date(Date.UTC(y, m + offset, 1))]
      : (byMonth.length ? byMonth : [m + 1]).map(
          (month) => new Date(Date.UTC(y + offset, month - 1, 1))
        );
  return months
    .flatMap((month) => monthDays(month, first, { byDay, byMonthDay }))
    .sort((a, b) => a - b);
}

function monthDays(month, first, { byDay, byMonthDay }) {
  const y = month.getUTCFullYear();
  const m = month.getUTCMonth();
  const length = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const all = Array.from(
    { length },
    (_, index) => new Date(Date.UTC(y, m, index + 1))
  );
  if (byMonthDay.length)
    return all.filter((day) => matchesMonthDay(day, byMonthDay));
  if (byDay.length) {
    return all.filter((day) =>
      byDay.some((item) => {
        if (item.day !== day.getUTCDay()) return false;
        if (!item.n) return true;
        const nth =
          item.n > 0
            ? Math.ceil(day.getUTCDate() / 7)
            : -Math.ceil((length - day.getUTCDate() + 1) / 7);
        return nth === item.n;
      })
    );
  }
  // Monthly on the 31st skips months without one, as Google does.
  return all.filter((day) => day.getUTCDate() === first.getUTCDate());
}

function matchesMonthDay(day, byMonthDay) {
  const length = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const date = day.getUTCDate();
  return byMonthDay.some((n) => (n > 0 ? n === date : length + n + 1 === date));
}

function isoDay(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/** Test seam: the feed cache outlives a single test. */
export function resetCalendarCache() {
  cache.clear();
}
