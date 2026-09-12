import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeAgendaTime,
  describeMeetingTime,
  filterMeetings,
  groupMeetings,
  joinState,
  keepSelection,
  meetingBegun,
  meetingSection,
  meetingsPane,
  sourceNotice,
  sourceNotices,
  zoomMeetingId
} from '../src/meetings.js';

// Local wall-clock times, so the sections are checked in whatever zone the
// test runs in, the way the browser would see them.
function local(y, m, d, h = 0, min = 0) {
  return new Date(y, m - 1, d, h, min).getTime();
}

function meeting(title, start, end = start + 60 * 60 * 1000, extra = {}) {
  return {
    key: title,
    title,
    start: { iso: new Date(start).toISOString() },
    end: { iso: new Date(end).toISOString() },
    sources: ['a'],
    ...extra
  };
}

// Friday 11 September 2026, mid-morning.
const NOW = local(2026, 9, 11, 10);

test('sorts meetings into local-day sections', () => {
  const cases = [
    [meeting('earlier today', local(2026, 9, 11, 8)), 'today'],
    [meeting('tonight', local(2026, 9, 11, 23, 30)), 'today'],
    [meeting('tomorrow', local(2026, 9, 12, 9)), 'tomorrow'],
    [meeting('sunday', local(2026, 9, 13, 9)), 'week'],
    [meeting('monday', local(2026, 9, 14, 9)), 'next-week'],
    [meeting('next sunday', local(2026, 9, 20, 23)), 'next-week'],
    [meeting('in two weeks', local(2026, 9, 21, 9)), 'later'],
    [meeting('workshop', local(2026, 9, 8, 9), local(2026, 9, 12, 18)), 'ongoing'],
    [meeting('yesterday', local(2026, 9, 10, 9)), 'past']
  ];
  for (const [item, section] of cases) {
    assert.equal(meetingSection(item, NOW), section, item.title);
  }
});

test('on a Sunday, This week is already over', () => {
  const sunday = local(2026, 9, 13, 10);
  assert.equal(meetingSection(meeting('mon', local(2026, 9, 14, 9)), sunday), 'tomorrow');
  assert.equal(meetingSection(meeting('tue', local(2026, 9, 15, 9)), sunday), 'next-week');
});

test('groups in order and leaves empty sections out', () => {
  const groups = groupMeetings(
    [
      meeting('later', local(2026, 9, 30, 9)),
      meeting('b', local(2026, 9, 11, 15)),
      meeting('a', local(2026, 9, 11, 11))
    ],
    NOW
  );
  assert.deepEqual(
    groups.map((group) => [group.label, group.meetings.map((item) => item.title)]),
    [
      ['Today', ['a', 'b']],
      ['Later', ['later']]
    ]
  );
});

test('filters by source without losing meetings listed by several', () => {
  const both = meeting('both', NOW, NOW, { sources: ['a', 'b'] });
  const onlyA = meeting('onlyA', NOW);
  assert.deepEqual(filterMeetings([both, onlyA], 'b'), [both]);
  assert.deepEqual(filterMeetings([both, onlyA], ''), [both, onlyA]);
});

test('shows local time, and the event zone only when it reads differently', () => {
  const geneva = {
    ...meeting('g', Date.parse('2026-09-11T13:00:00Z'), Date.parse('2026-09-11T14:00:00Z')),
    timezone: 'Europe/Zurich'
  };
  const inChicago = describeMeetingTime(geneva, { timeZone: 'America/Chicago' });
  assert.equal(inChicago.time, '08:00–09:00');
  assert.match(inChicago.zoned, / · 15:00–16:00 Europe\/Zurich$/);
  const inGeneva = describeMeetingTime(geneva, { timeZone: 'Europe/Zurich' });
  assert.equal(inGeneva.time, '15:00–16:00');
  assert.equal(inGeneva.zoned, '');
});

test('spells out multi-day and all-day meetings', () => {
  const workshop = {
    ...meeting('w', Date.parse('2026-09-14T07:00:00Z'), Date.parse('2026-09-16T16:00:00Z')),
    timezone: 'UTC'
  };
  const multi = describeMeetingTime(workshop, { timeZone: 'UTC' });
  assert.match(multi.day, /14.*–.*16/);
  assert.equal(multi.time, '3 days');
  assert.match(multi.full, /14, 07:00 – .*16, 16:00$/);

  const holiday = {
    ...meeting('h', Date.parse('2026-09-20T00:00:00Z'), Date.parse('2026-09-20T23:59:00Z')),
    allDay: true,
    timezone: 'UTC'
  };
  assert.equal(describeMeetingTime(holiday, { timeZone: 'UTC' }).time, 'All day');
});

