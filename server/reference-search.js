import { WorkspaceError } from './workspace.js';

const MAX_CANDIDATES = 150;
const MAX_MATCHES = 15;

const text = (entry) =>
  `${entry.key} ${entry.title} ${entry.author} ${entry.year} ${entry.fields?.abstract ?? ''}`.toLowerCase();

/** Entries sharing the most words with the query, so a big .bib stays one cheap call. */
export function shortlistReferences(entries, query, limit = MAX_CANDIDATES) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return entries
    .map((entry, index) => {
      const haystack = text(entry);
      return { entry, index, hits: words.filter((w) => haystack.includes(w)).length };
    })
    .sort((a, b) => b.hits - a.hits || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.entry);
}

export function buildReferenceSearchMessages(query, candidates) {
  const list = candidates
    .map((e) =>
      [e.key, e.year, e.title, e.author.split(' and ').slice(0, 3).join('; ')]
        .filter(Boolean)
        .join(' | ')
    )
    .join('\n');
  return [
    {
      role: 'system',
      content: `You search a researcher's bibliography. Reply with JSON only: {"matches":[{"key":"<citation key>","reason":"<one short sentence>"}]}, best first, at most ${MAX_MATCHES}, only keys from the list. Use {"matches":[]} when nothing fits.`
    },
    { role: 'user', content: `Looking for: ${query}\n\nEntries (key | year | title | authors):\n${list}` }
  ];
}

export function parseReferenceMatches(reply, candidates) {
  let parsed;
  try {
    parsed = JSON.parse(String(reply).slice(String(reply).indexOf('{')));
  } catch {
    throw new WorkspaceError(502, 'The model did not return a usable answer.');
  }
  const keys = new Set(candidates.map((e) => e.key));
  return (Array.isArray(parsed.matches) ? parsed.matches : [])
    .filter((m) => keys.has(m?.key))
    .slice(0, MAX_MATCHES)
    .map((m) => ({ key: m.key, reason: String(m.reason ?? '').slice(0, 260) }));
}
