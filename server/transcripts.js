import { shortestWikiTarget } from '../src/wiki-target.js';
import { meetingNoteNames } from './meetings.js';
import { WorkspaceError } from './workspace.js';

/**
 * Meeting transcripts and the summaries written from them.
 *
 * A transcript arrives as the file Zoom (or Teams, or a captioning tool) hands
 * out: WebVTT, SubRip, or Zoom's saved-captions text. It becomes a readable
 * Markdown note of its own, one paragraph per turn, tied to the meeting by the
 * same `indico:` link its note carries. A summary is written into the
 * meeting's own note, beside the notes taken during it, and its action items
 * join that note's list, where the Tasks view picks them up.
 */
export const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
// About 40k tokens: a three-hour meeting, and still inside the context of the
// models WebMD is usually pointed at. Longer ones are summarized from the start.
export const MAX_SUMMARY_TRANSCRIPT_CHARS = 160000;
const MAX_SUMMARY_POINTS = 12;
const MAX_ACTIONS = 20;
const MAX_ITEM_CHARS = 400;

const TIMING =
  /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

/**
 * `[{ at, speaker, text }]` from a transcript file, `at` in whole seconds from
 * the start (null when the file has no times). Throws a 400 for a file with no
 * words in it.
 */
export function parseTranscript(source) {
  const text = String(source ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^WEBVTT[^\n]*\n?/, '');
  const entries = text.split('\n').some((line) => TIMING.test(line))
    ? parseCues(text)
    : parseSavedCaptions(text);
  if (!entries.some((entry) => entry.text)) {
    throw new WorkspaceError(400, 'That file has no transcript text in it.');
  }
  return entries.filter((entry) => entry.text);
}

/** WebVTT and SubRip: blocks of an optional id, a timing line, and text. */
function parseCues(text) {
  const entries = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timing = lines.findIndex((line) => TIMING.test(line));
    if (timing === -1) continue;
    const at = seconds(TIMING.exec(lines[timing])[1]);
    const body = lines.slice(timing + 1).join(' ');
    // Teams and others name the speaker in a voice tag: <v Ada Lovelace>text.
    const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(body);
    const words = clean(body.replace(/<[^>]*>/g, ' '));
    if (voice) entries.push({ at, speaker: clean(voice[1]), text: words });
    else entries.push({ at, ...splitSpeaker(words) });
  }
  return entries;
}

/**
 * Zoom's saved captions (`[Ada Lovelace] 10:02:33` over the words) and plain
 * text, where each paragraph is a turn and a leading "Name:" names its speaker.
 */
function parseSavedCaptions(text) {
  const entries = [];
  let current = null;
  let first = null;
  for (const line of text.split('\n')) {
    const header = /^\[([^\]]+)\]\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/.exec(line.trim());
    if (header) {
      const clock = seconds(header[2]);
      first ??= clock;
      current = { at: clock - first, speaker: clean(header[1]), text: '' };
      entries.push(current);
    } else if (!line.trim()) {
      // In plain text a blank line ends a paragraph, and so a turn.
      if (current?.at === null) current = null;
    } else if (current) {
      current.text = clean(`${current.text} ${line}`);
    } else {
      current = { at: null, ...splitSpeaker(clean(line)) };
      entries.push(current);
    }
  }
  return entries;
}

/** "Ada Lovelace: text" as a speaker and their words; a short name only. */
function splitSpeaker(words) {
  const match = /^([^:]{1,60}):\s+(.+)$/.exec(words);
  if (match && !/^https?$/i.test(match[1]) && match[1].split(/\s+/).length <= 5) {
    return { speaker: match[1].trim(), text: match[2] };
  }
  return { speaker: '', text: words };
}

function seconds(clock) {
  const parts = clock.replace(',', '.').split(':').map(Number);
  return Math.floor(parts.reduce((total, part) => total * 60 + part, 0));
}

