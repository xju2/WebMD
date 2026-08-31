import { parseUnifiedDiff } from './diff.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  ASSIGNEE_BODY,
  TAG_BODY,
  displayAssignee,
  parseTaskFields
} from './tasks.js';
import { isMediaWikiTarget, parseWikiLinkValue } from './wiki-links.js';

// ponytail: small safe preview renderer; swap for CommonMark when exact Markdown fidelity matters.
// Blocks carry `line`, the 0-based source line they start on, so the preview can jump to the editor.
export function renderMarkdown(
  source = '',
  taskCounter = { value: 0 },
  lineOffset = 0
) {
  const { attributes, body, bodyLine, attributeLines } =
    parseFrontmatter(source);
  const base = lineOffset + bodyLine;
  const lines = body.split('\n');
  const blocks = [];
  let index = 0;

  const fields = Object.entries(attributes).map(([key, value]) => ({
    key,
    list: Array.isArray(value),
    values: (Array.isArray(value) ? value : [value]).map(parseInline),
    line: lineOffset + (attributeLines[key] ?? 0)
  }));
  if (fields.length) blocks.push({ type: 'frontmatter', fields, line: 0 });

  while (index < lines.length) {
    const line = lines[index];
    const start = base + index;
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        ...parseCodeBlock(parseInfoString(fence[1] || ''), code.join('\n')),
        line: start
      });
      continue;
    }

    const math = parseMathBlock(lines, index);
    if (math) {
      blocks.push({ ...math.block, line: start });
      index = math.nextIndex;
      continue;
    }

    // The title may be empty: `## ` on its own is a heading a writer has not
    // named yet. It has to match here, because startsBlock() already counts
    // it as a heading, and a line no branch consumes stalls the loop below.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2]),
        line: start
      });
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ type: 'rule', line: start });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ ...parseQuote(quote, taskCounter, start), line: start });
      continue;
    }

    if (/^<details>\s*$/i.test(line.trim())) {
      const details = [];
      index += 1;
      while (
        index < lines.length &&
        !/^<\/details>\s*$/i.test(lines[index].trim())
      ) {
        details.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        ...parseDetails(details, taskCounter, start + 1),
        line: start
      });
      continue;
    }

    const embed = parseNoteEmbedLine(line);
    if (embed) {
      blocks.push({ ...embed, line: start });
      index += 1;
      continue;
    }

    const table = parseTable(lines, index, base);
    if (table) {
      blocks.push({ ...table.block, line: start });
      index = table.nextIndex;
      continue;
    }

    if (parseListItem(line)) {
      const list = parseList(lines, index, base, taskCounter);
      blocks.push({ ...list.block, line: start });
      index = list.nextIndex;
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
    // A line startsBlock() claims but no branch above consumed would leave
    // index where it was and spin this loop forever. Taking it as paragraph
    // text costs one odd-looking line and keeps the parser moving.
    if (!paragraph.length) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({
      type: 'paragraph',
      children: parseInline(paragraph.join(' ')),
      line: start
    });
  }

  return blocks;
}

