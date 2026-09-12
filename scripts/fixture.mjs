// A throwaway workspace for checking the UI by eye: two roots (one populated,
// one empty), a canned arXiv listing, and a stub AI provider. Nothing leaves
// the machine and ~/.webmd.conf is never read, so no real notes or API keys
// are involved.
//
//   npm run fixture                    # http://127.0.0.1:3197
//   AI_MODE=slow npm run fixture       # stream replies slowly
//   AI_MODE=error npm run fixture      # the provider fails every request
//   NEWS_MODE=error|empty npm run fixture
//   MEETINGS_MODE=notoken|auth|offline|none|zoom npm run fixture
//
// Meetings talk to a canned Indico at indico.cern.ch with a placeholder token
// (never a real one): `notoken` drops the token, `auth` makes Indico reject it,
// `offline` fails the network, and `none` starts with no sources at all.
//
// The stub's chat reply states which context the server sent it, so a page can
// be checked against what the AI actually received, not just its own labels.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { newsCategories, parseArxivRss } from '../server/news.js';

const port = Number(process.env.PORT || 3197);
const aiMode = process.env.AI_MODE || 'ok';
const newsMode = process.env.NEWS_MODE || 'ok';
const meetingsMode = process.env.MEETINGS_MODE || 'ok';
const base =
  process.env.FIXTURE_DIR ||
  (await fs.mkdtemp(path.join(os.tmpdir(), 'webmd-fixture-')));
const research = path.join(base, 'research');
const empty = path.join(base, 'empty-workspace');