test('agenda times carry the day only when it changes', () => {
  const workshop = meeting('w', Date.parse('2026-09-14T07:00:00Z'));
  const sameDay = { start: { iso: '2026-09-14T09:30:00.000Z' } };
  const nextDay = { start: { iso: '2026-09-15T09:30:00.000Z' } };
  assert.equal(describeAgendaTime(sameDay, workshop, { timeZone: 'UTC' }), '09:30');
  assert.match(describeAgendaTime(nextDay, workshop, { timeZone: 'UTC' }), /15.* 09:30$/);
});

test('says which sources need attention, and how much', () => {
  assert.equal(sourceNotice({ id: 'a', state: 'ok' }), null);
  assert.equal(sourceNotice({ id: 'a', state: 'empty', count: 0 }), null);
  const auth = sourceNotice(
    { id: 'a', state: 'error', kind: 'auth', message: 'rejected INDICO_CERN_TOKEN' },
    { label: 'ATLAS' }
  );
  assert.equal(auth.tone, 'error');
  assert.equal(auth.kind, 'auth');
  assert.equal(auth.text, 'ATLAS: rejected INDICO_CERN_TOKEN');
  assert.equal(
    sourceNotice({ id: 'a', state: 'empty', kind: 'maybe_protected', message: 'set it' })
      .tone,
    'hint'
  );
});

test('narrow panes show the list or the meeting, never both', () => {
  assert.equal(meetingsPane({ compact: false, detailOpen: true }), 'both');
  assert.equal(meetingsPane({ compact: true, detailOpen: false }), 'list');
  assert.equal(meetingsPane({ compact: true, detailOpen: true }), 'detail');
});

test('keeps the chosen meeting across a refresh only while it is listed', () => {
  const items = [meeting('a', NOW)];
  assert.equal(keepSelection(items, 'a'), 'a');
  assert.equal(keepSelection(items, 'gone'), '');
});

test('says a shared failure once, naming every source it broke', () => {
  const statuses = [
    { id: 'a', state: 'error', kind: 'auth', message: 'rejected INDICO_CERN_TOKEN' },
    { id: 'b', state: 'error', kind: 'auth', message: 'rejected INDICO_CERN_TOKEN' },
    { id: 'c', state: 'error', kind: 'network', message: 'offline' },
    { id: 'd', state: 'ok' }
  ];
  const names = new Map([
    ['a', { label: 'Tracking' }],
    ['b', { label: 'Seminars' }],
    ['c', { label: 'Other Indico' }]
  ]);
  assert.deepEqual(
    sourceNotices(statuses, names).map((notice) => notice.text),
    ['Tracking, Seminars: rejected INDICO_CERN_TOKEN', 'Other Indico: offline']
  );
});

test('lists the past week last, newest first', () => {
  const groups = groupMeetings(
    [
      meeting('monday', local(2026, 9, 7, 9)),
      meeting('today', local(2026, 9, 11, 15)),
      meeting('wednesday', local(2026, 9, 9, 9))
    ],
    NOW
  );
  assert.deepEqual(
    groups.map((group) => [group.label, group.meetings.map((item) => item.title)]),
    [
      ['Today', ['today']],
      ['Past week', ['wednesday', 'monday']]
    ]
  );
});

test('offers Join from a quarter hour before a Zoom meeting until it ends', () => {
  const zoom = { url: 'https://cern.zoom.us/j/12345678901' };
  const at = (h, min = 0) => local(2026, 9, 11, h, min);
  const call = meeting('call', at(15), at(16), { zoom });
  assert.equal(joinState(call, at(14, 44)), 'upcoming');
  assert.equal(joinState(call, at(14, 45)), 'live');
  assert.equal(joinState(call, at(15, 59)), 'live');
  assert.equal(joinState(call, at(16, 1)), 'over');
  assert.equal(joinState(meeting('room only', at(15)), at(15)), '');
  assert.equal(meetingBegun(call, at(14, 59)), false);
  assert.equal(meetingBegun(call, at(15)), true);
});

test('writes a Zoom meeting number the way Zoom does', () => {
  assert.equal(zoomMeetingId('12345678901'), '123 4567 8901');
  assert.equal(zoomMeetingId('1234567890'), '123 456 7890');
  assert.equal(zoomMeetingId('123456789'), '123456789');
});
