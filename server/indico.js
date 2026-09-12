import { indicoReference } from '../src/editor.js';
import { WorkspaceError } from './workspace.js';

const cache = new Map();
const inFlight = new Map();

// A slow Indico must not leave a view spinning: every request gives up here.
export const INDICO_TIMEOUT_MS = 15000;
// Same-origin hops only (a trailing slash, http to https); anything longer is
// not an Indico answering the question it was asked.
const MAX_REDIRECTS = 3;

/**
 * The Indicos a token can be configured for, by the word its variables use.
 * `INDICO_<NAME>_URL` adds another installation or moves one of these.
 */
export const KNOWN_INDICO_ORIGINS = {
  cern: 'https://indico.cern.ch',
  fnal: 'https://indico.fnal.gov',
  global: 'https://indico.global'
};

/**
 * Indico installations this server knows, keyed by exact origin, as
 * `{ name, origin, token }`. A token is bound to one origin, named up front,
 * and never to whatever a hostname happens to look like: `INDICO_CERN_TOKEN`
 * travels to `https://indico.cern.ch` and nowhere else, so a link to
 * `indico.cern.example` cannot collect it. An installation not in
 * `KNOWN_INDICO_ORIGINS` needs `INDICO_<NAME>_URL` beside its token.
 */
export function indicoSites(env = process.env) {
  const names = new Map();
  for (const [key, value] of Object.entries(env || {})) {
    const match = /^INDICO_([A-Z0-9]+)_(TOKEN|URL)$/.exec(key);
    if (!match) continue;
    const name = match[1].toLowerCase();
    const entry = names.get(name) || {};
    const text = typeof value === 'string' ? value.trim() : '';
    if (match[2] === 'TOKEN') entry.token = text;
    else entry.url = text;
    names.set(name, entry);
  }
  for (const name of Object.keys(KNOWN_INDICO_ORIGINS)) {
    if (!names.has(name)) names.set(name, {});
  }

  const sites = new Map();
  for (const [name, entry] of names) {
    const origin = entry.url
      ? trustedOrigin(entry.url)
      : KNOWN_INDICO_ORIGINS[name] || '';
    // A token without a place to send it is dropped, never guessed at.
    if (!origin) continue;
    const existing = sites.get(origin);
    if (existing?.token) continue;
    sites.set(origin, { name, origin, token: entry.token || '' });
  }
  return sites;
}

/** `https://host` for a configured base URL, or '' when it is not one. */
function trustedOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return '';
  }
  return parsed.origin;
}

/** The variable a given Indico reads its token from, for error messages. */
export function indicoTokenName(origin, sites = new Map()) {
  const name = sites.get(origin)?.name;
  return name ? `INDICO_${name.toUpperCase()}_TOKEN` : 'INDICO_<NAME>_TOKEN';
}

/** The token for exactly this origin, or '' — never one for a lookalike. */
export function tokenForOrigin(origin, sites = new Map()) {
  return sites.get(origin)?.token || '';
}

export function isIndicoUrl(value) {
  return typeof value === 'string' && indicoReference(value.trim()) !== null;
}

/**
 * Everything that makes an address safe to fetch from this server: HTTPS, no
 * credentials, no custom port, and either a configured installation or a host
 * that calls itself `indico.` — the shape the paste handler already accepts.
 * Returns `{ origin, url }` or throws a 400 that says what to fix.
 */
export function checkIndicoAddress(value, sites = new Map()) {
  let parsed;
  try {
    parsed = new URL(String(value ?? '').trim());
  } catch {
    throw new WorkspaceError(400, 'That is not a URL.');
  }
  if (parsed.protocol === 'http:') {
    throw new WorkspaceError(400, 'Use the https:// address of the Indico.');
  }
  if (parsed.protocol !== 'https:') {
    throw new WorkspaceError(400, 'Only https:// Indico links are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new WorkspaceError(
      400,
      'Remove the user name or password from the link; tokens belong in ~/.webmd.conf.'
    );
  }
  if (parsed.port) {
    throw new WorkspaceError(400, 'Indico links with a custom port are not supported.');
  }
  if (!sites.has(parsed.origin) && !/^indico\./i.test(parsed.hostname)) {
    throw new WorkspaceError(
      400,
      `${parsed.hostname} is not a known Indico. Add INDICO_<NAME>_URL=${parsed.origin} to ~/.webmd.conf to use it.`
    );
  }
  return { origin: parsed.origin, url: parsed };
}

/**
 * A failure that says what kind it is, so the Meetings view can tell an
 * expired token from a dead network without reading prose. `kind` is one of
 * auth, config, network, timeout, redirect, not_found, upstream.
 */
export class IndicoError extends WorkspaceError {
  constructor(kind, message, status = 502) {
    super(status, message);
    this.kind = kind;
  }
}

/**
 * GET from an Indico with the bearer token only it may see. Redirects are
 * followed by hand so each hop is checked before the header goes with it: a
 * hop to another origin, or off HTTPS, stops the request instead of carrying
 * the token (or the server) somewhere it was never pointed.
 *
 * Never puts the token in an error: messages name the variable instead.
 */
