import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchXPost,
  isXPostUrl,
  parseSyndicatedPost,
  parseXOembed,
  resetXCache
} from '../server/x.js';

const URL_ = 'https://x.com/pvncher/status/2095991462416490862';
const REFERENCE = { url: URL_, handle: 'pvncher', id: '2095991462416490862' };

function oembed(paragraph) {
  return {
    author_name: 'eric provencher',
    author_url: 'https://x.com/pvncher',
    html:
      `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">${paragraph}</p>` +
      `&mdash; eric provencher (@pvncher) <a href="${URL_}">September 4, 2026</a></blockquote>`
  };
}

test.beforeEach(() => resetXCache());

test('recognises X post links, not profiles or other sites', () => {
  assert.equal(isXPostUrl(URL_), true);
  assert.equal(isXPostUrl('https://twitter.com/pvncher/status/20'), true);
  assert.equal(isXPostUrl('https://x.com/pvncher'), false);
  assert.equal(isXPostUrl(undefined), false);
});

test('quotes the post and names the account that wrote it', () => {
  assert.deepEqual(
    parseXOembed(
      oembed('Claude Code now edits &amp; reviews<br>in one pass'),
      REFERENCE
    ),
    {
      url: URL_,
      author: 'eric provencher',
      handle: 'pvncher',
      text: 'Claude Code now edits & reviews in one pass'
    }
  );
});

test('leaves no text for a post that is only a t.co link', () => {
  const parsed = parseXOembed(
    oembed('<a href="https://t.co/iDl6I25AQu">https://t.co/iDl6I25AQu</a>'),
    REFERENCE
  );
  assert.equal(parsed.text, '');
  assert.equal(parsed.author, 'eric provencher');
});

test('names an X Article after the article, not its bare link', () => {
  assert.deepEqual(
    parseSyndicatedPost(
      {
        text: 'https://t.co/iDl6I25AQu',
        user: { name: 'eric provencher', screen_name: 'pvncher' },
        article: { title: 'Rethinking skills and prompts' }
      },
      REFERENCE
    ),
    {
      url: URL_,
      author: 'eric provencher',
      handle: 'pvncher',
      text: 'Rethinking skills and prompts'
    }
  );
});

test('quotes a syndicated post, dropping its t.co media link', () => {
  const parsed = parseSyndicatedPost(
    {
      text: 'Ship it https://t.co/iDl6I25AQu',
      user: { name: 'eric provencher', screen_name: 'pvncher' }
    },
    REFERENCE
  );
  assert.equal(parsed.text, 'Ship it');

  // Nothing names the account: the answer is no use, so oEmbed gets a turn.
  assert.equal(parseSyndicatedPost({ text: 'Ship it' }, REFERENCE), null);
});

test('falls back to oEmbed when syndication will not answer', async () => {
  const asked = [];
  const fetchImpl = async (target) => {
    asked.push(target);
    if (target.startsWith('https://cdn.syndication.twimg.com/')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => oembed('Ship it') };
  };

  assert.equal((await fetchXPost(URL_, { fetchImpl })).text, 'Ship it');
  assert.equal(asked.length, 2);
  assert.ok(asked[1].startsWith('https://publish.x.com/oembed?'));
  assert.ok(asked[1].includes(encodeURIComponent(URL_)));
});

test('asks X once per post and caches the answer', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.ok(
      url.startsWith('https://cdn.syndication.twimg.com/tweet-result?')
    );
    assert.ok(url.includes(`id=${REFERENCE.id}`));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        text: 'Ship it',
        user: { name: 'eric provencher', screen_name: 'pvncher' }
      })
    };
  };

  assert.equal((await fetchXPost(URL_, { fetchImpl })).text, 'Ship it');
  assert.equal(
    (
      await fetchXPost(
        'https://twitter.com/pvncher/status/2095991462416490862?s=46',
        { fetchImpl }
      )
    ).text,
    'Ship it'
  );
  assert.equal(calls, 1);
});

test('reports a post neither endpoint will hand over as a 404', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    json: async () => ({})
  });
  await assert.rejects(fetchXPost(URL_, { fetchImpl }), { status: 404 });
});

test('rejects a link that is not an X post', async () => {
  await assert.rejects(fetchXPost('https://x.com/pvncher'), { status: 400 });
});
