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
  // The syndication endpoint — what an embedded post loads itself from — is
  // the only public place that names an X Article, whose post body is just a
  // link to it. oEmbed answers when it will not.
  const syndicated = await requestJson(syndicationUrl(reference), fetchImpl);
  if (syndicated) {
    const post = parseSyndicatedPost(syndicated, reference);
    if (post) return post;
  }

  const embed = await requestJson(oembedUrl(reference), fetchImpl, {
    required: true
  });
  return parseXOembed(embed, reference);
}

function syndicationUrl({ id }) {
  // The token is a function of the id, the way an embedded post derives it.
  const token = ((Number(id) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, '');
  return `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`;
}

function oembedUrl({ url }) {
  return `https://publish.x.com/oembed?omit_script=1&url=${encodeURIComponent(url)}`;
}

/**
 * Fetches JSON, returning null for anything short of an answer unless the
 * caller has no fallback left — then the failure is the user's to hear about.
 */
async function requestJson(endpoint, fetchImpl, { required = false } = {}) {
  let response;
  try {
    response = await fetchImpl(endpoint, { redirect: 'follow' });
  } catch (error) {
    if (!required) return null;
    throw new WorkspaceError(
      502,
      `Could not reach X: ${error.message}. Check that this host has outbound network access.`
    );
  }

  if (!response?.ok) {
    if (!required) return null;
    // A post that is deleted, protected or from a suspended account is one X
    // will not hand over; the placeholder label already says what we know.
    if (!response) throw new WorkspaceError(502, 'No response from X.');
    if (response.status === 403 || response.status === 404) {
      throw new WorkspaceError(404, 'X gave nothing for that post.');
    }
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    throw new WorkspaceError(502, `X failed with ${status}.`);
  }

  try {
    return await response.json();
  } catch {
    if (!required) return null;
    throw new WorkspaceError(502, 'X returned something other than JSON.');
  }
}

/**
 * The syndicated post carries the account, the post's own words, and — when
 * the post is a link to an X Article — the article's title, which is the name
 * the post goes by everywhere it is seen.
 */
export function parseSyndicatedPost(payload, reference) {
  const user = payload?.user;
  const author = collapse(typeof user?.name === 'string' ? user.name : '');
  const handle = collapse(
    typeof user?.screen_name === 'string' ? user.screen_name : ''
  );
  if (!author && !handle) return null;

  const article = collapse(
    typeof payload?.article?.title === 'string' ? payload.article.title : ''
  );
  const words = collapse(
    stripLinks(typeof payload?.text === 'string' ? payload.text : '')
  );

  return {
    url: reference.url,
    author,
    handle: handle || reference.handle,
    text: article || words
  };
}

/** `t.co` stands in for media and links alike, and reads as noise in a label. */
function stripLinks(text) {
  return text.replace(/https?:\/\/t\.co\/\S+/g, ' ');
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
    stripLinks(
      decodeHtml(paragraph.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
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
