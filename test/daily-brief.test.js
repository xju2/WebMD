import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDailyBrief } from '../server/daily-brief.js';
import { createWorkspace } from '../server/workspace.js';

async function tempRoot() {
  return fs.mkdtemp(path.join(tmpdir(), 'webmd-brief-'));
}

test('reads the Codex daily brief contract file', async () => {
  const root = await tempRoot();
  const workspace = await createWorkspace(root);

  assert.deepEqual(await readDailyBrief(workspace), {
    path: '/raw/dailybrief/latest.md',
    content: ''
  });

  await fs.mkdir(path.join(root, 'raw', 'dailybrief'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'raw', 'dailybrief', 'latest.md'),
    '# Daily Brief\n'
  );

  assert.deepEqual(await readDailyBrief(workspace), {
    path: '/raw/dailybrief/latest.md',
    content: '# Daily Brief\n'
  });
});