// Accepts ```lang, ```lang title="x", and ```lang,title="x". The language is
// the leading token; the rest is key="value" pairs split on commas or spaces.
// Unknown keys are ignored.
function parseInfoString(info) {
  const trimmed = info.trim();
  if (!trimmed) return { lang: '', title: '' };

  const [, lang = '', rest = ''] = trimmed.match(/^([^\s,]*)[\s,]*([\s\S]*)$/);
  let title = '';
  const attribute = /([\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|[^\s,]*)/g;
  let match;
  while ((match = attribute.exec(rest))) {
    if (match[1].toLowerCase() !== 'title') continue;
    title = match[3] ?? match[4] ?? match[2];
  }
  return { lang, title };
}

function parseCodeBlock({ lang, title }, text) {
  if (lang.toLowerCase() === 'mermaid') return { type: 'mermaid', lang, text };

  const files = lang.toLowerCase() === 'diff' ? parseUnifiedDiff(text) : [];
  return files.length
    ? { type: 'diff', lang, text, files }
    : { type: 'code', lang, title, text };
}

// `$$` opens display math. On a line of its own it fences until a closing `$$`,
// the way a code fence does — an unclosed one runs to the end of the note — and
// `$$ x = y $$` on a single line is the same block written short.
function parseMathBlock(lines, index) {
  const open = lines[index].trim().match(/^\$\$(.*)$/);
  if (!open) return null;

  const rest = open[1].trim();
  if (rest.endsWith('$$')) {
    return {
      block: { type: 'mathBlock', text: rest.slice(0, -2).trim() },
      nextIndex: index + 1
    };
  }

  const body = rest ? [rest] : [];
  let cursor = index + 1;
  while (cursor < lines.length && !/^\$\$\s*$/.test(lines[cursor].trim())) {
    body.push(lines[cursor]);
    cursor += 1;
  }
  if (cursor < lines.length) cursor += 1;

  return {
    block: { type: 'mathBlock', text: body.join('\n').trim() },
    nextIndex: cursor
  };
}

// A bare URL is matched before the `#tag` alternative can see it, so a fragment
// such as `example.com/page#top` stays part of its link, and a tag has to open a
// word, which leaves `C#` alone. Built from a string rather than a literal so
// the tag rules live in one place — `\x60` is the backtick a raw template
// cannot hold.
const INLINE_TOKEN = new RegExp(
  String.raw`(\x60[^\x60]+\x60|(?<!\\)\$[^\s$\n](?:[^$\n]*[^\s$])?(?<!\\)\$|\[[^\]]+\]\([^)]+\)|!?\[\[[^\]\n]+\]\]|\*\*[^*]+\*\*|\*[^*]+\*|https?:\/\/[^\s<]+|(?<=^|\s)#${TAG_BODY}|(?<=^|\s)who:${ASSIGNEE_BODY})`,
  'gu'
);

export function parseInline(text) {
  const segments = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_TOKEN)) {
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

  if (token.startsWith('$')) return { type: 'math', text: token.slice(1, -1) };

  const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) {
    return { type: 'link', text: link[1], href: safeHref(link[2]) };
  }

  const wikiEmbed = token.match(/^!\[\[([^\]\n]+)\]\]$/);
  if (wikiEmbed) {
    return { type: 'wikiEmbed', ...parseWikiLinkValue(wikiEmbed[1]) };
  }

  const wikiLink = token.match(/^\[\[([^\]\n]+)\]\]$/);
  if (wikiLink) {
    return { type: 'wikiLink', ...parseWikiLinkValue(wikiLink[1]) };
  }

  if (/^https?:\/\//i.test(token))
    return { type: 'link', text: token, href: token };

  if (token.startsWith('#')) return { type: 'tag', text: token.slice(1) };

  // A name reads as a name whatever case it was typed in; `name` is what
  // filtering matches on.
  if (/^who:/i.test(token)) {
    const name = token.slice(4);
    return {
      type: 'assignee',
      text: displayAssignee(name),
      name: name.toLowerCase()
    };
  }

  if (token.startsWith('**'))
    return { type: 'strong', text: token.slice(2, -2) };
  return { type: 'em', text: token.slice(1, -1) };
}

