import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LANES,
  ageBand,
  filterTasks,
  groupTasksIntoBoard,
  scoreTask,
  taskAgeDays
} from '../src/task-score.js';
import { DEFAULT_SECTIONS, sanitizeSections } from '../src/task-sections.js';

const TODAY = '2026-08-14';

const task = (fields = {}) => {
  const entry = {
    line: 0,
    checked: false,
    text: 'Work',
    due: '',
    created: '',
    priority: '',
    tags: [],
    noteTags: [],
    headings: [],
    path: '/notes/plan.md',
    ...fields
  };
  // As collectTasks builds it: the prose without its inline tags.
  return { displayText: entry.text, ...entry };
};

const daily = (date, fields = {}) =>
  task({ path: `/raw/dailynotes/${date}.md`, ...fields });

const board = (tasks, options = {}) =>
  groupTasksIntoBoard(tasks, sanitizeSections(DEFAULT_SECTIONS), {
    today: TODAY,
    dailyNoteFolder: '/raw/dailynotes',
    ...options
  });

const lane = (result, key) => result.find((entry) => entry.key === key);
const textsIn = (result, key) =>
  lane(result, key).cards.map((card) => card.task.text);

test('ages a task by the date in its daily note filename', () => {
  assert.equal(taskAgeDays(daily('2026-08-04'), TODAY, '/raw/dailynotes'), 10);
  assert.equal(taskAgeDays(daily('2026-08-14'), TODAY, '/raw/dailynotes'), 0);
  // A note dated ahead of today is new, not negatively aged.
  assert.equal(taskAgeDays(daily('2026-09-01'), TODAY, '/raw/dailynotes'), 0);
});

test('falls back to the created date for a task outside the daily notes', () => {
  assert.equal(taskAgeDays(task({ created: '2026-07-15' }), TODAY), 30);
  assert.equal(taskAgeDays(task(), TODAY), null);
});

test('an overdue task outranks a top-priority undated one', () => {
  const overdue = scoreTask(task({ due: '2026-08-01' }), { today: TODAY });
  const flagged = scoreTask(task({ priority: 'highest' }), { today: TODAY });
  assert.equal(overdue.lane, 'now');
  assert.equal(flagged.lane, 'now');
  assert.ok(overdue.score > flagged.score);
});

test('a top-priority task reaches Now with no date at all', () => {
  assert.equal(
    scoreTask(task({ priority: 'highest' }), { today: TODAY }).lane,
    'now'
  );
  assert.equal(
    scoreTask(task({ priority: 'high' }), { today: TODAY }).lane,
    'soon'
  );
});

test('an old undated task sinks to Later while a fresh one reaches Soon', () => {
  const stale = scoreTask(daily('2026-05-01'), {
    today: TODAY,
    dailyNoteFolder: '/raw/dailynotes'
  });
  const fresh = scoreTask(daily('2026-08-13'), {
    today: TODAY,
    dailyNoteFolder: '/raw/dailynotes'
  });
  assert.equal(stale.lane, 'later');
  assert.equal(fresh.lane, 'soon');
});

test('a shelved section skips the urgency lanes however fresh it is', () => {
  const result = board([
    daily('2026-08-14', { text: 'Read this', tags: ['paper'] }),
    daily('2026-08-14', { text: 'Do this', due: TODAY })
  ]);
  assert.deepEqual(textsIn(result, 'shelf'), ['Read this']);
  assert.deepEqual(textsIn(result, 'now'), ['Do this']);
});

test('a shelved task with a date or a priority is let off the shelf', () => {
  const result = board([
    daily('2026-08-14', { text: 'Skim it', tags: ['paper'] }),
    daily('2026-08-14', {
      text: 'Read for Friday',
      tags: ['paper'],
      due: TODAY
    }),
    daily('2026-08-14', {
      text: 'Chase this idea',
      tags: ['idea'],
      priority: 'highest'
    })
  ]);
  assert.deepEqual(textsIn(result, 'shelf'), ['Skim it']);
  assert.deepEqual(textsIn(result, 'now'), [
    'Read for Friday',
    'Chase this idea'
  ]);
});

