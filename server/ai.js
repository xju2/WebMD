import { WorkspaceError } from './workspace.js';

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6';
const DEFAULT_OLLAMA_MODEL = 'llama3.2';
const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com/v1';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';
// Claude requires a cap on the reply; this is well above any note edit or chat answer.
const ANTHROPIC_MAX_TOKENS = 8192;
const MAX_CONTEXT_CHARS = 12000;
const MAX_PROVIDER_ERROR_CHARS = 400;
const DEFAULT_EDIT_SYSTEM =
  'You are WebMD, an AI editor inside a remote Markdown workspace. Return only the replacement Markdown for the selected text. Do not include explanations, labels, quotes, or code fences.';
const DEFAULT_CHAT_SYSTEM =
  'You are WebMD, an AI assistant inside a remote Markdown workspace. Answer with concise, useful Markdown. You cannot edit files yourself: when asked to rewrite or reformat the selection, reply with only the replacement Markdown, which the user can apply with Replace selection.';
// Earlier turns sent back with each question, so a follow-up like "yes,
// please" still knows what it answers.
const MAX_HISTORY_MESSAGES = 10;

// Models offered per provider, first is the default. The model in use is
// always added, so an AI_MODEL set in the conf file stays selectable.
const MODEL_CHOICES = {
  anthropic: [
    ['claude-haiku-5-5', 'Claude Haiku 5.5'],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-fable-5-1', 'Claude Fable 5.1']
  ],
  openai: [[DEFAULT_OPENAI_MODEL, DEFAULT_OPENAI_MODEL]],
  ollama: [[DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_MODEL]]
};

/** The providers and models the Workspace Home switch offers, and the ones in use. */
export function aiProviderChoices(env) {
  const { provider, model } = aiConfig(env);
  const models = Object.fromEntries(
    Object.entries(MODEL_CHOICES).map(([id, list]) => [
      id,
      id === provider && !list.some(([value]) => value === model)
        ? [...list, [model, model]]
        : list
    ])
  );
  return {
    provider,
    model,
    models: Object.fromEntries(
      Object.entries(models).map(([id, list]) => [
        id,
        list.map(([value, label]) => ({ value, label }))
      ])
    ),
    providers: [
      { id: 'openai', label: 'OpenAI', configured: Boolean(env.OPENAI_API_KEY) },
      {
        id: 'anthropic',
        label: 'Claude',
        configured: Boolean(env.ANTHROPIC_API_KEY)
      },
      { id: 'ollama', label: 'Ollama', configured: true }
    ]
  };
}

export async function* streamAiChat({
  prompt,
  system = DEFAULT_CHAT_SYSTEM,
  selectedText = '',
  path = '',
  documentText = '',
  history = [],
  ticketText = '',
  env = process.env,
  fetchImpl = fetch
}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new WorkspaceError(400, 'Prompt is required.');
  }

  const config = aiConfig(env);
  const messages = chatMessages({
    prompt,
    system,
    selectedText,
    path,
    documentText,
    history,
    ticketText
  });
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

/**
 * Runs a prompt to completion and returns the whole reply.
 *
 * For short structured answers there is nothing to show token by token, and a
 * plain call can fail with a real HTTP status instead of an SSE `error` event
 * the client has to unpack.
 */
export async function runAiCompletion({
  messages,
  env = process.env,
  fetchImpl = fetch,
  onUsage
}) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new WorkspaceError(400, 'Messages are required.');
  }

  const config = aiConfig(env);
  const usage = { model: config.model };
  let reply = '';
  for await (const chunk of streamAiProvider(
    config,
    messages,
    fetchImpl,
    (tokens) => Object.assign(usage, tokens)
  )) {
    reply += chunk;
  }
  usage.cost = aiCost(config.model, usage, env);
  onUsage?.(usage);
  return stripSingleFencedBlock(reply);
}

// Anthropic list prices, dollars per million input and output tokens. A
// gateway may bill differently: AI_PRICE_PER_MTOK="3,15" sets your own.
const PRICES_PER_MTOK = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5]
};

/** The call's cost in dollars, or null when the price or the counts are unknown. */
export function aiCost(model, { inputTokens, outputTokens } = {}, env = {}) {
  const configured = String(env.AI_PRICE_PER_MTOK ?? '')
    .split(',')
    .map(Number);
  const price =
    configured.length === 2 && configured.every(Number.isFinite)
      ? configured
      : PRICES_PER_MTOK[String(model).replace(/^.*anthropic\./, '')];
  if (!price || !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens))
    return null;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1e6;
}

function aiConfig(env) {
  const provider = (
    env.AI_PROVIDER ||
    (env.OPENAI_API_KEY
      ? 'openai'
      : env.ANTHROPIC_API_KEY
        ? 'anthropic'
        : 'ollama')
  ).toLowerCase();

  return {
    provider,
    model:
      env.AI_MODEL ||
      (provider === 'openai'
        ? env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
        : provider === 'anthropic'
          ? env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL
          : env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL),
    openaiApiKey: env.OPENAI_API_KEY,
    openaiBaseUrl: env.OPENAI_BASE_URL || DEFAULT_OPENAI_URL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_URL,
    ollamaBaseUrl: env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL
  };
}

