// Admissions & CRM: shared constants and school-time (Asia/Kolkata) date helpers.

export const STAGES = ['New Lead', 'Contacted', 'Qualified', 'Visit Scheduled', 'Visit Completed', 'Application', 'Assessment', 'Offer', 'Enrolled'] as const;
export const CLOSED = ['Enrolled', 'Lost'];
export const SOURCES = ['WhatsApp', 'Website', 'Meta Ads', 'Referral', 'Google', 'Walk-in', 'Instagram', 'Phone'] as const;
export const FOLLOW_UP_TYPES = ['Call', 'WhatsApp', 'Email', 'SMS', 'Campus Visit', 'Meeting', 'Note'] as const;
export const COMM_CHANNELS = ['Call', 'WhatsApp', 'Email', 'SMS', 'Note', 'In-app'] as const;
export const VISIT = 'Campus Visit';

/** Standard document checklist requested when an application opens. */
export const DOCUMENTS = ['Birth certificate', 'Previous report card', 'Address proof', 'Photograph'];

export const APP_STATUSES = ['Submitted', 'Under Review', 'Assessment Scheduled', 'Offer Made', 'Accepted', 'Enrolled', 'Rejected', 'Withdrawn'] as const;
export const APP_TERMINAL = ['Enrolled', 'Rejected', 'Withdrawn'];
export const APP_LIVE = ['Draft', 'Submitted', 'Under Review', 'Assessment Scheduled', 'Offer Made', 'Accepted'];

export const VENDOR_STATUSES = ['Active', 'Renewal due', 'Expired', 'Suspended'] as const;
export const ENGAGEMENT = ['High', 'Medium', 'Low'] as const;
export const ENGAGEMENT_RANK: Record<string, number> = { High: 1, Medium: 2, Low: 3 };

/** Sort position of a stage (Lost sorts last). */
export const stageOrder = (stage: string) => (stage === 'Lost' ? 9 : Math.max(0, STAGES.indexOf(stage as (typeof STAGES)[number])));
export const stageIndex = (stage: string) => STAGES.indexOf(stage as (typeof STAGES)[number]);
export const gradeLevel = (grade: string) => Number(grade.replace(/\D/g, '')) || 0;
/** Last 10 digits of a phone number — matches "+91 98400 12345" with "9840012345". */
export const phoneKey = (phone: string) => phone.replace(/\D/g, '').slice(-10);

export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
/** Percentage change, or null when there is nothing to compare with. */
export const change = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 100) : null);
export const median = (values: number[]) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// School time (IST, UTC+05:30, no daylight saving)
// ---------------------------------------------------------------------------
const IST = 330 * 60_000;
const DAY = 86_400_000;

const parts = (d: Date) => {
  const s = new Date(d.getTime() + IST);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth(), d: s.getUTCDate(), dow: s.getUTCDay() };
};

/** Midnight (school time) of the day `add` days from `d`. */
export const dayStart = (d = new Date(), add = 0) => {
  const p = parts(d);
  return new Date(Date.UTC(p.y, p.m, p.d + add) - IST);
};
/** Monday 00:00 (school time) of the week containing `d`. */
export const weekStart = (d = new Date()) => {
  const p = parts(d);
  return new Date(Date.UTC(p.y, p.m, p.d - ((p.dow + 6) % 7)) - IST);
};
/** First day 00:00 (school time) of the month `add` months from `d`. */
export const monthStart = (d = new Date(), add = 0) => {
  const p = parts(d);
  return new Date(Date.UTC(p.y, p.m + add, 1) - IST);
};
/** "YYYY-MM-DD" of an instant in school time. */
export const dayKey = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10);
export const todayKey = () => dayKey(new Date());
/** A @db.Date value as "YYYY-MM-DD". */
export const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** "YYYY-MM-DD" → a @db.Date value. */
export const asDate = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
/** A @db.Date value → the instant its day starts in school time. */
export const dateToInstant = (d: Date) => new Date(d.getTime() - IST);
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const daysBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / DAY;
/** School-time `hh:mm` on the day `add` days from now. */
export const atTime = (add: number, hh: number, mm = 0) => new Date(dayStart(new Date(), add).getTime() + (hh * 60 + mm) * 60_000);

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });
const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const WHEN = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' });
export const monthLabel = (d: Date) => MONTH.format(d);
/** "12 Oct" */
export const shortDate = (d: Date) => SHORT.format(d);
/** "Mon 12 Oct, 10:00" */
export const whenLabel = (d: Date) => WHEN.format(d);

/** The last `n` calendar months (school time), oldest first. */
export function lastMonths(n = 12, now = new Date()) {
  return Array.from({ length: n }, (_, i) => {
    const start = monthStart(now, i - n + 1);
    return { start, end: monthStart(now, i - n + 2), label: monthLabel(new Date(start.getTime() + DAY)) };
  });
}

/** Index of the month bucket an instant falls in, or -1. */
export const bucketOf = (months: { start: Date; end: Date }[], d: Date) => months.findIndex((m) => d >= m.start && d < m.end);
