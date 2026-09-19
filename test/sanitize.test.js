import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitize, sanitizeEdits } from '../src/sanitize.js';

test('trims trailing whitespace and blank lines at both ends', () => {
  assert.equal(
    sanitize('\n\n# Notes  \n\nBody\t\n\n  \n\n'),
    '# Notes\n\nBody\n'
  );
});

test('adds the missing final newline', () => {
  assert.equal(sanitize('# Notes'), '# Notes\n');
  assert.equal(sanitize('# Notes  '), '# Notes\n');
});

test('leaves a tidy note alone', () => {
  const text = '---\ncreation-date: 2026-09-18\n---\n\n# Notes\n\n- one\n';
  assert.deepEqual(sanitizeEdits(text), []);
  assert.equal(sanitize(text), text);
});

test('keeps blank lines inside the note', () => {
  assert.equal(sanitize('a\n\n\nb\n'), 'a\n\n\nb\n');
});

test('empties a note that is only whitespace', () => {
  assert.equal(sanitize('\n  \n\t\n'), '');
  assert.equal(sanitize(''), '');
});

test('edits are ordered and never overlap', () => {
  const edits = sanitizeEdits('\n\na  \nb\t\n\n\n');
  let end = 0;
  for (const edit of edits) {
    assert.ok(edit.from >= end, 'edits overlap');
    end = edit.to;
  }
});

test('strips carriage returns from a CRLF file', () => {
  assert.equal(sanitize('# Notes\r\n\r\nBody\r\n'), '# Notes\n\nBody\n');
  assert.equal(sanitize('# Notes\r\n\r\n'), '# Notes\n');
});
