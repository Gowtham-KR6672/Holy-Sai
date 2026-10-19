// Students: shared constants and school-clock (Asia/Kolkata) date helpers.
import { notFound } from '../../common/errors';

export const SCHOOL_TZ = 'Asia/Kolkata';

/** Student lifecycle. Only `active` students are on registers, rosters and bus lists. */
export const STUDENT_STATUSES = ['active', 'discontinued', 'transferred', 'graduated'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];
export const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  discontinued: 'Discontinued',
  transferred: 'Transferred',
  graduated: 'Graduated',
};

export const RISK_BANDS = ['On Track', 'Developing Risk', 'At Risk'] as const;
export const GENDERS = ['F', 'M', 'O'] as const;
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'] as const;
export const TODAY_STATUSES = ['present', 'absent', 'late', 'leave', 'unmarked'] as const;
export const FEE_STATUSES = ['Paid', 'Partial', 'Pending', 'Overdue', 'No charges'] as const;

/** Behaviour note types. Student 360 records Positive / Note / Concern; the Wellbeing page adds Incident. */
export const BEHAVIOUR_TYPES = ['Positive', 'Note', 'Concern', 'Incident'] as const;
/** Types parents and the student themself see on the profile. */
export const FAMILY_BEHAVIOUR_TYPES = ['Positive', 'Note'];
export const CONCERN_TYPES = ['Concern', 'Incident'];
export const MOODS = ['Positive', 'Settled', 'Unsettled', 'Anxious', 'Low'] as const;
/** Moods that alert the counsellor. */
export const ALERT_MOODS = ['Anxious', 'Low'];

export const ACHIEVEMENT_TYPES = ['Competition', 'Academic', 'Co-curricular', 'Attendance', 'Sports', 'Service', 'Innovation'] as const;
export const ACHIEVEMENT_LEVELS = ['School', 'District', 'State', 'National', 'International'] as const;
export const INNOVATION_STAGES = ['Idea', 'Review', 'Mentor', 'Project', 'Prototype', 'Competition', 'Achievement'];

export const SENSITIVE = 'students.sensitive';
export const STAFF_READ = ['students.read', 'students.read_assigned'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
/** Throws a 404 for anything that is not a uuid (so a bad link reads "Student not found"). */
export function assertId(id: string, what = 'Student'): void {
  if (!isUuid(id)) throw notFound(what);
}

// ---------------------------------------------------------------------------
// School clock
// ---------------------------------------------------------------------------
/** Today on the school clock as YYYY-MM-DD. */
export function schoolToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
/** YYYY-MM-DD → Date at UTC midnight (the form Prisma uses for @db.Date). */
export const asDate = (key: string) => new Date(`${key.slice(0, 10)}T00:00:00.000Z`);
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
export const dayKeyOrNull = (d: Date | null | undefined) => (d ? dayKey(d) : null);
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export function addDays(key: string, n: number): string {
  const d = asDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return dayKey(d);
}
export const daysBetween = (from: string, to: string) => Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86_400_000);
/** The instant the school day began for a YYYY-MM-DD date. */
export const istStart = (key: string) => new Date(`${key.slice(0, 10)}T00:00:00+05:30`);
export const isDateKey = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(asDate(v).getTime());

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-06" → "Jun" (with the year when the series spans more than one). */
export const monthLabel = (ym: string, withYear = false) => `${SHORT_MONTHS[Number(ym.slice(5, 7)) - 1]}${withYear ? ` ${ym.slice(2, 4)}` : ''}`;

// ---------------------------------------------------------------------------
// Numbers and labels
// ---------------------------------------------------------------------------
export const round1 = (n: number) => Math.round(n * 10) / 10;
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** Percentage change, or null when there is nothing to compare with. */
export const change = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 100) : null);

/** Grade bands used across assessments and report cards (percentage of maximum marks). */
export function gradeFor(p: number): string {
  return p >= 90 ? 'A*' : p >= 85 ? 'A+' : p >= 78 ? 'A' : p >= 72 ? 'B+' : p >= 65 ? 'B' : p >= 55 ? 'C' : p >= 45 ? 'D' : 'E';
}

/** "R04" + "Urapakkam" → "Route 4 · Urapakkam" (as the lookups name routes). */
export const routeLabel = (code: string, name: string) => `Route ${code.replace(/^R0?/i, '')} · ${name}`;

/** Last 10 digits of a phone number — matches "+91 98400 12345" with "9840012345". */
export const phoneKey = (phone: string) => phone.replace(/\D/g, '').slice(-10);

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
