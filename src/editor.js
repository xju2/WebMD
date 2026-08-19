const ARXIV_URL =
  /^(?:https?:\/\/)?(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7})(v\d+)?(?:\.pdf)?\/?$/i;

export function arxivPasteId(text, { beforeCursor = '' } = {}) {
  if (/[(<]$/.test(beforeCursor)) return null;

  const match = ARXIV_URL.exec(text.trim());
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
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6',
  '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(',
  '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i'
};

const SUBSCRIPTS = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6',
  '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', '₌': '=', '₍': '(',
  '₎': ')', 'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o', 'ₓ': 'x', 'ₕ': 'h', 'ₖ': 'k',
  'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₚ': 'p', 'ₛ': 's', 'ₜ': 't'
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
  return value.length === 1
    ? `${operator}${value}`
    : `${operator}{${value}}`;
}

function countDollars(text) {
  return (text.match(/\$/g) || []).length;
}

export function quotedBlockPaste(text, { beforeCursor = '', previousLine = '' } = {}) {
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
