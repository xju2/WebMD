import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchXPost, isXPostUrl, parseXOembed, resetXCache } from '../server/x.js';

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
    parseXOembed(oembed('Claude Code now edits &amp; reviews<br>in one pass'), REFERENCE),
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

test('asks oEmbed once per post and caches the answer', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.ok(url.startsWith('https://publish.x.com/oembed?'));
    assert.ok(url.includes(encodeURIComponent(URL_)));
    return { ok: true, status: 200, json: async () => oembed('Ship it') };
  };

  assert.equal((await fetchXPost(URL_, { fetchImpl })).text, 'Ship it');
  assert.equal(
    (await fetchXPost('https://twitter.com/pvncher/status/2095991462416490862?s=46', { fetchImpl }))
      .text,
    'Ship it'
  );
  assert.equal(calls, 1);
});

test('reports a post X will not quote as a 404', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(fetchXPost(URL_, { fetchImpl }), { status: 404 });
});

test('rejects a link that is not an X post', async () => {
  await assert.rejects(fetchXPost('https://x.com/pvncher'), { status: 400 });
});
