import assert from 'node:assert/strict';
import test from 'node:test';
import {
  arxivCitation,
  arxivLinkPaste,
  arxivPasteId,
  mathPasteText,
  quotedBlockPaste,
  sourceColumnForWord
} from '../src/editor.js';

const ABS_LINK = '[arXiv:2608.00146](https://arxiv.org/abs/2608.00146)';

test('turns a pasted arXiv pdf link into an abstract link', () => {
  assert.equal(arxivLinkPaste('https://arxiv.org/pdf/2608.00146'), ABS_LINK);
});

test('labels an already-abstract arXiv link', () => {
  assert.equal(arxivLinkPaste('https://arxiv.org/abs/2608.00146'), ABS_LINK);
});

test('turns a pasted arXiv html link into an abstract link', () => {
  assert.equal(arxivLinkPaste('https://arxiv.org/html/2608.00146'), ABS_LINK);
  assert.equal(
    arxivLinkPaste('https://arxiv.org/html/2608.00146v2'),
    '[arXiv:2608.00146v2](https://arxiv.org/abs/2608.00146v2)'
  );
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

test('reports the identifier a pasted arXiv link carries', () => {
  assert.equal(arxivPasteId('https://arxiv.org/pdf/2608.00146v2'), '2608.00146v2');
  assert.equal(arxivPasteId('https://arxiv.org/abs/hep-th/9901001'), 'hep-th/9901001');
  assert.equal(arxivPasteId('arxiv.org/pdf/2511.15684'), '2511.15684');
  assert.equal(arxivPasteId('www.arxiv.org/abs/2608.00146'), '2608.00146');
  assert.equal(arxivPasteId('https://example.com/abs/2608.00146'), null);
  assert.equal(
    arxivPasteId('https://arxiv.org/pdf/2608.00146', { beforeCursor: '[p](' }),
    null
  );
});

test('formats a citation with the first author and title', () => {
  assert.equal(
    arxivCitation({
      id: '2608.00146',
      title: 'A Tracking Pipeline',
      authors: ['Xiangyang Ju', 'Daniel Murnane']
    }),
    `Ju et al., "A Tracking Pipeline" — ${ABS_LINK}`
  );
});

test('drops the et al. for a single author', () => {
  assert.equal(
    arxivCitation({
      id: '2608.00146',
      title: 'A Tracking Pipeline',
      authors: ['Xiangyang Ju']
    }),
    `Ju, "A Tracking Pipeline" — ${ABS_LINK}`
  );
});

test('keeps a collaboration name whole', () => {
  assert.equal(
    arxivCitation({
      id: '2608.00146',
      title: 'A Search',
      authors: ['ATLAS Collaboration', 'CMS Collaboration']
    }),
    `ATLAS Collaboration et al., "A Search" — ${ABS_LINK}`
  );
});

test('collapses the line breaks arXiv wraps titles with', () => {
  assert.equal(
    arxivCitation({
      id: '2608.00146',
      title: 'A Tracking\n  Pipeline for\nDetectors',
      authors: ['Xiangyang Ju']
    }),
    `Ju, "A Tracking Pipeline for Detectors" — ${ABS_LINK}`
  );
});

test('falls back to the bare link without metadata', () => {
  assert.equal(arxivCitation({ id: '2608.00146' }), ABS_LINK);
  assert.equal(
    arxivCitation({ id: '2608.00146', title: 'Untitled', authors: [] }),
    `"Untitled" — ${ABS_LINK}`
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

test('turns pasted Unicode powers into inline math', () => {
  assert.equal(mathPasteText('32³'), '$32^3$');
  assert.equal(mathPasteText('a 10⁻³ chance'), 'a $10^{-3}$ chance');
  assert.equal(mathPasteText('10²³ atoms'), '$10^{23}$ atoms');
  assert.equal(mathPasteText('x₁ and x₂'), '$x_1$ and $x_2$');
  assert.equal(mathPasteText('aₙ⁻¹'), '$a_n^{-1}$');
});

test('leaves footnote markers and plain text alone', () => {
  assert.equal(mathPasteText('as claimed¹'), null);
  assert.equal(mathPasteText('nothing to convert'), null);
  assert.equal(mathPasteText(''), null);
});

test('skips math conversion inside an open math span', () => {
  assert.equal(mathPasteText('32³', { beforeCursor: 'is $' }), null);
  assert.equal(mathPasteText('32³', { beforeCursor: '$a$ = ' }), '$32^3$');
});

test('locates a double-clicked word on its source line', () => {
  assert.deepEqual(sourceColumnForWord('We measured the decay rate.', 'decay'), {
    from: 16,
    to: 21
  });
});

test('locates the first occurrence of a repeated word', () => {
  assert.deepEqual(sourceColumnForWord('rate over rate', 'rate'), {
    from: 0,
    to: 4
  });
});

test('reports no column when the word is absent or empty', () => {
  assert.equal(sourceColumnForWord('# Heading', 'missing'), null);
  assert.equal(sourceColumnForWord('# Heading', '  \n'), null);
  assert.equal(sourceColumnForWord(), null);
});
