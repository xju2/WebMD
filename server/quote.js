import fs from 'node:fs/promises';

export const QUOTE_HISTORY_PATH = '/.webmd/quotes.json';

// The whole point of the placeholder is that today does not read like
// yesterday, and a model asked for "a thought-provoking quote" returns the same
// handful of famous lines forever. Three defences, in order of how much they
// buy: the theme is picked from the date so consecutive days cannot even be
// about the same subject, every quote we have already used is sent back as an
// exclusion list, and a repeat that slips through is caught after the fact and
// retried.
export const QUOTE_THEMES = ['life', 'programming', 'finance'];

/**
 * `QUOTE_THEMES` in the environment (or `~/.webmd.conf`) replaces the default
 * rotation with a comma-separated list of your own. Duplicates are dropped so
 * one theme cannot crowd out the rest of the cycle, and an empty or unusable
 * setting falls back rather than leaving the placeholder with nothing to ask
 * for.
 */
export function quoteThemes(env = process.env) {
  const configured = String(env?.QUOTE_THEMES ?? '')
    .split(',')
    .map((theme) => theme.trim())
    .filter(Boolean);
  const unique = [...new Set(configured)];
  return unique.length ? unique : QUOTE_THEMES;
}

// Enough history that a year of daily notes never silently recycles, small
// enough that the exclusion list stays a sane fraction of the prompt.
const MAX_HISTORY = 120;
const EXCLUDED_QUOTES = 60;
const EXCLUDED_AUTHORS = 20;
const MAX_QUOTE_CHARS = 240;
const MAX_SAID_CHARS = 20;

/**
 * The theme rotates with the calendar day rather than at random so that two
 * notes created in the same week are guaranteed to span different subjects,
 * and so a regenerated note keeps the theme it had.
 */
export function quoteTheme(date, themes = QUOTE_THEMES) {
  const days = Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000
  );
  return themes[((days % themes.length) + themes.length) % themes.length];
}

/**
 * The calendar day in the server's own timezone. The daily note is named after
 * a local date, so a UTC key would file the quote under the wrong day for
 * anyone west of Greenwich.
 */
export function quoteDayKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function buildQuoteMessages({ date, theme, history = [], avoidRepeat = false }) {
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
  const iso = quoteDayKey(date);
  const recent = history.slice(-EXCLUDED_QUOTES);
  const authors = [
    ...new Set(
      history
        .slice(-EXCLUDED_AUTHORS)
        .map((entry) => entry.author)
        .filter(Boolean)
    )
  ];

  const system = `You choose one real, attributable quotation for the top of someone's daily note.

The quote must be genuinely thought-provoking: something that changes how the reader approaches the day, not a motivational poster line. Prefer sharp, specific, slightly uncomfortable observations from people who earned the right to make them — practitioners, writers, scientists, investors, engineers.

Rules:
- Quote real words by a real, named person. Never invent a quotation or an attribution. If you are unsure the wording is right, choose a different quote you are sure of.
- Avoid the exhausted canon: no "stay hungry, stay foolish", no "be the change", no fortune-cookie Confucius, no misattributed Einstein or Twain.
- Keep it under ${MAX_QUOTE_CHARS} characters, on a single line, with no line breaks.
- Say when the words were said or published, as a year ("1974"), or a fuller date if you are sure of one ("1974-05-08"). This is the date of the quote itself, never today's date. Leave it empty rather than guessing.
- Return only JSON, with no prose and no code fences: {"quote": "<the words>", "author": "<name>", "said": "<when>"}
- The quote field holds the words alone: no surrounding quotation marks, no attribution, no source title.`;

  const lines = [
    `Today is ${weekday}, ${iso}. Choose a quote about ${theme}.`,
    `Let it sit well with a ${weekday}: what someone starting this particular day would benefit from turning over.`
  ];

  if (recent.length) {
    lines.push(
      '',
      'This note already used the quotes below. Do not repeat any of them, and do not return a close paraphrase or another famous line making the same point:',
      ...recent.map((entry) => `- ${entry.author || 'Unknown'}: ${entry.text}`)
    );
  }
  if (authors.length) {
    lines.push(
      '',
      `Also pick someone other than these recently quoted people: ${authors.join(', ')}.`
    );
  }
  if (avoidRepeat) {
    lines.push(
      '',
      'Your previous answer repeated a quote from that list. Choose a different quote by a different person.'
    );
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') }
  ];
}

/**
 * Accepts the JSON we asked for, and falls back to a bare `"words" — Author`
 * line, which is what a smaller local model tends to return instead.
 */
