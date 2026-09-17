import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ChangeSet, Text } from '@codemirror/state';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp, createWorkspaceRegistry } from '../server/app.js';
import { resetArxivCache } from '../server/arxiv.js';
import { resetIndicoCache } from '../server/indico.js';
import { resetXCache } from '../server/x.js';

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
  assert.equal(
    (await workspaces.get('1').loadFile('/second.md')).content,
    'second'
  );
  assert.throws(() => workspaces.get('9'), /Unknown workspace root/);
});

test('searches through the selected workspace root', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'Needle found\n');
  const workspaces = await createWorkspaceRegistry([root]);

  assert.equal(
    (await workspaces.get().searchFiles('needle'))[0].path,
    '/note.md'
  );
});

test('falls back to IMAGE_ASSET_FOLDER when the workspace sets no folder', async () => {
  const root = await tempRoot();

  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      env: { IMAGE_ASSET_FOLDER: 'files/img/' }
    })
  );

  try {
    const response = await fetch(`${url}/api/settings`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      imageAssetFolder: '/files/img',
      dailyNoteFolder: '/raw/dailynotes',
      dailyNoteFolderConfigured: false,
      dailyNoteTemplate: null,
      meetingTimeZone: 'America/Los_Angeles'
    });
  } finally {
    server.close();
  }
});

test('falls back to /assets when no image asset folder is configured', async () => {
  const root = await tempRoot();

  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root], env: {} })
  );

  try {
    const settings = await (await fetch(`${url}/api/settings`)).json();
    assert.equal(settings.imageAssetFolder, '/assets');
    await assert.rejects(fs.access(path.join(root, '.webmd')));
  } finally {
    server.close();
  }
});

test('reads settings from each workspace .webmd/settings.json', async () => {
  const first = await tempRoot();
  const second = await tempRoot();
  await fs.mkdir(path.join(first, '.webmd'));
  await fs.writeFile(
    path.join(first, '.webmd/settings.json'),
    JSON.stringify({
      imageAssetFolder: 'static/img/',
      dailyNoteFolder: '/journal',
      dailyNoteTemplate: 'journal/template.md',
      meetingTimeZone: 'Europe/Zurich'
    })
  );

  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [first, second],
      env: { IMAGE_ASSET_FOLDER: '/files/img' }
    })
  );

  try {
    assert.deepEqual(await (await fetch(`${url}/api/settings?root=0`)).json(), {
      imageAssetFolder: '/static/img',
      dailyNoteFolder: '/journal',
      dailyNoteFolderConfigured: true,
      dailyNoteTemplate: '/journal/template.md',
      meetingTimeZone: 'Europe/Zurich'
    });
    const other = await (await fetch(`${url}/api/settings?root=1`)).json();
    assert.equal(other.imageAssetFolder, '/files/img');
    assert.equal(other.dailyNoteFolderConfigured, false);
  } finally {
    server.close();
  }
});

test('keeps good settings and warns about bad ones', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, '.webmd'));
  await fs.writeFile(
    path.join(root, '.webmd/settings.json'),
    JSON.stringify({
      imageAssetFolder: '../outside',
      dailyNoteFolder: '/daily',
      dailyNoteTemplate: '',
      meetingTimeZone: 'Mars/Olympus'
    })
  );

  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root], env: {} })
  );

  try {
    const settings = await (await fetch(`${url}/api/settings`)).json();
    assert.equal(settings.imageAssetFolder, '/assets');
    assert.equal(settings.dailyNoteFolder, '/daily');
    assert.equal(settings.dailyNoteTemplate, '');
    assert.match(settings.warning, /imageAssetFolder/);
    assert.equal(settings.meetingTimeZone, 'America/Los_Angeles');
    assert.match(settings.warning, /meetingTimeZone/);

    await fs.writeFile(path.join(root, '.webmd/settings.json'), '{ nope');
    const broken = await (await fetch(`${url}/api/settings`)).json();
    assert.equal(broken.dailyNoteFolder, '/raw/dailynotes');
    assert.match(broken.warning, /not valid JSON/);
  } finally {
    server.close();
  }
});

