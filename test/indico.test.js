import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkIndicoAddress,
  fetchIndicoTitle,
  indicoFetch,
  indicoSites,
  isIndicoUrl,
  parseIndicoPage,
  resetIndicoCache,
  tokenForOrigin
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

const LOGIN = '<html><head><title>Sign in to CERN</title></head></html>';

function html(body) {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html' }
  });
}

const CERN = 'https://indico.cern.ch';
const cernSites = (token = 'abc123') => indicoSites({ INDICO_CERN_TOKEN: token });

test('binds each token to one exact origin', () => {
  const sites = indicoSites({
    INDICO_CERN_TOKEN: 'abc',
    INDICO_FNAL_TOKEN: ' def ',
    INDICO_DESY_TOKEN: 'ghi',
    INDICO_DESY_URL: 'https://indico.desy.de/some/path',
    INDICO_ORPHAN_TOKEN: 'no-url-so-dropped',
    INDICO_PLAIN_TOKEN: 'x',
    INDICO_PLAIN_URL: 'http://indico.plain.org',
    OPENAI_API_KEY: 'unrelated'
  });

  assert.equal(tokenForOrigin(CERN, sites), 'abc');
  assert.equal(tokenForOrigin('https://indico.fnal.gov', sites), 'def');
  assert.equal(tokenForOrigin('https://indico.desy.de', sites), 'ghi');
  assert.equal(tokenForOrigin('https://indico.global', sites), '');
  // Only an https base URL can carry a token; the orphan has nowhere to go.
  assert.equal(tokenForOrigin('http://indico.plain.org', sites), '');
  assert.ok(
    ![...sites.values()].some((site) => site.token === 'no-url-so-dropped')
  );
});

test('never hands the CERN token to a lookalike host', () => {
  const sites = cernSites();
  for (const origin of [
    'https://indico.cern.example',
    'https://indico.cern.ch.evil.org',
    'http://indico.cern.ch',
    'https://indico.cern.ch:8443',
    'https://evil.indico.cern.ch'
  ]) {
    assert.equal(tokenForOrigin(origin, sites), '', origin);
  }
});

test('accepts only plain https Indico addresses', () => {
  const sites = cernSites();
  assert.equal(
    checkIndicoAddress('https://indico.cern.ch/category/1/', sites).origin,
    CERN
  );
  assert.throws(
    () => checkIndicoAddress('http://indico.cern.ch/event/1/', sites),
    /https/
  );
  assert.throws(
    () => checkIndicoAddress('ftp://indico.cern.ch/event/1/', sites),
    /Only https/
  );
  assert.throws(
    () => checkIndicoAddress('https://me:pw@indico.cern.ch/event/1/', sites),
    /user name or password/
  );
  assert.throws(
    () => checkIndicoAddress('https://indico.cern.ch:8443/event/1/', sites),
    /port/
  );
  assert.throws(
    () => checkIndicoAddress('https://example.com/event/1/', sites),
    /not a known Indico/
  );
  assert.throws(() => checkIndicoAddress('not a url', sites), /not a URL/);
});

test('sends the token only to the Indico it was configured for', async () => {
  const seen = [];
  const fetchImpl = async (target, options) => {
    seen.push([target, options?.headers?.Authorization]);
    return html(page(`${EVENT} (1 May 2026): Tracking`));
  };
  const sites = cernSites();

  await fetchIndicoTitle('https://indico.cern.ch/event/1/', {
    fetchImpl,
    sites
  });
  await fetchIndicoTitle('https://indico.fnal.gov/event/2/', {
    fetchImpl,
    sites
  });
  // The old rule read "cern" out of the second label and sent the token here.
  await fetchIndicoTitle('https://indico.cern.example/event/3/', {
    fetchImpl,
    sites
  });

  assert.deepEqual(seen, [
    ['https://indico.cern.ch/event/1/', 'Bearer abc123'],
    ['https://indico.fnal.gov/event/2/', undefined],
    ['https://indico.cern.example/event/3/', undefined]
  ]);
});

test('follows a same-origin redirect with the token, and no other', async () => {
  const seen = [];
  const redirectTo = (location) =>
    new Response('', { status: 302, headers: { Location: location } });
  const responses = {
    'https://indico.cern.ch/export/a.json': redirectTo('/export/b.json'),
    'https://indico.cern.ch/export/b.json': new Response('{}', { status: 200 }),
    'https://indico.cern.ch/export/c.json': redirectTo(
      'https://attacker.example/steal'
    ),
    'https://indico.cern.ch/export/d.json': redirectTo(
      'http://indico.cern.ch/export/b.json'
    )
  };
  const fetchImpl = async (target, options) => {
    seen.push([target, options?.headers?.Authorization, options?.redirect]);
    return responses[target];
  };
  const options = { fetchImpl, sites: cernSites(), token: 'abc123' };

  const ok = await indicoFetch('https://indico.cern.ch/export/a.json', options);
  assert.equal(ok.status, 200);
  await assert.rejects(
    () => indicoFetch('https://indico.cern.ch/export/c.json', options),
    (error) => error.kind === 'redirect' && /attacker\.example/.test(error.message)
  );
  // A downgrade to http is another origin too.
  await assert.rejects(
    () => indicoFetch('https://indico.cern.ch/export/d.json', options),
    (error) => error.kind === 'redirect'
  );

  assert.deepEqual(seen, [
    ['https://indico.cern.ch/export/a.json', 'Bearer abc123', 'manual'],
    ['https://indico.cern.ch/export/b.json', 'Bearer abc123', 'manual'],
    ['https://indico.cern.ch/export/c.json', 'Bearer abc123', 'manual'],
    ['https://indico.cern.ch/export/d.json', 'Bearer abc123', 'manual']
  ]);
  assert.ok(!seen.some(([target]) => !target.startsWith(CERN)));
});