function clean(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One paragraph per turn: a speaker's consecutive captions are one turn, so a
 * two-second caption stream reads like someone speaking. Captions that name
 * no speaker are gathered a minute at a time instead. Returns Markdown.
 */
export function transcriptMarkdown(entries) {
  const turns = [];
  for (const entry of entries) {
    const last = turns.at(-1);
    const same = entry.speaker
      ? last?.speaker === entry.speaker
      : last && !last.speaker && last.at !== null && entry.at !== null && entry.at - last.at < 60;
    if (same) {
      last.text = `${last.text} ${entry.text}`;
    } else {
      turns.push({ ...entry });
    }
  }
  return turns
    .map((turn) => {
      const label = [turn.at === null ? '' : clockText(turn.at), turn.speaker]
        .filter(Boolean)
        .join(' ');
      return label
        ? `**${escapeMarkdown(label)}:** ${escapeMarkdown(turn.text)}`
        : escapeMarkdown(turn.text);
    })
    .join('\n\n');
}

export function clockText(total) {
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
}

// Enough to keep spoken words from turning into Markdown: a caption that
// starts "# of events" or says "use *this*" stays a sentence.
function escapeMarkdown(text) {
  return String(text)
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .replace(/^([#>+-]|\d+\.)(\s)/, '\\$1$2');
}

/** The transcript note: its own frontmatter, a link back, and the turns. */
export function transcriptNoteMarkdown({
  meeting,
  heading,
  meetingLink,
  fileName,
  entries
}) {
  return [
    '---',
    'type: transcript',
    // A Google Calendar meeting has no Indico event; its day's note links here.
    ...(meeting.key ? [`indico: ${meeting.key}`] : []),
    `date: ${meeting.start.date}`,
    'tags: [meeting, transcript]',
    '---',
    '',
    `# ${heading.replace(/\s+/g, ' ').trim()}`,
    '',
    `Transcript of [[${meetingLink}]]${fileName ? `, from \`${String(fileName).replace(/`/g, "'").replace(/\s+/g, ' ')}\`` : ''}.`,
    '',
    transcriptMarkdown(entries),
    ''
  ].join('\n');
}

/** The transcript as the model reads it: plain turns, no Markdown escapes. */
export function transcriptForModel(content) {
  const body = String(content ?? '')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^# .*\n/m, '')
    .replace(/^Transcript of .*\n/m, '')
    .replace(/\*\*([^*]+):\*\*/g, '$1:')
    .replace(/\\([\\`*_[\]<>|#>+-])/g, '$1')
    .trim();
  if (body.length <= MAX_SUMMARY_TRANSCRIPT_CHARS) return { text: body, truncated: false };
  return { text: body.slice(0, MAX_SUMMARY_TRANSCRIPT_CHARS), truncated: true };
}

const SUMMARY_SYSTEM = `You write the minutes of a research meeting from its transcript, for someone who was in the meeting and wants a record to come back to.

Return only a JSON object, with no prose and no code fences:
{"summary": ["<point>", ...], "decisions": ["<decision>", ...], "actions": [{"task": "<what>", "owner": "<name or empty>", "due": "<YYYY-MM-DD or empty>"}]}

Rules:
- "summary": at most ${MAX_SUMMARY_POINTS} points, in the order the meeting took them. Each point is one or two sentences naming the specific result, number, problem, or conclusion discussed, and who presented it when that is clear. No filler such as "the meeting started".
- "decisions": what the group agreed to do or chose between, only when the transcript shows it being agreed. [] is a normal answer.
- "actions": concrete follow-ups someone took on or was asked to do. "owner" is the person's name as said in the meeting, or "" when nobody was named. "due" is a date only when one was stated; otherwise "". [] is a normal answer.
- Captions are machine-made and have errors. Fix obvious misheard technical words from context, but never invent results, numbers, or names that are not there.
- Write in the language of the transcript.`;

export function buildSummaryMessages({ meeting, transcript, truncated }) {
  const agenda = (meeting.agenda || [])
    .map((item) =>
      `- ${item.title}${item.speakers?.length ? ` (${item.speakers.join(', ')})` : ''}`
    )
    .join('\n');
  return [
    { role: 'developer', content: SUMMARY_SYSTEM },
    {
      role: 'user',
      content: [
        `Meeting: ${meeting.title}`,
        `Date: ${meeting.start?.date || ''}`,
        agenda ? `Agenda:\n${agenda}` : '',
        `Transcript${truncated ? ' (the first part only; it was too long to send whole)' : ''}:\n${transcript}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  ];
}

/**
 * `{ summary, decisions, actions }` from the model's reply, each item trimmed
 * to one line. Throws a 502 when the reply holds no JSON object at all.
 */
export function parseSummary(reply) {
  const text = String(reply ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || start === -1) {
    throw new WorkspaceError(502, 'The model did not return a summary.');
  }
  const line = (value) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS) : '';
  const list = (value) => (Array.isArray(value) ? value.map(line).filter(Boolean) : []);
  const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
    .map((item) =>
      typeof item === 'string'
        ? { task: line(item), owner: '', due: '' }
        : {
            task: line(item?.task),
            owner: line(item?.owner),
            due: /^\d{4}-\d{2}-\d{2}$/.test(item?.due ?? '') ? item.due : ''
          }
    )
    .filter((item) => item.task)
    .slice(0, MAX_ACTIONS);
  const summary = list(parsed.summary).slice(0, MAX_SUMMARY_POINTS);
  if (!summary.length && !actions.length) {
    throw new WorkspaceError(502, 'The model returned an empty summary.');
  }
  return { summary, decisions: list(parsed.decisions), actions };
}

/** `- [ ] task who:ada 📅 2026-09-20`, in the Tasks view's own syntax. */
export function actionLine(action) {
  const who = assignee(action.owner);
  return [
    '- [ ]',
    action.task.replace(/^\[[ xX]\]\s*/, ''),
    who && !new RegExp(`(^|\\s)who:${who}\\b`, 'i').test(action.task) ? `who:${who}` : '',
    action.due ? `📅 ${action.due}` : ''
  ]
    .filter(Boolean)
    .join(' ');
}

/** "Ada Lovelace" is `who:ada`, the way assignments are written by hand. */
function assignee(owner) {
  const first = String(owner ?? '').trim().split(/\s+/)[0] || '';
  return first
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/^[._-]+|[._-]+$/g, '');
}

const SUMMARY_HEADING = /^##\s+Summary\s*$/im;

export function assertNoSummary(content) {
  if (SUMMARY_HEADING.test(String(content ?? ''))) {
    throw new WorkspaceError(
      409,
      'This note already has a Summary section. Delete it in the note to write a new one.'
    );
  }
}

/**
 * The note with a `## Summary` section put ahead of `## Notes` (or at the
 * end), and the action items added to `## Action items`, skipping any already
 * listed there. A note that already has a Summary is refused, never replaced:
 * what is written under it may be the user's own.
 */
export function insertSummary(content, { summary, decisions, actions }, { source }) {
  const text = String(content ?? '').replace(/\r\n?/g, '\n');
  assertNoSummary(text);

  const section = ['## Summary', '', `_Written by AI from ${source}._`, ''];
  section.push(...summary.map((point) => `- ${point}`));
  if (decisions.length) {
    section.push('', '**Decisions**', '', ...decisions.map((item) => `- ${item}`));
  }
  section.push('');

  let lines = text.split('\n');
  const notesAt = lines.findIndex((line) => /^##\s+Notes\s*$/i.test(line));
  const actionsAt = lines.findIndex((line) => /^##\s+Action items\s*$/i.test(line));
  const insertAt = notesAt !== -1 ? notesAt : actionsAt !== -1 ? actionsAt : -1;
  if (insertAt === -1) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines.push('', ...section);
  } else {
    lines.splice(insertAt, 0, ...section);
  }

  const items = actions.map(actionLine);
  if (items.length) lines = addActionItems(lines, items);
  const result = lines.join('\n');
  return result.endsWith('\n') ? result : `${result}\n`;
}

function addActionItems(lines, items) {
  const heading = lines.findIndex((line) => /^##\s+Action items\s*$/i.test(line));
  if (heading === -1) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    return [...lines, '', '## Action items', '', ...items, ''];
  }
  let end = lines.findIndex((line, index) => index > heading && /^#{1,2}\s/.test(line));
  if (end === -1) end = lines.length;
  const existing = new Set(
    lines.slice(heading + 1, end).map((line) => taskKey(line)).filter(Boolean)
  );
  const fresh = items.filter((item) => !existing.has(taskKey(item)));
  // After the section's last non-blank line, so the list stays one list.
  let at = end;
  while (at > heading + 1 && !lines[at - 1].trim()) at -= 1;
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  if (at === heading + 1) before.push('');
  return [...before, ...fresh, ...(after.length && after[0].trim() ? [''] : []), ...after];
}

function taskKey(line) {
  const match = /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/.exec(line);
  if (!match) return '';
  return match[1]
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/(^|\s)who:\S+/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/* ------------------------------------------------------------ workspace side */

/**
 * Writes a meeting's transcript note beside its meeting note, or rewrites the
 * one it already has (a better transcript replaces a first rough one). The new
 * note links back to the meeting note, which is how the note finds it again in
 * its backlinks.
 */
export async function saveTranscript(
  workspace,
  meeting,
  { notePath, transcriptPath = '', fileName = '', text }
) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new WorkspaceError(400, 'Choose a transcript file (.vtt, .srt, or .txt).');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TRANSCRIPT_BYTES) {
    throw new WorkspaceError(413, 'That transcript is larger than 5 MB.');
  }
  const entries = parseTranscript(text);
  const paths = (await workspace.markdownFiles()).map((file) => file.path);
  const note = (target, heading) =>
    transcriptNoteMarkdown({
      meeting,
      heading,
      meetingLink: shortestWikiTarget(notePath, target, [...paths, target]),
      fileName,
      entries
    });

  if (transcriptPath) {
    const heading = transcriptPath.split('/').pop().replace(/\.md$/i, '');
    await workspace.editFile(transcriptPath, () => note(transcriptPath, heading));
    return { path: transcriptPath, created: false, turns: entries.length };
  }

  const folder = notePath.slice(0, notePath.lastIndexOf('/'));
  const names = meetingNoteNames(meeting, ' transcript');
  for (const { name, heading } of names) {
    const target = `${folder}/${name}`;
    try {
      await workspace.createFile(target, note(target, heading));
      return { path: target, created: true, turns: entries.length };
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  throw new WorkspaceError(
    409,
    `Could not save the transcript: ${names.map((item) => item.name).join(' and ')} already exist in ${folder || '/'}.`
  );
}

/**
 * Sets (or, given '', removes) the `recording:` link in a meeting note's
 * frontmatter, leaving every other line as it was.
 */
export function setRecordingField(content, url) {
  const text = String(content ?? '');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (lines[0]?.trim() !== '---' || end === -1) {
    throw new WorkspaceError(409, 'The meeting note has lost its frontmatter.');
  }
  const at = lines.findIndex((line, index) => index > 0 && index < end && /^recording:/.test(line));
  const value = /^[^\s"'#]+$/.test(url) ? url : JSON.stringify(url);
  if (at !== -1) {
    if (url) lines[at] = `recording: ${value}`;
    else lines.splice(at, 1);
  } else if (url) {
    lines.splice(end, 0, `recording: ${value}`);
  }
  return lines.join(newline);
}

/** A recording link someone pasted: a web address, nothing else. */
export function recordingUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new WorkspaceError(400, 'Paste the recording’s web address (https://…).');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WorkspaceError(400, 'Paste the recording’s web address (https://…).');
  }
  return url.href;
}
