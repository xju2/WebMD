import { parseFrontmatter } from './frontmatter.js';

// Task metadata follows the Obsidian Tasks emoji convention, so a note stays
// readable as plain text and portable to other Markdown tools:
//
//   - [ ] Submit the abstract 📅 2026-08-20 ⏫
//   - [x] Draft outline ➕ 2026-08-01 📅 2026-08-10 ✅ 2026-08-14
//
// `↩ [[origin]]` is WebMD's own addition, recording the note a carried-over
// task came from. Recurring tasks (🔁) are not supported.

const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const DATE_FIELDS = { '➕': 'created', '📅': 'due', '✅': 'done' };
const PRIORITIES = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '⏬': 'lowest'
};
const PRIORITY_RANK = {
  highest: 0,
  high: 1,
  medium: 2,
  '': 3,
  low: 4,
  lowest: 5
};

const DATE_FIELD_PATTERN = new RegExp(`([➕📅✅])\\s*(${DATE})`, 'gu');
const PRIORITY_PATTERN = /[🔺⏫🔼🔽⏬]/gu;
const ORIGIN_PATTERN = /↩\s*\[\[([^\]\n]+)\]\]/u;
const ORIGIN_TAIL = /(\s*↩\s*\[\[[^\]\n]+\]\])\s*$/u;
const DONE_PATTERN = new RegExp(`✅\\s*${DATE}`, 'u');
const DONE_TAIL = new RegExp(`\\s*✅\\s*${DATE}`, 'u');

// The checkbox itself, split so a line can be rewritten without disturbing the
// indentation, list marker, or blockquote prefix the author used.
const TASK_LINE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s*)(.*)$/;
const FENCE = /^\s*(```|~~~)/;

// Inline #tags, Obsidian style. The `#` has to open a word, so a URL fragment
// (`example.com/page#top`) and a name like `C#` are left alone, and a tag needs
// at least one letter, so `#123` stays an issue reference.
const TAG_PATTERN = /(^|\s)#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const MAX_HEADING_LEVEL = 6;

// Typing shorthand, so the emoji never have to be typed at all: `due:friday`
// and `p2` on a task line become `📅 <date>` and `⏫` once the caret leaves the
// line. Only the emoji are stored, so a note stays plain Obsidian syntax.
const SHORTHAND_FIELDS = {
  due: 'due',
  created: 'created',
  added: 'created',
  done: 'done'
};
const SHORTHAND_DATE = /(^|\s)(due|created|added|done):(\S+)/giu;
const SHORTHAND_PRIORITY = /(^|\s)p([1-5])(?=\s|$)/giu;
const PRIORITY_BY_LEVEL = ['highest', 'high', 'medium', 'low', 'lowest'];
const RELATIVE_DAYS = { yesterday: -1, today: 0, tod: 0, tomorrow: 1, tmr: 1 };
const OFFSET_SHORTHAND = /^\+(\d+)([dw])$/;
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday'
];

/**
 * Splits a task's text into its plain prose and its metadata fields. Anything
 * unrecognised — including a malformed date or a second copy of a field — is
 * left in `text` rather than silently dropped.
 */
export function parseTaskFields(text = '') {
  const fields = { created: '', due: '', done: '', priority: '', origin: '' };
  let rest = String(text);

  rest = rest.replace(DATE_FIELD_PATTERN, (match, mark, date) => {
    const key = DATE_FIELDS[mark];
    if (fields[key] || !isDateText(date)) return match;
    fields[key] = date;
    return ' ';
  });

  rest = rest.replace(PRIORITY_PATTERN, (match) => {
    if (fields.priority) return match;
    fields.priority = PRIORITIES[match];
    return ' ';
  });

  rest = rest.replace(ORIGIN_PATTERN, (match, target) => {
    fields.origin = target.trim();
    return ' ';
  });

  return { ...fields, text: rest.replace(/\s{2,}/g, ' ').trim() };
}

