import { parseFrontmatter } from './frontmatter.js';

export const CREATED_FIELD = 'creation-date';
export const MODIFIED_FIELD = 'last-modified-date';

/**
 * Character edits that bring a note's `creation-date` and `last-modified-date`
 * frontmatter up to date, in the shape CodeMirror's `changes` takes. Empty when
 * the note already says today, which is the usual case: the stamp moves once a
 * day, not once a save.
 *
 * `creation-date` is only ever written, never rewritten — a note that predates
 * the stamp takes `createdFallback` (the file's own age) rather than today, so
 * the date stays honest.
 */
export function noteDateEdits(content = '', today = '', createdFallback = '') {
  if (!today) return [];

  const text = String(content ?? '');
  const { attributes, bodyLine, attributeLines } = parseFrontmatter(text);
  const created = createdFallback || today;

  if (!bodyLine) {
    const block = `---\n${CREATED_FIELD}: ${created}\n${MODIFIED_FIELD}: ${today}\n---\n`;
    // A blank line before the note itself, but not before an empty file.
    return [{ from: 0, to: 0, insert: text.trim() ? `${block}\n` : block }];
  }

  const lines = text.split('\n');
  const offsets = lineOffsets(lines);
  const edits = [];
  const missing = [];

  if (!attributes[CREATED_FIELD]) missing.push(`${CREATED_FIELD}: ${created}`);

  if (!attributes[MODIFIED_FIELD]) {
    missing.push(`${MODIFIED_FIELD}: ${today}`);
  } else if (attributes[MODIFIED_FIELD] !== today) {
    const line = attributeLines[MODIFIED_FIELD];
    edits.push({
      from: offsets[line],
      to: offsets[line] + (lines[line] ?? '').length,
      insert: `${MODIFIED_FIELD}: ${today}`
    });
  }

  // Both inserts land on the line after the opening `---`, ahead of the fields
  // the note already carries.
  if (missing.length)
    edits.unshift({
      from: offsets[1],
      to: offsets[1],
      insert: `${missing.join('\n')}\n`
    });

  return edits;
}

/** noteDateEdits applied to the note. */
export function stampNoteDates(content = '', today = '', createdFallback = '') {
  const text = String(content ?? '');
  const edits = noteDateEdits(text, today, createdFallback);
  let result = text;
  for (const edit of [...edits].reverse()) {
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  }
  return result;
}

function lineOffsets(lines) {
  const offsets = [0];
  for (const line of lines)
    offsets.push(offsets[offsets.length - 1] + line.length + 1);
  return offsets;
}
