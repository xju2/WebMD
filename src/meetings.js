// Browser-side helpers for the Meetings view. The server sends each meeting's
// start and end as absolute instants beside the event's own timezone; these
// helpers place them in the workspace's meeting time zone (the reader's local
// time when none is given), which is what "Today" means in the list.

export const MEETING_SECTIONS = [
  { id: 'ongoing', label: 'Ongoing' },
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'week', label: 'This week' },
  { id: 'next-week', label: 'Next week' },
  { id: 'later', label: 'Later' },
  // Last, newest first: where a recording and transcript get attached.
  { id: 'past', label: 'Past week' }
];

// A Zoom meeting opens its waiting room a little early, and people join then.
export const JOIN_LEAD_MS = 15 * 60 * 1000;

// Where the Meetings view reads its times when the workspace sets no zone.
export const DEFAULT_MEETING_TIME_ZONE = 'America/Los_Angeles';

/** `timeZone` if the browser knows it, else '' (the reader's local time). */
export function validTimeZone(timeZone) {
  if (!timeZone) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return '';
  }
}

/** `PDT` or `GMT+2`: the zone's short name at `ms`, for the toolbar. */
export function zoneName(timeZone, ms = Date.now()) {
  try {
    return (
      new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
        .formatToParts(ms)
        .find((part) => part.type === 'timeZoneName')?.value || timeZone
    );
  } catch {
    return timeZone;
  }
}

/** The calendar date and weekday `ms` falls on in `timeZone`, or locally. */
function calendarDate(ms, timeZone) {
  if (!timeZone) {
    const date = new Date(ms);
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), weekday: date.getDay() };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value])
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** How far `timeZone`'s wall clock runs ahead of UTC at `ms`. */
function zoneOffset(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value])
  );
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** The instant midnight begins on a calendar date, in `timeZone` or locally. */
function midnight(year, month, day, timeZone) {
  if (!timeZone) return new Date(year, month - 1, day).getTime();
  const wall = Date.UTC(year, month - 1, day);
  // Twice, so a date whose offset differs from the guess (a DST switch) settles.
  let at = wall - zoneOffset(wall, timeZone);
  at = wall - zoneOffset(at, timeZone);
  return at;
}

export function startOfDay(ms, timeZone = '') {
  const { year, month, day } = calendarDate(ms, timeZone);
  return midnight(year, month, day, timeZone);
}

function addDays(ms, days, timeZone = '') {
  const { year, month, day } = calendarDate(ms, timeZone);
  // Date.UTC rolls a day past the month's end over, so the date stays valid.
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
}

/** Midnight at the start of the Monday after the week holding `ms`. */
function endOfWeek(ms, timeZone = '') {
  const { weekday } = calendarDate(ms, timeZone); // 0 = Sunday
  return addDays(ms, weekday === 0 ? 1 : 8 - weekday, timeZone);
}

export function meetingStart(meeting) {
  return Date.parse(meeting?.start?.iso ?? '');
}

export function meetingEnd(meeting) {
  const end = Date.parse(meeting?.end?.iso ?? '');
  const start = meetingStart(meeting);
  return Number.isFinite(end) && end > start ? end : start;
}

/**
 * Which section a meeting sits in, by the reader's local calendar. A meeting
 * that began before today and is still running is Ongoing, so a year-long
 * "event" does not crowd the top of Today every morning. One that finished
 * before today began is Past; the server only sends the last week of those.
 */
export function meetingSection(meeting, now = Date.now(), { timeZone = '' } = {}) {
  const start = meetingStart(meeting);
  const end = meetingEnd(meeting);
  if (!Number.isFinite(start)) return '';
  const today = startOfDay(now, timeZone);
  if (end < today) return 'past';
  if (start < today) return 'ongoing';
  if (start < addDays(now, 1, timeZone)) return 'today';
  if (start < addDays(now, 2, timeZone)) return 'tomorrow';
  const weekEnd = endOfWeek(now, timeZone);
  if (start < weekEnd) return 'week';
  if (start < addDays(weekEnd, 7, timeZone)) return 'next-week';
  return 'later';
}