/** The inverse of parseTaskFields, in the field order Obsidian writes. */
export function formatTaskFields(text = '', fields = {}) {
  const priority = Object.keys(PRIORITIES).find(
    (mark) => PRIORITIES[mark] === fields.priority
  );
  return [
    String(text).trim(),
    priority,
    fields.created && `➕ ${fields.created}`,
    fields.due && `📅 ${fields.due}`,
    fields.done && `✅ ${fields.done}`,
    fields.origin && `↩ [[${fields.origin}]]`
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Rewrites the task lines of a note that use typing shorthand, as a list of
 * `{ line, text }` replacements against `content`'s 0-based lines. Returned as
 * edits rather than a new document so the editor can apply them without
 * disturbing the caret, and can hold back the line still being typed.
 *
 * Only lines that actually carry shorthand appear, so a task the author has
 * hand-formatted is never reflowed.
 */
export function taskShorthandEdits(content = '', todayText = '') {
  const { body, bodyLine } = parseFrontmatter(content);
  const edits = [];
  let fence = '';

  body.split('\n').forEach((line, index) => {
    const marker = FENCE.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1] === fence) fence = '';
      return;
    }
    if (fence) return;

    const match = TASK_LINE.exec(line);
    if (!match) return;

    const [, prefix, mark, gap, taskBody] = match;
    const expanded = expandTaskBody(taskBody, todayText);
    if (expanded === taskBody) return;
    edits.push({
      line: bodyLine + index,
      text: `${prefix}${mark}${gap}${expanded}`
    });
  });

  return edits;
}

/** taskShorthandEdits applied to the whole note. */
export function expandTaskShorthand(content = '', todayText = '') {
  const edits = taskShorthandEdits(content, todayText);
  if (!edits.length) return content;

  const lines = content.split('\n');
  edits.forEach((edit) => {
    lines[edit.line] = edit.text;
  });
  return lines.join('\n');
}

// Shorthand that resolves to nothing recognisable — a typo, or a word that
// merely looks like a field — is left alone rather than guessed at, so the
// author sees it stay put and can fix it.
function expandTaskBody(body, todayText) {
  const overrides = {};
  let rest = body;

  rest = rest.replace(SHORTHAND_DATE, (match, lead, name, value) => {
    const date = resolveShorthandDate(value, todayText);
    if (!date) return match;
    overrides[SHORTHAND_FIELDS[name.toLowerCase()]] = date;
    return lead;
  });

  rest = rest.replace(SHORTHAND_PRIORITY, (match, lead, level) => {
    overrides.priority = PRIORITY_BY_LEVEL[Number(level) - 1];
    return lead;
  });

  if (!Object.keys(overrides).length) return body;

  const fields = parseTaskFields(rest);
  return formatTaskFields(fields.text, { ...fields, ...overrides });
}

/**
 * A shorthand date value as `YYYY-MM-DD`, or '' when it means nothing. Accepts
 * a plain date, `today`/`tomorrow`/`yesterday`, an offset such as `+3d` or
 * `+2w`, and a weekday name or its three-letter form, which reads as the next
 * one still to come — `friday` on a Friday is a week away, not today.
 */
export function resolveShorthandDate(value = '', todayText = '') {
  const text = String(value).trim().toLowerCase();
  if (isDateText(text)) return text;
  if (!isDateText(todayText)) return '';

  if (Object.hasOwn(RELATIVE_DAYS, text))
    return shiftDateText(todayText, RELATIVE_DAYS[text]);

  const offset = OFFSET_SHORTHAND.exec(text);
  if (offset)
    return shiftDateText(
      todayText,
      Number(offset[1]) * (offset[2] === 'w' ? 7 : 1)
    );

  const weekday = WEEKDAYS.findIndex(
    (name) => name === text || (text.length === 3 && name.startsWith(text))
  );
  if (weekday < 0) return '';

  const [year, month, day] = todayText.split('-').map(Number);
  const current = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return shiftDateText(todayText, ((weekday - current + 6) % 7) + 1);
}

