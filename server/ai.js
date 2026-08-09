import { WorkspaceError } from './workspace.js';

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6';
const DEFAULT_OLLAMA_MODEL = 'llama3.2';
const MAX_CONTEXT_CHARS = 12000;
const MAX_PROVIDER_ERROR_CHARS = 400;
const DEFAULT_EDIT_SYSTEM =
  'You are WebMD, an AI editor inside a remote Markdown workspace. Return only the replacement Markdown for the selected text. Do not include explanations, labels, quotes, or code fences.';

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

/**
 * Yields `{ text }` deltas as the provider streams, then a final
 * `{ done, replacement }` carrying the authoritative text. Fences can only be
 * stripped once the whole reply has arrived, so the last event — not the
 * concatenated deltas — is what callers should apply to the document.
 */
export async function* streamAiEdit({
  instruction,
  system = DEFAULT_EDIT_SYSTEM,
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
  const messages = editMessages({
    instruction,
    system,
    selectedText,
    path,
    documentText
  });

  let replacement = '';
  for await (const chunk of streamAiProvider(config, messages, fetchImpl)) {
    replacement += chunk;
    yield { text: chunk };
  }

  yield { done: true, replacement: stripSingleFencedBlock(replacement) };
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

function editMessages({ instruction, system, selectedText, path, documentText }) {
  const documentContext = documentText?.trim()
    ? `Current document ${path || ''}:\n${trimContext(documentText)}`
    : path
      ? `Active document: ${path}`
      : 'No active document.';

  return [
    {
      role: 'developer',
      content: system || DEFAULT_EDIT_SYSTEM
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
    throw new WorkspaceError(
      400,
      'OPENAI_API_KEY is required for AI_PROVIDER=openai. Set it in the environment or ~/.webmd.conf.'
    );
  }

  const response = await requestProvider(
    fetchImpl,
    `${config.openaiBaseUrl}/responses`,
    {
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
    },
    config
  );

  await assertProviderResponse(response, config);
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
  throw new WorkspaceError(
    400,
    `Unsupported AI_PROVIDER: "${config.provider}". Use "openai" or "ollama".`
  );
}

function stripSingleFencedBlock(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return match ? match[1] : text;
}

async function* streamOllama(config, messages, fetchImpl) {
  const response = await requestProvider(
    fetchImpl,
    `${config.ollamaBaseUrl}/api/chat`,
    {
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
    },
    config
  );

  await assertProviderResponse(response, config);
  for await (const event of parseJsonLines(response.body)) {
    const text = event.message?.content;
    if (text) yield text;
  }
}

/** Wraps transport failures, which arrive as bare "fetch failed" otherwise. */
async function requestProvider(fetchImpl, url, options, config) {
  try {
    return await fetchImpl(url, options);
  } catch (error) {
    throw new WorkspaceError(
      502,
      `Could not reach ${providerLabel(config)}: ${error.message}. ${
        config.provider === 'ollama'
          ? 'Is Ollama running?'
          : 'Check OPENAI_BASE_URL and that the host is reachable.'
      }`
    );
  }
}

async function assertProviderResponse(response, config) {
  if (!response) {
    throw new WorkspaceError(502, `No response from ${providerLabel(config)}.`);
  }
  if (!response.ok) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    const detail = await readProviderError(response);
    throw new WorkspaceError(
      502,
      [
        `${providerLabel(config)} failed with ${status}.`,
        providerHint(response.status, config),
        detail && `Provider said: ${detail}`
      ]
        .filter(Boolean)
        .join(' ')
    );
  }
  if (!response.body) {
    throw new WorkspaceError(
      502,
      `${providerLabel(config)} returned no response body to stream.`
    );
  }
}

function providerLabel(config) {
  const base =
    config.provider === 'openai' ? config.openaiBaseUrl : config.ollamaBaseUrl;
  return `AI provider ${safeUrl(base)} (model ${config.model})`;
}

/** Drops any user:password in the configured URL so it stays out of errors. */
function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

function providerHint(status, config) {
  const openai = config.provider === 'openai';

  if (status === 401 || status === 403) {
    return openai
      ? 'The API key was rejected. Check OPENAI_API_KEY in the environment or ~/.webmd.conf, and note that a duplicate entry there overrides the earlier one.'
      : 'The provider rejected the request.';
  }
  if (status === 404) {
    return openai
      ? `Check that AI_MODEL "${config.model}" exists on this provider and that OPENAI_BASE_URL points at the API root.`
      : `Check that AI_MODEL "${config.model}" is installed: ollama pull ${config.model}.`;
  }
  if (status === 429) {
    return 'Rate limit or quota exceeded. Retry in a moment.';
  }
  if (status >= 500) {
    return `The provider could not serve AI_MODEL "${config.model}". It may be unavailable, or not permitted for this account — try another model.`;
  }
  if (status >= 400) {
    return `The request was rejected. Check AI_MODEL "${config.model}".`;
  }
  return '';
}

async function readProviderError(response) {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    return text.length > MAX_PROVIDER_ERROR_CHARS
      ? `${text.slice(0, MAX_PROVIDER_ERROR_CHARS)}...`
      : text;
  } catch {
    return '';
  }
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
