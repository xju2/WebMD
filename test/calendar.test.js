import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calendarDays,
  dailyNoteContent,
  dailyNoteDate,
  dailyNoteDateFromPath,
  defaultDailyNoteTemplatePath,
  defaultReferencePath,
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
  assert.equal(
    shiftMonth(new Date(2026, 0, 1), -1)
      .toISOString()
      .slice(0, 10),
    '2025-12-01'
  );
});

test('indexes the neighbouring daily note', () => {
  assert.equal(stepDailyNote(4, 2, -1), 1);
  assert.equal(stepDailyNote(4, 1, 1), 2);
});

test('stops at either end of the daily notes', () => {
  assert.equal(stepDailyNote(4, 3, 1), null);
  assert.equal(stepDailyNote(4, 0, -1), null);
  assert.equal(stepDailyNote(0, -1, -1), null);
  assert.equal(stepDailyNote(1, 0, -1), null);
});

test('reaches the newest daily note when none is open', () => {
  assert.equal(stepDailyNote(3, -1, -1), 2);
  assert.equal(stepDailyNote(3, 9, -1), 2);
  // Forward from nowhere would land past the newest note.
  assert.equal(stepDailyNote(3, -1, 1), null);
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

test('finds a conventionally named template without one being chosen', () => {
  const paths = [
    '/template.md',
    '/raw/dailynotes/2026-08-15.md',
    '/raw/dailynotes/dailynote_template.md'
  ];

  // The daily note folder wins over the root, whatever the separators.
  assert.equal(
    defaultDailyNoteTemplatePath(paths, '/raw/dailynotes'),
    '/raw/dailynotes/dailynote_template.md'
  );
  assert.equal(
    defaultDailyNoteTemplatePath(['/notes/Daily-Template.md'], '/notes'),
    '/notes/Daily-Template.md'
  );
  assert.equal(defaultDailyNoteTemplatePath(paths, '/wiki'), '/template.md');
  assert.equal(defaultDailyNoteTemplatePath(paths, '/'), '/template.md');
  assert.equal(
    defaultDailyNoteTemplatePath(
      ['/raw/dailynotes/2026-08-15.md'],
      '/raw/dailynotes'
    ),
    ''
  );
  assert.equal(defaultDailyNoteTemplatePath(), '');
});

test('picks the reference note beside the open file', () => {
  const paths = [
    '/raw/dailynotes/2026-08-10.md',
    '/raw/dailynotes/2026-08-11.md',
    '/raw/dailynotes/2026-08-12.md'
  ];

  assert.equal(defaultReferencePath([], '/raw/dailynotes/2026-08-12.md'), '');
  assert.equal(
    defaultReferencePath(paths, '/raw/dailynotes/2026-08-12.md'),
    '/raw/dailynotes/2026-08-11.md'
  );
  // Not a daily note, so the newest one is the useful companion.
  assert.equal(
    defaultReferencePath(paths, '/notes/inbox.md'),
    '/raw/dailynotes/2026-08-12.md'
  );
  // Nothing sits before the oldest note.
  assert.equal(
    defaultReferencePath(paths, '/raw/dailynotes/2026-08-10.md'),
    ''
  );
});
