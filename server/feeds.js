import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readCacheFile, writeCacheFile } from './news.js';

export const FEEDS_CONFIG_PATH = '/.webmd/feeds.json';

/**
 * Where the Feeds view reads from until the workspace has its own
 * `.webmd/feeds.json`. Started from disler/pi-durable-news-agent's list.
 *
 *   feed  RSS or Atom, GitHub `releases.atom` included
 *   page  a listing page with no feed: its article links, each article's
 *         title and date read from the article itself. Article links are
 *         those below the page's own path, or below `links` when given
 *   hn    the Hacker News front page, through the Algolia API
 */
export const DEFAULT_FEED_SOURCES = [
  { kind: 'hn', name: 'Hacker News' },
  {
    kind: 'page',
    name: 'Anthropic News',
    url: 'https://www.anthropic.com/news'
  },
  {
    kind: 'page',
    name: 'Anthropic Engineering',
    url: 'https://www.anthropic.com/engineering',
    // Its posts moved under /research/; the listing still lives here.
    links: '/research/'
  },
  {
    kind: 'page',
    name: 'Hugging Face Papers',
    url: 'https://huggingface.co/papers'
  },
  { kind: 'page', name: 'ARC Prize', url: 'https://arcprize.org/blog' },
  { kind: 'feed', name: 'OpenAI News', url: 'https://openai.com/news/rss.xml' },
  {
    kind: 'feed',
    name: 'Google DeepMind',
    url: 'https://deepmind.google/blog/rss.xml'
  },
  {
    kind: 'feed',
    name: 'Hugging Face Blog',
    url: 'https://huggingface.co/blog/feed.xml'
  },
  { kind: 'feed', name: 'GitHub Blog', url: 'https://github.blog/feed/' },
  {
    kind: 'feed',
    name: 'Simon Willison',
    url: 'https://simonwillison.net/atom/everything/'
  },
  { kind: 'feed', name: 'Latent Space', url: 'https://www.latent.space/feed' },
  { kind: 'feed', name: 'Epoch AI', url: 'https://epoch.ai/atom.xml' },
  { kind: 'feed', name: 'METR', url: 'https://metr.org/feed.xml' },
  { kind: 'feed', name: 'Aider', url: 'https://aider.chat/feed.xml' },
  {
    kind: 'feed',
    name: 'TechCrunch AI',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/'
  },
  {
    kind: 'feed',
    name: 'The Verge AI',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'
  },
  {
    kind: 'feed',
    name: 'Ars Technica AI',
    url: 'https://arstechnica.com/ai/feed/'
  },
  { kind: 'feed', name: 'The Decoder', url: 'https://the-decoder.com/feed/' },
  {
    kind: 'feed',
    name: 'MarkTechPost',
    url: 'https://www.marktechpost.com/feed/'
  },
  { kind: 'feed', name: 'Lobsters AI', url: 'https://lobste.rs/t/ai.rss' },
  {
    kind: 'feed',
    name: 'r/LocalLLaMA',
    url: 'https://www.reddit.com/r/LocalLLaMA/top/.rss?t=day'
  },
  {
    kind: 'feed',
    name: 'r/ClaudeAI',
    url: 'https://www.reddit.com/r/ClaudeAI/new/.rss'
  },
  {
    kind: 'feed',
    name: 'Claude Code releases',
    url: 'https://github.com/anthropics/claude-code/releases.atom'
  },
  {
    kind: 'feed',
    name: 'Codex CLI releases',
    url: 'https://github.com/openai/codex/releases.atom'
  },
  {
    kind: 'feed',
    name: 'Gemini CLI releases',
    url: 'https://github.com/google-gemini/gemini-cli/releases.atom'
  },
  {
    kind: 'feed',
    name: 'pi releases',
    url: 'https://github.com/earendil-works/pi/releases.atom'
  },
  {
    kind: 'feed',
    name: 'SWE-bench releases',
    url: 'https://github.com/SWE-bench/SWE-bench/releases.atom'
  }
];

// Each topic is a Google News search over the last week.
export const DEFAULT_FEED_TOPICS = [
  'agentic AI for science',
  'AI agents scientific discovery',
  'LLM inference HPC',
  'foundation models for science',
  'machine learning high energy physics',
  'Claude Code',
  'coding agents',
  'Model Context Protocol'
];

const KINDS = new Set(['feed', 'page', 'hn']);
const HN_FRONT_URL =
  'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50';
