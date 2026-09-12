export const NEWS_CLIP_HEADING = 'Reading';

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ARXIV_ABS =
  /arxiv\.org\/(?:abs|pdf|html)\/([a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7}|\d{4}\.\d{4,5})/gi;

/**
 * Where a clipped paper goes: one more bullet at the end of the note's
 * `## Reading` section, which is added at the bottom the first time. The result
 * is a single CodeMirror change, so it can ride the collaborative update path
 * into an editor that has the note open.
 */
export function newsClipChange(
  content = '',
  line = '',
  heading = NEWS_CLIP_HEADING
) {
  const lines = content.split('\n');
  const start = lines.findIndex((text) => {
    const match = HEADING.exec(text);
    return match && match[2].toLowerCase() === heading.toLowerCase();
  });

  if (start === -1) {
    const trailing = content.match(/\n*$/)[0].length;
    const from = content.length - trailing;
    const lead = from === 0 ? '' : '\n\n';
    return {
      from,
      to: content.length,
      insert: `${lead}## ${heading}\n\n- ${line}\n`
    };
  }

  // The section runs until the next heading at its own level or above.
  const level = HEADING.exec(lines[start])[1].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = HEADING.exec(lines[index]);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }
  let last = end - 1;
  while (last > start && !lines[last].trim()) last -= 1;

  // Offset of the end of line `last`: every earlier line plus its newline.
  const from =
    lines
      .slice(0, last + 1)
      .reduce((total, text) => total + text.length + 1, 0) - 1;
  const insert = last === start ? `\n\n- ${line}` : `\n- ${line}`;
  // A section that ends the file still ends in a newline afterwards.
  const tail = from === content.length ? '\n' : '';
  return { from, to: from, insert: `${insert}${tail}` };
}

/** The arXiv ids a note already links to, so a clipped paper shows as clipped. */
export function linkedArxivIds(content = '') {
  return new Set(
    [...content.matchAll(ARXIV_ABS)].map((match) => match[1].toLowerCase())
  );
}

/**
 * Narrows the day's listing. Every word of `query` must appear in the title,
 * authors, or abstract; `categories` keeps papers listed under any of them;
 * replacements (new versions of older papers) stay out unless asked for.
 */
export function filterPapers(
  papers = [],
  { query = '', categories = [], includeReplacements = false } = {}
) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = new Set(categories);
  return papers.filter((paper) => {
    if (!includeReplacements && isReplacement(paper)) return false;
    if (
      wanted.size &&
      !paper.categories.some((category) => wanted.has(category))
    )
      return false;
    if (!words.length) return true;
    const haystack = [paper.title, paper.authors.join(' '), paper.abstract]
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function isReplacement(paper) {
  return /^replace/.test(paper?.announceType ?? '');
}

/** How many papers each followed category would show, for its chip. */
export function newsCategoryCounts(papers = [], categories = [], options = {}) {
  const listed = filterPapers(papers, { ...options, categories: [] });
  return new Map(
    categories.map((category) => [
      category,
      listed.filter((paper) => paper.categories.includes(category)).length
    ])
  );
}

/** "Fri 11 Sep" for a kept listing's `YYYY-MM-DD`, whatever the time zone. */
export function newsDayLabel(day = '', locale) {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC'
  });
}

/** Collaboration papers list hundreds of names; three say who it is. */
export function shortAuthorList(authors = [], limit = 3) {
  if (authors.length <= limit) return authors.join(', ');
  return `${authors.slice(0, limit).join(', ')} et al.`;
}

// Inline math as the note renderer reads it, plus bare links. Nothing else in
// an abstract is markup: a `#`, `*`, or `who:` there is just arXiv text.
const NEWS_TOKEN =
  /(?<!\\)\$[^\s$\n](?:[^$\n]*[^\s$])?(?<!\\)\$|https?:\/\/[^\s<]*[^\s<.,;:)]/g;

/**
 * Splits arXiv text into the segments the inline renderer draws. A title is
 * itself a link, so `{ links: false }` keeps any URL in it as text.
 */
export function newsSegments(text = '', { links = true } = {}) {
  const segments = [];
  let lastIndex = 0;
  for (const match of text.matchAll(NEWS_TOKEN)) {
    const token = match[0];
    const math = token.startsWith('$');
    if (!math && !links) continue;
    if (match.index > lastIndex)
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    segments.push(
      math
        ? { type: 'math', text: token.slice(1, -1) }
        : { type: 'link', text: token, href: token }
    );
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length)
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  return segments;
}

/** Must match NEWS_INSTRUCTIONS_PATH in server/news-rank.js. */
export const NEWS_INSTRUCTIONS_PATH = '/.webmd/news.md';

export const NEWS_INSTRUCTIONS_TEMPLATE = `# arXiv ranking instructions

<!-- The News view gives this note to the AI when it ranks the day's arXiv
papers. Say what your research is and how papers should be judged, in plain
words. Edits apply the next time you open News or press Re-rank. Comments like
this one are not sent. -->

Rank today's arXiv papers by relevance to my research: <your research areas>.
Prioritize papers with substantive methodological or systems contributions, not
superficial keyword overlap.
`;
