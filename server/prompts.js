import { WorkspaceError } from './workspace.js';
import fs from 'node:fs/promises';

export const PRESETS_CONFIG_PATH = '/.webmd/prompts.json';

// Every edit system prompt must keep two invariants: return only the
// replacement Markdown, and never wrap it in fences or commentary. The diff
// preview shows whatever comes back verbatim, so a stray "Sure, here you go:"
// lands in the document.
const OUTPUT_RULES =
  'Return only the replacement Markdown for the selected text. Do not include explanations, labels, quotes, or code fences. Preserve Markdown structure, links, and citations unless the instruction says otherwise.';

// Chat presets answer *about* the note instead of rewriting it, so they get the
// opposite contract: prose is welcome, but the model must not imply it changed
// the file — nothing it returns is ever written to disk.
const CHAT_OUTPUT_RULES =
  'Answer in concise Markdown about the note. Ground every point in the text you were given and say so plainly when the note does not cover something. Do not rewrite the note or claim to have edited any file.';

export const BUILT_IN_PRESETS = [
  {
    id: 'academic-tighten',
    label: 'Tighten (academic)',
    group: 'Paper',
    kind: 'edit',
    system: `You rewrite prose for a peer-reviewed paper. Prefer precise, economical academic English. Cut hedging and filler, keep every claim and citation intact, and never strengthen a claim beyond what the original states. ${OUTPUT_RULES}`,
    instruction: 'Tighten this passage without changing what it claims.'
  },
  {
    id: 'academic-active',
    label: 'Active voice',
    group: 'Paper',
    kind: 'edit',
    system: `You rewrite academic prose from passive to active voice. Keep the subject matter, terminology, and citations unchanged. Where the agent is genuinely unknown, leave the sentence passive rather than inventing one. ${OUTPUT_RULES}`,
    instruction: 'Rewrite in active voice.'
  },
  {
    id: 'academic-methods',
    label: 'Methods-section voice',
    group: 'Paper',
    kind: 'edit',
    system: `You rewrite text into the voice of a methods section: past tense, third person, factual and reproducible. State what was done, with what, and under what conditions. Do not add detail that is not present in the original. ${OUTPUT_RULES}`,
    instruction: 'Rewrite this as a methods-section paragraph.'
  },
  {
    id: 'academic-hedge',
    label: 'Calibrate claims',
    group: 'Paper',
    kind: 'edit',
    system: `You calibrate the strength of claims in academic prose so each one matches the evidence stated in the text. Weaken assertions the passage does not support, and remove hedging where the passage does support the claim. Do not add evidence, citations, or caveats that are not already present. ${OUTPUT_RULES}`,
    instruction: 'Match each claim to the evidence actually stated.'
  },
  {
    id: 'academic-abstract',
    label: 'Compress to abstract',
    group: 'Paper',
    kind: 'edit',
    system: `You compress text into a single abstract paragraph: context, gap, approach, result, implication. Use only material present in the original — no invented numbers, datasets, or conclusions. Drop citations and figure references, which do not belong in an abstract. ${OUTPUT_RULES}`,
    instruction: 'Compress this into one abstract paragraph.'
  },
  {
    id: 'plain-language',
    label: 'Plain-language summary',
    group: 'Paper',
    kind: 'edit',
    system: `You rewrite technical prose for an educated non-specialist. Replace jargon with plain equivalents, keep the technical content accurate, and do not oversimplify to the point of being wrong. ${OUTPUT_RULES}`,
    instruction: 'Rewrite this in plain language for a non-specialist.'
  },
  {
    id: 'email-reply',
    label: 'Polite reply',
    group: 'Email',
    kind: 'edit',
    system: `You rewrite draft text into a courteous, professional email reply. Keep it warm but efficient, lead with the answer, and keep any concrete commitments, dates, and numbers exactly as written. ${OUTPUT_RULES}`,
    instruction: 'Rewrite this as a polite, professional email reply.'
  },
  {
    id: 'email-concise',
    label: 'Concise reply',
    group: 'Email',
    kind: 'edit',
    system: `You rewrite email text to be as short as it can be while staying polite and complete. Cut throat-clearing, pleasantries, and restatement of the question. Keep every commitment, date, and number. ${OUTPUT_RULES}`,
    instruction: 'Make this email reply much shorter.'
  },
  {
    id: 'email-decline',
    label: 'Soften a decline',
    group: 'Email',
    kind: 'edit',
    system: `You rewrite a refusal into a gracious but unambiguous decline. The answer must stay clearly negative — do not soften it into a maybe. Offer an alternative only if the original text suggests one. ${OUTPUT_RULES}`,
    instruction: 'Rewrite this as a warm but clear decline.'
  },
  {
    id: 'email-followup',
    label: 'Follow-up nudge',
    group: 'Email',
    kind: 'edit',
    system: `You turn notes about an unanswered thread into a short, friendly follow-up email. Restate the ask in one sentence, make the next step obvious, and assume good faith about the silence — no guilt, no escalation. Keep every date, name, and number exactly as written. ${OUTPUT_RULES}`,
    instruction: 'Rewrite this as a short follow-up nudge.'
  },
  {
    id: 'note-bullets',
    label: 'Condense to bullets',
    group: 'Notes',
    kind: 'edit',
    system: `You condense prose into terse Markdown bullets for personal notes. One idea per bullet, no filler words, keep names, numbers, and dates exact. Preserve any existing nesting that carries meaning. ${OUTPUT_RULES}`,
    instruction: 'Condense this into bullet points.'
  },
  {
    id: 'note-cleanup',
    label: 'Clean up dictation',
    group: 'Notes',
    kind: 'edit',
    system: `You clean up dictated or hastily typed notes. Fix grammar, punctuation, capitalization, and obvious transcription slips. Preserve the author's wording and voice — this is a cleanup, not a rewrite, so do not restructure or summarize. ${OUTPUT_RULES}`,
    instruction: 'Clean up the grammar and punctuation without rewriting it.'
  },
  {
    id: 'note-action-items',
    label: 'Extract action items',
    group: 'Notes',
    kind: 'edit',
    system: `You extract the actionable commitments from notes and return them as a Markdown task list, one "- [ ] " item per action, each starting with a verb. Keep the owner and due date when the text names them. Include only actions the text actually states — do not invent follow-ups — and drop everything that is not actionable. ${OUTPUT_RULES}`,
    instruction: 'Turn this into a task list of the actions it contains.'
  },
  {
    id: 'note-expand',
    label: 'Expand shorthand',
    group: 'Notes',
    kind: 'edit',
    system: `You expand telegraphic notes into complete sentences a reader can follow months later. Spell out abbreviations only when the meaning is unambiguous from context, and add connective tissue between fragments. Add no facts, numbers, or conclusions that the shorthand does not already carry. ${OUTPUT_RULES}`,
    instruction: 'Expand this shorthand into full sentences.'
  },
  {
    id: 'ask-summarize',
    label: 'Summarize this note',
    group: 'Ask',
    kind: 'chat',
    system: `You summarize a working note for its own author, who wrote it and wants the shape of it back quickly. Lead with a one-sentence gist, then the key points as bullets, keeping names, numbers, and dates exact. ${CHAT_OUTPUT_RULES}`,
    instruction: 'Summarize this note: the gist first, then the key points.'
  },
  {
    id: 'ask-questions',
    label: 'Open questions',
    group: 'Ask',
    kind: 'chat',
    system: `You find the open questions in a working note: what it raises but does not answer, what a reader would need to know that is missing, and where two parts of it disagree. List them as bullets, most consequential first. Do not answer them. ${CHAT_OUTPUT_RULES}`,
    instruction: 'What questions does this note leave open?'
  },
  {
    id: 'ask-critique',
    label: 'Skeptical review',
    group: 'Ask',
    kind: 'chat',
    system: `You review a note the way a sharp, friendly colleague would: name the weakest reasoning, the claims that outrun their support, and the alternative reading the author seems not to have considered. Be specific and quote the phrase you are reacting to. Say what is strong too, briefly, and do not pad the list to seem thorough. ${CHAT_OUTPUT_RULES}`,
    instruction: 'Review this note skeptically: where is the reasoning weakest?'
  },
  {
    id: 'ask-next-steps',
    label: 'Suggest next steps',
    group: 'Ask',
    kind: 'chat',
    system: `You propose the concrete next steps implied by a working note. Each step is one action the author could start today, ordered so that the step which most reduces uncertainty comes first. Say briefly why each one is next. Propose no more than five. ${CHAT_OUTPUT_RULES}`,
    instruction: 'What are the concrete next steps from this note?'
  }
];