test('returns a workspace overview', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'older.md'), 'old\n');
  await fs.writeFile(path.join(root, 'recent.md'), 'new\n');
  await fs.writeFile(path.join(root, 'image.png'), 'png');
  await fs.utimes(path.join(root, 'older.md'), new Date(1), new Date(1));

  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root] })
  );

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

  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root] })
  );
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
  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root] })
  );

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
    assert.deepEqual(await response.json(), {
      path: '/assets/2026-07-15-01.png',
      fileKind: 'image'
    });
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
  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root] })
  );

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

test('deletes files through the workspace API', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'delete me\n');
  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root] })
  );

  try {
    const response = await fetch(`${url}/api/workspace/files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/note.md' })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      path: '/note.md'
    });
    await assert.rejects(
      () => fs.readFile(path.join(root, 'note.md'), 'utf8'),
      /ENOENT/
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

test('suggests related notes as links that resolve back to real files', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'wiki'));
  await fs.writeFile(
    path.join(root, 'note.md'),
    '# Today\nTriton dropped ONNX inference requests on the GPU.\n'
  );
  await fs.writeFile(
    path.join(root, 'wiki', 'triton.md'),
    '# Triton\nTriton batches ONNX inference requests across GPU instances.\n'
  );
  await fs.writeFile(
    path.join(root, 'wiki', 'bread.md'),
    '# Bread\nProof the dough.\n'
  );

  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
      aiFetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.match(body.messages[1].content, /\/wiki\/triton\.md/);
        assert.doesNotMatch(body.messages[1].content, /\/wiki\/bread\.md/);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `{"message":{"content":"[{\\"path\\": \\"/wiki/triton.md\\", \\"reason\\": \\"same serving stack\\"}]"}}\n`
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
    const response = await fetch(`${url}/api/ai/related`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/note.md' })
    });

    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).suggestions, [
      {
        path: '/wiki/triton.md',
        title: 'Triton',
        reason: 'same serving stack',
        target: 'triton'
      }
    ]);
  } finally {
    server.close();
  }
});

test('skips the AI call when no note shares wording with the open one', async () => {
  const root = await tempRoot();
  await fs.writeFile(
    path.join(root, 'note.md'),
    '# Today\nTriton inference.\n'
  );
  await fs.writeFile(
    path.join(root, 'bread.md'),
    '# Bread\nProof the dough.\n'
  );

  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
      aiFetch: async () => assert.fail('should not call the AI provider')
    })
  );

  try {
    const response = await fetch(`${url}/api/ai/related`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/note.md' })
    });

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.suggestions, []);
    assert.equal(result.candidateCount, 0);
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
    const body = await response.text();
    assert.match(body, /data: .*"text":"concise text"/);
    assert.match(body, /data: .*"replacement":"concise text"/);
  } finally {
    server.close();
  }
});

test('lists prompt presets without their system prompts', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, '.webmd'));
  await fs.writeFile(
    path.join(root, '.webmd', 'prompts.json'),
    JSON.stringify({
      presets: [
        { id: 'grant-aims', label: 'Specific Aims voice', system: 'Secret.' }
      ]
    })
  );

  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root] })
  );

  try {
    const response = await fetch(`${url}/api/ai/presets`);
    assert.equal(response.status, 200);

    const body = await response.text();
    assert.match(body, /Specific Aims voice/);
    assert.doesNotMatch(body, /Secret\./);

    const { presets } = JSON.parse(body);
    const tighten = presets.find((preset) => preset.id === 'academic-tighten');
    assert.equal(tighten.kind, 'edit');
    assert.equal(
      presets.find((preset) => preset.id === 'ask-summarize').kind,
      'chat'
    );
    // Presets without an explicit kind stay selection rewrites.
    assert.equal(
      presets.find((preset) => preset.id === 'grant-aims').kind,
      'edit'
    );
    assert.ok(presets.every((preset) => !('system' in preset)));
  } finally {
    server.close();
  }
});

test('runs an AI chat turn from a chat preset', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, '.webmd'));
  await fs.writeFile(path.join(root, 'note.md'), '# Note\nrough text\n');
  await fs.writeFile(
    path.join(root, '.webmd', 'prompts.json'),
    JSON.stringify({
      presets: [
        {
          id: 'ask-risks',
          label: 'Risks',
          group: 'Ask',
          kind: 'chat',
          system: 'You list the risks in a note.'
        }
      ]
    })
  );

  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
      aiFetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.match(
          body.messages[0].content,
          /You list the risks in a note\./
        );
        // The preset asks the question; the typed text narrows it.
        assert.match(body.messages[1].content, /Risks, for the current note\./);
        assert.match(body.messages[1].content, /only the schedule/);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"message":{"content":"one risk"}}\n')
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
      body: JSON.stringify({
        path: '/note.md',
        presetId: 'ask-risks',
        prompt: 'only the schedule'
      })
    });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /"text":"one risk"/);
  } finally {
    server.close();
  }
});

test('rejects a prompt preset used for the wrong kind of request', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), '# Note\nrough text\n');
  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root] })
  );

  const post = (route, body) =>
    fetch(`${url}/api/ai/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/note.md', ...body })
    });

  try {
    const editAsChat = await post('chat', { presetId: 'academic-tighten' });
    assert.equal(editAsChat.status, 400);
    assert.match((await editAsChat.json()).error, /is a "edit" preset/);

    const chatAsEdit = await post('edit', {
      selectedText: 'rough text',
      presetId: 'ask-summarize'
    });
    assert.equal(chatAsEdit.status, 400);
    assert.match((await chatAsEdit.json()).error, /is a "chat" preset/);

    const empty = await post('chat', {});
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /preset or a question/);
  } finally {
    server.close();
  }
});

