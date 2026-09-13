import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import {
  calendarEvents,
  calendarFeeds,
  expandEvents,
  parseIcs,
  resetCalendarCache
} from '../server/gcal.js';
import { eventsByDay, eventTimeRange, linkParts } from '../src/calendar.js';

test.beforeEach(() => resetCalendarCache());

const FEED =
  'https://calendar.google.com/calendar/ical/me%40gmail.com/private-SECRET/basic.ics';

// Shaped like Google's export: CRLF, folded lines, a VTIMEZONE, an alarm
// inside an event, a weekly series with a moved, an excluded and a cancelled
// instance, and an all-day event.
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:America/Los_Angeles',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/Los_Angeles:20261022T100000',
  'DTEND;TZID=America/Los_Angeles:20261022T103000',
  'RRULE:FREQ=WEEKLY;BYDAY=TH',
  'EXDATE;TZID=America/Los_Angeles:20261105T100000',
  'UID:weekly@google.com',
  'SUMMARY:Group sync\\, weekly',
  'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
  'DESCRIPTION:Join at https://meet.google.com/abc-defg-hij and bring',
  '  slides',
  'BEGIN:VALARM',
  'DESCRIPTION:This is an event reminder',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/Los_Angeles:20261030T150000',
  'DTEND;TZID=America/Los_Angeles:20261030T153000',
  'RECURRENCE-ID;TZID=America/Los_Angeles:20261029T100000',
  'UID:weekly@google.com',
  'SUMMARY:Group sync (moved)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/Los_Angeles:20261112T100000',
  'RECURRENCE-ID;TZID=America/Los_Angeles:20261112T100000',
  'UID:weekly@google.com',
  'STATUS:CANCELLED',
  'SUMMARY:Group sync',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261102',
  'DTEND;VALUE=DATE:20261104',
  'UID:trip@google.com',
  'SUMMARY:Trip',
  'ORGANIZER;CN=Ada Lovelace:mailto:ada@example.org',
  'ATTENDEE;CN=Ada Lovelace;PARTSTAT=ACCEPTED:mailto:ada@example.org',
  'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.org',
  'DESCRIPTION:<p>Pack the <b>poster</b>.</p><p><a href="https://example.org/h">Hotel</a></p>',
  'LOCATION:https://example.org/trip',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n');

const window = (from, to) => ({
  from: Date.parse(`${from}T00:00:00Z`),
  to: Date.parse(`${to}T00:00:00Z`)
});

test('parses Google iCal: folded lines, escapes, alarms ignored', () => {
  const [weekly] = parseIcs(ICS);
  assert.equal(weekly.title, 'Group sync, weekly');
  assert.equal(
    weekly.description,
    'Join at https://meet.google.com/abc-defg-hij and bring slides'
  );
  assert.equal(weekly.start.tz, 'America/Los_Angeles');
  assert.equal(weekly.exdates.length, 1);
});

test('expands a weekly series in its own zone, across daylight saving', () => {
  const found = expandEvents(parseIcs(ICS), window('2026-10-20', '2026-11-25'));
  const sync = found
    .filter((event) => event.title.startsWith('Group sync'))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  assert.deepEqual(
    sync.map((event) => [event.title, event.startsAt]),
    [
      ['Group sync, weekly', '2026-10-22T17:00:00.000Z'],
      // The 29th moved to Friday afternoon; the 5th is excluded; the 12th is
      // cancelled. 10:00 stays 10:00 after the clocks change on Nov 1.
      ['Group sync (moved)', '2026-10-30T22:00:00.000Z'],
      ['Group sync, weekly', '2026-11-19T18:00:00.000Z']
    ]
  );
  assert.equal(sync[0].url, 'https://meet.google.com/abc-defg-hij');
  assert.equal(sync[0].endsAt, '2026-10-22T17:30:00.000Z');

  const trip = found.find((event) => event.title === 'Trip');
  assert.deepEqual(
    [trip.allDay, trip.date, trip.endDate, trip.url],
    [true, '2026-11-02', '2026-11-04', 'https://example.org/trip']
  );
});

