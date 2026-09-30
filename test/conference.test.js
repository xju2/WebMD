import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import {
  PLAN_END,
  PLAN_START,
  buildTalkScoreMessages,
  conferenceEvent,
  parseTalkScores,
  replacePlan,
  shortlistDay
} from '../server/conference.js';
import { resetMeetingsCache } from '../server/meetings.js';
import { buildInterestProfile } from '../server/news-rank.js';
import {
  agendaDays,
  backupFor,
  choose,
  dayUnits,
  planDay,
  unitScores
} from '../src/conference-plan.js';

const CERN = 'https://indico.cern.ch';

// A talk at `time` on 2026-10-05 (or `date`), `minutes` long, in `room`.
function talk(id, time, minutes, room, date = '2026-10-05') {
  const at = Date.parse(`${date}T${time}:00Z`);
  const end = new Date(at + minutes * 60000).toISOString();
  return {
    id,
    title: `Talk ${id}`,
    start: { date, time, at },
    end: { date, time: end.slice(11, 16), at: at + minutes * 60000 },
    speakers: [],
    session: '',
    room,
    description: ''
  };
}

const scoresOf = (object) => new Map(Object.entries(object));

test('plans the highest-scoring talks that never overlap', () => {
  const talks = [
    talk('a1', '09:00', 30, 'A'),
    talk('b1', '09:00', 30, 'B'),
    talk('a2', '09:30', 30, 'A'),
    talk('b2', '09:30', 60, 'B'),
    talk('a3', '10:00', 30, 'A')
  ];
  const scores = scoresOf({ a1: 3, b1: 8, a2: 6, b2: 4, a3: 7 });
  assert.deepEqual(
    planDay(talks, scores).map((item) => item.id),
    ['b1', 'a2', 'a3']
  );
  assert.equal(
    backupFor(talks[0], talks, planDay(talks, scores), scores).id,
    'a1'
  );
  assert.equal(
    backupFor(talks[2], talks, planDay(talks, scores), scores).id,
    'b2',
    'the long talk running alongside is the backup'
  );
});

test('stays in the same room when switching gains nothing', () => {
  const talks = [
    talk('a1', '09:00', 30, 'A'),
    talk('a2', '09:30', 30, 'A'),
    talk('b2', '09:30', 30, 'B')
  ];
  assert.deepEqual(
    planDay(talks, scoresOf({ a1: 7, a2: 6, b2: 6 })).map((item) => item.id),
    ['a1', 'a2']
  );
  assert.deepEqual(
    planDay(talks, scoresOf({ a1: 7, a2: 6, b2: 7 })).map((item) => item.id),
    ['a1', 'b2'],
    'a better talk is still worth the walk'
  );
});

test('a chosen talk replaces what it clashes with', () => {
  const plan = [talk('a1', '09:00', 30, 'A'), talk('a2', '09:30', 30, 'A')];
  assert.deepEqual(
    choose(plan, talk('b', '09:15', 30, 'B')).map((item) => item.id),
    ['b']
  );
  assert.deepEqual(
    choose(plan, talk('c', '10:00', 30, 'C')).map((item) => item.id),
    ['a1', 'a2', 'c']
  );
});

test('splits the agenda by the conference’s own days', () => {
  const days = agendaDays([
    talk('x', '09:00', 30, 'A', '2026-10-06'),
    talk('y', '09:00', 30, 'A', '2026-10-05')
  ]);
  assert.deepEqual(
    days.map((day) => [day.date, day.talks.map((item) => item.id)]),
    [
      ['2026-10-05', ['y']],
      ['2026-10-06', ['x']]
    ]
  );
});

test('asks the model to score every talk and keeps only real ones', () => {
  const talks = [talk('1', '09:00', 30, 'A'), talk('2', '09:00', 30, 'B')];
  const [system, user] = buildTalkScoreMessages(
    buildInterestProfile({ interests: 'Tracking' }),
    talks
  );
  assert.match(system.content, /Score every talk/);
  assert.match(user.content, /1\. id: 1\n {3}title: Talk 1/);
  assert.deepEqual(
    parseTalkScores(
      '[{"id": "1", "score": 8, "reason": "Yours."}, {"id": "2", "score": 2}, {"id": "9", "score": 9}]',
      talks
    ),
    { 1: { score: 8, reason: 'Yours.' }, 2: { score: 2 } }
  );
});

