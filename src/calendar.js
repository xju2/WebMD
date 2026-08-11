export function calendarDays(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      date,
      currentMonth: date.getMonth() === month.getMonth(),
      today: sameDay(date, new Date())
    };
  });
}

export function shiftMonth(month, amount) {
  return new Date(month.getFullYear(), month.getMonth() + amount, 1);
}

// Picks the neighbouring daily note in a list ordered oldest to newest. The
// walk reverses at either end instead of stalling, so the button keeps moving
// once it reaches today. `step` is the direction the previous hop travelled.
export function stepDailyNote(count, index, step) {
  if (count <= 0) return null;
  // Nothing daily is open, so start from the newest note and walk backwards.
  if (index < 0 || index >= count) return { index: count - 1, step: -1 };

  const forward = step >= 0 ? 1 : -1;
  const next = index + forward;
  if (next >= 0 && next < count) return { index: next, step: forward };

  const back = index - forward;
  if (back < 0 || back >= count) return null;
  return { index: back, step: -forward };
}

export function dailyNoteDateFromPath(path) {
  const name = String(path ?? '')
    .split('/')
    .pop();
  const match = /^(\d{4})-(\d{2})-(\d{2})\.(?:md|markdown)$/i.exec(name ?? '');
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  // Rejects impossible dates such as 2026-02-30, which Date rolls forward.
  return dailyNoteDate(date) === `${year}-${month}-${day}` ? date : null;
}

export function dailyNotePath(date, folder = '/') {
  const dateText = dailyNoteDate(date);
  return `${folder === '/' ? '' : folder}/${dateText}.md`;
}

export function dailyNoteDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function dailyNoteContent(date, filePath, template = '') {
  const title = filePath.split('/').pop().replace(/\.md$/i, '');
  if (!template) return `# ${title}\n\n`;

  return template
    .replaceAll('{{date}}', dailyNoteDate(date))
    .replaceAll('{{title}}', title)
    .replaceAll(
      '{{weekday}}',
      date.toLocaleDateString([], { weekday: 'long' })
    );
}

export function sameDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
