import assert from 'node:assert/strict';
import test from 'node:test';
import {
  headingCompletions,
  noteCompletions,
  wikiCompletionQuery
} from '../src/wiki-complete.js';
import { parseWikiLinkValue, resolveWikiLinkPath } from '../src/wiki-links.js';

const PATHS = [
  '/raw/dailynotes/2026-07-08.md',
  '/raw/projects/iaas/triton.md',
  '/wiki/concepts/hybrid-search.md',
  '/wiki/topics/hybrid-search.md',
  '/assets/diagram.png'
];

test('sees a name being typed inside [[', () => {
  assert.deepEqual(wikiCompletionQuery('see [[trit'), {
    kind: 'note',
    note: '',
    query: 'trit',
    length: 4
  });
});

test('an empty [[ offers everything', () => {
  assert.deepEqual(wikiCompletionQuery('see [['), {
    kind: 'note',
    note: '',
    query: '',
    length: 0
  });
});

test('switches to headings after a #', () => {
  assert.deepEqual(wikiCompletionQuery('see [[triton#Se'), {
    kind: 'heading',
    note: 'triton',
    query: 'Se',
    length: 2
  });
});

test('stops at a closed link, an alias, or plain text', () => {
  assert.equal(wikiCompletionQuery('see [[triton]] and'), null);
  assert.equal(wikiCompletionQuery('see [[triton|Tri'), null);
  assert.equal(wikiCompletionQuery('plain text'), null);
});

test('only the line at the cursor counts', () => {
  assert.equal(wikiCompletionQuery('[[triton]]\nnext line'), null);
});

test('completes note names to the full path, aliased to the name', () => {
  const options = noteCompletions(
    'trit',
    PATHS,
    '/raw/dailynotes/2026-07-08.md'
  );
  assert.deepEqual(options, [
    {
      label: 'triton',
      detail: '/raw/projects/iaas',
      path: '/raw/projects/iaas/triton.md',
      target: '/raw/projects/iaas/triton|triton'
    }
  ]);
});

test('a repeated basename stays distinct, since each target is a full path', () => {
  const targets = noteCompletions(
    'hybrid',
    PATHS,
    '/raw/dailynotes/2026-07-08.md'
  ).map((option) => option.target);
  assert.deepEqual(targets.sort(), [
    '/wiki/concepts/hybrid-search|hybrid-search',
    '/wiki/topics/hybrid-search|hybrid-search'
  ]);
});

// The point of the full path: the inserted link keeps pointing at the note it
// was completed from, even once another note takes the same name.
test('every completed target resolves back to the note it came from', () => {
  const laterPaths = [...PATHS, '/wiki/archive/triton.md'];

  for (const option of noteCompletions('', PATHS, '')) {
    const { target } = parseWikiLinkValue(option.target);
    assert.equal(resolveWikiLinkPath(target, '', laterPaths), option.path);
  }
});

test('the alias is the note name, so the preview reads the same as before', () => {
  const [option] = noteCompletions('trit', PATHS, '');
  assert.deepEqual(parseWikiLinkValue(option.target), {
    target: '/raw/projects/iaas/triton',
    text: 'triton'
  });
});

test('matches a folder as well as a name, and never the open note or media', () => {
  const paths = noteCompletions(
    'iaas',
    PATHS,
    '/wiki/topics/hybrid-search.md'
  ).map((option) => option.path);
  assert.deepEqual(paths, ['/raw/projects/iaas/triton.md']);

  const all = noteCompletions('', PATHS, '/wiki/topics/hybrid-search.md').map(
    (option) => option.path
  );
  assert.ok(!all.includes('/wiki/topics/hybrid-search.md'));
  assert.ok(!all.includes('/assets/diagram.png'));
});

test('completes the headings of a note', () => {
  const content = '# Triton\n\n## Setup\n\n### Ports\n';
  assert.deepEqual(headingCompletions('port', content), [
    { label: 'Ports', detail: '###', target: 'Ports' }
  ]);
  assert.equal(headingCompletions('', content).length, 3);
});