const today = new Date();
const isoDay = (offset = 0) => {
  const day = new Date(today);
  day.setDate(day.getDate() + offset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
};

const files = {
  'README.md': `---
title: Fixture research workspace
tags: [fixture, validation]
---

# Fixture research workspace

This workspace exists only to validate the WebMD interface. See [[Deep note]] and [[Missing note]].

> [!note] Fixture
> Callout body with \`inline code\` and $E = mc^2$.

## Tasks

- [ ] Overdue fixture task 📅 ${isoDay(-3)} ⏫
- [ ] Due today fixture task 📅 ${isoDay(0)}
- [ ] Later fixture task with a considerably longer sentence so the row has to wrap across more than one line in the preview 📅 ${isoDay(12)}
- [x] Finished fixture task ✅ ${isoDay(-1)}

## Code

\`\`\`js
console.log('fixture');
\`\`\`
`,
  'meta/conventions.md': '# Conventions\n\nFixture file.\n',
  'wiki/topics/analysis-methods.md': '# Analysis methods\n\nFixture topic.\n',
  'wiki/concepts/a-deliberately-long-concept-note-name-that-should-truncate-cleanly-in-the-sidebar.md':
    '# Long name\n\nFixture file with a long name.\n',
  'projects/level-1/level-2/level-3/level-4/level-5/Deep note.md':
    '# Deep note\n\nFive folders down, to check tree indentation.\n',
  [`raw/dailynotes/${isoDay(-1)}.md`]: `# ${isoDay(-1)}\n\n- [ ] Yesterday fixture task\n`,
  [`raw/dailynotes/${isoDay(0)}.md`]: `# ${isoDay(0)}\n\n## Reading\n\n## Notes\n\nFixture daily note.\n`,
  '.webmd/news.md':
    'Fixture ranking instructions: statistical combination, detector hardware, machine learning.\n'
};
if (meetingsMode !== 'none') {
  files['.webmd/meetings.json'] = `${JSON.stringify(
    {
      version: 1,
      noteFolder: '/meetings',
      sources: [
        {
          id: 'indico.cern.ch-category-100',
          label: 'Tracking group',
          origin: 'https://indico.cern.ch',
          url: 'https://indico.cern.ch/category/100/',
          enabled: true
        },
        {
          id: 'indico.cern.ch-category-200',
          label: 'Public seminars',
          origin: 'https://indico.cern.ch',
          url: 'https://indico.cern.ch/category/200/',
          enabled: true
        }
      ]
    },
    null,
    2
  )}\n`;
  // An existing note, so one meeting shows Open note instead of Create note.
  files['meetings/Machine learning seminar.md'] = `---
type: meeting
indico: https://indico.cern.ch/event/9002/
---

# Machine learning seminar

## Notes

Written before the meeting.
`;
}
for (let index = 1; index <= 12; index += 1) {
  files[`raw/imports/import-${String(index).padStart(2, '0')}.md`] =
    `# Import ${index}\n\nFixture import.\n`;
}

for (const [name, text] of Object.entries(files)) {
  const target = path.join(research, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}
await fs.mkdir(empty, { recursive: true });

const papers = [
  [
    '2609.00001',
    'Fixture paper A: a combination of correlated measurements with a title long enough to wrap onto several lines in a narrow column',
    'Author One, Author Two, Author Three, Author Four, Author Five',
    ['hep-ex', 'physics.data-an'],
    'new'
  ],
  [
    '2609.00002',
    'Fixture paper B: detector hardware reliability study',
    'Author Six',
    ['hep-ex', 'physics.ins-det'],
    'new'
  ],
  [
    '2609.00003',
    'Fixture paper C: machine learning for event reconstruction',
    'Author Seven, Author Eight',
    ['cs.LG', 'hep-ex'],
    'cross'
  ],
  [
    '2609.00004',
    'Fixture paper D: phenomenology note',
    'Author Nine',
    ['hep-ph'],
    'new'
  ],
  [
    '2609.00005',
    'Fixture paper E: revised version of an earlier listing',
    'Author Ten',
    ['hep-ex'],
    'replace'
  ]
];
const abstract =
  'Fixture abstract text, placeholder prose used only to check line length, clamping, and expansion. '.repeat(
    4
  );
const escapeXml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const channel = (items) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>fixture</title><pubDate>${today.toUTCString()}</pubDate>${items}</channel></rss>`;
const rss = channel(
  papers
    .map(
      ([id, title, authors, categories, type]) =>
        `<item><title>${escapeXml(title)}</title><guid>oai:arXiv.org:${id}v1</guid><description>arXiv:${id}v1 Announce Type: ${type} Abstract: ${escapeXml(abstract)}</description>${categories
          .map((category) => `<category>${category}</category>`)
          .join(
            ''
          )}<arxiv:announce_type>${type}</arxiv:announce_type><dc:creator>${escapeXml(authors)}</dc:creator></item>`
    )
    .join('')
);

// Two earlier weekdays of listings, so the News day picker has a month to
// page through. Each keeps the fixture's papers under that day's own ids.
const cacheDir = path.join(base, '.cache');
const newsKey = newsCategories({
  ARXIV_NEWS_CATEGORIES: 'hep-ex,hep-ph,cs.LG,physics.data-an'
}).join('+');
for (const [offset, label] of [
  [-3, 'Earlier'],
  [-4, 'Earliest']
]) {
  const date = new Date(today.getTime() + offset * 24 * 60 * 60 * 1000);
  const listing = parseArxivRss(
    rss
      .replace(/<pubDate>[^<]*/, `<pubDate>${date.toUTCString()}`)
      .replace(/2609\.000(\d\d)/g, `2608.${String(-offset)}00$1`)
      .replace(/Fixture paper/g, `${label} fixture paper`)
  );
  const file = path.join(
    cacheDir,
    'arxiv-news',
    'history',
    newsKey,
    `${date.toISOString().slice(0, 10)}.json`
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      categories: newsKey.split('+'),
      ...listing,
      fetchedAt: date.getTime()
    })
  );
}

async function newsFetch() {
  if (newsMode === 'error') throw new Error('fixture network is offline');
  return new Response(newsMode === 'empty' ? channel('') : rss, {
    status: 200
  });
}

// Names the context block the server built (see chatMessages in server/ai.js).
function describeContext(userMessage) {
  const firstLine = userMessage.split('\n')[0];
  if (/^Selected text/.test(firstLine)) {
    const body = userMessage.split('\n\nUser request:')[0];
    const chars = body.slice(firstLine.length + 1).length;
    return `${firstLine.replace(/:$/, '')} (${chars} characters)`;
  }
  if (/^Current document/.test(firstLine)) return firstLine.replace(/:$/, '');
  return firstLine;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function aiFetch(_url, options) {
  if (aiMode === 'error') {
    return new Response('{"error":"fixture provider is down"}', {
      status: 503,
      statusText: 'Service Unavailable'
    });
  }
  const body = JSON.parse(options.body);
  const user = body.messages.findLast((message) => message.role === 'user');
  const prompt = body.messages.map((message) => message.content).join('\n');
  const ids = [...new Set(prompt.match(/\b2609\.\d{5}\b/g) || [])];
  let text;
  if (ids.length && /rank|score/i.test(prompt)) {
    text = JSON.stringify(
      ids.slice(0, 2).map((id, index) => ({
        id,
        score: [9, 6][index],
        connection: 'Fixture link',
        reason: `Fixture reason ${index + 1}, from the stub ranker.`
      }))
    );
  } else if (/write the minutes of a research meeting/.test(prompt)) {
    text = JSON.stringify({
      summary: ['Fixture summary point from the stub.', 'A second fixture point.'],
      decisions: ['Keep the fixture geometry.'],
      actions: [{ task: 'Rerun the fixture validation', owner: 'Fixture Person', due: isoDay(7) }]
    });
  } else if (user.content.includes('\n\nSelected text to replace:\n')) {
    text = 'Fixture replacement text from the stub editor.';
  } else {
    text = `Stub reply. Context received: ${describeContext(user.content)}.\n\n- First fixture point\n- Second fixture point`;
  }
  const chunks = text.match(/[\s\S]{1,24}/g) || [];
  const delay = aiMode === 'slow' ? 250 : 0;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        if (delay) await sleep(delay);
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ message: { content: chunk } })}\n`)
        );
      }
      controller.enqueue(encoder.encode(`${JSON.stringify({ done: true })}\n`));
      controller.close();
    }
  });
  return new Response(stream, { status: 200 });
}

