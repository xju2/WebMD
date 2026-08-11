import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calendarDays,
  dailyNoteContent,
  dailyNoteDate,
  dailyNoteDateFromPath,
  shiftDay,
  shiftMonth
} from '../src/calendar.js';

test('builds a Monday-first six-week calendar', () => {
  const days = calendarDays(new Date(2026, 6, 1));

  assert.equal(days.length, 42);
  assert.equal(days[0].date.toISOString().slice(0, 10), '2026-06-29');
  assert.equal(days[2].date.toISOString().slice(0, 10), '2026-07-01');
  assert.equal(days[2].currentMonth, true);
  assert.equal(days[33].date.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(shiftMonth(new Date(2026, 0, 1), -1).toISOString().slice(0, 10), '2025-12-01');
});

test('advances a day across month and year ends', () => {
  assert.equal(dailyNoteDate(shiftDay(new Date(2026, 7, 10), 1)), '2026-08-11');
  assert.equal(dailyNoteDate(shiftDay(new Date(2026, 7, 31), 1)), '2026-09-01');
  assert.equal(
    dailyNoteDate(shiftDay(new Date(2026, 11, 31), 1)),
    '2027-01-01'
  );
});

test('reads the date only from daily note file names', () => {
  assert.equal(
    dailyNoteDate(dailyNoteDateFromPath('/raw/dailynotes/2026-08-10.md')),
    '2026-08-10'
  );
  assert.equal(
    dailyNoteDate(dailyNoteDateFromPath('/2026-08-10.markdown')),
    '2026-08-10'
  );
  assert.equal(dailyNoteDateFromPath('/notes/standup-2026-08-10.md'), null);
  assert.equal(dailyNoteDateFromPath('/raw/dailynotes/2026-02-30.md'), null);
  assert.equal(dailyNoteDateFromPath('/raw/2026-08-10/note.md'), null);
  assert.equal(dailyNoteDateFromPath(''), null);
  assert.equal(dailyNoteDateFromPath(null), null);
});

test('builds daily note content from a template', () => {
  assert.equal(
    dailyNoteContent(new Date(2026, 7, 6), '/raw/dailynotes/2026-08-06.md'),
    '# 2026-08-06\n\n'
  );
  assert.equal(
    dailyNoteContent(
      new Date(2026, 7, 6),
      '/raw/dailynotes/2026-08-06.md',
      '# {{title}}\n\n{{weekday}} {{date}}\n'
    ),
    '# 2026-08-06\n\nThursday 2026-08-06\n'
  );
});