test('takes only an Indico event link', () => {
  assert.deepEqual(conferenceEvent(`${CERN}/event/77/timetable/`), {
    origin: CERN,
    eventId: '77',
    url: `${CERN}/event/77/`
  });
  assert.throws(() => conferenceEvent(`${CERN}/category/1/`), /event link/);
  assert.throws(
    () => conferenceEvent('https://example.org/agenda'),
    /not a known Indico/
  );
});

test('rewrites only the plan section of a note', () => {
  const note = `# Mine\n\nKeep this.\n\n${PLAN_START}\nold\n${PLAN_END}\n\nAnd this.\n`;
  assert.equal(
    replacePlan(note, `${PLAN_START}\nnew\n${PLAN_END}`),
    `# Mine\n\nKeep this.\n\n${PLAN_START}\nnew\n${PLAN_END}\n\nAnd this.\n`
  );
  assert.equal(replacePlan('# Mine\n', 'plan'), '# Mine\n\nplan\n');
});

test('folds a poster session into one stop, best posters first', () => {
  const posters = Array.from({ length: 12 }, (_, index) => ({
    ...talk(`p${index}`, '16:00', 90, 'Hall'),
    session: 'Evening session'
  }));
  const talks = [talk('t1', '16:00', 30, 'A'), ...posters];
  const scores = scoresOf({ t1: 6, p3: 9, p7: 4 });
  const units = dayUnits(talks, scores);
  assert.equal(units.length, 2, 'a crowd of 12 in one session and room');
  const block = units.find((unit) => unit.posters);
  assert.equal(block.posters.length, 12);
  assert.deepEqual(
    block.posters.slice(0, 2).map((item) => item.id),
    ['p3', 'p7']
  );
  assert.equal(unitScores(units, scores).get(block.id), 9);
  assert.deepEqual(
    planDay(units, unitScores(units, scores)).map((item) => item.id),
    [block.id],
    'the session is worth its best poster'
  );

  // Ten parallel talks in ten rooms are tracks, not posters.
  const tracks = Array.from({ length: 10 }, (_, index) =>
    talk(`r${index}`, '09:00', 20, `Room ${index}`)
  );
  assert.equal(dayUnits(tracks).length, 10);
  const labelled = [{ ...talk('x', '09:00', 60, 'Hall'), type: 'Poster' }];
  assert.ok(dayUnits(labelled)[0].posters, 'Indico says Poster');
});

test('shortlists a day by local match, with a few talks from every slot', () => {
  const profile = buildInterestProfile({
    interests: 'calorimeter calibration'
  });
  // Twenty morning talks all match; the one afternoon slot matches nothing.
  const morning = Array.from({ length: 20 }, (_, index) => ({
    ...talk(`m${index}`, '09:00', 20, `Room ${index}`),
    title: `Calorimeter calibration ${index}`
  }));
  const afternoon = Array.from({ length: 5 }, (_, index) => ({
    ...talk(`a${index}`, '14:00', 20, `Room ${index}`),
    title: `Unrelated topic ${index}`
  }));
  const { candidates, local } = shortlistDay(
    [...morning, ...afternoon],
    profile,
    8
  );
  assert.equal(candidates.length, 8);
  assert.equal(
    candidates.filter((item) => item.id.startsWith('a')).length,
    3,
    'the afternoon slot still gets three talks read'
  );
  assert.equal(Object.keys(local).length, 17, 'the rest are scored locally');
  assert.ok(
    Object.values(local).every(
      (value) => value.local && value.score >= 1 && value.score <= 3
    )
  );
  assert.equal(local.a4.score, 1, 'no match is the lowest local score');
  assert.ok(local.m19.score > 1, 'a local match scores above no match');
});

/* ------------------------------------------------------------------ API */

const when = (date, time) => ({
  date,
  time: `${time}:00`,
  tz: 'Europe/Zurich'
});
const CONFERENCE = {
  id: '77',
  title: 'Connecting the Dots',
  startDate: when('2026-10-05', '09:00'),
  endDate: when('2026-10-06', '18:00'),
  timezone: 'Europe/Zurich',
  url: `${CERN}/event/77/`,
  location: 'CERN',
  room: '',
  roomFullname: '',
  address: '',
  description: '',
  type: 'conference',
  category: 'Conferences',
  hasAnyProtection: false,
  contributions: [
    ['501', 'GNN tracking at HL-LHC', '09:00', 'Room A', 'Edge classifiers.'],
    ['502', 'Calorimeter calibration', '09:00', 'Room B', ''],
    ['503', 'Line segment tracking', '09:30', 'Room A', '']
  ].map(([id, title, time, room, description]) => ({
    db_id: Number(id),
    title,
    startDate: when('2026-10-05', time),
    endDate: when(
      '2026-10-05',
      time.replace(':00', ':25').replace(':30', ':55')
    ),
    duration: 25,
    speakers: [{ first_name: 'Ada', last_name: 'Lovelace' }],
    session: 'Tracking',
    roomFullname: room,
    description: `<p>${description}</p>`,
    url: `${CERN}/event/77/contributions/${id}/`
  }))
};