// A source is asked again only after this, however often the view opens.
const FRESH_MS = 15 * 60 * 1000;
// A forced refresh still waits this long, so the button cannot hammer a site.
const MIN_REFRESH_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;
// What a source has shown is kept this long, so a week away can be caught up.
const KEEP_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
const PARALLEL_SOURCES = 6;
const PARALLEL_ARTICLES = 4;
// Article pages read per listing page per fetch: the first visit reads this
// many, later ones only the links that are new.
const MAX_PAGE_LINKS = 30;
const MAX_EXCERPT_CHARS = 400;
// Reddit refuses requests without a descriptive agent.
const USER_AGENT = 'WebMD feed reader (personal notes app)';

// source key → { items, checkedAt, error }
const sourceCache = new Map();
const inFlight = new Map();
// url → { hype, facts, signal, at }
let labelCache = null;

/**
 * The workspace's sources and topics, or the defaults when it has no
 * `.webmd/feeds.json`. An unreadable file or a bad entry costs a warning, not
 * the view.
 */
export async function readFeedsConfig(workspace) {
  let raw;
  try {
    raw = await fs.readFile(
      await workspace.resolvePath(FEEDS_CONFIG_PATH),
      'utf8'
    );
  } catch (error) {
    if (error.status === 404 || error.status === 403 || error.code === 'ENOENT')
      return { sources: DEFAULT_FEED_SOURCES, topics: DEFAULT_FEED_TOPICS };
    throw error;
  }
  let values;
  try {
    values = JSON.parse(raw);
  } catch (error) {
    return {
      sources: DEFAULT_FEED_SOURCES,
      topics: DEFAULT_FEED_TOPICS,
      warning: `${FEEDS_CONFIG_PATH} is not valid JSON (${error.message}), so the default sources are shown.`
    };
  }
  const warnings = [];
  const sources = (Array.isArray(values?.sources) ? values.sources : []).filter(
    (source) => {
      const kind = source?.kind ?? 'feed';
      const ok =
        KINDS.has(kind) &&
        typeof source?.name === 'string' &&
        source.name.trim() &&
        (kind === 'hn' || isWebUrl(source.url));
      if (!ok) warnings.push(`Skipped source ${JSON.stringify(source)}.`);
      return ok;
    }
  );
  const topics = (Array.isArray(values?.topics) ? values.topics : [])
    .filter((topic) => typeof topic === 'string' && topic.trim())
    .map((topic) => topic.trim());
  return {
    sources: sources.map((source) => ({
      kind: source.kind ?? 'feed',
      name: source.name.trim(),
      ...(source.url ? { url: source.url } : {}),
      ...(/^\/\S*$/.test(source.links ?? '') ? { links: source.links } : {})
    })),
    topics,
    ...(warnings.length ? { warning: warnings.join(' ') } : {})
  };
}

