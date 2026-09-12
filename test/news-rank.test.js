import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { DEFAULT_NEWS_CATEGORIES, resetNewsCache } from '../server/news.js';
import {
  buildInterestProfile,
  buildRankMessages,
  orderByScore,
  parseRankedPicks,
  profileIsEmpty,
  readNewsInstructions,
  scorePapers
} from '../server/news-rank.js';
import { createWorkspace } from '../server/workspace.js';

const paper = (id, title, abstract = '', announceType = 'new') => ({
  id,
  title,
  abstract,
  authors: ['A. Person'],
  categories: ['hep-ex'],
  announceType,
  url: `https://arxiv.org/abs/${id}`
});

const PAPERS = [
  paper('2609.00001', 'Gluon splitting in dijet events', 'We measure dijets.'),
  paper(
    '2609.00002',
    'Graph neural network track finding at the HL-LHC',
    'An edge classifier for charged particle tracking with pileup.'
  ),
  paper('2609.00003', 'Language agents for chemistry', 'Agents run labs.'),
  paper(
    '2501.00004',
    'Older tracking paper',
    'Track finding revised.',
    'replace'
  )
];

test.beforeEach(() => resetNewsCache());

test('builds a profile from citations, references, and recent notes', () => {
  const profile = buildInterestProfile({
    interests: 'Tracking with GNNs.\nAlso agents.',
    references: [{ title: 'Exa.TrkX: tracking with graphs' }],
    files: [
      {
        path: '/old.md',
        fileKind: 'markdown',
        mtimeMs: 1,
        content:
          '# Old\n\n- Ju et al., "Old tracking paper title" — [arXiv:2101.00001](https://arxiv.org/abs/2101.00001)\n'
      },
      {
        path: '/new.md',
        fileKind: 'markdown',
        mtimeMs: 2,
        content:
          '---\ntags: [x]\n---\n# 2026-09-10\n\nDebugged the edge classifier on [TrackML](https://x.org).\n- Vami et al., "New dark matter search paper" — [arXiv:2609.09194](https://arxiv.org/abs/2609.09194)\n'
      },
      { path: '/image.png', fileKind: 'image', mtimeMs: 3 }
    ]
  });

  assert.equal(profile.interests, 'Tracking with GNNs.\nAlso agents.');
  assert.deepEqual(profile.reading, [
    'New dark matter search paper',
    'Old tracking paper title',
    'Exa.TrkX: tracking with graphs'
  ]);
  assert.deepEqual(profile.recent, [
    { path: '/new.md', snippet: 'Debugged the edge classifier on TrackML.' }
  ]);
  assert.equal(profileIsEmpty(profile), false);
  assert.equal(
    profileIsEmpty(buildInterestProfile({ files: [], references: [] })),
    true
  );
});

test('scores papers by the rare words they share with the profile', () => {
  const profile = buildInterestProfile({
    interests: 'Graph neural network tracking at the HL-LHC'
  });
  const order = orderByScore(PAPERS, scorePapers(PAPERS, profile)).map(
    (item) => item.id
  );
  assert.equal(order[0], '2609.00002');
  assert.equal(order.at(-1), '2609.00003', 'no overlap keeps arXiv order last');
});

test('puts the instructions and the shortlist in front of the model', () => {
  const profile = buildInterestProfile({ interests: 'HPC agents for science' });
  const [system, user] = buildRankMessages(profile, PAPERS.slice(0, 2));
  assert.match(system.content, /substantive methodological or systems/);
  assert.match(user.content, /Instructions:\nHPC agents for science/);
  assert.match(user.content, /1\. id: 2609\.00001/);
  assert.match(user.content, /2\. id: 2609\.00002/);
});

