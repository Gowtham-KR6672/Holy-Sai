import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Employee, Prisma, WorkforceLeaveType } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { PerWorkspace } from '../../tenancy/context';
import { WorkspaceSeeds } from '../../tenancy/workspace-seeds.service';
import { NotificationsService, type TaskInput } from '../notifications/notifications.service';
import { SearchService } from '../search/search.service';
import { SettingsService } from '../settings/settings.service';
import {
  CPD_TARGET, LEAVE_OPEN, addDays, dateOf, groupBy, isSunday, keyOf, minutes, monthEndKey, monthStartKey, round, todayKey, workingDays,
} from './workforce.util';

/** Leave types the school starts with (the UI has no screen to create them). */
const DEFAULT_LEAVE_TYPES = [
  { code: 'CL', name: 'Casual leave', entitlementDays: 12, isPaid: true, sortOrder: 1 },
  { code: 'SL', name: 'Sick leave', entitlementDays: 12, isPaid: true, sortOrder: 2 },
  { code: 'EL', name: 'Earned leave', entitlementDays: 15, isPaid: true, sortOrder: 3 },
  { code: 'CO', name: 'Compensatory off', entitlementDays: 6, isPaid: true, sortOrder: 4 },
];

export interface DayMark {
  status: string;
  checkIn: string | null;
  checkOut: string | null;
  source: string | null;
}

export interface LeaveBalanceView {
  leaveTypeId: string;
  code: string;
  type: string;
  entitled: number;
  used: number;
  pending: number;
  balance: number;
}

export interface LoadView {
  sections: number;
  assigned: number;
  timetabled: number;
  recorded: number;
  periods: number;
}

/** Shared workforce lookups and computations (status today, balances, hours, load). */
@Injectable()
export class WorkforceService implements OnModuleInit {
  private readonly log = new Logger(WorkforceService.name);
  private readonly leaveTypeCache = new PerWorkspace<{ at: number; rows: WorkforceLeaveType[] } | null>(() => null);

  constructor(
    readonly prisma: PrismaService,
    readonly scope: ScopeService,
    readonly settings: SettingsService,
    readonly notifications: NotificationsService,
    private readonly search: SearchService,
    private readonly seeds: WorkspaceSeeds,
  ) {}

  onModuleInit() {
    // Ctrl K: leave references (LV-123).
    this.search.register(async (user, q) => {
      if (!user.permissions.has('hr.read') || !/^lv-?\d+$/i.test(q.trim())) return [];
      const code = `LV-${q.trim().replace(/^lv-?/i, '')}`;
      const rows = await this.prisma.workforceLeaveRequest.findMany({ where: { code: { startsWith: code } }, include: { leaveType: true }, take: 5 });
      const emps = await this.employeesByIds(rows.map((r) => r.employeeId));
      return rows.map((r) => ({
        group: 'Leave',
        label: `${r.code} · ${emps.get(r.employeeId)?.fullName ?? 'Employee'}`,
        meta: `${r.leaveType.name} · ${keyOf(r.fromDate)} · ${r.status}`,
        icon: 'calendar',
        route: `/leave?q=${encodeURIComponent(r.code)}`,
      }));
    });
    this.seeds.register('workforce leave types', () => this.seedLeaveTypes());
  }

  /** Adds the standard leave types a school is missing (every school, at start-up and when it is created). */
  private async seedLeaveTypes() {
    const existing = await this.prisma.workforceLeaveType.findMany({ select: { code: true } });
    const have = new Set(existing.map((t) => t.code));
    const missing = DEFAULT_LEAVE_TYPES.filter((t) => !have.has(t.code));
    if (missing.length) {
      await this.prisma.workforceLeaveType.createMany({ data: missing, skipDuplicates: true });
      this.log.log(`Seeded ${missing.length} leave type(s)`);
    }
  }

  // ---------------------------------------------------------------------------
  // Scope
  // ---------------------------------------------------------------------------

  campus(user: AuthUser, requested?: string | null) {
    return this.scope.campus(user, requested);
  }

  /** Employees on the books (not archived), optionally on one campus. */
  employeeWhere(campusId?: string, extra: Prisma.EmployeeWhereInput = {}): Prisma.EmployeeWhereInput {
    return { archivedAt: null, employmentStatus: { not: 'exited' }, ...(campusId ? { campusId } : {}), ...extra };
  }

  async employeeOr404(id: string) {
    const e = await this.prisma.employee.findUnique({ where: { id } });
    return e;
  }

  /** The leave/CPD year: the current academic year, else the calendar year containing today. */
  async yearWindow(): Promise<{ from: string; to: string }> {
    const y = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    if (y) return { from: keyOf(y.startsOn), to: keyOf(y.endsOn) };
    const t = todayKey();
    return { from: `${t.slice(0, 4)}-01-01`, to: `${t.slice(0, 4)}-12-31` };
  }

  monthWindow(key = todayKey()) {
    return { from: monthStartKey(key), to: monthEndKey(key) };
  }

  // ---------------------------------------------------------------------------
  // Attendance status
  // ---------------------------------------------------------------------------

