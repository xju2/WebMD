import fs from 'node:fs/promises';
import { parseFrontmatter } from '../src/frontmatter.js';

/** A note in the workspace, so the instructions are edited like any other. */
export const NEWS_INSTRUCTIONS_PATH = '/.webmd/news.md';
const MAX_INSTRUCTIONS_CHARS = 4000;

// Enough of each paper for the model to tell a method paper from a physics
// result, few enough that a day of hep-ex through cs.AI stays one sane call.
const MAX_CANDIDATES = 120;
const ABSTRACT_CHARS = 360;
export const MAX_PICKS = 20;
export const TOP_PICKS = 5;
const MAX_CONNECTION_CHARS = 48;
const MAX_READING = 40;
const MAX_RECENT_NOTES = 8;
const NOTE_SNIPPET_CHARS = 500;
// Asked for under this; trimmed only well past it, because a model that runs a
// little long has usually still written one good sentence.
const REASON_CHARS = 160;
const MAX_REASON_CHARS = 260;

const STOPWORDS = new Set(
  `about after all also and any are based because been before being between both
   but can could data did does each for from had has have how into its just like
   made make method methods model models more most much new not now off one only
   other our out over paper present propose proposed results same show should
   some such than that the their them then there these they this those through
   too two under use used using very via was were what when where which while
   who why will with within work would you your`.split(/\s+/)
);

const CITED_TITLE = /"([^"\n]{12,300})"\s*[—–-]+\s*\[arXiv:/g;

/**
 * What this workspace says its owner cares about, in three parts: what they
 * wrote down as interests, the papers they have cited or clipped (the most
 * direct record of what they read), and what their most recent notes are
 * about (what they are working on this week).
 */
export function buildInterestProfile({
  files = [],
  references = [],
  interests = ''
}) {
  const notes = files
    .filter(
      (file) => file.fileKind === 'markdown' && typeof file.content === 'string'
    )
    .sort((left, right) => (right.mtimeMs || 0) - (left.mtimeMs || 0));

  const reading = [];
  const seen = new Set();
  const addTitle = (title) => {
    const clean = collapse(title);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) return;
    seen.add(key);
    reading.push(clean);
  };
  // Newest notes first, so a long history keeps the papers read lately.
  for (const note of notes) {
    for (const match of note.content.matchAll(CITED_TITLE)) addTitle(match[1]);
  }
  for (const entry of references) addTitle(entry.title);

  const recent = notes
    .map((note) => ({ path: note.path, snippet: noteSnippet(note.content) }))
    .filter((note) => note.snippet)
    .slice(0, MAX_RECENT_NOTES);

  return {
    interests: String(interests ?? '').trim(),
    reading: reading.slice(0, MAX_READING),
    recent
  };
}

/**
 * The ranking instructions note, without its frontmatter and HTML comments, so
 * the starter note can explain itself without that explanation reaching the
 * model. A missing note is the normal first-run case.
 */
export async function readNewsInstructions(workspace) {
  let raw;
  try {
    raw = await fs.readFile(
      await workspace.resolvePath(NEWS_INSTRUCTIONS_PATH),
      'utf8'
    );
  } catch (error) {
    if (error.status === 404 || error.status === 403 || error.code === 'ENOENT')
      return '';
    throw error;
  }
  return clip(
    parseFrontmatter(raw)
      .body.replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    MAX_INSTRUCTIONS_CHARS
  );
}

export function profileIsEmpty(profile) {
  return (
    !profile.interests && !profile.reading.length && !profile.recent.length
  );
}

/**
 * A lexical score for every paper: how much of the profile's vocabulary it
 * uses, weighted by how rare each word is in today's listing, so "learning" or
 * "detector" count for little and "calorimeter" or "diffusion" for a lot. It
 * orders the tail and chooses what the model reads; the model does the judging.
 */
export function scorePapers(papers = [], profile) {
  const profileWeights = new Map();
  const add = (text, weight) => {
    for (const term of terms(text)) {
      profileWeights.set(term, (profileWeights.get(term) || 0) + weight);
    }
  };
  add(profile.interests, 3);
  for (const title of profile.reading) add(title, 2);
  for (const note of profile.recent) add(note.snippet, 1);

  const documents = papers.map((paper) => ({
    id: paper.id,
    terms: new Set(terms(`${paper.title} ${paper.title} ${paper.abstract}`))
  }));
  const frequencies = new Map();
  for (const { terms: paperTerms } of documents) {
    for (const term of paperTerms) {
      frequencies.set(term, (frequencies.get(term) || 0) + 1);
    }
  }

  const total = documents.length || 1;
  const scores = new Map();
  for (const { id, terms: paperTerms } of documents) {
    let score = 0;
    for (const term of paperTerms) {
      const weight = profileWeights.get(term);
      if (!weight) continue;
      score +=
        Math.log(1 + weight) * Math.log(1 + total / frequencies.get(term));
    }
    scores.set(id, paperTerms.size ? score / Math.sqrt(paperTerms.size) : 0);
  }
  return scores;
}