/**
 * Presets available for a workspace: built-ins, then workspace overrides by id.
 * `warning` is set when the workspace file exists but could not be used in
 * full, so a typo surfaces in the UI instead of silently shortening the list.
 */
export async function listPresets(workspace) {
  const { presets, warning } = await readWorkspacePresets(workspace);
  const merged = new Map(BUILT_IN_PRESETS.map((preset) => [preset.id, preset]));
  for (const preset of presets) merged.set(preset.id, preset);
  return { presets: [...merged.values()], warning };
}

export async function resolvePreset(workspace, presetId, kind) {
  const { presets } = await listPresets(workspace);
  const preset = presets.find((entry) => entry.id === presetId);
  if (!preset) throw new WorkspaceError(400, `Unknown prompt preset: ${presetId}.`);
  if (kind && preset.kind !== kind) {
    throw new WorkspaceError(
      400,
      `Prompt preset ${presetId} is a "${preset.kind}" preset and cannot be used here.`
    );
  }
  return preset;
}

/** Strips system prompts, which stay server-side like provider credentials. */
export function publicPresets(presets) {
  return presets.map(({ id, label, group, kind, instruction }) => ({
    id,
    label,
    group,
    kind,
    instruction
  }));
}

async function readWorkspacePresets(workspace) {
  let raw;
  try {
    const absolute = await workspace.resolvePath(PRESETS_CONFIG_PATH);
    raw = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    // No workspace overrides is the normal case, not a problem worth reporting.
    if (error.status === 404 || error.code === 'ENOENT') return { presets: [] };
    if (error.status === 403) {
      return { presets: [], warning: `${PRESETS_CONFIG_PATH} resolves outside the workspace.` };
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      presets: [],
      warning: `${PRESETS_CONFIG_PATH} is not valid JSON: ${error.message}`
    };
  }

  const entries = Array.isArray(parsed) ? parsed : parsed?.presets;
  if (!Array.isArray(entries)) {
    return {
      presets: [],
      warning: `${PRESETS_CONFIG_PATH} must contain a "presets" array.`
    };
  }

  const presets = [];
  const invalid = [];
  for (const [index, entry] of entries.entries()) {
    const preset = normalizePreset(entry);
    if (preset) presets.push(preset);
    else invalid.push(entry?.id || `#${index + 1}`);
  }

  return {
    presets,
    warning: invalid.length
      ? `Ignored ${invalid.length} preset(s) in ${PRESETS_CONFIG_PATH} missing id, label, or system: ${invalid.join(', ')}.`
      : undefined
  };
}

function normalizePreset(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = text(entry.id);
  const label = text(entry.label);
  const system = text(entry.system);
  if (!id || !label || !system) return null;

  // Anything but an explicit "chat" is a selection rewrite, so presets written
  // before `kind` existed keep their old behaviour.
  const kind = text(entry.kind).toLowerCase() === 'chat' ? 'chat' : 'edit';

  return {
    id,
    label,
    group: text(entry.group) || 'Custom',
    kind,
    system,
    instruction:
      text(entry.instruction) ||
      (kind === 'chat'
        ? `${label}, for the current note.`
        : `Rewrite the selected text: ${label}.`)
  };
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