test('the catch-all section is never shelved, even if stored that way', () => {
  const sections = sanitizeSections(
    DEFAULT_SECTIONS.map((section) => ({ ...section, shelf: true }))
  );
  assert.equal(sections.at(-1).catchAll, true);
  assert.equal(sections.at(-1).shelf, false);
});

test('a config saved before the board keeps papers and ideas on the shelf', () => {
  const stored = sanitizeSections(
    DEFAULT_SECTIONS.map(({ shelf, ...section }) => section)
  );
  const shelved = stored
    .filter((section) => section.shelf)
    .map((section) => section.id);
  assert.deepEqual(shelved, ['ideas', 'papers', 'software']);
});

test('lanes are ordered by score, highest first', () => {
  const result = board([
    daily('2026-08-14', { text: 'Due today' }),
    daily('2026-08-14', { text: 'Overdue', due: '2026-08-10' }),
    daily('2026-08-14', { text: 'Flagged', priority: 'highest' })
  ]);
  assert.deepEqual(textsIn(result, 'now'), ['Overdue', 'Flagged']);
  assert.deepEqual(textsIn(result, 'soon'), ['Due today']);
});

test('a card carries its section and, in a daily note, its project heading', () => {
  const [card] = lane(
    board([
      daily('2026-08-14', {
        text: 'Ship it',
        headings: ['', '', 'IaaS'],
        priority: 'highest'
      })
    ]),
    'now'
  ).cards;
  assert.equal(card.sectionLabel, 'Other tasks');
  assert.equal(card.projectLabel, 'IaaS');
  assert.equal(card.age, 'fresh');
});

test('filters on prose, tags, headings, and path alike', () => {
  const tasks = [
    task({ text: 'Try the GNLarge model' }),
    task({ text: 'Something else', tags: ['iaas-daod'] }),
    task({ text: 'Third', headings: ['', '', 'Fundra'] }),
    task({ text: 'Fourth', path: '/raw/dailynotes/2026-08-06.md' })
  ];
  assert.deepEqual(
    filterTasks(tasks, 'gnl').map((entry) => entry.text),
    ['Try the GNLarge model']
  );
  assert.deepEqual(
    filterTasks(tasks, '#iaas-daod').map((entry) => entry.text),
    ['Something else']
  );
  assert.deepEqual(
    filterTasks(tasks, 'fundra').map((entry) => entry.text),
    ['Third']
  );
  assert.deepEqual(
    filterTasks(tasks, '2026-08-06').map((entry) => entry.text),
    ['Fourth']
  );
  assert.equal(filterTasks(tasks, '  ').length, 4);
});

test('who: filters on the assignee, and who: alone on having one', () => {
  const tasks = [
    task({ text: 'Update the metrics', assignee: 'julien' }),
    task({ text: 'Ask Julien about the metrics' }),
    task({ text: 'Write the summary', assignee: 'sam' })
  ];
  assert.deepEqual(
    filterTasks(tasks, 'who:julien').map((entry) => entry.text),
    ['Update the metrics']
  );
  assert.deepEqual(
    filterTasks(tasks, 'who:').map((entry) => entry.text),
    ['Update the metrics', 'Write the summary']
  );
  // Plain text still finds the assignee, and the task that merely says the name.
  assert.equal(filterTasks(tasks, 'julien').length, 2);
});

test('every lane is returned, empty ones included, in a fixed order', () => {
  const result = board([]);
  assert.deepEqual(
    result.map((entry) => entry.key),
    LANES.map((entry) => entry.key)
  );
  assert.ok(result.every((entry) => entry.count === 0));
});

test('completed tasks stay out until they are asked for', () => {
  const tasks = [daily('2026-08-14', { text: 'Done', checked: true })];
  assert.equal(
    board(tasks).reduce((total, entry) => total + entry.count, 0),
    0
  );
  assert.equal(
    board(tasks, { includeDone: true }).reduce(
      (total, entry) => total + entry.count,
      0
    ),
    1
  );
});

test('bands an age into the four inks the board sets cards in', () => {
  assert.equal(ageBand(null), '');
  assert.equal(ageBand(0), 'fresh');
  assert.equal(ageBand(30), 'warm');
  assert.equal(ageBand(90), 'cool');
  assert.equal(ageBand(91), 'cold');
});
