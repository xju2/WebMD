import { indicoReference } from '../src/editor.js';
import { WorkspaceError } from './workspace.js';

const cache = new Map();
const inFlight = new Map();

export function isIndicoUrl(value) {
  return typeof value === 'string' && indicoReference(value.trim()) !== null;
}

/**
 * Personal access tokens by host, from `INDICO_TOKEN`: either a bare token for
 * indico.cern.ch, or `host=token` pairs separated by commas or whitespace. A
 * token only ever travels to the host it was written next to.
 */
export function indicoTokens(env = process.env) {
  const setting = (env.INDICO_TOKEN || '').trim();
  if (!setting) return new Map();

  const entries = setting
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf('=');
      return at === -1
        ? ['indico.cern.ch', entry]
        : [entry.slice(0, at).trim().toLowerCase(), entry.slice(at + 1).trim()];
    })
    .filter(([host, token]) => host && token);

  return new Map(entries);
}

/**
 * Resolves `{ url, title, event }` for an Indico event, contribution or
 * session link. Indico's JSON export only covers whole events, so the title
 * normally comes off the page itself, which answers for every shape of link
 * alike; a token, when there is one, also opens the pages that need a login.
 */
export async function fetchIndicoTitle(
  url,
  { fetchImpl = fetch, tokens = new Map() } = {}
) {
  const reference = indicoReference(typeof url === 'string' ? url.trim() : '');
  if (!reference) {
    throw new WorkspaceError(400, `"${url}" is not an Indico link.`);
  }

  const key = reference.url;
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return await pending;

  const token = tokens.get(reference.host.toLowerCase()) || '';
  const request = requestIndico(reference, fetchImpl, token).finally(() =>
    inFlight.delete(key)
  );
  inFlight.set(key, request);

  const metadata = await request;
  cache.set(key, metadata);
  return metadata;
}

async function requestIndico(reference, fetchImpl, token) {
  const page = await requestIndicoText(reference.url, fetchImpl, token);
  try {
    return parseIndicoPage(page, reference.url);
  } catch (error) {
    // A page can still be private to the token's holder, or to nobody at all.
    if (!token || error.status !== 404) throw error;
    return await exportedTitle(reference, fetchImpl, token);
  }
}

async function requestIndicoText(url, fetchImpl, token) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      // Cross-origin redirects drop this header, so it stays with the host it
      // was configured for.
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {})
    });
  } catch (error) {
    throw new WorkspaceError(
      502,
      `Could not reach Indico: ${error.message}. Check that this host has outbound network access.`
    );
  }

  if (!response) throw new WorkspaceError(502, 'No response from Indico.');
  if (response.status === 401 || response.status === 403) {
    throw new WorkspaceError(
      502,
      `Indico refused the request with ${response.status}. Check INDICO_TOKEN in the environment or ~/.webmd.conf, and that its scope includes reading events.`
    );
  }
  if (!response.ok) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    throw new WorkspaceError(502, `Indico failed with ${status}.`);
  }

  return await response.text();
}

/**
 * The JSON export API, which takes a token on every Indico. It is only reached
 * for a page the HTML view would not hand over, and it names contributions
 * only as part of the whole event, so that detail is asked for just then.
 */
async function exportedTitle(reference, fetchImpl, token) {
  const contribution = reference.kind === 'contributions';
  const url =
    `https://${reference.host}/export/event/${reference.event}.json` +
    (contribution ? '?detail=contributions&occ=no' : '');

  const body = await requestIndicoText(url, fetchImpl, token);
  let exported;
  try {
    exported = JSON.parse(body);
  } catch {
    throw new WorkspaceError(404, 'Indico returned no title for that link.');
  }

  const event = collapse(exported?.results?.[0]?.title || '');
  if (!event) {
    throw new WorkspaceError(
      404,
      'Indico gave no title for that link; the token cannot see it.'
    );
  }

  const talk = contribution
    ? collapse(
        (exported.results[0].contributions || []).find((entry) =>
          String(entry?.url || '').includes(`/contributions/${reference.id}/`)
        )?.title || ''
      )
    : '';

  return { url: reference.url, title: talk || event, event };
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
  return collapse(
    value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_match, code) =>
        String.fromCodePoint(Number(code))
      )
      .replace(/&amp;/g, '&')
  );
}

function collapse(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/** Test seam: the module-level cache outlives a single test. */
export function resetIndicoCache() {
  cache.clear();
  inFlight.clear();
}