export function parseQuote(reply) {
  const text = String(reply ?? '').trim();
  if (!text) return null;

  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      const quote = cleanQuote(parsed?.quote);
      if (quote)
        return {
          text: quote,
          author: cleanAuthor(parsed?.author),
          said: cleanSaid(parsed?.said)
        };
    } catch {
      // Smart quotes, a trailing comma, or an unescaped quotation mark inside
      // the words are enough to break JSON.parse. Read the fields out by hand
      // rather than letting the whole blob fall through as the quote itself.
      const fields = readJsonFields(json);
      if (fields) return fields;
    }
  }

  const line = text.split('\n').find((candidate) => candidate.trim()) ?? '';
  const split = line.match(/^(.*?)\s+[—–-]{1,2}\s*([^—–]+)$/);
  const quote = cleanQuote(split ? split[1] : line);
  if (!quote || looksLikeJson(quote)) return null;
  // `words -- Author (1974)` carries the date in the tail, not in the name.
  const tail = String(split?.[2] ?? '');
  const dated = tail.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return {
    text: quote,
    author: cleanAuthor(dated ? dated[1] : tail),
    said: cleanSaid(dated?.[2])
  };
}

/** Last resort for a JSON-shaped reply that will not parse. */
function readJsonFields(json) {
  const match = json.match(
    /["“”]quote["“”]\s*:\s*["“”]([\s\S]*?)["“”]\s*(?:,\s*["“”]author|\})/
  );
  const quote = cleanQuote(match?.[1]);
  if (!quote || looksLikeJson(quote)) return null;
  const author = json.match(/["“”]author["“”]\s*:\s*["“”]([\s\S]*?)["“”]\s*[,\}]?/)?.[1];
  const said = json.match(/["“”]said["“”]\s*:\s*["“”]([\s\S]*?)["“”]\s*[,\}]?/)?.[1];
  return { text: quote, author: cleanAuthor(author), said: cleanSaid(said) };
}

/** A quote is words, never the envelope we asked the model to put them in. */
function looksLikeJson(value) {
  return /^\{/.test(value) || /["“”]quote["“”]\s*:/.test(value);
}

/**
 * Always `"{quote}" -- {author} ({date})`, on one line so a `> {{quote}}`
 * template stays a single blockquote. The shape is fixed on purpose: a note
 * written today should line up with one written a year ago, so a missing
 * author becomes "Unknown" rather than a differently-shaped line.
 *
 * The date is when the quote was said, not the day the note was written —
 * knowing a line is from 1974 is what places it; repeating today's date on
 * every note says nothing.
 */
export function formatQuote(quote, said = quote?.said) {
  if (!quote?.text) return '';
  const line = `"${quote.text}" -- ${quote.author || 'Unknown'}`;
  return said ? `${line} (${said})` : line;
}

export function quoteKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isRepeatQuote(quote, history = []) {
  if (!quote?.text) return false;
  const key = quoteKey(quote.text);
  return history.some((entry) => quoteKey(entry.text) === key);
}

export function appendQuoteHistory(history, entry) {
  return [...history.filter((item) => item.date !== entry.date), entry].slice(
    -MAX_HISTORY
  );
}

export async function readQuoteHistory(workspace) {
  let raw;
  try {
    const absolute = await workspace.resolvePath(QUOTE_HISTORY_PATH);
    raw = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    // No history yet is the normal first-run case.
    if (error.status === 404 || error.code === 'ENOENT') return [];
    if (error.status === 403) return [];
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : parsed?.quotes;
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((entry) => entry && typeof entry.text === 'string' && entry.text)
      .map((entry) => ({
        date: String(entry.date ?? ''),
        text: entry.text,
        author: typeof entry.author === 'string' ? entry.author : '',
        said: typeof entry.said === 'string' ? entry.said : ''
      }));
  } catch {
    // A corrupt history costs us de-duplication, not the quote itself.
    return [];
  }
}

export async function writeQuoteHistory(workspace, history) {
  const absolute = await workspace.resolvePath(QUOTE_HISTORY_PATH, {
    forWrite: true
  });
  await fs.mkdir(absolute.replace(/\/[^/]*$/, ''), { recursive: true });
  await fs.writeFile(absolute, `${JSON.stringify({ quotes: history }, null, 2)}\n`);
}

function cleanQuote(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“”'']+|["“”'']+$/g, '')
    .trim()
    .slice(0, MAX_QUOTE_CHARS);
}

/** When the words were said: a year, or a date, never prose about a source. */
function cleanSaid(value) {
  const said = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[(\[]|[)\]]$/g, '')
    .trim()
    .slice(0, MAX_SAID_CHARS);
  return /\d{3,4}/.test(said) ? said : '';
}

function cleanAuthor(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[—–-]\s*/, '')
    .replace(/[.,]$/, '')
    .slice(0, 80);
}
