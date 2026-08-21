import { parseFrontmatter } from './frontmatter.js';
import { splitWikiTarget } from './wiki-links.js';
import { normalizeHeading } from './note-headings.js';

// `![[note#Section]]` previews one section rather than the whole note, so the
// target splits exactly the way a wiki link's does.
export const splitEmbedTarget = splitWikiTarget;

/**
 * The note's body without its frontmatter, or just the named section of it.
 * A section runs to the next heading of the same or higher level, so it
 * carries its own subsections along. Returns '' when the heading is missing,
 * which is what tells the card to say so.
 */
export function sliceNoteSection(content = '', heading = '') {
  const { body } = parseFrontmatter(String(content));
  const wanted = normalizeHeading(heading);
  if (!wanted) return body.trim();

  const lines = body.split('\n');
  let start = -1;
  let level = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;

    if (start === -1) {
      if (normalizeHeading(match[2]) === wanted) {
        start = index;
        level = match[1].length;
      }
      continue;
    }

    if (match[1].length <= level) {
      return lines.slice(start, index).join('\n').trim();
    }
  }

  return start === -1 ? '' : lines.slice(start).join('\n').trim();
}
