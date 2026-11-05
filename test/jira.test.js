import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiraClient, jiraSites } from '../server/jira.js';
import { jiraTicket } from '../src/editor.js';
import { collectJiraTickets } from '../src/x-posts.js';

test('jiraTicket canonicalises browse and board links', () => {
  assert.deepEqual(
    jiraTicket('https://its.cern.ch/jira/browse/ATLAS-7?focus=1'),
    {
      key: 'ATLAS-7',
      url: 'https://its.cern.ch/jira/browse/ATLAS-7'
    }
  );
  assert.equal(
    jiraTicket(
      'https://its.cern.ch/jira/secure/RapidBoard.jspa?selectedIssue=ATLAS-8'
    ).url,
    'https://its.cern.ch/jira/browse/ATLAS-8'
  );
  assert.equal(
    jiraTicket('https://acme.atlassian.net/browse/PROJ-1').url,
    'https://acme.atlassian.net/browse/PROJ-1'
  );
  assert.equal(jiraTicket('https://its.cern.ch/jira/browse/notakey'), null);
});

test('collectJiraTickets merges links to one ticket and keeps a real label', () => {
  const note = [
    '[ATLAS-7](https://its.cern.ch/jira/browse/ATLAS-7)',
    '[the memory bug](https://its.cern.ch/jira/browse/ATLAS-7?focus=1)',
    'https://its.cern.ch/jira/browse/ATLAS-9'
  ].join('\n');
  assert.deepEqual(collectJiraTickets(note), [
    {
      url: 'https://its.cern.ch/jira/browse/ATLAS-7',
      handle: 'ATLAS-7',
      label: 'the memory bug'
    },
    {
      url: 'https://its.cern.ch/jira/browse/ATLAS-9',
      handle: 'ATLAS-9',
      label: 'ATLAS-9'
    }
  ]);
});

test('a token is bound to its base URL and needs https', () => {
  assert.deepEqual(jiraSites({ JIRA_CERN_TOKEN: 't' }), [
    { name: 'cern', base: 'https://its.cern.ch/jira', token: 't' }
  ]);
  assert.deepEqual(
    jiraSites({ JIRA_X_TOKEN: 't', JIRA_X_URL: 'http://x.example' }),
    []
  );
  assert.deepEqual(jiraSites({ JIRA_Y_URL: 'https://y.example/' }), []);
});

test('looks tickets up once, only on their own Jira, and caches misses', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        issues: [
          {
            key: 'ATLAS-7',
            fields: {
              summary: ' Memory  leak ',
              status: { name: 'Closed', statusCategory: { key: 'done' } },
              assignee: null,
              duedate: '2026-11-01',
              priority: { name: 'Major' }
            }
          }
        ]
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  };
  const jira = createJiraClient({
    env: { JIRA_CERN_TOKEN: 'secret' },
    fetchImpl
  });
  const urls = [
    'https://its.cern.ch/jira/browse/ATLAS-7',
    'https://its.cern.ch/jira/browse/ATLAS-404',
    'https://its.cern.ch.evil.example/jira/browse/ATLAS-7'
  ];
  const first = await jira.tickets(urls);
  assert.deepEqual(Object.keys(first), [
    'https://its.cern.ch/jira/browse/ATLAS-7'
  ]);
  assert.equal(
    first['https://its.cern.ch/jira/browse/ATLAS-7'].summary,
    'Memory leak'
  );
  assert.equal(first['https://its.cern.ch/jira/browse/ATLAS-7'].done, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://its.cern.ch/jira/rest/api/2/search');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
  assert.match(
    JSON.parse(calls[0].init.body).jql,
    /^key in \(ATLAS-7,ATLAS-404\)$/
  );

  await jira.tickets(urls);
  assert.equal(calls.length, 1);
});

test('a refused token says which variable to fix', async () => {
  const jira = createJiraClient({
    env: { JIRA_CERN_TOKEN: 'bad' },
    fetchImpl: async () => new Response('', { status: 401 })
  });
  await assert.rejects(jira.mine(), /JIRA_CERN_TOKEN/);
});
