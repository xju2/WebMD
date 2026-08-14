import { sortTasks } from './tasks.js';

// The Tasks view is a dashboard of sections, each one a small filter over the
// workspace's tasks. It replaces the Dataview queries a note like this needs in
// Obsidian:
//
//   TASK WHERE contains(tags, "#paper") GROUP BY file.link
//
// A task belongs to a section when one of its terms matches. Terms come from
// three places, so a note can be organised whichever way reads best: inline
// `#tags` on the line, the note's frontmatter `tags:`, and the headings the
// task sits under — a task under `## Papers` needs no tag at all.

export const SECTION_STATUSES = ['open', 'done', 'any'];

export const DEFAULT_SECTIONS = [
  {
    id: 'ideas',
    label: 'Ideas',
    include: ['idea'],
    exclude: [],
    status: 'open'
  },
  {
    id: 'papers',
    label: 'Interesting papers',
    include: ['paper'],
    exclude: [],
    status: 'open'
  },
  {
    id: 'software',
    label: 'Interesting software',
    include: ['software'],
    exclude: [],
    status: 'open'
  },
  {
    id: 'coding',
    label: 'Coding tasks',
    include: ['coding'],
    exclude: [],
    status: 'open'
  },
  {
    id: 'atlas',
    label: 'ATLAS-related',
    include: ['atlas'],
    exclude: [],
    status: 'open'
  },
  {
    id: 'other',
    label: 'Other tasks',
    include: [],
    exclude: [],
    status: 'open',
    catchAll: true
  }
];

const DAILY_NOTE_NAME = /^\d{4}-\d{2}-\d{2}(\.md)?$/;