  /** Each employee's status for one day: the mark, else approved leave, else "Not marked". */
  async dayMarks(employeeIds: string[], date: string): Promise<Map<string, DayMark>> {
    const out = new Map<string, DayMark>();
    if (!employeeIds.length) return out;
    const d = dateOf(date);
    const [marks, leave] = await Promise.all([
      this.prisma.workforceAttendance.findMany({ where: { employeeId: { in: employeeIds }, date: d } }),
      this.prisma.workforceLeaveRequest.findMany({
        where: { employeeId: { in: employeeIds }, status: 'Approved', halfDay: false, fromDate: { lte: d }, toDate: { gte: d } },
        select: { employeeId: true },
      }),
    ]);
    const onLeave = new Set(leave.map((l) => l.employeeId));
    const byEmp = new Map(marks.map((m) => [m.employeeId, m]));
    for (const id of employeeIds) {
      const m = byEmp.get(id);
      if (m) out.set(id, { status: m.status, checkIn: m.checkIn, checkOut: m.checkOut, source: m.source });
      else out.set(id, { status: onLeave.has(id) && !isSunday(date) ? 'On Leave' : 'Not marked', checkIn: null, checkOut: null, source: onLeave.has(id) ? 'leave' : null });
    }
    return out;
  }

  /** Present or Late for a check-in time, from the shift start (or the default start) plus grace. */
  async arrivalStatus(shiftName: string | null, checkIn: string): Promise<'Present' | 'Late'> {
    const grace = Number(await this.settings.get('workforce.late_grace_minutes', 10)) || 0;
    let start: string | null = null;
    if (shiftName) {
      const s = await this.prisma.workforceShift.findUnique({ where: { name: shiftName } });
      start = s?.startsAt ?? null;
    }
    if (!start) start = String(await this.settings.get('workforce.default_start_time', '08:30'));
    const a = minutes(checkIn);
    const b = minutes(start);
    if (a == null || b == null) return 'Present';
    return a > b + grace ? 'Late' : 'Present';
  }

  // ---------------------------------------------------------------------------
  // Leave
  // ---------------------------------------------------------------------------

  async leaveTypes(): Promise<WorkforceLeaveType[]> {
    const hit = this.leaveTypeCache.get();
    if (hit && Date.now() - hit.at < 60_000) return hit.rows;
    const rows = await this.prisma.workforceLeaveType.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    this.leaveTypeCache.set({ at: Date.now(), rows });
    return rows;
  }

