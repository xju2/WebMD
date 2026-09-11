import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeXml } from './arxiv.js';
import { WorkspaceError } from './workspace.js';

const ARXIV_RSS_URL = 'https://rss.arxiv.org/rss/';
export const DEFAULT_NEWS_CATEGORIES = [
  'hep-ex',
  'hep-ph',
  'cs.LG',
  'cs.AI',
  'physics.data-an'
];
const CATEGORY = /^[a-z][a-z-]*(?:\.[A-Za-z-]+)?$/;
// arXiv rebuilds the feed once a day and says in max-age how long the current
// one stands. Without that header a half-hour cache costs nothing in freshness.
const CACHE_MS = 30 * 60 * 1000;
const MAX_CACHE_MS = 24 * 60 * 60 * 1000;
// A forced refresh still waits this long, so the button cannot hammer arXiv.
const MIN_REFRESH_MS = 60 * 1000;

// key → { news, etag, checkedAt, expiresAt }
const cache = new Map();
const inFlight = new Map();

/**
 * `ARXIV_NEWS_CATEGORIES` in the environment (or `~/.webmd.conf`) replaces the
 * default list with a comma-separated one of your own. Anything that is not an
 * arXiv category name is dropped rather than sent to arXiv.
 */
export function newsCategories(env = process.env) {
  const configured = String(env?.ARXIV_NEWS_CATEGORIES ?? '')
    .split(',')
    .map((category) => category.trim())
    .filter((category) => CATEGORY.test(category));
  const unique = [...new Set(configured)];
  return unique.length ? unique : DEFAULT_NEWS_CATEGORIES;
}

/**
 * Today's arXiv announcements for `categories`, as
 * `{ categories, published, fetchedAt, papers, warning? }`. When arXiv cannot
 * be reached, the last good listing comes back with a warning instead of an
 * error, because yesterday's papers beat an empty page.
 *
 * With a `cacheDir` the listing also survives a server restart, and a stale
 * copy is revalidated by ETag, so an unchanged feed costs arXiv a 304 rather
 * than half a megabyte.
 */
export async function fetchArxivNews(
  categories,
  { fetchImpl = fetch, refresh = false, now = Date.now, cacheDir } = {}
) {
  const key = categories.join('+');
  const file = cacheDir && path.join(cacheDir, 'arxiv-news', `${key}.json`);
  let cached = cache.get(key);
  if (!cached && file) {
    cached = await readCacheFile(file);
    if (cached?.news?.papers) cache.set(key, cached);
    else cached = undefined;
  }
  if (cached) {
    const fresh = refresh
      ? now() - cached.checkedAt < MIN_REFRESH_MS
      : now() < cached.expiresAt;
    if (fresh) return cached.news;
  }

  let pending = inFlight.get(key);
  if (!pending) {
    pending = requestFeed(key, fetchImpl, cached?.etag).finally(() =>
      inFlight.delete(key)
    );
    inFlight.set(key, pending);
  }

  try {
    const feed = await pending;
    const checkedAt = now();
    const entry = {
      news: feed.notModified
        ? cached.news
        : {
            categories,
            published: feed.published,
            papers: feed.papers,
            fetchedAt: checkedAt
          },
      etag: feed.etag || cached?.etag || '',
      checkedAt,
      expiresAt: checkedAt + feed.freshMs
    };
    cache.set(key, entry);
    if (file) await writeCacheFile(file, entry);
    return entry.news;
  } catch (error) {
    if (!cached) throw error;
    return { ...cached.news, warning: error.message };
  }
}

async function requestFeed(key, fetchImpl, etag) {
  let response;
  try {
    response = await fetchImpl(
      `${ARXIV_RSS_URL}${key}`,
      etag ? { headers: { 'If-None-Match': etag } } : undefined
    );
  } catch (error) {
    throw new WorkspaceError(
      502,
      `Could not reach arXiv: ${error.message}. Check that this host has outbound network access.`
    );
  }
  const freshness = {
    etag: response?.headers?.get('etag') || '',
    freshMs: freshMs(response?.headers)
  };
  if (etag && response?.status === 304) {
    return { ...freshness, notModified: true };
  }
  if (!response?.ok) {
    const status = response
      ? `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
      : 'no response';
    throw new WorkspaceError(502, `The arXiv feed failed with ${status}.`);
  }
  return { ...freshness, ...parseArxivRss(await response.text()) };
}

/** How long arXiv says this copy stands: max-age less what the CDN held it. */
function freshMs(headers) {
  const maxAge = /max-age=(\d+)/i.exec(headers?.get('cache-control') || '');
  if (!maxAge) return CACHE_MS;
  const age = Number(headers.get('age')) || 0;
  const ms = (Number(maxAge[1]) - age) * 1000;
  return Math.min(Math.max(ms, MIN_REFRESH_MS), MAX_CACHE_MS);
}

/**
 * Best-effort JSON cache files: a missing or unreadable one is a cache miss,
 * and a failed write only costs the next restart a fetch.
 */
export async function readCacheFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeCacheFile(file, value) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value));
    await fs.rename(temp, file);
  } catch (error) {
    console.warn(`Could not write cache file ${file}: ${error.message}`);
  }
}

/**
 * Reads arXiv's RSS listing. Like the Atom reader in arxiv.js this stays
 * regex-based: the feed shape is fixed and Node has no DOM parser.
 */
export function parseArxivRss(xml) {
  const channel = String(xml ?? '');
  if (!/<rss[\s>]/i.test(channel)) {
    throw new WorkspaceError(502, 'arXiv did not return an RSS feed.');
  }
  // The first pubDate is the channel's, which is the announcement day.
  const published = tag(channel.split(/<item>/i)[0], 'pubDate');
  const papers = [...channel.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .map((match) => parseItem(match[1]))
    .filter(Boolean);
  return { published, papers };
}

function parseItem(item) {
  const guid = tag(item, 'guid');
  const versioned = /^oai:arXiv\.org:(.+)$/i.exec(guid)?.[1] || '';
  const id = versioned.replace(/v\d+$/, '');
  const title = tag(item, 'title');
  if (!id || !title) return null;

  const description = tag(item, 'description');
  return {
    id,
    title,
    authors: tag(item, 'dc:creator')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    abstract: description.replace(/^[\s\S]*?Abstract:\s*/i, ''),
    categories: [...item.matchAll(/<category>([\s\S]*?)<\/category>/gi)].map(
      (match) => decodeXml(match[1])
    ),
    // new, cross, replace, or replace-cross.
    announceType: tag(item, 'arxiv:announce_type') || 'new',
    url: `https://arxiv.org/abs/${id}`
  };
}

function tag(xml, name) {
  const match = new RegExp(
    `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`,
    'i'
  ).exec(xml);
  return match ? decodeXml(match[1]) : '';
}

/** Test seam: the module-level cache outlives a single test. */
export function resetNewsCache() {
  cache.clear();
  inFlight.clear();
}
