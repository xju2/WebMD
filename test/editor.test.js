import assert from 'node:assert/strict';
import test from 'node:test';
import { arxivLinkPaste, quotedBlockPaste } from '../src/editor.js';

const ABS_LINK = '[arXiv:2608.00146](https://arxiv.org/abs/2608.00146)';

test('turns a pasted arXiv pdf link into an abstract link', () => {
  assert.equal(arxivLinkPaste('https://arxiv.org/pdf/2608.00146'), ABS_LINK);
});

test('labels an already-abstract arXiv link', () => {
  assert.equal(arxivLinkPaste('https://arxiv.org/abs/2608.00146'), ABS_LINK);
});

test('keeps the version suffix of a pasted arXiv link', () => {
  assert.equal(
    arxivLinkPaste('https://arxiv.org/pdf/2608.00146v2'),
    '[arXiv:2608.00146v2](https://arxiv.org/abs/2608.00146v2)'
  );
});

test('accepts arXiv link variants', () => {
  for (const url of [
    'http://arxiv.org/pdf/2608.00146',
    'https://www.arxiv.org/abs/2608.00146',
    'https://arxiv.org/pdf/2608.00146.pdf',
    'https://arxiv.org/abs/2608.00146/',
    '  https://arxiv.org/pdf/2608.00146\n'
  ]) {
    assert.equal(arxivLinkPaste(url), ABS_LINK, url);
  }
});

test('handles old-style arXiv identifiers', () => {
  assert.equal(
    arxivLinkPaste('https://arxiv.org/pdf/hep-th/9901001'),
    '[arXiv:hep-th/9901001](https://arxiv.org/abs/hep-th/9901001)'
  );
  assert.equal(
    arxivLinkPaste('https://arxiv.org/abs/math.GT/0309136'),
    '[arXiv:math.GT/0309136](https://arxiv.org/abs/math.GT/0309136)'
  );
});

test('leaves pastes that are not a lone arXiv link alone', () => {
  assert.equal(arxivLinkPaste('https://example.com/pdf/2608.00146'), null);
  assert.equal(arxivLinkPaste('https://arxiv.org/list/hep-ex/recent'), null);
  assert.equal(
    arxivLinkPaste('see https://arxiv.org/pdf/2608.00146 for it'),
    null
  );
  assert.equal(
    arxivLinkPaste(
      'https://arxiv.org/pdf/2608.00146\nhttps://arxiv.org/pdf/2608.00147'
    ),
    null
  );
});

test('leaves an arXiv link bare inside markdown link or autolink syntax', () => {
  assert.equal(
    arxivLinkPaste('https://arxiv.org/pdf/2608.00146', {
      beforeCursor: '[paper]('
    }),
    null
  );
  assert.equal(
    arxivLinkPaste('https://arxiv.org/pdf/2608.00146', { beforeCursor: '<' }),
    null
  );
});

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
