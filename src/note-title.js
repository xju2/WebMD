import { parseFrontmatter } from './frontmatter.js';

const MARKDOWN_PATTERN = /\.(md|markdown)$/i;
const DATE_STEM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Characters no file name should carry on macOS, Linux, or Windows, plus the
// ones that would make the renamed note awkward to link to with [[wiki links]].
const UNSAFE_CHARACTERS = /[\\/:*?"<>|#^[\]]/g;
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
const MAX_STEM_LENGTH = 120;

/**
 * The note's title: the frontmatter field when it has one, otherwise its first
 * heading — the same rule related-note ranking uses. Returns '' when the note
 * carries neither, which leaves the file name alone.
 */
export function noteTitle(content = '') {
  const { attributes, body } = parseFrontmatter(String(content ?? ''));
  if (attributes.title) return String(attributes.title).trim();

  const heading = body.match(/^#{1,3}[ \t]+(\S[^\n]*)$/m);
  return heading ? heading[1].trim() : '';
}

export function titleFileName(title = '') {
  const stem = String(title ?? '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_STEM_LENGTH)
    // Leading dots hide the note; trailing dots and spaces are dropped by some
    // filesystems, so the name on disk would stop matching the title.
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();

  return stem ? `${stem}.md` : '';
}

/**
 * The path `filePath` should move to for `title`, or '' when the title cannot
 * name a file or the name already matches.
 */
export function renamePathForTitle(filePath, title) {
  const path = String(filePath ?? '');
  if (!MARKDOWN_PATTERN.test(path)) return '';

  const name = titleFileName(title);
  const slashIndex = path.lastIndexOf('/');
  if (!name || slashIndex === -1 || name === path.slice(slashIndex + 1)) {
    return '';
  }

  return `${path.slice(0, slashIndex)}/${name}`;
}

/** Daily notes are addressed by their date, so their names are left alone. */
export function isDateNamedPath(filePath) {
  const stem = String(filePath ?? '')
    .split('/')
    .pop()
    .replace(MARKDOWN_PATTERN, '');
  return DATE_STEM_PATTERN.test(stem);
}