/**
 * Flips one task line and keeps its completion stamp in step: checking adds
 * `✅ <today>`, unchecking removes it. Everything else on the line is preserved
 * byte for byte, so this never reformats what the author typed.
 */
export function toggleTaskLine(line = '', todayText = '') {
  const match = TASK_LINE.exec(line);
  if (!match) return line;

  const [, prefix, mark, gap, body] = match;
  const checked = mark.toLowerCase() === 'x';
  const nextBody = checked
    ? clearCompletion(body)
    : stampCompletion(body, todayText);
  return `${prefix}${checked ? ' ' : 'x'}${gap}${nextBody}`;
}

/** Adds or refreshes `✅ <date>`, keeping any `↩` origin link last. */
export function stampCompletion(body = '', dateText = '') {
  if (!isDateText(dateText)) return body;
  if (DONE_PATTERN.test(body))
    return body.replace(DONE_PATTERN, `✅ ${dateText}`);

  const origin = ORIGIN_TAIL.exec(body);
  if (origin) {
    return `${body.slice(0, origin.index).trimEnd()} ✅ ${dateText}${origin[1]}`;
  }
  return `${body.trimEnd()} ✅ ${dateText}`.trimStart();
}

export function clearCompletion(body = '') {
  return body.replace(DONE_TAIL, '').trimEnd();
}

/**
 * Pulls inline `#tags` out of a task's prose, lowercased and deduped, and
 * returns the prose without them. `collectTasks` keeps both: `text` stays
 * exactly what the author wrote, so carrying a task into tomorrow's note never
 * drops its tags, while `displayText` is what the Tasks view shows once the
 * section heading already says `#paper`.
 */
export function extractTags(text = '') {
  const tags = [];
  const rest = String(text).replace(TAG_PATTERN, (match, lead, tag) => {
    const value = tag.toLowerCase();
    if (!tags.includes(value)) tags.push(value);
    return lead;
  });
  return { text: rest.replace(/\s{2,}/g, ' ').trim(), tags };
}

/**
 * A task's text split into plain runs and Markdown links, so the Tasks view can
 * show `[the paper](https://arxiv.org/…)` as just "the paper" without losing
 * the ability to open it. Only links are recognised — every other character is
 * left exactly as written, because a task row is not a Markdown preview.
 */
export function taskLinkSegments(text = '') {
  const source = String(text);
  const segments = [];
  let last = 0;

  const push = (value) => {
    if (!value) return;
    const previous = segments[segments.length - 1];
    if (previous?.type === 'text') previous.text += value;
    else segments.push({ type: 'text', text: value });
  };

  for (const match of source.matchAll(MARKDOWN_LINK)) {
    push(source.slice(last, match.index));
    const href = safeTaskHref(match[2]);
    // A link the browser should not follow stays on the row as plain text
    // rather than quietly vanishing.
    if (href) segments.push({ type: 'link', text: match[1], href });
    else push(match[0]);
    last = match.index + match[0].length;
  }

  push(source.slice(last));
  return segments;
}

