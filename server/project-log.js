import path from 'node:path';
import { parseFrontmatter } from '../src/frontmatter.js';
import { resolveWikiLinkPath } from '../src/wiki-links.js';

const WIKI_LINK = /!?\[\[([^\]]+)\]\]/g;
const MAX_NOTE_CHARS = 8000;
const SNIPPET_CHARS = 600;
export const MAX_TARGETS = 5;
// A filed line has to stand on its own months later, in a note that never saw
// the day it came from, so it gets more room than a link label would need.
const MAX_SUMMARY_CHARS = 240;

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

const SYSTEM_PROMPT = `You file a day's work into the project notes it belongs to.

You are given one daily note — a dated log of everything its author worked on that day — and a numbered list of candidate project notes from the same personal knowledge workspace. A day usually touches several projects, and often mentions things that belong to no project at all.

For each project note the day genuinely advanced, write the one line that should be added to that project's log. Someone reading only the project note, months later, must learn something from that line that the project note does not already say.

File a project note when the day:
- produced a result, number, or measurement that project depends on
- made or reversed a decision about it
- hit a blocker, bug, or open question in it
- finished, abandoned, or newly started a piece of it
- changed a configuration, method, or plan the project note describes

Do not file a project note when the day:
- only mentions the project, its tools, or its people in passing
- only repeats what the project note already records
- did routine work on it with no outcome worth remembering
- is merely about the same broad research area

Return only a JSON array, with no prose and no code fences:
[{"path": "<a path copied exactly from the candidate list>", "summary": "<one sentence>"}]

Rules:
- Never invent a path. Every path must appear verbatim in the candidate list.
- Return at most ${MAX_TARGETS}, most significant first. Two real updates beat five padded ones, and returning none beats inventing significance.
- Return [] when the day advanced nothing in the list. That is a normal answer, not a failure.
- Each summary is one sentence under ${MAX_SUMMARY_CHARS} characters, written for the project note's reader. Name the specific thing — the result, decision, number, blocker, or change — in the past tense.
- Carry no facts the daily note does not state. Do not guess at causes or next steps it does not name.
- Do not date the summary and do not refer to "the daily note", "today", or "this note". The line is filed under a dated link that already says when.

Good summaries:
- "Traced the eval-harness OOM to the batch-size default, which is 32 rather than the 8 the config claims."
- "Dropped the hybrid retrieval scheme after it lost 4 points of recall to plain BM25."
- "Tracking efficiency drop is not the detector geometry; ruled that out by rerunning with the old alignment."

Bad summaries, because the project note learns nothing from them:
- "Continued work on model training and evaluation."
- "Made progress on the project and discussed next steps."
- "Worked on infrastructure related to this project."`;

/**
 * Project notes the day might belong in, ranked by TF-IDF cosine similarity
 * over the workspace corpus.
 *
 * Lexical rather than semantic on purpose: it needs no index to maintain, no
 * network call, and no dependency, and its job is only to narrow a few hundred
 * notes to a shortlist the model can read in full. The model does the judging.
 *
 * Other daily notes are never candidates. Filing one day into another would
 * only copy a log sideways, and `dailyNoteFolder` already says where they live.
 * Notes that link back to the day are dropped too, so filing the same day twice
 * cannot double an entry; they are returned as `filed` so the caller can say
 * they were left alone rather than silently omitting them.
 *
 * `files` is the corpus from the workspace's markdown file cache; `target` is
 * `{path, content}` for the daily note being filed.
 */
export function rankProjectCandidates(
  files,
  target,
  { dailyNoteFolder = '', limit = 12 } = {}
) {
  const markdown = (files || []).filter(
    (file) => file.fileKind === 'markdown' && typeof file.content === 'string'
  );
  const documents = markdown
    .filter((file) => !inFolder(file.path, dailyNoteFolder))
    .map((file) => ({ file, terms: termCounts(bodyOf(file.content)) }));

  // Resolution has to see the whole workspace, daily notes included, or the
  // backlink a project note already carries would not be recognised as one.
  const paths = markdown.map((file) => file.path);
  if (!paths.includes(target.path)) paths.push(target.path);
  const filed = documents
    .filter((document) =>
      linksTo(document.file, target.path, paths, dailyNoteFolder)
    )
    .map((document) => document.file.path);
  const excluded = new Set([target.path, ...filed]);

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
    // A project the day names by title is one the day almost certainly worked
    // on, whatever the rest of the wording overlap says.
    if (titleInText(file.path, targetTerms)) score *= 1.2;

    ranked.push({
      path: file.path,
      title: titleOf(file),
      tags,
      snippet: snippetOf(file.content),
      score
    });
  }

  const candidates = ranked
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, limit));

  return { candidates, filed };
}

