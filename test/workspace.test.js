import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createWorkspace } from '../server/workspace.js';

const execFileAsync = promisify(execFile);

async function tempRoot() {
  return fs.mkdtemp(path.join(tmpdir(), 'webmd-'));
}

test('rejects traversal paths', async () => {
  const root = await tempRoot();
  const workspace = await createWorkspace(root);

  await assert.rejects(() => workspace.loadFile('/../outside.md'), /Path traversal/);
});

test('reports missing markdown files as not found', async () => {
  const root = await tempRoot();
  const workspace = await createWorkspace(root);

  await assert.rejects(
    () => workspace.loadFile('/missing.md'),
    (error) => error.status === 404 && /not found/i.test(error.message)
  );
});

test('returns markdown, image, and PDF files in the workspace tree', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'raw', 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'raw', 'assets', 'manual.pdf'), 'pdf');
  await fs.writeFile(path.join(root, 'raw', 'assets', 'photo.png'), 'png');
  await fs.writeFile(path.join(root, 'raw', 'assets', 'table.csv'), 'csv');
  await fs.writeFile(path.join(root, 'note.md'), 'note');

  const workspace = await createWorkspace(root);

  assert.deepEqual(await workspace.readTree(), [
    {
      name: 'raw',
      type: 'directory',
      path: '/raw',
      children: [
        {
          name: 'assets',
          type: 'directory',
          path: '/raw/assets',
          children: [
            {
              name: 'manual.pdf',
              type: 'file',
              path: '/raw/assets/manual.pdf',
              fileKind: 'pdf'
            },
            {
              name: 'photo.png',
              type: 'file',
              path: '/raw/assets/photo.png',
              fileKind: 'image'
            }
          ]
        }
      ]
    },
    {
      name: 'note.md',
      type: 'file',
      path: '/note.md',
      fileKind: 'markdown'
    }
  ]);
});

test('resolves media files for read-only preview', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'raw', 'assets'), { recursive: true });
  const image = path.join(root, 'raw', 'assets', 'photo.png');
  await fs.writeFile(image, 'png');
  await fs.writeFile(path.join(root, 'raw', 'assets', 'table.csv'), 'csv');

  const workspace = await createWorkspace(root);
  const result = await workspace.loadMediaFile('/raw/assets/photo.png');

  assert.equal(result.path, '/raw/assets/photo.png');
  assert.equal(result.fileKind, 'image');
  assert.equal(await fs.readFile(result.absolute, 'utf8'), 'png');
  await assert.rejects(
    () => workspace.loadMediaFile('/raw/assets/table.csv'),
    /Only image and PDF files/
  );
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

test('creates missing folders when saving markdown', async () => {
  const root = await tempRoot();
  const workspace = await createWorkspace(root);

  await workspace.saveFile('/daily/2026-07-09.md', '# 2026-07-09\n');

  assert.equal(
    await fs.readFile(path.join(root, 'daily', '2026-07-09.md'), 'utf8'),
    '# 2026-07-09\n'
  );
});

test('rejects missing folders through symlink escapes', async () => {
  const root = await tempRoot();
  const outside = await tempRoot();

  await fs.symlink(outside, path.join(root, 'escape'));

  const workspace = await createWorkspace(root);
  await assert.rejects(
    () => workspace.saveFile('/escape/note.md', 'nope'),
    /outside WORKSPACE_ROOT/
  );
});

test('returns git diff for a markdown file', async () => {
  const root = await tempRoot();
  const note = path.join(root, 'note.md');
  await fs.writeFile(note, 'old\n');
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['add', 'note.md'], { cwd: root });
  await fs.writeFile(note, 'new\n');

  const workspace = await createWorkspace(root);
  const result = await workspace.diffFile('/note.md');

  assert.equal(result.path, '/note.md');
  assert.match(result.diff, /^-old$/m);
  assert.match(result.diff, /^\+new$/m);
});
