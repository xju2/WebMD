// A throwaway workspace for checking the UI by eye: two roots (one populated,
// one empty), a canned arXiv listing, and a stub AI provider. Nothing leaves
// the machine and ~/.webmd.conf is never read, so no real notes or API keys
// are involved.
//
//   npm run fixture                    # http://127.0.0.1:3197
//   AI_MODE=slow npm run fixture       # stream replies slowly
//   AI_MODE=error npm run fixture      # the provider fails every request
//   NEWS_MODE=error|empty npm run fixture
//
// The stub's chat reply states which context the server sent it, so a page can
// be checked against what the AI actually received, not just its own labels.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

const port = Number(process.env.PORT || 3197);
const aiMode = process.env.AI_MODE || 'ok';
const newsMode = process.env.NEWS_MODE || 'ok';
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

const offline = async () => new Response('', { status: 503 });
const env = {
  AI_PROVIDER: 'ollama',
  OLLAMA_BASE_URL: 'http://127.0.0.1:1',
  AI_MODEL: 'fixture-stub',
  ARXIV_NEWS_CATEGORIES: 'hep-ex,hep-ph,cs.LG,physics.data-an'
};
const app = await createApp({
  workspaceRoots: [research, empty],
  aiEnv: env,
  aiFetch,
  newsFetch,
  arxivFetch: offline,
  citationFetch: offline,
  indicoFetch: offline,
  xFetch: offline,
  env
});
app.listen(port, '127.0.0.1', () =>
  console.log(
    `Fixture on http://127.0.0.1:${port} (ai: ${aiMode}, news: ${newsMode})\nWorkspace: ${base}`
  )
);
