// The headings of a note, as `[[note#Heading]]` sees them: a link points at a
// line of Markdown, so the line number is what navigation and completion both
// need. Lines are 0-based over the whole file, the same numbering the rendered
// blocks carry in `data-line`.

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_PATTERN = /^\s*(```|~~~)/;

export function noteHeadings(content = '') {
  const lines = String(content).split('\n');
  const headings = [];
  let fenced = false;

  for (let index = 0; index < lines.length; index += 1) {
    // A `# comment` inside a code block is not a heading, so fences toggle the
    // scan off the way they do when the note is rendered.
    if (FENCE_PATTERN.test(lines[index])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const match = HEADING_PATTERN.exec(lines[index]);
    if (match) {
      headings.push({
        text: match[2].trim(),
        level: match[1].length,
        line: index
      });
    }
  }

  return headings;
}

/**
 * The line of the heading a `#fragment` names, or null when the note has no
 * such heading — which is what lets a link say so instead of scrolling
 * somewhere arbitrary. Matching ignores case and surrounding space, the way
 * section embeds already resolve their headings.
 */
export function findHeadingLine(content = '', heading = '') {
  const wanted = normalizeHeading(heading);
  if (!wanted) return null;

  const match = noteHeadings(content).find(
    (entry) => normalizeHeading(entry.text) === wanted
  );
  return match ? match.line : null;
}

export function normalizeHeading(text = '') {
  return String(text).trim().toLowerCase();
}
