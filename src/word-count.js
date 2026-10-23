import { parseFrontmatter } from './frontmatter.js';
import { stripHtmlComments } from './html-comments.js';

/** Words in a note's prose: no frontmatter, comments, code blocks, link targets or bare Markdown marks. */
export function wordCount(source = '') {
  const prose = stripHtmlComments(parseFrontmatter(source).body)
    .replace(
      /^ {0,3}(`{3,}|~{3,}).*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm,
      ''
    )
    .replace(/\]\([^)\s]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, '');
  return prose.match(/[^\s]*[\p{L}\p{N}][^\s]*/gu)?.length ?? 0;
}
