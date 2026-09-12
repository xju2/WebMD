import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { resetMeetingsCache } from '../server/meetings.js';
import {
  actionLine,
  insertSummary,
  parseSummary,
  parseTranscript,
  setRecordingField,
  transcriptForModel,
  transcriptMarkdown
} from '../server/transcripts.js';
import { createWorkspace } from '../server/workspace.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { collectTasks } from '../src/tasks.js';

const CERN = 'https://indico.cern.ch';

test.beforeEach(() => resetMeetingsCache());

/* ------------------------------------------------------------- parsing */

const ZOOM_VTT = `WEBVTT

1
00:00:01.200 --> 00:00:04.000
Ada Lovelace: Welcome, everyone.

2
00:00:04.100 --> 00:00:07.500
Ada Lovelace: First, the tracking efficiency.

3
00:01:05.000 --> 00:01:09.000
Grace Hopper: It dropped to 92% after the *new* geometry.
`;

test('reads a Zoom WebVTT transcript into turns, one per speaker', () => {
  const entries = parseTranscript(ZOOM_VTT);
  assert.deepEqual(entries[0], { at: 1, speaker: 'Ada Lovelace', text: 'Welcome, everyone.' });
  assert.equal(entries.length, 3);
  assert.equal(
    transcriptMarkdown(entries),
    '**00:00:01 Ada Lovelace:** Welcome, everyone. First, the tracking efficiency.\n\n' +
      '**00:01:05 Grace Hopper:** It dropped to 92% after the \\*new\\* geometry.'
  );
});

test('reads SubRip, voice tags, saved captions, and plain text', () => {
  const srt = parseTranscript('1\r\n00:00:02,000 --> 00:00:03,000\r\nHello there\r\n\r\n2\r\n01:00:00,000 --> 01:00:01,000\r\nBye\r\n');
  assert.deepEqual(srt.map((entry) => [entry.at, entry.speaker, entry.text]), [
    [2, '', 'Hello there'],
    [3600, '', 'Bye']
  ]);

  const teams = parseTranscript('WEBVTT\n\n00:00:05.000 --> 00:00:06.000\n<v Ada Lovelace>Good &amp; fast</v>\n');
  assert.deepEqual(teams, [{ at: 5, speaker: 'Ada Lovelace', text: 'Good & fast' }]);

  const saved = parseTranscript('[Ada Lovelace] 10:02:33\nFirst point\nstill first\n\n[Grace Hopper] 10:03:00\nSecond\n');
  assert.deepEqual(saved, [
    { at: 0, speaker: 'Ada Lovelace', text: 'First point still first' },
    { at: 27, speaker: 'Grace Hopper', text: 'Second' }
  ]);

  const plain = parseTranscript('Ada: We agreed on the plan.\n\n# of events is 10k\nsee https://example.org\n');
  assert.equal(plain[0].speaker, 'Ada');
  assert.equal(
    transcriptMarkdown(plain),
    '**Ada:** We agreed on the plan.\n\n\\# of events is 10k see https://example.org'
  );

  assert.throws(() => parseTranscript('WEBVTT\n\n'), { status: 400 });
});

test('hands the model the transcript without Markdown, cut to size', () => {
  const note = '---\ntype: transcript\n---\n\n# T\n\nTranscript of [[M]].\n\n**00:00:01 Ada:** use \\*this\\*\n';
  assert.deepEqual(transcriptForModel(note), { text: '00:00:01 Ada: use *this*', truncated: false });
  const long = transcriptForModel(`# T\n${'word '.repeat(50000)}`);
  assert.equal(long.truncated, true);
});

/* ------------------------------------------------------------ summaries */

const NOTE = [
  '---',
  'type: meeting',
  `indico: ${CERN}/event/303/`,
  '---',
  '',
  '# Public seminar (2026-09-12)',
  '',
  '## Notes',
  '',
  'My own notes.',
  '',
  '## Action items',
  '',
  '- [ ] Send the slides who:ada',
  ''
].join('\n');

const SUMMARY = {
  summary: ['Efficiency dropped to 92%.', 'The new geometry is the cause.'],
  decisions: ['Roll back the geometry.'],
  actions: [
    { task: 'Send the slides', owner: 'Ada Lovelace', due: '' },
    { task: 'Rerun the validation', owner: 'Grace Hopper', due: '2026-09-18' }
  ]
};

test('puts the summary ahead of the notes and adds only new action items', () => {
  const result = insertSummary(NOTE, SUMMARY, { source: '[[Seminar transcript]]' });
  assert.equal(
    result,
    [
      '---',
      'type: meeting',
      `indico: ${CERN}/event/303/`,
      '---',
      '',
      '# Public seminar (2026-09-12)',
      '',
      '## Summary',
      '',
      '_Written by AI from [[Seminar transcript]]._',
      '',
      '- Efficiency dropped to 92%.',
      '- The new geometry is the cause.',
      '',
      '**Decisions**',
      '',
      '- Roll back the geometry.',
      '',
      '## Notes',
      '',
      'My own notes.',
      '',
      '## Action items',
      '',
      '- [ ] Send the slides who:ada',
      '- [ ] Rerun the validation who:grace 📅 2026-09-18',
      ''
    ].join('\n')
  );
  const tasks = collectTasks(result);
  assert.deepEqual(
    tasks.map((task) => [task.text, task.due]),
    [
      ['Send the slides who:ada', ''],
      ['Rerun the validation who:grace', '2026-09-18']
    ]
  );
  // A second summary never replaces the first: it may have been edited since.
  assert.throws(() => insertSummary(result, SUMMARY, { source: 'x' }), { status: 409 });
});

