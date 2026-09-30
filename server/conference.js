import fs from 'node:fs/promises';
import { agendaDays, backupFor, talkSpan } from '../src/conference-plan.js';
import { escapeInline, parseMeetingSource } from './meetings.js';
import { clip, collapse, parseRankedPicks, profileText } from './news-rank.js';
import { WorkspaceError } from './workspace.js';

/** The conferences planned in this workspace, newest first. */
export const CONFERENCES_PATH = '/.webmd/conferences.json';
const MAX_CONFERENCES = 20;
// What every talk's abstract shares, so a 1,500-talk agenda stays one call
// (about 30k tokens of abstracts) while a small one reads 360 characters each.
const DESCRIPTION_BUDGET = 120000;
const DESCRIPTION_CHARS = 360;
const REASON_CHARS = 140;

export const PLAN_START = '<!-- webmd:conference-plan -->';
export const PLAN_END = '<!-- /webmd:conference-plan -->';

/** `{ origin, eventId, url }` for an Indico event link, or a 400. */
export function conferenceEvent(value, sites) {
  const source = parseMeetingSource(String(value ?? '').trim(), sites);
  if (source.kind !== 'event') {
    throw new WorkspaceError(
      400,
      'Paste the conference’s Indico event link (…/event/5678/), not a category.'
    );
  }
  return { origin: source.origin, eventId: source.indicoId, url: source.url };
}

