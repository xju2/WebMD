import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import {
  insertSectionSummary,
  sectionTranscript,
  setTranscriptLine
} from '../server/calendar-notes.js';

const HEADING = '## 10:00 AM Group sync';
const DAY = [
  '# 2026-09-10',
  '',
  HEADING,
  '',
  '- Guests: Ada Lovelace, Bob',
  '- Join: <https://zoom.us/j/123456789>',
  '',
  'Talked about the fit.',
  '',
  '## 2:00 PM Seminar',
  '',
  'Notes.',
  ''
].join('\n');

test('the transcript line goes after the section’s starter lines, and is replaced later', () => {
  const once = setTranscriptLine(
    DAY,
    HEADING,
    'Group sync (2026-09-10) transcript'
  );
  assert.match(
    once,
    /- Join: <https:\/\/zoom\.us\/j\/123456789>\n- Transcript: \[\[Group sync \(2026-09-10\) transcript\]\]\n\nTalked/
  );
  assert.equal(
    sectionTranscript(once, HEADING),
    'Group sync (2026-09-10) transcript'
  );
  const again = setTranscriptLine(once, HEADING, 'meetings/Other');
  assert.equal(again.match(/- Transcript:/g).length, 1);
  assert.equal(sectionTranscript(again, HEADING), 'meetings/Other');
  // A section with no starter lines gets the line right under its heading.
  assert.match(
    setTranscriptLine(DAY, '## 2:00 PM Seminar', 'T'),
    /## 2:00 PM Seminar\n\n- Transcript: \[\[T\]\]\n\nNotes\./
  );
});

test('a section missing from the note is a 409 that says what to do', () => {
  assert.throws(
    () => setTranscriptLine(DAY, '## 9:00 AM Nope', 'T'),
    (error) =>
      error.status === 409 && /Add it to the day’s note/.test(error.message)
  );
});

test('the summary lands at the end of its own section, once', () => {
  const summary = {
    summary: ['Fit converges.'],
    decisions: ['Use the new binning.'],
    actions: [
      { task: 'Rerun the fit', owner: 'Ada Lovelace', due: '2026-09-20' }
    ]
  };
  const written = insertSectionSummary(DAY, HEADING, summary, {
    source: '[[T]]'
  });
  assert.match(
    written,
    /Talked about the fit\.\n\n### Summary\n\n_Written by AI from \[\[T\]\]\._\n\n- Fit converges\.\n\n\*\*Decisions\*\*\n\n- Use the new binning\.\n\n### Action items\n\n- \[ \] Rerun the fit who:ada 📅 2026-09-20\n\n## 2:00 PM Seminar/
  );
  assert.throws(
    () => insertSectionSummary(written, HEADING, summary, { source: '[[T]]' }),
    (error) => error.status === 409
  );
  // Another meeting the same day can still get its own.
  assert.doesNotThrow(() =>
    insertSectionSummary(written, '## 2:00 PM Seminar', summary, {
      source: '[[T]]'
    })
  );
});

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Ada Lovelace: The fit converges now.

2
00:00:05.000 --> 00:00:08.000
Bob: Ada, can you rerun it by the 20th?
`;

test('transcript then summary, through the API, into the day’s note', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'webmd-calnotes-'));
  await fs.writeFile(path.join(root, '2026-09-10.md'), DAY);
  const reply = JSON.stringify({
    summary: ['Ada showed the fit converging.'],
    decisions: [],
    actions: [{ task: 'Rerun the fit', owner: 'Ada', due: '2026-09-20' }]
  });
  const app = await createApp({
    workspaceRoot: root,
    env: {},
    aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'test' },
    aiFetch: async (_url, options) => {
      const sent = JSON.parse(options.body).messages[1].content;
      assert.match(sent, /Meeting: Group sync/);
      assert.match(sent, /Ada Lovelace: The fit converges now\./);
      return new Response(
        `${JSON.stringify({ message: { content: reply } })}\n`
      );
    }
  });
  const server = app.listen(0);
  await once(server, 'listening');
  const post = (route, body) =>
    fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/2026-09-10.md',
        heading: HEADING,
        title: 'Group sync',
        date: '2026-09-10',
        ...body
      })
    });
  try {
    const early = await post('/api/calendar/summary');
    assert.equal(early.status, 400);
    assert.match((await early.json()).error, /transcript first/);

    const saved = await post('/api/calendar/transcript', {
      name: 'zoom.vtt',
      text: VTT
    });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(
      body.transcriptPath,
      '/meetings/Group sync (2026-09-10) transcript.md'
    );
    assert.equal(body.turns, 2);
    const transcript = await fs.readFile(
      path.join(root, body.transcriptPath),
      'utf8'
    );
    assert.match(transcript, /^---\ntype: transcript\ndate: 2026-09-10\n/);
    assert.ok(!transcript.includes('indico:'));
    assert.match(transcript, /Transcript of \[\[2026-09-10\]\]/);

    const summarized = await post('/api/calendar/summary');
    assert.equal(summarized.status, 200);
    assert.equal((await summarized.json()).actions, 1);
    const day = await fs.readFile(path.join(root, '2026-09-10.md'), 'utf8');
    assert.match(
      day,
      /- Transcript: \[\[Group sync \(2026-09-10\) transcript\]\]/
    );
    assert.match(
      day,
      /### Summary[\s\S]*- \[ \] Rerun the fit who:ada 📅 2026-09-20\n\n## 2:00 PM Seminar/
    );

    assert.equal((await post('/api/calendar/summary')).status, 409);
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
