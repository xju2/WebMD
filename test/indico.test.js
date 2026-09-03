import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchIndicoTitle,
  isIndicoUrl,
  parseIndicoPage,
  resetIndicoCache
} from '../server/indico.js';

const EVENT = 'Conference on Computing in High Energy &amp; Nuclear Physics';
const EVENT_TEXT = 'Conference on Computing in High Energy & Nuclear Physics';

function page(heading) {
  return `<html><head>
    <title>${heading} · Indico</title>
    <meta property="og:title" content="${EVENT}">
  </head><body></body></html>`;
}

test.beforeEach(() => resetIndicoCache());

test('recognises Indico event, contribution and session links', () => {
  assert.equal(isIndicoUrl('https://indico.cern.ch/event/1338689/'), true);
  assert.equal(
    isIndicoUrl('https://indico.cern.ch/event/1338689/contributions/6081535/'),
    true
  );
  assert.equal(
    isIndicoUrl('https://indico.fnal.gov/event/12/sessions/3/'),
    true
  );
  assert.equal(
    isIndicoUrl('https://indico.cern.ch/event/1338689/timetable/'),
    false
  );
  assert.equal(isIndicoUrl('https://example.com/event/1/'), false);
  assert.equal(isIndicoUrl(undefined), false);
});

test('names an event after its own title', () => {
  const parsed = parseIndicoPage(
    page(`${EVENT} (19-25 October 2024): General`),
    'https://indico.cern.ch/event/1338689/'
  );
  assert.deepEqual(parsed, {
    url: 'https://indico.cern.ch/event/1338689/',
    title: EVENT_TEXT,
    event: EVENT_TEXT
  });
});

test('names a contribution after the talk, keeping its meeting', () => {
  const url = 'https://indico.cern.ch/event/1338689/contributions/6081535/';
  assert.deepEqual(
    parseIndicoPage(page(`${EVENT} (19-25 October 2024): Welcome`), url),
    {
      url,
      title: 'Welcome',
      event: EVENT_TEXT
    }
  );
});

test('falls back to the event when the heading says nothing else', () => {
  const url = 'https://indico.cern.ch/event/1338689/contributions/6081535/';
  assert.equal(parseIndicoPage(page(EVENT), url).title, EVENT_TEXT);
});

test('reports a page that needs a login instead of guessing', () => {
  assert.throws(
    () =>
      parseIndicoPage(
        '<html><head><title>Sign in to CERN</title></head></html>',
        'https://indico.cern.ch/event/1/'
      ),
    /may need a login/
  );
});

test('fetches the canonical page once and caches the answer', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return new Response(page(`${EVENT} (1 May 2026): Tracking`), {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  };

  const url = 'https://indico.cern.ch/event/9/contributions/8';
  const first = await fetchIndicoTitle(url, { fetchImpl });
  const second = await fetchIndicoTitle(`  ${url}/  `, { fetchImpl });

  assert.equal(first.title, 'Tracking');
  assert.deepEqual(second, first);
  assert.deepEqual(requested, [
    'https://indico.cern.ch/event/9/contributions/8/'
  ]);
});

test('rejects a link that is not an Indico page', async () => {
  await assert.rejects(
    () =>
      fetchIndicoTitle('https://example.com/event/1/', {
        fetchImpl: async () => {
          throw new Error('should not be called');
        }
      }),
    /is not an Indico link/
  );
});
