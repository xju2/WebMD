// Completion inside `[[ ]]`. Typing a name offers the notes it could mean, and
// typing `#` after a resolved note offers that note's headings, so a cross
// reference can be written without leaving the keyboard or guessing at a path.
//
// The rules live here rather than in the editor so they can be tested without
// CodeMirror: each function takes the text before the cursor and returns what
// should replace it.

import { shortestWikiTarget } from './related-links.js';
import { noteHeadings } from './note-headings.js';

const MARKDOWN_PATTERN = /\.(md|markdown)$/i;
const MAX_RESULTS = 25;

/**
 * The `[[` being typed at the cursor, or null when the cursor is not inside
 * one. `length` is how many characters before the cursor a completion
 * replaces: the note name so far, or the heading so far once `#` is typed.
 */
export function wikiCompletionQuery(beforeCursor = '') {
  const text = String(beforeCursor ?? '');
  const line = text.slice(text.lastIndexOf('\n') + 1);
  const openIndex = line.lastIndexOf('[[');
  if (openIndex === -1) return null;

  const value = line.slice(openIndex + 2);
  // A closed link, a nested bracket, or an alias that has already started is
  // no longer a name being typed.
  if (/[[\]|]/.test(value)) return null;

  const hashIndex = value.indexOf('#');
  if (hashIndex === -1) {
    return { kind: 'note', note: '', query: value, length: value.length };
  }

  return {
    kind: 'heading',
    note: value.slice(0, hashIndex).trim(),
    query: value.slice(hashIndex + 1),
    length: value.length - hashIndex - 1
  };
}

/**
 * The notes a half-typed name could mean, best match first.
 *
 * Each option carries the `target` to insert — the shortest form that still
 * resolves back to that note, so a completed link stays readable and can never
 * be ambiguous — alongside the folder it lives in as `detail`.
 */
export function noteCompletions(query, files = [], currentPath = '') {
  const paths = markdownPaths(files);
  const needle = normalize(query);

  return paths
    .filter((path) => path !== currentPath)
    .map((path) => ({ path, score: matchScore(path, needle) }))
    .filter((entry) => entry.score !== null)
    .sort(compareMatches)
    .slice(0, MAX_RESULTS)
    .map(({ path }) => ({
      label: noteName(path),
      detail: folderOf(path),
      path,
      target: shortestWikiTarget(path, currentPath, paths) || path
    }));
}

/** The headings of the note a link already names, best match first. */
export function headingCompletions(query, content = '') {
  const needle = normalize(query);

  return noteHeadings(content)
    .map((heading) => ({
      heading,
      score: textScore(heading.text, needle)
    }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.heading.line - b.heading.line)
    .slice(0, MAX_RESULTS)
    .map(({ heading }) => ({
      label: heading.text,
      detail: '#'.repeat(heading.level),
      target: heading.text
    }));
}

// Name matches beat path matches, and an earlier hit beats a later one, so
// typing the start of a note's name puts that note on top even when a dozen
// folders happen to contain the word too.
function matchScore(path, needle) {
  const name = textScore(noteName(path), needle);
  if (name !== null) return name;

  const folder = textScore(folderOf(path), needle);
  return folder === null ? null : folder + 10;
}

function textScore(text, needle) {
  if (!needle) return 5;

  const index = normalize(text).indexOf(needle);
  if (index === 0) return 0;
  return index === -1 ? null : Math.min(index, 4);
}

function compareMatches(a, b) {
  return (
    a.score - b.score ||
    noteName(a.path).length - noteName(b.path).length ||
    a.path.localeCompare(b.path)
  );
}

function markdownPaths(files) {
  return (Array.isArray(files) ? files : [])
    .map((file) => (typeof file === 'string' ? file : file?.path))
    .filter((path) => typeof path === 'string' && MARKDOWN_PATTERN.test(path));
}

function noteName(path) {
  return path.slice(path.lastIndexOf('/') + 1).replace(MARKDOWN_PATTERN, '');
}

function folderOf(path) {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex <= 0 ? '/' : path.slice(0, slashIndex);
}

function normalize(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase();
}
