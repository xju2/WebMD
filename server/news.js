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
// Every day's listing is kept this long, so a week away can still be caught up.
export const NEWS_HISTORY_DAYS = 31;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

// key → { news, etag, checkedAt, expiresAt }
const cache = new Map();
const inFlight = new Map();
// Without a cache directory the history lives here: key → Map(day → news).
const memoryHistory = new Map();
// `${key}/${day}` already written this run, so a cache hit costs no disk.
const archived = new Set();

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
    if (fresh) {
      await archiveListing(key, cached.news, { cacheDir, now });
      return cached.news;
    }
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
    await archiveListing(key, entry.news, { cacheDir, now });
    return entry.news;
  } catch (error) {
    if (!cached) throw error;
    return { ...cached.news, warning: error.message };
  }
}

/**
 * The announcement day of a listing, `YYYY-MM-DD`, read off arXiv's own date
 * ("Thu, 10 Sep 2026 00:00:00 -0400") so the local time zone cannot shift it.
 */
export function newsDay(published) {
  const match = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(
    String(published ?? '')
  );
  const month = match ? MONTHS.indexOf(match[2].toLowerCase()) : -1;
  if (month >= 0) {
    return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  const date = new Date(published);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

export function isNewsDay(day) {
  return DAY.test(String(day ?? ''));
}

function historyDir(cacheDir, key) {
  return path.join(cacheDir, 'arxiv-news', 'history', key);
}

/** The earliest day still kept, `YYYY-MM-DD`. */
export function oldestNewsDay(now = Date.now) {
  return new Date(now() - NEWS_HISTORY_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Keeps each day's listing under its announcement day and forgets the ones
 * past NEWS_HISTORY_DAYS. Weekend feeds are empty and are not kept.
 */
async function archiveListing(key, news, { cacheDir, now = Date.now } = {}) {
  const day = newsDay(news?.published);
  if (!day || !news.papers?.length || archived.has(`${key}/${day}`)) return;
  const oldest = oldestNewsDay(now);
  if (cacheDir) {
    const dir = historyDir(cacheDir, key);
    await writeCacheFile(path.join(dir, `${day}.json`), news);
    for (const kept of await historyDays(dir)) {
      if (kept < oldest)
        await fs.rm(path.join(dir, `${kept}.json`), { force: true });
    }
  } else {
    const days = memoryHistory.get(key) ?? new Map();
    days.set(day, news);
    for (const kept of days.keys()) if (kept < oldest) days.delete(kept);
    memoryHistory.set(key, days);
  }
  archived.add(`${key}/${day}`);
}

async function historyDays(dir) {
  try {
    return (await fs.readdir(dir))
      .map((name) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1])
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The days with a kept listing for `categories`, newest first. */
export async function newsHistory(
  categories,
  { cacheDir, now = Date.now } = {}
) {
  const key = categories.join('+');
  const days = cacheDir
    ? await historyDays(historyDir(cacheDir, key))
    : [...(memoryHistory.get(key)?.keys() ?? [])];
  const oldest = oldestNewsDay(now);
  return days
    .filter((day) => day >= oldest)
    .sort()
    .reverse();
}

/** One kept day's listing, in the same shape fetchArxivNews returns. */
export async function readNewsDay(categories, day, { cacheDir } = {}) {
  const key = categories.join('+');
  const news =
    isNewsDay(day) &&
    (cacheDir
      ? await readCacheFile(path.join(historyDir(cacheDir, key), `${day}.json`))
      : memoryHistory.get(key)?.get(day));
  if (!news?.papers) {
    throw new WorkspaceError(404, `No arXiv listing is kept for ${day}.`);
  }
  return news;
}

/**
 * Checks the feed every `intervalMs`, so a day you never open News for is
 * still kept. Most ticks are cache hits; a stale listing costs arXiv a 304.
 */
export function startNewsArchive({
  categories,
  cacheDir,
  intervalMs = 60 * 60 * 1000,
  fetchImpl = fetch,
  onError = () => {}
}) {
  const tick = () =>
    fetchArxivNews(categories, { cacheDir, fetchImpl }).catch(onError);
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
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

export async function writeCacheFile(file, value, { mode } = {}) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), { mode });
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
  memoryHistory.clear();
  archived.clear();
}