function chatMessages({
  prompt,
  system,
  selectedText,
  path,
  documentText,
  history,
  ticketText = ''
}) {
  const context = selectedText?.trim()
    ? // Text selected outside a note (an arXiv abstract, an earlier reply)
      // has no document to name, so it is not attributed to one.
      `${path ? `Selected text from ${path}` : 'Selected text'}:\n${selectedText.trim()}`
    : documentText?.trim()
      ? `Current document ${path || ''}:\n${trimContext(documentText)}`
      : path
        ? `Active document: ${path}`
        : 'No active document.';

  return [
    {
      role: 'developer',
      content: system || DEFAULT_CHAT_SYSTEM
    },
    ...chatHistory(history),
    {
      role: 'user',
      content: `${context}${ticketText ? `\n\nJira tickets linked above:\n${ticketText}` : ''}\n\nUser request:\n${prompt.trim()}`
    }
  ];
}

// The client sends this, so only plain user and assistant turns get through.
function chatHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (message) =>
        ['user', 'assistant'].includes(message?.role) &&
        typeof message.text === 'string' &&
        message.text.trim()
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: trimContext(message.text)
    }));
}

function editMessages({
  instruction,
  system,
  selectedText,
  path,
  documentText
}) {
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

async function* streamOpenAI(config, messages, fetchImpl, onTokens) {
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
    const usage = event.type === 'response.completed' && event.response?.usage;
    if (usage)
      onTokens?.({
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens
      });
  }
}

async function* streamAnthropic(config, messages, fetchImpl, onTokens) {
  if (!config.anthropicApiKey) {
    throw new WorkspaceError(
      400,
      'ANTHROPIC_API_KEY is required for AI_PROVIDER=anthropic. Set it in the environment or ~/.webmd.conf.'
    );
  }

  // Claude takes the system prompt apart from the turns.
  const system = messages
    .filter((message) => message.role === 'developer')
    .map((message) => message.content)
    .join('\n\n');
  const response = await requestProvider(
    fetchImpl,
    `${config.anthropicBaseUrl}/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system,
        messages: messages.filter((message) => message.role !== 'developer'),
        stream: true
      })
    },
    config
  );

  await assertProviderResponse(response, config);
  let inputTokens;
  for await (const event of parseSse(response.body)) {
    if (event.type === 'error') {
      throw new WorkspaceError(
        502,
        `${providerLabel(config)} failed: ${event.error?.message || 'stream error'}`
      );
    }
    if (event.type === 'message_start')
      inputTokens = event.message?.usage?.input_tokens;
    if (event.type === 'content_block_delta' && event.delta?.text) {
      yield event.delta.text;
    }
    if (event.type === 'message_delta' && event.usage)
      onTokens?.({ inputTokens, outputTokens: event.usage.output_tokens });
  }
}

function streamAiProvider(config, messages, fetchImpl, onTokens) {
  if (config.provider === 'openai') {
    return streamOpenAI(config, messages, fetchImpl, onTokens);
  }
  if (config.provider === 'anthropic') {
    return streamAnthropic(config, messages, fetchImpl, onTokens);
  }
  if (config.provider === 'ollama') {
    return streamOllama(config, messages, fetchImpl, onTokens);
  }
  throw new WorkspaceError(
    400,
    `Unsupported AI_PROVIDER: "${config.provider}". Use "openai", "anthropic" or "ollama".`
  );
}

function stripSingleFencedBlock(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return match ? match[1] : text;
}

async function* streamOllama(config, messages, fetchImpl, onTokens) {
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
    if (event.done && event.prompt_eval_count != null)
      onTokens?.({
        inputTokens: event.prompt_eval_count,
        outputTokens: event.eval_count
      });
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
          : `Check ${config.provider === 'anthropic' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL'} and that the host is reachable.`
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
    config.provider === 'openai'
      ? config.openaiBaseUrl
      : config.provider === 'anthropic'
        ? config.anthropicBaseUrl
        : config.ollamaBaseUrl;
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
  const anthropic = config.provider === 'anthropic';
  const openai = config.provider === 'openai';

  if (status === 401 || status === 403) {
    return anthropic
      ? 'The API key was rejected. Check ANTHROPIC_API_KEY in the environment or ~/.webmd.conf, and note that a duplicate entry there overrides the earlier one.'
      : openai
      ? 'The API key was rejected. Check OPENAI_API_KEY in the environment or ~/.webmd.conf, and note that a duplicate entry there overrides the earlier one.'
      : 'The provider rejected the request.';
  }
  if (status === 404) {
    return anthropic
      ? `Check that AI_MODEL "${config.model}" is a Claude model your key can use.`
      : openai
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
