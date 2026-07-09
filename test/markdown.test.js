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

test('auto-links bare URLs', () => {
  assert.deepEqual(parseInline('See https://example.com/doc.pdf')[1], {
    type: 'link',
    text: 'https://example.com/doc.pdf',
    href: 'https://example.com/doc.pdf'
  });
});
