import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { streamAiChat, streamAiEdit } from '../server/ai.js';
import {
  BUILT_IN_PRESETS,
  listPresets,
  publicPresets,
  resolvePreset
} from '../server/prompts.js';
import { createWorkspace } from '../server/workspace.js';

async function workspaceWithPresets(contents) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'webmd-prompts-'));
  if (contents !== undefined) {
    await fs.mkdir(path.join(root, '.webmd'));
    await fs.writeFile(path.join(root, '.webmd', 'prompts.json'), contents);
  }
  return createWorkspace(root);
}

function streamResponse(text) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      }
    })
  );
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks.join('');
}

test('streams OpenAI Responses text deltas', async () => {
  const fetches = [];
  const text = await collect(
    streamAiChat({
      prompt: 'Summarize',
      env: {
        AI_PROVIDER: 'openai',
        AI_MODEL: 'gpt-test',
        OPENAI_API_KEY: 'secret'
      },
      fetchImpl: async (url, options) => {
        fetches.push({ url, body: JSON.parse(options.body) });
        return streamResponse(
          'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n' +
            'data: {"type":"response.completed"}\n\n'
        );
      }
    })
  );

  assert.equal(text, 'Hi');
  assert.equal(fetches[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(fetches[0].body.stream, true);
  assert.equal(fetches[0].body.input[1].role, 'user');
});

test('streams Ollama chat chunks', async () => {
  const text = await collect(
    streamAiChat({
      prompt: 'Summarize',
      selectedText: 'Important note',
      env: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.messages[0].role, 'system');
        assert.match(body.messages[1].content, /Important note/);
        return streamResponse(
          '{"message":{"content":"Hi"}}\n{"message":{"content":" there"}}\n'
        );
      }
    })
  );

  assert.equal(text, 'Hi there');
});

test('attributes a selection to its note only when there is one', async () => {
  const sent = [];
  const fetchImpl = async (_url, options) => {
    sent.push(JSON.parse(options.body).messages[1].content);
    return streamResponse('{"message":{"content":"ok"}}\n');
  };
  const env = { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' };
  await collect(
    streamAiChat({ prompt: 'Why?', selectedText: 'abstract', env, fetchImpl })
  );
  await collect(
    streamAiChat({
      prompt: 'Why?',
      selectedText: 'line',
      path: '/note.md',
      documentText: 'whole note',
      env,
      fetchImpl
    })
  );
  assert.match(sent[0], /^Selected text:\nabstract/);
  assert.match(sent[1], /^Selected text from \/note\.md:\nline/);
  // The selection stands in for the note; the rest of it is not sent.
  assert.doesNotMatch(sent[1], /whole note/);
});

test('streams AI edit deltas then a final replacement', async () => {
  const events = [];
  const stream = streamAiEdit({
    instruction: 'Make it clearer',
    selectedText: 'rough text',
    path: '/note.md',
    documentText: '# Note\nrough text\n',
    env: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.messages[0].role, 'system');
      assert.match(body.messages[0].content, /Return only the replacement/);
      assert.match(body.messages[1].content, /rough text/);
      assert.match(body.messages[1].content, /Make it clearer/);
      return streamResponse(
        '{"message":{"content":"clear"}}\n{"message":{"content":" text"}}\n'
      );
    }
  });
  for await (const event of stream) events.push(event);

  assert.deepEqual(events, [
    { text: 'clear' },
    { text: ' text' },
    { done: true, replacement: 'clear text' }
  ]);
});

test('strips a code fence only from the final AI edit event', async () => {
  const events = [];
  const stream = streamAiEdit({
    instruction: 'Rewrite',
    selectedText: 'rough text',
    env: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
    // Split mid-fence: the deltas alone can never be stripped correctly.
    fetchImpl: async () =>
      streamResponse(
        '{"message":{"content":"```markdown\\nclear"}}\n' +
          '{"message":{"content":" text\\n```"}}\n'
      )
  });
  for await (const event of stream) events.push(event);

  assert.equal(events.at(-1).replacement, 'clear text');
});

