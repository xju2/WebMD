import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWikiLinkPath } from '../src/wiki-links.js';

test('resolves simple wiki links beside the current note', () => {
  const files = [
    { path: '/raw/dailynotes/2026-07-08.md', fileKind: 'markdown' },
    { path: '/raw/dailynotes/2026-07-09.md', fileKind: 'markdown' }
  ];

  assert.equal(
    resolveWikiLinkPath('2026-07-08', '/raw/dailynotes/2026-07-09.md', files),
    '/raw/dailynotes/2026-07-08.md'
  );
});

test('resolves wiki links by unique workspace filename when needed', () => {
  const files = [
    { path: '/raw/dailynotes/2026-07-08.md', fileKind: 'markdown' },
    { path: '/notes/other.md', fileKind: 'markdown' }
  ];

  assert.equal(
    resolveWikiLinkPath('2026-07-08', '/notes/other.md', files),
    '/raw/dailynotes/2026-07-08.md'
  );
});

test('resolves slash wiki links by unique workspace suffix', () => {
  const files = [
    { path: '/wiki/topics/q2c.md', fileKind: 'markdown' },
    { path: '/wiki/index.md', fileKind: 'markdown' }
  ];

  assert.equal(
    resolveWikiLinkPath('topics/q2c', '/wiki/index.md', files),
    '/wiki/topics/q2c.md'
  );
});

test('rejects traversal wiki links', () => {
  assert.equal(resolveWikiLinkPath('../secret', '/notes/today.md', []), '');
});
