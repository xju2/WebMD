import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SECTIONS,
  groupTasksIntoSections,
  isDailyNotePath,
  normalizeTerm,
  parseTermList,
  sanitizeSections,
  taskMatchesSection,
  taskTerms,
  taskSourceLabel
} from '../src/task-sections.js';

const task = (fields = {}) => ({
  line: 0,
  checked: false,
  text: 'Work',
  displayText: 'Work',
  due: '',
  priority: '',
  tags: [],
  noteTags: [],
  headings: [],
  path: '/notes/plan.md',
  ...fields
});

const sectionOf = (result, id) => result.find((entry) => entry.id === id);
const textsIn = (result, id) =>
  sectionOf(result, id).groups.flatMap((group) =>
    group.tasks.map((entry) => entry.text)
  );

test('normalises a term written as a tag or as a heading', () => {
  assert.equal(normalizeTerm('#Paper'), 'paper');
  assert.equal(normalizeTerm('  Interesting   Papers '), 'interesting papers');
});

test("collects a task's terms from tags, note tags, and headings", () => {
  assert.deepEqual(
    taskTerms(
      task({
        tags: ['Paper'],
        noteTags: ['reading'],
        headings: ['', '', 'Interesting papers']
      })
    ),
    ['paper', 'reading', 'interesting papers', 'interesting', 'papers']
  );
});

test('matches a section on singular or plural', () => {
  const papers = { include: ['paper'] };
  assert.ok(taskMatchesSection(task({ tags: ['papers'] }), papers));
  assert.ok(taskMatchesSection(task({ headings: ['', 'Papers'] }), papers));
  assert.ok(!taskMatchesSection(task({ tags: ['idea'] }), papers));
});

test('files a task that mentions arXiv under paper', () => {
  const papers = { include: ['paper'] };
  assert.ok(
    taskMatchesSection(
      task({ text: 'Read https://arxiv.org/abs/2608.00146' }),
      papers
    )
  );
  assert.ok(
    taskMatchesSection(task({ text: 'Skim arXiv:2608.00146' }), papers)
  );
  assert.ok(!taskMatchesSection(task({ text: 'Write the report' }), papers));
});

test('does not mistake a word ending in s for a plural', () => {
  assert.ok(
    taskMatchesSection(task({ tags: ['atlas'] }), { include: ['atlas'] })
  );
  assert.ok(
    !taskMatchesSection(task({ tags: ['atlas'] }), { include: ['idea'] })
  );
});

test('honours exclusions and status', () => {
  const section = { include: ['coding'], exclude: ['atlas'] };
  assert.ok(!taskMatchesSection(task({ tags: ['coding', 'atlas'] }), section));
  assert.ok(
    !taskMatchesSection(task({ tags: ['coding'], checked: true }), section)
  );
  assert.ok(
    taskMatchesSection(task({ tags: ['coding'], checked: true }), {
      ...section,
      status: 'any'
    })
  );
});

test('files each task into the first section that claims it', () => {
  const sections = [
    { id: 'papers', label: 'Papers', include: ['paper'] },
    { id: 'coding', label: 'Coding', include: ['coding'] },
    { id: 'other', label: 'Other', catchAll: true }
  ];
  const result = groupTasksIntoSections(
    [
      task({ text: 'Skim it', tags: ['paper', 'coding'] }),
      task({ text: 'Ship it', tags: ['coding'] }),
      task({ text: 'Call Sam' })
    ],
    sections
  );
  assert.deepEqual(textsIn(result, 'papers'), ['Skim it']);
  assert.deepEqual(textsIn(result, 'coding'), ['Ship it']);
  assert.deepEqual(textsIn(result, 'other'), ['Call Sam']);
});

test('keeps a completed task out of the catch-all', () => {
  const result = groupTasksIntoSections(
    [task({ text: 'Done already', checked: true })],
    [{ id: 'other', label: 'Other', catchAll: true }]
  );
  assert.equal(sectionOf(result, 'other').count, 0);
});

test('showing completed work opens up the open-only sections', () => {
  const sections = [
    { id: 'papers', label: 'Papers', include: ['paper'] },
    { id: 'archive', label: 'Archive', include: ['paper'], status: 'done' },
    { id: 'other', label: 'Other', catchAll: true }
  ];
  const tasks = [
    task({ text: 'Skim it', tags: ['paper'], checked: true }),
    task({ text: 'Call Sam', checked: true })
  ];
  assert.deepEqual(
    groupTasksIntoSections(tasks, sections).map((section) => section.count),
    [0, 1, 0]
  );
  // The done paper still lands in Papers first; the catch-all takes the rest.
  assert.deepEqual(
    groupTasksIntoSections(tasks, sections, { includeDone: true }).map(
      (section) => section.count
    ),
    [1, 0, 1]
  );
});