// Mirrors safeHref in markdown.js. Kept local because markdown.js already
// imports this module, and a cycle between them is not worth one regex.
function safeTaskHref(href) {
  const trimmed = href.trim();
  return /^(https?:|mailto:|#|\/)/i.test(trimmed) ? trimmed : '';
}

/** A note's frontmatter `tags:`, lowercased, however it was written. */
export function noteTagsOf(attributes = {}) {
  const raw = attributes?.tags;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((tag) => String(tag).replace(/^#/, '').toLowerCase().trim())
    .filter(Boolean);
}

/**
 * Every task in a note, with its 0-based source line. Fenced code blocks and
 * YAML frontmatter are skipped, so a `- [ ]` shown as an example is never
 * mistaken for real work.
 *
 * Each task also carries where it sits: its inline `tags`, the note's
 * `noteTags`, and `headings`, an array indexed by heading level, so
 * `headings[2]` is the `##` a task lives under — the project name, by
 * convention, in a daily note.
 */
export function collectTasks(content = '') {
  const { attributes, body, bodyLine } = parseFrontmatter(content);
  const noteTags = noteTagsOf(attributes);
  const tasks = [];
  const headings = new Array(MAX_HEADING_LEVEL + 1).fill('');
  let fence = '';

  body.split('\n').forEach((line, index) => {
    const marker = FENCE.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1] === fence) fence = '';
      return;
    }
    if (fence) return;

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      headings[level] = heading[2].trim();
      // A new section closes every subsection it opened above.
      headings.fill('', level + 1);
      return;
    }

    const match = TASK_LINE.exec(line);
    if (!match) return;

    const fields = parseTaskFields(match[4]);
    const { text: displayText, tags } = extractTags(fields.text);
    tasks.push({
      line: bodyLine + index,
      checked: match[2].toLowerCase() === 'x',
      ...fields,
      displayText,
      tags,
      noteTags,
      headings: [...headings]
    });
  });

  return tasks;
}

/**
 * How loudly a due date should read today. `soon` covers the next week, which
 * is the window the Tasks view groups as "This week".
 */
export function taskUrgency(due = '', todayText = '') {
  if (!isDateText(due) || !isDateText(todayText)) return '';
  if (due < todayText) return 'overdue';
  if (due === todayText) return 'today';
  return due <= shiftDateText(todayText, 7) ? 'soon' : 'later';
}

export const URGENCY_GROUPS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'soon', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: '', label: 'No date' }
];

/** Soonest first, undated last, priority then path breaking ties. */
export function sortTasks(tasks = []) {
  return [...tasks].sort(
    (left, right) =>
      Number(!left.due) - Number(!right.due) ||
      (left.due || '').localeCompare(right.due || '') ||
      PRIORITY_RANK[left.priority ?? ''] -
        PRIORITY_RANK[right.priority ?? ''] ||
      (left.path || '').localeCompare(right.path || '') ||
      left.line - right.line
  );
}

export function groupTasksByUrgency(tasks = [], todayText = '') {
  const sorted = sortTasks(tasks);
  return URGENCY_GROUPS.map(({ key, label }) => ({
    key,
    label,
    tasks: sorted.filter((task) => taskUrgency(task.due, todayText) === key)
  })).filter((group) => group.tasks.length);
}

/**
 * The `- [ ] …` lines to carry into a new note: every unfinished task in
 * `content`, tagged with where it came from. A task that already carries an
 * origin keeps it, so a backlog dragged across a week still points at the note
 * that first raised it rather than at yesterday.
 */
export function carriedTaskLines(content = '', originTarget = '') {
  return collectTasks(content)
    .filter((task) => !task.checked && task.text)
    .map(
      (task) =>
        `- [ ] ${formatTaskFields(task.text, {
          ...task,
          done: '',
          origin: task.origin || originTarget
        })}`
    );
}

export function taskProgress(tasks = []) {
  const done = tasks.filter((task) => task.checked).length;
  return { done, total: tasks.length };
}

/** "2026-08-20" as "Aug 20", for the compact pills in the preview. */
export function formatDueLabel(dateText = '') {
  if (!isDateText(dateText)) return '';
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString([], {
    month: 'short',
    day: 'numeric'
  });
}

export function priorityMark(priority = '') {
  return (
    Object.keys(PRIORITIES).find((mark) => PRIORITIES[mark] === priority) || ''
  );
}

// UTC arithmetic, so a day never gains or loses an hour to daylight saving.
function shiftDateText(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

// Rejects dates the calendar rolls forward, such as 2026-02-30.
function isDateText(value) {
  if (typeof value !== 'string' || !new RegExp(`^${DATE}$`).test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
