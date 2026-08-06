import assert from 'node:assert/strict';
import test from 'node:test';
import { quotedBlockPaste } from '../src/editor.js';

test('quotes multiline paste after a callout marker', () => {
  assert.equal(
    quotedBlockPaste('alpha\nbeta', {
      beforeCursor: '',
      previousLine: '> [!note]'
    }),
    '> alpha\n> beta'
  );
});

test('continues quote prefixes when pasting inside a quote line', () => {
  assert.equal(
    quotedBlockPaste('alpha\nbeta\n', { beforeCursor: '> ' }),
    'alpha\n> beta\n'
  );
});

test('leaves normal multiline paste alone', () => {
  assert.equal(
    quotedBlockPaste('alpha\nbeta', {
      beforeCursor: '',
      previousLine: 'plain text'
    }),
    null
  );
});
