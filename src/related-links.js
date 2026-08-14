import { resolveWikiLinkPath } from './wiki-links.js';

const MARKDOWN_PATTERN = /\.(md|markdown)$/i;
// Matches "## Related", "## Related pages", "### Related concepts" — the shapes
// notes in the wild already use — but not "## Relatedness" or "## Unrelated".
const RELATED_HEADING = /^(#{2,6})[ \t]+Related\b[^\n]*$/gim;
const DEFAULT_HEADING = '## Related';

/**
 * The shortest wikilink text that resolves back to `targetPath`.
 *
 * Tries a bare name first, then progressively more path segments, and falls
 * back to the absolute path. Every form is verified with the same resolver the
 * app navigates with, so a returned link can never be a dead one — an ambiguous
 * basename simply loses to a longer form instead of being emitted.
 */
export function shortestWikiTarget(
  targetPath,
  currentPath = '',
  paths = [],
  options = {}
) {
  if (typeof targetPath !== 'string' || !targetPath) return '';

  const segments = targetPath
    .replace(MARKDOWN_PATTERN, '')
    .split('/')
    .filter(Boolean);
  const forms = segments.map((_, index) =>
    segments.slice(segments.length - index - 1).join('/')
  );
  forms.push(targetPath);

  for (const form of forms) {
    if (!form) continue;
    if (resolveWikiLinkPath(form, currentPath, paths, options) === targetPath) {
      return form;
    }
  }

  return targetPath;
}

/**
 * A single range replacement that adds `suggestions` to the note's trailing
 * Related section, creating one at the end when the note has none. Returns null
 * when there is nothing left to add, so callers can skip the dispatch entirely.
 *
 * Shaped as {from, to, insert} so the client can hand it straight to a
 * CodeMirror transaction and let the existing autosave and collab paths carry
 * the write to disk.
 */
export function relatedInsertion(content = '', suggestions = []) {
  const lines = suggestions
    .filter((suggestion) => suggestion?.target)
    .filter((suggestion) => !hasWikiLink(content, suggestion.target))
    .map(relatedBullet);
  if (!lines.length) return null;

  const block = lines.join('\n');
  const section = findRelatedSection(content);

  if (!section) {
    const trimmed = content.replace(/\s+$/, '');
    return {
      from: trimmed.length,
      to: content.length,
      insert: `${trimmed ? '\n\n' : ''}${DEFAULT_HEADING}\n${block}\n`
    };
  }

  // Append after the section's last non-blank line so trailing blank lines and
  // any following heading stay where the author put them.
  const body = content.slice(section.bodyStart, section.end);
  const insertAt = section.bodyStart + body.replace(/\s+$/, '').length;
  return { from: insertAt, to: insertAt, insert: `\n${block}` };
}

function relatedBullet({ target, reason }) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  return text ? `- [[${target}]] — ${text}` : `- [[${target}]]`;
}

// Cheap last-line defence against a duplicate bullet. Links already in the note
// are filtered out upstream by path, which also catches other spellings of the
// same target; this only has to catch the exact text about to be written.
function hasWikiLink(content, target) {
  return content.includes(`[[${target}]]`) || content.includes(`[[${target}|`);
}

/**
 * The last Related section in the note, spanning to the next heading of the
 * same or higher level. "Last" rather than "first" because these sections sit
 * at the end by convention, and a note quoting the words earlier should not
 * capture the insertion point.
 */
function findRelatedSection(content) {
  RELATED_HEADING.lastIndex = 0;
  let heading = null;
  let match;
  while ((match = RELATED_HEADING.exec(content))) {
    heading = { index: match.index, level: match[1].length, text: match[0] };
  }
  if (!heading) return null;

  const bodyStart = heading.index + heading.text.length;
  const following = new RegExp(`^#{1,${heading.level}}[ \\t]+\\S`, 'gm');
  following.lastIndex = bodyStart;
  const next = following.exec(content);

  return { bodyStart, end: next ? next.index : content.length };
}
