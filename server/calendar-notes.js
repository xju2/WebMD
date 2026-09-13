import { titleFileName } from '../src/note-title.js';
import { shortestWikiTarget } from '../src/related-links.js';
import { resolveWikiLinkPath } from '../src/wiki-links.js';
import {
  actionLine,
  MAX_TRANSCRIPT_BYTES,
  parseTranscript,
  transcriptNoteMarkdown
} from './transcripts.js';
import { normalizeWorkspaceFolder, WorkspaceError } from './workspace.js';

/**
 * Transcripts and AI summaries for Google Calendar meetings. Such a meeting
 * lives as a `## 10:00 AM Title` section in its day's note (the Calendar's
 * "Add to the day's note"), so everything here is scoped to that section: the
 * transcript is linked from a `- Transcript:` line in it, and the summary is
 * written at its end under `###` headings.
 */

/** The meeting's `## ` heading and where its section ends, or a 409. */
export function meetingSection(content, heading) {
  const lines = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const start = lines.indexOf(heading);
  if (!/^## \S/.test(heading ?? '') || start === -1) {
    throw new WorkspaceError(
      409,
      'That meeting is not in the day’s note. Add it to the day’s note first.'
    );
  }
  let end = lines.findIndex(
    (line, index) => index > start && /^#{1,2}\s/.test(line)
  );
  if (end === -1) end = lines.length;
  return { lines, start, end };
}

const TRANSCRIPT_LINE = /^- Transcript:\s*\[\[([^\]]+)\]\]/;

/** The wiki target of the section's transcript, or ''. */
export function sectionTranscript(content, heading) {
  const { lines, start, end } = meetingSection(content, heading);
  for (const line of lines.slice(start + 1, end)) {
    const match = TRANSCRIPT_LINE.exec(line);
    if (match) return match[1].split('|')[0].trim();
  }
  return '';
}

/**
 * Sets the section's `- Transcript: [[…]]` line: replaced where it is, or
 * added after the `- Guests:` / `- Join:` lines the section starts with.
 */
export function setTranscriptLine(content, heading, target) {
  const { lines, start, end } = meetingSection(content, heading);
  const line = `- Transcript: [[${target}]]`;
  const at = lines.findIndex(
    (text, index) => index > start && index < end && TRANSCRIPT_LINE.test(text)
  );
  if (at !== -1) {
    lines[at] = line;
  } else {
    let after = start + 1;
    while (after < end && !lines[after].trim()) after += 1;
    let last = after - 1;
    while (last + 1 < end && /^- [A-Z][\w ]*:/.test(lines[last + 1])) last += 1;
    if (last < after) lines.splice(start + 1, 0, '', line);
    else lines.splice(last + 1, 0, line);
  }
  return lines.join('\n');
}

/** The meeting's section, or a 409 when it already has a Summary. */
export function assertNoSectionSummary(content, heading) {
  const section = meetingSection(content, heading);
  const { lines, start, end } = section;
  if (
    lines.slice(start + 1, end).some((line) => /^###\s+Summary\s*$/i.test(line))
  ) {
    throw new WorkspaceError(
      409,
      'This meeting already has a Summary. Delete it in the note to write a new one.'
    );
  }
  return section;
}

/**
 * The section with the AI's minutes at its end: `### Summary` (with any
 * decisions) and `### Action items` in task syntax, so the Tasks view lists
 * them. A section that already has a Summary is refused, never replaced.
 */
export function insertSectionSummary(
  content,
  heading,
  { summary, decisions, actions },
  { source }
) {
  const { lines, start, end } = assertNoSectionSummary(content, heading);
  const block = ['### Summary', '', `_Written by AI from ${source}._`, ''];
  block.push(...summary.map((point) => `- ${point}`));
  if (decisions.length) {
    block.push(
      '',
      '**Decisions**',
      '',
      ...decisions.map((item) => `- ${item}`)
    );
  }
  if (actions.length)
    block.push('', '### Action items', '', ...actions.map(actionLine));

  let at = end;
  while (at > start + 1 && !lines[at - 1].trim()) at -= 1;
  const tail = lines.slice(end);
  const result = [
    ...lines.slice(0, at),
    '',
    ...block,
    ...(tail.length ? [''] : []),
    ...tail
  ].join('\n');
  return result.endsWith('\n') ? result : `${result}\n`;
}

/**
 * Saves the transcript as its own note in the meetings folder and links it
 * from the meeting's section. A section that already links one has that note
 * rewritten instead (a better transcript replaces a first rough one).
 */
export async function saveCalendarTranscript(
  workspace,
  { path, heading, title, date, name = '', text, folder }
) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new WorkspaceError(
      400,
      'Choose a transcript file (.vtt, .srt, or .txt).'
    );
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TRANSCRIPT_BYTES) {
    throw new WorkspaceError(413, 'That transcript is larger than 5 MB.');
  }
  const entries = parseTranscript(text);
  const day = await workspace.loadFile(path);
  const files = await workspace.markdownFiles();
  const existing = linkedPath(
    sectionTranscript(day.content, heading),
    path,
    files
  );
  const meeting = { title, start: { date } };
  const note = (target, noteHeading) =>
    transcriptNoteMarkdown({
      meeting,
      heading: noteHeading,
      meetingLink: shortestWikiTarget(
        path,
        target,
        files.map((file) => file.path)
      ),
      fileName: name,
      entries
    });

  let target = existing;
  if (existing) {
    const noteHeading = existing.split('/').pop().replace(/\.md$/i, '');
    await workspace.editFile(existing, () => note(existing, noteHeading));
  } else {
    const base = normalizeWorkspaceFolder(folder || '/meetings');
    for (let copy = 1; !target && copy <= 20; copy += 1) {
      const noteHeading = `${title} (${date})${copy > 1 ? ` ${copy}` : ''} transcript`;
      const candidate = `${base === '/' ? '' : base}/${titleFileName(noteHeading)}`;
      try {
        await workspace.createFile(candidate, note(candidate, noteHeading));
        target = candidate;
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    }
    if (!target)
      throw new WorkspaceError(409, 'Could not name the transcript note.');
  }

  const paths = [...files.map((file) => file.path), target];
  const link = shortestWikiTarget(target, path, paths);
  await workspace.editFile(path, (content) =>
    setTranscriptLine(content, heading, link)
  );
  return { transcriptPath: target, created: !existing, turns: entries.length };
}

/** The workspace path a section's `[[target]]` names, if the note exists. */
export function linkedPath(target, fromPath, files) {
  if (!target) return '';
  const resolved = resolveWikiLinkPath(target, fromPath, files);
  return files.some((file) => file.path === resolved) ? resolved : '';
}
