const CITE_KEY = String.raw`[^\s\[\],@;]+`;
const CITE = new RegExp(String.raw`\[@(${CITE_KEY})\]`, 'g');
const ARXIV_ID = String.raw`(?:\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?`;
const ARXIV_URL = new RegExp(
  String.raw`^(?:https?://)?(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/(${ARXIV_ID})(?:\.pdf)?\/?$`,
  'i'
);
const DOI_URL =
  /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)(10\.\d{4,9}\/\S+)$/i;
const INSPIRE_URL =
  /^(?:https?:\/\/)?(?:www\.)?inspirehep\.net\/(?:literature|record)\/(\d+)\/?$/i;

export function citationPasteSource(text, { beforeCursor = '' } = {}) {
  if (/[(<]$/.test(beforeCursor)) return null;
  const value = String(text ?? '').trim();
  return ARXIV_URL.test(value) || DOI_URL.test(value) || INSPIRE_URL.test(value)
    ? value
    : null;
}

export function citationSource(value) {
  const text = String(value ?? '').trim();
  let match = ARXIV_URL.exec(text);
  if (match) return { kind: 'arxiv', id: match[1] };
  match = DOI_URL.exec(text);
  if (match) return { kind: 'doi', id: match[1].replace(/[.,;]+$/, '') };
  match = INSPIRE_URL.exec(text);
  return match ? { kind: 'inspire', id: match[1] } : null;
}

export function parseBibtex(source = '') {
  const entries = [];
  const text = String(source ?? '');
  const start = /@([A-Za-z]+)\s*([({])/g;
  let match;

  while ((match = start.exec(text))) {
    const close = match[2] === '(' ? ')' : '}';
    const end = balancedEnd(text, start.lastIndex, match[2], close);
    if (end === -1) break;
    const body = text.slice(start.lastIndex, end);
    const comma = topLevelComma(body);
    const key = comma === -1 ? '' : body.slice(0, comma).trim();
    if (key && !/[\s[\],@;{}]/.test(key)) {
      const fields = parseFields(body.slice(comma + 1));
      entries.push({
        key,
        type: match[1].toLowerCase(),
        fields,
        title: cleanBibtex(fields.title),
        author: cleanBibtex(fields.author),
        year: cleanBibtex(fields.year),
        doi: cleanBibtex(fields.doi),
        url: cleanBibtex(fields.url),
        arxiv: cleanBibtex(fields.eprint)
      });
    }
    start.lastIndex = end + 1;
  }
  return entries;
}

export function citationKeys(source = '') {
  return [...String(source ?? '').matchAll(CITE)].map((match) => match[1]);
}

export function citationCompletionQuery(beforeCursor = '') {
  const line = String(beforeCursor ?? '')
    .split('\n')
    .at(-1);
  const match = /(?:^|[\s[(])@([^\s\[\],@;]*)$/.exec(line);
  return match ? { query: match[1], length: match[1].length } : null;
}

export function citationCompletions(query, entries = []) {
  const needle = String(query ?? '').toLowerCase();
  return entries
    .map((entry) => {
      const key = entry.key.toLowerCase();
      const haystack =
        `${entry.key} ${entry.title} ${entry.author}`.toLowerCase();
      const index = key.indexOf(needle);
      return {
        entry,
        score: index === 0 ? 0 : haystack.indexOf(needle) === -1 ? null : 1
      };
    })
    .filter(({ score }) => score !== null)
    .sort((a, b) => a.score - b.score || a.entry.key.localeCompare(b.entry.key))
    .slice(0, 25)
    .map(({ entry }) => ({
      label: entry.key,
      detail: [firstAuthor(entry.author), entry.year]
        .filter(Boolean)
        .join(', '),
      target: entry.key
    }));
}

export function citationLabel(entry) {
  if (!entry) return '';
  return (
    [firstAuthor(entry.author), entry.year].filter(Boolean).join(', ') ||
    entry.key
  );
}

export function citationUrl(entry) {
  if (!entry) return '';
  if (entry.doi) return `https://doi.org/${entry.doi}`;
  if (/^https?:\/\//i.test(entry.url)) return entry.url;
  return entry.arxiv ? `https://arxiv.org/abs/${entry.arxiv}` : '';
}

// Reference lines name the work, not its whole collaboration: an ATLAS paper
// carries three thousand authors, so anything past a pair collapses to the
// first author's surname.
export function citationAuthors(entry) {
  const names = String(entry?.author ?? '')
    .split(/\s+and\s+/i)
    .map((name) => surname(name))
    .filter(Boolean);
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return names.length === 2
    ? `${names[0]} and ${names[1]}`
    : `${names[0]} et al.`;
}

// Where the work appeared, so a published paper reads differently from a
// preprint: journal (or proceedings) with whatever volume and pages we have.
export function citationVenue(entry) {
  const journal = cleanBibtex(
    entry?.fields?.journal || entry?.fields?.booktitle
  );
  if (!journal) return '';
  const volume = cleanBibtex(entry?.fields?.volume);
  const pages = cleanBibtex(entry?.fields?.pages).replace(/--/g, '–');
  // Phys. Lett. B 716, 1-29 - the comma only earns its place between a volume
  // and the pages inside it.
  const locator = [volume, pages].filter(Boolean).join(', ');
  return [journal, locator].filter(Boolean).join(' ');
}

// The identifier people actually quote and paste into a search box.
export function citationArxiv(entry) {
  return entry?.arxiv ? `arXiv:${entry.arxiv}` : '';
}

export function citationSummary(entry) {
  return entry
    ? [
        citationAuthors(entry),
        entry.title,
        entry.year,
        citationVenue(entry),
        citationArxiv(entry)
      ]
        .filter(Boolean)
        .join(' — ')
    : '';
}

function balancedEnd(text, from, open, close) {
  let depth = 1;
  let quoted = false;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && text[index - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (character === open) depth += 1;
    if (character === close && --depth === 0) return index;
  }
  return -1;
}

function topLevelComma(text) {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && text[index - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (character === ',' && depth === 0) return index;
  }
  return -1;
}

function parseFields(text) {
  const fields = {};
  let index = 0;
  while (index < text.length) {
    const match = /\s*,?\s*([A-Za-z][\w-]*)\s*=\s*/y;
    match.lastIndex = index;
    const field = match.exec(text);
    if (!field) break;
    index = match.lastIndex;
    const value = readValue(text, index);
    fields[field[1].toLowerCase()] = value.text;
    index = value.end;
  }
  return fields;
}

function readValue(text, from) {
  if (text[from] === '{') {
    const end = balancedEnd(text, from + 1, '{', '}');
    return {
      text: text.slice(from + 1, end === -1 ? text.length : end),
      end: end + 1
    };
  }
  if (text[from] === '"') {
    let end = from + 1;
    while (end < text.length && (text[end] !== '"' || text[end - 1] === '\\'))
      end += 1;
    return { text: text.slice(from + 1, end), end: end + 1 };
  }
  const end = text.indexOf(',', from);
  return {
    text: text.slice(from, end === -1 ? text.length : end).trim(),
    end: end === -1 ? text.length : end
  };
}

function cleanBibtex(value = '') {
  return String(value)
    .replace(/[{}]/g, '')
    .replace(/\\([&%_#])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstAuthor(authors = '') {
  return surname(authors.split(/\s+and\s+/i)[0]);
}

function surname(name = '') {
  const trimmed = cleanBibtex(name);
  if (!trimmed) return '';
  if (trimmed.includes(',')) return trimmed.split(',')[0].trim();
  return trimmed.split(/\s+/).at(-1);
}
