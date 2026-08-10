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

test('keeps media extensions instead of appending .md', () => {
  const files = [
    { path: '/raw/assets/2026-08-10-01.pdf', fileKind: 'pdf' },
    { path: '/raw/dailynotes/2026-08-10.md', fileKind: 'markdown' }
  ];

  assert.equal(
    resolveWikiLinkPath(
      '/raw/assets/2026-08-10-01.pdf',
      '/raw/dailynotes/2026-08-10.md',
      files
    ),
    '/raw/assets/2026-08-10-01.pdf'
  );
});

test('resolves media wiki links by unique workspace filename', () => {
  const files = [
    { path: '/raw/assets/scan.pdf', fileKind: 'pdf' },
    { path: '/raw/assets/photo.png', fileKind: 'image' },
    { path: '/notes/today.md', fileKind: 'markdown' }
  ];

  assert.equal(
    resolveWikiLinkPath('scan.pdf', '/notes/today.md', files),
    '/raw/assets/scan.pdf'
  );
  assert.equal(
    resolveWikiLinkPath('photo.png', '/notes/today.md', files),
    '/raw/assets/photo.png'
  );
});

test('still appends .md to note titles that contain dots', () => {
  assert.equal(
    resolveWikiLinkPath('release 1.2', '/notes/today.md', []),
    '/notes/release 1.2.md'
  );
});

test('sends missing date links to the daily note folder', () => {
  const files = [{ path: '/wiki/topics/q2c.md', fileKind: 'markdown' }];

  assert.equal(
    resolveWikiLinkPath('2026-08-03', '/wiki/topics/q2c.md', files, {
      dailyNoteFolder: '/raw/dailynotes'
    }),
    '/raw/dailynotes/2026-08-03.md'
  );
});

test('prefers the daily note over a same-named note beside the link', () => {
  const files = [
    { path: '/meetings/2026-08-03.md', fileKind: 'markdown' },
    { path: '/meetings/agenda.md', fileKind: 'markdown' },
    { path: '/raw/dailynotes/2026-08-03.md', fileKind: 'markdown' }
  ];

  assert.equal(
    resolveWikiLinkPath('2026-08-03', '/meetings/agenda.md', files, {
      dailyNoteFolder: '/raw/dailynotes'
    }),
    '/raw/dailynotes/2026-08-03.md'
  );
});

test('falls back to a date note kept outside the daily note folder', () => {
  const files = [
    { path: '/archive/2026-08-03.md', fileKind: 'markdown' },
    { path: '/wiki/topics/q2c.md', fileKind: 'markdown' }
  ];

  assert.equal(
    resolveWikiLinkPath('2026-08-03', '/wiki/topics/q2c.md', files, {
      dailyNoteFolder: '/raw/dailynotes'
    }),
    '/archive/2026-08-03.md'
  );
});

test('keeps date links with an explicit folder out of the daily note folder', () => {
  assert.equal(
    resolveWikiLinkPath('archive/2026-08-03', '/wiki/topics/q2c.md', [], {
      dailyNoteFolder: '/raw/dailynotes'
    }),
    '/wiki/topics/archive/2026-08-03.md'
  );
});

test('resolves date links beside the link without a daily note folder', () => {
  assert.equal(
    resolveWikiLinkPath('2026-08-03', '/wiki/topics/q2c.md', []),
    '/wiki/topics/2026-08-03.md'
  );
});

test('rejects traversal wiki links', () => {
  assert.equal(resolveWikiLinkPath('../secret', '/notes/today.md', []), '');
});