/** Starts `.webmd/feeds.json` from the defaults; an existing file is kept. */
export async function startFeedsConfig(workspace) {
  const absolute = await workspace.resolvePath(FEEDS_CONFIG_PATH, {
    forWrite: true
  });
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const content = `${JSON.stringify(
    { topics: DEFAULT_FEED_TOPICS, sources: DEFAULT_FEED_SOURCES },
    null,
    2
  )}\n`;
  try {
    await fs.writeFile(absolute, content, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return FEEDS_CONFIG_PATH;
}

/** One Google News search per topic, as sources like any other feed. */
export function topicSources(topics = []) {
  return topics.map((topic) => ({
    kind: 'feed',
    name: `Google News: ${topic}`,
    topic,
    url: `https://news.google.com/rss/search?q=${encodeURIComponent(`${topic} when:7d`)}&hl=en-US&gl=US&ceid=US:en`
  }));
}

/**
 * Every source's items from the last `days`, newest first, as
 * `{ items, sources }`. Each source is fetched at most every 15 minutes and
 * keeps what it showed before, so a feed that only lists its last ten posts
 * still adds up to a week. A source that fails keeps its last items and says
 * why in `sources`.
 */
export async function fetchFeeds(
  { sources = [], topics = [] },
  {
    fetchImpl = fetch,
    refresh = false,
    now = Date.now,
    cacheDir,
    days = 7
  } = {}
) {
  const all = [...sources, ...topicSources(topics)];
  const states = await mapLimit(all, PARALLEL_SOURCES, (source) =>
    sourceState(source, { fetchImpl, refresh, now, cacheDir })
  );
  const since = now() - days * DAY_MS;
  const seen = new Set();
  const items = [];
  states.forEach((state, index) => {
    for (const item of state.items) {
      if (seen.has(item.url) || itemTime(item) < since) continue;
      seen.add(item.url);
      items.push({ ...item, source: all[index].name });
    }
  });
  items.sort((left, right) => itemTime(right) - itemTime(left));
  return {
    items,
    sources: all.map((source, index) => ({
      name: source.name,
      kind: source.kind,
      url: source.url ?? HN_FRONT_URL,
      count: states[index].items.filter((item) => itemTime(item) >= since)
        .length,
      checkedAt: states[index].checkedAt,
      ...(states[index].error ? { error: states[index].error } : {})
    }))
  };
}

export function itemTime(item) {
  if (item.baseline) return 0;
  return Date.parse(item.published || item.firstSeen) || 0;
}

async function sourceState(source, { fetchImpl, refresh, now, cacheDir }) {
  const key = `${source.kind}|${source.url ?? HN_FRONT_URL}`;
  const file = cacheDir && path.join(cacheDir, 'feeds', `${sha1(key)}.json`);
  let state = sourceCache.get(key);
  if (!state && file) state = await readCacheFile(file);
  state ??= { items: [], checkedAt: 0 };
  sourceCache.set(key, state);

  const age = now() - state.checkedAt;
  if (age < (refresh ? MIN_REFRESH_MS : FRESH_MS)) return state;
  if (inFlight.has(key)) return inFlight.get(key);

  const request = (async () => {
    let next;
    try {
      const entries = await fetchSource(source, state, fetchImpl);
      next = {
        items: mergeItems(state.items, entries, now()),
        checkedAt: now()
      };
    } catch (error) {
      // Kept items stay; the source is asked again after the usual wait.
      next = { ...state, checkedAt: now(), error: error.message };
    }
    sourceCache.set(key, next);
    if (file) await writeCacheFile(file, next);
    return next;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/** Earlier items with the new ones folded in, each keeping when it was first seen. */
export function mergeItems(earlier, entries, now) {
  const firstSeen = new Date(now).toISOString();
  const byUrl = new Map(earlier.map((item) => [item.url, item]));
  for (const entry of entries) {
    const kept = byUrl.get(entry.url);
    byUrl.set(entry.url, { ...entry, firstSeen: kept?.firstSeen ?? firstSeen });
  }
  const oldest = now - KEEP_DAYS * DAY_MS;
  return [...byUrl.values()].filter(
    (item) => item.baseline || itemTime(item) >= oldest
  );
}

async function fetchSource(source, state, fetchImpl) {
  if (source.kind === 'hn')
    return parseHackerNews(await fetchText(HN_FRONT_URL, fetchImpl));
  if (source.kind === 'page') {
    const links = listingLinks(
      await fetchText(source.url, fetchImpl),
      source.url,
      { links: source.links }
    );
    const known = new Map(state.items.map((item) => [item.url, item]));
    // Undated links on the first visit (ARC Prize's posts, Anthropic's team
    // pages) are not news: they are kept as a baseline that is never listed,
    // so only a link that shows up later counts as new.
    const baseline = !state.items.length;
    return mapLimit(links, PARALLEL_ARTICLES, async (link) => {
      if (known.has(link.url)) return known.get(link.url);
      let entry = link;
      try {
        const meta = articleMeta(await fetchText(link.url, fetchImpl));
        entry = {
          ...link,
          title: meta.title || link.title,
          excerpt: meta.excerpt,
          published: meta.published
        };
      } catch {
        // The link text still makes a usable title.
      }
      return baseline && !entry.published ? { ...entry, baseline } : entry;
    });
  }
  const items = parseFeed(await fetchText(source.url, fetchImpl));
  return source.topic ? items.map(splitPublisher) : items;
}

async function fetchText(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`Could not reach ${new URL(url).host}: ${error.message}`);
  }
  if (!response?.ok) {
    const status = response?.status ?? 'no response';
    // Reddit and Cloudflare answer servers with 403, rate limits with 429.
    const why =
      status === 403 ? ' blocked' : status === 429 ? ' rate limited' : '';
    throw new Error(`${status}${why}`);
  }
  return response.text();
}

/**
 * RSS items or Atom entries as `{ url, title, excerpt, published, author }`.
 * Regex-based like the arXiv reader: feeds are flat and Node has no DOM.
 */
export function parseFeed(xml) {
  const text = String(xml ?? '');
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text))
    throw new Error('Not an RSS or Atom feed.');
  const blocks = [
    ...text.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)
  ].map((match) => match[2]);
  return blocks.flatMap((block) => {
    const url = feedLink(block);
    const title = plainText(tag(block, 'title'));
    if (!url || !title) return [];
    const excerpt = clip(
      plainText(
        tag(block, 'description') ||
          tag(block, 'summary') ||
          tag(block, 'content:encoded') ||
          tag(block, 'content')
      ),
      MAX_EXCERPT_CHARS
    );
    const published = isoDate(
      tag(block, 'pubDate') ||
        tag(block, 'published') ||
        tag(block, 'dc:date') ||
        tag(block, 'updated')
    );
    const author = plainText(
      tag(tag(block, 'author'), 'name') ||
        tag(block, 'dc:creator') ||
        tag(block, 'author')
    );
    return [
      {
        url,
        title,
        ...(excerpt ? { excerpt } : {}),
        ...(published ? { published } : {}),
        ...(author ? { author } : {})
      }
    ];
  });
}

