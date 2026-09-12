// Browser-side helpers for the Meetings view. The server sends each meeting's
// start and end as absolute instants beside the event's own timezone; these
// helpers place them in the reader's local day, which is what "Today" means
// to the person looking at the list.

export const MEETING_SECTIONS = [
  { id: 'ongoing', label: 'Ongoing' },
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'week', label: 'This week' },
  { id: 'next-week', label: 'Next week' },
  { id: 'later', label: 'Later' }
];

export function startOfDay(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function addDays(ms, days) {
  const date = new Date(ms);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days
  ).getTime();
}

/** Local midnight at the start of the Monday after the week holding `ms`. */
function endOfWeek(ms) {
  const day = new Date(ms).getDay(); // 0 = Sunday
  return addDays(startOfDay(ms), day === 0 ? 1 : 8 - day);
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
 * "event" does not crowd the top of Today every morning. Returns '' for one
 * that finished before today began.
 */
export function meetingSection(meeting, now = Date.now()) {
  const start = meetingStart(meeting);
  const end = meetingEnd(meeting);
  if (!Number.isFinite(start)) return '';
  const today = startOfDay(now);
  if (end < today) return '';
  if (start < today) return 'ongoing';
  const tomorrow = addDays(today, 1);
  if (start < tomorrow) return 'today';
  if (start < addDays(today, 2)) return 'tomorrow';
  const weekEnd = endOfWeek(now);
  if (start < weekEnd) return 'week';
  if (start < addDays(weekEnd, 7)) return 'next-week';
  return 'later';
}

/** Non-empty sections in order, each `{ id, label, meetings }`. */
export function groupMeetings(meetings, now = Date.now()) {
  const buckets = new Map(MEETING_SECTIONS.map((section) => [section.id, []]));
  for (const meeting of meetings || []) {
    const id = meetingSection(meeting, now);
    if (id) buckets.get(id).push(meeting);
  }
  return MEETING_SECTIONS.map((section) => ({
    ...section,
    meetings: buckets
      .get(section.id)
      .sort((a, b) => meetingStart(a) - meetingStart(b))
  })).filter((section) => section.meetings.length);
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
 * `{ day, time, full, zoned }` for the list and the detail pane, in local
 * time. `day` and `time` are the list's two short lines; `full` is the one
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
  return `${format.format(Math.max(start, startOfDay(Date.now())))} – ${format.format(end)}`;
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
