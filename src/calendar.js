export function calendarDays(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      date,
      currentMonth: date.getMonth() === month.getMonth(),
      today: sameDay(date, new Date())
    };
  });
}

/**
 * How much work lands on each day: open tasks counted by due date, keyed
 * 'YYYY-MM-DD'. The Tasks view buckets anything past next week into one "Later"
 * pile, so the month grid is the only place the shape of a busy Thursday shows.
 * Ticked tasks and tasks with no due date are nobody's workload.
 */
export function countTasksByDueDate(tasks = []) {
  const counts = new Map();
  for (const task of tasks) {
    // `due` is validated where it is parsed, so its presence is enough here.
    if (!task?.due || task.checked) continue;
    counts.set(task.due, (counts.get(task.due) ?? 0) + 1);
  }
  return counts;
}

/**
 * Calendar events keyed 'YYYY-MM-DD' by the reader's own day: a timed event
 * on the day it starts, an all-day one on every day it spans (its endDate is
 * exclusive, as in iCal). All-day events lead, the rest keep start order.
 */
export function eventsByDay(events = []) {
  const days = new Map();
  const add = (key, event) => {
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(event);
  };
  for (const event of events) {
    if (!event.allDay) {
      add(dailyNoteDate(new Date(event.startsAt)), event);
      continue;
    }
    const [year, month, day] = event.date.split('-').map(Number);
    // Capped so a months-long "on leave" block cannot stall the grid.
    for (let offset = 0; offset < 62; offset += 1) {
      const key = dailyNoteDate(new Date(year, month - 1, day + offset));
      if (offset && key >= event.endDate) break;
      add(key, event);
    }
  }
  for (const list of days.values()) {
    list.sort((a, b) => Number(b.allDay) - Number(a.allDay));
  }
  return days;
}

export function shiftMonth(month, amount) {
  return new Date(month.getFullYear(), month.getMonth() + amount, 1);
}

// Indexes the neighbouring daily note in a list ordered oldest to newest, or
// null at either end. With nothing daily open, stepping back reaches the
// newest note and stepping forward has nowhere to go.
export function stepDailyNote(count, index, step) {
  if (count <= 0) return null;
  if (index < 0 || index >= count) return step < 0 ? count - 1 : null;

  const next = index + (step < 0 ? -1 : 1);
  return next >= 0 && next < count ? next : null;
}

// The daily note to show beside `currentPath`: the next one older, or the newest
// note when `currentPath` is not itself a daily note. Never returns currentPath.
export function defaultReferencePath(paths, currentPath) {
  const index = paths.indexOf(currentPath);
  const target = stepDailyNote(paths.length, index, -1);
  return target === null ? '' : paths[target];
}

export function dailyNoteDateFromPath(path) {
  const name = String(path ?? '')
    .split('/')
    .pop();
  const match = /^(\d{4})-(\d{2})-(\d{2})\.(?:md|markdown)$/i.exec(name ?? '');
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  // Rejects impossible dates such as 2026-02-30, which Date rolls forward.
  return dailyNoteDate(date) === `${year}-${month}-${day}` ? date : null;
}

export function dailyNotePath(date, folder = '/') {
  const dateText = dailyNoteDate(date);
  return `${folder === '/' ? '' : folder}/${dateText}.md`;
}

export function dailyNoteDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const TEMPLATE_NAMES = new Set([
  'dailynotetemplate',
  'dailytemplate',
  'template'
]);

/**
 * The template to use when none has been picked by hand: a conventionally named
 * file — `dailynote_template.md`, `daily-template.md`, `template.md` and the
 * like — sitting in the daily note folder, or failing that at the workspace
 * root. Returns '' when the workspace has no such file.
 */
export function defaultDailyNoteTemplatePath(paths = [], folder = '/') {
  const folders = folder === '/' ? ['/'] : [folder, '/'];
  for (const candidate of folders) {
    const match = paths.find(
      (path) => templateFolder(path) === candidate && isTemplateName(path)
    );
    if (match) return match;
  }
  return '';
}

function templateFolder(path) {
  const parts = String(path ?? '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}

function isTemplateName(path) {
  const name = String(path ?? '')
    .split('/')
    .pop()
    .replace(/\.(md|markdown)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return TEMPLATE_NAMES.has(name);
}

/** True when the template asks for the AI-written quote of the day. */
export function templateNeedsQuote(template = '') {
  return String(template ?? '').includes('{{quote}}');
}

export function dailyNoteContent(date, filePath, template = '', quote = '') {
  const title = filePath.split('/').pop().replace(/\.md$/i, '');
  if (!template) return `# ${title}\n\n`;

  return template
    .replaceAll('{{quote}}', quote)
    .replaceAll('{{date}}', dailyNoteDate(date))
    .replaceAll('{{title}}', title)
    .replaceAll(
      '{{weekday}}',
      date.toLocaleDateString([], { weekday: 'long' })
    );
}

export function sameDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
