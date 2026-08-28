import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFrontmatter } from '../src/frontmatter.js';
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

test('lifts task metadata out of the rendered text', () => {
  const blocks = renderMarkdown(
    '- [ ] Submit the abstract 📅 2026-08-20 ⏫\n- plain'
  );

  const [task, plain] = blocks[0].items;
  assert.equal(task.children[0].text, 'Submit the abstract');
  assert.equal(task.meta.due, '2026-08-20');
  assert.equal(task.meta.priority, 'high');
  assert.equal(plain.meta, null);
});

test('marks inline tags without moving them out of the sentence', () => {
  const blocks = renderMarkdown('- [ ] Fix the #bug in the parser ⏫');
  const [task] = blocks[0].items;

  assert.deepEqual(
    task.children.map((segment) => [segment.type, segment.text]),
    [
      ['text', 'Fix the '],
      ['tag', 'bug'],
      ['text', ' in the parser']
    ]
  );
  assert.equal(task.meta.priority, 'high');
});

test('marks inline tags in ordinary prose', () => {
  assert.deepEqual(parseInline('Read this #paper soon')[1], {
    type: 'tag',
    text: 'paper'
  });
});

test('marks who: names in place, keeping the sentence readable', () => {
  const blocks = renderMarkdown(
    '- [ ] who:Julien and who:jack will implement this 📅 2026-08-20'
  );
  const [task] = blocks[0].items;

  assert.deepEqual(
    task.children.map((segment) => [segment.type, segment.text]),
    [
      ['assignee', 'Julien'],
      ['text', ' and '],
      ['assignee', 'Jack'],
      ['text', ' will implement this']
    ]
  );
  assert.deepEqual(task.meta.assignees, ['julien', 'jack']);
  assert.equal(task.meta.due, '2026-08-20');
});

test('leaves text that only looks like an assignment alone', () => {
  const cases = [
    'Ask who: about it',
    'Read https://example.com/page/who:top now',
    'Type `who:me` to claim one'
  ];

  cases.forEach((source) => {
    assert.equal(
      parseInline(source).some((segment) => segment.type === 'assignee'),
      false,
      source
    );
  });
});

test('leaves text that only looks like a tag alone', () => {
  const cases = [
    'Written in C# lately',
    'See issue #123 today',
    'Read https://example.com/page#top now',
    'Type `#bug` to file one'
  ];

  cases.forEach((source) => {
    assert.equal(
      parseInline(source).some((segment) => segment.type === 'tag'),
      false,
      source
    );
  });
});

test('renders YAML frontmatter as a property block ahead of the body', () => {
  const source = `---
type: Playbook
title: Incident response
tags: [oncall, incident]
---
# Trigger
Act now.
`;
  const parsed = parseFrontmatter(source);
  const blocks = renderMarkdown(source);

  assert.deepEqual(parsed.attributes.tags, ['oncall', 'incident']);
  assert.equal(parsed.attributes.title, 'Incident response');

  assert.equal(blocks[0].type, 'frontmatter');
  const fields = Object.fromEntries(blocks[0].fields.map((f) => [f.key, f]));
  assert.equal(fields.title.values[0][0].text, 'Incident response');
  assert.deepEqual(
    fields.tags.values.map((v) => v[0].text),
    ['oncall', 'incident']
  );

  assert.equal(blocks[1].type, 'heading');
  assert.equal(blocks[1].children[0].text, 'Trigger');
});

