import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  articleMeta,
  DEFAULT_FEED_SOURCES,
  fetchFeeds,
  listingLinks,
  mergeItems,
  parseFeedLabels,
  parseFeed,
  parseHackerNews,
  readFeedsConfig,
  resetFeedsCache,
  topicSources
} from '../server/feeds.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
  <title>A blog</title>
  <item>
    <title><![CDATA[Claude Code 3.0 &amp; friends]]></title>
    <link>https://example.com/post-1</link>
    <description>&lt;p&gt;New &lt;b&gt;hooks&lt;/b&gt; API&lt;/p&gt;</description>
    <pubDate>Mon, 02 Nov 2026 09:00:00 GMT</pubDate>
    <dc:creator>Ada</dc:creator>
  </item>
  <item><title>No link</title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title type="html">v2.1.0</title>
    <link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v2.1.0"/>
    <updated>2026-11-01T10:00:00Z</updated>
    <author><name>bot</name></author>
    <content type="html">&lt;ul&gt;&lt;li&gt;Fix&lt;/li&gt;&lt;/ul&gt;</content>
  </entry>
</feed>`;

test('parseFeed reads RSS items and Atom entries', () => {
  assert.deepEqual(parseFeed(RSS), [
    {
      url: 'https://example.com/post-1',
      title: 'Claude Code 3.0 & friends',
      excerpt: 'New hooks API',
      published: '2026-11-02T09:00:00.000Z',
      author: 'Ada'
    }
  ]);
  assert.deepEqual(parseFeed(ATOM), [
    {
      url: 'https://github.com/o/r/releases/tag/v2.1.0',
      title: 'v2.1.0',
      excerpt: 'Fix',
      published: '2026-11-01T10:00:00.000Z',
      author: 'bot'
    }
  ]);
  assert.throws(() => parseFeed('<html></html>'), /Not an RSS or Atom feed/);
});

test('listingLinks keeps article links below the page and articleMeta dates them', () => {
  const html = `
    <a href="/news">News</a>
    <a href="/news/claude-5-launch">Announcements <span>Nov 2, 2026</span> Introducing Claude 5</a>
    <a href="/news/claude-5-launch#top">Introducing Claude 5 again</a>
    <a href="/careers/apply-now-please">Careers at the company</a>
    <a href="https://other.com/news/x-y-z-long-title">Elsewhere long title</a>
    <a href="/news/short">Short</a>`;
  assert.deepEqual(listingLinks(html, 'https://www.anthropic.com/news'), [
    {
      url: 'https://www.anthropic.com/news/claude-5-launch',
      title: 'Announcements Nov 2, 2026 Introducing Claude 5'
    }
  ]);
  assert.deepEqual(
    listingLinks(
      '<a href="/research/managed-agents">Scaling Managed Agents</a><a href="/engineering/x">Not this one here</a>',
      'https://www.anthropic.com/engineering',
      { links: '/research/' }
    ).map((link) => link.url),
    ['https://www.anthropic.com/research/managed-agents']
  );
  assert.equal(
    articleMeta(
      '<meta property="og:title" content="Astra on ARC-AGI-3 | ARC Prize"/><meta property="og:site_name" content="ARC Prize"/>'
    ).title,
    'Astra on ARC-AGI-3'
  );
  assert.deepEqual(
    articleMeta(`<head><title>ignored</title>
      <meta property="og:title" content="Introducing Claude 5">
      <meta name="description" content="Our newest model &amp; more.">
      <script type="application/ld+json">{"datePublished":"2026-11-02T16:00:00Z"}</script></head>`),
    {
      title: 'Introducing Claude 5',
      excerpt: 'Our newest model & more.',
      published: '2026-11-02T16:00:00.000Z'
    }
  );
});

test('parseHackerNews falls back to the discussion for Ask HN', () => {
  const items = parseHackerNews(
    JSON.stringify({
      hits: [
        {
          objectID: '1',
          title: 'Ask HN: x?',
          created_at: '2026-11-03T08:00:00Z',
          points: 40
        },
        {
          objectID: '2',
          title: 'Show',
          url: 'https://a.dev',
          created_at: '2026-11-03T09:00:00Z'
        }
      ]
    })
  );
  assert.equal(items[0].url, 'https://news.ycombinator.com/item?id=1');
  assert.equal(items[1].url, 'https://a.dev');
  assert.equal(items[1].discussion, 'https://news.ycombinator.com/item?id=2');
});

test('mergeItems keeps first-seen times and drops what is past a month', () => {
  const earlier = [
    { url: 'a', title: 'A', firstSeen: '2026-11-01T00:00:00.000Z' },
    { url: 'old', title: 'Old', published: '2026-09-01T00:00:00.000Z' }
  ];
  const merged = mergeItems(
    earlier,
    [
      { url: 'a', title: 'A2' },
      { url: 'b', title: 'B' }
    ],
    NOW
  );
  assert.deepEqual(
    merged.map((item) => [item.url, item.title, item.firstSeen]),
    [
      ['a', 'A2', '2026-11-01T00:00:00.000Z'],
      ['b', 'B', '2026-11-03T12:00:00.000Z']
    ]
  );
});

test('fetchFeeds merges sources and topics, dedupes, and keeps a failing source', async () => {
  resetFeedsCache();
  const cacheDir = await fs.mkdtemp(path.join(tmpdir(), 'webmd-feeds-'));
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('reddit')) return { ok: false, status: 403 };
    if (url.includes('news.google.com'))
      return {
        ok: true,
        text: async () =>
          RSS.replace(
            'Claude Code 3.0 &amp; friends',
            'Agents for science - Nature'
          ).replace('https://example.com/post-1', 'https://news.google.com/a1')
      };
    return { ok: true, text: async () => RSS };
  };
  const config = {
    sources: [
      { kind: 'feed', name: 'Blog', url: 'https://example.com/feed' },
      { kind: 'feed', name: 'Same post', url: 'https://mirror.com/feed' },
      { kind: 'feed', name: 'r/x', url: 'https://www.reddit.com/r/x/.rss' }
    ],
    topics: ['agents for science']
  };
  const result = await fetchFeeds(config, {
    fetchImpl,
    cacheDir,
    now: () => NOW
  });
  assert.deepEqual(
    result.items.map((item) => [item.source, item.title, item.publisher]),
    [
      ['Blog', 'Claude Code 3.0 & friends', undefined],
      ['Google News: agents for science', 'Agents for science', 'Nature']
    ]
  );
  assert.equal(result.sources[2].error, '403 blocked');
  assert.match(seen.at(-1), /q=agents%20for%20science%20when%3A7d/);

  // Within 15 minutes nothing is asked again, even after a restart.
  resetFeedsCache();
  seen.length = 0;
  await fetchFeeds(config, { fetchImpl, cacheDir, now: () => NOW + 60_000 });
  assert.equal(seen.length, 0);
});

test('readFeedsConfig falls back to the defaults and skips bad sources', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'webmd-feeds-config-'));
  const workspace = {
    resolvePath: async (relative) => path.join(dir, relative)
  };
  assert.equal(
    (await readFeedsConfig(workspace)).sources,
    DEFAULT_FEED_SOURCES
  );

  await fs.mkdir(path.join(dir, '.webmd'));
  await fs.writeFile(
    path.join(dir, '.webmd/feeds.json'),
    JSON.stringify({
      topics: ['LLM inference HPC', ''],
      sources: [
        { name: 'Blog', url: 'https://example.com/feed' },
        { kind: 'feed', name: 'Bad', url: 'file:///etc/passwd' },
        { kind: 'hn', name: 'HN' }
      ]
    })
  );
  const config = await readFeedsConfig(workspace);
  assert.deepEqual(config.topics, ['LLM inference HPC']);
  assert.deepEqual(config.sources, [
    { kind: 'feed', name: 'Blog', url: 'https://example.com/feed' },
    { kind: 'hn', name: 'HN' }
  ]);
  assert.match(config.warning, /Skipped source/);
  assert.equal(topicSources(['x']).length, 1);
});

test('parseFeedLabels keeps scores only for items it was shown', () => {
  const items = [{ url: 'a' }, { url: 'b' }];
  assert.deepEqual(
    parseFeedLabels(
      'Here:\n[{"i":1,"hype":10,"facts":90.4,"signal":150},{"i":7,"hype":1}]',
      items
    ),
    { a: { hype: 10, facts: 90, signal: 100 } }
  );
  assert.deepEqual(parseFeedLabels('no json', items), {});
});

test('undated links on a page’s first visit are a baseline, later ones are new', async () => {
  resetFeedsCache();
  let html = '<a href="/blog/first-post-here">The first post here</a>';
  const fetchImpl = async (url) => ({
    ok: true,
    text: async () => (url.endsWith('/blog') ? html : '<title>Post</title>')
  });
  const config = {
    sources: [{ kind: 'page', name: 'Blog', url: 'https://arc.example/blog' }]
  };
  const first = await fetchFeeds(config, { fetchImpl, now: () => NOW });
  assert.equal(first.items.length, 0);

  html += '<a href="/blog/second-post-here">The second post here</a>';
  const later = await fetchFeeds(config, {
    fetchImpl,
    now: () => NOW + 20 * 60_000
  });
  assert.deepEqual(
    later.items.map((item) => item.url),
    ['https://arc.example/blog/second-post-here']
  );
});
