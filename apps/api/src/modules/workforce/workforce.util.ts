import type { Prisma } from '@prisma/client';

/** School time zone: dates and clock times shown to staff are in IST. */
export const TZ = 'Asia/Kolkata';

export const ATTENDANCE_STATUSES = ['Present', 'Late', 'Half Day', 'Absent', 'On Leave'] as const;
export const TODAY_STATUSES = [...ATTENDANCE_STATUSES, 'Not marked'] as const;
export const LEAVE_OPEN = ['Submitted', 'Under Review'];
export const OT_OPEN = ['Submitted', 'Under Review'];
export const RUN_STAGES = ['Draft', 'Inputs', 'Calculated', 'Under Review', 'Approved', 'Released', 'Paid'] as const;
export type RunStatus = (typeof RUN_STAGES)[number];

export const CPD_TARGET = { teaching: 24, non_teaching: 12 } as const;
export const MANDATORY_CPD = /child protection|safeguarding|posh|first aid|fire safety/i;

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

/** YYYY-MM-DD in school time. */
export const todayKey = (at = new Date()) => dayFmt.format(at);
/** HH:MM in school time. */
export const timeKey = (at = new Date()) => timeFmt.format(at).replace(/^24:/, '00:');

/** A YYYY-MM-DD key as a UTC-midnight Date (how Prisma stores @db.Date). */
export const dateOf = (key: string) => new Date(`${key.slice(0, 10)}T00:00:00Z`);
export const keyOf = (d: Date) => d.toISOString().slice(0, 10);
export const keyOrNull = (d: Date | null | undefined) => (d ? keyOf(d) : null);
export const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const addDays = (key: string, n: number) => keyOf(new Date(dateOf(key).getTime() + n * 864e5));
export const weekday = (key: string) => dateOf(key).getUTCDay(); // 0 = Sunday
export const isSunday = (key: string) => weekday(key) === 0;
/** Monday of the week containing the date. */
export const mondayOf = (key: string) => addDays(key, -((weekday(key) + 6) % 7));
export const monthStartKey = (key: string) => `${key.slice(0, 7)}-01`;
export const monthEndKey = (key: string) => {
  const d = dateOf(monthStartKey(key));
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return keyOf(d);
};
export const addMonths = (key: string, n: number) => {
  const d = dateOf(monthStartKey(key));
  d.setUTCMonth(d.getUTCMonth() + n);
  return keyOf(d);
};

/** Every date from..to inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = from; k <= to && out.length < 800; k = addDays(k, 1)) out.push(k);
  return out;
}

/** Working days (Monday to Saturday) from..to inclusive. */
export const workingDays = (from: string, to: string) => eachDay(from, to).filter((k) => !isSunday(k));

export const monthLabel = (key: string) =>
  dateOf(key).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const monthShort = (key: string) => dateOf(key).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
export const dateLabel = (key: string) => dateOf(key).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export const num = (v: Prisma.Decimal | number | string | null | undefined) => (v == null ? 0 : Number(v));
export const round = (v: number, places = 2) => {
  const f = 10 ** places;
  return Math.round((v + Number.EPSILON) * f) / f;
};
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);

/** "Main Gate · Rear Gate" → group "Main Gate", duty "Rear Gate". */
export function splitPost(post: string): { group: string; duty: string | null } {
  const i = post.indexOf(' · ');
  if (i < 0) return { group: post.trim(), duty: null };
  return { group: post.slice(0, i).trim(), duty: post.slice(i + 3).trim() || null };
}

/** Minutes since midnight for "HH:MM". */
export const minutes = (hhmm: string | null | undefined) => {
  if (!hhmm || !/^\d{1,2}:\d{2}/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const sumBy = <T>(rows: T[], f: (r: T) => number) => rows.reduce((acc, r) => acc + f(r), 0);

export function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** Sorts rows in memory by a key function; nulls last. */
export function sortRows<T>(rows: T[], key: (r: T) => string | number | null | undefined, dir: 'asc' | 'desc' = 'asc'): T[] {
  const m = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * m;
    return String(x).localeCompare(String(y), 'en', { numeric: true }) * m;
  });
}

export const isUuid = (v: string | null | undefined) => !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
