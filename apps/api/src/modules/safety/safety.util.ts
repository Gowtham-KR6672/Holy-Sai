import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { SettingsService } from '../settings/settings.service';

// ---------------------------------------------------------------------------
// Reference values (must match apps/web/src/pages/safety/types.ts)
// ---------------------------------------------------------------------------
export const GATES = ['Main Gate', 'Rear Gate', 'Visitor Gate', 'Bus Bay'];
export const GATE_METHODS = ['RFID', 'Face', 'QR', 'Manual', 'Bus'];
export const PICKUP_METHODS = ['QR', 'QR + Face', 'Face', 'OTP', 'OTP + ID'];
export const INCIDENT_TYPES = ['Safeguarding', 'Health', 'Transport', 'Facilities', 'Security', 'Emergency'];
export const SEVERITIES = ['Critical', 'Attention', 'Information'];
export const INCIDENT_STATUSES = ['Open', 'Under Review', 'Escalated', 'Closed'];
export const OUTCOMES = ['Under observation', 'Returned to class', 'Awaiting pickup', 'Sent home', 'Referred to hospital'];
export const SESSION_STATUSES = ['Scheduled', 'Completed', 'Cancelled', 'Referred'];
export const VISIT_PURPOSES = ['Parent meeting', 'Admission enquiry', 'Vendor / contractor', 'Audit or inspection', 'Other'];

/** The permission that marks the Designated Safeguarding Lead, the Principal and counsellors. */
export const SENSITIVE = 'students.sensitive';

// ---------------------------------------------------------------------------
// School-local time
// ---------------------------------------------------------------------------
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function parts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(d)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Clock bound to the school timezone (Settings › school.timezone). */
export class Clock {
  constructor(public readonly tz: string) {}

  /** Minutes the zone is ahead of UTC at a moment. */
  offset(at: Date): number {
    const p = parts(at, this.tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / MINUTE);
  }

  /** YYYY-MM-DD in the school timezone. */
  date(d: Date = new Date()): string {
    const p = parts(d, this.tz);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }

  today(): string {
    return this.date(new Date());
  }

  /** HH:mm in the school timezone. */
  time(d: Date): string {
    const p = parts(d, this.tz);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  }

