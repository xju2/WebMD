import { resolveShorthandDate } from './tasks.js';

// Typing snippets. `/name` followed by Tab is replaced with the text below, so
// what lands on disk is plain Markdown: nothing here is re-evaluated at render
// time, and `Last update: 2026-08-21` still says the day it was typed when the
// note is read a year later in git, Obsidian, or `cat`.
//
// `{date}`, `{time}`, `{tomorrow}` and `{yesterday}` are filled in as the
// snippet expands. `$0` marks where the caret lands; without it the caret ends
// up after the inserted text.
export const SNIPPETS = [
  { name: 'date', hint: 'today’s date', text: '{date}' },
  { name: 'time', hint: 'the time now', text: '{time}' },
  { name: 'now', hint: 'date and time', text: '{date} {time}' },
  { name: 'lastupdate', hint: 'stamp a section', text: 'Last update: {date}' },
  { name: 'today', hint: 'link today’s note', text: '[[{date}]]' },
  { name: 'tomorrow', hint: 'link tomorrow’s note', text: '[[{tomorrow}]]' },
  { name: 'yesterday', hint: 'link yesterday’s note', text: '[[{yesterday}]]' },
  { name: 'task', hint: 'a task line', text: '- [ ] $0' },
  { name: 'log', hint: 'a timestamped bullet', text: '- **{time}** $0' },
  {
    name: 'meeting',
    hint: 'meeting skeleton',
    text: [
      '## {date} — $0',
      '',
      '**Present:**',
      '',
      '### Notes',
      '',
      '### Actions',
      '',
      '- [ ] '
    ].join('\n')
  },
  {
    name: 'table',
    hint: 'table skeleton',
    text: ['| $0| |', '| --- | --- |', '| | |'].join('\n')
  },
  { name: 'code', hint: 'fenced code block', text: '```$0\n\n```' },
  {
    name: 'details',
    hint: 'collapsible block',
    text: '<details>\n<summary>$0</summary>\n\n</details>'
  },
  { name: 'note', hint: 'note callout', text: '> [!note] $0' },
  { name: 'idea', hint: 'idea callout', text: '> [!idea] $0' },
  { name: 'warning', hint: 'warning callout', text: '> [!warning] $0' }
];

const BY_NAME = new Map(SNIPPETS.map((snippet) => [snippet.name, snippet]));

// The token has to open a word, so a URL's `/date` or a path in a code block
// is left alone and Tab keeps indenting.
const TOKEN = /(?:^|[\s(["'])\/([a-z]+)$/;
const PLACEHOLDER = /\{(date|time|tomorrow|yesterday)\}/g;

/**
 * The expansion for the `/name` token ending at the cursor, as `length` (the
 * characters before the cursor to replace), the `insert` text, and `caret` (an
 * offset into that text). Null when nothing there is a snippet, which is what
 * lets Tab fall through to indenting.
 */
export function snippetExpansion(beforeCursor = '', context = {}) {
  const match = TOKEN.exec(String(beforeCursor));
  if (!match) return null;

  const snippet = BY_NAME.get(match[1]);
  if (!snippet) return null;

  const filled = fill(snippet.text, context);
  if (filled === null) return null;

  const caret = filled.indexOf('$0');
  return {
    length: match[1].length + 1,
    insert: caret === -1 ? filled : filled.replace('$0', ''),
    caret: caret === -1 ? filled.length : caret
  };
}

// A snippet whose date cannot be worked out expands to nothing at all, rather
// than to a sentence with a hole in it.
function fill(text, { date = '', time = '' }) {
  let missing = false;
  const filled = text.replace(PLACEHOLDER, (token, name) => {
    const value =
      name === 'date'
        ? date
        : name === 'time'
          ? time
          : resolveShorthandDate(name, date);
    if (!value) missing = true;
    return value;
  });

  return missing ? null : filled;
}

/** The wall clock as `14:30`, the form the `/time` and `/log` snippets use. */
export function clockTime(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
