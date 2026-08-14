import assert from 'node:assert/strict';
import test from 'node:test';
import { relatedInsertion, shortestWikiTarget } from '../src/related-links.js';

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

test('appends a Related section when the note has none', () => {
  const content = '# Monday\n\n- shipped the tokenizer\n';
  const insertion = relatedInsertion(content, [
    { target: 'triton', reason: 'same serving stack' }
  ]);

  const next =
    content.slice(0, insertion.from) +
    insertion.insert +
    content.slice(insertion.to);
  assert.equal(
    next,
    '# Monday\n\n- shipped the tokenizer\n\n## Related\n- [[triton]] — same serving stack\n'
  );
});

test('merges into an existing related section whatever it is called', () => {
  const content = '# Page\n\n## Related pages\n- [[concepts/a]]\n';
  const insertion = relatedInsertion(content, [
    { target: 'triton', reason: 'serving' }
  ]);

  const next =
    content.slice(0, insertion.from) +
    insertion.insert +
    content.slice(insertion.to);
  assert.equal(
    next,
    '# Page\n\n## Related pages\n- [[concepts/a]]\n- [[triton]] — serving\n'
  );
});

test('keeps a heading that follows the related section below the new links', () => {
  const content = '## Related\n- [[a]]\n\n## Notes\n\nstill here\n';
  const insertion = relatedInsertion(content, [{ target: 'b' }]);

  const next =
    content.slice(0, insertion.from) +
    insertion.insert +
    content.slice(insertion.to);
  assert.equal(
    next,
    '## Related\n- [[a]]\n- [[b]]\n\n## Notes\n\nstill here\n'
  );
});

test('skips links the note already carries and reports nothing left to add', () => {
  const content = '# Page\n\n## Related\n- [[triton]]\n';
  assert.equal(
    relatedInsertion(content, [{ target: 'triton', reason: 'again' }]),
    null
  );
});

test('writes a bare bullet when the model gave no reason', () => {
  const insertion = relatedInsertion('# Page\n', [
    { target: 'triton', reason: '  ' }
  ]);
  assert.match(insertion.insert, /- \[\[triton\]\]\n/);
});