  /** The instant of a local date and time ("HH:mm"). */
  at(date: string, hhmm = '00:00'): Date {
    const [y, m, d] = date.split('-').map(Number);
    const [h, mi] = hhmm.split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, h, mi);
    return new Date(guess - this.offset(new Date(guess)) * MINUTE);
  }

  /** [start, end) of a local day. */
  bounds(date: string): { start: Date; end: Date } {
    const start = this.at(date);
    return { start, end: new Date(start.getTime() + DAY) };
  }

  /** Value for a @db.Date column holding a local day. */
  dayValue(date: string): Date {
    return new Date(`${date}T00:00:00.000Z`);
  }

  /** Local start of the month containing a date, and the same point last month. */
  monthStart(date: string): string {
    return `${date.slice(0, 7)}-01`;
  }

  addDays(date: string, n: number): string {
    const d = new Date(`${date}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
}

export const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const dayStr = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Students as the safety pages show them
// ---------------------------------------------------------------------------
export interface StudentInfo {
  id: string;
  admissionNo: string;
  fullName: string;
  firstName: string;
  grade: string | null;
  section: string | null;
  campusId: string;
  campusName: string;
  medicalNotes: string | null;
  routeId: string | null;
  routeCode: string | null;
  stopId: string | null;
  stopName: string | null;
}

const STUDENT_INCLUDE = {
  section: { select: { name: true, class: { select: { name: true } } } },
  campus: { select: { name: true } },
  transport: { select: { routeId: true, stopId: true, route: { select: { code: true } }, stop: { select: { name: true } } } },
} satisfies Prisma.StudentInclude;

type StudentWithInclude = Prisma.StudentGetPayload<{ include: typeof STUDENT_INCLUDE }>;

function toInfo(s: StudentWithInclude): StudentInfo {
  return {
    id: s.id,
    admissionNo: s.admissionNo,
    fullName: s.fullName,
    firstName: s.firstName,
    grade: s.section?.class?.name ?? null,
    section: s.section?.name ?? null,
    campusId: s.campusId,
    campusName: s.campus?.name ?? '',
    medicalNotes: s.medicalNotes,
    routeId: s.transport?.routeId ?? null,
    routeCode: s.transport?.route?.code ?? null,
    stopId: s.transport?.stopId ?? null,
    stopName: s.transport?.stop?.name ?? null,
  };
}

/** Sorts rows in memory by an allow-listed key (for columns that come from joined records). */
export function sortRows<T>(rows: T[], key: string | undefined, dir: 'asc' | 'desc' | undefined, map: Record<string, (r: T) => string | number | null>, fallback: string, fallbackDir: 'asc' | 'desc' = 'asc'): T[] {
  const known = !!key && !!map[key];
  const k = known ? key! : fallback;
  const d = known ? (dir ?? 'asc') : fallbackDir;
  const get = map[k];
  const sign = d === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === y) return 0;
    if (x === null || x === undefined) return 1; // blanks last
    if (y === null || y === undefined) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), 'en', { numeric: true, sensitivity: 'base' }) * sign;
  });
}

/** Scope, students, staff and users for the safety module. */
@Injectable()
export class SafetyContext {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
    private readonly integrations: IntegrationsService,
  ) {}

  async clock(): Promise<Clock> {
    const tz = await this.settings.get<string>('school.timezone', 'Asia/Kolkata');
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: tz });
      return new Clock(tz);
    } catch {
      return new Clock('Asia/Kolkata');
    }
  }

  /** Campus filter for campus-level records (visitors, incidents, broadcasts). */
  campus(user: AuthUser, requested?: string | null): string | undefined {
    return this.scope.campus(user, requested);
  }

  /** The campus a new campus-level record belongs to: header campus, the user's campus, or the only campus. */
  async campusFor(user: AuthUser, requested?: string | null): Promise<string | null> {
    const c = this.scope.campus(user, requested) ?? user.campusId;
    if (c) return c;
    if (user.employeeId) {
      const e = await this.prisma.employee.findUnique({ where: { id: user.employeeId }, select: { campusId: true } });
      if (e) return e.campusId;
    }
    const campuses = await this.prisma.campus.findMany({ where: { isActive: true }, select: { id: true }, take: 2 });
    return campuses.length === 1 ? campuses[0].id : null;
  }

  /**
   * Students a safety user may see. Gate, front-office and security staff (safety.manage, or staff
   * self-service roles) work across their campus; teachers see their own sections; parents their children.
   */
  async studentWhere(user: AuthUser, requested?: string | null): Promise<Prisma.StudentWhereInput> {
    const campusWide =
      user.scope === 'school' ||
      user.permissions.has('safety.manage') ||
      (user.scope === 'self' && !user.studentId && (user.permissions.has('safety.read') || user.permissions.has('transport.read')));
    if (!campusWide) return this.scope.studentWhere(user, requested);
    const campusId = this.scope.campus(user, requested);
    return campusId ? { campusId } : {};
  }

  /** Filter for per-student safety records ({ campusId } or { studentId: { in } }). */
  async recordWhere(user: AuthUser, requested?: string | null): Promise<{ campusId?: string; studentId?: { in: string[] } }> {
    const where = await this.studentWhere(user, requested);
    const keys = Object.keys(where);
    if (keys.length === 0) return {};
    if (keys.length === 1 && typeof where.campusId === 'string') return { campusId: where.campusId };
    const ids = await this.prisma.student.findMany({ where, select: { id: true } });
    return { studentId: { in: ids.map((s) => s.id) } };
  }

  async assertStudent(user: AuthUser, studentId: string): Promise<StudentInfo> {
    const where = await this.studentWhere(user);
    const s = await this.prisma.student.findFirst({ where: { AND: [where, { id: studentId }] }, include: STUDENT_INCLUDE });
    if (!s) {
      const exists = await this.prisma.student.count({ where: { id: studentId } });
      if (!exists) throw notFound('Student');
      throw forbidden('This student is outside your access');
    }
    return toInfo(s);
  }

  async students(ids: (string | null | undefined)[]): Promise<Map<string, StudentInfo>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    const rows = await this.prisma.student.findMany({ where: { id: { in: list } }, include: STUDENT_INCLUDE });
    return new Map(rows.map((s) => [s.id, toInfo(s)]));
  }

  async findStudents(where: Prisma.StudentWhereInput, opts: { take?: number; orderBy?: Prisma.StudentOrderByWithRelationInput } = {}): Promise<StudentInfo[]> {
    const rows = await this.prisma.student.findMany({ where, include: STUDENT_INCLUDE, orderBy: opts.orderBy ?? { fullName: 'asc' }, take: opts.take });
    return rows.map(toInfo);
  }

  /** Student ids in scope matching a search term (name or admission number). */
  async matchingStudentIds(user: AuthUser, q: string, requested?: string | null): Promise<string[]> {
    const where = await this.studentWhere(user, requested);
    const term = q.trim();
    const rows = await this.prisma.student.findMany({
      where: { AND: [where, { OR: [{ fullName: { contains: term, mode: 'insensitive' } }, { admissionNo: { contains: term, mode: 'insensitive' } }] }] },
      select: { id: true },
      take: 2000,
    });
    return rows.map((r) => r.id);
  }

  async employees(ids: (string | null | undefined)[]): Promise<Map<string, { id: string; fullName: string; designation: string; campusId: string }>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    const rows = await this.prisma.employee.findMany({ where: { id: { in: list } }, select: { id: true, fullName: true, designation: true, campusId: true } });
    return new Map(rows.map((e) => [e.id, e]));
  }

  async userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    const rows = await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, fullName: true } });
    return new Map(rows.map((u) => [u.id, u.fullName]));
  }

  async campusNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    const rows = await this.prisma.campus.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
    return new Map(rows.map((c) => [c.id, c.name]));
  }

  /** Active user accounts linked to employees (for notifying hosts, owners and counsellors). */
  async usersForEmployees(employeeIds: (string | null | undefined)[]): Promise<string[]> {
    const list = [...new Set(employeeIds.filter((x): x is string => !!x))];
    if (!list.length) return [];
    const rows = await this.prisma.user.findMany({ where: { employeeId: { in: list }, status: 'active' }, select: { id: true } });
    return rows.map((u) => u.id);
  }

  /** Gates configured on the gate integration (falls back to the four standard gates). */
  async gates(): Promise<{ gates: string[]; readers: boolean; provider: string | null }> {
    try {
      const i = await this.integrations.get('gate');
      const configured = (i.config.gates ?? '').split(',').map((g) => g.trim()).filter(Boolean);
      return { gates: configured.length ? configured : GATES, readers: i.isEnabled, provider: i.provider };
    } catch {
      return { gates: GATES, readers: false, provider: null };
    }
  }

  /** The current academic year, or the 12 months up to today. */
  async academicYear(clock: Clock): Promise<{ start: Date; end: Date; startsOn: string; endsOn: string }> {
    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    if (year) {
      const startsOn = dayStr(year.startsOn);
      const endsOn = dayStr(year.endsOn);
      return { start: clock.at(startsOn), end: clock.bounds(endsOn).end, startsOn, endsOn };
    }
    const endsOn = clock.today();
    const startsOn = clock.addDays(endsOn, -364);
    return { start: clock.at(startsOn), end: clock.bounds(endsOn).end, startsOn, endsOn };
  }

  /** The current term: the third of the academic year containing today (last 120 days without a year). */
  async term(clock: Clock): Promise<{ start: Date; end: Date }> {
    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    const now = new Date();
    if (year) {
      const start = clock.at(dayStr(year.startsOn));
      const end = clock.bounds(dayStr(year.endsOn)).end;
      if (now >= start && now < end) {
        const third = (end.getTime() - start.getTime()) / 3;
        const idx = Math.min(2, Math.floor((now.getTime() - start.getTime()) / third));
        return { start: new Date(start.getTime() + idx * third), end: new Date(start.getTime() + (idx + 1) * third) };
      }
    }
    const today = clock.today();
    return { start: clock.at(clock.addDays(today, -119)), end: clock.bounds(today).end };
  }
}
