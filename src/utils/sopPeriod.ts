import type { SopFrequency } from "./constants";

const pad = (n: number) => String(n).padStart(2, "0");

function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: date.getUTCFullYear(), week };
}

/** Stable key identifying the period a date falls in, for a given cadence. */
export function periodKey(freq: SopFrequency, d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  if (freq === "daily") return `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (freq === "weekly") {
    const { year, week } = isoWeek(d);
    return `${year}-W${pad(week)}`;
  }
  if (freq === "monthly") return `${y}-${pad(d.getUTCMonth() + 1)}`;
  return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`; // quarterly
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Human label for a period key (e.g. "July 2026", "Q3 2026", "Week 30, 2026"). */
export function periodLabel(freq: SopFrequency, key: string): string {
  if (freq === "daily") {
    const [y, m, d] = key.split("-");
    return `${d} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
  }
  if (freq === "weekly") {
    const [y, w] = key.split("-W");
    return `Week ${Number(w)}, ${y}`;
  }
  if (freq === "monthly") {
    const [y, m] = key.split("-");
    const full = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${full[Number(m) - 1] ?? m} ${y}`;
  }
  return key.replace("-", " "); // "2026 Q3" → "2026 Q3"
}

/** Start instant of the current period. */
export function periodStart(freq: SopFrequency, d: Date = new Date()): Date {
  const y = d.getUTCFullYear();
  if (freq === "daily") return new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
  if (freq === "weekly") {
    const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0
    return new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate() - dayNum, 0, 0, 0));
  }
  if (freq === "monthly") return new Date(Date.UTC(y, d.getUTCMonth(), 1, 0, 0, 0));
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(y, q * 3, 1, 0, 0, 0));
}

/** Key of the period immediately before the one `d` falls in (for overdue checks). */
export function prevPeriodKey(freq: SopFrequency, d: Date = new Date()): string {
  const justBefore = new Date(periodStart(freq, d).getTime() - 1); // 1ms into the previous period
  return periodKey(freq, justBefore);
}

/** End instant of the current period (used to decide "due soon"). */
export function periodEnd(freq: SopFrequency, d: Date = new Date()): Date {
  const y = d.getUTCFullYear();
  if (freq === "daily") return new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), 23, 59, 59));
  if (freq === "weekly") {
    const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0
    const end = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate() + (6 - dayNum), 23, 59, 59));
    return end;
  }
  if (freq === "monthly") return new Date(Date.UTC(y, d.getUTCMonth() + 1, 0, 23, 59, 59));
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(y, q * 3 + 3, 0, 23, 59, 59));
}

/** True when the current period is close enough to its end to nudge the owner. */
export function isDueWindow(freq: SopFrequency, now: Date = new Date()): boolean {
  const msLeft = periodEnd(freq, now).getTime() - now.getTime();
  const day = 86_400_000;
  if (freq === "daily") return true; // a daily task is always "due today"
  if (freq === "weekly") return msLeft <= 2 * day;
  if (freq === "monthly") return msLeft <= 5 * day;
  return msLeft <= 10 * day; // quarterly
}
