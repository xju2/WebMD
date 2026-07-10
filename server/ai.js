import { WorkspaceError } from './workspace.js';

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6';
const DEFAULT_OLLAMA_MODEL = 'llama3.2';
const MAX_CONTEXT_CHARS = 12000;

export async function* streamAiChat({
  prompt,
  selectedText = '',
  path = '',
  documentText = '',
  env = process.env,
  fetchImpl = fetch
}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new WorkspaceError(400, 'Prompt is required.');
  }

  const config = aiConfig(env);
  const messages = chatMessages({ prompt, selectedText, path, documentText });
  yield* streamAiProvider(config, messages, fetchImpl);
}

export async function createAiEdit({
  instruction,
  selectedText = '',
  path = '',
  documentText = '',
  env = process.env,
  fetchImpl = fetch
}) {
  if (typeof instruction !== 'string' || !instruction.trim()) {
    throw new WorkspaceError(400, 'Edit instruction is required.');
  }
  if (typeof selectedText !== 'string' || !selectedText.length) {
    throw new WorkspaceError(400, 'Selected text is required for AI edits.');
  }

  const config = aiConfig(env);
  const messages = editMessages({ instruction, selectedText, path, documentText });
  let replacement = '';
  for await (const chunk of streamAiProvider(config, messages, fetchImpl)) {
    replacement += chunk;
  }

  return { replacement: stripSingleFencedBlock(replacement) };
}

function aiConfig(env) {
  const provider = (
    env.AI_PROVIDER ||
    (env.OPENAI_API_KEY ? 'openai' : 'ollama')
  ).toLowerCase();

  return {
    provider,
    model:
      env.AI_MODEL ||
      (provider === 'openai'
        ? env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
        : env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL),
    openaiApiKey: env.OPENAI_API_KEY,
    openaiBaseUrl: env.OPENAI_BASE_URL || DEFAULT_OPENAI_URL,
    ollamaBaseUrl: env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL
  };
}

function chatMessages({ prompt, selectedText, path, documentText }) {
  const context = selectedText?.trim()
    ? `Selected text from ${path || 'the current document'}:\n${selectedText.trim()}`
    : documentText?.trim()
      ? `Current document ${path || ''}:\n${trimContext(documentText)}`
      : path
        ? `Active document: ${path}`
        : 'No active document.';

  return [
    {
      role: 'developer',
      content:
        'You are WebMD, an AI assistant inside a remote Markdown workspace. Answer with concise, useful Markdown. Do not claim to edit files unless the user asks for an explicit edit flow.'
    },
    {
      role: 'user',
      content: `${context}\n\nUser request:\n${prompt.trim()}`
    }
  ];
}

function editMessages({ instruction, selectedText, path, documentText }) {
  const documentContext = documentText?.trim()
    ? `Current document ${path || ''}:\n${trimContext(documentText)}`
    : path
      ? `Active document: ${path}`
      : 'No active document.';

  return [
    {
      role: 'developer',
      content:
        'You are WebMD, an AI editor inside a remote Markdown workspace. Return only the replacement Markdown for the selected text. Do not include explanations, labels, quotes, or code fences.'
    },
    {
      role: 'user',
      content: `${documentContext}\n\nSelected text to replace:\n${selectedText}\n\nEdit instruction:\n${instruction.trim()}`
    }
  ];
}

function trimContext(text) {
  return text.length > MAX_CONTEXT_CHARS
    ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[Context truncated]`
    : text;
}

async function* streamOpenAI(config, messages, fetchImpl) {
  if (!config.openaiApiKey) {
    throw new WorkspaceError(400, 'OPENAI_API_KEY is required for AI_PROVIDER=openai.');
  }

  const response = await fetchImpl(`${config.openaiBaseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      input: messages,
      stream: true
    })
  });

  assertProviderResponse(response);
  for await (const event of parseSse(response.body)) {
    if (event.type === 'response.output_text.delta' && event.delta) {
      yield event.delta;
    }
  }
}

function streamAiProvider(config, messages, fetchImpl) {
  if (config.provider === 'openai') {
    return streamOpenAI(config, messages, fetchImpl);
  }
  if (config.provider === 'ollama') {
    return streamOllama(config, messages, fetchImpl);
  }
  throw new WorkspaceError(400, `Unsupported AI_PROVIDER: ${config.provider}.`);
}

function stripSingleFencedBlock(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return match ? match[1] : text;
}

async function* streamOllama(config, messages, fetchImpl) {
  const response = await fetchImpl(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map((message) => ({
        role: message.role === 'developer' ? 'system' : message.role,
        content: message.content
      })),
      stream: true
    })
  });

  assertProviderResponse(response);
  for await (const event of parseJsonLines(response.body)) {
    const text = event.message?.content;
    if (text) yield text;
  }
}

function assertProviderResponse(response) {
  if (!response?.ok) {
    throw new WorkspaceError(
      502,
      `AI provider failed: ${response?.status || 'no response'} ${response?.statusText || ''}`.trim()
    );
  }
  if (!response.body) throw new WorkspaceError(502, 'AI provider did not stream.');
}

async function* parseSse(body) {
  let buffer = '';
  for await (const chunk of decodeText(body)) {
    buffer += chunk;
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';

    for (const block of blocks) {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      yield JSON.parse(data);
    }
  }
  if (buffer.trim()) {
    const data = buffer
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (data && data !== '[DONE]') yield JSON.parse(data);
  }
}

async function* parseJsonLines(body) {
  let buffer = '';
  for await (const chunk of decodeText(body)) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

async function* decodeText(body) {
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    yield decoder.decode(chunk, { stream: true });
  }
  yield decoder.decode();
}
