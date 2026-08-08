import { WorkspaceError } from './workspace.js';
import fs from 'node:fs/promises';

export const PRESETS_CONFIG_PATH = '/.webmd/prompts.json';

// Every system prompt must keep two invariants: return only the replacement
// Markdown, and never wrap it in fences or commentary. The diff preview shows
// whatever comes back verbatim, so a stray "Sure, here you go:" lands in the
// document.
const OUTPUT_RULES =
  'Return only the replacement Markdown for the selected text. Do not include explanations, labels, quotes, or code fences. Preserve Markdown structure, links, and citations unless the instruction says otherwise.';

export const BUILT_IN_PRESETS = [
  {
    id: 'academic-tighten',
    label: 'Tighten (academic)',
    group: 'Paper',
    system: `You rewrite prose for a peer-reviewed paper. Prefer precise, economical academic English. Cut hedging and filler, keep every claim and citation intact, and never strengthen a claim beyond what the original states. ${OUTPUT_RULES}`,
    instruction: 'Tighten this passage without changing what it claims.'
  },
  {
    id: 'academic-active',
    label: 'Active voice',
    group: 'Paper',
    system: `You rewrite academic prose from passive to active voice. Keep the subject matter, terminology, and citations unchanged. Where the agent is genuinely unknown, leave the sentence passive rather than inventing one. ${OUTPUT_RULES}`,
    instruction: 'Rewrite in active voice.'
  },
  {
    id: 'academic-methods',
    label: 'Methods-section voice',
    group: 'Paper',
    system: `You rewrite text into the voice of a methods section: past tense, third person, factual and reproducible. State what was done, with what, and under what conditions. Do not add detail that is not present in the original. ${OUTPUT_RULES}`,
    instruction: 'Rewrite this as a methods-section paragraph.'
  },
  {
    id: 'plain-language',
    label: 'Plain-language summary',
    group: 'Paper',
    system: `You rewrite technical prose for an educated non-specialist. Replace jargon with plain equivalents, keep the technical content accurate, and do not oversimplify to the point of being wrong. ${OUTPUT_RULES}`,
    instruction: 'Rewrite this in plain language for a non-specialist.'
  },
  {
    id: 'email-reply',
    label: 'Polite reply',
    group: 'Email',
    system: `You rewrite draft text into a courteous, professional email reply. Keep it warm but efficient, lead with the answer, and keep any concrete commitments, dates, and numbers exactly as written. ${OUTPUT_RULES}`,
    instruction: 'Rewrite this as a polite, professional email reply.'
  },
  {
    id: 'email-concise',
    label: 'Concise reply',
    group: 'Email',
    system: `You rewrite email text to be as short as it can be while staying polite and complete. Cut throat-clearing, pleasantries, and restatement of the question. Keep every commitment, date, and number. ${OUTPUT_RULES}`,
    instruction: 'Make this email reply much shorter.'
  },
  {
    id: 'email-decline',
    label: 'Soften a decline',
    group: 'Email',
    system: `You rewrite a refusal into a gracious but unambiguous decline. The answer must stay clearly negative — do not soften it into a maybe. Offer an alternative only if the original text suggests one. ${OUTPUT_RULES}`,
    instruction: 'Rewrite this as a warm but clear decline.'
  },
  {
    id: 'note-bullets',
    label: 'Condense to bullets',
    group: 'Notes',
    system: `You condense prose into terse Markdown bullets for personal notes. One idea per bullet, no filler words, keep names, numbers, and dates exact. Preserve any existing nesting that carries meaning. ${OUTPUT_RULES}`,
    instruction: 'Condense this into bullet points.'
  },
  {
    id: 'note-cleanup',
    label: 'Clean up dictation',
    group: 'Notes',
    system: `You clean up dictated or hastily typed notes. Fix grammar, punctuation, capitalization, and obvious transcription slips. Preserve the author's wording and voice — this is a cleanup, not a rewrite, so do not restructure or summarize. ${OUTPUT_RULES}`,
    instruction: 'Clean up the grammar and punctuation without rewriting it.'
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

export async function resolvePreset(workspace, presetId) {
  const { presets } = await listPresets(workspace);
  const preset = presets.find((entry) => entry.id === presetId);
  if (!preset) throw new WorkspaceError(400, `Unknown prompt preset: ${presetId}.`);
  return preset;
}

/** Strips system prompts, which stay server-side like provider credentials. */
export function publicPresets(presets) {
  return presets.map(({ id, label, group }) => ({ id, label, group }));
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

  return {
    id,
    label,
    group: text(entry.group) || 'Custom',
    system,
    instruction: text(entry.instruction) || `Rewrite the selected text: ${label}.`
  };
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
