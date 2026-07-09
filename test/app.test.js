import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspaceRegistry } from '../server/app.js';

async function tempRoot() {
  return fs.mkdtemp(path.join(tmpdir(), 'webmd-'));
}

test('reads from the selected workspace root', async () => {
  const first = await tempRoot();
  const second = await tempRoot();
  await fs.writeFile(path.join(first, 'first.md'), 'first');
  await fs.writeFile(path.join(second, 'second.md'), 'second');

  const workspaces = await createWorkspaceRegistry([first, second]);
  assert.deepEqual(
    workspaces.options.map((root) => root.name),
    [path.basename(first), path.basename(second)]
  );
  assert.deepEqual(
    (await workspaces.get('1').readTree()).map((node) => node.name),
    ['second.md']
  );
  assert.equal((await workspaces.get('1').loadFile('/second.md')).content, 'second');
  assert.throws(() => workspaces.get('9'), /Unknown workspace root/);
});