test('uses the preset system prompt for AI edits', async () => {
  const stream = streamAiEdit({
    instruction: 'Tighten this',
    system: 'You rewrite text for an NIH Specific Aims page.',
    selectedText: 'rough text',
    env: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.messages[0].content, /Specific Aims/);
      return streamResponse('{"message":{"content":"tight"}}\n');
    }
  });
  // eslint-disable-next-line no-empty
  for await (const _event of stream) {
  }
});

test('rejects AI edits without selected text', async () => {
  await assert.rejects(async () => {
    const stream = streamAiEdit({
      instruction: 'Improve',
      selectedText: '',
      env: { AI_PROVIDER: 'ollama' },
      fetchImpl: async () => streamResponse('')
    });
    for await (const _event of stream) {
      // The generator throws on the first pull, before any event arrives.
    }
  }, /Selected text is required/);
});

test('explains a rejected API key and quotes the provider', async () => {
  await assert.rejects(
    () =>
      collect(
        streamAiChat({
          prompt: 'Summarize',
          env: {
            AI_PROVIDER: 'openai',
            AI_MODEL: 'gpt-test',
            OPENAI_API_KEY: 'stale'
          },
          fetchImpl: async () =>
            new Response('{"error":"invalid api key"}', {
              status: 401,
              statusText: 'Unauthorized'
            })
        })
      ),
    (error) => {
      assert.match(error.message, /401 Unauthorized/);
      assert.match(error.message, /OPENAI_API_KEY/);
      assert.match(error.message, /duplicate entry/);
      assert.match(error.message, /invalid api key/);
      // The key itself must never travel back to the browser.
      assert.doesNotMatch(error.message, /stale/);
      return true;
    }
  );
});

test('names the model when the provider fails to serve it', async () => {
  await assert.rejects(
    () =>
      collect(
        streamAiChat({
          prompt: 'Summarize',
          env: {
            AI_PROVIDER: 'openai',
            AI_MODEL: 'blocked-model',
            OPENAI_API_KEY: 'secret'
          },
          fetchImpl: async () =>
            new Response('{"error":"explicit deny in a service control policy"}', {
              status: 500
            })
        })
      ),
    (error) => {
      assert.match(error.message, /blocked-model/);
      assert.match(error.message, /not permitted for this account/);
      assert.match(error.message, /service control policy/);
      return true;
    }
  );
});

test('suggests pulling a missing Ollama model', async () => {
  await assert.rejects(
    () =>
      collect(
        streamAiChat({
          prompt: 'Summarize',
          env: { AI_PROVIDER: 'ollama', AI_MODEL: 'absent-model' },
          fetchImpl: async () => new Response('model not found', { status: 404 })
        })
      ),
    /ollama pull absent-model/
  );
});

test('reports an unreachable provider instead of a bare fetch failure', async () => {
  await assert.rejects(
    () =>
      collect(
        streamAiChat({
          prompt: 'Summarize',
          env: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
          fetchImpl: async () => {
            throw new TypeError('fetch failed');
          }
        })
      ),
    (error) => {
      assert.match(error.message, /Could not reach/);
      assert.match(error.message, /Is Ollama running\?/);
      return true;
    }
  );
});

test('keeps credentials in the base URL out of error messages', async () => {
  await assert.rejects(
    () =>
      collect(
        streamAiChat({
          prompt: 'Summarize',
          env: {
            AI_PROVIDER: 'openai',
            AI_MODEL: 'gpt-test',
            OPENAI_API_KEY: 'secret',
            OPENAI_BASE_URL: 'https://user:hunter2@example.test/v1'
          },
          fetchImpl: async () => new Response('nope', { status: 429 })
        })
      ),
    (error) => {
      assert.doesNotMatch(error.message, /hunter2/);
      assert.match(error.message, /example\.test/);
      assert.match(error.message, /Rate limit or quota/);
      return true;
    }
  );
});

test('lists built-in presets when the workspace has no prompts file', async () => {
  const workspace = await workspaceWithPresets();
  const { presets, warning } = await listPresets(workspace);

  assert.equal(warning, undefined);
  assert.equal(presets.length, BUILT_IN_PRESETS.length);
  assert.ok(presets.some((preset) => preset.id === 'academic-tighten'));
});

