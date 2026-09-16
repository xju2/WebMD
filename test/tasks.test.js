import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearCompletion,
  collectTasks,
  displayAssignee,
  expandTaskShorthand,
  extractTags,
  formatDueChip,
  formatTaskFields,
  groupTasksByUrgency,
  parseTaskFields,
  priorityGlyph,
  resolveShorthandDate,
  sortTasks,
  stampCompletion,
  taskTextSegments,
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
    origin: '',
    assignees: []
  });
});

test('reads who: as the assignee and leaves the name in the text', () => {
  const fields = parseTaskFields(
    'who:Julien will update the scaling metrics 📅 2026-08-20'
  );
  assert.deepEqual(fields.assignees, ['julien']);
  assert.equal(fields.due, '2026-08-20');
  // The name is the sentence's subject, so it stays where it was written.
  assert.equal(fields.text, 'who:Julien will update the scaling metrics');
});

test('only a who: that opens a word, with a name, is an assignee', () => {
  assert.deepEqual(parseTaskFields('Ask who: about it').assignees, []);
  assert.deepEqual(parseTaskFields('See docs/who:-notes').assignees, []);
  assert.deepEqual(parseTaskFields('Ping who:mary-anne').assignees, [
    'mary-anne'
  ]);
});

test('a task can be assigned to several people at once', () => {
  const fields = parseTaskFields(
    'who:julien and who:jack will implement this feature'
  );
  assert.deepEqual(fields.assignees, ['julien', 'jack']);
  assert.equal(
    fields.text,
    'who:julien and who:jack will implement this feature'
  );
});

test('however the names are written, everyone named is picked up', () => {
  assert.deepEqual(
    parseTaskFields('Ship it who:julien, who:jack & who:sam + who:mary')
      .assignees,
    ['julien', 'jack', 'sam', 'mary']
  );
  assert.deepEqual(parseTaskFields('Ship it who:julien who:jack').assignees, [
    'julien',
    'jack'
  ]);
});

test('punctuation after a name belongs to the sentence, not the name', () => {
  const fields = parseTaskFields(
    'Support who:julien. For example, who:Julien updates the metrics'
  );
  // Both mentions are the same person: the full stop is not part of the name.
  assert.deepEqual(fields.assignees, ['julien']);
  assert.deepEqual(
    parseTaskFields('Ask who:mary-anne, then who:jack!').assignees,
    ['mary-anne', 'jack']
  );
  assert.deepEqual(parseTaskFields('Ping who:sam- and who:jo_').assignees, [
    'sam',
    'jo'
  ]);
});

test('the same person named twice is listed once', () => {
  assert.deepEqual(
    parseTaskFields('Review who:Julien and who:julien').assignees,
    ['julien']
  );
});

test('round-trips assignees alongside the emoji fields', () => {
  const line = 'who:Julien and who:jack update the metrics 📅 2026-08-20 ⏫';
  const fields = parseTaskFields(line);
  assert.equal(
    formatTaskFields(fields.text, fields),
    'who:Julien and who:jack update the metrics ⏫ 📅 2026-08-20'
  );
});

test('sets each who: name as its own segment, read as a name', () => {
  assert.deepEqual(taskTextSegments('Assign it to who:Julien.'), [
    { type: 'text', text: 'Assign it to ' },
    { type: 'assignee', text: 'Julien', name: 'julien' },
    { type: 'text', text: '.' }
  ]);
  // However fast it was typed, the chip reads as a name.
  assert.deepEqual(
    taskTextSegments(
      'who:julien and who:mary-anne will ship [it](https://x.dev)'
    ),
    [
      { type: 'assignee', text: 'Julien', name: 'julien' },
      { type: 'text', text: ' and ' },
      { type: 'assignee', text: 'Mary-Anne', name: 'mary-anne' },
      { type: 'text', text: ' will ship ' },
      { type: 'link', text: 'it', href: 'https://x.dev' }
    ]
  );
});

test('a name is raised for reading without flattening what was written', () => {
  assert.equal(displayAssignee('julien'), 'Julien');
  assert.equal(displayAssignee('mary-anne'), 'Mary-Anne');
  assert.equal(displayAssignee('McCarthy'), 'McCarthy');
  assert.equal(displayAssignee('j.smith'), 'J.Smith');
  assert.equal(displayAssignee(''), '');
});

test('a who: inside a link is part of the link, not an assignment', () => {
  assert.deepEqual(taskTextSegments('Read [who:me](https://x.dev/who:top)'), [
    { type: 'text', text: 'Read ' },
    { type: 'link', text: 'who:me', href: 'https://x.dev/who:top' }
  ]);
});

