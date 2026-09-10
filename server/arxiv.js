import { WorkspaceError } from './workspace.js';

const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
const ARXIV_ID =
  /^(?:\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?$/i;
const MAX_ARXIV_ERROR_CHARS = 400;
/** arXiv asks callers to leave ~3s between requests. */
const MIN_REQUEST_GAP_MS = 3000;

const cache = new Map();
const inFlight = new Map();
let nextRequestAt = 0;

export function isArxivId(value) {
  return typeof value === 'string' && ARXIV_ID.test(value.trim());
}

/**
 * Resolves `{ id, title, authors }` for an arXiv identifier. Results are cached
 * forever: published metadata for a given id (version included) does not change.
 */
export async function fetchArxivMetadata(id, { fetchImpl = fetch } = {}) {
  if (!isArxivId(id)) {
    throw new WorkspaceError(400, `"${id}" is not an arXiv identifier.`);
  }

  const key = id.trim();
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return await pending;

  const request = requestArxiv(key, fetchImpl).finally(() =>
    inFlight.delete(key)
  );
  inFlight.set(key, request);

  const metadata = await request;
  cache.set(key, metadata);
  return metadata;
}

async function requestArxiv(id, fetchImpl) {
  await waitForRequestSlot();

  const url = `${ARXIV_API_URL}?id_list=${encodeURIComponent(id)}&max_results=1`;
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new WorkspaceError(
      502,
      `Could not reach arXiv: ${error.message}. Check that this host has outbound network access.`
    );
  }

  if (!response) {
    throw new WorkspaceError(502, 'No response from arXiv.');
  }
  if (!response.ok) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    const detail = await readArxivError(response);
    throw new WorkspaceError(
      502,
      [
        `arXiv failed with ${status}.`,
        response.status === 429
          ? 'Rate limited by arXiv. Retry in a moment.'
          : '',
        detail && `arXiv said: ${detail}`
      ]
        .filter(Boolean)
        .join(' ')
    );
  }

  return parseArxivEntry(await response.text(), id);
}

/** Serializes outbound calls so bursts of pastes stay inside arXiv's rate limit. */
async function waitForRequestSlot() {
  const now = Date.now();
  const readyAt = Math.max(now, nextRequestAt);
  nextRequestAt = readyAt + MIN_REQUEST_GAP_MS;

  const delay = readyAt - now;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Pulls the title and author names out of the Atom feed. Node has no DOM parser
 * and the feed shape is fixed, so this stays regex-based rather than adding a
 * dependency.
 */
export function parseArxivEntry(feed, id) {
  const entry = /<entry>([\s\S]*?)<\/entry>/i.exec(feed || '')?.[1];
  if (!entry) {
    throw new WorkspaceError(404, `arXiv has no entry for ${id}.`);
  }

  const title = decodeXml(
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(entry)?.[1] || ''
  );
  const authors = [...entry.matchAll(/<name[^>]*>([\s\S]*?)<\/name>/gi)]
    .map((match) => decodeXml(match[1]))
    .filter(Boolean);

  if (!title) {
    throw new WorkspaceError(404, `arXiv returned no title for ${id}.`);
  }
  return { id, title, authors };
}

export function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readArxivError(response) {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    return text.length > MAX_ARXIV_ERROR_CHARS
      ? `${text.slice(0, MAX_ARXIV_ERROR_CHARS)}...`
      : text;
  } catch {
    return '';
  }
}

/** Test seam: the module-level cache and rate-limit clock outlive a single test. */
export function resetArxivCache() {
  cache.clear();
  inFlight.clear();
  nextRequestAt = 0;
}