function series(rrule, dtstart = 'DTSTART:20200106T090000Z') {
  return parseIcs(
    [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:x',
      'SUMMARY:S',
      dtstart,
      `RRULE:${rrule}`,
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\n')
  );
}

const dates = (events, from, to) =>
  expandEvents(events, window(from, to)).map((event) =>
    (event.date || event.startsAt).slice(0, 10)
  );

test('a years-old daily series still reaches this month; COUNT and UNTIL stop it', () => {
  assert.deepEqual(dates(series('FREQ=DAILY'), '2026-09-10', '2026-09-13'), [
    '2026-09-10',
    '2026-09-11',
    '2026-09-12'
  ]);
  assert.deepEqual(
    dates(series('FREQ=DAILY;COUNT=3'), '2020-01-01', '2020-02-01'),
    ['2020-01-06', '2020-01-07', '2020-01-08']
  );
  assert.deepEqual(
    dates(
      series('FREQ=DAILY;UNTIL=20200107T090000Z'),
      '2020-01-01',
      '2020-02-01'
    ),
    ['2020-01-06', '2020-01-07']
  );
});

test('weekdays, fortnightly, monthly by ordinal weekday and by day', () => {
  assert.deepEqual(
    dates(
      series('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'),
      '2026-09-12',
      '2026-09-16'
    ),
    ['2026-09-14', '2026-09-15']
  );
  // Every other Monday from Mon 2020-01-06.
  assert.deepEqual(
    dates(
      series('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'),
      '2020-01-01',
      '2020-02-01'
    ),
    ['2020-01-06', '2020-01-20']
  );
  assert.deepEqual(
    dates(series('FREQ=MONTHLY;BYDAY=2TU'), '2026-09-01', '2026-11-01'),
    ['2026-09-08', '2026-10-13']
  );
  assert.deepEqual(
    dates(series('FREQ=MONTHLY;BYDAY=-1FR'), '2026-09-01', '2026-10-01'),
    ['2026-09-25']
  );
  assert.deepEqual(
    dates(
      series('FREQ=MONTHLY', 'DTSTART;VALUE=DATE:20260131'),
      '2026-01-01',
      '2026-04-01'
    ),
    ['2026-01-31', '2026-03-31']
  );
  assert.deepEqual(
    dates(
      series('FREQ=YEARLY', 'DTSTART;VALUE=DATE:20200229'),
      '2024-01-01',
      '2025-01-01'
    ),
    ['2024-02-29']
  );
});

test('an unsupported rule shows its first instance rather than guessing', () => {
  assert.deepEqual(
    dates(
      series('FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1'),
      '2020-01-01',
      '2020-12-31'
    ),
    ['2020-01-06']
  );
});

test('only https feeds are read, and webcal is https', () => {
  assert.deepEqual(
    calendarFeeds({
      GOOGLE_CALENDAR_ICS: ` webcal://a.example/x.ics  http://b.example/y.ics nonsense ${FEED}`
    }),
    ['https://a.example/x.ics', FEED]
  );
  assert.deepEqual(calendarFeeds({}), []);
});

test('a failing feed is reported without its secret address', async () => {
  const result = await calendarEvents([FEED], {
    from: '2026-10-01',
    to: '2026-11-01',
    fetchImpl: async () => new Response('no', { status: 404 })
  });
  assert.deepEqual(result.events, []);
  assert.equal(result.errors.length, 1);
  assert.ok(!result.errors[0].includes('SECRET'));
});

test('GET /api/calendar/events serves occurrences and never the feed address', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'webmd-gcal-'));
  const app = await createApp({
    workspaceRoot: root,
    env: { GOOGLE_CALENDAR_ICS: FEED },
    calendarFetch: async (url) => {
      assert.equal(url, FEED);
      return new Response(ICS);
    }
  });
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(
      `${base}/api/calendar/events?from=2026-10-25&to=2026-11-05`
    );
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!text.includes('SECRET'));
    const body = JSON.parse(text);
    assert.equal(body.configured, true);
    assert.deepEqual(
      body.events.map((event) => event.title),
      ['Group sync (moved)', 'Trip']
    );

    const bad = await fetch(
      `${base}/api/calendar/events?from=nope&to=2026-11-05`
    );
    assert.equal(bad.status, 400);
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('eventsByDay puts all-day events on every day they span, first', () => {
  const days = eventsByDay([
    {
      title: 'Standup',
      allDay: false,
      startsAt: new Date(2026, 10, 3, 9, 30).toISOString()
    },
    { title: 'Trip', allDay: true, date: '2026-11-02', endDate: '2026-11-04' }
  ]);
  assert.deepEqual([...days.keys()].sort(), ['2026-11-02', '2026-11-03']);
  assert.deepEqual(
    days.get('2026-11-03').map((event) => event.title),
    ['Trip', 'Standup']
  );
});

