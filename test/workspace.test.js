import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspace } from '../server/workspace.js';

async function tempRoot() {
  return fs.mkdtemp(path.join(tmpdir(), 'webmd-'));
}

test('rejects traversal paths', async () => {
  const root = await tempRoot();
  const workspace = await createWorkspace(root);

  await assert.rejects(() => workspace.loadFile('/../outside.md'), /Path traversal/);
});

test('rejects symlink escapes', async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  const outsideFile = path.join(outside, 'secret.md');

  await fs.writeFile(outsideFile, 'nope');
  await fs.symlink(outsideFile, path.join(root, 'escape.md'));

  const workspace = await createWorkspace(root);
  await assert.rejects(() => workspace.loadFile('/escape.md'), /outside WORKSPACE_ROOT/);
});

test('saves markdown atomically without leaving temp files', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'old');

  const workspace = await createWorkspace(root);
  await workspace.saveFile('/note.md', 'new');

  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'new');
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.endsWith('.tmp')),
    []
  );
});
