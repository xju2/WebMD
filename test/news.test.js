import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_NEWS_CATEGORIES,
  fetchArxivNews,
  newsCategories,
  parseArxivRss,
  resetNewsCache
} from '../server/news.js';
import {
  filterPapers,
  linkedArxivIds,
  newsCategoryCounts,
  newsClipChange,
  newsSegments,
  shortAuthorList
} from '../src/news.js';

const RSS = `<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>hep-ex, cs.LG updates on arXiv.org</title>
    <pubDate>Thu, 10 Sep 2026 00:00:00 -0400</pubDate>
    <item>
      <title>Tracking at the HL-LHC with $\\mathcal{O}(n)$ graphs</title>
      <link>https://arxiv.org/abs/2609.09159</link>
      <description>arXiv:2609.09159v1 Announce Type: new
Abstract: We show $d &lt; 2$ tracking &amp; more.</description>
      <guid isPermaLink="false">oai:arXiv.org:2609.09159v1</guid>
      <category>hep-ex</category>
      <category>cs.LG</category>
      <pubDate>Thu, 10 Sep 2026 00:00:00 -0400</pubDate>
      <arxiv:announce_type>new</arxiv:announce_type>
      <dc:creator>Xiangyang Ju, Daniel Murnane</dc:creator>
    </item>
    <item>
      <title>An older paper, revised</title>
      <link>https://arxiv.org/abs/2501.00001</link>
      <description>arXiv:2501.00001v3 Announce Type: replace
Abstract: Revised.</description>
      <guid isPermaLink="false">oai:arXiv.org:2501.00001v3</guid>
      <category>cs.LG</category>
      <arxiv:announce_type>replace</arxiv:announce_type>
      <dc:creator>A. Person</dc:creator>
    </item>
  </channel>
</rss>`;

test.beforeEach(() => resetNewsCache());

test('reads papers out of the arXiv RSS listing', () => {
  const { published, papers } = parseArxivRss(RSS);
  assert.equal(published, 'Thu, 10 Sep 2026 00:00:00 -0400');
  assert.equal(papers.length, 2);
  assert.deepEqual(papers[0], {
    id: '2609.09159',
    title: 'Tracking at the HL-LHC with $\\mathcal{O}(n)$ graphs',
    authors: ['Xiangyang Ju', 'Daniel Murnane'],
    abstract: 'We show $d < 2$ tracking & more.',
    categories: ['hep-ex', 'cs.LG'],
    announceType: 'new',
    url: 'https://arxiv.org/abs/2609.09159'
  });
  assert.equal(papers[1].id, '2501.00001');
  assert.equal(papers[1].announceType, 'replace');
});

test('rejects a reply that is not an RSS feed', () => {
  assert.throws(() => parseArxivRss('<html>down</html>'), /RSS/);
});

test('categories come from the environment, with sane defaults', () => {
  assert.deepEqual(newsCategories({}), DEFAULT_NEWS_CATEGORIES);
  assert.deepEqual(
    newsCategories({ ARXIV_NEWS_CATEGORIES: 'hep-ex, cs.LG,,hep-ex, bad cat' }),
    ['hep-ex', 'cs.LG']
  );
});

test('caches the listing and falls back to it when arXiv is down', async () => {
  let calls = 0;
  let clock = 0;
  const now = () => clock;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.equal(url, 'https://rss.arxiv.org/rss/hep-ex+cs.LG');
    if (calls > 1) throw new Error('offline');
    return new Response(RSS, { status: 200 });
  };
  const categories = ['hep-ex', 'cs.LG'];

  const first = await fetchArxivNews(categories, { fetchImpl, now });
  assert.equal(first.papers.length, 2);

  clock = 10 * 60 * 1000;
  await fetchArxivNews(categories, { fetchImpl, now });
  assert.equal(calls, 1, 'a fresh listing is served from the cache');

  const refreshed = await fetchArxivNews(categories, {
    fetchImpl,
    now,
    refresh: true
  });
  assert.equal(calls, 2);
  assert.equal(refreshed.papers.length, 2);
  assert.match(refreshed.warning, /offline/);
});

