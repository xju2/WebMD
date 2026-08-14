import path from 'node:path';
import { parseFrontmatter } from '../src/frontmatter.js';
import { resolveWikiLinkPath } from '../src/wiki-links.js';

const WIKI_LINK = /!?\[\[([^\]]+)\]\]/g;
const MAX_NOTE_CHARS = 8000;
const SNIPPET_CHARS = 220;
export const MAX_SUGGESTIONS = 5;
const MAX_REASON_CHARS = 140;

// Small and deliberately generic: the IDF term weighting already discounts
// words that appear everywhere in a given workspace, so this list only has to
// cover the ones that would otherwise dominate a short daily note.
const STOPWORDS = new Set(
  `about after all also and any are because been before being but can could did
   does doing done each for from had has have how into its just like made make
   more most much need not now off one only other our out over same should some
   such than that the their them then there these they this those through too
   under use used using very was were what when where which while who why will
   with would you your`.split(/\s+/)
);

const SYSTEM_PROMPT = `You connect a Markdown note to other notes in the same personal knowledge workspace.

You are given the note and a numbered list of candidate notes that share vocabulary with it. Choose the candidates whose subject matter genuinely continues, explains, or precedes what this note is about — the ones its author would want to click through to months from now. Shared jargon alone is not a connection.

Return only a JSON array, with no prose and no code fences:
[{"path": "<a path copied exactly from the candidate list>", "reason": "<one short clause>"}]

Rules:
- Never invent a path. Every path must appear verbatim in the candidate list.
- Return at most ${MAX_SUGGESTIONS}, ordered strongest first. Prefer three strong links to five weak ones.
- Return [] when nothing in the list is genuinely related. That is a normal answer, not a failure.
- Each reason is one line under ${MAX_REASON_CHARS} characters saying what the two notes share. Do not restate the title.`;

/**
 * Candidate notes for `target`, ranked by TF-IDF cosine similarity over the
 * workspace corpus.
 *
 * Lexical rather than semantic on purpose: it needs no index to maintain, no
 * network call, and no dependency, and its job is only to narrow a few hundred
 * notes to a shortlist the model can read in full. The model does the judging.
 *
 * `files` is the corpus from the workspace's markdown file cache; `target` is
 * `{path, content}` for the note being connected.
 */
export function rankRelatedCandidates(files, target, { limit = 12 } = {}) {
  const documents = (files || [])
    .filter(
      (file) => file.fileKind === 'markdown' && typeof file.content === 'string'
    )
    .map((file) => ({ file, terms: termCounts(bodyOf(file.content)) }));

  const excluded = new Set([
    target.path,
    ...linkedPaths(
      target,
      documents.map((document) => document.file.path)
    )
  ]);

  const frequencies = new Map();
  for (const document of documents) {
    for (const term of document.terms.keys()) {
      frequencies.set(term, (frequencies.get(term) || 0) + 1);
    }
  }

  const total = documents.length || 1;
  const targetTerms = termCounts(bodyOf(target.content));
  const targetWeights = termWeights(targetTerms, frequencies, total);
  const targetTags = tagsOf(target);

  const ranked = [];
  for (const { file, terms } of documents) {
    if (excluded.has(file.path)) continue;

    const weights = termWeights(terms, frequencies, total);
    let dot = 0;
    let norm = 0;
    for (const [term, weight] of weights) {
      norm += weight * weight;
      dot += (targetWeights.get(term) || 0) * weight;
    }
    if (!dot) continue;

    // Only the candidate norm matters: the target's is the same divisor for
    // every candidate and so cannot change the order.
    let score = dot / Math.sqrt(norm);
    const tags = tagsOf(file);
    const shared = tags.filter((tag) => targetTags.includes(tag)).length;
    if (shared) score *= 1 + 0.25 * shared;
    if (titleInText(file.path, targetTerms)) score *= 1.2;

    ranked.push({
      path: file.path,
      title: titleOf(file),
      tags,
      snippet: snippetOf(file.content),
      score
    });
  }

  return ranked
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, limit));
}

