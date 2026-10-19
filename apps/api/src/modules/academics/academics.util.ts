// Shared helpers for the academics module: school-clock dates, terms, grades and labels.
import type { PrismaService } from '../../common/prisma.service';

export const SCHOOL_TZ = 'Asia/Kolkata';
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Today on the school clock as YYYY-MM-DD. */
export function schoolToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Current time on the school clock as HH:MM. */
export function schoolNow(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: SCHOOL_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

/** YYYY-MM-DD → Date at UTC midnight (the form Prisma uses for @db.Date). */
export const asDate = (key: string) => new Date(`${key.slice(0, 10)}T00:00:00.000Z`);
/** Date → YYYY-MM-DD. */
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
export const dayKeyOrNull = (d: Date | null | undefined) => (d ? dayKey(d) : null);
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function addDays(key: string, n: number): string {
  const d = asDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return dayKey(d);
}

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (key: string) => asDate(key).getUTCDay();

/** Timetable day number for a date: 1 = Monday … 6 = Saturday, 0 = Sunday (no school). */
export const timetableDay = (key: string) => weekdayOf(key);

/** Monday of the week containing the date. */
export function weekStart(key: string): string {
  const wd = weekdayOf(key);
  return addDays(key, wd === 0 ? -6 : 1 - wd);
}

/** The last `n` school days (Monday–Saturday) up to and including `key`, oldest first. */
export function recentSchoolDays(key: string, n: number): string[] {
  const out: string[] = [];
  let d = key;
  while (out.length < n) {
    if (weekdayOf(d) !== 0) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

/** "14 Oct" */
export function shortDate(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${d} ${SHORT_MONTHS[m - 1]}`;
}

/** Next date (today or later) that falls on a timetable day. */
export function nextDateForDay(today: string, day: number): string {
  for (let i = 0; i < 7; i++) {
    const k = addDays(today, i);
    if (weekdayOf(k) === day) return k;
  }
  return today;
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const pct = (n: number, of: number) => (of ? round1((100 * n) / of) : 0);
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Grade bands used across assessments and report cards (percentage of maximum marks). */
export const GRADE_BANDS = ['A*', 'A+', 'A', 'B+', 'B', 'C', 'D', 'E'];
export function gradeFor(p: number): string {
  return p >= 90 ? 'A*' : p >= 85 ? 'A+' : p >= 78 ? 'A' : p >= 72 ? 'B+' : p >= 65 ? 'B' : p >= 55 ? 'C' : p >= 45 ? 'D' : 'E';
}

/** "Grade 5" + "A" → "Grade 5A". */
export const sectionLabel = (className: string, sectionName: string) => `${className}${sectionName}`;

export interface Term {
  label: string;
  start: string;
  end: string;
}

/**
 * School terms: each academic year is split into three terms of equal length
 * ("Term 1 2026–27"). Without any academic year, calendar thirds are used.
 */
export async function loadTerms(prisma: PrismaService): Promise<Term[]> {
  const years = await prisma.academicYear.findMany({ orderBy: { startsOn: 'asc' } });
  const terms: Term[] = [];
  for (const y of years) {
    const start = asDate(dayKey(y.startsOn)).getTime();
    const end = asDate(dayKey(y.endsOn)).getTime();
    const span = Math.max(3, Math.round((end - start) / 86_400_000) + 1);
    const len = Math.floor(span / 3);
    for (let i = 0; i < 3; i++) {
      const s = dayKey(new Date(start + i * len * 86_400_000));
      const e = i === 2 ? dayKey(y.endsOn) : dayKey(new Date(start + ((i + 1) * len - 1) * 86_400_000));
      terms.push({ label: `Term ${i + 1} ${y.label}`, start: s, end: e });
    }
  }
  if (terms.length) return terms;
  const year = Number(schoolToday().slice(0, 4));
  for (const yy of [year - 1, year]) {
    terms.push({ label: `Term 1 ${yy}`, start: `${yy}-01-01`, end: `${yy}-04-30` });
    terms.push({ label: `Term 2 ${yy}`, start: `${yy}-05-01`, end: `${yy}-08-31` });
    terms.push({ label: `Term 3 ${yy}`, start: `${yy}-09-01`, end: `${yy}-12-31` });
  }
  return terms;
}

/** The term containing the date; else the latest term that started before it; else the first. */
export function termOf(terms: Term[], key: string): Term | null {
  if (!terms.length) return null;
  const hit = terms.find((t) => t.start <= key && key <= t.end);
  if (hit) return hit;
  const before = terms.filter((t) => t.start <= key);
  return before.length ? before[before.length - 1] : terms[0];
}

/** Numeric value or null from a Prisma Decimal/number. */
export const num = (v: unknown): number | null => (v == null ? null : Number(v));
