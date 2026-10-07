import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findHeadingLine,
  headingLabel,
  noteHeadings
} from '../src/note-headings.js';

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

test('labels a heading with its Markdown taken off', () => {
  assert.equal(headingLabel('Plan for **next** week'), 'Plan for next week');
  assert.equal(
    headingLabel('See [[Garden planner|the garden]]'),
    'See the garden'
  );
  assert.equal(
    headingLabel('[[Garden planner]] notes'),
    'Garden planner notes'
  );
  assert.equal(
    headingLabel('Read [the paper](https://x.org) first'),
    'Read the paper first'
  );
  assert.equal(headingLabel('The `run()` loop ##'), 'The run() loop');
  assert.equal(
    headingLabel('An *aside* and snake_case_name'),
    'An aside and snake_case_name'
  );
});