test('keeps only real, distinct picks, strongest first', () => {
  const reply = `Here you go:
[
  {"id": "2609.00001", "score": 6, "connection": "HEP analysis", "reason": "Dijets."},
  {"id": "arXiv:2609.00002v2", "score": 12, "connection": "HEP tracking", "reason": "  Your   tracker. "},
  {"id": "2609.00002", "score": 3, "reason": "Duplicate."},
  {"id": "9999.99999", "score": 10, "reason": "Invented."}
]`;
  assert.deepEqual(parseRankedPicks(reply, PAPERS), [
    {
      id: '2609.00002',
      score: 10,
      connection: 'HEP tracking',
      reason: 'Your tracker.'
    },
    {
      id: '2609.00001',
      score: 6,
      connection: 'HEP analysis',
      reason: 'Dijets.'
    }
  ]);
  assert.deepEqual(parseRankedPicks('no json here', PAPERS), []);
});

test('reads the instructions note without its comments', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'webmd-news-'));
  const workspace = await createWorkspace(root);
  assert.equal(await readNewsInstructions(workspace), '');

  await fs.mkdir(path.join(root, '.webmd'));
  await fs.writeFile(
    path.join(root, '.webmd', 'news.md'),
    '# arXiv ranking\n\n<!-- not for the model -->\n\n\n\nRank by HPC agents.\n'
  );
  assert.equal(
    await readNewsInstructions(workspace),
    '# arXiv ranking\n\nRank by HPC agents.'
  );
});

const RSS = `<rss version="2.0"><channel><pubDate>Thu, 10 Sep 2026 00:00:00 -0400</pubDate>
${PAPERS.map(
  (item) => `<item><title>${item.title}</title>
<description>arXiv:${item.id}v1 Announce Type: ${item.announceType}
Abstract: ${item.abstract}</description>
<guid>oai:arXiv.org:${item.id}v1</guid><category>hep-ex</category>
<arxiv:announce_type>${item.announceType}</arxiv:announce_type>
<dc:creator>A. Person</dc:creator></item>`
).join('\n')}</channel></rss>`;

function ollamaReply(text) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({ message: { content: text } })}\n`
          )
        );
        controller.close();
      }
    })
  );
}

test('ranks the listing with the AI once per listing and instructions', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'webmd-news-'));
  await fs.mkdir(path.join(root, '.webmd'));
  const instructionsPath = path.join(root, '.webmd', 'news.md');
  await fs.writeFile(instructionsPath, 'Rank by HL-LHC tracking.\n');

  const prompts = [];
  const app = await createApp({
    workspaceRoots: [root],
    env: {},
    newsFetch: async () => new Response(RSS, { status: 200 }),
    aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
    aiFetch: async (_url, options) => {
      prompts.push(JSON.parse(options.body).messages[1].content);
      return ollamaReply(
        '[{"id": "2609.00003", "score": 7, "connection": "Agents", "reason": "Lab agents."}]'
      );
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const rank = async () =>
    (
      await fetch(`${url}/api/news/rank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: '0' })
      })
    ).json();

  try {
    const ranking = await rank();
    assert.equal(ranking.method, 'ai');
    assert.deepEqual(ranking.picks, [
      {
        id: '2609.00003',
        score: 7,
        connection: 'Agents',
        reason: 'Lab agents.'
      }
    ]);
    assert.equal(ranking.order[0], '2609.00003', 'picks lead');
    assert.equal(ranking.order[1], '2609.00002', 'then the closest match');
    assert.equal(ranking.order.length, PAPERS.length);

    assert.match(prompts[0], /Rank by HL-LHC tracking/);
    assert.doesNotMatch(prompts[0], /2501\.00004/, 'updates are not judged');

    await rank();
    assert.equal(prompts.length, 1, 'the same listing is ranked once');

    await fs.writeFile(instructionsPath, 'Rank by agents for chemistry.\n');
    await rank();
    assert.equal(prompts.length, 2, 'edited instructions earn a fresh ranking');
    assert.match(prompts[1], /Rank by agents for chemistry/);
  } finally {
    server.close();
  }
});