/** Non-empty sections in order, each `{ id, label, meetings }`. */
export function groupMeetings(meetings, now = Date.now(), options = {}) {
  const buckets = new Map(MEETING_SECTIONS.map((section) => [section.id, []]));
  for (const meeting of meetings || []) {
    const id = meetingSection(meeting, now, options);
    if (id) buckets.get(id).push(meeting);
  }
  return MEETING_SECTIONS.map((section) => ({
    ...section,
    meetings: buckets
      .get(section.id)
      .sort((a, b) =>
        section.id === 'past'
          ? meetingStart(b) - meetingStart(a)
          : meetingStart(a) - meetingStart(b)
      )
  })).filter((section) => section.meetings.length);
}

/**
 * Where a meeting stands for joining it: `live` from a quarter of an hour
 * before it starts until it ends, `upcoming` before that, `over` after. A
 * meeting with no Zoom link has nothing to join, so it is ''.
 */
export function joinState(meeting, now = Date.now()) {
  if (!meeting?.zoom?.url) return '';
  const start = meetingStart(meeting);
  if (!Number.isFinite(start)) return '';
  if (now < start - JOIN_LEAD_MS) return 'upcoming';
  return now <= meetingEnd(meeting) ? 'live' : 'over';
}

/** Recordings and transcripts only exist once a meeting has begun. */
export function meetingBegun(meeting, now = Date.now()) {
  const start = meetingStart(meeting);
  return Number.isFinite(start) && now >= start;
}

/** `123 4567 8901`, the way Zoom writes a meeting number. */
export function zoomMeetingId(id = '') {
  const digits = String(id).replace(/\D/g, '');
  if (digits.length === 11) return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return digits;
}

/** The calendar day a meeting starts on in `timeZone` (or locally), as YYYY-MM-DD. */
export function meetingLocalDay(meeting, { timeZone = '' } = {}) {
  const start = meetingStart(meeting);
  if (!Number.isFinite(start)) return '';
  const { year, month, day } = calendarDate(start, timeZone);
  return [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
}

/** A note path as its name, for a link that opens it. */
export function noteName(path = '') {
  return String(path).split('/').pop().replace(/\.md$/i, '');
}

/** Meetings from one source, or from every source when `sourceId` is empty. */
export function filterMeetings(meetings, sourceId = '') {
  if (!sourceId) return meetings || [];
  return (meetings || []).filter((meeting) =>
    (meeting.sources || []).includes(sourceId)
  );
}

function formatter(options, timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    ...options,
    ...(timeZone ? { timeZone } : {})
  });
}

const DAY_OPTIONS = { weekday: 'short', day: 'numeric', month: 'short' };
const TIME_OPTIONS = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

/**
 * `{ day, time, full, zoned }` for the list and the detail pane, in
 * `timeZone` (local time when none is given). `day` and `time` are the list's two short lines; `full` is the one
 * line the detail pane shows. `zoned` repeats `full` in the event's own zone
 * when that reads differently, so a Geneva meeting seen from Chicago still
 * shows the time the agenda talks about. A meeting over several days says so
 * rather than showing a start and end time that look like one afternoon.
 */
export function describeMeetingTime(meeting, { timeZone } = {}) {
  const start = meetingStart(meeting);
  const end = meetingEnd(meeting);
  if (!Number.isFinite(start)) return { day: '', time: '', full: '', zoned: '' };
  const local = spanText(start, end, meeting.allDay, timeZone);

  const eventZone = meeting.timezone || meeting.start?.tz || '';
  let zoned = '';
  if (eventZone && !meeting.allDay) {
    try {
      const own = spanText(start, end, false, eventZone);
      if (own.full !== local.full) zoned = `${own.full} ${eventZone}`;
    } catch {
      zoned = '';
    }
  }
  return { ...local, zoned };
}