test('keeps an empty section so the dashboard keeps its shape', () => {
  const result = groupTasksIntoSections([], DEFAULT_SECTIONS);
  assert.deepEqual(
    result.map((section) => section.id),
    DEFAULT_SECTIONS.map((section) => section.id)
  );
});

test("groups a note's tasks under the note, soonest due first", () => {
  const result = groupTasksIntoSections(
    [
      task({ text: 'Later', path: '/notes/b.md', due: '2026-09-01' }),
      task({ text: 'Sooner', path: '/notes/a.md', due: '2026-08-20' }),
      task({ text: 'Also later', path: '/notes/b.md', due: '2026-09-02' })
    ],
    [{ id: 'other', label: 'Other', catchAll: true }]
  );
  assert.deepEqual(
    sectionOf(result, 'other').groups.map((group) => [
      group.label,
      group.tasks.map((entry) => entry.text)
    ]),
    [
      ['/notes/a.md', ['Sooner']],
      ['/notes/b.md', ['Later', 'Also later']]
    ]
  );
});

test('groups daily-note tasks by the project heading they sit under', () => {
  const result = groupTasksIntoSections(
    [
      task({
        text: 'Fix the fit',
        path: '/daily/2026-08-14.md',
        headings: ['', 'Thursday', 'Tracking'],
        due: '2026-08-15'
      }),
      task({
        text: 'Rerun the scan',
        path: '/daily/2026-08-15.md',
        headings: ['', 'Friday', 'Tracking'],
        due: '2026-08-16'
      }),
      task({
        text: 'Book the room',
        path: '/daily/2026-08-14.md',
        headings: ['', 'Thursday'],
        due: '2026-08-17'
      })
    ],
    [{ id: 'other', label: 'Other', catchAll: true }],
    { dailyNoteFolder: '/daily' }
  );
  assert.deepEqual(
    sectionOf(result, 'other').groups.map((group) => [
      group.label,
      group.tasks.map((entry) => entry.text)
    ]),
    [
      // One project pile spanning two days, then the task written above any `##`.
      ['Tracking', ['Fix the fit', 'Rerun the scan']],
      ['/daily/2026-08-14.md', ['Book the room']]
    ]
  );
});

test('only treats date-named notes in the daily folder as daily notes', () => {
  assert.ok(isDailyNotePath('/daily/2026-08-14.md', '/daily'));
  assert.ok(!isDailyNotePath('/notes/2026-08-14.md', '/daily'));
  assert.ok(!isDailyNotePath('/daily/plan.md', '/daily'));
  assert.ok(isDailyNotePath('/2026-08-14.md', '/'));
});

test('falls back to the defaults when nothing usable was stored', () => {
  assert.deepEqual(sanitizeSections(null), DEFAULT_SECTIONS);
  assert.deepEqual(sanitizeSections([{ label: '   ' }]), DEFAULT_SECTIONS);
});

test('keeps one catch-all and puts it last', () => {
  const sections = sanitizeSections([
    { label: 'Everything else', catchAll: true },
    { label: 'Papers', include: '#Paper, papers', status: 'nonsense' },
    { label: 'Spare', catchAll: true }
  ]);
  assert.deepEqual(
    sections.map((section) => [section.label, Boolean(section.catchAll)]),
    [
      ['Papers', false],
      ['Spare', false],
      ['Everything else', true]
    ]
  );
  assert.deepEqual(sections[0].include, ['paper', 'papers']);
  assert.equal(sections[0].status, 'open');
});

test('reads a comma-separated term list the way the editor writes it', () => {
  assert.deepEqual(parseTermList(' #paper , coding,, #paper '), [
    'paper',
    'coding'
  ]);
});

test('compact task sources use project and date or a readable filename', () => {
  assert.equal(taskSourceLabel(task()), 'plan');
  const daily = task({
    path: '/notes/2026-08-18.md',
    headings: ['', '', 'IAAS']
  });
  const date = new Date(2026, 7, 18).toLocaleDateString([], {
    month: 'short',
    day: 'numeric'
  });
  assert.equal(taskSourceLabel(daily, '/notes'), `IAAS · ${date}`);
  assert.equal(taskSourceLabel({ ...daily, headings: [] }, '/notes'), date);
  assert.equal(taskSourceLabel(daily, '/journal'), '2026-08-18');
  assert.equal(
    taskSourceLabel(task({ path: '/notes/My plan.markdown' })),
    'My plan'
  );
});
