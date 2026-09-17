import assert from 'node:assert/strict';
import test from 'node:test';
import { shortestWikiTarget } from '../src/wiki-target.js';

const PATHS = [
  '/raw/dailynotes/2026-07-08.md',
  '/wiki/concepts/hybrid-search.md',
  '/wiki/topics/hybrid-search.md',
  '/raw/projects/iaas/triton.md'
];

test('shortens a link to a unique basename', () => {
  assert.equal(
    shortestWikiTarget(
      '/raw/projects/iaas/triton.md',
      '/raw/dailynotes/2026-07-08.md',
      PATHS
    ),
    'triton'
  );
});

test('keeps enough path to disambiguate a repeated basename', () => {
  assert.equal(
    shortestWikiTarget(
      '/wiki/concepts/hybrid-search.md',
      '/raw/dailynotes/2026-07-08.md',
      PATHS
    ),
    'concepts/hybrid-search'
  );
});

test('shortens a daily note to its bare date inside the daily note folder', () => {
  assert.equal(
    shortestWikiTarget(
      '/raw/dailynotes/2026-07-08.md',
      '/wiki/topics/hybrid-search.md',
      PATHS,
      {
        dailyNoteFolder: '/raw/dailynotes'
      }
    ),
    '2026-07-08'
  );
});

test('every shortened link resolves back to the note it names', async () => {
  const { resolveWikiLinkPath } = await import('../src/wiki-links.js');

  for (const target of PATHS) {
    const short = shortestWikiTarget(
      target,
      '/raw/dailynotes/2026-07-08.md',
      PATHS
    );
    assert.equal(
      resolveWikiLinkPath(short, '/raw/dailynotes/2026-07-08.md', PATHS),
      target,
      `${short} should resolve to ${target}`
    );
  }
});
