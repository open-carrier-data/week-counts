// ISO weeks in UTC, as text such as 2026-W45. Text order is time order.

const DAY = 86_400_000;

/** The Monday 00:00 UTC, in ms, of the ISO week that holds `ms`. */
function mondayOf(ms) {
  const day = Math.floor(ms / DAY);
  // 1970-01-01 was a Thursday, so day 0 is weekday 3 counted from Monday.
  return (day - ((day + 3) % 7)) * DAY;
}

/** The ISO week that holds `ms`. */
export function weekOf(ms) {
  const thursday = new Date(mondayOf(ms) + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const number = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY)) + 1;
  return `${year}-W${String(number).padStart(2, "0")}`;
}

/** The week `offset` weeks from the one that holds `ms`. */
export function weekFrom(ms, offset) {
  return weekOf(mondayOf(ms) + offset * 7 * DAY);
}

/** The Monday of a week, in ms; null when the text names no ISO week. */
export function mondayOfWeek(week) {
  const match = /^([0-9]{4})-W([0-9]{2})$/.exec(week);
  if (!match) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  // January 4th is always in week 1.
  const monday = mondayOf(Date.UTC(year, 0, 4)) + (number - 1) * 7 * DAY;
  return number >= 1 && weekOf(monday) === week ? monday : null;
}

/** The month a week counts for: the one that holds its Thursday, as ISO weeks do for years. */
export function monthOfWeek(week) {
  const monday = mondayOfWeek(week);
  return new Date(monday + 3 * DAY).toISOString().slice(0, 7);
}

/** Every week that counts for `month` (YYYY-MM), oldest first. */
export function weeksOfMonth(month) {
  const [year, number] = month.split("-").map(Number);
  const weeks = [];
  let ms = mondayOf(Date.UTC(year, number - 1, 1)) - 7 * DAY;
  for (let i = 0; i < 7; i += 1, ms += 7 * DAY) {
    const week = weekOf(ms);
    if (monthOfWeek(week) === month) weeks.push(week);
  }
  return weeks;
}

/** A report may name this week or the last, so a week takes no more reports only from the week after next. */
export function isClosed(week, nowMs) {
  return week < weekFrom(nowMs, -1);
}