/** Papers ordered by `scores`, keeping arXiv's order among equals. */
export function orderByScore(papers, scores) {
  return papers
    .map((paper, index) => ({ paper, index, score: scores.get(paper.id) || 0 }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.paper);
}

export function rankCandidates(papers, scores, limit = MAX_CANDIDATES) {
  return orderByScore(papers, scores).slice(0, limit);
}

const SYSTEM_PROMPT = `You triage today's arXiv listing for one researcher, so the papers worth their time are at the top.

You get their profile and a numbered list of today's papers. The profile has up to three parts:
- Instructions: what they wrote about their research and how they want papers judged, in their own words. This is the authority on what counts as relevant and how to weigh it; when the other parts suggest something else, it wins. Follow it, except that the reply format below is fixed.
- Papers they read: titles they cited or saved. This shows their taste within those areas.
- Recent notes: what they are working on this week. Use it to break ties towards their current work.

Judge each paper on what it contributes, not on the words it uses. Prioritize papers with a substantive methodological or systems contribution to one of their research areas: a new method, architecture, system, benchmark, or result they could build on. A paper that only mentions their topics, applies an off-the-shelf model without new insight, or shares a buzzword with their profile is superficial overlap and does not qualify.

A strong pick does at least one of these:
- Advances a specific problem, method, or system in their research areas.
- Is a direct competitor, follow-up, or rebuttal to a paper they read.
- Introduces a technique or tool they could lift straight into their own work.
- Is a result in their field significant enough that they will be asked about it.

Return only a JSON array, with no prose and no code fences, sorted from most to least relevant:
[{"id": "<an id copied exactly from the list>", "score": <1-10>, "connection": "<2-5 words>", "reason": "<one sentence>"}]

Rules:
- Never invent an id. Every id must appear in the list.
- Return at most ${MAX_PICKS}, and leave out anything scoring below 5. Fewer sharp picks beat many loose ones, and an empty array is a fine answer on a quiet day.
- Score 9-10 for a substantive contribution squarely on their research, 7-8 for clearly useful to it, 5-6 for worth a look.
- "connection" names the one research area from their instructions or profile the paper connects to most, as a short label, such as "Agentic AI for science" or "HEP tracking". Reuse the same label for every paper on the same area.
- "reason" is one sentence under ${REASON_CHARS} characters, addressed to the researcher as "you", saying what the paper contributes and why that matters to their work. Do not restate the title.

Good reasons:
- "A GNN track finder benchmarked on TrackML at HL-LHC pileup, with a 5x faster edge classifier you could drop into your pipeline."
- "Serves a 70B model across Slurm nodes with speculative decoding, the inference-on-HPC setup you are building toward."
Bad reasons:
- "Relevant to your interest in machine learning."
- "An interesting paper on particle physics."`;

export function buildRankMessages(profile, candidates) {
  const sections = [];
  if (profile.interests) sections.push(`Instructions:\n${profile.interests}`);
  if (profile.reading.length)
    sections.push(
      `Papers they read, most recent first:\n${profile.reading.map((title) => `- ${title}`).join('\n')}`
    );
  if (profile.recent.length)
    sections.push(
      `Recent notes, most recent first:\n${profile.recent.map((note) => `- ${note.path}: ${note.snippet}`).join('\n')}`
    );

  const papers = candidates
    .map(
      (paper, index) =>
        `${index + 1}. id: ${paper.id}\n   title: ${collapse(paper.title)}\n   categories: ${paper.categories.join(', ')}\n   abstract: ${clip(collapse(paper.abstract), ABSTRACT_CHARS)}`
    )
    .join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Profile\n\n${sections.join('\n\n')}\n\nToday's papers\n\n${papers}`
    }
  ];
}

/**
 * The model's picks, kept only where they name a paper it was actually shown,
 * each at most once, in the order it gave them.
 */
export function parseRankedPicks(reply, candidates) {
  const known = new Set(candidates.map((paper) => paper.id));
  const picks = [];
  for (const item of parseJsonArray(reply) || []) {
    const id = String(item?.id ?? '')
      .trim()
      .replace(/^arxiv:/i, '')
      .replace(/v\d+$/, '');
    if (!known.has(id) || picks.some((pick) => pick.id === id)) continue;
    const score = Math.round(Number(item.score));
    picks.push({
      id,
      score: Number.isFinite(score) ? Math.min(Math.max(score, 1), 10) : null,
      connection: clip(
        collapse(String(item.connection ?? '')),
        MAX_CONNECTION_CHARS
      ),
      reason: clip(collapse(String(item.reason ?? '')), MAX_REASON_CHARS)
    });
    if (picks.length >= MAX_PICKS) break;
  }
  // Strongest first even when the model's order and its scores disagree.
  return picks
    .map((pick, index) => ({ pick, index }))
    .sort(
      (left, right) =>
        (right.pick.score ?? 0) - (left.pick.score ?? 0) ||
        left.index - right.index
    )
    .map((item) => item.pick);
}

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

function noteSnippet(content) {
  const { body } = parseFrontmatter(content);
  const prose = body
    .split('\n')
    .map((line) => line.trim())
    // Headings are mostly dates in daily notes, and a clipped paper is already
    // counted under reading.
    .filter(
      (line) =>
        line && !line.startsWith('#') && !/arxiv\.org\/abs\//i.test(line)
    )
    .join(' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '');
  return clip(collapse(prose), NOTE_SNIPPET_CHARS);
}

function terms(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\$[^$]*\$/g, ' ')
    .split(/[^a-z0-9-]+/)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter(
      (token) =>
        token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token)
    );
}

function collapse(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
