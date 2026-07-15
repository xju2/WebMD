import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { ChangeSet, Text } from '@codemirror/state';
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

function updateFor(content, change) {
  return {
    changes: ChangeSet.of(change, Text.of(content.split('\n')).length).toJSON(),
    clientID: 'test'
  };
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

test('searches visible paths and markdown content from an index', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'raw', 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
  await fs.writeFile(path.join(root, 'note.md'), 'First\nNeedle found\n');
  await fs.writeFile(path.join(root, 'raw', 'assets', 'photo.png'), 'png');
  await fs.writeFile(path.join(root, '.hidden', 'secret.md'), 'Needle hidden\n');

  const workspace = await createWorkspace(root);

  assert.deepEqual(await workspace.searchFiles('needle'), [
    {
      name: 'note.md',
      type: 'file',
      path: '/note.md',
      fileKind: 'markdown',
      kind: 'content',
      from: 6,
      to: 12,
      lineNumber: 2,
      preview: 'Needle found'
    }
  ]);
  assert.deepEqual(await workspace.searchFiles('photo'), [
    {
      name: 'photo.png',
      type: 'file',
      path: '/raw/assets/photo.png',
      fileKind: 'image',
      kind: 'path'
    }
  ]);
});

test('indexes resolved wiki links and invalidates after saves', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'wiki'));
  await fs.writeFile(path.join(root, 'a.md'), '[[wiki/b|B]] [[missing]]\n');
  await fs.writeFile(path.join(root, 'wiki', 'b.md'), '[[a]]\n');
  const workspace = await createWorkspace(root);

  assert.deepEqual(await workspace.graph(), {
    nodes: [
      { path: '/a.md', name: 'a', group: 'root' },
      { path: '/wiki/b.md', name: 'b', group: 'wiki' }
    ],
    edges: [
      { source: '/a.md', target: '/wiki/b.md' },
      { source: '/wiki/b.md', target: '/a.md' }
    ],
    unresolved: 1
  });

  await workspace.saveFile('/a.md', '# No links\n');
  assert.equal((await workspace.graph()).edges.length, 1);
});

test('invalidates the search index after saving markdown', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'old phrase\n');

  const workspace = await createWorkspace(root);

  assert.equal((await workspace.searchFiles('old'))[0].path, '/note.md');
  await workspace.saveFile('/note.md', 'new phrase\n');

  assert.deepEqual(await workspace.searchFiles('old'), []);
  assert.equal((await workspace.searchFiles('new'))[0].path, '/note.md');
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

test('saves pasted images into the requested folder', async () => {
  const root = await tempRoot();
  const workspace = await createWorkspace(root);

  const first = await workspace.saveImageFile({
    folder: 'assets',
    notePath: '/2026-07-15.md',
    name: 'My Plot.png',
    mimeType: 'image/png',
    data: Buffer.from('png').toString('base64')
  });
  const second = await workspace.saveImageFile({
    folder: 'assets',
    notePath: '/2026-07-15.md',
    name: 'My Plot.png',
    mimeType: 'image/png',
    data: Buffer.from('next').toString('base64')
  });

  assert.equal(first.path, '/assets/2026-07-15-01.png');
  assert.equal(second.path, '/assets/2026-07-15-02.png');
  assert.equal(
    await fs.readFile(path.join(root, 'assets', '2026-07-15-01.png'), 'utf8'),
    'png'
  );
  assert.equal(
    await fs.readFile(path.join(root, 'assets', '2026-07-15-02.png'), 'utf8'),
    'next'
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

test('creates folders for asset dropdown options', async () => {
  const root = await tempRoot();
  const workspace = await createWorkspace(root);

  assert.deepEqual(await workspace.createFolder('assets/screenshots'), {
    path: '/assets/screenshots'
  });

  const tree = await workspace.readTree();
  assert.equal(tree[0].path, '/assets');
  assert.equal(tree[0].children[0].path, '/assets/screenshots');
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

test('returns unstaged, staged, and untracked git diffs', async () => {
  const root = await tempRoot();
  const note = path.join(root, 'note.md');
  const staged = path.join(root, 'staged.md');
  const untracked = path.join(root, 'untracked.md');
  await fs.writeFile(note, 'old\n');
  await fs.writeFile(staged, 'old staged\n');
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['add', 'note.md', 'staged.md'], { cwd: root });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'base'
    ],
    { cwd: root }
  );
  await fs.writeFile(note, 'new\n');
  await fs.writeFile(staged, 'new staged\n');
  await execFileAsync('git', ['add', 'staged.md'], { cwd: root });
  await fs.writeFile(untracked, 'new untracked\n');

  const workspace = await createWorkspace(root);
  const unstagedResult = await workspace.diffFile('/note.md');
  const stagedResult = await workspace.diffFile('/staged.md');
  const untrackedResult = await workspace.diffFile('/untracked.md');

  assert.match(unstagedResult.diff, /^-old$/m);
  assert.match(unstagedResult.diff, /^\+new$/m);
  assert.match(stagedResult.diff, /^-old staged$/m);
  assert.match(stagedResult.diff, /^\+new staged$/m);
  assert.match(untrackedResult.diff, /^\+new untracked$/m);
});

test('applies versioned document updates and writes a snapshot', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'old\n');

  const workspace = await createWorkspace(root);
  assert.deepEqual(await workspace.loadFile('/note.md'), {
    path: '/note.md',
    content: 'old\n',
    version: 0
  });

  const result = await workspace.applyUpdates('/note.md', 0, [
    updateFor('old\n', { from: 0, to: 3, insert: 'new' })
  ]);

  assert.equal(result.version, 1);
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'new\n');
  assert.equal((await workspace.loadFile('/note.md')).version, 1);
  await assert.rejects(
    () =>
      workspace.applyUpdates('/note.md', 0, [
        updateFor('new\n', { from: 0, to: 3, insert: 'bad' })
      ]),
    (error) => error.status === 409
  );
});

test('replays and pushes document update events', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'old');

  const workspace = await createWorkspace(root);
  const pushed = [];
  const live = await workspace.subscribeEvents('/note.md', 0, (event) =>
    pushed.push(event)
  );

  await workspace.applyUpdates('/note.md', 0, [
    updateFor('old', { from: 0, to: 3, insert: 'new' }),
    updateFor('new', { from: 3, to: 3, insert: '!' })
  ]);

  assert.deepEqual(
    pushed.map((event) => event.version),
    [1, 2]
  );
  live.unsubscribe();

  const replay = await workspace.subscribeEvents('/note.md', 1, () => {});
  assert.equal(replay.version, 2);
  assert.deepEqual(
    replay.backlog.map((event) => event.version),
    [2]
  );
  replay.unsubscribe();
});