/** Lowercased, `#` dropped, whitespace collapsed — `#Papers` and `Papers` agree. */
export function normalizeTerm(value = '') {
  return String(value)
    .trim()
    .replace(/^#/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// Singular and plural are the same category to a person writing notes, so
// `paper` matches `#papers` and a `## Papers` heading. Only a trailing "s" is
// considered, which leaves words that genuinely end in one — `atlas` — alone.
function termsMatch(left, right) {
  return left === right || left === `${right}s` || right === `${left}s`;
}

/**
 * Everything a task can be filed under: its inline tags, its note's tags, and
 * its enclosing headings. A heading also contributes its individual words, so
 * "Interesting papers" files under `paper` without being renamed.
 */
export function taskTerms(task = {}) {
  const terms = [];
  const add = (value) => {
    const term = normalizeTerm(value);
    if (term && !terms.includes(term)) terms.push(term);
  };

  (task.tags || []).forEach(add);
  (task.noteTags || []).forEach(add);
  (task.headings || []).filter(Boolean).forEach((heading) => {
    add(heading);
    normalizeTerm(heading).split(' ').forEach(add);
  });

  return terms;
}

function matchesStatus(task, status) {
  if (status === 'any') return true;
  if (status === 'done') return Boolean(task.checked);
  return !task.checked;
}

export function taskMatchesSection(task = {}, section = {}) {
  if (!matchesStatus(task, section.status || 'open')) return false;

  const terms = taskTerms(task);
  const has = (list) =>
    (list || []).some((entry) => {
      const term = normalizeTerm(entry);
      return term && terms.some((candidate) => termsMatch(candidate, term));
    });

  if (has(section.exclude)) return false;
  return section.include?.length ? has(section.include) : true;
}

export function isDailyNotePath(path = '', dailyNoteFolder = '') {
  const name = String(path).split('/').pop() || '';
  if (!DAILY_NOTE_NAME.test(name)) return false;

  const folder = String(dailyNoteFolder || '').replace(/\/+$/, '');
  return !folder || String(path).startsWith(`${folder}/`);
}

/**
 * Which pile a task belongs to inside a section. Notes group by file, but a
 * daily note is a diary of many projects, so its tasks group by the `##` they
 * sit under — the project name, by convention. A task written above any `##`
 * falls back to the note itself.
 */
export function sectionGroupKey(task = {}, dailyNoteFolder = '') {
  const path = task.path || '';
  if (isDailyNotePath(path, dailyNoteFolder) && task.headings?.[2]) {
    return {
      key: `project:${normalizeTerm(task.headings[2])}`,
      label: task.headings[2],
      kind: 'project'
    };
  }
  return { key: `file:${path}`, label: path, kind: 'file' };
}

/**
 * Files every task into the first section that claims it, leaving the rest to
 * whichever section is marked `catchAll` — so "Other tasks" stays correct as
 * sections are added, instead of needing its exclusions maintained by hand.
 */
export function groupTasksIntoSections(
  tasks = [],
  sections = DEFAULT_SECTIONS,
  { dailyNoteFolder = '', includeDone = false } = {}
) {
  // "Show completed" opens up every section that was only showing open work.
  // A section deliberately set to `done` is already an archive, so it is left
  // as it is.
  const applied = includeDone
    ? sections.map((section) =>
        section.status === 'done' ? section : { ...section, status: 'any' }
      )
    : sections;
  const buckets = sections.map(() => []);
  const catchAllIndex = applied.findIndex((section) => section.catchAll);

  tasks.forEach((task) => {
    const index = applied.findIndex(
      (section) => !section.catchAll && taskMatchesSection(task, section)
    );
    if (index !== -1) {
      buckets[index].push(task);
      return;
    }
    if (
      catchAllIndex !== -1 &&
      taskMatchesSection(task, applied[catchAllIndex])
    ) {
      buckets[catchAllIndex].push(task);
    }
  });

  return sections.map((section, index) => ({
    id: section.id,
    label: section.label,
    count: buckets[index].length,
    groups: groupBySource(buckets[index], dailyNoteFolder)
  }));
}

// Piles ordered by their most urgent task, so what needs doing first is on top.
function groupBySource(tasks, dailyNoteFolder) {
  const groups = new Map();

  sortTasks(tasks).forEach((task) => {
    const { key, label, kind } = sectionGroupKey(task, dailyNoteFolder);
    if (!groups.has(key)) groups.set(key, { key, label, kind, tasks: [] });
    groups.get(key).tasks.push(task);
  });

  return [...groups.values()].sort(
    (left, right) =>
      Number(!left.tasks[0].due) - Number(!right.tasks[0].due) ||
      (left.tasks[0].due || '').localeCompare(right.tasks[0].due || '') ||
      left.label.localeCompare(right.label)
  );
}

/**
 * Sections as read back from storage, where anything could be waiting. A stored
 * value that is not a usable list of sections falls back to the defaults rather
 * than leaving the view empty.
 */
export function sanitizeSections(value) {
  const list = Array.isArray(value)
    ? value.map(sanitizeSection).filter(Boolean)
    : [];
  if (!list.length) return DEFAULT_SECTIONS.map((section) => ({ ...section }));

  // Exactly one catch-all, and it goes last, where "everything else" reads. A
  // second one is demoted to an ordinary section rather than thrown away.
  const first = list.findIndex((section) => section.catchAll);
  const ordered = [
    ...list.filter((section, index) => index !== first),
    ...(first === -1 ? [] : [list[first]])
  ];
  return ordered.map((section, index) => ({
    ...section,
    catchAll: first !== -1 && index === ordered.length - 1,
    id: section.id || `section-${index + 1}`
  }));
}

function sanitizeSection(section) {
  if (!section || typeof section !== 'object') return null;
  const label = String(section.label ?? '').trim();
  if (!label) return null;

  return {
    id: typeof section.id === 'string' ? section.id : '',
    label,
    include: toTermList(section.include),
    exclude: toTermList(section.exclude),
    status: SECTION_STATUSES.includes(section.status) ? section.status : 'open',
    catchAll: Boolean(section.catchAll)
  };
}

function toTermList(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list.map(normalizeTerm).filter(Boolean))];
}

/** A section's terms as the comma-separated text the editor shows. */
export function formatTermList(terms = []) {
  return terms.join(', ');
}

export function parseTermList(text = '') {
  return toTermList(text);
}
