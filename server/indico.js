import { indicoReference } from '../src/editor.js';
import { WorkspaceError } from './workspace.js';

const cache = new Map();
const inFlight = new Map();

export function isIndicoUrl(value) {
  return typeof value === 'string' && indicoReference(value.trim()) !== null;
}

/**
 * Resolves `{ url, title, event }` for an Indico event, contribution or
 * session link. Indico's JSON export only covers whole events, so the title
 * comes off the page itself, which answers for every shape of link alike.
 */
export async function fetchIndicoTitle(url, { fetchImpl = fetch } = {}) {
  const reference = indicoReference(typeof url === 'string' ? url.trim() : '');
  if (!reference) {
    throw new WorkspaceError(400, `"${url}" is not an Indico link.`);
  }

  const key = reference.url;
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return await pending;

  const request = requestIndico(key, fetchImpl).finally(() =>
    inFlight.delete(key)
  );
  inFlight.set(key, request);

  const metadata = await request;
  cache.set(key, metadata);
  return metadata;
}

async function requestIndico(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'follow' });
  } catch (error) {
    throw new WorkspaceError(
      502,
      `Could not reach Indico: ${error.message}. Check that this host has outbound network access.`
    );
  }

  if (!response) throw new WorkspaceError(502, 'No response from Indico.');
  if (!response.ok) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    throw new WorkspaceError(502, `Indico failed with ${status}.`);
  }

  return parseIndicoPage(await response.text(), url);
}

/**
 * The page names the meeting in `og:title` and, for a contribution or session,
 * repeats it in `<title>` followed by the dates and the item's own name:
 * `Meeting (1-2 May 2026): The talk · Indico`.
 */
export function parseIndicoPage(html, url) {
  const page = html || '';
  const event = decodeHtml(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(
      page
    )?.[1] || ''
  );
  // A page that needs a login is served as the sign-in form, which names no event.
  if (!event) {
    throw new WorkspaceError(
      404,
      'Indico gave no title for that link; it may need a login.'
    );
  }

  // An event's own page ends in the name of the view being shown ("General"),
  // so only a contribution or session takes its name from the heading.
  const heading = /\/(contributions|sessions)\//.test(url)
    ? decodeHtml(
        /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page)?.[1] || ''
      ).replace(/\s*·\s*Indico$/, '')
    : '';
  const rest = heading.startsWith(event) ? heading.slice(event.length) : '';
  const section = /\)\s*:\s*(.+)$/.exec(rest)?.[1]?.trim() || '';

  return { url, title: section || event, event };
}

function decodeHtml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Test seam: the module-level cache outlives a single test. */
export function resetIndicoCache() {
  cache.clear();
  inFlight.clear();
}