export async function readConferences(workspace) {
  let raw;
  try {
    raw = await fs.readFile(
      await workspace.resolvePath(CONFERENCES_PATH),
      'utf8'
    );
  } catch (error) {
    if (error.status === 404 || error.status === 403 || error.code === 'ENOENT')
      return [];
    throw error;
  }
  try {
    const list = JSON.parse(raw)?.conferences;
    return Array.isArray(list)
      ? list.filter((item) => typeof item?.url === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function writeConferences(workspace, conferences) {
  const absolute = await workspace.resolvePath(CONFERENCES_PATH, {
    forWrite: true
  });
  await fs.mkdir(absolute.replace(/\/[^/]*$/, ''), { recursive: true });
  await fs.writeFile(
    absolute,
    `${JSON.stringify({ conferences: conferences.slice(0, MAX_CONFERENCES) }, null, 2)}\n`
  );
}

/** The list with this conference first, once. */
export function rememberConference(conferences, entry) {
  return [entry, ...conferences.filter((item) => item.url !== entry.url)];
}

const SYSTEM_PROMPT = `You score every talk of a conference for one researcher, so a planner can build them an hour-by-hour schedule across the parallel tracks.

You get their profile and a numbered list of every talk. The profile has up to five parts:
- Instructions: what they wrote about their research and how they want work judged, in their own words. This is the authority on what counts as relevant; when the other parts suggest something else, it wins. Follow it, except that the reply format below is fixed.
- Papers they read: titles they cited or saved. This shows their taste within those areas.
- Recent notes: what they are working on this week. Use it to break ties towards their current work.
- Papers they upvoted and downvoted: earlier papers they marked as worth or not worth their time. Score talks like the upvoted ones up and like the downvoted ones down.

Judge each talk on what it is likely to present, not on the words in its title. Score up talks that bring a new method, system, or result in their research areas, talks by groups that compete with or build on the work they read, and results in their field they will be asked about. Plenary overviews of their field are worth attending. Many talks are only titles; judge those from the title, session, and speakers.

Return only a JSON array, with no prose and no code fences:
[{"id": "<an id copied exactly from the list>", "score": <1-10>, "reason": "<one sentence, only for scores of 7 or more>"}]

Rules:
- Score every talk in the list, exactly once. The planner compares talks that run at the same time, so a low score is as useful as a high one.
- Never invent an id.
- Score 9-10 for a talk squarely on their research, 7-8 for clearly useful to it, 4-6 for worth attending when nothing better runs, 1-3 for off their research.
- "reason" is under ${REASON_CHARS} characters, addressed to the researcher as "you", saying what the talk is likely to bring. Do not restate the title. Leave it out below 7.`;

/** One entry per talk, in agenda order; an id listed twice counts once. */
export function uniqueTalks(agenda = []) {
  const seen = new Set();
  return agenda.filter((item) => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function buildTalkScoreMessages(profile, talks) {
  const chars = Math.min(
    DESCRIPTION_CHARS,
    Math.floor(DESCRIPTION_BUDGET / Math.max(talks.length, 1))
  );
  const list = talks
    .map((item, index) => {
      const lines = [
        `${index + 1}. id: ${item.id}`,
        `   title: ${collapse(item.title)}`
      ];
      if (item.session) lines.push(`   session: ${collapse(item.session)}`);
      if (item.speakers.length)
        lines.push(`   speakers: ${item.speakers.join(', ')}`);
      if (item.description && chars >= 40)
        lines.push(`   abstract: ${clip(collapse(item.description), chars)}`);
      return lines.join('\n');
    })
    .join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Profile\n\n${profileText(profile)}\n\nThe conference's talks\n\n${list}`
    }
  ];
}

/** `{ [id]: { score, reason } }` for the talks the model scored. */
export function parseTalkScores(reply, talks) {
  const scores = {};
  for (const pick of parseRankedPicks(reply, talks, talks.length)) {
    if (pick.score == null) continue;
    scores[pick.id] = pick.reason
      ? { score: pick.score, reason: pick.reason }
      : { score: pick.score };
  }
  return scores;
}

/**
 * The plan as Markdown, one section per day: when, what, where, why, and the
 * talk to go to instead. Plain bullets, not tasks: fifty talks are not fifty
 * things to do in the Tasks view.
 */
export function planMarkdown(meeting, days, scores = {}) {
  const byId = new Map(meeting.agenda.map((item) => [item.id, item]));
  const scoreMap = new Map(
    Object.entries(scores).map(([id, value]) => [id, value.score])
  );
  const lines = [PLAN_START];
  for (const { date, talks } of agendaDays(meeting.agenda)) {
    const chosen = (days[date] || []).map((id) => byId.get(id)).filter(Boolean);
    if (!chosen.length) continue;
    lines.push('', `## ${dayHeading(date)}`, '');
    for (const item of chosen) {
      const score = scores[item.id];
      const where = [item.room, item.speakers.join(', ')]
        .filter(Boolean)
        .join(' · ');
      lines.push(
        `- ${spanText(item)} ${talkLink(item)}${where ? ` — ${escapeInline(where)}` : ''}${score ? ` (${score.score}/10)` : ''}`
      );
      if (score?.reason) lines.push(`  - ${escapeInline(score.reason)}`);
      const backup = backupFor(item, talks, chosen, scoreMap);
      if (backup)
        lines.push(
          `  - Or: ${talkLink(backup)}${backup.room ? ` — ${escapeInline(backup.room)}` : ''} (${scores[backup.id].score}/10)`
        );
    }
  }
  lines.push('', PLAN_END);
  return lines.join('\n');
}

/** The note with its plan section replaced, or the plan added at the end. */
export function replacePlan(content, plan) {
  const start = content.indexOf(PLAN_START);
  const end = content.indexOf(PLAN_END, start);
  if (start !== -1 && end !== -1)
    return `${content.slice(0, start)}${plan}${content.slice(end + PLAN_END.length)}`;
  return `${content.replace(/\n*$/, '')}\n\n${plan}\n`;
}

export function planNoteMarkdown(meeting, heading, plan) {
  return [
    '---',
    'type: conference-plan',
    `conference: ${meeting.key}`,
    '---',
    '',
    `# ${heading}`,
    '',
    `- **Indico:** <${meeting.key}>`,
    `- **Times:** ${meeting.timezone || 'the conference’s own time zone'}`,
    '',
    plan,
    ''
  ].join('\n');
}

function spanText(item) {
  if (item.end?.time && item.end.at > item.start.at)
    return `${item.start.time}–${item.end.time}`;
  // No end from Indico: the planner's assumed length, on the same wall clock.
  const { start, end } = talkSpan(item);
  const [hours, minutes] = item.start.time.split(':').map(Number);
  const total =
    (hours * 60 + minutes + Math.round((end - start) / 60000)) % 1440;
  const pad = (value) => String(value).padStart(2, '0');
  return `${item.start.time}–${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function talkLink(item) {
  const title = escapeInline(item.title);
  return item.url ? `[${title}](${item.url})` : title;
}

function dayHeading(date) {
  const day = new Date(`${date}T12:00:00Z`);
  return day.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC'
  });
}