test('adds the sections a hand-made note lacks', () => {
  const result = insertSummary('# Sync\n\nText\n', SUMMARY, { source: 'the transcript' });
  assert.match(result, /^# Sync\n\nText\n\n## Summary\n/);
  assert.match(result, /\n## Action items\n\n- \[ \] Send the slides who:ada\n- \[ \] Rerun/);
  assert.ok(result.endsWith('\n'));
  // The template's own empty Action items section.
  const empty = insertSummary('# M\n\n## Notes\n\n\n## Action items\n\n', SUMMARY, { source: 's' });
  assert.match(empty, /## Action items\n\n- \[ \] Send the slides who:ada\n- \[ \] Rerun the validation who:grace 📅 2026-09-18\n/);
});

test('reads the model reply tolerantly and refuses an empty one', () => {
  const parsed = parseSummary(
    'Sure:\n{"summary": ["  One  point "], "decisions": "none", "actions": ["Call Bob", {"task": "Fix it", "due": "Friday"}]}'
  );
  assert.deepEqual(parsed, {
    summary: ['One point'],
    decisions: [],
    actions: [
      { task: 'Call Bob', owner: '', due: '' },
      { task: 'Fix it', owner: '', due: '' }
    ]
  });
  assert.throws(() => parseSummary('I cannot help'), { status: 502 });
  assert.throws(() => parseSummary('{"summary": [], "actions": []}'), { status: 502 });
  assert.equal(actionLine({ task: 'Ask who:jo for data', owner: 'Jo', due: '' }), '- [ ] Ask who:jo for data');
});

test('sets, changes, and removes the recording link, leaving the rest alone', () => {
  const withLink = setRecordingField(NOTE, 'https://cern.zoom.us/rec/share/abc');
  assert.equal(parseFrontmatter(withLink).attributes.recording, 'https://cern.zoom.us/rec/share/abc');
  assert.equal(withLink.replace('recording: https://cern.zoom.us/rec/share/abc\n', ''), NOTE);
  const odd = setRecordingField(withLink, 'https://example.org/a b#c');
  assert.equal(parseFrontmatter(odd).attributes.recording, 'https://example.org/a b#c');
  assert.equal(setRecordingField(odd, ''), NOTE);
  assert.throws(() => setRecordingField('# No frontmatter\n', 'https://x.org'), { status: 409 });
});

/* ---------------------------------------------------------------- routes */

function seminar() {
  return {
    id: '303',
    title: 'Public seminar',
    startDate: { date: '2026-09-12', time: '11:00:00', tz: 'Europe/Zurich' },
    endDate: { date: '2026-09-12', time: '12:00:00', tz: 'Europe/Zurich' },
    timezone: 'Europe/Zurich',
    description: '<a href="https://cern.zoom.us/j/98765432101">Zoom</a>',
    contributions: []
  };
}

async function tempRoot() {
  return fs.mkdtemp(path.join(tmpdir(), 'webmd-transcripts-'));
}

async function startApp({ reply, onAi } = {}) {
  const root = await tempRoot();
  const aiCalls = [];
  const app = await createApp({
    workspaceRoots: [root],
    env: {},
    indicoFetch: async (target) => {
      const url = new URL(target);
      const results = url.pathname === '/export/event/303.json' ? [seminar()] : [];
      return new Response(JSON.stringify({ count: results.length, results }));
    },
    aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
    aiFetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      aiCalls.push(body);
      onAi?.(body);
      const line = `${JSON.stringify({ message: { content: reply } })}\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(line));
            controller.close();
          }
        })
      );
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, call, root, aiCalls };
}

const MEETING = { root: '0', origin: CERN, id: '303' };

test('attaches a recording and a transcript, then summarizes into the note', async (t) => {
  const { server, call, root, aiCalls } = await startApp({
    reply: JSON.stringify(SUMMARY),
    onAi: (body) => {
      assert.match(body.messages[1].content, /Meeting: Public seminar/);
      assert.match(body.messages[1].content, /00:01:05 Grace Hopper: It dropped to 92% after the \*new\* geometry\./);
    }
  });
  t.after(() => server.close());

  // A transcript before any note: the note is made first, then the transcript.
  const transcript = await call('POST', '/api/meetings/transcript', {
    ...MEETING,
    name: 'GMT20260912-090000_Recording.transcript.vtt',
    text: ZOOM_VTT
  });
  assert.equal(transcript.status, 200);
  assert.equal(transcript.body.created, true);
  assert.equal(transcript.body.notePath, '/meetings/Public seminar (2026-09-12).md');
  assert.equal(transcript.body.transcriptPath, '/meetings/Public seminar (2026-09-12) transcript.md');
  assert.equal(transcript.body.turns, 3);
  const transcriptText = await fs.readFile(path.join(root, transcript.body.transcriptPath), 'utf8');
  assert.equal(parseFrontmatter(transcriptText).attributes.type, 'transcript');
  assert.match(transcriptText, /Transcript of \[\[Public seminar \(2026-09-12\)\]\], from `GMT20260912-090000_Recording\.transcript\.vtt`\./);

  // The transcript never stands in for the meeting's own note.
  const opened = await call('POST', '/api/meetings/note', MEETING);
  assert.deepEqual(opened.body, { path: transcript.body.notePath, created: false });

  const recording = await call('POST', '/api/meetings/recording', {
    ...MEETING,
    url: 'https://cern.zoom.us/rec/share/abc'
  });
  assert.equal(recording.status, 200);
  assert.equal(recording.body.recording, 'https://cern.zoom.us/rec/share/abc');
  const bad = await call('POST', '/api/meetings/recording', { ...MEETING, url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);

  const listed = await call('GET', `/api/meetings/event?root=0&origin=${encodeURIComponent(CERN)}&id=303`);
  assert.equal(listed.body.recording, 'https://cern.zoom.us/rec/share/abc');
  assert.equal(listed.body.transcriptPath, transcript.body.transcriptPath);
  assert.equal(listed.body.zoom.url, 'https://cern.zoom.us/j/98765432101');

  const summary = await call('POST', '/api/meetings/summary', MEETING);
  assert.equal(summary.status, 200);
  assert.deepEqual([summary.body.points, summary.body.actions], [2, 2]);
  const note = await fs.readFile(path.join(root, transcript.body.notePath), 'utf8');
  assert.match(note, /- \*\*Zoom:\*\* <https:\/\/cern\.zoom\.us\/j\/98765432101>/);
  assert.match(note, /## Summary\n\n_Written by AI from \[\[Public seminar \(2026-09-12\) transcript\]\]\._/);
  assert.match(note, /- \[ \] Rerun the validation who:grace 📅 2026-09-18/);
  assert.equal(parseFrontmatter(note).attributes.recording, 'https://cern.zoom.us/rec/share/abc');

  // Asked again, it refuses before spending a model call.
  const again = await call('POST', '/api/meetings/summary', MEETING);
  assert.equal(again.status, 409);
  assert.equal(aiCalls.length, 1);

  // A better transcript replaces the first one in place.
  const replaced = await call('POST', '/api/meetings/transcript', {
    ...MEETING,
    name: 'captions.txt',
    text: '[Ada Lovelace] 11:00:00\nOnly this.\n'
  });
  assert.equal(replaced.body.transcriptPath, transcript.body.transcriptPath);
  const rewritten = await fs.readFile(path.join(root, replaced.body.transcriptPath), 'utf8');
  assert.match(rewritten, /\*\*00:00:00 Ada Lovelace:\*\* Only this\./);
  assert.doesNotMatch(rewritten, /Grace Hopper/);
});

test('a summary needs a transcript, and a bad model reply writes nothing', async (t) => {
  const { server, call, root } = await startApp({ reply: 'I cannot do that.' });
  t.after(() => server.close());

  const none = await call('POST', '/api/meetings/summary', MEETING);
  assert.equal(none.status, 400);

  await call('POST', '/api/meetings/transcript', { ...MEETING, text: ZOOM_VTT });
  const before = await fs.readFile(path.join(root, 'meetings/Public seminar (2026-09-12).md'), 'utf8');
  const failed = await call('POST', '/api/meetings/summary', MEETING);
  assert.equal(failed.status, 502);
  assert.equal(
    await fs.readFile(path.join(root, 'meetings/Public seminar (2026-09-12).md'), 'utf8'),
    before
  );

  const empty = await call('POST', '/api/meetings/transcript', { ...MEETING, text: '   ' });
  assert.equal(empty.status, 400);
});

test('an edit WebMD makes reaches an open editor as an ordinary version', async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, 'note.md'), 'one\ntwo\n');
  const workspace = await createWorkspace(root);
  const events = [];
  const subscription = await workspace.subscribeEvents('/note.md', 0, (event) => events.push(event));

  const result = await workspace.editFile('/note.md', (content) => content.replace('two', 'TWO!'));
  assert.deepEqual([result.changed, result.version], [true, 1]);
  assert.equal(events.length, 1);
  assert.equal(events[0].updates[0].clientID, 'webmd');
  assert.deepEqual(events[0].updates[0].changes, [4, [3, 'TWO!'], 1]);
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'one\nTWO!\n');

  // An editor at version 0 is told to rebase, not allowed to overwrite.
  await assert.rejects(workspace.applyUpdates('/note.md', 0, []), { status: 409 });
  const unchanged = await workspace.editFile('/note.md', (content) => content);
  assert.equal(unchanged.changed, false);
  subscription.unsubscribe();
});
