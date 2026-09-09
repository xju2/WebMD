import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { ChangeSet, Text } from '@codemirror/state';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { changesBetween } from '../src/collab.js';
import { createWorkspace } from '../server/workspace.js';
import { parseBibtex } from '../src/citations.js';

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

  await assert.rejects(
    () => workspace.loadFile('/../outside.md'),
    /Path traversal/
  );
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
  await fs.writeFile(
    path.join(root, '.hidden', 'secret.md'),
    'Needle hidden\n'
  );

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

test('ranks markdown notes and recent edits above matching assets', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'assets', 'chart-01.png'), 'png');
  await fs.writeFile(path.join(root, 'chart-01-notes.md'), 'Fresh\n');
  await fs.writeFile(path.join(root, 'chart-01-archive.md'), 'Older\n');
  await fs.writeFile(
    path.join(root, 'owner.md'),
    'See ![[assets/chart-01.png]]\n'
  );
  const stale = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  await fs.utimes(path.join(root, 'chart-01-archive.md'), stale, stale);

  const workspace = await createWorkspace(root);

  assert.deepEqual(
    (await workspace.searchFiles('chart-01')).map((result) => result.path),
    [
      '/chart-01-notes.md',
      '/chart-01-archive.md',
      '/owner.md',
      '/assets/chart-01.png'
    ]
  );
});

test('queries OKF frontmatter fields', async () => {
  const root = await tempRoot();
  await fs.writeFile(
    path.join(root, 'incident.md'),
    `---
type: Playbook
title: Incident response
description: Steps for a freshness alert.
resource: https://example.com/runbook
tags:
  - oncall
  - data
timestamp: 2026-07-18T12:00:00Z
---
Act now.
`
  );
  await fs.writeFile(path.join(root, 'other.md'), 'type: Playbook\n');
  const workspace = await createWorkspace(root);

  assert.deepEqual(
    (await workspace.searchFiles('type:play')).map((result) => result.path),
    ['/incident.md']
  );
  for (const query of [
    'title:incident',
    'description:freshness',
    'resource:example.com',
    'tags:oncall',
    'timestamp:2026-07'
  ]) {
    assert.equal((await workspace.searchFiles(query))[0].path, '/incident.md');
  }
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
    unresolved: 1,
    broken: [{ path: '/a.md', name: 'a', target: 'missing', line: 0 }]
  });

  await workspace.saveFile('/a.md', '# No links\n');
  assert.equal((await workspace.graph()).edges.length, 1);
});

test('indexes BibTeX papers and note citations', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'See [@Ju:2026abc].\n');
  await fs.writeFile(
    path.join(root, 'references.bib'),
    '@article{Ju:2026abc, title={Graph Paper}, author={Ju, Xiangyang}, year={2026}, doi={10.1234/example}}\n'
  );
  const workspace = await createWorkspace(root);
  const graph = await workspace.graph();

  assert.deepEqual(graph.edges, [
    { source: '/note.md', target: '@Ju:2026abc' }
  ]);
  assert.deepEqual(graph.nodes[1], {
    path: '@Ju:2026abc',
    name: 'Graph Paper',
    group: 'citation',
    kind: 'citation',
    href: 'https://doi.org/10.1234/example',
    summary: 'Ju — Graph Paper — 2026'
  });
});

test('appends each BibTeX key once at the workspace root', async () => {
  const root = await tempRoot();
  const workspace = await createWorkspace(root);
  const bibtex = '@article{Ju:2026abc, title={Graph Paper}}';

  assert.equal((await workspace.addReference(bibtex)).added, true);
  assert.equal((await workspace.addReference(bibtex)).added, false);
  assert.equal(
    parseBibtex(await fs.readFile(path.join(root, 'references.bib'), 'utf8'))
      .length,
    1
  );
});

test('lists the dead links behind the unresolved count', async () => {
  const root = await tempRoot();
  await fs.writeFile(
    path.join(root, 'a.md'),
    '# A\n\nsee [[typo]]\n\n![[diagram.png]] and [[also-missing|Alias]]\n'
  );
  const workspace = await createWorkspace(root);
  const { unresolved, broken } = await workspace.graph();

  // The image is not a dead note link, so it is neither counted nor listed.
  assert.equal(unresolved, 2);
  assert.deepEqual(broken, [
    { path: '/a.md', name: 'a', target: 'typo', line: 2 },
    { path: '/a.md', name: 'a', target: 'also-missing', line: 4 }
  ]);
});

