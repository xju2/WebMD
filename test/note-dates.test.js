import assert from 'node:assert/strict';
import test from 'node:test';
import { noteDateEdits, stampNoteDates } from '../src/note-dates.js';

test('writes a frontmatter block when the note has none', () => {
  assert.equal(
    stampNoteDates('# Notes\n\nBody\n', '2026-08-19'),
    '---\ncreation-date: 2026-08-19\nlast-modified-date: 2026-08-19\n---\n\n# Notes\n\nBody\n'
  );
  assert.equal(
    stampNoteDates('', '2026-08-19'),
    '---\ncreation-date: 2026-08-19\nlast-modified-date: 2026-08-19\n---\n'
  );
});

test('dates an older note by its file age rather than by today', () => {
  assert.equal(
    stampNoteDates('# Notes\n', '2026-08-19', '2024-03-02'),
    '---\ncreation-date: 2024-03-02\nlast-modified-date: 2026-08-19\n---\n\n# Notes\n'
  );
});

test('adds the fields a note is missing, keeping the ones it has', () => {
  assert.equal(
    stampNoteDates('---\ntitle: Notes\n---\n\nBody\n', '2026-08-19'),
    '---\ncreation-date: 2026-08-19\nlast-modified-date: 2026-08-19\ntitle: Notes\n---\n\nBody\n'
  );
  assert.equal(
    stampNoteDates(
      '---\ncreation-date: 2024-01-05\ntitle: Notes\n---\n\nBody\n',
      '2026-08-19'
    ),
    '---\nlast-modified-date: 2026-08-19\ncreation-date: 2024-01-05\ntitle: Notes\n---\n\nBody\n'
  );
});

test('moves the modified date on, and never rewrites the creation date', () => {
  assert.equal(
    stampNoteDates(
      '---\ncreation-date: 2024-01-05\nlast-modified-date: 2026-08-18\ntags: [a]\n---\n\nBody\n',
      '2026-08-19',
      '2024-01-05'
    ),
    '---\ncreation-date: 2024-01-05\nlast-modified-date: 2026-08-19\ntags: [a]\n---\n\nBody\n'
  );
});

test('leaves a note that already says today untouched', () => {
  const note =
    '---\ncreation-date: 2024-01-05\nlast-modified-date: 2026-08-19\n---\n\nBody\n';
  assert.deepEqual(noteDateEdits(note, '2026-08-19'), []);
  assert.deepEqual(noteDateEdits(note, ''), []);
  assert.equal(stampNoteDates(note, '2026-08-19'), note);
});

test('reports edits as character ranges the editor can dispatch', () => {
  const note = '---\nlast-modified-date: 2026-08-18\n---\n\nBody\n';
  assert.deepEqual(noteDateEdits(note, '2026-08-19', '2024-01-05'), [
    { from: 4, to: 4, insert: 'creation-date: 2024-01-05\n' },
    { from: 4, to: 34, insert: 'last-modified-date: 2026-08-19' }
  ]);
});
