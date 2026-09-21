import assert from 'node:assert/strict';
import test from 'node:test';
import { collectXPosts } from '../src/x-posts.js';

test('collectXPosts keeps labels, reads bare links, and skips the rest', () => {
  const note = [
    '- [Karpathy on X: a thread](https://x.com/karpathy/status/123)',
    '- https://twitter.com/jack/status/20 and again https://x.com/jack/status/20',
    '- [a profile](https://x.com/karpathy) and https://medium.com/p/1',
    '- <https://mobile.x.com/ylecun/status/9?s=20>'
  ].join('\n');

  assert.deepEqual(collectXPosts(note), [
    {
      url: 'https://x.com/karpathy/status/123',
      handle: 'karpathy',
      label: 'Karpathy on X: a thread'
    },
    { url: 'https://x.com/jack/status/20', handle: 'jack', label: 'jack on X' },
    {
      url: 'https://x.com/ylecun/status/9',
      handle: 'ylecun',
      label: 'ylecun on X'
    }
  ]);
});

test('listXPosts puts the newest note first and keeps a real label', async () => {
  const { mkdtemp, writeFile, utimes } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createWorkspace } = await import('../server/workspace.js');
  const dir = await mkdtemp(join(tmpdir(), 'webmd-x-'));
  await writeFile(
    join(dir, 'old.md'),
    '[Ann on X: hi](https://x.com/ann/status/1)'
  );
  await writeFile(join(dir, 'new.md'), 'https://x.com/ann/status/1');
  await utimes(join(dir, 'old.md'), 1, 1);

  const { posts } = await (await createWorkspace(dir)).listXPosts();
  assert.deepEqual(
    posts.map(({ label, path }) => [label, path]),
    [['Ann on X: hi', '/new.md']]
  );
});
