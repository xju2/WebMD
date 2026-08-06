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
