import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { Employee, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { can, type AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { fieldError, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { AuditService } from '../audit/audit.service';
import { FinanceBridge } from './finance.bridge';
import { WorkforceService } from './workforce.service';
import {
  LEAVE_OPEN, OT_OPEN, TODAY_STATUSES, addDays, dateLabel, dateOf, isoOrNull, keyOf, keyOrNull, mondayOf, monthLabel, num, round, sortRows, sumBy,
  todayKey,
} from './workforce.util';

export const CATEGORIES = ['Leadership', 'Teachers', 'Reception & Admin', 'Security', 'Drivers & Attendants', 'Housekeeping', 'Lab Staff', 'Library Staff'];

class EmployeeQuery extends ListQuery {
  @IsOptional() @IsIn(['teaching', 'non_teaching']) employeeType?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsIn([...TODAY_STATUSES]) today?: string;
}

class SummaryQuery {
  @IsOptional() @IsString() campusId?: string;
  @IsOptional() @IsIn(['teaching', 'non_teaching']) employeeType?: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class EmployeeDto {
  @IsString() @MinLength(2, { message: 'Enter the full name' }) @MaxLength(120) fullName: string;
  @IsOptional() @IsIn(['F', 'M', 'O'], { message: 'Choose a gender' }) gender?: string | null;
  @IsOptional() @Matches(/^\+?[0-9 ]{8,16}$/, { message: 'Enter a valid phone number' }) phone?: string | null;
  @IsOptional() @IsEmail({}, { message: 'Enter a valid email' }) @MaxLength(160) email?: string | null;
  @IsUUID('all', { message: 'Choose a campus' }) campusId: string;
  @IsString() @MinLength(1, { message: 'Enter the department' }) @MaxLength(60) department: string;
  @IsString() @MinLength(1, { message: 'Enter the designation' }) @MaxLength(80) designation: string;
  @IsIn(['teaching', 'non_teaching'], { message: 'Choose teaching or non-teaching' }) employeeType: string;
  @IsIn(CATEGORIES, { message: 'Choose a staff group' }) category: string;
  @IsOptional() @IsString() @MaxLength(80) shiftName?: string | null;
  @IsOptional() @IsDateString({}, { message: 'Enter a valid date' }) joinDate?: string | null;
  @IsOptional() @IsIn(['active', 'on_notice', 'exited']) employmentStatus?: string;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Enter the monthly basic salary' }) @Min(0, { message: 'Enter the monthly basic salary' }) @Max(10_000_000) basicSalary?: number;
  @IsOptional() @Matches(/^[X0-9 ]{4,24}$/, { message: 'Masked number only, e.g. XXXXXX4417' }) bankAccountMasked?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(60) workloadPeriods?: number;
  @IsOptional() @IsBoolean() backgroundVerified?: boolean;
  @IsOptional() @IsString() @MaxLength(160) qualification?: string | null;
  @IsOptional() @IsString() @MaxLength(160) specialisation?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1, { message: 'Between 1 and 60' }) @Max(60, { message: 'Between 1 and 60' }) maxPeriodsWeek?: number;
  @IsOptional() @IsString() @MaxLength(40) licenceNoMasked?: string | null;
  @IsOptional() @IsDateString({}, { message: 'Enter a valid date' }) licenceExpiry?: string | null;
}

const clean = (v: string | null | undefined) => (v == null ? null : v.trim() || null);

/** The employee record as the profile and the edit form read it. Salary fields only for payroll.read. */
export function employeeDetail(
  e: Employee,
  campusFullName: string,
  campusName: string,
  seesPay: boolean,
  stats: { today: string; leaveBalance: number; leaveEntitled: number; overtime: number; cpd: number; workload: number; userLinked: boolean },
) {
  return {
    id: e.id,
    code: e.code,
    fullName: e.fullName,
    gender: e.gender,
    phone: e.phone,
    email: e.email,
    campusId: e.campusId,
    campusName,
    campusFullName,
    department: e.department,
    designation: e.designation,
    employeeType: e.employeeType,
    category: e.category,
    shift: e.shiftName,
    joinDate: keyOrNull(e.joinDate),
    employmentStatus: e.employmentStatus,
    ...(seesPay ? { basicSalary: num(e.basicSalary), bankAccount: e.bankAccountMasked } : {}),
    workload: stats.workload,
    maxPeriodsWeek: e.maxPeriodsWeek,
    backgroundVerified: e.backgroundVerified,
    qualification: e.qualification,
    specialisation: e.specialisation,
    licenceNoMasked: e.licenceNoMasked,
    licenceExpiry: keyOrNull(e.licenceExpiry),
    today: stats.today,
    leaveBalance: stats.leaveBalance,
    leaveEntitled: stats.leaveEntitled,
    overtime: stats.overtime,
    cpd: stats.cpd,
    userLinked: stats.userLinked,
  };
}

/** Employee master (core Employee table): directory, profile, create/edit/archive, dashboard summary. */
@Controller('workforce')
export class EmployeesController {
  constructor(
    private readonly wf: WorkforceService,
    private readonly finance: FinanceBridge,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  // ---------------------------------------------------------------------------
  // Dashboard summary
  // ---------------------------------------------------------------------------

  @Get('summary')
  @RequirePermissions('hr.read')
  async summary(@Query() q: SummaryQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.wf.campus(user, q.campusId);
    const emps = await this.prisma.employee.findMany({
      where: this.wf.employeeWhere(campusId, q.employeeType ? { employeeType: q.employeeType } : {}),
      select: { id: true, employeeType: true, category: true, department: true, employmentStatus: true, joinDate: true, workloadPeriods: true },
    });
    const ids = emps.map((e) => e.id);
    const today = todayKey();
    const month = this.wf.monthWindow(today);
    const [marks, uncoveredToday, openLeave, ot, otOpen, cpd, load, year, finance, currentRun] = await Promise.all([
      this.wf.dayMarks(ids, today),
      this.prisma.workforceRosterEntry.count({ where: { employeeId: { in: ids }, date: dateOf(today), status: 'Cover needed' } }),
      this.prisma.workforceLeaveRequest.count({ where: { employeeId: { in: ids }, status: { in: LEAVE_OPEN } } }),
      this.wf.overtimeHours(ids, month.from, month.to),
      this.prisma.workforceOvertime.count({ where: { employeeId: { in: ids }, status: { in: OT_OPEN } } }),
      this.wf.cpdHours(ids),
      this.wf.workload(emps.filter((e) => e.employeeType === 'teaching')),
      this.wf.yearWindow(),
      this.finance.pending(ids),
      this.prisma.workforcePayrollRun.findFirst({ where: campusId ? { campusId } : {}, orderBy: [{ payMonth: 'desc' }, { createdAt: 'desc' }] }),
    ]);
    const count = (s: string) => [...marks.values()].filter((m) => m.status === s).length;
    const loads = [...load.values()].map((l) => l.periods).filter((p) => p > 0);
    const otRows = [...ot.values()];
    const pendingApprovals = openLeave + otOpen + finance.allowances.count + finance.reimbursements.count;
    const cats = new Map<string, number>();
    for (const e of emps) cats.set(e.category, (cats.get(e.category) ?? 0) + 1);
    return {
      kpis: {
        total: emps.length,
        teaching: emps.filter((e) => e.employeeType === 'teaching').length,
        nonTeaching: emps.filter((e) => e.employeeType !== 'teaching').length,
        present: count('Present'),
        late: count('Late'),
        halfDay: count('Half Day'),
        absent: count('Absent'),
        leave: count('On Leave'),
        notMarked: count('Not marked'),
        uncoveredToday,
        openLeave,
        overtimeHours: round(sumBy(otRows, (r) => r.hours), 1),
        overtimePending: round(sumBy(otRows, (r) => r.pending), 1),
        payrollPending: pendingApprovals,
        cpdHours: sumBy([...cpd.values()], (h) => h),
        avgWorkload: loads.length ? round(sumBy(loads, (p) => p) / loads.length, 1) : null,
      },
      journey: {
        joinedThisYear: emps.filter((e) => e.joinDate && keyOf(e.joinDate) >= year.from && keyOf(e.joinDate) <= year.to).length,
        active: emps.filter((e) => e.employmentStatus === 'active').length,
        openLeave,
        overtimeHours: round(sumBy(otRows, (r) => r.hours), 1),
        pendingApprovals,
        currentRun: currentRun ? { id: currentRun.id, payMonth: keyOf(currentRun.payMonth), status: currentRun.status } : null,
      },
      categories: [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
      departments: [...new Set(emps.map((e) => e.department))].sort((a, b) => a.localeCompare(b)),
    };
  }

  @Get('departments')
  @RequirePermissions('hr.read')
  async departments(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.wf.campus(user, q.campusId);
    const rows = await this.prisma.employee.findMany({ where: this.wf.employeeWhere(campusId), distinct: ['department'], select: { department: true }, orderBy: { department: 'asc' } });
    return rows.map((r) => r.department);
  }

  // ---------------------------------------------------------------------------
  // Directory
  // ---------------------------------------------------------------------------

  @Get('employees')
  @RequirePermissions('hr.read')
  async list(@Query() q: EmployeeQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.wf.campus(user, q.campusId);
    const where = this.wf.employeeWhere(campusId, {
      ...(q.employeeType ? { employeeType: q.employeeType } : {}),
      ...(q.department ? { department: q.department } : {}),
      ...(q.q ? { OR: [{ fullName: like(q.q) }, { code: like(q.q) }, { designation: like(q.q) }, { department: like(q.q) }] } : {}),
    });
    const emps = await this.prisma.employee.findMany({ where, orderBy: { fullName: 'asc' } });
    const ids = emps.map((e) => e.id);
    const today = todayKey();
    const month = this.wf.monthWindow(today);
    const [marks, balances, ot, load, cpd] = await Promise.all([
      this.wf.dayMarks(ids, today),
      this.wf.leaveBalances(ids),
      this.wf.overtimeHours(ids, month.from, month.to),
      this.wf.workload(emps.filter((e) => e.employeeType === 'teaching')),
      this.wf.cpdHours(ids),
    ]);
    let rows = emps.map((e) => ({
      id: e.id,
      code: e.code,
      fullName: e.fullName,
      designation: e.designation,
      department: e.department,
      employeeType: e.employeeType,
      category: e.category,
      campusId: e.campusId,
      shift: e.shiftName,
      today: marks.get(e.id)?.status ?? 'Not marked',
      leaveBalance: round(sumBy(balances.get(e.id) ?? [], (b) => b.balance), 1),
      overtime: ot.get(e.id)?.hours ?? 0,
      workload: load.get(e.id)?.periods ?? 0,
      cpd: cpd.get(e.id) ?? 0,
    }));
    if (q.today) rows = rows.filter((r) => r.today === q.today);
    const keys: Record<string, (r: (typeof rows)[number]) => string | number | null> = {
      name: (r) => r.fullName,
      code: (r) => r.code,
      category: (r) => r.employeeType,
      department: (r) => r.department,
      shift: (r) => r.shift,
      today: (r) => r.today,
      leaveBalance: (r) => r.leaveBalance,
      overtime: (r) => r.overtime,
      workload: (r) => r.workload,
      cpd: (r) => r.cpd,
    };
    rows = sortRows(rows, keys[q.sort ?? ''] ?? keys.name, q.dir ?? 'asc');
    return paged(rows.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  @Get('employees/:id')
  @RequirePermissions('hr.read')
  async profile(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const e = await this.prisma.employee.findUnique({ where: { id } });
    if (!e) throw notFound('Employee');
    this.assertCampus(user, e);
    return this.buildProfile(e, user);
  }

  /** Full employee profile (also used for the staff member's own record). */
  async buildProfile(e: Employee, user: AuthUser) {
    const today = todayKey();
    const month = this.wf.monthWindow(today);
    const seesPay = can(user, 'payroll.read');
    const weekStart = mondayOf(today);
    const [campus, marks, monthMarks, balances, ot, cpdHours, load, leaveRequests, overtime, cpd, roster, payslips, linkedUser] = await Promise.all([
      this.prisma.campus.findUnique({ where: { id: e.campusId } }),
      this.wf.dayMarks([e.id], today),
      this.prisma.workforceAttendance.findMany({ where: { employeeId: e.id, date: { gte: dateOf(month.from), lte: dateOf(today) } } }),
      this.wf.leaveBalances([e.id]),
      this.wf.overtimeHours([e.id], month.from, month.to),
      this.wf.cpdHours([e.id]),
      this.wf.workload([e]),
      this.prisma.workforceLeaveRequest.findMany({ where: { employeeId: e.id }, include: { leaveType: true }, orderBy: { fromDate: 'desc' }, take: 20 }),
      this.prisma.workforceOvertime.findMany({ where: { employeeId: e.id }, orderBy: { workDate: 'desc' }, take: 20 }),
      this.prisma.workforceCpdRecord.findMany({ where: { employeeId: e.id }, orderBy: [{ completedOn: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }], take: 30 }),
      this.prisma.workforceRosterEntry.findMany({
        where: { employeeId: e.id, date: { gte: dateOf(weekStart), lte: dateOf(addDays(weekStart, 13)) } },
        include: { shift: true },
        orderBy: { date: 'asc' },
      }),
      seesPay
        ? this.prisma.workforcePayslip.findMany({ where: { employeeId: e.id }, include: { run: { select: { status: true } } }, orderBy: { payMonth: 'desc' }, take: 12 })
        : Promise.resolve([]),
      this.prisma.user.findFirst({ where: { employeeId: e.id }, select: { id: true } }),
    ]);
    const bal = balances.get(e.id) ?? [];
    const cnt = (s: string) => monthMarks.filter((m) => m.status === s).length;
    const leaveCount = cnt('On Leave');
    const marked = monthMarks.length;
    const credit = cnt('Present') + cnt('Late') + cnt('Half Day') * 0.5;
    const attendancePct = marked - leaveCount > 0 ? Math.round((credit / (marked - leaveCount)) * 100) : null;
    const covers = await this.wf.employeesByIds(roster.map((r) => r.coverEmployeeId));
    const balanceByType = new Map(bal.map((b) => [b.leaveTypeId, b.balance]));
    const otHours = ot.get(e.id) ?? { hours: 0, pending: 0 };
    const openLeave = leaveRequests.filter((l) => LEAVE_OPEN.includes(l.status)).length;
    const released = payslips.find((s) => s.status === 'Released');
    const latestRun = await this.prisma.workforcePayrollRun.findFirst({ where: { campusId: e.campusId }, orderBy: { payMonth: 'desc' } });

    const documents: { id: string; name: string; status: string }[] = [
      { id: 'bgv', name: 'Background verification', status: e.backgroundVerified ? 'Verified' : 'Pending' },
    ];
    if (e.licenceNoMasked || e.licenceExpiry) {
      const exp = keyOrNull(e.licenceExpiry);
      documents.push({
        id: 'licence',
        name: `Driving licence${e.licenceNoMasked ? ` ${e.licenceNoMasked}` : ''}`,
        status: !exp ? 'Pending' : exp < today ? 'Expired' : exp <= addDays(today, 30) ? 'Due Soon' : 'Active',
      });
    }
    if (seesPay) documents.push({ id: 'bank', name: 'Bank account details', status: e.bankAccountMasked ? 'Verified' : 'Pending' });

    const journey = [
      { label: 'Recruitment', meta: e.joinDate ? `Joined ${dateLabel(keyOf(e.joinDate))} ${keyOf(e.joinDate).slice(0, 4)}` : 'Join date not recorded', state: 'done' as const },
      { label: 'Employee profile', meta: e.backgroundVerified ? `${e.code} · verified` : `${e.code} · verification pending`, state: e.backgroundVerified ? ('done' as const) : ('active' as const) },
      { label: 'Attendance', meta: attendancePct != null ? `${attendancePct}% this month` : 'No marks this month', state: 'done' as const },
      { label: 'Leave', meta: openLeave ? `${openLeave} request${openLeave === 1 ? '' : 's'} open` : `${round(sumBy(bal, (b) => b.balance), 1)} days left`, state: openLeave ? ('active' as const) : ('done' as const) },
      { label: 'Overtime', meta: `${otHours.hours} h this month${otHours.pending ? ` · ${otHours.pending} h pending` : ''}`, state: otHours.pending ? ('active' as const) : ('done' as const) },
      {
        label: 'Payroll',
        meta: latestRun ? `${monthLabel(keyOf(latestRun.payMonth)).split(' ')[0]} run · ${latestRun.status}` : 'No run yet',
        state: latestRun && ['Released', 'Paid'].includes(latestRun.status) ? ('done' as const) : latestRun ? ('active' as const) : undefined,
      },
      {
        label: 'Payslip',
        meta: released ? `${monthLabel(keyOf(released.payMonth))} released` : 'None released yet',
        state: released ? ('done' as const) : undefined,
      },
    ];

    return {
      employee: employeeDetail(e, campus?.name ?? '', campus?.shortName ?? '', seesPay, {
        today: marks.get(e.id)?.status ?? 'Not marked',
        leaveBalance: round(sumBy(bal, (b) => b.balance), 1),
        leaveEntitled: round(sumBy(bal, (b) => b.entitled), 1),
        overtime: otHours.hours,
        cpd: cpdHours.get(e.id) ?? 0,
        workload: load.get(e.id)?.periods ?? e.workloadPeriods,
        userLinked: !!linkedUser,
      }),
      attendance: { pct: attendancePct, present: cnt('Present'), late: cnt('Late'), halfDay: cnt('Half Day'), absent: cnt('Absent'), leave: leaveCount, marked },
      journey,
      documents,
      leaveBalances: bal,
      leaveRequests: leaveRequests.map((l) => ({
        id: l.id,
        code: l.code,
        employeeId: l.employeeId,
        employeeName: e.fullName,
        employeeCode: e.code,
        employeeType: e.employeeType,
        designation: e.designation,
        leaveTypeId: l.leaveTypeId,
        leaveType: l.leaveType.name,
        type: l.leaveType.name,
        fromDate: keyOf(l.fromDate),
        toDate: keyOf(l.toDate),
        halfDay: l.halfDay,
        days: l.days,
        reason: l.reason,
        coverArrangement: l.coverArrangement,
        status: l.status,
        balance: balanceByType.get(l.leaveTypeId) ?? 0,
        decidedBy: l.decidedByName,
        decidedAt: isoOrNull(l.decidedAt),
        decisionNote: l.decisionNote,
        createdAt: l.createdAt.toISOString(),
      })),
      overtime: overtime.map((o) => ({
        id: o.id,
        employeeId: e.id,
        employeeName: e.fullName,
        employeeCode: e.code,
        designation: e.designation,
        department: e.department,
        workDate: keyOf(o.workDate),
        hours: num(o.hours),
        reason: o.reason,
        rate: num(o.ratePerHour),
        cost: num(o.cost),
        status: o.status,
        decidedBy: o.decidedByName,
        decisionNote: o.decisionNote,
        createdAt: o.createdAt.toISOString(),
      })),
      cpd: cpd.map((c) => ({ id: c.id, programme: c.programme, provider: c.provider, hours: c.hours, completedOn: keyOrNull(c.completedOn), status: c.status, isMandatory: c.isMandatory })),
      roster: roster.map((r) => {
        const date = keyOf(r.date);
        return {
          id: r.id,
          date,
          post: r.post,
          shift: r.shift.name,
          status: r.status === 'Scheduled' && date < today ? 'Completed' : r.status,
          coveredBy: r.coverEmployeeId ? covers.get(r.coverEmployeeId)?.fullName ?? null : null,
        };
      }),
      payslips: payslips.map((s) => ({
        id: s.id,
        runId: s.runId,
        payMonth: keyOf(s.payMonth),
        monthLabel: monthLabel(keyOf(s.payMonth)),
        gross: num(s.gross),
        net: num(s.net),
        status: s.status,
      })),
    };
  }

  private assertCampus(user: AuthUser, e: Pick<Employee, 'campusId'>) {
    const campusId = this.wf.campus(user, null);
    if (campusId && e.campusId !== campusId && !can(user, 'dashboard.group')) throw notFound('Employee');
  }

  // ---------------------------------------------------------------------------
  // Create / edit / archive
  // ---------------------------------------------------------------------------

  @Post('employees')
  @RequirePermissions('hr.manage')
  async create(@Body() dto: EmployeeDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.validate(dto, null);
    if (dto.basicSalary === undefined || dto.basicSalary === null) throw fieldError('basicSalary', 'Enter the monthly basic salary');
    const code = await this.nextCode();
    const data = this.data(dto, true);
    const exited = dto.employmentStatus === 'exited';
    const e = await this.prisma.employee.create({
      data: {
        ...(data as Prisma.EmployeeUncheckedCreateInput),
        code,
        basicSalary: dto.basicSalary,
        bankAccountMasked: clean(dto.bankAccountMasked),
        archivedAt: exited ? new Date() : null,
      },
    });
    const linked = await this.linkUser(e);
    await this.audit.record({
      user, action: 'create', module: 'workforce', entityType: 'employee', entityId: e.id, campusId: e.campusId,
      description: `Created employee ${e.code} ${e.fullName} (${e.designation})${linked ? `; linked to the account ${linked}` : ''}`, req,
    });
    return ok({ id: e.id, code: e.code }, `Employee ${e.code} created`);
  }

  @Put('employees/:id')
  @RequirePermissions('hr.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EmployeeDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const existing = await this.prisma.employee.findUnique({ where: { id } });
    if (!existing) throw notFound('Employee');
    this.assertCampus(user, existing);
    await this.validate(dto, existing);
    const data = this.data(dto, false) as Prisma.EmployeeUncheckedUpdateInput;
    const salaryChanged: string[] = [];
    if (can(user, 'payroll.read', 'payroll.manage')) {
      if (dto.basicSalary !== undefined && dto.basicSalary !== null && num(existing.basicSalary) !== dto.basicSalary) {
        data.basicSalary = dto.basicSalary;
        salaryChanged.push('basic salary');
      }
      if (dto.bankAccountMasked !== undefined && clean(dto.bankAccountMasked) !== existing.bankAccountMasked) {
        data.bankAccountMasked = clean(dto.bankAccountMasked);
        salaryChanged.push('bank account');
      }
    }
    const status = dto.employmentStatus ?? existing.employmentStatus;
    if (status === 'exited' && !existing.archivedAt) data.archivedAt = new Date();
    if (status !== 'exited' && existing.archivedAt) data.archivedAt = null;

    const changed = (Object.keys(data) as (keyof Employee)[]).filter((k) => {
      if (k === 'archivedAt' || k === 'basicSalary' || k === 'bankAccountMasked') return false;
      const before = existing[k];
      const after = (data as Record<string, unknown>)[k];
      const b = before instanceof Date ? keyOf(before) : before;
      const a = after instanceof Date ? keyOf(after) : after;
      return (b ?? null) !== (a ?? null);
    });
    const e = await this.prisma.employee.update({ where: { id }, data });
    if (status === 'exited' && !existing.archivedAt) await this.clearFutureRoster(e.id);
    const linked = await this.linkUser(e);
    await this.audit.record({
      user, action: 'update', module: 'workforce', entityType: 'employee', entityId: e.id, campusId: e.campusId,
      description: `Updated ${e.code} ${e.fullName}${changed.length || salaryChanged.length ? `: ${[...changed, ...salaryChanged].join(', ')}` : ''}${linked ? `; linked to the account ${linked}` : ''}`,
      metadata: { changed, salaryChanged },
      req,
    });
    return ok({ id: e.id, code: e.code }, 'Employee updated');
  }

  /** Archive: the employee is marked exited, removed from future rosters and hidden from lists. Payroll history is kept. */
  @Delete('employees/:id')
  @RequirePermissions('hr.manage')
  async archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.prisma.employee.findUnique({ where: { id } });
    if (!e) throw notFound('Employee');
    this.assertCampus(user, e);
    if (e.archivedAt) return ok({ id }, `${e.fullName} is already archived`);
    await this.prisma.employee.update({ where: { id }, data: { employmentStatus: 'exited', archivedAt: new Date() } });
    const removed = await this.clearFutureRoster(id);
    await this.audit.record({
      user, action: 'delete', module: 'workforce', entityType: 'employee', entityId: id, campusId: e.campusId,
      description: `Archived ${e.code} ${e.fullName} (exited)${removed ? `; removed from ${removed} future roster line${removed === 1 ? '' : 's'}` : ''}`, req,
    });
    return ok({ id }, 'Employee archived');
  }

  private async clearFutureRoster(employeeId: string) {
    const today = dateOf(todayKey());
    const r = await this.prisma.workforceRosterEntry.deleteMany({ where: { employeeId, date: { gte: today } } });
    await this.prisma.workforceRosterEntry.updateMany({
      where: { coverEmployeeId: employeeId, date: { gte: today } },
      data: { coverEmployeeId: null, status: 'Cover needed', coverReason: 'Cover colleague has left' },
    });
    return r.count;
  }

  private async validate(dto: EmployeeDto, existing: Employee | null) {
    const campus = await this.prisma.campus.findUnique({ where: { id: dto.campusId } });
    if (!campus) throw fieldError('campusId', 'Choose a campus');
    if (dto.shiftName) {
      const s = await this.prisma.workforceShift.findUnique({ where: { name: dto.shiftName } });
      if (!s) throw fieldError('shiftName', 'Choose a shift from the list');
    }
    const email = clean(dto.email)?.toLowerCase();
    if (email) {
      const dup = await this.prisma.employee.findFirst({
        where: { email: { equals: email, mode: 'insensitive' }, archivedAt: null, ...(existing ? { NOT: { id: existing.id } } : {}) },
        select: { code: true, fullName: true },
      });
      if (dup) throw fieldError('email', `${dup.fullName} (${dup.code}) already uses this email`);
    }
    if (dto.joinDate && dto.joinDate.slice(0, 10) > addDays(todayKey(), 366)) throw fieldError('joinDate', 'Join date is too far in the future');
  }

  private data(dto: EmployeeDto, creating: boolean) {
    const teaching = dto.employeeType === 'teaching';
    const out: Record<string, unknown> = {
      fullName: dto.fullName.trim(),
      gender: dto.gender || null,
      phone: clean(dto.phone),
      email: clean(dto.email)?.toLowerCase() ?? null,
      campusId: dto.campusId,
      department: dto.department.trim(),
      designation: dto.designation.trim(),
      employeeType: dto.employeeType,
      category: dto.category,
      shiftName: clean(dto.shiftName),
      joinDate: dto.joinDate ? dateOf(dto.joinDate) : null,
      employmentStatus: dto.employmentStatus ?? 'active',
      ...(dto.workloadPeriods !== undefined ? { workloadPeriods: dto.workloadPeriods } : {}),
      ...(dto.backgroundVerified !== undefined ? { backgroundVerified: dto.backgroundVerified } : {}),
    };
    if (teaching) {
      Object.assign(out, {
        ...(dto.qualification !== undefined ? { qualification: clean(dto.qualification) } : {}),
        ...(dto.specialisation !== undefined ? { specialisation: clean(dto.specialisation) } : {}),
        ...(dto.maxPeriodsWeek !== undefined ? { maxPeriodsWeek: dto.maxPeriodsWeek } : creating ? { maxPeriodsWeek: 27 } : {}),
      });
    } else {
      Object.assign(out, {
        ...(dto.licenceNoMasked !== undefined ? { licenceNoMasked: clean(dto.licenceNoMasked) } : {}),
        ...(dto.licenceExpiry !== undefined ? { licenceExpiry: dto.licenceExpiry ? dateOf(dto.licenceExpiry) : null } : {}),
      });
    }
    return out;
  }

  private async nextCode() {
    for (let i = 0; i < 50; i++) {
      const code = await this.counters.reference('EMP', 'employees', 4, 1001);
      if (!(await this.prisma.employee.findUnique({ where: { code }, select: { id: true } }))) return code;
    }
    throw fieldError('fullName', 'Could not allocate an employee code. Try again.');
  }

  /** Links the user account with the same email (if unlinked) so the person can use staff self-service. */
  private async linkUser(e: Employee): Promise<string | null> {
    if (!e.email || e.archivedAt) return null;
    const already = await this.prisma.user.findFirst({ where: { employeeId: e.id }, select: { id: true } });
    if (already) return null;
    const u = await this.prisma.user.findFirst({ where: { email: e.email.toLowerCase(), employeeId: null, studentId: null, parentId: null }, select: { id: true, email: true } });
    if (!u) return null;
    await this.prisma.user.update({ where: { id: u.id }, data: { employeeId: e.id } });
    return u.email;
  }
}