test('runs an AI edit from a prompt preset', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), '# Note\nrough text\n');

  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
      aiFetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        // The preset supplies the system prompt; the typed note refines it.
        assert.match(body.messages[0].content, /peer-reviewed paper/);
        assert.match(body.messages[1].content, /keep the third sentence/);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  '{"message":{"content":"tight text"}}\n'
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
        presetId: 'academic-tighten',
        instruction: 'keep the third sentence'
      })
    });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /"replacement":"tight text"/);
  } finally {
    server.close();
  }
});

test('rejects AI edits with a bad or missing prompt', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), '# Note\nrough text\n');
  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root] })
  );

  const post = (body) =>
    fetch(`${url}/api/ai/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/note.md', ...body })
    });

  try {
    // A bad request must surface as a status code, not an SSE error event.
    const unknown = await post({
      selectedText: 'rough text',
      presetId: 'nope'
    });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /Unknown prompt preset/);

    const empty = await post({ selectedText: 'rough text' });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /preset or an edit instruction/);

    const noSelection = await post({
      selectedText: '',
      presetId: 'note-bullets'
    });
    assert.equal(noSelection.status, 400);
    assert.match((await noSelection.json()).error, /Selected text is required/);
  } finally {
    server.close();
  }
});

test('serves arXiv metadata for an identifier', async () => {
  resetArxivCache();
  const root = await tempRoot();
  const requested = [];
  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      arxivFetch: async (target) => {
        requested.push(target);
        return new Response(
          '<feed><entry><title>A Tracking Pipeline</title>' +
            '<author><name>Xiangyang Ju</name></author></entry></feed>'
        );
      }
    })
  );

  try {
    const response = await fetch(`${url}/api/arxiv?id=2608.00146v2`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: '2608.00146v2',
      title: 'A Tracking Pipeline',
      authors: ['Xiangyang Ju']
    });
    assert.match(requested[0], /id_list=2608\.00146v2/);
  } finally {
    server.close();
  }
});

test('rejects an arXiv lookup without a valid identifier', async () => {
  resetArxivCache();
  const root = await tempRoot();
  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      arxivFetch: async () => {
        throw new Error('should not be called');
      }
    })
  );

  try {
    for (const query of ['', '?id=', '?id=https://arxiv.org/abs/2608.00146']) {
      const response = await fetch(`${url}/api/arxiv${query}`);
      assert.equal(response.status, 400, query);
      assert.match(
        (await response.json()).error,
        /arXiv identifier is required/
      );
    }
  } finally {
    server.close();
  }
});

test('imports a citation into the selected workspace bibliography', async () => {
  const root = await tempRoot();
  const requested = [];
  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      citationFetch: async (target) => {
        requested.push(target);
        return new Response(
          '@article{Ju:2026abc, title={Graph Paper}, author={Ju, Xiangyang}, year={2026}}'
        );
      }
    })
  );

  try {
    const response = await fetch(`${url}/api/workspace/citations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: '0',
        source: 'https://inspirehep.net/literature/12345'
      })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).entry.key, 'Ju:2026abc');
    assert.match(
      await fs.readFile(path.join(root, 'references.bib'), 'utf8'),
      /Ju:2026abc/
    );
    assert.match(requested[0], /api\/literature\/12345\?format=bibtex/);

    const references = await (
      await fetch(`${url}/api/workspace/references?root=0`)
    ).json();
    assert.equal(references.entries[0].title, 'Graph Paper');
  } finally {
    server.close();
  }
});

