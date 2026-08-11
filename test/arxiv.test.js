import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchArxivMetadata,
  isArxivId,
  parseArxivEntry,
  resetArxivCache
} from '../server/arxiv.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2608.00146v1</id>
    <title>Performance of a Geometric Deep Learning Pipeline
  for HL-LHC Particle Tracking</title>
    <author><name>Xiangyang Ju</name></author>
    <author><name>Daniel Murnane</name></author>
  </entry>
</feed>`;

const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>ArXiv Query</title></feed>`;

function feedResponse(body = FEED) {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/atom+xml' }
  });
}

test.beforeEach(() => resetArxivCache());

test('recognises arXiv identifiers', () => {
  assert.equal(isArxivId('2608.00146'), true);
  assert.equal(isArxivId('2608.00146v2'), true);
  assert.equal(isArxivId('hep-th/9901001'), true);
  assert.equal(isArxivId('math.GT/0309136'), true);
  assert.equal(isArxivId('not-an-id'), false);
  assert.equal(isArxivId('2608.00146; rm -rf /'), false);
  assert.equal(isArxivId(undefined), false);
});

test('pulls title and authors out of the Atom feed', () => {
  assert.deepEqual(parseArxivEntry(FEED, '2608.00146'), {
    id: '2608.00146',
    title:
      'Performance of a Geometric Deep Learning Pipeline for HL-LHC Particle Tracking',
    authors: ['Xiangyang Ju', 'Daniel Murnane']
  });
});

test('decodes XML entities in titles', () => {
  const feed = FEED.replace(
    /<title>[\s\S]*?<\/title>/,
    '<title>Higgs &amp; Top: p &lt; 0.05 &quot;evidence&quot;</title>'
  );
  assert.equal(
    parseArxivEntry(feed, '2608.00146').title,
    'Higgs & Top: p < 0.05 "evidence"'
  );
});

test('requests the identifier and returns its metadata', async () => {
  const urls = [];
  const metadata = await fetchArxivMetadata('2608.00146', {
    fetchImpl: async (url) => {
      urls.push(url);
      return feedResponse();
    }
  });

  assert.equal(urls.length, 1);
  assert.match(urls[0], /id_list=2608\.00146/);
  assert.equal(metadata.authors[0], 'Xiangyang Ju');
});

test('serves a repeated lookup from cache', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return feedResponse();
  };

  await fetchArxivMetadata('2608.00146', { fetchImpl });
  const second = await fetchArxivMetadata('2608.00146', { fetchImpl });

  assert.equal(calls, 1);
  assert.equal(second.title.startsWith('Performance'), true);
});

test('shares one request between concurrent lookups', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return feedResponse();
  };

  await Promise.all([
    fetchArxivMetadata('2608.00146', { fetchImpl }),
    fetchArxivMetadata('2608.00146', { fetchImpl })
  ]);

  assert.equal(calls, 1);
});

test('rejects an identifier that is not an arXiv id', async () => {
  await assert.rejects(
    fetchArxivMetadata('../../etc/passwd', { fetchImpl: async () => feedResponse() }),
    /not an arXiv identifier/
  );
});

test('reports an unknown identifier as not found', async () => {
  await assert.rejects(
    fetchArxivMetadata('2608.00146', {
      fetchImpl: async () => feedResponse(EMPTY_FEED)
    }),
    /no entry for 2608\.00146/
  );
});

test('wraps a transport failure', async () => {
  await assert.rejects(
    fetchArxivMetadata('2608.00146', {
      fetchImpl: async () => {
        throw new Error('fetch failed');
      }
    }),
    /Could not reach arXiv: fetch failed/
  );
});

test('reports an arXiv error status', async () => {
  await assert.rejects(
    fetchArxivMetadata('2608.00146', {
      fetchImpl: async () => new Response('slow down', { status: 429 })
    }),
    /arXiv failed with 429.*Rate limited/s
  );
});

// Slow by design: the retry is a second distinct request, so it waits out the
// rate-limit gap.
test('does not cache a failed lookup', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error('fetch failed');
    return feedResponse();
  };

  await assert.rejects(fetchArxivMetadata('2608.00146', { fetchImpl }));
  const metadata = await fetchArxivMetadata('2608.00146', { fetchImpl });

  assert.equal(calls, 2);
  assert.equal(metadata.id, '2608.00146');
});
