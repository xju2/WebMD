import assert from 'node:assert/strict';
import test from 'node:test';
import { findHeadingLine, noteHeadings } from '../src/note-headings.js';

const NOTE = [
  '---',
  'title: Triton',
  '---',
  '',
  '# Triton',
  '',
  'Body text.',
  '',
  '## Setup',
  '',
  '```bash',
  '# not a heading',
  '```',
  '',
  '### Ports'
].join('\n');

test('lists headings with their level and 0-based line', () => {
  assert.deepEqual(noteHeadings(NOTE), [
    { text: 'Triton', level: 1, line: 4 },
    { text: 'Setup', level: 2, line: 8 },
    { text: 'Ports', level: 3, line: 14 }
  ]);
});

test('ignores a comment inside a fenced code block', () => {
  assert.ok(
    !noteHeadings(NOTE).some((heading) =>
      heading.text.includes('not a heading')
    )
  );
});

test('finds a heading line ignoring case and surrounding space', () => {
  assert.equal(findHeadingLine(NOTE, '  setup '), 8);
});

test('reports a missing heading rather than guessing', () => {
  assert.equal(findHeadingLine(NOTE, 'Teardown'), null);
  assert.equal(findHeadingLine(NOTE, ''), null);
});