// A canned Indico. Times are wall-clock in Geneva, as Indico states them; the
// view places them in the browser's day. Category 100 is protected: without a
// token it answers with nothing, exactly as the real one does.
const FIXTURE_TOKEN = 'fixture-placeholder-token';
const zurich = (offset, time) => ({
  date: isoDay(offset),
  time: `${time}:00`,
  tz: 'Europe/Zurich'
});
const person = (first, last) => ({ first_name: first, last_name: last });
const indicoEvents = {
  9001: {
    id: '9001',
    title: 'Tracking and reconstruction weekly',
    type: 'meeting',
    category: 'Tracking group',
    startDate: zurich(0, '15:00'),
    endDate: zurich(0, '16:30'),
    timezone: 'Europe/Zurich',
    roomFullname: '40/S2-C01 - Salle Curie',
    location: 'CERN',
    description:
      '<p>Weekly status of track reconstruction.</p><p>Connection details are on the Indico page.</p>',
    hasAnyProtection: true,
    categoryId: 100,
    contributions: [
      ['15:00', '15:10', 'Introduction and news', [person('Fixture', 'Convener')]],
      [
        '15:10',
        '15:35',
        'Seeding performance with the new geometry, a title long enough to wrap in the agenda column',
        [person('Speaker', 'One'), person('Speaker', 'Two')]
      ],
      ['15:35', '16:00', 'GNN-based track finding: timing studies', [person('Speaker', 'Three')]],
      ['16:00', '16:30', 'AOB', []]
    ].map(([start, end, title, speakers], index) => ({
      db_id: 70000 + index,
      title,
      startDate: zurich(0, start),
      endDate: zurich(0, end),
      speakers,
      session: index === 2 ? 'ML session' : null,
      url: `https://indico.cern.ch/event/9001/contributions/${70000 + index}/`
    }))
  },
  9002: {
    id: '9002',
    title: 'Machine learning seminar',
    type: 'lecture',
    category: 'Public seminars',
    startDate: zurich(1, '11:00'),
    endDate: zurich(1, '12:00'),
    timezone: 'Europe/Zurich',
    roomFullname: '222/R-001',
    location: 'CERN',
    hasAnyProtection: false,
    categoryId: 200,
    contributions: []
  },
  9003: {
    id: '9003',
    title: 'Detector upgrade workshop',
    type: 'conference',
    category: 'Tracking group',
    startDate: zurich(4, '09:00'),
    endDate: zurich(6, '17:00'),
    timezone: 'Europe/Zurich',
    location: 'Fixture Institute',
    hasAnyProtection: true,
    categoryId: 100,
    contributions: [
      {
        db_id: 71000,
        title: 'Opening',
        startDate: zurich(4, '09:00'),
        endDate: zurich(4, '09:30'),
        speakers: [person('Chair', 'Person')]
      },
      {
        db_id: 71001,
        title: 'Day two summary',
        startDate: zurich(5, '16:00'),
        endDate: zurich(5, '17:00'),
        speakers: []
      },
      { db_id: 71002, title: 'Unscheduled poster', startDate: null, speakers: [] }
    ]
  },
  9004: {
    id: '9004',
    title: 'Tracking and reconstruction weekly',
    type: 'meeting',
    category: 'Tracking group',
    startDate: zurich(10, '15:00'),
    endDate: zurich(10, '16:30'),
    timezone: 'Europe/Zurich',
    roomFullname: '40/S2-C01 - Salle Curie',
    location: 'CERN',
    hasAnyProtection: true,
    categoryId: 100,
    contributions: []
  },
  9005: {
    id: '9005',
    title: 'Colloquium: seeing the unseen',
    type: 'lecture',
    category: 'Public seminars',
    startDate: zurich(2, '16:00'),
    endDate: zurich(2, '17:00'),
    timezone: 'Europe/Zurich',
    location: 'Main Auditorium',
    hasAnyProtection: false,
    categoryId: 200,
    contributions: []
  }
};

