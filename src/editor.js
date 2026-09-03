const ARXIV_ID = /(\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7})(v\d+)?/
  .source;
const ARXIV_URL = new RegExp(
  `^(?:https?://)?(?:www\\.)?arxiv\\.org/(?:abs|pdf|html)/${ARXIV_ID}(?:\\.pdf)?/?$`,
  'i'
);
/** The identifier on its own, as arXiv prints it: `arXiv:2511.15684`. */
const ARXIV_REF = new RegExp(`^arxiv:\\s*${ARXIV_ID}$`, 'i');

export function arxivPasteId(text, { beforeCursor = '' } = {}) {
  if (/[(<]$/.test(beforeCursor)) return null;

  const trimmed = text.trim();
  const match = ARXIV_URL.exec(trimmed) || ARXIV_REF.exec(trimmed);
  if (!match) return null;

  return `${match[1]}${match[2] || ''}`;
}

export function arxivLinkPaste(text, options = {}) {
  const id = arxivPasteId(text, options);
  return id === null ? null : arxivLink(id);
}

/** `Ju et al., "Title" - [arXiv:id](link)`, falling back to the bare link. */
export function arxivCitation({ id, title, authors = [] } = {}) {
  const link = arxivLink(id);
  const cleanTitle = collapseSpaces(title);
  if (!cleanTitle) return link;

  const credit = authorCredit(authors);
  return `${credit ? `${credit}, ` : ''}"${cleanTitle}" — ${link}`;
}

function arxivLink(id) {
  return `[arXiv:${id}](https://arxiv.org/abs/${id})`;
}

function authorCredit(authors) {
  const names = authors.map(collapseSpaces).filter(Boolean);
  if (!names.length) return '';
  return names.length > 1 ? `${lastName(names[0])} et al.` : lastName(names[0]);
}

/** Group authors ("ATLAS Collaboration") are a name, not a person, so keep them whole. */
function lastName(name) {
  if (/\b(collaboration|group|team|consortium)$/i.test(name)) return name;

  const parts = name.split(' ');
  return parts.length > 1 ? parts[parts.length - 1] : name;
}

function collapseSpaces(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Where a word double-clicked in the preview sits on its source line, if it survived rendering. */
export function sourceColumnForWord(line = '', word = '') {
  const needle = typeof word === 'string' ? word.trim() : '';
  if (!needle || typeof line !== 'string') return null;

  const from = line.indexOf(needle);
  return from === -1 ? null : { from, to: from + needle.length };
}

const SUPERSCRIPTS = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁺': '+',
  '⁻': '-',
  '⁼': '=',
  '⁽': '(',
  '⁾': ')',
  ⁿ: 'n',
  ⁱ: 'i'
};

const SUBSCRIPTS = {
  '₀': '0',
  '₁': '1',
  '₂': '2',
  '₃': '3',
  '₄': '4',
  '₅': '5',
  '₆': '6',
  '₇': '7',
  '₈': '8',
  '₉': '9',
  '₊': '+',
  '₋': '-',
  '₌': '=',
  '₍': '(',
  '₎': ')',
  ₐ: 'a',
  ₑ: 'e',
  ₒ: 'o',
  ₓ: 'x',
  ₕ: 'h',
  ₖ: 'k',
  ₗ: 'l',
  ₘ: 'm',
  ₙ: 'n',
  ₚ: 'p',
  ₛ: 's',
  ₜ: 't'
};

/**
 * A number or single symbol carrying Unicode super/subscripts, as web pages
 * write powers: `32³`, `10⁻³`, `x₁`. The base must not continue a longer word,
 * so footnote markers ("claim¹") keep their text.
 */
const SCRIPTED_TOKEN = new RegExp(
  `(?<![\\p{L}\\p{N}])(\\d+(?:\\.\\d+)?|\\p{L})([${Object.keys(SUBSCRIPTS).join('')}]*)([${Object.keys(SUPERSCRIPTS).join('')}]*)`,
  'gu'
);

/** Rewrites pasted Unicode powers as inline math, or null when there are none. */
export function mathPasteText(text, { beforeCursor = '' } = {}) {
  if (typeof text !== 'string' || !text) return null;
  // Inside an unclosed `$…$` the text is already math; nesting would break it.
  if (countDollars(beforeCursor) % 2 === 1) return null;

  let changed = false;
  const converted = text.replace(
    SCRIPTED_TOKEN,
    (match, base, subscript, superscript) => {
      if (!subscript && !superscript) return match;

      changed = true;
      const sub = script(subscript, SUBSCRIPTS, '_');
      const sup = script(superscript, SUPERSCRIPTS, '^');
      return `$${base}${sub}${sup}$`;
    }
  );

  return changed ? converted : null;
}

function script(characters, map, operator) {
  if (!characters) return '';

  const value = [...characters].map((character) => map[character]).join('');
  return value.length === 1 ? `${operator}${value}` : `${operator}{${value}}`;
}

function countDollars(text) {
  return (text.match(/\$/g) || []).length;
}

export function quotedBlockPaste(
  text,
  { beforeCursor = '', previousLine = '' } = {}
) {
  if (!text.includes('\n')) return null;

  const currentLineIsQuoted = /^\s*>\s?/.test(beforeCursor);
  if (currentLineIsQuoted) return quotePastedLines(text, false);

  if (beforeCursor.trim() || !/^\s*>\s?/.test(previousLine)) return null;
  return quotePastedLines(text, true);
}

function quotePastedLines(text, prefixFirstLine) {
  const normalized = text.replace(/\r\n?/g, '\n');
  const quoted = normalized.replace(/\n(?!$)/g, '\n> ');
  return prefixFirstLine ? `> ${quoted}` : quoted;
}

/** Spaces that look ordinary but are not: NBSP and the typographic widths. */
const INVISIBLE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

/**
 * Tidies pasted text: line endings, stray whitespace, and — when the clipboard
 * says the fragment is prose rather than code — the wrapper indentation a
 * browser copies out of the page source. Returns null when the text was
 * already clean, so an untouched paste still falls through to the browser.
 */
export function tidyPasteText(text, { html = '', dedent = false } = {}) {
  if (typeof text !== 'string' || !text) return null;

  let tidied = text
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE_SPACES, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '');

  if (dedent && !pastedFromCode(html)) tidied = dedentLines(tidied);

  return tidied === text ? null : tidied;
}