test('workspace presets override built-ins by id and add new ones', async () => {
  const workspace = await workspaceWithPresets(
    JSON.stringify({
      presets: [
        {
          id: 'academic-tighten',
          label: 'My tighten',
          group: 'Paper',
          system: 'Custom system prompt.'
        },
        {
          id: 'grant-aims',
          label: 'Specific Aims voice',
          system: 'Aims system prompt.'
        }
      ]
    })
  );

  const { presets, warning } = await listPresets(workspace);
  assert.equal(warning, undefined);
  assert.equal(presets.length, BUILT_IN_PRESETS.length + 1);

  const overridden = await resolvePreset(workspace, 'academic-tighten');
  assert.equal(overridden.label, 'My tighten');
  assert.equal(overridden.system, 'Custom system prompt.');

  const added = await resolvePreset(workspace, 'grant-aims');
  assert.equal(added.group, 'Custom');
  assert.match(added.instruction, /Specific Aims voice/);
});

test('keeps built-in presets when the workspace prompts file is malformed', async () => {
  const workspace = await workspaceWithPresets('{"presets": [');
  const { presets, warning } = await listPresets(workspace);

  assert.equal(presets.length, BUILT_IN_PRESETS.length);
  assert.match(warning, /not valid JSON/);
});

test('reports presets that are missing required fields', async () => {
  const workspace = await workspaceWithPresets(
    JSON.stringify({
      presets: [
        { id: 'good', label: 'Good', system: 'System.' },
        { id: 'no-system', label: 'Broken' }
      ]
    })
  );

  const { presets, warning } = await listPresets(workspace);
  assert.ok(presets.some((preset) => preset.id === 'good'));
  assert.ok(!presets.some((preset) => preset.id === 'no-system'));
  assert.match(warning, /no-system/);
});

test('rejects an unknown preset id', async () => {
  const workspace = await workspaceWithPresets();
  await assert.rejects(
    () => resolvePreset(workspace, 'nope'),
    /Unknown prompt preset/
  );
});

test('never exposes preset system prompts to the browser', async () => {
  const workspace = await workspaceWithPresets();
  const { presets } = await listPresets(workspace);

  for (const preset of publicPresets(presets)) {
    assert.deepEqual(Object.keys(preset).sort(), [
      'group',
      'id',
      'instruction',
      'kind',
      'label'
    ]);
  }
});

test('normalizes preset kind, defaulting to a selection rewrite', async () => {
  const workspace = await workspaceWithPresets(
    JSON.stringify({
      presets: [
        { id: 'ask-risks', label: 'Risks', kind: 'CHAT', system: 'System.' },
        { id: 'shout', label: 'Shout', system: 'System.' },
        { id: 'odd', label: 'Odd', kind: 'sideways', system: 'System.' }
      ]
    })
  );

  const { presets } = await listPresets(workspace);
  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  assert.equal(byId.get('ask-risks').kind, 'chat');
  assert.equal(byId.get('ask-risks').instruction, 'Risks, for the current note.');
  assert.equal(byId.get('shout').kind, 'edit');
  assert.equal(byId.get('odd').kind, 'edit');
});

test('rejects a preset resolved for the wrong kind', async () => {
  const workspace = await workspaceWithPresets();
  await assert.rejects(
    () => resolvePreset(workspace, 'ask-summarize', 'edit'),
    /is a "chat" preset/
  );
  assert.equal(
    (await resolvePreset(workspace, 'ask-summarize', 'chat')).kind,
    'chat'
  );
});

test('uses a custom chat system prompt when one is given', async () => {
  const systems = [];
  const capture = async (_url, options) => {
    systems.push(JSON.parse(options.body).messages[0].content);
    return streamResponse('{"message":{"content":"Hi"}}\n');
  };
  const env = { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' };

  await collect(
    streamAiChat({ prompt: 'Ask', system: 'You list risks.', env, fetchImpl: capture })
  );
  await collect(streamAiChat({ prompt: 'Ask', env, fetchImpl: capture }));

  assert.equal(systems[0], 'You list risks.');
  assert.match(systems[1], /You are WebMD, an AI assistant/);
});
