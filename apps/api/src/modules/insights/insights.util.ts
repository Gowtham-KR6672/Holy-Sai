import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { fieldError, notFound } from '../../common/errors';

// ---------------------------------------------------------------------------
// School clock. Date-only columns are stored as UTC midnight; "today" is the school's date (IST).
// ---------------------------------------------------------------------------

export const TZ = 'Asia/Kolkata';
const DAY = 86_400_000;
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

/** YYYY-MM-DD on the school clock. */
export const todayKey = (at = new Date()) => dayFmt.format(at);
/** HH:MM on the school clock. */
export const nowTime = (at = new Date()) => hourFmt.format(at).replace(/^24:/, '00:');
/** YYYY-MM-DD → Date at UTC midnight (how Prisma stores @db.Date). */
export const dateOf = (key: string) => new Date(`${key.slice(0, 10)}T00:00:00.000Z`);
/** Date-only value → YYYY-MM-DD. */
export const keyOf = (d: Date) => d.toISOString().slice(0, 10);
export const keyOrNull = (d: Date | null | undefined) => (d ? keyOf(d) : null);
export const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const addDays = (key: string, n: number) => keyOf(new Date(dateOf(key).getTime() + n * DAY));
/** 0 = Sunday … 6 = Saturday. */
export const weekday = (key: string) => dateOf(key).getUTCDay();
/** Whole days from one date key to another. */
export const daysBetween = (from: string, to: string) => Math.round((dateOf(to).getTime() - dateOf(from).getTime()) / DAY);
/** The instant the school day began for a date key. */
export const istStart = (key: string) => new Date(`${key.slice(0, 10)}T00:00:00+05:30`);
/** The school-clock date of a timestamp. */
export const istKey = (d: Date) => dayFmt.format(d);
export const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
/** Whole days since a timestamp (0 for today). */
export const ageDays = (d: Date | null | undefined) => (d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY)) : 0);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "2026-10" → "Oct" */
export const monthShort = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;
/** "2026-10" → "Oct 2026" */
export const monthLong = (ym: string) => `${monthShort(ym)} ${ym.slice(0, 4)}`;
/** "2026-10-14" → "14 Oct" */
export const shortDate = (key: string) => `${Number(key.slice(8, 10))} ${monthShort(key.slice(0, 7))}`;
export const nextMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
export const prevMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
/** Every month key from..to inclusive (YYYY-MM). */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7) && out.length < 36; m = nextMonth(m)) out.push(m);
  return out;
}
/** The last `n` school days (Monday–Saturday) up to and including `key`, oldest first. */
export function recentSchoolDays(key: string, n: number): string[] {
  const out: string[] = [];
  let d = key;
  while (out.length < n) {
    if (weekday(d) !== 0) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export const num = (v: Prisma.Decimal | number | bigint | string | null | undefined): number => (v == null ? 0 : Number(v));
export const r1 = (n: number) => Math.round(n * 10) / 10;
export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** part ÷ whole as a percentage with one decimal, or null when there is nothing to divide by. */
export const pctOrNull = (part: number, whole: number) => (whole > 0 ? r1((part / whole) * 100) : null);
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const inr = (n: number) => INR.format(n);

// ---------------------------------------------------------------------------
// Academic year and terms
// ---------------------------------------------------------------------------

export interface YearWindow {
  id: string | null;
  label: string;
  start: Date;
  end: Date;
}

export interface TermWindow {
  label: string;
  start: string;
  end: string;
}

/** The academic year split into three terms of equal length (as the academics module does). */
export function termsOf(y: YearWindow): TermWindow[] {
  const start = y.start.getTime();
  const end = y.end.getTime();
  const span = Math.max(3, Math.round((end - start) / DAY) + 1);
  const len = Math.floor(span / 3);
  return [0, 1, 2].map((i) => ({
    label: `Term ${i + 1} ${y.label}`,
    start: keyOf(new Date(start + i * len * DAY)),
    end: i === 2 ? keyOf(y.end) : keyOf(new Date(start + ((i + 1) * len - 1) * DAY)),
  }));
}

/** The term containing the date (else the latest that started before it), and the one before it. */
export function currentTerms(y: YearWindow, today: string): { current: TermWindow; previous: TermWindow } {
  const terms = termsOf(y);
  let idx = terms.findIndex((t) => t.start <= today && today <= t.end);
  if (idx < 0) idx = today < terms[0].start ? 0 : terms.length - 1;
  const current = terms[idx];
  const previous = idx > 0 ? terms[idx - 1] : {
    label: 'Previous term',
    start: addDays(current.start, -(daysBetween(current.start, current.end) + 1)),
    end: addDays(current.start, -1),
  };
  return { current, previous };
}

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

/** A date parameter for a @db.Date column (independent of the session time zone). */
export const sqlDate = (key: string | Date) => Prisma.sql`${typeof key === 'string' ? key.slice(0, 10) : keyOf(key)}::date`;
/** A timestamp parameter for a DateTime column (stored as UTC without a zone). */
export const sqlTs = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** `AND <column> = <campus>` when a campus is chosen (nothing for the group view). */
export const andCampus = (column: string, campusId?: string | null) =>
  campusId ? Prisma.sql`AND ${Prisma.raw(column)} = ${campusId}::uuid` : Prisma.empty;

/** `AND <column> IN (…)` for a teacher's sections (nothing when unrestricted). */
export const andSections = (column: string, sectionIds?: string[] | null) =>
  sectionIds
    ? sectionIds.length
      ? Prisma.sql`AND ${Prisma.raw(column)} IN (${Prisma.join(sectionIds.map((s) => Prisma.sql`${s}::uuid`))})`
      : Prisma.sql`AND FALSE`
    : Prisma.empty;


// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** A campus id from the query string: 'all' or empty means none; anything else must be a uuid. */
export function campusParam(v: string | undefined | null): string | undefined {
  if (!v || v === 'all') return undefined;
  if (!isUUID(v)) throw fieldError('campusId', 'Choose a campus');
  return v;
}

/** 404 for ids that are not uuids (instead of a database error). */
export function uuidOr404(id: string, what: string): string {
  if (!isUUID(id)) throw notFound(what);
  return id;
}

/** Sorts rows in memory by an accessor; nulls last. */
export function sortRows<T>(rows: T[], key: (r: T) => string | number | null | undefined, dir: 'asc' | 'desc' = 'asc'): T[] {
  const m = dir === 'desc' ? -1 : 1;
  return rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * m;
    return String(x).localeCompare(String(y), 'en', { numeric: true, sensitivity: 'base' }) * m;
  });
}

/** "Grade 5" + "A" → "Grade 5A". */
export const classLabel = (grade: string | null | undefined, section: string | null | undefined) =>
  grade ? `${grade}${section ?? ''}` : null;

/** Small in-memory cache that also coalesces concurrent identical requests (dashboards are polled). */
export class ShortCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private readonly ttlMs: number, private readonly max = 300) {}

  get<T>(key: string, make: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value as Promise<T>;
    if (this.entries.size >= this.max) {
      for (const [k, v] of this.entries) if (now - v.at >= this.ttlMs) this.entries.delete(k);
      if (this.entries.size >= this.max) this.entries.clear();
    }
    const value = make();
    this.entries.set(key, { at: now, value });
    value.catch(() => this.entries.delete(key));
    return value;
  }

  clear() {
    this.entries.clear();
  }
}