/** Provider messages in the same shape `server/ai.js` builds elsewhere. */
export function buildProjectLogMessages(target, candidates) {
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
      content: `Daily note ${target.path}:\n${trimNote(target.content)}\n\nCandidate project notes:\n${digest}`
    }
  ];
}

/**
 * Reads the model's reply into filing entries, keeping only paths it was
 * actually offered. A reply that is partly malformed degrades to the usable
 * part plus a warning rather than failing the whole request.
 *
 * An entry with no summary is dropped rather than filed bare: the whole point
 * of writing into another note is the sentence, and a lone backlink there
 * would say less than the linked mention the note already shows.
 */
export function parseProjectLogEntries(text, candidates) {
  const byPath = new Map(
    candidates.map((candidate) => [candidate.path, candidate])
  );
  const parsed = parseJsonArray(text);
  if (!parsed) {
    return {
      entries: [],
      warning: 'The model did not return a usable list of project notes.'
    };
  }

  const entries = [];
  const seen = new Set();
  let invented = 0;
  let empty = 0;

  for (const entry of parsed) {
    const candidatePath =
      typeof entry?.path === 'string' ? entry.path.trim() : '';
    const candidate = byPath.get(candidatePath);
    if (!candidate) {
      if (candidatePath) invented += 1;
      continue;
    }
    if (seen.has(candidate.path)) continue;

    const summary = cleanSummary(entry.summary);
    if (!summary) {
      empty += 1;
      continue;
    }
    seen.add(candidate.path);

    entries.push({
      path: candidate.path,
      title: candidate.title,
      summary
    });
    if (entries.length >= MAX_TARGETS) break;
  }

  const warnings = [];
  if (invented) {
    warnings.push(
      `Ignored ${invented} project note${invented === 1 ? '' : 's'} that ${invented === 1 ? 'does' : 'do'} not exist in this workspace.`
    );
  }
  if (empty) {
    warnings.push(
      `Ignored ${empty} project note${empty === 1 ? '' : 's'} the model gave no summary for.`
    );
  }

  return { entries, warning: warnings.join(' ') || undefined };
}

/** Whether `filePath` sits inside `folder`, which may be `/` or unset. */
function inFolder(filePath, folder) {
  const base = String(folder || '').replace(/\/+$/, '');
  if (!base || base === '') return false;
  return filePath === base || filePath.startsWith(`${base}/`);
}

/** Whether `file` already carries a wiki link that resolves to `targetPath`. */
function linksTo(file, targetPath, paths, dailyNoteFolder) {
  for (const match of String(file.content || '').matchAll(WIKI_LINK)) {
    const value = match[1].split('|')[0].split('#')[0].trim();
    const resolved = resolveWikiLinkPath(value, file.path, paths, {
      dailyNoteFolder
    });
    if (resolved === targetPath) return true;
  }
  return false;
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

/** A note whose file name is spoken about in the day is likely one it worked on. */
function titleInText(filePath, targetTerms) {
  const stem = path
    .basename(filePath)
    .replace(/\.(md|markdown)$/i, '')
    .toLowerCase();
  const tokens = stem.split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
  return tokens.length > 0 && tokens.every((token) => targetTerms.has(token));
}

// Several lines rather than one: the model can only write a summary worth
// filing if the digest shows what the project note already says.
function snippetOf(content) {
  const { body } = parseFrontmatter(String(content || ''));
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('---'));

  const prose = lines.join(' ');
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

function cleanSummary(summary) {
  const text =
    typeof summary === 'string' ? summary.replace(/\s+/g, ' ').trim() : '';
  return text.length > MAX_SUMMARY_CHARS
    ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : text;
}