test('tells a rejected token apart from a missing one, without echoing it', async () => {
  const invalid = async () =>
    new Response('<h1>Bad Request</h1>invalid_token: The access token provided is expired', {
      status: 400
    });
  await assert.rejects(
    () =>
      indicoFetch('https://indico.cern.ch/export/categ/1.json', {
        fetchImpl: invalid,
        sites: cernSites('indp_secret_value'),
        token: 'indp_secret_value'
      }),
    (error) =>
      error.kind === 'auth' &&
      /INDICO_CERN_TOKEN/.test(error.message) &&
      !error.message.includes('indp_secret_value')
  );
  await assert.rejects(
    () =>
      indicoFetch('https://indico.cern.ch/export/categ/1.json', {
        fetchImpl: async () => new Response('{"message":"Not authenticated"}', { status: 403 }),
        sites: indicoSites({})
      }),
    (error) => error.kind === 'config' && /Set INDICO_CERN_TOKEN/.test(error.message)
  );
});

test('gives up on an Indico that does not answer', async () => {
  const hang = (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason))
    );
  await assert.rejects(
    () =>
      indicoFetch('https://indico.cern.ch/export/categ/1.json', {
        fetchImpl: hang,
        timeoutMs: 20
      }),
    (error) => error.kind === 'timeout' && error.status === 504
  );
  await assert.rejects(
    () =>
      indicoFetch('https://indico.cern.ch/export/categ/1.json', {
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        }
      }),
    (error) => error.kind === 'network'
  );
});

test('falls back to the export API for a page the token opens', async () => {
  const requested = [];
  const fetchImpl = async (target) => {
    requested.push(target);
    if (target.includes('/export/')) {
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'ATLAS Weekly',
              contributions: [
                {
                  url: 'https://indico.cern.ch/event/7/contributions/55/',
                  title: 'Tracking status'
                }
              ]
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return html(LOGIN);
  };

  const metadata = await fetchIndicoTitle(
    'https://indico.cern.ch/event/7/contributions/55/',
    { fetchImpl, sites: cernSites() }
  );

  assert.deepEqual(metadata, {
    url: 'https://indico.cern.ch/event/7/contributions/55/',
    title: 'Tracking status',
    event: 'ATLAS Weekly'
  });
  assert.deepEqual(requested, [
    'https://indico.cern.ch/event/7/contributions/55/',
    'https://indico.cern.ch/export/event/7.json?detail=contributions&occ=no'
  ]);
});

test('says so when Indico refuses the token', async () => {
  await assert.rejects(
    () =>
      fetchIndicoTitle('https://indico.cern.ch/event/3/', {
        // Both the page and the export fallback turn it away.
        fetchImpl: async () => new Response('no', { status: 403 }),
        sites: cernSites('stale')
      }),
    /INDICO_CERN_TOKEN/
  );
});

test('falls back to the export API when a legacy-scoped token cannot open the page', async () => {
  const requested = [];
  const metadata = await fetchIndicoTitle('https://indico.cern.ch/event/8/', {
    fetchImpl: async (target) => {
      requested.push(target);
      if (target.includes('/export/')) {
        return new Response(JSON.stringify({ results: [{ title: 'Protected meeting' }] }), {
          status: 200
        });
      }
      // What a token without read:everything gets from an HTML view.
      return new Response('insufficient_scope', { status: 403 });
    },
    sites: cernSites()
  });
  assert.equal(metadata.title, 'Protected meeting');
  assert.deepEqual(requested, [
    'https://indico.cern.ch/event/8/',
    'https://indico.cern.ch/export/event/8.json'
  ]);
});

test('reads a sign-on redirect without a token as a page that needs a login', async () => {
  await assert.rejects(
    () =>
      fetchIndicoTitle('https://indico.cern.ch/event/9/', {
        fetchImpl: async () =>
          new Response('', {
            status: 302,
            headers: { Location: 'https://auth.cern.ch/login' }
          })
      }),
    (error) => error.status === 404 && /may need a login/.test(error.message)
  );
});

test('keeps the placeholder when there is no token to try', async () => {
  const requested = [];
  await assert.rejects(
    () =>
      fetchIndicoTitle('https://indico.cern.ch/event/4/', {
        fetchImpl: async (target) => {
          requested.push(target);
          return html(LOGIN);
        }
      }),
    /may need a login/
  );
  assert.equal(requested.length, 1);
});