test('keeps the listing on disk and revalidates it by ETag', async () => {
  const cacheDir = await fs.mkdtemp(path.join(tmpdir(), 'webmd-cache-'));
  const requests = [];
  let clock = 0;
  const now = () => clock;
  const fetchImpl = async (_url, options) => {
    requests.push(options?.headers?.['If-None-Match'] ?? null);
    const headers = {
      etag: '"v1"',
      'cache-control': 'max-age=3600',
      age: '600'
    };
    return requests.length === 1
      ? new Response(RSS, { status: 200, headers })
      : new Response(null, { status: 304, headers });
  };
  const categories = ['hep-ex', 'cs.LG'];

  const first = await fetchArxivNews(categories, { fetchImpl, now, cacheDir });
  assert.equal(first.papers.length, 2);

  resetNewsCache(); // a server restart
  clock = 40 * 60 * 1000;
  const restarted = await fetchArxivNews(categories, {
    fetchImpl,
    now,
    cacheDir
  });
  assert.equal(requests.length, 1, 'fresh per max-age less age, from disk');
  assert.deepEqual(restarted, first);

  clock = 51 * 60 * 1000;
  const revalidated = await fetchArxivNews(categories, {
    fetchImpl,
    now,
    cacheDir
  });
  assert.deepEqual(requests, [null, '"v1"']);
  assert.deepEqual(revalidated, first, 'a 304 keeps the saved papers');
});

test('clips into an existing Reading section', () => {
  const content = '# Today\n\n## Reading\n\n- first\n\n## Log\n\nwrote\n';
  const change = newsClipChange(content, 'second');
  const next =
    content.slice(0, change.from) + change.insert + content.slice(change.to);
  assert.equal(
    next,
    '# Today\n\n## Reading\n\n- first\n- second\n\n## Log\n\nwrote\n'
  );
});

test('adds a Reading section at the end when there is none', () => {
  const apply = (content) => {
    const change = newsClipChange(content, 'paper');
    return (
      content.slice(0, change.from) + change.insert + content.slice(change.to)
    );
  };
  assert.equal(
    apply('# Today\n\nnotes\n\n'),
    '# Today\n\nnotes\n\n## Reading\n\n- paper\n'
  );
  assert.equal(apply(''), '## Reading\n\n- paper\n');
  assert.equal(apply('## Reading'), '## Reading\n\n- paper\n');
});

test('finds the arXiv papers a note already links to', () => {
  const ids = linkedArxivIds(
    'Ju et al., "T" — [arXiv:2609.09159](https://arxiv.org/abs/2609.09159)\nhttps://arxiv.org/pdf/hep-ph/0601001'
  );
  assert.deepEqual([...ids], ['2609.09159', 'hep-ph/0601001']);
});

test('filters by words, categories, and replacements', () => {
  const { papers } = parseArxivRss(RSS);
  assert.deepEqual(
    filterPapers(papers).map((paper) => paper.id),
    ['2609.09159']
  );
  assert.equal(filterPapers(papers, { includeReplacements: true }).length, 2);
  assert.equal(filterPapers(papers, { query: 'murnane TRACKING' }).length, 1);
  assert.equal(filterPapers(papers, { query: 'nothing' }).length, 0);
  assert.equal(
    filterPapers(papers, { categories: ['cs.LG'], includeReplacements: true })
      .length,
    2
  );
  assert.deepEqual(
    [...newsCategoryCounts(papers, ['hep-ex', 'cs.LG'])],
    [
      ['hep-ex', 1],
      ['cs.LG', 1]
    ]
  );
});

test('renders math and links in arXiv text, and nothing else', () => {
  assert.deepEqual(newsSegments('Mass $m_H$ at https://x.org/a. #1 *not em*'), [
    { type: 'text', text: 'Mass ' },
    { type: 'math', text: 'm_H' },
    { type: 'text', text: ' at ' },
    { type: 'link', text: 'https://x.org/a', href: 'https://x.org/a' },
    { type: 'text', text: '. #1 *not em*' }
  ]);
  assert.deepEqual(newsSegments('See https://x.org', { links: false }), [
    { type: 'text', text: 'See https://x.org' }
  ]);
});

test('shortens long author lists', () => {
  assert.equal(shortAuthorList(['A', 'B']), 'A, B');
  assert.equal(shortAuthorList(['A', 'B', 'C', 'D']), 'A, B, C et al.');
});