function feedLink(block) {
  // Atom: the alternate link, or the only one.
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map(
    (match) => match[1]
  );
  const alternate =
    links.find((attrs) => /rel=["']alternate["']/i.test(attrs)) ??
    links.find((attrs) => !/rel=/i.test(attrs) && /href=/i.test(attrs));
  const href = alternate && /href=["']([^"']+)["']/i.exec(alternate)?.[1];
  const candidate =
    decodeEntities(href || '') ||
    plainText(tag(block, 'link')) ||
    plainText(tag(block, 'guid'));
  return isWebUrl(candidate) ? candidate : '';
}

// Google News titles end in " - Publisher", which also comes as <source>.
function splitPublisher(item) {
  const match = /^(.*\S)\s+-\s+([^-]+)$/.exec(item.title);
  if (!match) return item;
  const { excerpt: _links, ...rest } = item;
  return { ...rest, title: match[1], publisher: match[2].trim() };
}

export function parseHackerNews(body) {
  const hits = JSON.parse(body)?.hits ?? [];
  return hits.flatMap((hit) => {
    const title = hit.title ?? hit.story_title;
    if (!title) return [];
    const discussion = `https://news.ycombinator.com/item?id=${hit.objectID}`;
    return [
      {
        url: hit.url || discussion,
        title,
        published: isoDate(hit.created_at),
        discussion,
        ...(hit.points != null ? { points: hit.points } : {})
      }
    ];
  });
}

/**
 * A listing page's article links: links on the same host, below the page's
 * own path (`/news/...` under `/news`) or below `links`, whose text is long
 * enough to be a title. One word ("Announcements") is a category, not an
 * article. Titles and dates come from the articles themselves.
 */
export function listingLinks(
  html,
  pageUrl,
  { links: below, limit = MAX_PAGE_LINKS } = {}
) {
  const page = new URL(pageUrl);
  const prefix = (below ?? page.pathname).replace(/\/+$/, '');
  const seen = new Set();
  const links = [];
  for (const match of String(html).matchAll(
    /<a\b[^>]*?href=["']([^"'#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi
  )) {
    let url;
    try {
      url = new URL(decodeEntities(match[1]), page);
    } catch {
      continue;
    }
    const pathname = url.pathname.replace(/\/+$/, '');
    if (
      url.host !== page.host ||
      !pathname.startsWith(`${prefix}/`) ||
      seen.has(url.href)
    )
      continue;
    const title = plainText(match[2]);
    if (title.length < 12 || !/\s/.test(title)) continue;
    seen.add(url.href);
    links.push({ url: url.href, title: clip(title, 300) });
    if (links.length >= limit) break;
  }
  return links;
}

/** An article page's title, summary and publish date, from its meta tags. */
export function articleMeta(html) {
  const head = String(html).slice(0, 300_000);
  const meta = (name) => {
    for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
      const attrs = match[0];
      const key = /(?:property|name|itemprop)=["']([^"']+)["']/i.exec(
        attrs
      )?.[1];
      if (key?.toLowerCase() === name)
        return decodeEntities(
          /content=["']([^"']*)["']/i.exec(attrs)?.[1] ?? ''
        ).trim();
    }
    return '';
  };
  const site = meta('og:site_name');
  let title =
    meta('og:title') ||
    plainText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '');
  // "Post | ARC Prize", and Hugging Face's "Paper page - Title".
  if (site && title.endsWith(` | ${site}`))
    title = title.slice(0, -` | ${site}`.length);
  title = title.replace(/^Paper page - /, '').trim();
  const excerpt = clip(
    meta('og:description') || meta('description'),
    MAX_EXCERPT_CHARS
  );
  const published = isoDate(
    meta('article:published_time') ||
      meta('datepublished') ||
      /"datePublished"\s*:\s*"([^"]+)"/.exec(head)?.[1] ||
      /<time\b[^>]*datetime=["']([^"']+)["']/i.exec(head)?.[1]
  );
  return {
    title,
    ...(excerpt ? { excerpt } : {}),
    ...(published ? { published } : {})
  };
}