// Zoom mode adds a Zoom call under way right now and one from last week that
// has its recording linked, to the public category.
const zurichAt = (ms) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Zurich',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:00`,
    tz: 'Europe/Zurich'
  };
};
if (meetingsMode === 'zoom') {
  const now = Date.now();
  indicoEvents[9006] = {
    id: '9006',
    title: 'Analysis check-in on Zoom',
    type: 'meeting',
    category: 'Public seminars',
    startDate: zurichAt(now - 10 * 60 * 1000),
    endDate: zurichAt(now + 50 * 60 * 1000),
    timezone: 'Europe/Zurich',
    location: 'Zoom',
    description:
      '<p>Join: <a href="https://cern.zoom.us/j/98765432101?pwd=Fixture.1&amp;uname=x">Zoom</a></p><p>Passcode: 424242</p>',
    hasAnyProtection: false,
    categoryId: 200,
    contributions: []
  };
  indicoEvents[9007] = {
    id: '9007',
    title: 'Last week analysis review',
    type: 'meeting',
    category: 'Public seminars',
    startDate: zurich(-3, '10:00'),
    endDate: zurich(-3, '11:00'),
    timezone: 'Europe/Zurich',
    location: 'Zoom',
    description:
      '<p><a href="https://cern.zoom.us/j/12345678901">Join</a></p><p><a href="https://cern.zoom.us/rec/share/fixture-recording">Recording</a></p>',
    hasAnyProtection: false,
    categoryId: 200,
    contributions: []
  };
}

async function indicoFetch(target, options = {}) {
  const url = new URL(target);
  if (url.origin !== 'https://indico.cern.ch') {
    return new Response('{"results":[]}', { status: 200 });
  }
  if (meetingsMode === 'offline') throw new Error('fixture network is offline');
  const auth = options.headers?.Authorization || '';
  if (meetingsMode === 'auth' && auth) {
    return new Response(
      '<h1>Bad Request</h1>invalid_token: The access token provided is expired, revoked, malformed, or invalid',
      { status: 400 }
    );
  }
  const authed = auth === `Bearer ${FIXTURE_TOKEN}`;
  const visible = (event) => authed || !event.hasAnyProtection;
  const json = (results) =>
    new Response(JSON.stringify({ count: results.length, results }), {
      status: 200
    });
  const summary = ({ contributions: _c, ...event }) => event;
  await sleep(150);

  const category = /^\/export\/categ\/(\d+)\.json$/.exec(url.pathname)?.[1];
  if (category) {
    return json(
      Object.values(indicoEvents)
        .filter((event) => String(event.categoryId) === category && visible(event))
        .map(summary)
    );
  }
  const eventId = /^\/export\/event\/(\d+)\.json$/.exec(url.pathname)?.[1];
  const event = indicoEvents[eventId];
  if (event && visible(event)) {
    return json([
      url.searchParams.get('detail') === 'contributions' ? event : summary(event)
    ]);
  }
  return json([]);
}

const offline = async () => new Response('', { status: 503 });
const env = {
  AI_PROVIDER: 'ollama',
  OLLAMA_BASE_URL: 'http://127.0.0.1:1',
  AI_MODEL: 'fixture-stub',
  ARXIV_NEWS_CATEGORIES: 'hep-ex,hep-ph,cs.LG,physics.data-an',
  ...(meetingsMode === 'notoken' ? {} : { INDICO_CERN_TOKEN: FIXTURE_TOKEN })
};
const app = await createApp({
  workspaceRoots: [research, empty],
  aiEnv: env,
  aiFetch,
  newsFetch,
  arxivFetch: offline,
  citationFetch: offline,
  indicoFetch,
  xFetch: offline,
  cacheDir,
  env
});
app.listen(port, '127.0.0.1', () =>
  console.log(
    `Fixture on http://127.0.0.1:${port} (ai: ${aiMode}, news: ${newsMode}, meetings: ${meetingsMode})\nWorkspace: ${base}`
  )
);
