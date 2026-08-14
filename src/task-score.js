import { daysBetween, sortTasks } from './tasks.js';
import {
  DEFAULT_SECTIONS,
  groupTasksIntoSections,
  isDailyNotePath,
  normalizeTerm,
  taskTerms
} from './task-sections.js';

// The board is the Tasks view's answer to a list that has grown past reading.
// Sections say what a task is about and the urgency groups say when it is due,
// but most tasks in a notebook are written without a date, so neither alone
// tells you what is live. The board scores every task on the three things a
// note actually carries — a due date, a priority mark, and how long ago it was
// written — and sorts the result into four short columns.
//
// Nothing here reads the DOM: the whole ranking is a pure function of the task
// list, the section config and today's date, so it can be tested directly.

export const LANES = [
  {
    key: 'now',
    label: 'Now',
    note: 'Overdue, due today, or flagged top priority.'
  },
  {
    key: 'soon',
    label: 'Soon',
    note: 'Dated soon, or raised in the last week.'
  },
  { key: 'later', label: 'Later', note: 'Real work, but nothing is pressing.' },
  {
    key: 'shelf',
    label: 'Shelf',
    note: 'Reading and ideas, whenever you get to them.'
  }
];

export const NOW_SCORE = 80;
export const SOON_SCORE = 30;

// A date is the strongest signal a task can carry, so it outweighs everything
// else: an overdue task reaches Now on its due date alone. The overdue bonus is
// capped, because a task three months late is not thirty times more urgent than
// one three days late — it is just late.
function dueScore(due, today) {
  const days = daysBetween(today, due);
  if (days === null) return 0;
  if (days < 0) return 100 + Math.min(-days, 30);
  if (days === 0) return 80;
  if (days <= 3) return 60;
  if (days <= 7) return 40;
  return days <= 30 ? 15 : 0;
}

// `:p1:` is how you say "this one" without inventing a deadline, so it reaches
// Now by itself. The low marks subtract, which is the only way to push a fresh
// task back down into Later.
export const PRIORITY_SCORE = {
  highest: 80,
  high: 45,
  medium: 20,
  '': 0,
  low: -15,
  lowest: -30
};

// Age cuts both ways. Something written this week is still on your mind and
// worth surfacing; something written two months ago and never dated is, by
// evidence, not urgent — and saying so is what keeps Now short.
function ageScore(ageDays) {
  if (ageDays === null) return 0;
  if (ageDays <= 3) return 35;
  if (ageDays <= 14) return 20;
  return ageDays > 60 ? -12 : 0;
}

/**
 * How many days ago a task was written: the date in its daily note's filename,
 * or its own `➕` created date for a task living anywhere else. Undatable tasks
 * return null and are scored as neither fresh nor stale.
 */
export function taskAgeDays(task = {}, today = '', dailyNoteFolder = '') {
  const path = task.path || '';
  const written = isDailyNotePath(path, dailyNoteFolder)
    ? (path.split('/').pop() || '').replace(/\.md$/, '')
    : task.created || '';
  const days = daysBetween(written, today);
  // A note dated in the future is not negative-aged, just new.
  return days === null ? null : Math.max(days, 0);
}

export function laneOf(score) {
  if (score >= NOW_SCORE) return 'now';
  return score >= SOON_SCORE ? 'soon' : 'later';
}

export function scoreTask(
  task = {},
  { today = '', dailyNoteFolder = '', shelf = false } = {}
) {
  const ageDays = taskAgeDays(task, today, dailyNoteFolder);
  const score =
    dueScore(task.due || '', today) +
    (PRIORITY_SCORE[task.priority || ''] ?? 0) +
    ageScore(ageDays);
  // A shelved section is reading, not work. Scoring it against a deadline it
  // never had would only push papers into Later and bury the actual backlog.
  //
  // Giving one a date or a priority is how you say this particular paper is
  // work now, so the shelf lets it go rather than holding it there. That makes
  // the flag a default filing instead of a cage.
  const shelved = shelf && !task.due && !task.priority;
  return { score, ageDays, lane: shelved ? 'shelf' : laneOf(score) };
}

/**
 * Which ink a card is set in. Age is the one signal with no pill of its own, so
 * the board says it by letting old work fade rather than adding another chip.
 */
export function ageBand(ageDays) {
  if (ageDays === null) return '';
  if (ageDays <= 7) return 'fresh';
  if (ageDays <= 30) return 'warm';
  return ageDays <= 90 ? 'cool' : 'cold';
}

/**
 * The filter box: one string against everything a task can be found by — its
 * prose, its tags, the headings it sits under, and its path. Deliberately a
 * substring match rather than the section machinery's whole-term matching, so
 * typing "gnl" finds "GNLarge" halfway through a word.
 */
export function filterTasks(tasks = [], filter = '') {
  const needle = normalizeTerm(filter);
  if (!needle) return tasks;

  return tasks.filter((task) =>
    [task.displayText || task.text || '', task.path || '', ...taskTerms(task)]
      .join(' ')
      .toLowerCase()
      .includes(needle)
  );
}

/**
 * The board: four lanes of cards, each card a task plus the context the row
 * form used to get from its surroundings — which section claimed it and which
 * project heading it sits under.
 *
 * Sections still do the filing, so a task lands on the Shelf for exactly the
 * reason it would land under "Interesting papers" in the sections view.
 */
export function groupTasksIntoBoard(
  tasks = [],
  sections = DEFAULT_SECTIONS,
  { today = '', dailyNoteFolder = '', includeDone = false, filter = '' } = {}
) {
  const shelved = new Set(
    sections.filter((section) => section.shelf).map((section) => section.id)
  );
  const lanes = new Map(LANES.map((lane) => [lane.key, []]));

  groupTasksIntoSections(filterTasks(tasks, filter), sections, {
    dailyNoteFolder,
    includeDone
  }).forEach((section) => {
    section.groups.forEach((group) => {
      group.tasks.forEach((task) => {
        const { score, lane, ageDays } = scoreTask(task, {
          today,
          dailyNoteFolder,
          shelf: shelved.has(section.id)
        });
        lanes.get(lane).push({
          task,
          score,
          ageDays,
          age: ageBand(ageDays),
          sectionLabel: section.label,
          projectLabel: group.kind === 'project' ? group.label : ''
        });
      });
    });
  });

  return LANES.map((lane) => ({
    ...lane,
    count: lanes.get(lane.key).length,
    cards: sortCards(lanes.get(lane.key))
  }));
}

// Highest score first, with the list view's own ordering breaking ties, so two
// tasks the board rates equally still read in a stable, familiar order.
function sortCards(cards) {
  const order = new Map(
    sortTasks(cards.map((card) => card.task)).map((task, index) => [
      task,
      index
    ])
  );
  return [...cards].sort(
    (left, right) =>
      right.score - left.score || order.get(left.task) - order.get(right.task)
  );
}