/**
 * Drops the whitespace prefix every non-blank line shares. Relative
 * indentation survives, so code that slipped past the checks below is still
 * code afterwards — only the wrapper the page added goes away.
 */
function dedentLines(text) {
  const lines = text.split('\n');
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => /^[ \t]*/.exec(line)[0]);
  if (!indents.length) return text;

  const common = indents.reduce((prefix, indent) => {
    let index = 0;
    while (
      index < prefix.length &&
      index < indent.length &&
      prefix[index] === indent[index]
    ) {
      index += 1;
    }
    return prefix.slice(0, index);
  });
  if (!common) return text;

  return lines
    .map((line) => (line.startsWith(common) ? line.slice(common.length) : line))
    .join('\n');
}

/**
 * Whether the clipboard's HTML flavour says the fragment came out of a code
 * block, where the indentation is the content rather than page formatting. A
 * `<code>` span inside a sentence does not count: only a whole-fragment one.
 */
export function pastedFromCode(html) {
  if (!html || typeof DOMParser !== 'function') return false;

  const document = new DOMParser().parseFromString(html, 'text/html');
  if (document.querySelector('pre')) return true;

  const text = document.body?.textContent?.trim() || '';
  if (!text) return false;

  return [...document.querySelectorAll('code')].some(
    (node) => node.textContent.trim() === text
  );
}

/**
 * A bare URL pasted on its own becomes a markdown link with a short, readable
 * label — `atlas/atlasexternals!1436` rather than the whole GitLab path.
 * Returns null for anything we have no better name for, so the plain URL is
 * pasted as-is.
 */
export function shortLinkPaste(text, { beforeCursor = '' } = {}) {
  if (/[(<[]$/.test(beforeCursor)) return null;

  const url = typeof text === 'string' ? text.trim() : '';
  if (!/^https?:\/\/[^\s<>]+$/i.test(url)) return null;

  const label = shortLinkLabel(url);
  return label ? `[${label}](${url})` : null;
}

/** The label a forge would print for the thing the URL points at. */
export function shortLinkLabel(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, '');
  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map(decodeSegment);
  if (!segments.length) return null;

  if (host === 'github.com') return githubLabel(segments);
  if (/(^|\.)gitlab\./.test(host) || segments.includes('-')) {
    return gitlabLabel(segments);
  }
  return null;
}

function githubLabel(segments) {
  const project = projectName(segments.slice(0, 2));
  if (!project) return null;

  return withSuffix(project, referenceSuffix(segments.slice(2), '#'));
}

/** GitLab nests groups, so the project is everything before the `/-/` marker. */
function gitlabLabel(segments) {
  const marker = segments.indexOf('-');
  const project = projectName(
    marker === -1 ? segments : segments.slice(0, marker)
  );
  if (!project) return null;

  if (marker === -1) return project;

  return withSuffix(project, referenceSuffix(segments.slice(marker + 1), '!'));
}

/** A deep file path stops being shorter than the link it replaces. */
function withSuffix(project, suffix) {
  const label = `${project}${suffix}`;
  return label.length <= 60 ? label : project;
}

function referenceSuffix([kind, ...rest], mergeRequestMark) {
  const [first, ...path] = rest;
  if (!kind || !first) return '';

  if (kind === 'merge_requests' || kind === 'pull') {
    return /^\d+$/.test(first) ? `${mergeRequestMark}${first}` : '';
  }
  if (kind === 'issues') return /^\d+$/.test(first) ? `#${first}` : '';
  if (kind === 'commit') return `@${shortSha(first)}`;
  // `first` is the branch or tag the path is read at, which the label drops.
  if (kind === 'tree' || kind === 'blob') {
    return path.length ? `/${path.join('/')}` : '';
  }
  return '';
}

function projectName(parts) {
  if (parts.length < 2 || parts.some((part) => !part)) return null;
  return parts.join('/').replace(/\.git$/, '');
}

function shortSha(revision) {
  return /^[0-9a-f]{7,40}$/i.test(revision) ? revision.slice(0, 7) : revision;
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
