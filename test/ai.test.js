import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiEdit, streamAiChat } from '../server/ai.js';

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

test('creates AI edit replacement text from the selected Markdown', async () => {
  const result = await createAiEdit({
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
      return streamResponse('{"message":{"content":"clear text"}}\n');
    }
  });

  assert.deepEqual(result, { replacement: 'clear text' });
});

test('rejects AI edits without selected text', async () => {
  await assert.rejects(
    () =>
      createAiEdit({
        instruction: 'Improve',
        selectedText: '',
        env: { AI_PROVIDER: 'ollama' },
        fetchImpl: async () => streamResponse('')
      }),
    /Selected text is required/
  );
});