test('lists open tasks across the workspace', async () => {
  const root = await tempRoot();
  await fs.writeFile(
    path.join(root, 'plan.md'),
    [
      '# Plan',
      '- [ ] Submit the abstract 📅 2026-08-20 ⏫',
      '- [x] Draft outline ✅ 2026-08-14',
      '```markdown',
      '- [ ] Only an example',
      '```',
      ''
    ].join('\n')
  );
  await fs.writeFile(path.join(root, 'notes.md'), '- [ ] Email Sarah\n');

  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root] })
  );

  try {
    const response = await fetch(`${url}/api/workspace/tasks`);
    assert.equal(response.status, 200);
    const { tasks, total } = await response.json();

    assert.equal(total, 2);
    assert.deepEqual(
      tasks.map((task) => [
        task.path,
        task.line,
        task.text,
        task.due,
        task.priority
      ]),
      [
        ['/notes.md', 0, 'Email Sarah', '', ''],
        ['/plan.md', 1, 'Submit the abstract', '2026-08-20', 'high']
      ]
    );

    const all = await (
      await fetch(`${url}/api/workspace/tasks?include=all`)
    ).json();
    assert.deepEqual(
      all.tasks.map((task) => task.checked),
      [false, false, true]
    );
  } finally {
    server.close();
  }
});

