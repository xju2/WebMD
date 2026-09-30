// A conference plan: for each day, the talks to attend, one at a time. The
// model scores talks; this picks the timetable, because a set of talks with no
// overlaps and the highest total score is arithmetic, not judgement.

const MINUTE = 60 * 1000;
// A talk Indico gives no end or duration is taken to fill this long.
const DEFAULT_TALK_MINUTES = 20;
// Scores weigh this much more than one stay in the same room, so staying only
// ever breaks ties: no plan has a thousand room changes to trade for a point.
const SCORE_WEIGHT = 1000;

/** `{ start, end }` in milliseconds for an agenda item. */
export function talkSpan(item) {
  const start = item.start.at;
  const end =
    item.end?.at > start
      ? item.end.at
      : start + (item.duration || DEFAULT_TALK_MINUTES) * MINUTE;
  return { start, end };
}

export function overlaps(left, right) {
  const a = talkSpan(left);
  const b = talkSpan(right);
  return a.start < b.end && b.start < a.end;
}

/** The agenda by the conference's own calendar day, in order. */
export function agendaDays(agenda = []) {
  const days = new Map();
  for (const item of agenda) {
    if (!days.has(item.start.date)) days.set(item.start.date, []);
    days.get(item.start.date).push(item);
  }
  return [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, talks]) => ({ date, talks }));
}

/**
 * The day's plan: talks that never overlap with the highest total score,
 * staying in the same room when that costs nothing. `scores` maps a talk id
 * to its score; talks without one are never planned.
 */
// ponytail: O(n²) per day, fine for a few hundred talks a day.
export function planDay(talks = [], scores = new Map()) {
  const scored = talks
    .filter((item) => (scores.get(item.id) || 0) > 0)
    .map((item) => ({ item, ...talkSpan(item) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const best = [];
  const previous = [];
  for (let i = 0; i < scored.length; i += 1) {
    best[i] = SCORE_WEIGHT * scores.get(scored[i].item.id);
    previous[i] = -1;
    for (let j = 0; j < i; j += 1) {
      if (scored[j].end > scored[i].start) continue;
      const stay =
        scored[i].item.room && scored[i].item.room === scored[j].item.room
          ? 1
          : 0;
      const total =
        best[j] + stay + SCORE_WEIGHT * scores.get(scored[i].item.id);
      if (total > best[i]) {
        best[i] = total;
        previous[i] = j;
      }
    }
  }
  let last = -1;
  for (let i = 0; i < scored.length; i += 1) {
    if (last === -1 || best[i] > best[last]) last = i;
  }
  const plan = [];
  for (let i = last; i !== -1; i = previous[i]) plan.unshift(scored[i].item);
  return plan;
}

/** The best-scored talk running at the same time as `talk`, outside the plan. */
export function backupFor(talk, talks = [], plan = [], scores = new Map()) {
  const planned = new Set(plan.map((item) => item.id));
  let backup = null;
  for (const item of talks) {
    if (planned.has(item.id) || !overlaps(item, talk)) continue;
    const score = scores.get(item.id) || 0;
    if (score > (backup ? scores.get(backup.id) || 0 : 0)) backup = item;
  }
  return backup;
}

// A crowd this big at one time, in one session and room, is a poster session
// even when Indico does not call it one.
const POSTER_CROWD = 8;
export const POSTERS_SHOWN = 10;

/**
 * The day as the planner sees it: talks as they are, and each poster session
 * as one item that lasts as long as its posters, with `posters` best first.
 * You go to a poster session and visit several; you cannot attend 1,000
 * posters one at a time, or pick just one.
 */
export function dayUnits(talks = [], scores = new Map()) {
  const crowds = new Map();
  const crowdKey = (item) =>
    `${item.session}|${item.room}|${item.start.at}|${talkSpan(item).end}`;
  for (const item of talks)
    crowds.set(crowdKey(item), (crowds.get(crowdKey(item)) || 0) + 1);

  const units = [];
  const blocks = new Map();
  for (const item of talks) {
    const poster =
      /poster/i.test(item.type || '') ||
      /poster/i.test(item.session || '') ||
      crowds.get(crowdKey(item)) >= POSTER_CROWD;
    if (!poster) {
      units.push(item);
      continue;
    }
    const id = `posters:${item.session || item.type || 'Posters'}|${item.start.at}`;
    if (!blocks.has(id)) {
      const block = { ...item, id, url: '', speakers: [], posters: [] };
      block.title = item.session || 'Poster session';
      blocks.set(id, block);
      units.push(block);
    }
    const block = blocks.get(id);
    block.posters.push(item);
    if (talkSpan(item).end > talkSpan(block).end) {
      block.end = item.end;
      block.duration = item.duration;
    }
    if (block.room !== item.room) block.room = '';
  }
  for (const block of blocks.values()) {
    block.posters.sort(
      (left, right) => (scores.get(right.id) || 0) - (scores.get(left.id) || 0)
    );
  }
  return units;
}

/** Scores for the planner: a poster session is worth its best poster. */
export function unitScores(units = [], scores = new Map()) {
  const out = new Map(scores);
  for (const unit of units) {
    if (unit.posters)
      out.set(
        unit.id,
        Math.max(0, ...unit.posters.map((item) => scores.get(item.id) || 0))
      );
  }
  return out;
}

/** The plan with `talk` in it, and whatever it clashes with taken out. */
export function choose(plan = [], talk) {
  return [
    ...plan.filter((item) => item.id !== talk.id && !overlaps(item, talk)),
    talk
  ].sort((left, right) => talkSpan(left).start - talkSpan(right).start);
}
