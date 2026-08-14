import assert from 'node:assert/strict';
import test from 'node:test';
import {
  carriedTaskLines,
  clearCompletion,
  collectTasks,
  expandTaskShorthand,
  extractTags,
  formatTaskFields,
  groupTasksByUrgency,
  parseTaskFields,
  resolveShorthandDate,
  sortTasks,
  stampCompletion,
  taskLinkSegments,
  taskProgress,
  taskShorthandEdits,
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

test('pulls inline tags off a task, lowercased and deduped', () => {
  assert.deepEqual(extractTags('Read the GNN paper #Paper #paper #ml/graphs'), {
    text: 'Read the GNN paper',
    tags: ['paper', 'ml/graphs']
  });
});

test('leaves a hash that is not a tag alone', () => {
  assert.deepEqual(
    extractTags('Skim example.com/page#results, then rate C# #software'),
    { text: 'Skim example.com/page#results, then rate C#', tags: ['software'] }
  );
});

test('does not read an issue reference as a tag', () => {
  assert.deepEqual(extractTags('Close #123 #bug'), {
    text: 'Close #123',
    tags: ['bug']
  });
});

test('keeps the written text and offers a tag-free version for display', () => {
  const [task] = collectTasks(
    '- [ ] Read the transformer paper #paper 📅 2026-08-20'
  );
  assert.equal(task.text, 'Read the transformer paper #paper');
  assert.equal(task.displayText, 'Read the transformer paper');
  assert.deepEqual(task.tags, ['paper']);
  assert.equal(task.due, '2026-08-20');
});

test('carries a task over with its tags intact', () => {
  assert.deepEqual(carriedTaskLines('- [ ] Read it #Paper', '2026-08-13'), [
    '- [ ] Read it #Paper ↩ [[2026-08-13]]'
  ]);
});

test('splits a markdown link out of a task, keeping only its text', () => {
  assert.deepEqual(
    taskLinkSegments(
      'Read [the paper](https://arxiv.org/abs/1706.03762) again'
    ),
    [
      { type: 'text', text: 'Read ' },
      {
        type: 'link',
        text: 'the paper',
        href: 'https://arxiv.org/abs/1706.03762'
      },
      { type: 'text', text: ' again' }
    ]
  );
});

test('leaves a task with no link as a single run of text', () => {
  assert.deepEqual(taskLinkSegments('Email Sarah'), [
    { type: 'text', text: 'Email Sarah' }
  ]);
  assert.deepEqual(taskLinkSegments(''), []);
});

test('leaves a link the browser should not follow as plain text', () => {
  assert.deepEqual(taskLinkSegments('Try [this](javascript:alert(1)) out'), [
    { type: 'text', text: 'Try [this](javascript:alert(1)) out' }
  ]);
});

test('keeps bracket text that is not a link exactly as written', () => {
  assert.deepEqual(taskLinkSegments('Check [draft] and [[Note]] today'), [
    { type: 'text', text: 'Check [draft] and [[Note]] today' }
  ]);
});

test('records the headings a task sits under, by level', () => {
  const content = [
    '# Daily',
    '## Tracking detector',
    '### Meetings',
    '- [ ] Prepare slides',
    '## Reading',
    '- [ ] Skim the paper'
  ].join('\n');
  const [slides, paper] = collectTasks(content);
  assert.deepEqual(slides.headings.slice(1, 4), [
    'Daily',
    'Tracking detector',
    'Meetings'
  ]);
  // The second `##` closes the `###` it opened above.
  assert.deepEqual(paper.headings.slice(1, 4), ['Daily', 'Reading', '']);
});

test('ignores a heading inside a fenced code block', () => {
  const content = ['## Real', '```', '## Example', '```', '- [ ] Work'].join(
    '\n'
  );
  assert.equal(collectTasks(content)[0].headings[2], 'Real');
});

test('gives every task in a note its frontmatter tags', () => {
  const content = [
    '---',
    'tags: [Paper, reading]',
    '---',
    '- [ ] Skim it'
  ].join('\n');
  assert.deepEqual(collectTasks(content)[0].noteTags, ['paper', 'reading']);
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

// 2026-08-14 is a Friday, which the weekday cases below lean on.
const FRIDAY = '2026-08-14';

test('expands typed shorthand into the emoji convention', () => {
  assert.equal(
    expandTaskShorthand(
      '- [ ] Submit the abstract due:2026-08-20 :p2:',
      FRIDAY
    ),
    '- [ ] Submit the abstract ⏫ 📅 2026-08-20'
  );
});

test('keeps a task line that carries no shorthand byte for byte', () => {
  const line = '  - [x]   Draft   outline ✅ 2026-08-14';
  assert.equal(expandTaskShorthand(line, FRIDAY), line);
  assert.deepEqual(taskShorthandEdits(line, FRIDAY), []);
});

test('shorthand overrides a field the line already carries', () => {
  assert.equal(
    expandTaskShorthand('- [ ] Ship it 📅 2026-08-30 due:today', FRIDAY),
    '- [ ] Ship it 📅 2026-08-14'
  );
});

test('resolves relative and weekday shorthand dates', () => {
  assert.equal(resolveShorthandDate('today', FRIDAY), '2026-08-14');
  assert.equal(resolveShorthandDate('tomorrow', FRIDAY), '2026-08-15');
  assert.equal(resolveShorthandDate('yesterday', FRIDAY), '2026-08-13');
  assert.equal(resolveShorthandDate('+3d', FRIDAY), '2026-08-17');
  assert.equal(resolveShorthandDate('+2w', FRIDAY), '2026-08-28');
  assert.equal(resolveShorthandDate('MONDAY', FRIDAY), '2026-08-17');
  assert.equal(resolveShorthandDate('mon', FRIDAY), '2026-08-17');
  // The same weekday means the next one, never today.
  assert.equal(resolveShorthandDate('friday', FRIDAY), '2026-08-21');
  assert.equal(resolveShorthandDate('2026-02-30', FRIDAY), '');
  assert.equal(resolveShorthandDate('someday', FRIDAY), '');
});

test('leaves unrecognised shorthand in the task text', () => {
  const line = '- [ ] Ask about due:someday :p9:';
  assert.equal(expandTaskShorthand(line, FRIDAY), line);
});

test('leaves a bare priority word alone in the task text', () => {
  const line = '- [ ] Fix the p2 bug due:today';
  assert.equal(
    expandTaskShorthand(line, FRIDAY),
    '- [ ] Fix the p2 bug 📅 2026-08-14'
  );
});

test('ignores shorthand outside tasks and inside code fences', () => {
  const content = [
    'Notes about due:tomorrow in prose.',
    '',
    '```markdown',
    '- [ ] Example due:tomorrow',
    '```',
    '',
    '- [ ] Real work due:tomorrow'
  ].join('\n');
  assert.deepEqual(taskShorthandEdits(content, FRIDAY), [
    { line: 6, text: '- [ ] Real work 📅 2026-08-15' }
  ]);
});

test('expands shorthand under frontmatter and keeps the origin link last', () => {
  const content = [
    '---',
    'tags: [work]',
    '---',
    '',
    '- [ ] Email Sarah due:mon :p1: ↩ [[2026-08-11]]'
  ].join('\n');
  assert.deepEqual(taskShorthandEdits(content, FRIDAY), [
    {
      line: 4,
      text: '- [ ] Email Sarah 🔺 📅 2026-08-17 ↩ [[2026-08-11]]'
    }
  ]);
});

test('reads typed priority shorthand as a priority before it is expanded', () => {
  const [task] = collectTasks('- [ ] Ship the abstract :p1:');
  assert.equal(task.priority, 'highest');
  assert.equal(task.text, 'Ship the abstract');
});

test('an emoji priority wins over shorthand on the same line', () => {
  const [task] = collectTasks('- [ ] Ship it 🔽 :p1:');
  assert.equal(task.priority, 'low');
});

test('leaves shorthand that is not a bare priority in the text', () => {
  const [task] = collectTasks('- [ ] Fix the :p1:. typo');
  assert.equal(task.priority, '');
  assert.equal(task.text, 'Fix the :p1:. typo');
});
