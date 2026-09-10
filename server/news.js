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
// arXiv rebuilds the feed once a day, so a half-hour cache costs nothing in
// freshness and keeps every tab and reload off rss.arxiv.org.
const CACHE_MS = 30 * 60 * 1000;
// A forced refresh still waits this long, so the button cannot hammer arXiv.
const MIN_REFRESH_MS = 60 * 1000;

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
 */
export async function fetchArxivNews(
  categories,
  { fetchImpl = fetch, refresh = false, now = Date.now } = {}
) {
  const key = categories.join('+');
  const cached = cache.get(key);
  const age = cached ? now() - cached.fetchedAt : Infinity;
  if (cached && age < (refresh ? MIN_REFRESH_MS : CACHE_MS)) return cached;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = requestFeed(key, fetchImpl).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }

  try {
    const feed = await pending;
    const news = { categories, ...feed, fetchedAt: now() };
    cache.set(key, news);
    return news;
  } catch (error) {
    if (!cached) throw error;
    return { ...cached, warning: error.message };
  }
}

async function requestFeed(key, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${ARXIV_RSS_URL}${key}`);
  } catch (error) {
    throw new WorkspaceError(
      502,
      `Could not reach arXiv: ${error.message}. Check that this host has outbound network access.`
    );
  }
  if (!response?.ok) {
    const status = response
      ? `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
      : 'no response';
    throw new WorkspaceError(502, `The arXiv feed failed with ${status}.`);
  }
  return parseArxivRss(await response.text());
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
