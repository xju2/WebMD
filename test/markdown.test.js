import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInline, renderMarkdown } from '../src/markdown.js';

test('renders common markdown blocks safely', () => {
  const blocks = renderMarkdown(`# Title

Text with [a link](https://example.com) and \`code\`.

- [x] done
- next

\`\`\`js
console.log("ok");
\`\`\`
`);

  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].children[0].text, 'Title');
  assert.equal(blocks[1].children[1].href, 'https://example.com');
  assert.deepEqual(
    blocks[2].items.map((item) => [item.task, item.checked]),
    [
      [true, true],
      [false, false]
    ]
  );
  assert.equal(blocks[3].type, 'code');
  assert.equal(blocks[3].lang, 'js');
});

test('drops unsafe link targets', () => {
  assert.equal(parseInline('[bad](javascript:alert(1))')[0].href, '');
});

test('renders pipe tables with alignment and inline cells', () => {
  const blocks = renderMarkdown(`Intro
| Name | Scale | Notes |
|:---|---:|:---:|
| FM4NPP | 10B-100B | **raw** |
| Q2C | 100M-100B | [docs](/wiki/q2c) |
`);

  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[1].type, 'table');
  assert.deepEqual(blocks[1].alignments, ['left', 'right', 'center']);
  assert.deepEqual(
    blocks[1].headers.map((cell) => cell[0].text),
    ['Name', 'Scale', 'Notes']
  );
  assert.equal(blocks[1].rows[0][2][0].type, 'strong');
  assert.equal(blocks[1].rows[1][2][0].href, '/wiki/q2c');
});

test('renders supported callout blockquotes', () => {
  const blocks = renderMarkdown(`> [!note] My Note
> Body with **detail**.

> [!tldr]
> Short version.

> [!warning] Keep as quote
`);

  assert.equal(blocks[0].type, 'callout');
  assert.equal(blocks[0].variant, 'note');
  assert.equal(blocks[0].title[0].text, 'My Note');
  assert.equal(blocks[0].children[1].type, 'strong');
  assert.equal(blocks[1].type, 'callout');
  assert.equal(blocks[1].variant, 'tldr');
  assert.equal(blocks[1].title[0].text, 'TLDR');
  assert.equal(blocks[2].type, 'quote');
});

test('auto-links bare URLs', () => {
  assert.deepEqual(parseInline('See https://example.com/doc.pdf')[1], {
    type: 'link',
    text: 'https://example.com/doc.pdf',
    href: 'https://example.com/doc.pdf'
  });
});

test('parses wiki links as workspace references', () => {
  assert.deepEqual(parseInline('See [[2026-07-08]]')[1], {
    type: 'wikiLink',
    target: '2026-07-08',
    text: '2026-07-08'
  });
  assert.deepEqual(parseInline('See [[2026-07-08|yesterday]]')[1], {
    type: 'wikiLink',
    target: '2026-07-08',
    text: 'yesterday'
  });
});