function spanText(start, end, allDay, timeZone) {
  const dayFormat = formatter(DAY_OPTIONS, timeZone);
  const timeFormat = formatter(TIME_OPTIONS, timeZone);
  const startDay = dayFormat.format(start);
  const endDay = dayFormat.format(end);
  if (startDay === endDay || end === start) {
    const time = allDay
      ? 'All day'
      : `${timeFormat.format(start)}–${timeFormat.format(end)}`;
    return { day: startDay, time, full: `${startDay} · ${time}` };
  }
  const days = calendarDays(start, end, timeZone);
  return {
    day: `${startDay} – ${endDay}`,
    time: `${days} days`,
    full: allDay
      ? `${startDay} – ${endDay}`
      : `${startDay}, ${timeFormat.format(start)} – ${endDay}, ${timeFormat.format(end)}`
  };
}

/** How many calendar days a span touches in `timeZone`, counting both ends. */
function calendarDays(start, end, timeZone) {
  const key = (ms) => {
    const parts = Object.fromEntries(
      formatter({ year: 'numeric', month: 'numeric', day: 'numeric' }, timeZone)
        .formatToParts(ms)
        .map((part) => [part.type, part.value])
    );
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  };
  return Math.round((key(end) - key(start)) / 86400000) + 1;
}

/** An agenda entry's local start time, with its day when that differs. */
export function describeAgendaTime(item, meeting, { timeZone } = {}) {
  const start = Date.parse(item?.start?.iso ?? '');
  if (!Number.isFinite(start)) return '';
  const time = formatter(TIME_OPTIONS, timeZone).format(start);
  const dayFormat = formatter(DAY_OPTIONS, timeZone);
  const meetingDay = dayFormat.format(meetingStart(meeting));
  const itemDay = dayFormat.format(start);
  return itemDay === meetingDay ? time : `${itemDay} ${time}`;
}

/** `11 Sep – 25 Sep` for the toolbar. */
export function describeRange(from, to, { timeZone } = {}) {
  const start = Date.parse(from ?? '');
  const end = Date.parse(to ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const format = formatter({ day: 'numeric', month: 'short' }, timeZone);
  // The server asks from a day back to cover every timezone; the list itself
  // starts today.
  return `${format.format(Math.max(start, startOfDay(Date.now(), timeZone)))} – ${format.format(end)}`;
}

export function meetingPlace(meeting) {
  const parts = [meeting?.room, meeting?.location].filter(Boolean);
  return [...new Set(parts)].join(', ');
}

/**
 * What to say about one source, as `{ tone, kind, text }` or null when all is
 * well. Tones: `error` for something that stops a source (a rejected token, a
 * dead network), `hint` for something worth knowing (an empty protected
 * category).
 */
export function sourceNotice(status, source) {
  if (!status || status.state === 'ok') return null;
  const name = source?.label || status.id;
  if (status.state === 'error') {
    return { tone: 'error', kind: status.kind, names: [name], message: status.message, text: `${name}: ${status.message}` };
  }
  if (status.kind === 'maybe_protected') {
    return { tone: 'hint', kind: status.kind, names: [name], message: status.message, text: `${name}: ${status.message}` };
  }
  return null;
}

/**
 * Notices for every source, with sources that failed for the same reason
 * said once: one expired token breaks every source on its Indico, and three
 * copies of the same sentence would bury the fix.
 */
export function sourceNotices(statuses, sourceById = new Map()) {
  const merged = new Map();
  for (const status of statuses || []) {
    const notice = sourceNotice(status, sourceById.get(status.id));
    if (!notice) continue;
    const key = `${notice.tone}|${notice.kind}|${notice.message}`;
    const existing = merged.get(key);
    if (existing) existing.names.push(...notice.names);
    else merged.set(key, notice);
  }
  return [...merged.values()].map((notice) => ({
    ...notice,
    text: `${notice.names.join(', ')}: ${notice.message}`
  }));
}

/** Stays in the list while nothing is chosen; narrow panes show one at a time. */
export function meetingsPane({ compact, detailOpen }) {
  if (!compact) return 'both';
  return detailOpen ? 'detail' : 'list';
}

/** The last choice, if it is still in the list; otherwise nothing. */
export function keepSelection(meetings, key) {
  return (meetings || []).some((meeting) => meeting.key === key) ? key : '';
}