test('collects backlinks by resolving links, not by matching text', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'wiki'));
  await fs.writeFile(
    path.join(root, 'a.md'),
    'see [[wiki/b|B]]\n\nand again [[b#Setup]]\n'
  );
  await fs.writeFile(
    path.join(root, 'wiki', 'b.md'),
    '[[b]] links to itself\n'
  );
  await fs.writeFile(path.join(root, 'wiki', 'c.md'), 'no links here\n');
  const workspace = await createWorkspace(root);

  assert.deepEqual(await workspace.backlinks('/wiki/b.md'), {
    path: '/wiki/b.md',
    notes: [
      {
        path: '/a.md',
        name: 'a',
        mentions: [
          { line: 0, text: 'see [[wiki/b|B]]' },
          { line: 2, text: 'and again [[b#Setup]]' }
        ]
      }
    ],
    total: 2
  });

  await workspace.saveFile('/wiki/c.md', 'now it links to [[b]]\n');
  assert.equal((await workspace.backlinks('/wiki/b.md')).notes.length, 2);
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

test('saves uploaded media into the requested folder', async () => {
  const root = await tempRoot();
  const workspace = await createWorkspace(root);

  const first = await workspace.saveMediaFile({
    folder: 'assets',
    notePath: '/2026-07-15.md',
    name: 'My Plot.png',
    mimeType: 'image/png',
    data: Buffer.from('png').toString('base64')
  });
  const second = await workspace.saveMediaFile({
    folder: 'assets',
    notePath: '/2026-07-15.md',
    name: 'Report.pdf',
    mimeType: 'application/pdf',
    data: Buffer.from('pdf').toString('base64')
  });
  const third = await workspace.saveMediaFile({
    folder: 'assets',
    notePath: '/2026-07-15.md',
    name: 'clip',
    mimeType: 'image/heic',
    data: Buffer.from('heic').toString('base64')
  });

  assert.equal(first.path, '/assets/2026-07-15-01.png');
  assert.equal(second.path, '/assets/2026-07-15-01.pdf');
  assert.equal(third.path, '/assets/2026-07-15-01.heic');
  assert.equal(
    await fs.readFile(path.join(root, 'assets', '2026-07-15-01.png'), 'utf8'),
    'png'
  );
  assert.equal(
    await fs.readFile(path.join(root, 'assets', '2026-07-15-01.pdf'), 'utf8'),
    'pdf'
  );
  assert.equal(
    await fs.readFile(path.join(root, 'assets', '2026-07-15-01.heic'), 'utf8'),
    'heic'
  );
});

test('keeps the pasted image save alias working', async () => {
  const root = await tempRoot();
  const workspace = await createWorkspace(root);

  const result = await workspace.saveImageFile({
    folder: 'assets',
    name: 'plot.png',
    mimeType: 'image/png',
    data: Buffer.from('png').toString('base64')
  });

  assert.equal(result.path, '/assets/plot.png');
});

test('rejects symlink escapes', async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  const outsideFile = path.join(outside, 'secret.md');

  await fs.writeFile(outsideFile, 'nope');
  await fs.symlink(outsideFile, path.join(root, 'escape.md'));

  const workspace = await createWorkspace(root);
  await assert.rejects(
    () => workspace.loadFile('/escape.md'),
    /outside WORKSPACE_ROOT/
  );
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

test('deletes supported workspace files', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'old phrase\n');
  await fs.writeFile(path.join(root, 'image.png'), 'png');

  const workspace = await createWorkspace(root);
  assert.equal((await workspace.searchFiles('old'))[0].path, '/note.md');

  assert.deepEqual(await workspace.deleteFile('/note.md'), {
    success: true,
    path: '/note.md'
  });
  assert.deepEqual(await workspace.searchFiles('old'), []);
  await assert.rejects(
    () => fs.readFile(path.join(root, 'note.md'), 'utf8'),
    /ENOENT/
  );
  await workspace.deleteFile('/image.png');
  await assert.rejects(
    () => workspace.deleteFile('/'),
    /File path is required/
  );
});

test('does not recreate a loaded document after deleting it', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'old\n');

  const workspace = await createWorkspace(root);
  await workspace.loadFile('/note.md');
  await workspace.deleteFile('/note.md');

  await assert.rejects(
    () =>
      workspace.applyUpdates('/note.md', 0, [
        updateFor('old\n', { from: 0, to: 3, insert: 'new' })
      ]),
    (error) => error.status === 404
  );
  await assert.rejects(
    () => fs.readFile(path.join(root, 'note.md'), 'utf8'),
    /ENOENT/
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
  const loaded = await workspace.loadFile('/note.md');
  assert.deepEqual(
    { path: loaded.path, content: loaded.content, version: loaded.version },
    { path: '/note.md', content: 'old\n', version: 0 }
  );
  // The file's age, so a note without a `creation-date` can be dated honestly.
  assert.match(loaded.created, /^\d{4}-\d{2}-\d{2}T/);

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

test('renames a note and repoints the wiki links that named it', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'wiki'));
  await fs.writeFile(path.join(root, 'wiki', 'Untitled.md'), '# Draft\n');
  await fs.writeFile(
    path.join(root, 'index.md'),
    'See [[Untitled]], ![[Untitled]], [[Untitled#Notes|the draft]], [[Other]].\n'
  );

  const workspace = await createWorkspace(root);
  const result = await workspace.renameFile(
    '/wiki/Untitled.md',
    '/wiki/Field Notes.md'
  );

  assert.deepEqual(result, {
    success: true,
    path: '/wiki/Field Notes.md',
    updatedLinks: ['/index.md']
  });
  assert.equal(
    await fs.readFile(path.join(root, 'wiki', 'Field Notes.md'), 'utf8'),
    '# Draft\n'
  );
  assert.equal(
    await fs.readFile(path.join(root, 'index.md'), 'utf8'),
    'See [[Field Notes]], ![[Field Notes]], ' +
      '[[Field Notes#Notes|the draft]], [[Other]].\n'
  );
  await assert.rejects(
    () => workspace.loadFile('/wiki/Untitled.md'),
    (error) => error.status === 404
  );
});

