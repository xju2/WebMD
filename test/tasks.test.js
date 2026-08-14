import assert from 'node:assert/strict';
import test from 'node:test';
import {
  carriedTaskLines,
  clearCompletion,
  collectTasks,
  formatTaskFields,
  groupTasksByUrgency,
  parseTaskFields,
  sortTasks,
  stampCompletion,
  taskProgress,
  taskUrgency,
  toggleTaskLine
} from '../src/tasks.js';

test('splits task metadata off the task text', () => {
  const fields = parseTaskFields(
    'Submit the abstract ➕ 2026-08-01 📅 2026-08-20 ✅ 2026-08-14 ⏫'
  );
  assert.deepEqual(fields, {
    text: 'Submit the abstract',
    created: '2026-08-01',
    due: '2026-08-20',
    done: '2026-08-14',
    priority: 'high',
    origin: ''
  });
});

test('leaves unrecognised and malformed fields in the text', () => {
  const fields = parseTaskFields('Ship it 📅 2026-02-30 🔁 every week');
  assert.equal(fields.due, '');
  assert.equal(fields.text, 'Ship it 📅 2026-02-30 🔁 every week');
});

test('keeps a duplicate field rather than dropping it silently', () => {
  const fields = parseTaskFields('Ship it 📅 2026-08-20 📅 2026-09-01');
  assert.equal(fields.due, '2026-08-20');
  assert.equal(fields.text, 'Ship it 📅 2026-09-01');
});

test('round-trips task fields through the canonical order', () => {
  const line =
    'Draft outline ➕ 2026-08-01 📅 2026-08-10 ✅ 2026-08-14 ↩ [[2026-08-02]]';
  const fields = parseTaskFields(line);
  assert.equal(
    formatTaskFields(fields.text, { ...fields, priority: 'low' }),
    'Draft outline 🔽 ➕ 2026-08-01 📅 2026-08-10 ✅ 2026-08-14 ↩ [[2026-08-02]]'
  );
});

test('stamps the completion date when a box is checked', () => {
  assert.equal(
    toggleTaskLine('  - [ ] Email Sarah 📅 2026-08-20', '2026-08-14'),
    '  - [x] Email Sarah 📅 2026-08-20 ✅ 2026-08-14'
  );
});

test('removes the completion date when a box is unchecked', () => {
  assert.equal(
    toggleTaskLine(
      '  - [x] Email Sarah 📅 2026-08-20 ✅ 2026-08-14',
      '2026-08-15'
    ),
    '  - [ ] Email Sarah 📅 2026-08-20'
  );
});

test('toggling twice returns the original line', () => {
  const line = '> 1. [ ] Nested task ⏫';
  const stamped = toggleTaskLine(line, '2026-08-14');
  assert.equal(stamped, '> 1. [x] Nested task ⏫ ✅ 2026-08-14');
  assert.equal(toggleTaskLine(stamped, '2026-08-14'), line);
});

test('keeps the origin backlink after the completion stamp', () => {
  assert.equal(
    stampCompletion('Email Sarah ↩ [[2026-08-11]]', '2026-08-14'),
    'Email Sarah ✅ 2026-08-14 ↩ [[2026-08-11]]'
  );
});

test('refreshes an existing completion date instead of adding a second', () => {
  assert.equal(
    stampCompletion('Email Sarah ✅ 2026-08-01', '2026-08-14'),
    'Email Sarah ✅ 2026-08-14'
  );
  assert.equal(clearCompletion('Email Sarah ✅ 2026-08-14'), 'Email Sarah');
});

test('leaves lines that are not tasks alone', () => {
  assert.equal(
    toggleTaskLine('- just a bullet', '2026-08-14'),
    '- just a bullet'
  );
  assert.equal(toggleTaskLine('# [ ] heading', '2026-08-14'), '# [ ] heading');
});

test('collects tasks with their source lines', () => {
  const content = [
    '---',
    'title: Plan',
    '---',
    '# Plan',
    '',
    '- [ ] Open',
    '- [x] Done ✅ 2026-08-14'
  ].join('\n');
  assert.deepEqual(
    collectTasks(content).map((task) => [task.line, task.checked, task.text]),
    [
      [5, false, 'Open'],
      [6, true, 'Done']
    ]
  );
});

test('ignores tasks inside fenced code blocks', () => {
  const content = [
    '- [ ] Real',
    '```markdown',
    '- [ ] Example',
    '```',
    '- [ ] Also real'
  ].join('\n');
  assert.deepEqual(
    collectTasks(content).map((task) => task.text),
    ['Real', 'Also real']
  );
});

test('grades a due date against today', () => {
  assert.equal(taskUrgency('2026-08-13', '2026-08-14'), 'overdue');
  assert.equal(taskUrgency('2026-08-14', '2026-08-14'), 'today');
  assert.equal(taskUrgency('2026-08-21', '2026-08-14'), 'soon');
  assert.equal(taskUrgency('2026-08-22', '2026-08-14'), 'later');
  assert.equal(taskUrgency('', '2026-08-14'), '');
});

test('sorts by due date, then priority, and puts undated tasks last', () => {
  const tasks = [
    { due: '', priority: 'high', path: 'a.md', line: 1 },
    { due: '2026-08-20', priority: 'low', path: 'a.md', line: 2 },
    { due: '2026-08-20', priority: 'highest', path: 'a.md', line: 3 },
    { due: '2026-08-12', priority: '', path: 'a.md', line: 4 }
  ];
  assert.deepEqual(
    sortTasks(tasks).map((task) => task.line),
    [4, 3, 2, 1]
  );
});

test('groups tasks by urgency and drops empty groups', () => {
  const groups = groupTasksByUrgency(
    [
      { due: '2026-08-12', line: 1 },
      { due: '2026-08-14', line: 2 },
      { due: '', line: 3 }
    ],
    '2026-08-14'
  );
  assert.deepEqual(
    groups.map((group) => [group.key, group.tasks.length]),
    [
      ['overdue', 1],
      ['today', 1],
      ['', 1]
    ]
  );
});

test('carries unfinished tasks forward and tags where they came from', () => {
  const content = [
    '- [ ] Email Sarah 📅 2026-08-12 ⏫',
    '- [x] Finished ✅ 2026-08-13',
    '- [ ] Fix the build ↩ [[2026-08-09]]'
  ].join('\n');
  assert.deepEqual(carriedTaskLines(content, '2026-08-13'), [
    '- [ ] Email Sarah ⏫ 📅 2026-08-12 ↩ [[2026-08-13]]',
    '- [ ] Fix the build ↩ [[2026-08-09]]'
  ]);
});

test('drops the completion stamp from a carried task', () => {
  assert.deepEqual(
    carriedTaskLines('- [ ] Reopened ✅ 2026-08-10', '2026-08-13'),
    ['- [ ] Reopened ↩ [[2026-08-13]]']
  );
});

test('counts progress across a note', () => {
  assert.deepEqual(taskProgress(collectTasks('- [x] a\n- [ ] b\n- [x] c')), {
    done: 2,
    total: 3
  });
});