/* ---------- Hype, Facts and Signal ---------- */

export const LABEL_BATCH = 60;
export const LABEL_THRESHOLD = 50;

/** Labels known for these urls, as `url → { hype, facts, signal }`. */
export async function readFeedLabels(urls, { cacheDir } = {}) {
  const labels = await loadLabels(cacheDir);
  return Object.fromEntries(
    urls.filter((url) => labels[url]).map((url) => [url, scoresOf(labels[url])])
  );
}

export async function saveFeedLabels(fresh, { cacheDir, now = Date.now } = {}) {
  const labels = await loadLabels(cacheDir);
  const at = now();
  for (const [url, scores] of Object.entries(fresh))
    labels[url] = { ...scores, at };
  const oldest = at - (KEEP_DAYS + 7) * DAY_MS;
  for (const [url, entry] of Object.entries(labels))
    if (!(entry.at >= oldest)) delete labels[url];
  if (cacheDir)
    await writeCacheFile(path.join(cacheDir, 'feeds', 'labels.json'), labels);
}

async function loadLabels(cacheDir) {
  labelCache ??=
    (cacheDir &&
      (await readCacheFile(path.join(cacheDir, 'feeds', 'labels.json')))) ||
    {};
  return labelCache;
}

const scoresOf = ({ hype, facts, signal }) => ({ hype, facts, signal });

export function buildLabelMessages(items) {
  const list = items
    .map((item, index) => {
      const from = item.publisher
        ? `${item.source} / ${item.publisher}`
        : item.source;
      const excerpt = item.excerpt ? ` — ${clip(item.excerpt, 300)}` : '';
      return `${index + 1}. [${from}] ${item.title}${excerpt}`;
    })
    .join('\n');
  return [
    {
      role: 'system',
      content: `You label news items for a researcher who reads AI and science news. Score every item on three independent scales from 0 to 100. Real items mix them: an item can score high on two or all three.

Hype: excitement beyond what is shown. Superlatives, "game changer", AGI talk, predictions, funding rounds and valuations, unverified claims, opinion dressed as news.
Facts: verifiable substance. Release notes, changelogs, benchmark numbers, papers, documentation, open-source code, methodology, reproducible results. A primary source scores higher than a secondhand report of it.
Signal: something a practitioner should know or act on now. A release they can use today, a breaking change or migration, a new API, a pricing change, a deprecation, a security advisory, a practical how-to.

Judge only from the title, source and excerpt given. Answer with a JSON array and nothing else, one object per item, in order: [{"i": 1, "hype": 10, "facts": 80, "signal": 70}, ...]`
    },
    { role: 'user', content: list }
  ];
}

/** The model's scores, kept only for items it was shown, as `url → scores`. */
export function parseFeedLabels(reply, items) {
  const text = String(reply ?? '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  let rows;
  try {
    rows = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
  if (!Array.isArray(rows)) return {};
  const score = (value) =>
    Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const labels = {};
  for (const row of rows) {
    const item = items[Number(row?.i) - 1];
    if (!item) continue;
    labels[item.url] = {
      hype: score(row.hype),
      facts: score(row.facts),
      signal: score(row.signal)
    };
  }
  return labels;
}

/* ---------- helpers ---------- */

function tag(xml, name) {
  const match = new RegExp(
    `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`,
    'i'
  ).exec(xml);
  return match ? match[1] : '';
}

/** Markup to one line of text: CDATA unwrapped, entities decoded, tags dropped. */
export function plainText(value) {
  const unwrapped = String(value ?? '').replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>/g,
    '$1'
  );
  // Feeds often escape their HTML, so tags only appear after one decode.
  return decodeEntities(
    decodeEntities(unwrapped)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“'
};

function decodeEntities(value) {
  return String(value).replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, code) => {
      if (code[0] === '#') {
        const point =
          code[1].toLowerCase() === 'x'
            ? parseInt(code.slice(2), 16)
            : Number(code.slice(1));
        try {
          return String.fromCodePoint(point);
        } catch {
          return match;
        }
      }
      return NAMED[code.toLowerCase()] ?? match;
    }
  );
}

function isoDate(value) {
  const time = Date.parse(String(value ?? '').trim());
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function isWebUrl(value) {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim());
}

function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

async function mapLimit(values, limit, task) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, worker)
  );
  return results;
}

/** Test seam: the module-level caches outlive a single test. */
export function resetFeedsCache() {
  sourceCache.clear();
  inFlight.clear();
  labelCache = null;
}
