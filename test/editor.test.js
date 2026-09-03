import assert from 'node:assert/strict';
import test from 'node:test';
import {
  arxivCitation,
  arxivLinkPaste,
  arxivPasteId,
  mathPasteText,
  quotedBlockPaste,
  pastedFromCode,
  shortLinkPaste,
  sourceColumnForWord,
  tidyPasteText
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
  assert.equal(
    arxivPasteId('https://arxiv.org/pdf/2608.00146v2'),
    '2608.00146v2'
  );
  assert.equal(
    arxivPasteId('https://arxiv.org/abs/hep-th/9901001'),
    'hep-th/9901001'
  );
  assert.equal(arxivPasteId('arxiv.org/pdf/2511.15684'), '2511.15684');
  assert.equal(arxivPasteId('www.arxiv.org/abs/2608.00146'), '2608.00146');
  assert.equal(arxivPasteId('arXiv:2511.15684'), '2511.15684');
  assert.equal(arxivPasteId('arxiv: 2608.00146v2'), '2608.00146v2');
  assert.equal(arxivPasteId('arXiv:hep-th/9901001'), 'hep-th/9901001');
  assert.equal(arxivPasteId('arXiv 2511.15684'), null);
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
  assert.deepEqual(
    sourceColumnForWord('We measured the decay rate.', 'decay'),
    {
      from: 16,
      to: 21
    }
  );
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

test('strips trailing spaces, CRLF, and runs of blank lines from a paste', () => {
  const pasted = 'first line  \r\nsecond\ttab \r\n\r\n\r\n\r\nlast\r\n\r\n';
  assert.equal(tidyPasteText(pasted), 'first line\nsecond\ttab\n\nlast');
});

test('turns non-breaking and typographic spaces into ordinary ones', () => {
  assert.equal(tidyPasteText('one two three　four'), 'one two three four');
});

test('leaves already-clean text to the browser', () => {
  assert.equal(tidyPasteText('one\ntwo'), null);
  assert.equal(tidyPasteText(''), null);
});

test('drops the indentation a page wraps around copied prose', () => {
  const pasted = '    A paragraph.\n\n    Another one.';
  assert.equal(
    tidyPasteText(pasted, { dedent: true }),
    'A paragraph.\n\nAnother one.'
  );
});

test('keeps relative indentation when dedenting', () => {
  const pasted = '  def run():\n      return 1\n  # done';
  assert.equal(
    tidyPasteText(pasted, { dedent: true }),
    'def run():\n    return 1\n# done'
  );
});

test('only dedents when asked', () => {
  assert.equal(tidyPasteText('    indented', { dedent: false }), null);
});

test('leaves indentation alone when the clipboard says it is code', () => {
  withDomParser(() => {
    const pasted = '    def run():\n        return 1';
    assert.equal(
      tidyPasteText(pasted, {
        dedent: true,
        html: '<pre><code>    def run():\n        return 1</code></pre>'
      }),
      null
    );
  });
});

test('reads a code block out of the clipboard html', () => {
  withDomParser(() => {
    assert.equal(pastedFromCode('<pre>x = 1</pre>'), true);
    assert.equal(pastedFromCode('<code>x = 1</code>'), true);
    assert.equal(pastedFromCode('<p>run <code>x</code> first</p>'), false);
    assert.equal(pastedFromCode('<p>plain prose</p>'), false);
    assert.equal(pastedFromCode(''), false);
  });
});

/**
 * A stand-in for the browser parser, big enough for the queries
 * `pastedFromCode` makes: `<pre>` anywhere, and `<code>` against the text of
 * the whole fragment.
 */
function withDomParser(run) {
  const original = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString(html) {
      const text = (value) => value.replace(/<[^>]*>/g, '');
      const tags = (name) =>
        [
          ...html.matchAll(
            new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'g')
          )
        ].map((match) => ({ textContent: text(match[1]) }));
      return {
        body: { textContent: text(html) },
        querySelector: (name) => tags(name)[0] || null,
        querySelectorAll: (name) => tags(name)
      };
    }
  };

  try {
    run();
  } finally {
    globalThis.DOMParser = original;
  }
}

const MR_URL =
  'https://gitlab.cern.ch/atlas/atlasexternals/-/merge_requests/1436';

test('shortens a pasted GitLab merge request to its reference', () => {
  assert.equal(
    shortLinkPaste(MR_URL),
    `[atlas/atlasexternals!1436](${MR_URL})`
  );
});

test('keeps the nested group path of a GitLab project', () => {
  const url = 'https://gitlab.cern.ch/atlas/athena/sub/-/issues/42';
  assert.equal(shortLinkPaste(url), `[atlas/athena/sub#42](${url})`);
});

test('names a GitHub tree link after the repository and path', () => {
  const url =
    'https://github.com/milescb/traccc-aaS/tree/main/backend/traccc-gpu';
  assert.equal(
    shortLinkPaste(url),
    `[milescb/traccc-aaS/backend/traccc-gpu](${url})`
  );
});

test('names a bare GitHub repository link after the repository', () => {
  const url = 'https://github.com/milescb/traccc-aaS';
  assert.equal(shortLinkPaste(url), `[milescb/traccc-aaS](${url})`);
  assert.equal(
    shortLinkPaste('https://github.com/milescb/traccc-aaS/tree/main'),
    '[milescb/traccc-aaS](https://github.com/milescb/traccc-aaS/tree/main)'
  );
});

test('shortens GitHub pull requests, issues and commits', () => {
  const pull = 'https://github.com/a/b/pull/12#issuecomment-9';
  assert.equal(shortLinkPaste(pull), `[a/b#12](${pull})`);

  const issue = 'https://github.com/a/b/issues/7';
  assert.equal(shortLinkPaste(issue), `[a/b#7](${issue})`);

  const commit = 'https://github.com/a/b/commit/0123456789abcdef';
  assert.equal(shortLinkPaste(commit), `[a/b@0123456](${commit})`);
});

test('leaves links alone when there is nothing shorter to say', () => {
  assert.equal(shortLinkPaste('https://example.com/some/page'), null);
  assert.equal(shortLinkPaste('https://github.com/milescb'), null);
  assert.equal(shortLinkPaste('not a url'), null);
  assert.equal(shortLinkPaste(`see ${MR_URL} for it`), null);
});

test('skips shortening a link pasted into markdown link syntax', () => {
  assert.equal(shortLinkPaste(MR_URL, { beforeCursor: '[mr](' }), null);
  assert.equal(shortLinkPaste(MR_URL, { beforeCursor: '<' }), null);
});

test('falls back to the project when the file path is longer than the link', () => {
  const url =
    'https://github.com/a/b/blob/main/very/deeply/nested/directory/tree/with/a/long/name/file.py';
  assert.equal(shortLinkPaste(url), `[a/b](${url})`);
});
