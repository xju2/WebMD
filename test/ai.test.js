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
    assert.deepEqual(Object.keys(preset).sort(), ['group', 'id', 'label']);
  }
});
