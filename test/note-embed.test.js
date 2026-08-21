import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../src/markdown.js';
import { sliceNoteSection, splitEmbedTarget } from '../src/note-embed.js';

const NOTE = `---
title: Athena
---
# Athena setup

Intro line.

## Build

- [ ] compile
### Details
deeper

## Run

go
`;

test('splits an embed target from its section', () => {
  assert.deepEqual(splitEmbedTarget('/raw/projects/athena#Build'), {
    path: '/raw/projects/athena',
    heading: 'Build'
  });
  assert.deepEqual(splitEmbedTarget('athena'), {
    path: 'athena',
    heading: ''
  });
});

test('slices a whole note without its frontmatter', () => {
  const body = sliceNoteSection(NOTE);
  assert.ok(body.startsWith('# Athena setup'));
  assert.ok(!body.includes('title: Athena'));
});

test('slices a section and its subsections', () => {
  assert.equal(
    sliceNoteSection(NOTE, 'build'),
    '## Build\n\n- [ ] compile\n### Details\ndeeper'
  );
});

test('reports a missing section as empty', () => {
  assert.equal(sliceNoteSection(NOTE, 'Deploy'), '');
});

test('parses an embed on its own line as a note preview', () => {
  const [block] = renderMarkdown('![[/raw/projects/athena#Build]]');
  assert.deepEqual(block, {
    type: 'noteEmbed',
    target: '/raw/projects/athena#Build',
    text: 'athena#Build',
    line: 0
  });
});

test('keeps an image embed inline rather than making it a card', () => {
  const [block] = renderMarkdown('![[assets/plot.png]]');
  assert.equal(block.type, 'paragraph');
  assert.equal(block.children[0].type, 'wikiEmbed');
});

test('keeps a mid-sentence embed out of the note preview', () => {
  const [block] = renderMarkdown('See ![[athena]] for the setup.');
  assert.equal(block.type, 'paragraph');
  assert.equal(block.children[1].type, 'wikiEmbed');
});

test('ends the paragraph above an embed', () => {
  const blocks = renderMarkdown('Context line.\n![[athena]]\nAfter.');
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['paragraph', 'noteEmbed', 'paragraph']
  );
});
