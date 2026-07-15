import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ChangeSet, Text } from '@codemirror/state';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp, createWorkspaceRegistry } from '../server/app.js';

async function tempRoot() {
  return fs.mkdtemp(path.join(tmpdir(), 'webmd-'));
}

function updateFor(content, change) {
  return {
    changes: ChangeSet.of(change, Text.of(content.split('\n')).length).toJSON(),
    clientID: 'test'
  };
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
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

test('searches through the selected workspace root', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'Needle found\n');
  const workspaces = await createWorkspaceRegistry([root]);

  assert.equal((await workspaces.get().searchFiles('needle'))[0].path, '/note.md');
});

test('returns a workspace overview', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'older.md'), 'old\n');
  await fs.writeFile(path.join(root, 'recent.md'), 'new\n');
  await fs.writeFile(path.join(root, 'image.png'), 'png');
  await fs.utimes(path.join(root, 'older.md'), new Date(1), new Date(1));

  const { server, url } = await listen(await createApp({ workspaceRoots: [root] }));

  try {
    const response = await fetch(`${url}/api/workspace/overview`);
    assert.equal(response.status, 200);
    const overview = await response.json();
    assert.equal(overview.fileCount, 3);
    assert.equal(overview.markdownCount, 2);
    assert.equal(overview.recent[0].path, '/recent.md');
    assert.equal(overview.gitAvailable, false);
  } finally {
    server.close();
  }
});

test('accepts document updates and exposes them as SSE events', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'old');

  const { server, url } = await listen(await createApp({ workspaceRoots: [root] }));
  const abort = new AbortController();

  try {
    const updateResponse = await fetch(`${url}/api/workspace/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/note.md',
        version: 0,
        updates: [updateFor('old', { from: 0, to: 3, insert: 'new' })]
      })
    });

    assert.equal(updateResponse.status, 200);
    assert.equal((await updateResponse.json()).version, 1);
    assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'new');

    const eventsResponse = await fetch(
      `${url}/api/workspace/events?path=${encodeURIComponent('/note.md')}&since=0`,
      { signal: abort.signal }
    );
    assert.equal(eventsResponse.status, 200);
    assert.match(
      eventsResponse.headers.get('content-type') || '',
      /^text\/event-stream/
    );

    const { value } = await eventsResponse.body.getReader().read();
    assert.match(new TextDecoder().decode(value), /data: .*"version":1/);
  } finally {
    abort.abort();
    server.close();
  }
});

test('saves pasted images through the workspace API', async () => {
  const root = await tempRoot();
  const { server, url } = await listen(await createApp({ workspaceRoots: [root] }));

  try {
    const response = await fetch(`${url}/api/workspace/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: '/assets',
        notePath: '/2026-07-15.md',
        name: 'clip.png',
        mimeType: 'image/png',
        data: Buffer.from('png').toString('base64')
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: '/assets/2026-07-15-01.png' });
    assert.equal(
      await fs.readFile(path.join(root, 'assets', '2026-07-15-01.png'), 'utf8'),
      'png'
    );
  } finally {
    server.close();
  }
});

test('creates folders through the workspace API', async () => {
  const root = await tempRoot();
  const { server, url } = await listen(await createApp({ workspaceRoots: [root] }));

  try {
    const response = await fetch(`${url}/api/workspace/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/assets/screenshots' })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: '/assets/screenshots' });
    assert.equal(
      (await fs.stat(path.join(root, 'assets', 'screenshots'))).isDirectory(),
      true
    );
  } finally {
    server.close();
  }
});

test('streams AI chat through the selected workspace document', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), '# Note\nContext line\n');

  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
      aiFetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.match(body.messages[1].content, /Context line/);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"message":{"content":"Done"}}\n')
              );
              controller.close();
            }
          })
        );
      }
    })
  );

  try {
    const response = await fetch(`${url}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/note.md', prompt: 'Summarize' })
    });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /data: .*"text":"Done"/);
  } finally {
    server.close();
  }
});

test('returns AI edit replacement for the selected workspace text', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), '# Note\nrough text\n');

  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
      aiFetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.match(body.messages[1].content, /# Note/);
        assert.match(body.messages[1].content, /rough text/);
        assert.match(body.messages[1].content, /Make it concise/);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  '{"message":{"content":"concise text"}}\n'
                )
              );
              controller.close();
            }
          })
        );
      }
    })
  );

  try {
    const response = await fetch(`${url}/api/ai/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/note.md',
        selectedText: 'rough text',
        instruction: 'Make it concise'
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { replacement: 'concise text' });
  } finally {
    server.close();
  }
});
