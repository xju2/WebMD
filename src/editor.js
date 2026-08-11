const ARXIV_URL =
  /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7})(v\d+)?(?:\.pdf)?\/?$/i;

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
