import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { fieldError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';

/** Campus local time zone; every "today" in this module is a date in this zone. */
export const TZ = 'Asia/Kolkata';
const DAY_MS = 86_400_000;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Today's date (YYYY-MM-DD) on the campus clock. */
export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

/** A YYYY-MM-DD string as a UTC-midnight Date (how @db.Date columns are stored). */
export function dateOf(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

export function today(): Date {
  return dateOf(todayIso());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/** A @db.Date value as YYYY-MM-DD. */
export function day(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** The calendar date (on the campus clock) of a timestamp, as a UTC-midnight Date. */
export function localDate(ts: Date): Date {
  return dateOf(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ts));
}

/** Current time on the campus clock as "HH:MM". */
export function nowHm(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

/** "HH:MM" → minutes after midnight. */
export function minutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/** First day of the month of a date (UTC-midnight Date). */
export function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** True for a real calendar date in YYYY-MM-DD form. */
export function isRealDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = dateOf(v);
  return !Number.isNaN(d.getTime()) && day(d) === v;
}

export const num = (v: Prisma.Decimal | number | null | undefined): number | null => (v == null ? null : Number(v));

/** Sorts rows in memory, nulls last, for sort keys a database order cannot express. */
export function sortRows<T>(rows: T[], get: (r: T) => string | number | null | undefined, dir: 'asc' | 'desc' = 'asc'): T[] {
  const m = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * m;
    return String(x).localeCompare(String(y), 'en', { sensitivity: 'base', numeric: true }) * m;
  });
}

export interface EmployeeInfo {
  id: string;
  fullName: string;
  designation: string;
  employeeType: string;
  campusId: string;
}

/** Lookups shared by the operations controllers: campus names, people, recipients. */
@Injectable()
export class OpsContext {
  private campusCache: { at: number; map: Map<string, { name: string; shortName: string; place: string }> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  async campuses() {
    if (this.campusCache && Date.now() - this.campusCache.at < 60_000) return this.campusCache.map;
    const rows = await this.prisma.campus.findMany({ select: { id: true, name: true, shortName: true, place: true } });
    const map = new Map(rows.map((c) => [c.id, { name: c.name, shortName: c.shortName, place: c.place }]));
    this.campusCache = { at: Date.now(), map };
    return map;
  }

  /** Short campus name as the forms show it. */
  async campusNames(): Promise<Map<string, string>> {
    const map = await this.campuses();
    return new Map([...map].map(([id, c]) => [id, c.shortName || c.name]));
  }

  /** Throws a field error unless the campus exists and the user may act on it. */
  async assertCampus(user: AuthUser, campusId: string, field = 'campusId') {
    const map = await this.campuses();
    if (!map.has(campusId)) {
      this.campusCache = null;
      if (!(await this.prisma.campus.findUnique({ where: { id: campusId } }))) throw fieldError(field, 'Choose a campus');
    }
    this.scope.campus(user, campusId);
  }

  async employees(ids: (string | null | undefined)[]): Promise<Map<string, EmployeeInfo>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map();
    const rows = await this.prisma.employee.findMany({
      where: { id: { in: want } },
      select: { id: true, fullName: true, designation: true, employeeType: true, campusId: true },
    });
    return new Map(rows.map((e) => [e.id, e]));
  }

  async employee(id: string | null | undefined): Promise<EmployeeInfo | null> {
    if (!id) return null;
    return (await this.employees([id])).get(id) ?? null;
  }

  /** Throws a field error unless the employee exists. */
  async assertEmployee(id: string, field: string): Promise<EmployeeInfo> {
    const e = await this.employee(id);
    if (!e) throw fieldError(field, 'Choose a staff member');
    return e;
  }

  /** Active user accounts linked to these employees. */
  async usersForEmployees(employeeIds: (string | null | undefined)[]): Promise<string[]> {
    const ids = [...new Set(employeeIds.filter((x): x is string => !!x))];
    if (!ids.length) return [];
    const rows = await this.prisma.user.findMany({ where: { employeeId: { in: ids }, status: 'active' }, select: { id: true } });
    return rows.map((u) => u.id);
  }

  /** Active users holding one of these roles, on the campus (or with no campus / group view). */
  async usersWithRoles(roleKeys: string[], campusId?: string | null): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        status: 'active',
        role: { key: { in: roleKeys } },
        ...(campusId ? { OR: [{ campusId }, { campusId: null }, { role: { permissions: { some: { permissionKey: 'dashboard.group' } } } }] } : {}),
      },
      select: { id: true },
    });
    return rows.map((u) => u.id);
  }

  /** Active staff users (not parents or students) holding a permission, on the campus or group-wide. */
  async usersWithPermission(permission: string, campusId?: string | null): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        status: 'active',
        role: { permissions: { some: { permissionKey: permission } }, key: { notIn: ['parent', 'student'] } },
        ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}),
      },
      select: { id: true },
    });
    return rows.map((u) => u.id);
  }

  async userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map();
    const rows = await this.prisma.user.findMany({ where: { id: { in: want } }, select: { id: true, fullName: true } });
    return new Map(rows.map((u) => [u.id, u.fullName]));
  }

  /**
   * Filter on a record's `campusId`/`studentId` columns that limits it to students the user may see:
   * nothing for the whole school, the campus for a campus view, or the visible student ids otherwise.
   */
  async studentFilter(user: AuthUser, requestedCampus?: string | null): Promise<{ campusId?: string; studentId?: { in: string[] } }> {
    const where = await this.scope.studentWhere(user, requestedCampus);
    const keys = Object.keys(where);
    if (!keys.length) return {};
    if (keys.length === 1 && typeof where.campusId === 'string') return { campusId: where.campusId };
    const ids = await this.prisma.student.findMany({ where, select: { id: true } });
    return { studentId: { in: ids.map((s) => s.id) } };
  }

  /** Students by id with class and section names, for list rows. */
  async students(ids: string[]) {
    const want = [...new Set(ids)];
    if (!want.length) return new Map<string, StudentInfo>();
    const rows = await this.prisma.student.findMany({
      where: { id: { in: want } },
      select: { id: true, fullName: true, admissionNo: true, campusId: true, status: true, section: { select: { name: true, class: { select: { name: true } } } } },
    });
    const campuses = await this.campusNames();
    return new Map<string, StudentInfo>(
      rows.map((s) => [
        s.id,
        {
          id: s.id,
          fullName: s.fullName,
          admissionNo: s.admissionNo,
          campusId: s.campusId,
          campusName: campuses.get(s.campusId) ?? '',
          grade: s.section?.class?.name ?? null,
          section: s.section?.name ?? null,
          status: s.status,
        },
      ]),
    );
  }
}

export interface StudentInfo {
  id: string;
  fullName: string;
  admissionNo: string;
  campusId: string;
  campusName: string;
  grade: string | null;
  section: string | null;
  status: string;
}
