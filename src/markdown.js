// ponytail: small safe preview renderer; swap for CommonMark when exact Markdown fidelity matters.
export function renderMarkdown(source = '') {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(\S*)?\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: 'code',
        lang: fence[1] || '',
        text: code.join('\n')
      });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2])
      });
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', children: parseInline(quote.join(' ')) });
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const list = parseListItem(line);
    if (list) {
      const ordered = list.ordered;
      const items = [];
      while (index < lines.length) {
        const item = parseListItem(lines[index]);
        if (!item || item.ordered !== ordered) break;
        items.push(item);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !startsBlock(lines[index], lines[index + 1])
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({
      type: 'paragraph',
      children: parseInline(paragraph.join(' '))
    });
  }

  return blocks;
}

export function parseInline(text) {
  const tokenPattern =
    /(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|https?:\/\/[^\s<]+)/g;
  const segments = [];
  let lastIndex = 0;

  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    segments.push(parseInlineToken(match[0]));
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return segments;
}

function parseInlineToken(token) {
  if (token.startsWith('`')) return { type: 'code', text: token.slice(1, -1) };

  const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) {
    return { type: 'link', text: link[1], href: safeHref(link[2]) };
  }

  if (/^https?:\/\//i.test(token))
    return { type: 'link', text: token, href: token };

  if (token.startsWith('**'))
    return { type: 'strong', text: token.slice(2, -2) };
  return { type: 'em', text: token.slice(1, -1) };
}

function parseTable(lines, index) {
  if (!isTableStart(lines[index], lines[index + 1])) return null;

  const headers = parseTableRow(lines[index]);
  const alignments = parseTableDivider(lines[index + 1]);
  const rows = [];
  index += 2;

  while (index < lines.length && lines[index].trim()) {
    const row = parseTableRow(lines[index]);
    if (!row) break;
    rows.push(normalizeTableCells(row, headers.length).map(parseInline));
    index += 1;
  }

  return {
    block: {
      type: 'table',
      alignments,
      headers: headers.map(parseInline),
      rows
    },
    nextIndex: index
  };
}

function isTableStart(header, divider) {
  const headers = parseTableRow(header);
  const alignments = parseTableDivider(divider);
  return !!headers && !!alignments && headers.length === alignments.length;
}

function parseTableRow(line = '') {
  if (!line.includes('|')) return null;

  const cells = [];
  let cell = '';
  const trimmed = line.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '\\' && trimmed[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());

  if (cells[0] === '') cells.shift();
  if (cells[cells.length - 1] === '') cells.pop();
  return cells.length > 1 ? cells : null;
}

function parseTableDivider(line) {
  const cells = parseTableRow(line);
  if (!cells) return null;

  const alignments = [];
  for (const cell of cells) {
    const marker = cell.replace(/\s+/g, '');
    if (!/^:?-{3,}:?$/.test(marker)) return null;
    alignments.push(
      marker.startsWith(':') && marker.endsWith(':')
        ? 'center'
        : marker.endsWith(':')
          ? 'right'
          : 'left'
    );
  }
  return alignments;
}

function normalizeTableCells(cells, count) {
  return Array.from({ length: count }, (_, index) => cells[index] || '');
}

function parseListItem(line) {
  const match = line.match(/^\s*((?:[-*+])|(?:\d+[.)]))\s+(.+)$/);
  if (!match) return null;

  const task = match[2].match(/^\[([ xX])\]\s+(.+)$/);
  return {
    ordered: /^\d/.test(match[1]),
    task: !!task,
    checked: task ? task[1].toLowerCase() === 'x' : false,
    children: parseInline(task ? task[2] : match[2])
  };
}

function startsBlock(line, nextLine = '') {
  return (
    /^```/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim()) ||
    isTableStart(line, nextLine) ||
    !!parseListItem(line)
  );
}

function safeHref(href) {
  const trimmed = href.trim();
  return /^(https?:|mailto:|#|\/)/i.test(trimmed) ? trimmed : '';
}
