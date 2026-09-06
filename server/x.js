import { xPostReference } from '../src/editor.js';
import { WorkspaceError } from './workspace.js';

const cache = new Map();
const inFlight = new Map();

export function isXPostUrl(value) {
  return typeof value === 'string' && xPostReference(value.trim()) !== null;
}

/**
 * Resolves `{ url, author, handle, text }` for an X post. X's oEmbed endpoint
 * is the one way in that needs no key: it names the account and quotes the
 * post, which is all a link label wants.
 */
export async function fetchXPost(url, { fetchImpl = fetch } = {}) {
  const reference = xPostReference(url);
  if (!reference) {
    throw new WorkspaceError(400, `"${url}" is not an X post link.`);
  }

  const key = reference.url;
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return await pending;

  const request = requestXPost(reference, fetchImpl).finally(() =>
    inFlight.delete(key)
  );
  inFlight.set(key, request);

  const metadata = await request;
  cache.set(key, metadata);
  return metadata;
}

async function requestXPost(reference, fetchImpl) {
  const endpoint =
    'https://publish.x.com/oembed?omit_script=1&url=' +
    encodeURIComponent(reference.url);

  let response;
  try {
    response = await fetchImpl(endpoint, { redirect: 'follow' });
  } catch (error) {
    throw new WorkspaceError(
      502,
      `Could not reach X: ${error.message}. Check that this host has outbound network access.`
    );
  }

  if (!response) throw new WorkspaceError(502, 'No response from X.');
  // A post that is deleted, protected or from a suspended account is one X
  // will not quote; the placeholder label already says as much as we know.
  if (response.status === 403 || response.status === 404) {
    throw new WorkspaceError(404, 'X gave nothing for that post.');
  }
  if (!response.ok) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    throw new WorkspaceError(502, `X failed with ${status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new WorkspaceError(502, 'X returned something other than JSON.');
  }

  return parseXOembed(payload, reference);
}

/**
 * The embed markup carries the post in its first paragraph, followed by the
 * byline and date X adds for the quote card. Media and links are shortened to
 * `t.co`, which reads as noise in a label, so they come out.
 */
export function parseXOembed(payload, reference) {
  const html = typeof payload?.html === 'string' ? payload.html : '';
  const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] || '';
  const text = collapse(
    decodeHtml(
      paragraph
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/https?:\/\/t\.co\/\S+/g, ' ')
    )
  );

  const handle =
    /x\.com\/([A-Za-z0-9_]{1,15})/i.exec(
      typeof payload?.author_url === 'string' ? payload.author_url : ''
    )?.[1] || reference.handle;

  return {
    url: reference.url,
    author: collapse(
      typeof payload?.author_name === 'string' ? payload.author_name : ''
    ),
    handle,
    text
  };
}

function decodeHtml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(parseInt(code, 16))
    )
    .replace(/&amp;/g, '&');
}

function collapse(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/** Test seam: the module-level cache outlives a single test. */
export function resetXCache() {
  cache.clear();
  inFlight.clear();
}