test('details: organizer, guests, and an HTML description as text', () => {
  const trip = expandEvents(
    parseIcs(ICS),
    window('2026-11-01', '2026-11-05')
  ).find((event) => event.title === 'Trip');
  assert.equal(trip.organizer, 'Ada Lovelace');
  assert.deepEqual(trip.attendees, ['Ada Lovelace', 'bob@example.org']);
  assert.equal(
    trip.description,
    'Pack the poster.\nHotel (https://example.org/h)'
  );
});

test('linkParts keeps text around links and drops trailing punctuation', () => {
  assert.deepEqual(linkParts('See https://a.example/x). Then go.'), [
    { text: 'See ' },
    { text: 'https://a.example/x', url: 'https://a.example/x' },
    { text: '). Then go.' }
  ]);
  assert.deepEqual(linkParts(''), []);
});

test('eventTimeRange: a range, all day, and all day across days', () => {
  const event = {
    startsAt: new Date(2026, 8, 15, 9, 0).toISOString(),
    endsAt: new Date(2026, 8, 15, 10, 30).toISOString()
  };
  assert.match(eventTimeRange(event, 'en-US'), /^9:00\s*–\s*10:30\sAM$/);
  assert.equal(
    eventTimeRange({ allDay: true, date: '2026-09-21', endDate: '2026-09-22' }),
    'All day'
  );
  assert.equal(
    eventTimeRange(
      { allDay: true, date: '2026-09-21', endDate: '2026-09-24' },
      'en-US'
    ),
    'All day, until Sep 23'
  );
});

test('feeds are cached on disk without their address, and a stale copy is served', async () => {
  const cacheDir = await fs.mkdtemp(path.join(tmpdir(), 'webmd-gcal-cache-'));
  const range = { from: '2026-10-25', to: '2026-11-05', cacheDir };
  try {
    const first = await calendarEvents([FEED], {
      ...range,
      fetchImpl: async () => {
        return new Response(ICS);
      }
    });
    assert.equal(first.events.length, 2);

    const [file] = await fs.readdir(path.join(cacheDir, 'gcal'));
    const saved = path.join(cacheDir, 'gcal', file);
    assert.ok(!(await fs.readFile(saved, 'utf8')).includes('SECRET'));
    assert.equal((await fs.stat(saved)).mode & 0o777, 0o600);

    // A restart, an hour later, with Google unreachable.
    resetCalendarCache();
    const later = () => Date.now() + 60 * 60 * 1000;
    const down = async () => {
      throw new Error('offline');
    };
    const stale = await calendarEvents([FEED], {
      ...range,
      fetchImpl: down,
      allowStale: true,
      now: later
    });
    assert.equal(stale.stale, true);
    assert.equal(stale.events.length, 2);
    assert.deepEqual(stale.errors, []);

    const fresh = await calendarEvents([FEED], {
      ...range,
      fetchImpl: down,
      now: later
    });
    assert.equal(fresh.events.length, 0);
    assert.equal(fresh.errors.length, 1);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});
