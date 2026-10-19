import { fieldError } from '../../common/errors';

/** The school's timezone: "today", day boundaries and PTM/event dates are in IST. */
export const IST = 'Asia/Kolkata';

/** Today's date in the school's timezone, YYYY-MM-DD. */
export const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(new Date());

/** A YYYY-MM-DD key as the Date Prisma stores for @db.Date columns (UTC midnight). */
export const dateOnly = (key: string) => new Date(`${key}T00:00:00.000Z`);

/** @db.Date column → YYYY-MM-DD. */
export const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** Timestamp → ISO string. */
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const addDays = (key: string, n: number) => {
  const d = dateOnly(key);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Midnight today in the school's timezone, as an instant. */
export const startOfToday = () => new Date(`${todayKey()}T00:00:00+05:30`);

export const hoursSince = (d: Date) => Math.max(0, Math.floor((Date.now() - d.getTime()) / 3_600_000));

export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "09:00" + 25 min → "09:25" (wraps past midnight). */
export function timeAdd(hhmm: string, minutes: number) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Class + section as the pages show it, e.g. "Grade 5A". */
export const gradeOf = (s?: { name: string; class: { name: string } } | null) => (s ? `${s.class.name}${s.name}` : null);

export const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Engagement band used by the directory filters and KPIs. */
export const ENGAGEMENT = { high: 70, medium: 50 } as const;

/** Reply SLA for unanswered parent messages, in hours. */
export const REPLY_SLA_HOURS = 24;

export const RISK_ORDER: Record<string, number> = { 'At Risk': 0, 'Developing Risk': 1, Watch: 2, 'On Track': 3 };

// ---------------------------------------------------------------------------
// Audiences (circulars and events)
// ---------------------------------------------------------------------------
export type AudienceKind = 'all' | 'grades' | 'transport' | 'staff';
export interface Audience {
  kind: AudienceKind;
  grades?: number[];
}
const KINDS: AudienceKind[] = ['all', 'grades', 'transport', 'staff'];

/** Validates an audience from a request body; `gradesField` is where the "choose a grade" error is shown. */
export function parseAudience(raw: unknown, gradesField = 'audience.grades'): Audience {
  const a = (raw && typeof raw === 'object' ? raw : {}) as { kind?: unknown; grades?: unknown };
  if (!KINDS.includes(a.kind as AudienceKind)) throw fieldError('audience', 'Choose an audience');
  const kind = a.kind as AudienceKind;
  if (kind !== 'grades') return { kind };
  const grades = Array.isArray(a.grades)
    ? [...new Set(a.grades.map(Number).filter((g) => Number.isInteger(g) && g >= -3 && g <= 14))].sort((x, y) => x - y)
    : [];
  if (!grades.length) throw fieldError(gradesField, 'Choose at least one grade');
  return { kind, grades };
}

/** The stored JSON audience, read back defensively. */
export function audienceOf(raw: unknown): Audience {
  try {
    return parseAudience(raw);
  } catch {
    return { kind: 'all' };
  }
}

export function audienceLabel(a: Audience): string {
  switch (a.kind) {
    case 'all':
      return 'All parents';
    case 'transport':
      return 'Transport users';
    case 'staff':
      return 'All staff';
    case 'grades': {
      const g = a.grades ?? [];
      return g.length === 1 ? `Parents of Grade ${g[0]}` : `Parents of Grades ${g.join(', ')}`;
    }
  }
}