export async function indicoFetch(
  target,
  {
    fetchImpl = fetch,
    sites = new Map(),
    token = '',
    timeoutMs = INDICO_TIMEOUT_MS,
    accept
  } = {}
) {
  const start = new URL(target);
  const origin = start.origin;
  let url = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response;
    try {
      response = await fetchImpl(url.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...(accept ? { Accept: accept } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new IndicoError(
          'timeout',
          `${start.hostname} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
          504
        );
      }
      throw new IndicoError(
        'network',
        `Could not reach ${start.hostname}: ${error?.message || 'network error'}. Check that this host has outbound network access.`
      );
    }
    if (!response) {
      throw new IndicoError('network', `No response from ${start.hostname}.`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.('location');
      if (!location) {
        throw new IndicoError(
          'upstream',
          `${start.hostname} redirected without saying where.`
        );
      }
      const next = new URL(location, url);
      if (next.origin !== origin) {
        // Most often the single sign-on page, which is what a protected page
        // looks like to a request without a usable token.
        throw new IndicoError(
          'redirect',
          `${start.hostname} redirected to ${next.hostname}; not followed.`
        );
      }
      url = next;
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw authError(start.hostname, origin, sites, token, response.status);
    }
    if (response.status === 400 && token) {
      // Indico answers an unknown, expired, or revoked token with a 400 whose
      // page says invalid_token, rather than with a 401.
      const body = await safeText(response);
      if (/invalid_token/i.test(body)) {
        throw authError(start.hostname, origin, sites, token, 400);
      }
      throw new IndicoError('upstream', `${start.hostname} failed with 400 Bad Request.`);
    }
    if (response.status === 404) {
      throw new IndicoError('not_found', `${start.hostname} has no such page.`, 404);
    }
    if (!response.ok) {
      const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
      throw new IndicoError('upstream', `${start.hostname} failed with ${status}.`);
    }
    return response;
  }

  throw new IndicoError('upstream', `${start.hostname} redirected too many times.`);
}

function authError(hostname, origin, sites, token, status) {
  const variable = indicoTokenName(origin, sites);
  return token
    ? new IndicoError(
        'auth',
        `${hostname} rejected ${variable} (${status}). It may be expired, revoked, or missing the read:legacy_api scope; create a new token and restart WebMD.`
      )
    : new IndicoError(
        'config',
        `${hostname} needs a login for this (${status}). Set ${variable} in the environment or ~/.webmd.conf and restart WebMD.`
      );
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Resolves `{ url, title, event }` for an Indico event, contribution or
 * session link. Indico's JSON export only covers whole events, so the title
 * normally comes off the page itself, which answers for every shape of link
 * alike; a token, when there is one, also opens the pages that need a login.
 */
export async function fetchIndicoTitle(
  url,
  { fetchImpl = fetch, sites = new Map() } = {}
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

  const origin = new URL(reference.url).origin;
  const token = tokenForOrigin(origin, sites);
  const request = requestIndico(reference, { fetchImpl, sites, token }).finally(
    () => inFlight.delete(key)
  );
  inFlight.set(key, request);

  const metadata = await request;
  cache.set(key, metadata);
  return metadata;
}

async function requestIndico(reference, options) {
  let page;
  try {
    page = await (await indicoFetch(reference.url, options)).text();
  } catch (error) {
    // A page that turns the token away can still be open to the export API:
    // a read:legacy_api token reaches /export/ but not the HTML views, which
    // need read:everything. A redirect to the sign-on page means the same.
    if (!options.token || !['auth', 'redirect'].includes(error.kind)) {
      throw titleError(error);
    }
    return await exportedTitle(reference, options);
  }
  try {
    return parseIndicoPage(page, reference.url);
  } catch (error) {
    // A page can still be private to the token's holder, or to nobody at all.
    if (!options.token || error.status !== 404) throw error;
    return await exportedTitle(reference, options);
  }
}

// The paste handler keeps its placeholder on a 404, so a sign-on redirect
// without a token reads as "needs a login" rather than as a failure.
function titleError(error) {
  if (error.kind === 'redirect') {
    return new WorkspaceError(
      404,
      'Indico gave no title for that link; it may need a login.'
    );
  }
  return error;
}

/**
 * The JSON export API, which takes a token on every Indico. It is only reached
 * for a page the HTML view would not hand over, and it names contributions
 * only as part of the whole event, so that detail is asked for just then.
 */
async function exportedTitle(reference, options) {
  const contribution = reference.kind === 'contributions';
  const url =
    `https://${reference.host}/export/event/${reference.event}.json` +
    (contribution ? '?detail=contributions&occ=no' : '');

  const body = await (await indicoFetch(url, options)).text();
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

export function decodeHtml(value) {
  return collapse(
    String(value ?? '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_match, code) => safeCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
        safeCodePoint(parseInt(code, 16))
      )
      .replace(/&amp;/g, '&')
  );
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function collapse(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/** Test seam: the module-level cache outlives a single test. */
export function resetIndicoCache() {
  cache.clear();
  inFlight.clear();
}
