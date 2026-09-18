/**
 * Character edits that tidy a note before it is written out, in the shape
 * CodeMirror's `changes` takes: no trailing whitespace, no blank lines at the
 * start or the end, and exactly one newline to finish on. Empty when the note
 * is already tidy, which is the usual case.
 */
export function sanitizeEdits(content = '') {
  const text = String(content ?? '');
  if (!text) return [];

  const lines = text.split('\n');
  const offsets = [0];
  for (const line of lines)
    offsets.push(offsets[offsets.length - 1] + line.length + 1);

  let first = 0;
  while (first < lines.length && !lines[first].trim()) first += 1;
  let last = lines.length - 1;
  while (last >= first && !lines[last].trim()) last -= 1;

  // Nothing but whitespace: leave the file empty rather than a lone newline.
  if (last < first) return [{ from: 0, to: text.length, insert: '' }];

  const edits = [];
  if (first > 0) edits.push({ from: 0, to: offsets[first], insert: '' });

  for (let i = first; i < last; i += 1) {
    const trimmed = trimEnd(lines[i]);
    if (trimmed !== lines[i])
      edits.push({
        from: offsets[i] + trimmed.length,
        to: offsets[i] + lines[i].length,
        insert: ''
      });
  }

  // The last line's own trailing whitespace and everything after it are one
  // edit, so the two never overlap.
  const tailFrom = offsets[last] + trimEnd(lines[last]).length;
  if (text.slice(tailFrom) !== '\n')
    edits.push({ from: tailFrom, to: text.length, insert: '\n' });

  return edits;
}

/** sanitizeEdits applied to the note. */
export function sanitize(content = '') {
  const text = String(content ?? '');
  let result = text;
  for (const edit of [...sanitizeEdits(text)].reverse())
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  return result;
}

function trimEnd(line) {
  return line.replace(/[ \t]+$/, '');
}
