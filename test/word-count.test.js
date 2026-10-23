import assert from 'node:assert/strict';
import test from 'node:test';
import { wordCount } from '../src/word-count.js';

test('counts prose, not frontmatter, comments, link targets or marks', () => {
  const note = [
    '---',
    'title: Ignored here',
    '---',
    '# Two words',
    '<!-- hidden note -->',
    '- [three small words](https://example.com/a/b) and https://x.com/y',
    '---'
  ].join('\n');
  assert.equal(wordCount(note), 2 + 4);
  assert.equal(wordCount(), 0);
});

test('skips fenced code, including a fence left open', () => {
  assert.equal(wordCount('one\n```js\nconst a = 1;\n```\ntwo'), 2);
  assert.equal(wordCount('one\n```\nnever closed here'), 1);
});