function parseTable(lines, index, base = 0) {
  if (!isTableStart(lines[index], lines[index + 1])) return null;

  const headers = parseTableRow(lines[index]);
  const alignments = parseTableDivider(lines[index + 1]);
  const rows = [];
  const rowLines = [];
  index += 2;

  while (index < lines.length && lines[index].trim()) {
    const row = parseTableRow(lines[index]);
    if (!row) break;
    rows.push(normalizeTableCells(row, headers.length).map(parseInline));
    rowLines.push(base + index);
    index += 1;
  }

  return {
    block: {
      type: 'table',
      alignments,
      headers: headers.map(parseInline),
      rows,
      rowLines
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

// A list runs until the indentation drops below where it started; a deeper item
// opens a sub-list under the item above it. Same-depth items with a different
// marker still start a new list, the way CommonMark reads them.
function parseList(lines, index, base, taskCounter) {
  const { indent, ordered } = parseListItem(lines[index]);
  const items = [];

  while (index < lines.length) {
    const item = parseListItem(lines[index]);
    if (!item || item.indent < indent) break;

    if (item.indent > indent) {
      const parent = items[items.length - 1];
      if (!parent) break;
      const nested = parseList(lines, index, base, taskCounter);
      parent.list = [...(parent.list || []), nested.block];
      index = nested.nextIndex;
      continue;
    }

    if (item.ordered !== ordered) break;
    if (item.task) item.taskIndex = taskCounter.value++;
    item.line = base + index;
    items.push(item);
    index += 1;
  }

  return {
    block: {
      type: 'list',
      ordered,
      items,
      line: items[0]?.line ?? base + index
    },
    nextIndex: index
  };
}

function parseListItem(line) {
  const match = line.match(/^([ \t]*)((?:[-*+])|(?:\d+[.)]))\s+(.+)$/);
  if (!match) return null;

  const task = match[3].match(/^\[([ xX])\]\s+(.+)$/);
  // A task's due date, priority, and completion stamp render as pills rather
  // than as part of the sentence, so they come off the text before inlines.
  const fields = task ? parseTaskFields(task[2]) : null;
  return {
    indent: match[1].replace(/\t/g, '    ').length,
    ordered: /^\d/.test(match[2]),
    task: !!task,
    checked: task ? task[1].toLowerCase() === 'x' : false,
    meta: fields,
    children: parseInline(fields ? fields.text : match[3])
  };
}

function parseQuote(lines, taskCounter, start = 0) {
  const marker = lines[0]?.match(
    /^\[!(note|tldr|deadline|info|idea|warning|error|code|prompt)\]\s*(.*)$/i
  );
  // A bare `>` line is a blank line inside the blockquote: it ends one
  // paragraph and starts the next, so the two must not run together.
  if (!marker)
    return { type: 'quote', paragraphs: quoteParagraphs(lines, start) };

  const variant = marker[1].toLowerCase();
  const title = marker[2].trim() || calloutTitle(variant);
  return {
    type: 'callout',
    variant,
    title: parseInline(title),
    children: renderMarkdown(lines.slice(1).join('\n'), taskCounter, start + 1)
  };
}

function quoteParagraphs(lines, start) {
  const paragraphs = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }
    const first = index;
    const group = [];
    while (index < lines.length && lines[index].trim()) {
      group.push(lines[index]);
      index += 1;
    }
    paragraphs.push({
      children: parseInline(group.join(' ')),
      line: start + first
    });
  }
  return paragraphs;
}

function parseDetails(lines, taskCounter, start = 0) {
  const summary = lines[0]?.trim().match(/^<summary>(.*)<\/summary>\s*$/i);
  return {
    type: 'details',
    summary: parseInline(summary ? summary[1].trim() || 'Details' : 'Details'),
    children: renderMarkdown(
      (summary ? lines.slice(1) : lines).join('\n'),
      taskCounter,
      summary ? start + 1 : start
    )
  };
}

function calloutTitle(variant) {
  return variant === 'tldr'
    ? 'TLDR'
    : variant[0].toUpperCase() + variant.slice(1);
}

function startsBlock(line, nextLine = '') {
  return (
    /^```/.test(line) ||
    /^\$\$/.test(line.trim()) ||
    !!parseNoteEmbedLine(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^<details>\s*$/i.test(line.trim()) ||
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim()) ||
    isTableStart(line, nextLine) ||
    !!parseListItem(line)
  );
}

// `![[note]]` alone on a line previews that note in place. Only a line of its
// own becomes a card: mid-sentence the same token stays inline, and a media
// target keeps embedding the picture rather than growing a card around it.
function parseNoteEmbedLine(line = '') {
  const match = line.trim().match(/^!\[\[([^\]\n]+)\]\]$/);
  if (!match) return null;

  const { target, text } = parseWikiLinkValue(match[1]);
  return isMediaWikiTarget(target) ? null : { type: 'noteEmbed', target, text };
}

function safeHref(href) {
  const trimmed = href.trim();
  return /^(https?:|mailto:|#|\/)/i.test(trimmed) ? trimmed : '';
}
