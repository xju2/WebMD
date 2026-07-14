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

export function dailyNotePath(date, folder = '/') {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${folder === '/' ? '' : folder}/${year}-${month}-${day}.md`;
}

export function sameDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
