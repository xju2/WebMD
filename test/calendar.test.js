import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarDays, shiftMonth } from '../src/calendar.js';

test('builds a Monday-first six-week calendar', () => {
  const days = calendarDays(new Date(2026, 6, 1));

  assert.equal(days.length, 42);
  assert.equal(days[0].date.toISOString().slice(0, 10), '2026-06-29');
  assert.equal(days[2].date.toISOString().slice(0, 10), '2026-07-01');
  assert.equal(days[2].currentMonth, true);
  assert.equal(days[33].date.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(shiftMonth(new Date(2026, 0, 1), -1).toISOString().slice(0, 10), '2025-12-01');
});