test('links to a renamed note keep their folder when the name collides', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'wiki'));
  await fs.writeFile(path.join(root, 'wiki', 'Draft.md'), '# Draft\n');
  await fs.writeFile(path.join(root, 'Notes.md'), '# Notes\n');
  await fs.writeFile(path.join(root, 'index.md'), 'See [[Draft]].\n');

  const workspace = await createWorkspace(root);
  await workspace.renameFile('/wiki/Draft.md', '/wiki/Notes.md');

  assert.equal(
    await fs.readFile(path.join(root, 'index.md'), 'utf8'),
    'See [[wiki/Notes]].\n'
  );
});

test('refuses to rename a note over an existing one', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'one.md'), 'one\n');
  await fs.writeFile(path.join(root, 'two.md'), 'two\n');

  const workspace = await createWorkspace(root);
  await assert.rejects(
    () => workspace.renameFile('/one.md', '/two.md'),
    (error) => error.status === 409
  );
  assert.equal(await fs.readFile(path.join(root, 'two.md'), 'utf8'), 'two\n');
});

test('a renamed note keeps its collaborative document', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'old');

  const workspace = await createWorkspace(root);
  await workspace.applyUpdates('/note.md', 0, [
    updateFor('old', { from: 0, to: 3, insert: 'new' })
  ]);
  await workspace.renameFile('/note.md', '/renamed.md');

  const subscription = await workspace.subscribeEvents(
    '/renamed.md',
    0,
    () => {}
  );
  assert.equal(subscription.version, 1);
  subscription.unsubscribe();
  assert.equal((await workspace.loadFile('/renamed.md')).content, 'new');
});

test('picks up a note edited outside WebMD', async () => {
  const root = await tempRoot();
  const file = path.join(root, 'note.md');
  await fs.writeFile(file, 'old\n');

  const workspace = await createWorkspace(root);
  await workspace.applyUpdates('/note.md', 0, [
    updateFor('old\n', { from: 0, to: 3, insert: 'mine' })
  ]);

  const pushed = [];
  const live = await workspace.subscribeEvents('/note.md', 1, (event) =>
    pushed.push(event)
  );

  // Another app writes the file while WebMD holds it in memory.
  await fs.writeFile(file, 'theirs\n');

  const loaded = await workspace.loadFile('/note.md');
  assert.equal(loaded.content, 'theirs\n');
  assert.equal(loaded.version, 2);

  // Open editors are told, so their next keystroke rebases instead of
  // overwriting the outside edit.
  assert.deepEqual(
    pushed.map((event) => event.version),
    [2]
  );
  assert.equal(pushed[0].updates[0].clientID, 'disk');
  live.unsubscribe();

  // An unchanged file is not republished as a new version.
  assert.equal((await workspace.loadFile('/note.md')).version, 2);
  assert.equal(pushed.length, 1);
});

test('a restarted server takes the editor’s unsaved text after a resync', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'hello\n');

  // The session the browser tab was talking to, edited up to version 1.
  const before = await createWorkspace(root);
  await before.applyUpdates('/note.md', 0, [
    updateFor('hello\n', { from: 5, to: 5, insert: ' world' })
  ]);

  // The server restarts: a new instance holds no versions at all.
  const after = await createWorkspace(root);
  await assert.rejects(
    () =>
      after.applyUpdates('/note.md', 1, [
        updateFor('hello world\n', { from: 11, to: 11, insert: '!' })
      ]),
    /Document is at version 0\./
  );

  // What the client does next: reload, then send the one change carrying the
  // server's copy to the text still on screen.
  const file = await after.loadFile('/note.md');
  assert.equal(file.version, 0);
  const typed = 'hello world!\n';
  const result = await after.applyUpdates('/note.md', file.version, [
    { changes: changesBetween(file.content, typed).toJSON(), clientID: 'test' }
  ]);

  assert.equal(result.version, 1);
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), typed);
});