async function startApp({ reply, conference = CONFERENCE, env = {} }) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'webmd-conference-'));
  const cacheDir = await fs.mkdtemp(path.join(tmpdir(), 'webmd-cache-'));
  const prompts = [];
  const app = await createApp({
    workspaceRoots: [root],
    cacheDir,
    env: { ARXIV_NEWS_INTERESTS: 'Charged particle tracking', ...env },
    indicoFetch: async (target) => {
      const url = new URL(target);
      const results =
        url.pathname === '/export/event/77.json' ? [conference] : [];
      return new Response(JSON.stringify({ count: results.length, results }));
    },
    aiEnv: { AI_PROVIDER: 'ollama', AI_MODEL: 'llama-test' },
    aiFetch: async (_url, options) => {
      const prompt = JSON.parse(options.body).messages[1].content;
      prompts.push(prompt);
      const text = typeof reply === 'function' ? reply(prompt) : reply;
      return new Response(
        `${JSON.stringify({ message: { content: text } })}\n${JSON.stringify({ done: true })}\n`
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
  return { server, call, root, prompts };
}

test('scores a conference once, remembers it, and saves the plan to a note', async (t) => {
  resetMeetingsCache();
  const { server, call, root, prompts } = await startApp({
    reply:
      '[{"id": "501", "score": 9, "reason": "Your tracker."}, {"id": "502", "score": 3}, {"id": "503", "score": 7, "reason": "LST."}]'
  });
  t.after(() => server.close());
  const url = `${CERN}/event/77/overview`;

  const planned = await call('POST', '/api/conference/plan', {
    root: '0',
    url
  });
  assert.equal(planned.status, 200);
  assert.equal(planned.body.meeting.agenda.length, 3);
  assert.equal(
    planned.body.meeting.agenda.find((item) => item.id === '501').description,
    'Edge classifiers.'
  );
  assert.deepEqual(planned.body.ranking.scores['501'], {
    score: 9,
    reason: 'Your tracker.'
  });
  assert.equal(planned.body.ranking.reviewed, 3);
  assert.equal(planned.body.planPath, '');
  assert.match(prompts[0], /Charged particle tracking/);
  assert.match(prompts[0], /abstract: Edge classifiers\./);

  await call('POST', '/api/conference/plan', { root: '0', url });
  assert.equal(prompts.length, 1, 'the saved scores are reused');
  await call('POST', '/api/conference/plan', { root: '0', url, refresh: true });
  assert.equal(prompts.length, 2, 'Re-rank asks again');

  const list = await call('GET', '/api/conferences?root=0');
  assert.deepEqual(list.body.conferences, [
    {
      url: `${CERN}/event/77/`,
      title: 'Connecting the Dots',
      start: '2026-10-05',
      end: '2026-10-06'
    }
  ]);

  const days = { '2026-10-05': ['501', '503'] };
  const saved = await call('POST', '/api/conference/note', {
    root: '0',
    url,
    days
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.created, true);
  assert.equal(
    saved.body.path,
    '/meetings/Connecting the Dots (2026-10-05) plan.md'
  );
  const notePath = path.join(root, saved.body.path);
  const note = await fs.readFile(notePath, 'utf8');
  assert.match(note, /^type: conference-plan$/m);
  assert.match(note, /^## Monday 5 October$/m);
  assert.match(
    note,
    /- 09:00–09:25 \[GNN tracking at HL-LHC\]\(https:\/\/indico\.cern\.ch\/event\/77\/contributions\/501\/\) — Room A · Ada Lovelace \(9\/10\)\n {2}- Your tracker\.\n {2}- Or: \[Calorimeter calibration\]/
  );
  assert.doesNotMatch(note, /- \[ \]/, 'no tasks for the Tasks view');

  // Your own lines survive a second save; the plan section is replaced.
  await fs.writeFile(notePath, `${note}\nMy own notes.\n`);
  const again = await call('POST', '/api/conference/note', {
    root: '0',
    url,
    days: { '2026-10-05': ['502'] }
  });
  assert.equal(again.body.created, false);
  const rewritten = await fs.readFile(notePath, 'utf8');
  assert.match(rewritten, /My own notes\./);
  assert.match(rewritten, /Calorimeter calibration/);
  assert.match(
    rewritten,
    /Or: \[GNN tracking at HL-LHC\]/,
    'the swapped-out talk is now the backup'
  );
  assert.equal(
    (await call('POST', '/api/conference/plan', { root: '0', url })).body
      .planPath,
    saved.body.path
  );

  const removed = await call('DELETE', '/api/conferences', {
    root: '0',
    url: `${CERN}/event/77/`
  });
  assert.deepEqual(removed.body.conferences, []);
});

test('a link that is not an Indico event is refused before any fetch', async (t) => {
  const { server, call, prompts } = await startApp({ reply: '[]' });
  t.after(() => server.close());
  const refused = await call('POST', '/api/conference/plan', {
    root: '0',
    url: 'https://169.254.169.254/latest/'
  });
  assert.equal(refused.status, 400);
  assert.equal(prompts.length, 0);
});

test('scores each day in its own call, reading at most N talks a day', async (t) => {
  resetMeetingsCache();
  const contributions = ['2026-10-05', '2026-10-06'].flatMap((date, day) =>
    Array.from({ length: 6 }, (_, index) => ({
      db_id: 600 + day * 10 + index,
      title: index % 2 ? `Tracking study ${index}` : `Other study ${index}`,
      startDate: when(date, `${String(9 + index).padStart(2, '0')}:00`),
      endDate: when(date, `${String(9 + index).padStart(2, '0')}:30`),
      speakers: [],
      session: null,
      roomFullname: 'Room A',
      url: `${CERN}/event/77/contributions/${600 + day * 10 + index}/`
    }))
  );
  const failing = new Set();
  const { server, call, prompts } = await startApp({
    conference: {
      ...CONFERENCE,
      endDate: when('2026-10-06', '18:00'),
      contributions
    },
    env: { ARXIV_NEWS_MAX_CANDIDATES: '4' },
    reply: (prompt) => {
      const ids = [...prompt.matchAll(/^\d+\. id: (\S+)/gm)].map(
        (match) => match[1]
      );
      if (ids.some((id) => failing.has(id))) return 'no scores today';
      return JSON.stringify(
        ids.map((id) => ({ id, score: 8, reason: 'Read.' }))
      );
    }
  });
  t.after(() => server.close());
  const plan = (body = {}) =>
    call('POST', '/api/conference/plan', {
      root: '0',
      url: `${CERN}/event/77/`,
      ...body
    });

  const first = await plan();
  assert.equal(prompts.length, 2, 'one call per day');
  for (const prompt of prompts)
    assert.equal(prompt.match(/^\d+\. id:/gm).length, 4, 'N talks a day');
  assert.equal(first.body.ranking.reviewed, 8);
  assert.equal(first.body.ranking.total, 12);
  const values = Object.values(first.body.ranking.scores);
  assert.equal(values.length, 12, 'every talk has a score');
  assert.equal(values.filter((value) => value.local).length, 4);

  await plan();
  assert.equal(prompts.length, 2, 'both days are reused');

  // A failed Re-rank keeps the day's earlier scores.
  for (const id of ['610', '611', '612', '613', '614', '615']) failing.add(id);
  const kept = await plan({ refresh: true });
  assert.equal(kept.status, 200);
  assert.match(
    kept.body.ranking.warnings[0],
    /Re-ranking 2026-10-06 failed, so it keeps its earlier scores/
  );
  assert.equal(kept.body.ranking.scores['611'].score, 8);
  failing.clear();
});

test('a day the model fails on is ordered locally and asked again next time', async (t) => {
  resetMeetingsCache();
  let fail = true;
  const { server, call, prompts } = await startApp({
    reply: () =>
      fail
        ? 'no scores today'
        : '[{"id": "501", "score": 9}, {"id": "502", "score": 3}, {"id": "503", "score": 7}]'
  });
  t.after(() => server.close());
  const plan = () =>
    call('POST', '/api/conference/plan', {
      root: '0',
      url: `${CERN}/event/77/`
    });

  const local = await plan();
  assert.equal(local.status, 200);
  assert.equal(local.body.ranking.method, 'local');
  assert.match(
    local.body.ranking.warnings[0],
    /2026-10-05 is ordered by keyword match only/
  );
  assert.equal(local.body.ranking.scores['501'].local, true);
  fail = false;
  const scored = await plan();
  assert.equal(prompts.length, 2, 'the failed day is asked again');
  assert.equal(scored.body.ranking.scores['501'].score, 9);
});