/** Provider messages in the same shape `server/ai.js` builds elsewhere. */
export function buildRelatedMessages(target, candidates) {
  const digest = candidates
    .map((candidate, index) => {
      const tags = candidate.tags?.length
        ? ` [tags: ${candidate.tags.join(', ')}]`
        : '';
      const snippet = candidate.snippet ? `\n   ${candidate.snippet}` : '';
      return `${index + 1}. ${candidate.path} — ${candidate.title}${tags}${snippet}`;
    })
    .join('\n');

  return [
    { role: 'developer', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Note ${target.path}:\n${trimNote(target.content)}\n\nCandidate notes:\n${digest}`
    }
  ];
}

/**
 * Reads the model's reply into suggestions, keeping only paths it was actually
 * offered. A reply that is partly malformed degrades to the usable part plus a
 * warning rather than failing the whole request.
 */
export function parseRelatedSuggestions(text, candidates) {
  const byPath = new Map(
    candidates.map((candidate) => [candidate.path, candidate])
  );
  const entries = parseJsonArray(text);
  if (!entries) {
    return {
      suggestions: [],
      warning: 'The model did not return a usable list of links.'
    };
  }

  const suggestions = [];
  const seen = new Set();
  let invented = 0;

  for (const entry of entries) {
    const candidatePath =
      typeof entry?.path === 'string' ? entry.path.trim() : '';
    const candidate = byPath.get(candidatePath);
    if (!candidate) {
      if (candidatePath) invented += 1;
      continue;
    }
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);

    suggestions.push({
      path: candidate.path,
      title: candidate.title,
      reason: cleanReason(entry.reason)
    });
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }

  return {
    suggestions,
    warning: invented
      ? `Ignored ${invented} suggested note${invented === 1 ? '' : 's'} that ${invented === 1 ? 'does' : 'do'} not exist in this workspace.`
      : undefined
  };
}

/** Paths the note already links to, so they are never suggested again. */
function linkedPaths(target, paths) {
  const linked = [];
  for (const match of String(target.content || '').matchAll(WIKI_LINK)) {
    const value = match[1].split('|')[0].trim();
    const resolved = resolveWikiLinkPath(value, target.path, paths);
    if (resolved) linked.push(resolved);
  }
  return linked;
}

function termWeights(terms, frequencies, total) {
  const weights = new Map();
  for (const [term, count] of terms) {
    const documentFrequency = frequencies.get(term) || 1;
    const idf = Math.log(1 + total / documentFrequency);
    weights.set(term, (1 + Math.log(count)) * idf);
  }
  return weights;
}

function termCounts(text) {
  const counts = new Map();
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .toLowerCase();

  for (const token of cleaned.split(/[^a-z0-9]+/)) {
    // Bare numbers are almost always dates or counts in these notes, and they
    // link unrelated notes together far more often than they link related ones.
    if (token.length < 3 || STOPWORDS.has(token) || /^\d+$/.test(token))
      continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  return counts;
}

function bodyOf(content) {
  return parseFrontmatter(String(content || '')).body;
}

function tagsOf(file) {
  const tags =
    file.metadata?.tags ??
    parseFrontmatter(String(file.content || '')).attributes.tags;
  const list = Array.isArray(tags) ? tags : tags ? [tags] : [];
  return list.map((tag) => String(tag).toLowerCase());
}

function titleOf(file) {
  const { attributes, body } = parseFrontmatter(String(file.content || ''));
  if (attributes.title) return String(attributes.title);
  const heading = body.match(/^#{1,3}[ \t]+(\S[^\n]*)$/m);
  if (heading) return heading[1].trim();
  return path.basename(file.path).replace(/\.(md|markdown)$/i, '');
}

/** A note whose file name is spoken about in the target is likely relevant. */
function titleInText(filePath, targetTerms) {
  const stem = path
    .basename(filePath)
    .replace(/\.(md|markdown)$/i, '')
    .toLowerCase();
  const tokens = stem.split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
  return tokens.length > 0 && tokens.every((token) => targetTerms.has(token));
}

function snippetOf(content) {
  const { body } = parseFrontmatter(String(content || ''));
  const prose = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('---'));
  if (!prose) return '';
  return prose.length > SNIPPET_CHARS
    ? `${prose.slice(0, SNIPPET_CHARS)}...`
    : prose;
}

function trimNote(content) {
  const text = String(content || '');
  return text.length > MAX_NOTE_CHARS
    ? `${text.slice(0, MAX_NOTE_CHARS)}\n\n[Note truncated]`
    : text;
}

/** Tolerates code fences and stray prose around the JSON array. */
function parseJsonArray(text) {
  const raw = String(text || '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end < start) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanReason(reason) {
  const text =
    typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  return text.length > MAX_REASON_CHARS
    ? `${text.slice(0, MAX_REASON_CHARS - 1)}…`
    : text;
}
