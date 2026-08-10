const ARXIV_URL =
  /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7})(v\d+)?(?:\.pdf)?\/?$/i;

export function arxivLinkPaste(text, { beforeCursor = '' } = {}) {
  if (/[(<]$/.test(beforeCursor)) return null;

  const match = ARXIV_URL.exec(text.trim());
  if (!match) return null;

  const id = `${match[1]}${match[2] || ''}`;
  return `[arXiv:${id}](https://arxiv.org/abs/${id})`;
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