test('a saved AI ranking outlives a server restart', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'webmd-news-'));
  const cacheDir = await fs.mkdtemp(path.join(tmpdir(), 'webmd-cache-'));
  await fs.mkdir(path.join(root, '.webmd'));
  await fs.writeFile(
    path.join(root, '.webmd', 'news.md'),
    'Rank by HL-LHC tracking.\n'
  );

  let calls = 0;
  const rankOnce = async (body = {}) => {
    const app = await createApp({
      workspaceRoots: [root],
      env: {},
      cacheDir,
      newsFetch: async () => new Response(RSS, { status: 200 }),
      aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
      aiFetch: async () => {
        calls += 1;
        return ollamaReply(
          '[{"id": "2609.00002", "score": 9, "connection": "HEP tracking", "reason": "GNN tracking."}]'
        );
      }
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/news/rank`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: '0', ...body })
        }
      );
      return response.json();
    } finally {
      server.close();
      resetNewsCache();
    }
  };

  const first = await rankOnce();
  assert.equal(first.method, 'ai');
  assert.deepEqual(await rankOnce(), first);
  assert.equal(calls, 1, 'the restarted server reuses the saved ranking');

  await rankOnce({ refresh: true });
  assert.equal(calls, 2, 'Re-rank still asks the model');
});

test('serves and ranks the listings of earlier days', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'webmd-news-'));
  const cacheDir = await fs.mkdtemp(path.join(tmpdir(), 'webmd-cache-'));
  await fs.mkdir(path.join(root, '.webmd'));
  await fs.writeFile(
    path.join(root, '.webmd', 'news.md'),
    'Rank by HL-LHC tracking.\n'
  );
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const today = new Date();
  const feedOf = (date, title) =>
    RSS.replace(/<pubDate>[^<]*/, `<pubDate>${date.toUTCString()}`).replace(
      PAPERS[0].title,
      title
    );
  const isoDay = (date) => date.toISOString().slice(0, 10);

  const prompts = [];
  const serve = async (feed, run) => {
    const app = await createApp({
      workspaceRoots: [root],
      env: {},
      cacheDir,
      newsFetch: async () => new Response(feed, { status: 200 }),
      aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
      aiFetch: async (_url, options) => {
        prompts.push(JSON.parse(options.body).messages[1].content);
        return ollamaReply(
          '[{"id": "2609.00002", "score": 9, "connection": "HEP tracking", "reason": "GNN tracking."}]'
        );
      }
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      return await run({
        get: async (query = '') => {
          const response = await fetch(`${url}/api/news/arxiv${query}`);
          return { status: response.status, body: await response.json() };
        },
        rank: async (body = {}) =>
          (
            await fetch(`${url}/api/news/rank`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ root: '0', ...body })
            })
          ).json()
      });
    } finally {
      server.close();
      resetNewsCache();
    }
  };

  await serve(feedOf(yesterday, 'Yesterday paper'), async ({ get }) => {
    const { body } = await get();
    assert.equal(body.day, isoDay(yesterday));
    assert.deepEqual(body.days, [isoDay(yesterday)]);
  });
  // The next day's feed, past the cached copy.
  await fs.rm(
    path.join(
      cacheDir,
      'arxiv-news',
      `${DEFAULT_NEWS_CATEGORIES.join('+')}.json`
    )
  );
  await serve(feedOf(today, 'Today paper'), async ({ get, rank }) => {
    const latest = await get();
    assert.equal(latest.body.day, isoDay(today));
    assert.deepEqual(latest.body.days, [isoDay(today), isoDay(yesterday)]);

    const earlier = await get(`?day=${isoDay(yesterday)}`);
    assert.equal(earlier.body.day, isoDay(yesterday));
    assert.equal(earlier.body.papers[0].title, 'Yesterday paper');
    assert.deepEqual(earlier.body.days, latest.body.days);
    assert.equal((await get('?day=soon')).status, 400);
    assert.equal((await get('?day=2001-01-01')).status, 404);

    assert.equal((await rank({ day: isoDay(yesterday) })).method, 'ai');
    assert.match(prompts[0], /Yesterday paper/);
    assert.equal((await rank()).method, 'ai');
    assert.match(prompts[1], /Today paper/);
    await rank({ day: isoDay(yesterday) });
    assert.equal(prompts.length, 2, 'each day is ranked once');
  });
  await serve(feedOf(today, 'Today paper'), async ({ rank }) => {
    await rank({ day: isoDay(yesterday) });
    await rank();
    assert.equal(prompts.length, 2, 'both rankings are saved on disk');
  });
});