test('expanding date shorthand leaves the assignees where they are', () => {
  assert.equal(
    expandTaskShorthand(
      '- [ ] who:julien and who:jack ship it due:tomorrow',
      '2026-08-19'
    ),
    '- [ ] who:julien and who:jack ship it 📅 2026-08-20'
  );
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

test('splits a markdown link out of a task, keeping only its text', () => {
  assert.deepEqual(
    taskTextSegments(
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
  assert.deepEqual(taskTextSegments('Email Sarah'), [
    { type: 'text', text: 'Email Sarah' }
  ]);
  assert.deepEqual(taskTextSegments(''), []);
});

test('leaves a link the browser should not follow as plain text', () => {
  assert.deepEqual(taskTextSegments('Try [this](javascript:alert(1)) out'), [
    { type: 'text', text: 'Try [this](javascript:alert(1)) out' }
  ]);
});

test('keeps bracket text that is not a link exactly as written', () => {
  assert.deepEqual(taskTextSegments('Check [draft] and [[Note]] today'), [
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
    '- [ ] Submit the abstract who:me ⏫ 📅 2026-08-20'
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
    '- [ ] Ship it who:me 📅 2026-08-14'
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

test('resolves a year-less month-day shorthand date', () => {
  // FRIDAY is 2026-08-14.
  assert.equal(resolveShorthandDate('10-01', FRIDAY), '2026-10-01');
  assert.equal(resolveShorthandDate('8/14', FRIDAY), '2026-08-14');
  assert.equal(resolveShorthandDate('9/3', FRIDAY), '2026-09-03');
  // A day already past this year means the same day next year.
  assert.equal(resolveShorthandDate('01-05', FRIDAY), '2027-01-05');
  // A leap day looks ahead for a year that actually has one.
  assert.equal(resolveShorthandDate('02-29', FRIDAY), '2028-02-29');
  assert.equal(resolveShorthandDate('13-01', FRIDAY), '');
  assert.equal(resolveShorthandDate('10-32', FRIDAY), '');
});

test('expands a year-less due date on a task line', () => {
  assert.equal(
    expandTaskShorthand('- [ ] Ship it due:10-01', FRIDAY),
    '- [ ] Ship it who:me 📅 2026-10-01'
  );
});

test('leaves unrecognised shorthand in the task text', () => {
  const line = '- [ ] Ask about due:someday :p9: who:julien';
  assert.equal(expandTaskShorthand(line, FRIDAY), line);
});

test('leaves a bare priority word alone in the task text', () => {
  const line = '- [ ] Fix the p2 bug due:today';
  assert.equal(
    expandTaskShorthand(line, FRIDAY),
    '- [ ] Fix the p2 bug who:me 📅 2026-08-14'
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
    { line: 6, text: '- [ ] Real work who:me 📅 2026-08-15' }
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
      text: '- [ ] Email Sarah who:me 🔺 📅 2026-08-17 ↩ [[2026-08-11]]'
    }
  ]);
});

test('an open task defaults to who:me and a due date a week out', () => {
  assert.equal(
    expandTaskShorthand('- [ ] Water the plants', FRIDAY),
    '- [ ] Water the plants who:me 📅 2026-08-21'
  );
  assert.equal(
    expandTaskShorthand('- [ ] who:julien ships it 📅 2026-08-30', FRIDAY),
    '- [ ] who:julien ships it 📅 2026-08-30'
  );
  // Done tasks, empty checkboxes, and unresolved due typos get no defaults.
  assert.equal(expandTaskShorthand('- [x] Old work', FRIDAY), '- [x] Old work');
  assert.equal(expandTaskShorthand('- [ ] ', FRIDAY), '- [ ] ');
  assert.equal(
    expandTaskShorthand('- [ ] Ask due:someday', FRIDAY),
    '- [ ] Ask due:someday who:me'
  );
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

test('reads a due date the way a reader thinks about it', () => {
  const today = '2026-08-15';
  assert.equal(formatDueChip('2026-08-15', today), 'Today');
  assert.equal(formatDueChip('2026-08-16', today), 'Tomorrow');
  assert.equal(formatDueChip('2026-08-14', today), 'Yesterday');
  assert.equal(formatDueChip('2026-08-12', today), '3d late');
  // Inside the week a weekday name places the date better than a count does.
  assert.equal(formatDueChip('2026-08-17', today), 'Mon');
  assert.equal(formatDueChip('2026-08-20', today), 'Thu');
  assert.equal(formatDueChip('2026-08-21', today), 'Fri');
  // Past it, a weekday is ambiguous — "Fri" could be either of two Fridays.
  assert.equal(formatDueChip('2026-08-22', today), 'in 7d');
});

test('falls back to the absolute date where a relative one stops helping', () => {
  const today = '2026-08-15';
  // A month out, "in 47d" means nothing; the date itself does.
  assert.equal(formatDueChip('2026-09-14', today), 'Sep 14');
  // Same the other way, and an unbounded "412d late" would widen the rail.
  assert.equal(formatDueChip('2026-07-16', today), '30d late');
  assert.equal(formatDueChip('2026-07-15', today), 'Jul 15');
  assert.equal(formatDueChip('2026-08-20', ''), 'Aug 20');
  assert.equal(formatDueChip('', today), '');
  assert.equal(formatDueChip('someday', today), '');
});

test('ranks priority with geometric glyphs rather than emoji', () => {
  assert.equal(priorityGlyph('highest'), '▲');
  assert.equal(priorityGlyph('high'), '▲');
  assert.equal(priorityGlyph('medium'), '●');
  assert.equal(priorityGlyph('low'), '▼');
  assert.equal(priorityGlyph('lowest'), '▼');
  assert.equal(priorityGlyph(''), '');
  assert.equal(priorityGlyph(), '');
});