  /** Leave balances per employee for the leave year: entitled − approved days (pending shown separately). */
  async leaveBalances(employeeIds: string[]): Promise<Map<string, LeaveBalanceView[]>> {
    const out = new Map<string, LeaveBalanceView[]>();
    if (!employeeIds.length) return out;
    const [types, win] = await Promise.all([this.leaveTypes(), this.yearWindow()]);
    const rows = await this.prisma.workforceLeaveRequest.groupBy({
      by: ['employeeId', 'leaveTypeId', 'status'],
      where: {
        employeeId: { in: employeeIds },
        status: { in: ['Approved', ...LEAVE_OPEN] },
        fromDate: { gte: dateOf(win.from), lte: dateOf(win.to) },
      },
      _sum: { days: true },
    });
    const used = new Map<string, number>();
    const pending = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.employeeId}:${r.leaveTypeId}`;
      const target = r.status === 'Approved' ? used : pending;
      target.set(k, (target.get(k) ?? 0) + (r._sum.days ?? 0));
    }
    for (const id of employeeIds) {
      out.set(
        id,
        types.map((t) => {
          const u = used.get(`${id}:${t.id}`) ?? 0;
          return {
            leaveTypeId: t.id,
            code: t.code,
            type: t.name,
            entitled: t.entitlementDays,
            used: round(u, 1),
            pending: round(pending.get(`${id}:${t.id}`) ?? 0, 1),
            balance: round(Math.max(0, t.entitlementDays - u), 1),
          };
        }),
      );
    }
    return out;
  }

  /** Working days a leave request takes: Sundays excluded, 0.5 for a half day. */
  leaveDays(from: string, to: string, halfDay: boolean) {
    if (halfDay) return isSunday(from) ? 0 : 0.5;
    return workingDays(from, to).length;
  }

  // ---------------------------------------------------------------------------
  // Overtime, CPD, workload
  // ---------------------------------------------------------------------------

  /** Overtime hours per employee in a date range: all claims except rejected; pending = awaiting a decision. */
  async overtimeHours(employeeIds: string[], from: string, to: string): Promise<Map<string, { hours: number; pending: number }>> {
    const out = new Map<string, { hours: number; pending: number }>();
    if (!employeeIds.length) return out;
    const rows = await this.prisma.workforceOvertime.groupBy({
      by: ['employeeId', 'status'],
      where: { employeeId: { in: employeeIds }, workDate: { gte: dateOf(from), lte: dateOf(to) }, status: { not: 'Rejected' } },
      _sum: { hours: true },
    });
    for (const r of rows) {
      const cur = out.get(r.employeeId) ?? { hours: 0, pending: 0 };
      const h = Number(r._sum.hours ?? 0);
      cur.hours = round(cur.hours + h, 1);
      if (r.status === 'Submitted' || r.status === 'Under Review') cur.pending = round(cur.pending + h, 1);
      out.set(r.employeeId, cur);
    }
    return out;
  }

  /** Completed CPD hours per employee within the leave/CPD year. */
  async cpdHours(employeeIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!employeeIds.length) return out;
    const win = await this.yearWindow();
    const rows = await this.prisma.workforceCpdRecord.groupBy({
      by: ['employeeId'],
      where: { employeeId: { in: employeeIds }, status: 'Completed', completedOn: { gte: dateOf(win.from), lte: dateOf(win.to) } },
      _sum: { hours: true },
    });
    for (const r of rows) out.set(r.employeeId, r._sum.hours ?? 0);
    return out;
  }

  cpdTarget(employeeType: string) {
    return employeeType === 'teaching' ? CPD_TARGET.teaching : CPD_TARGET.non_teaching;
  }

  /**
   * Teaching load per employee: periods = the highest of timetabled periods (academics timetable),
   * section/subject assignments and the recorded load on the employee record (which includes duties).
   */
  async workload(employees: Pick<Employee, 'id' | 'workloadPeriods'>[]): Promise<Map<string, LoadView>> {
    const out = new Map<string, LoadView>();
    if (!employees.length) return out;
    const ids = employees.map((e) => e.id);
    let entries: { employeeId: string | null; sectionId: string; subjectId: string | null }[] = [];
    try {
      entries = await this.prisma.timetableEntry.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, sectionId: true, subjectId: true } });
    } catch {
      entries = []; // academics tables not migrated yet
    }
    const classTeacher = await this.prisma.section.findMany({ where: { classTeacherId: { in: ids } }, select: { id: true, classTeacherId: true } });
    const byEmp = groupBy(entries, (e) => e.employeeId as string);
    const ctBy = groupBy(classTeacher, (s) => s.classTeacherId as string);
    for (const e of employees) {
      const tt = byEmp.get(e.id) ?? [];
      const sections = new Set([...tt.map((x) => x.sectionId), ...(ctBy.get(e.id) ?? []).map((s) => s.id)]);
      const assigned = new Set(tt.filter((x) => x.subjectId).map((x) => `${x.sectionId}:${x.subjectId}`)).size;
      const timetabled = tt.length;
      const recorded = e.workloadPeriods ?? 0;
      out.set(e.id, { sections: sections.size, assigned, timetabled, recorded, periods: Math.max(timetabled, recorded, assigned) });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // People
  // ---------------------------------------------------------------------------

  /** Active user accounts linked to employees (User.employeeId). */
  async usersFor(employeeIds: (string | null | undefined)[]): Promise<Map<string, string>> {
    const ids = [...new Set(employeeIds.filter((x): x is string => !!x))];
    if (!ids.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { employeeId: { in: ids }, status: 'active' }, select: { id: true, employeeId: true } });
    return new Map(users.map((u) => [u.employeeId as string, u.id]));
  }

  async notifyEmployees(employeeIds: string[], input: Parameters<NotificationsService['notifyUsers']>[1]) {
    const users = await this.usersFor(employeeIds);
    if (users.size) await this.notifications.notifyUsers([...users.values()], input);
  }

  /** Review tasks for everyone holding a permission (on the campus or group-wide), except the people involved. */
  async approverTasks(permission: string, input: Omit<TaskInput, 'assigneeId'>, campusId: string | null, exclude: (string | null | undefined)[] = []) {
    const skip = new Set(exclude.filter(Boolean) as string[]);
    const users = await this.prisma.user.findMany({
      where: {
        status: 'active',
        role: { permissions: { some: { permissionKey: permission } }, key: { notIn: ['parent', 'student'] } },
        ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}),
      },
      select: { id: true },
    });
    for (const u of users) {
      if (skip.has(u.id)) continue;
      await this.notifications.createTask({ ...input, assigneeId: u.id });
    }
  }

  async campusNames(ids: string[]): Promise<Map<string, { name: string; shortName: string; address: string | null }>> {
    const rows = await this.prisma.campus.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, shortName: true, address: true, place: true } });
    return new Map(rows.map((c) => [c.id, { name: c.name, shortName: c.shortName, address: c.address ?? c.place }]));
  }

  async employeesByIds(ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map<string, Employee>();
    const rows = await this.prisma.employee.findMany({ where: { id: { in: list } } });
    return new Map(rows.map((e) => [e.id, e]));
  }

  /** Default overtime rate: twice the hourly basic (basic ÷ 26 days ÷ 8 hours). */
  async defaultOvertimeRate(basic: number) {
    const factor = Number(await this.settings.get('workforce.overtime_multiplier', 2)) || 2;
    return round((basic / 208) * factor, 2);
  }

  /** Dates of the last n days ending at a date (inclusive), oldest first. */
  lastDays(end: string, n: number) {
    return Array.from({ length: n }, (_, i) => addDays(end, i - n + 1));
  }
}
