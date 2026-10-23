import { parseFrontmatter } from './frontmatter.js';
import { stripHtmlComments } from './html-comments.js';

/** Words in a note's prose: no frontmatter, comments, link targets or bare Markdown marks. */
export function wordCount(source = '') {
  const prose = stripHtmlComments(parseFrontmatter(source).body)
    .replace(/\]\([^)\s]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, '');
  return prose.match(/[^\s]*[\p{L}\p{N}][^\s]*/gu)?.length ?? 0;
}