test('renders fenced unified diffs as diff blocks', () => {
  const blocks = renderMarkdown(`\`\`\`diff
diff --git a/scripts/submit_reco_h5.sh b/scripts/submit_reco_h5.sh
index 42ced7d..19ccce4 100755
--- a/scripts/submit_reco_h5.sh
+++ b/scripts/submit_reco_h5.sh
@@ -10,13 +10,14 @@ export MPICH_MPIIO_DVS_MAXNODES=48
 IN_VAL_H5_FILE="/global/cfs/cdirs/m3443/data/foundational_universe/raw_data/L80_N4096/L80_N4096_z3_s2.hdf5"
-RECO_H5_FILE="/global/cfs/cdirs/m3443/data/foundational_universe/raw_data/L80_N4096/L80_N4096_z3_s2_RECO.hdf5"
+RECO_H5_FILE="/global/cfs/cdirs/m3443/data/foundational_universe/raw_data/L80_N4096/L80_N4096_z3_s2_RECO_x0-7-1_v1.hdf5"
+TRAIN_CONFIG_FILE="src/fundra/configs/resolved/vqvae/x0.7.0.yaml"
\`\`\``);

  assert.equal(blocks[0].type, 'diff');
  assert.equal(blocks[0].files[0].title, 'scripts/submit_reco_h5.sh');
  assert.equal(blocks[0].files[0].hunks[0].header, '@@ -10,13 +10,14 @@');
  assert.deepEqual(
    blocks[0].files[0].hunks[0].lines.map((line) => line.kind),
    ['context', 'removed', 'added', 'added']
  );
});

test('renders fenced mermaid as diagram blocks', () => {
  const blocks = renderMarkdown(`\`\`\`mermaid
flowchart TD
  A[Start] --> B[Finish]
\`\`\`

\`\`\`Mermaid
sequenceDiagram
  Alice->>Bob: hi
\`\`\`

\`\`\`js
console.log("ok");
\`\`\``);

  assert.equal(blocks[0].type, 'mermaid');
  assert.equal(blocks[0].text, 'flowchart TD\n  A[Start] --> B[Finish]');
  assert.equal(blocks[1].type, 'mermaid');
  assert.equal(blocks[2].type, 'code');
});

test('reads a title out of the code fence info string', () => {
  const blocks = renderMarkdown(`\`\`\`bash,title="training cmds"
fundra train
\`\`\`

\`\`\`bash title="deploy cmds"
fundra deploy
\`\`\`

\`\`\`python title='eval' caption="ignored"
run()
\`\`\`

\`\`\`mermaid title="flow"
flowchart TD
  A --> B
\`\`\``);

  assert.deepEqual(
    blocks.map((block) => [block.type, block.lang, block.title, block.text]),
    [
      ['code', 'bash', 'training cmds', 'fundra train'],
      ['code', 'bash', 'deploy cmds', 'fundra deploy'],
      ['code', 'python', 'eval', 'run()'],
      ['mermaid', 'mermaid', undefined, 'flowchart TD\n  A --> B']
    ]
  );
});