test('renames a note through the workspace API', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'Untitled.md'), '# Field Notes\n');
  await fs.writeFile(path.join(root, 'index.md'), 'See [[Untitled]].\n');
  const { server, url } = await listen(
    await createApp({ workspaceRoots: [root] })
  );

  try {
    const response = await fetch(`${url}/api/workspace/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '/Untitled.md', to: '/Field Notes.md' })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      path: '/Field Notes.md',
      updatedLinks: ['/index.md']
    });
    assert.equal(
      await fs.readFile(path.join(root, 'Field Notes.md'), 'utf8'),
      '# Field Notes\n'
    );
    assert.equal(
      await fs.readFile(path.join(root, 'index.md'), 'utf8'),
      'See [[Field Notes]].\n'
    );
  } finally {
    server.close();
  }
});

test('writes a quote of the day once, then serves it from history', async () => {
  const root = await tempRoot();
  let calls = 0;

  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      aiEnv: {
        AI_PROVIDER: 'ollama',
        AI_MODEL: 'llama-test',
        QUOTE_THEMES: 'stoicism'
      },
      aiFetch: async (_url, options) => {
        calls += 1;
        const body = JSON.parse(options.body);
        assert.match(body.messages[1].content, /2026-08-18/);
        assert.match(body.messages[1].content, /quote about stoicism/);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({
                    message: {
                      content:
                        '{"quote": "Talk is cheap. Show me the code.", "author": "Linus Torvalds", "said": "2000"}'
                    }
                  })}\n`
                )
              );
              controller.close();
            }
          })
        );
      }
    })
  );

  const ask = () =>
    fetch(`${url}/api/ai/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-18' })
    }).then((response) => response.json());

  try {
    // Dated by when Torvalds said it, not by the day of the note.
    const expected =
      '"Talk is cheap. Show me the code." -- Linus Torvalds (2000)';
    assert.equal((await ask()).quote, expected);

    // The same day reuses the stored quote instead of paying for another call,
    // and the cached line is formatted exactly like the fresh one.
    const again = await ask();
    assert.equal(again.quote, expected);
    assert.equal(again.cached, true);
    assert.equal(calls, 1);

    const history = JSON.parse(
      await fs.readFile(path.join(root, '.webmd', 'quotes.json'), 'utf8')
    );
    assert.deepEqual(history.quotes, [
      {
        date: '2026-08-18',
        text: 'Talk is cheap. Show me the code.',
        author: 'Linus Torvalds',
        said: '2000'
      }
    ]);
  } finally {
    server.close();
  }
});

test('serves the title of an Indico page', async () => {
  resetIndicoCache();
  const root = await tempRoot();
  const requested = [];
  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      indicoFetch: async (target) => {
        requested.push(target);
        return new Response(
          '<html><head><title>CHEP 2024 (19 October 2024): Welcome · Indico' +
            '</title><meta property="og:title" content="CHEP 2024"></head></html>'
        );
      }
    })
  );

  try {
    const link = 'https://indico.cern.ch/event/1338689/contributions/6081535/';
    const response = await fetch(
      `${url}/api/indico?url=${encodeURIComponent(link)}`
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      url: link,
      title: 'Welcome',
      event: 'CHEP 2024'
    });
    assert.deepEqual(requested, [link]);
  } finally {
    server.close();
  }
});

test('serves the author and words of an X post', async () => {
  resetXCache();
  const root = await tempRoot();
  const requested = [];
  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      xFetch: async (target) => {
        requested.push(target);
        return new Response(
          JSON.stringify({
            text: 'Ship it',
            user: { name: 'eric provencher', screen_name: 'pvncher' }
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
    })
  );

  try {
    const link = 'https://x.com/pvncher/status/2095991462416490862';
    const response = await fetch(
      `${url}/api/x?url=${encodeURIComponent(link)}`
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      url: link,
      author: 'eric provencher',
      handle: 'pvncher',
      text: 'Ship it'
    });
    assert.equal(requested.length, 1);
    assert.ok(
      requested[0].startsWith('https://cdn.syndication.twimg.com/tweet-result?')
    );

    const profile = await fetch(`${url}/api/x?url=https://x.com/pvncher`);
    assert.equal(profile.status, 400);
    assert.match((await profile.json()).error, /X post link is required/);
  } finally {
    server.close();
  }
});

test('refuses to fetch a link that is not an Indico page', async () => {
  resetIndicoCache();
  const root = await tempRoot();
  const { server, url } = await listen(
    await createApp({
      workspaceRoots: [root],
      indicoFetch: async () => {
        throw new Error('should not be called');
      }
    })
  );

  try {
    for (const query of ['', '?url=', '?url=https://example.com/event/1/']) {
      const response = await fetch(`${url}/api/indico${query}`);
      assert.equal(response.status, 400, query);
      assert.match(
        (await response.json()).error,
        /Indico event link is required/
      );
    }
  } finally {
    server.close();
  }
});
