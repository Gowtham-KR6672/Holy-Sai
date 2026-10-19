import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { IsOptional, Matches } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { AppError, badRequest, conflict, notFound } from '../../common/errors';
import { AuditService } from '../audit/audit.service';
import { employeeDetail } from './employees.controller';
import { FinanceBridge } from './finance.bridge';
import { LeaveDto } from './leave.controller';
import { LeaveService } from './leave.service';
import { ClaimDto } from './overtime.controller';
import { OvertimeService } from './overtime.service';
import { PayrollService } from './payroll.service';
import { WorkforceService } from './workforce.service';
import {
  LEAVE_OPEN, OT_OPEN, addDays, dateLabel, dateOf, keyOf, minutes, mondayOf, monthLabel, num, round, sumBy, timeKey, todayKey,
} from './workforce.util';

class WeekQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use YYYY-MM-DD' }) weekStart?: string;
}

const PRESENT = ['Present', 'Late', 'Half Day'];

/** Staff self-service: my record, roster, attendance (check in/out), leave, overtime, payslips, requests and tasks. */
@Controller('me')
@RequirePermissions('selfservice.use')
export class MeController {
  constructor(
    private readonly wf: WorkforceService,
    private readonly leave: LeaveService,
    private readonly overtime: OvertimeService,
    private readonly payroll: PayrollService,
    private readonly finance: FinanceBridge,
    private readonly audit: AuditService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  /** The employee record linked to the signed-in account (User.employeeId). */
  private async me(user: AuthUser) {
    const e = user.employeeId ? await this.prisma.employee.findUnique({ where: { id: user.employeeId } }) : null;
    if (!e) throw new AppError(404, 'EMPLOYEE_NOT_LINKED', 'No employee record is linked to your account');
    return e;
  }

  @Get('employee')
  async employee(@CurrentUser() user: AuthUser) {
    const e = await this.me(user);
    const today = todayKey();
    const month = this.wf.monthWindow(today);
    const [campus, marks, balances, ot, cpd, load, shift, rosterToday, lastSlip] = await Promise.all([
      this.prisma.campus.findUnique({ where: { id: e.campusId } }),
      this.wf.dayMarks([e.id], today),
      this.wf.leaveBalances([e.id]),
      this.wf.overtimeHours([e.id], month.from, month.to),
      this.wf.cpdHours([e.id]),
      this.wf.workload([e]),
      e.shiftName ? this.prisma.workforceShift.findUnique({ where: { name: e.shiftName } }) : Promise.resolve(null),
      this.todayLine(e.id, today),
      this.prisma.workforcePayslip.findFirst({ where: { employeeId: e.id, status: 'Released' }, orderBy: { payMonth: 'desc' } }),
    ]);
    const bal = balances.get(e.id) ?? [];
    const mark = marks.get(e.id);
    const o = ot.get(e.id) ?? { hours: 0, pending: 0 };
    const activeShift = rosterToday?.shift ?? shift;
    return {
      today,
      employee: {
        ...employeeDetail(e, campus?.name ?? '', campus?.shortName ?? '', false, {
          today: mark?.status ?? 'Not marked',
          leaveBalance: round(sumBy(bal, (b) => b.balance), 1),
          leaveEntitled: round(sumBy(bal, (b) => b.entitled), 1),
          overtime: o.hours,
          cpd: cpd.get(e.id) ?? 0,
          workload: load.get(e.id)?.periods ?? e.workloadPeriods,
          userLinked: true,
        }),
        checkIn: mark?.checkIn ?? null,
        checkOut: mark?.checkOut ?? null,
      },
      shift: activeShift ? { id: activeShift.id, name: activeShift.name, startsAt: activeShift.startsAt, endsAt: activeShift.endsAt } : null,
      rosterToday: rosterToday
        ? { id: rosterToday.id, group: rosterToday.group, duty: rosterToday.duty, shiftName: rosterToday.shift.name, status: rosterToday.status }
        : null,
      overtime: { hours: o.hours, pending: o.pending },
      lastPayslip: lastSlip ? { id: lastSlip.id, monthLabel: monthLabel(keyOf(lastSlip.payMonth)), net: num(lastSlip.net) } : null,
    };
  }

  /** Today's roster line: my own post, or a post I am covering. */
  private async todayLine(employeeId: string, date: string) {
    const line =
      (await this.prisma.workforceRosterEntry.findUnique({ where: { employeeId_date: { employeeId, date: dateOf(date) } }, include: { shift: true } })) ??
      (await this.prisma.workforceRosterEntry.findFirst({ where: { coverEmployeeId: employeeId, date: dateOf(date), status: 'Covered' }, include: { shift: true } }));
    if (!line) return null;
    const i = line.post.indexOf(' · ');
    return { ...line, group: i < 0 ? line.post : line.post.slice(0, i), duty: i < 0 ? null : line.post.slice(i + 3) };
  }

  @Get('roster')
  async roster(@Query() q: WeekQuery, @CurrentUser() user: AuthUser) {
    const e = await this.me(user);
    const today = todayKey();
    const weekStart = mondayOf(q.weekStart ?? today);
    const days = Array.from({ length: 6 }, (_, i) => addDays(weekStart, i));
    const range = { gte: dateOf(days[0]), lte: dateOf(days[5]) };
    const [own, covering, marks, leave] = await Promise.all([
      this.prisma.workforceRosterEntry.findMany({ where: { employeeId: e.id, date: range }, include: { shift: true } }),
      this.prisma.workforceRosterEntry.findMany({ where: { coverEmployeeId: e.id, status: 'Covered', date: range }, include: { shift: true } }),
      this.prisma.workforceAttendance.findMany({ where: { employeeId: e.id, date: range } }),
      this.prisma.workforceLeaveRequest.findMany({ where: { employeeId: e.id, status: 'Approved', halfDay: false, fromDate: { lte: range.lte }, toDate: { gte: range.gte } } }),
    ]);
    const rostered = own.length + covering.length > 0;
    const markBy = new Map(marks.map((m) => [keyOf(m.date), m]));
    return {
      weekStart,
      defaultShift: e.shiftName,
      days: days.map((date) => {
        const mine = own.find((r) => keyOf(r.date) === date);
        const cover = covering.find((r) => keyOf(r.date) === date);
        const line = mine && mine.status !== 'Covered' && mine.status !== 'Cover needed' ? mine : cover ?? mine;
        const onLeave = leave.some((l) => keyOf(l.fromDate) <= date && keyOf(l.toDate) >= date) || markBy.get(date)?.status === 'On Leave';
        const att = markBy.get(date)?.status ?? null;
        const post = line?.post ?? null;
        const i = post ? post.indexOf(' · ') : -1;
        let rosterStatus: string | null = line ? (line === cover ? 'Covering' : line.status) : null;
        if (rosterStatus === 'Scheduled' && date < today && att && PRESENT.includes(att)) rosterStatus = 'Completed';
        return {
          date,
          shift: line?.shift.name ?? (rostered ? null : e.shiftName),
          group: post ? (i < 0 ? post : post.slice(0, i)) : null,
          duty: post ? (i < 0 ? null : post.slice(i + 3)) : null,
          onLeave,
          attendance: att,
          rosterStatus,
        };
      }),
    };
  }

  @Get('attendance')
  async attendance(@CurrentUser() user: AuthUser) {
    const e = await this.me(user);
    const to = todayKey();
    const from = addDays(to, -29);
    const [marks, leave] = await Promise.all([
      this.prisma.workforceAttendance.findMany({ where: { employeeId: e.id, date: { gte: dateOf(from), lte: dateOf(to) } }, orderBy: { date: 'desc' } }),
      this.prisma.workforceLeaveRequest.findMany({ where: { employeeId: e.id, status: 'Approved', halfDay: false, fromDate: { lte: dateOf(to) }, toDate: { gte: dateOf(from) } } }),
    ]);
    const rows = marks.map((m) => ({ date: keyOf(m.date), status: m.status, checkIn: m.checkIn, checkOut: m.checkOut, source: m.source }));
    const have = new Set(rows.map((r) => r.date));
    for (const l of leave) {
      for (let d = keyOf(l.fromDate) < from ? from : keyOf(l.fromDate); d <= keyOf(l.toDate) && d <= to; d = addDays(d, 1)) {
        if (!have.has(d) && dateOf(d).getUTCDay() !== 0) {
          rows.push({ date: d, status: 'On Leave', checkIn: null, checkOut: null, source: 'leave' });
          have.add(d);
        }
      }
    }
    rows.sort((a, b) => b.date.localeCompare(a.date));
    const n = (s: string) => rows.filter((r) => r.status === s).length;
    return { from, to, rows, summary: { present: n('Present'), late: n('Late'), halfDay: n('Half Day'), absent: n('Absent'), leave: n('On Leave') } };
  }

  @Post('attendance/check-in')
  @HttpCode(200)
  async checkIn(@CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.me(user);
    const today = todayKey();
    const mark = (await this.wf.dayMarks([e.id], today)).get(e.id);
    if (mark?.status === 'On Leave') throw badRequest('You are on leave today');
    if (mark?.checkIn) throw conflict(`You checked in at ${mark.checkIn}`);
    const now = timeKey();
    const line = await this.todayLine(e.id, today);
    const status = await this.wf.arrivalStatus(line?.shift.name ?? e.shiftName, now);
    await this.prisma.workforceAttendance.upsert({
      where: { employeeId_date: { employeeId: e.id, date: dateOf(today) } },
      create: { employeeId: e.id, campusId: e.campusId, date: dateOf(today), status, checkIn: now, source: 'app', markedById: user.id },
      update: { status, checkIn: now, source: 'app', markedById: user.id },
    });
    await this.audit.record({
      user, action: 'create', module: 'workforce', entityType: 'staff_attendance', entityId: e.id, campusId: e.campusId,
      description: `Checked in from the app at ${now} (${status})`, req,
    });
    return ok({ checkIn: now, status }, status === 'Late' ? `Checked in at ${now} — marked late` : `Checked in at ${now}`);
  }

  @Post('attendance/check-out')
  @HttpCode(200)
  async checkOut(@CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.me(user);
    const today = todayKey();
    const row = await this.prisma.workforceAttendance.findUnique({ where: { employeeId_date: { employeeId: e.id, date: dateOf(today) } } });
    if (!row?.checkIn) throw badRequest('Check in first');
    if (row.checkOut) throw conflict(`You checked out at ${row.checkOut}`);
    const now = timeKey();
    if ((minutes(now) ?? 0) < (minutes(row.checkIn) ?? 0)) throw badRequest('Check-out cannot be before check-in');
    await this.prisma.workforceAttendance.update({ where: { id: row.id }, data: { checkOut: now } });
    await this.audit.record({
      user, action: 'update', module: 'workforce', entityType: 'staff_attendance', entityId: e.id, campusId: e.campusId,
      description: `Checked out from the app at ${now}`, req,
    });
    return ok({ checkOut: now }, `Checked out at ${now}`);
  }

  // ---------------------------------------------------------------------------
  // Leave and overtime
  // ---------------------------------------------------------------------------

  @Get('leave-balances')
  async balances(@CurrentUser() user: AuthUser) {
    const e = await this.me(user);
    return (await this.wf.leaveBalances([e.id])).get(e.id) ?? [];
  }

  @Get('leave-requests')
  async leaveRequests(@CurrentUser() user: AuthUser) {
    const e = await this.me(user);
    const rows = await this.prisma.workforceLeaveRequest.findMany({ where: { employeeId: e.id }, include: { leaveType: true }, orderBy: [{ fromDate: 'desc' }, { createdAt: 'desc' }], take: 50 });
    return this.leave.rows(rows);
  }

  @Post('leave-requests')
  async applyLeave(@Body() dto: LeaveDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.me(user);
    const row = await this.leave.create(e, dto, user, 'self', req);
    return ok({ id: row.id, code: row.code }, `Leave request ${row.code} submitted — HR will review it`);
  }

  @Post('leave-requests/:id/cancel')
  @HttpCode(200)
  async cancelLeave(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.me(user);
    const r = await this.prisma.workforceLeaveRequest.findUnique({ where: { id }, include: { leaveType: true } });
    if (!r || r.employeeId !== e.id) throw notFound('Leave request');
    await this.leave.cancel(r, user, req);
    return ok({ id }, `${r.code} withdrawn`);
  }

  @Get('overtime')
  async myOvertime(@CurrentUser() user: AuthUser) {
    const e = await this.me(user);
    const rows = await this.prisma.workforceOvertime.findMany({ where: { employeeId: e.id }, orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }], take: 50 });
    return this.overtime.rows(rows);
  }

  @Post('overtime')
  async claim(@Body() dto: ClaimDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.me(user);
    const row = await this.overtime.create(e, { workDate: dto.workDate, hours: dto.hours, reason: dto.reason }, user, 'self', req);
    return ok({ id: row.id }, 'Overtime claim submitted — awaiting approval');
  }

  // ---------------------------------------------------------------------------
  // Payslips
  // ---------------------------------------------------------------------------

  @Get('payslips')
  async payslips(@CurrentUser() user: AuthUser) {
    const e = await this.me(user);
    const rows = await this.prisma.workforcePayslip.findMany({ where: { employeeId: e.id, status: 'Released' }, orderBy: { payMonth: 'desc' }, take: 24 });
    return rows.map((s) => ({
      id: s.id,
      payMonth: keyOf(s.payMonth),
      monthLabel: monthLabel(keyOf(s.payMonth)),
      gross: num(s.gross),
      deductions: num(s.totalDeductions),
      net: num(s.net),
      releasedAt: s.releasedAt?.toISOString() ?? null,
    }));
  }

  @Get('payslips/:id')
  async payslip(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.me(user);
    const slip = await this.prisma.workforcePayslip.findUnique({ where: { id }, include: { run: true } });
    if (!slip || slip.employeeId !== e.id || slip.status !== 'Released') throw notFound('Payslip');
    const view = await this.payroll.payslipView(slip);
    await this.audit.record({
      user, action: 'view', module: 'payroll', entityType: 'payslip', entityId: id, campusId: slip.campusId, sensitive: true,
      description: `Viewed own ${view.monthLabel} payslip`, req,
    });
    return view;
  }

  // ---------------------------------------------------------------------------
  // Requests and tasks
  // ---------------------------------------------------------------------------

  @Get('requests')
  async requests(@CurrentUser() user: AuthUser) {
    const e = await this.me(user);
    const [leave, ot, claims] = await Promise.all([
      this.prisma.workforceLeaveRequest.findMany({ where: { employeeId: e.id }, include: { leaveType: true }, orderBy: { updatedAt: 'desc' }, take: 10 }),
      this.prisma.workforceOvertime.findMany({ where: { employeeId: e.id }, orderBy: { updatedAt: 'desc' }, take: 10 }),
      this.finance.myReimbursements(e.id),
    ]);
    const items = [
      ...leave.map((l) => {
        const from = keyOf(l.fromDate);
        const to = keyOf(l.toDate);
        return {
          id: l.id,
          kind: 'leave',
          title: `${l.leaveType.name} ${l.code} · ${dateLabel(from)}${to !== from ? ` – ${dateLabel(to)}` : ''} (${l.days} d)`,
          status: l.status,
          at: (l.decidedAt ?? l.cancelledAt ?? l.reviewedAt ?? l.createdAt).toISOString(),
          open: LEAVE_OPEN.includes(l.status),
        };
      }),
      ...ot.map((o) => ({
        id: o.id,
        kind: 'overtime',
        title: `Overtime ${num(o.hours)} h · ${dateLabel(keyOf(o.workDate))}`,
        status: o.status,
        at: (o.paidAt ?? o.decidedAt ?? o.createdAt).toISOString(),
        open: OT_OPEN.includes(o.status),
      })),
      ...claims.map((c) => ({
        id: c.id,
        kind: 'reimbursement',
        title: `${c.claimType} claim ${c.code} · ₹${num(c.amount).toLocaleString('en-IN')}`,
        status: c.status,
        at: (c.paidAt ?? c.decidedAt ?? c.createdAt).toISOString(),
        open: ['Submitted', 'Under Review'].includes(c.status),
      })),
    ];
    return items
      .sort((a, b) => Number(b.open) - Number(a.open) || b.at.localeCompare(a.at))
      .slice(0, 10)
      .map(({ open: _open, ...r }) => r);
  }

  @Get('tasks')
  async tasks(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.task.findMany({
      where: { assigneeId: user.id, status: { not: 'Completed' } },
      orderBy: [{ dueOn: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      take: 20,
    });
    const today = dateOf(todayKey());
    return rows.map((t) => ({
      id: t.id,
      code: t.code,
      title: t.title,
      module: t.module,
      dueOn: t.dueOn ? keyOf(t.dueOn) : null,
      priority: t.priority,
      status: t.status,
      overdue: !!t.dueOn && t.dueOn < today,
      route: t.route,
    }));
  }
}