test('keeps plain fences working without attributes', () => {
  const blocks = renderMarkdown(`\`\`\`
bare
\`\`\`

\`\`\`js
console.log("ok");
\`\`\``);

  assert.deepEqual(
    blocks.map((block) => [block.type, block.lang, block.title]),
    [
      ['code', '', ''],
      ['code', 'js', '']
    ]
  );
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

test('a blank line inside a blockquote starts a new paragraph', () => {
  const [block] = renderMarkdown(`> "First quote" -- Someone (1997)
>
> "Second quote"
`);

  assert.equal(block.type, 'quote');
  assert.equal(block.paragraphs.length, 2);
  assert.equal(
    block.paragraphs[0].children[0].text,
    '"First quote" -- Someone (1997)'
  );
  assert.equal(block.paragraphs[0].line, 0);
  assert.equal(block.paragraphs[1].children[0].text, '"Second quote"');
  assert.equal(block.paragraphs[1].line, 2);
});

test('wrapped lines inside a blockquote stay one paragraph', () => {
  const [block] = renderMarkdown('> one\n> two\n');

  assert.equal(block.paragraphs.length, 1);
  assert.equal(block.paragraphs[0].children[0].text, 'one two');
});

test('renders supported callout blockquotes', () => {
  const blocks = renderMarkdown(`> [!note] My Note
> Body with **detail**.

> [!tldr]
> Short version.

> [!warning]
> Check this.

> [!idea]
> Try this.

> [!error]
> Broken.

> [!code]
> \`wrap me\`

> [!prompt]
> Summarize this note.
`);

  assert.equal(blocks[0].type, 'callout');
  assert.equal(blocks[0].variant, 'note');
  assert.equal(blocks[0].title[0].text, 'My Note');
  assert.equal(blocks[0].children[0].children[1].type, 'strong');
  assert.equal(blocks[1].type, 'callout');
  assert.equal(blocks[1].variant, 'tldr');
  assert.equal(blocks[1].title[0].text, 'TLDR');
  assert.equal(blocks[2].type, 'callout');
  assert.equal(blocks[2].variant, 'warning');
  assert.equal(blocks[2].title[0].text, 'Warning');
  assert.equal(blocks[3].type, 'callout');
  assert.equal(blocks[3].variant, 'idea');
  assert.equal(blocks[3].title[0].text, 'Idea');
  assert.equal(blocks[4].type, 'callout');
  assert.equal(blocks[4].variant, 'error');
  assert.equal(blocks[4].title[0].text, 'Error');
  assert.equal(blocks[5].type, 'callout');
  assert.equal(blocks[5].variant, 'code');
  assert.equal(blocks[5].title[0].text, 'Code');
  assert.equal(blocks[6].type, 'callout');
  assert.equal(blocks[6].variant, 'prompt');
  assert.equal(blocks[6].title[0].text, 'Prompt');
});

test('renders details blocks with markdown children', () => {
  const blocks = renderMarkdown(`<details>
<summary>Show code</summary>

\`\`\`js
console.log("ok");
\`\`\`
</details>
`);

  assert.equal(blocks[0].type, 'details');
  assert.equal(blocks[0].summary[0].text, 'Show code');
  assert.equal(blocks[0].children[0].type, 'code');
  assert.equal(blocks[0].children[0].lang, 'js');
});

test('renders markdown blocks inside callouts', () => {
  const blocks = renderMarkdown(`> [!info] HITS dataset **e8481\\_s4149** info:
> - identifier                : 2950990
> - nFiles                    : 49,984
`);

  assert.equal(blocks[0].type, 'callout');
  assert.equal(blocks[0].title[1].type, 'strong');
  assert.equal(blocks[0].children[0].type, 'list');
  assert.deepEqual(
    blocks[0].children[0].items.map((item) => item.children[0].text),
    [
      'identifier                : 2950990',
      'nFiles                    : 49,984'
    ]
  );
});

test('auto-links bare URLs', () => {
  assert.deepEqual(parseInline('See https://example.com/doc.pdf')[1], {
    type: 'link',
    text: 'https://example.com/doc.pdf',
    href: 'https://example.com/doc.pdf'
  });
});

test('parses inline math spans', () => {
  assert.deepEqual(parseInline('Angle $\\alpha$ matters')[1], {
    type: 'math',
    text: '\\alpha'
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

test('parses embedded wiki links for media previews', () => {
  assert.deepEqual(parseInline('![[assets/image.png|plot]]')[0], {
    type: 'wikiEmbed',
    target: 'assets/image.png',
    text: 'plot'
  });
});

test('records the source line each block starts on', () => {
  const blocks = renderMarkdown(`# Title

Intro paragraph.

- first
- second

| a | b |
| --- | --- |
| 1 | 2 |
| 3 | 4 |

---
`);

  assert.deepEqual(
    blocks.map((block) => [block.type, block.line]),
    [
      ['heading', 0],
      ['paragraph', 2],
      ['list', 4],
      ['table', 7],
      ['rule', 12]
    ]
  );
  assert.deepEqual(
    blocks[2].items.map((item) => item.line),
    [4, 5]
  );
  assert.deepEqual(blocks[3].rowLines, [9, 10]);
});

test('counts frontmatter lines when mapping body blocks', () => {
  const blocks = renderMarkdown(`---
title: Notes
---
# Trigger

Act now.
`);

  assert.deepEqual(
    blocks.map((block) => [block.type, block.line]),
    [
      ['frontmatter', 0],
      ['heading', 3],
      ['paragraph', 5]
    ]
  );
});

test('maps nested callout and details children to absolute lines', () => {
  const blocks = renderMarkdown(`Intro.

> [!note] Heads up
> Nested paragraph.

<details>
<summary>More</summary>
Hidden paragraph.
</details>
`);

  assert.equal(blocks[1].type, 'callout');
  assert.equal(blocks[1].line, 2);
  assert.deepEqual(
    blocks[1].children.map((child) => [child.type, child.line]),
    [['paragraph', 3]]
  );
  assert.equal(blocks[2].type, 'details');
  assert.equal(blocks[2].line, 5);
  assert.deepEqual(
    blocks[2].children.map((child) => [child.type, child.line]),
    [['paragraph', 7]]
  );
});

test('maps each frontmatter field to its own source line', () => {
  const blocks = renderMarkdown(`---
title: Notes
tags: [a, b]
---
Body.
`);

  assert.deepEqual(
    blocks[0].fields.map((field) => [field.key, field.line]),
    [
      ['title', 1],
      ['tags', 2]
    ]
  );
});

test('nests an indented list under the item above it', () => {
  const blocks = renderMarkdown(`- alpha
  - beta
    - gamma
- delta
`);

  assert.equal(blocks.length, 1);
  assert.deepEqual(
    blocks[0].items.map((item) => item.children[0].text),
    ['alpha', 'delta']
  );

  const [beta] = blocks[0].items[0].list;
  assert.equal(beta.type, 'list');
  assert.equal(beta.items[0].children[0].text, 'beta');
  assert.equal(beta.items[0].line, 1);
  assert.equal(beta.items[0].list[0].items[0].children[0].text, 'gamma');
});

test('a sub-list may change marker without leaving its parent', () => {
  const blocks = renderMarkdown(`- alpha
  1. one
  2. two
- beta
`);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 2);

  const [numbers] = blocks[0].items[0].list;
  assert.equal(numbers.ordered, true);
  assert.deepEqual(
    numbers.items.map((item) => item.children[0].text),
    ['one', 'two']
  );
});

test('a different marker at the same depth still starts a new list', () => {
  const blocks = renderMarkdown(`- bullet
1. number
`);

  assert.deepEqual(
    blocks.map((block) => [block.type, block.ordered]),
    [
      ['list', false],
      ['list', true]
    ]
  );
});

test('numbers sub-tasks in source order and keeps their lines', () => {
  const counter = { value: 0 };
  const blocks = renderMarkdown(
    `- [ ] parent
  - [x] child
- [ ] sibling
`,
    counter
  );

  assert.equal(counter.value, 3);
  assert.deepEqual(
    [
      blocks[0].items[0].taskIndex,
      blocks[0].items[0].list[0].items[0].taskIndex,
      blocks[0].items[1].taskIndex
    ],
    [0, 1, 2]
  );
  assert.equal(blocks[0].items[0].list[0].items[0].line, 1);
  assert.equal(blocks[0].items[0].list[0].items[0].checked, true);
});

test('renders a fenced $$ block as display math', () => {
  const blocks = renderMarkdown(
    'Before\n\n$$\nQK^\\top \\quad\\text{and}\\quad V\n$$\n\nAfter'
  );

  assert.deepEqual(
    blocks.map((block) => block.type),
    ['paragraph', 'mathBlock', 'paragraph']
  );
  assert.equal(blocks[1].text, 'QK^\\top \\quad\\text{and}\\quad V');
  assert.equal(blocks[1].line, 2);
});

test('keeps multi-line display math together', () => {
  const [block] = renderMarkdown('$$\na = b\n\\\\\nc = d\n$$');

  assert.equal(block.type, 'mathBlock');
  assert.equal(block.text, 'a = b\n\\\\\nc = d');
});

test('renders single-line $$ math as its own block', () => {
  const blocks = renderMarkdown('Text\n$$E = mc^2$$\nMore text');

  assert.deepEqual(
    blocks.map((block) => block.type),
    ['paragraph', 'mathBlock', 'paragraph']
  );
  assert.equal(blocks[1].text, 'E = mc^2');
});

test('an unclosed $$ block runs to the end of the note', () => {
  const [block] = renderMarkdown('$$\na = b\nc = d');

  assert.equal(block.type, 'mathBlock');
  assert.equal(block.text, 'a = b\nc = d');
});

test('leaves inline $ math to the inline parser', () => {
  const [block] = renderMarkdown('The width is $C$ per site.');

  assert.equal(block.type, 'paragraph');
  assert.deepEqual(
    block.children.map((segment) => segment.type),
    ['text', 'math', 'text']
  );
});
