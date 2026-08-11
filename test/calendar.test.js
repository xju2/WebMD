import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calendarDays,
  dailyNoteContent,
  dailyNoteDate,
  dailyNoteDateFromPath,
  shiftMonth,
  stepDailyNote
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

test('walks daily notes and reverses at either end', () => {
  assert.deepEqual(stepDailyNote(4, 2, -1), { index: 1, step: -1 });
  assert.deepEqual(stepDailyNote(4, 1, 1), { index: 2, step: 1 });
  // The newest note is the end of the line, so the walk turns around.
  assert.deepEqual(stepDailyNote(4, 3, 1), { index: 2, step: -1 });
  assert.deepEqual(stepDailyNote(4, 0, -1), { index: 1, step: 1 });
});

test('starts from the newest daily note when none is open', () => {
  assert.deepEqual(stepDailyNote(3, -1, 1), { index: 2, step: -1 });
  assert.deepEqual(stepDailyNote(3, 9, -1), { index: 2, step: -1 });
});

test('has nowhere to hop with fewer than two daily notes', () => {
  assert.equal(stepDailyNote(0, -1, -1), null);
  // The only note is already open, so both directions run off the end.
  assert.equal(stepDailyNote(1, 0, -1), null);
  assert.deepEqual(stepDailyNote(1, -1, -1), { index: 0, step: -1 });
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
