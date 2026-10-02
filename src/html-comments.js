const FENCE = /^\s*(```|~~~)/;
// A code span is matched first so `<!--` written as code stays visible.
const COMMENT_OR_CODE = /`[^`\n]*`|<!--[\s\S]*?-->/g;

// Drops `<!-- … -->` outside code fences, keeping every newline it spanned so
// line numbers still point at the source. An unclosed `<!--` stays as text.
export function stripHtmlComments(text = '') {
  if (!text.includes('<!--')) return text;

  const out = [];
  let prose = [];
  let fence = '';
  const flush = () => {
    if (!prose.length) return;
    out.push(
      prose
        .join('\n')
        .replace(COMMENT_OR_CODE, (match) =>
          match.startsWith('`') ? match : match.replace(/[^\n]/g, '')
        )
    );
    prose = [];
  };

  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line);
    if (fence || marker) {
      flush();
      out.push(line);
      if (marker && !fence) fence = marker[1];
      else if (marker && marker[1] === fence) fence = '';
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join('\n');
}
