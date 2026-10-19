import { Injectable } from '@nestjs/common';
import type { Employee, WorkforceLeaveRequest, WorkforceLeaveType } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { AuditService } from '../audit/audit.service';
import { WorkforceService } from './workforce.service';
import { LEAVE_OPEN, addDays, dateLabel, dateOf, isoOrNull, keyOf, round, todayKey, workingDays } from './workforce.util';

export interface LeaveInput {
  leaveTypeId: string;
  fromDate: string;
  toDate: string;
  halfDay?: boolean;
  reason: string;
  coverArrangement?: string | null;
}

type RequestWithType = WorkforceLeaveRequest & { leaveType: WorkforceLeaveType };

/** Leave requests: apply, review, approve/reject (with balance check, attendance and roster effects), cancel. */
@Injectable()
export class LeaveService {
  constructor(
    private readonly wf: WorkforceService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  /** Rows as the leave screens read them, with the employee and the remaining balance of the type. */
  async rows(requests: RequestWithType[]) {
    const emps = await this.wf.employeesByIds(requests.map((r) => r.employeeId));
    const balances = await this.wf.leaveBalances([...emps.keys()]);
    return requests.map((r) => {
      const e = emps.get(r.employeeId);
      const bal = balances.get(r.employeeId)?.find((b) => b.leaveTypeId === r.leaveTypeId);
      return {
        id: r.id,
        code: r.code,
        employeeId: r.employeeId,
        employeeName: e?.fullName ?? 'Former employee',
        employeeCode: e?.code ?? '',
        employeeType: e?.employeeType ?? 'non_teaching',
        designation: e?.designation ?? '',
        leaveTypeId: r.leaveTypeId,
        leaveType: r.leaveType.name,
        type: r.leaveType.name,
        fromDate: keyOf(r.fromDate),
        toDate: keyOf(r.toDate),
        halfDay: r.halfDay,
        days: r.days,
        reason: r.reason,
        coverArrangement: r.coverArrangement,
        status: r.status,
        balance: bal?.balance ?? 0,
        decidedBy: r.decidedByName,
        decidedAt: isoOrNull(r.decidedAt),
        decisionNote: r.decisionNote,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  async create(emp: Employee, input: LeaveInput, user: AuthUser, via: 'self' | 'hr', req: Request) {
    if (emp.archivedAt || emp.employmentStatus === 'exited') throw fieldError('employeeId', 'This employee has left');
    const type = await this.prisma.workforceLeaveType.findUnique({ where: { id: input.leaveTypeId } });
    if (!type || !type.isActive) throw fieldError('leaveTypeId', 'Choose a leave type');
    const from = input.fromDate.slice(0, 10);
    const to = input.toDate.slice(0, 10);
    const halfDay = !!input.halfDay;
    if (to < from) throw fieldError('toDate', 'End date must be on or after the start date');
    if (halfDay && from !== to) throw fieldError('halfDay', 'A half day starts and ends on the same date');
    if (workingDays(from, to).length > 60) throw fieldError('toDate', 'One request can cover at most 60 working days');
    if (via === 'self' && from < addDays(todayKey(), -60)) throw fieldError('fromDate', 'Leave older than 60 days must be recorded by HR');
    const days = this.wf.leaveDays(from, to, halfDay);
    if (!days) throw fieldError('fromDate', 'These dates fall on Sundays — choose working days');
    const reason = input.reason.trim();
    if (reason.length < 3) throw fieldError('reason', 'Give a short reason');
    const overlap = await this.prisma.workforceLeaveRequest.findFirst({
      where: { employeeId: emp.id, status: { in: [...LEAVE_OPEN, 'Approved'] }, fromDate: { lte: dateOf(to) }, toDate: { gte: dateOf(from) } },
      select: { code: true, status: true },
    });
    if (overlap) throw fieldError('fromDate', `These dates overlap ${overlap.code} (${overlap.status.toLowerCase()})`);

    const code = await this.counters.reference('LV', 'leave-requests', 0, 101);
    const row = await this.prisma.workforceLeaveRequest.create({
      data: {
        code,
        employeeId: emp.id,
        campusId: emp.campusId,
        leaveTypeId: type.id,
        fromDate: dateOf(from),
        toDate: dateOf(to),
        halfDay,
        days,
        reason,
        coverArrangement: input.coverArrangement?.trim() || null,
        status: 'Submitted',
        appliedVia: via,
        appliedById: user.id,
      },
    });
    const self = await this.wf.usersFor([emp.id]);
    await this.wf.approverTasks(
      'hr.approve',
      {
        title: `Approve leave ${code}: ${emp.fullName}, ${type.name} (${days} d from ${dateLabel(from)})`,
        module: 'workforce',
        status: 'Under Review',
        priority: from <= addDays(todayKey(), 2) ? 'High' : 'Medium',
        dueOn: from < todayKey() ? todayKey() : from,
        route: '/leave?status=open',
        entityType: 'leave_request',
        entityId: row.id,
      },
      emp.campusId,
      [self.get(emp.id), via === 'self' ? user.id : null],
    );
    await this.audit.record({
      user, action: 'create', module: 'workforce', entityType: 'leave_request', entityId: row.id, campusId: emp.campusId,
      description: `${via === 'self' ? 'Applied for' : `Recorded for ${emp.fullName}:`} ${type.name} ${code}, ${from}${to !== from ? ` to ${to}` : ''} (${days} d)`, req,
    });
    return row;
  }

  async find(id: string, user: AuthUser) {
    const r = await this.prisma.workforceLeaveRequest.findUnique({ where: { id }, include: { leaveType: true } });
    if (!r) throw notFound('Leave request');
    const campusId = this.wf.campus(user, null);
    if (campusId && r.campusId !== campusId && !user.permissions.has('dashboard.group') && r.employeeId !== user.employeeId) throw notFound('Leave request');
    return r;
  }

  async review(r: RequestWithType, user: AuthUser, req: Request) {
    if (r.status !== 'Submitted') throw badRequest(`${r.code} is ${r.status.toLowerCase()}`);
    this.notOwn(r, user);
    await this.prisma.workforceLeaveRequest.update({ where: { id: r.id }, data: { status: 'Under Review', reviewedById: user.id, reviewedAt: new Date() } });
    await this.wf.notifyEmployees([r.employeeId], {
      category: 'Information', topic: 'system', module: 'workforce', title: `${r.code} is under review`,
      body: `${r.leaveType.name}, ${dateLabel(keyOf(r.fromDate))}${r.days > 1 ? ` – ${dateLabel(keyOf(r.toDate))}` : ''}.`, route: '/staff-self',
    });
    await this.audit.record({ user, action: 'update', module: 'workforce', entityType: 'leave_request', entityId: r.id, campusId: r.campusId, description: `Started review of ${r.code}`, req });
  }

  /** Approves: checks the balance, marks attendance On Leave, flags roster lines for cover, notifies the employee. */
  async approve(r: RequestWithType, note: string | undefined, user: AuthUser, req: Request) {
    if (!LEAVE_OPEN.includes(r.status)) throw badRequest(`${r.code} is already ${r.status.toLowerCase()}`);
    this.notOwn(r, user);
    const bal = (await this.wf.leaveBalances([r.employeeId])).get(r.employeeId)?.find((b) => b.leaveTypeId === r.leaveTypeId);
    const balance = bal?.balance ?? 0;
    if (balance < r.days) throw badRequest(`Only ${balance} day${balance === 1 ? '' : 's'} of ${r.leaveType.name.toLowerCase()} left — approval refused`);
    const from = keyOf(r.fromDate);
    const to = keyOf(r.toDate);
    await this.prisma.workforceLeaveRequest.update({
      where: { id: r.id },
      data: { status: 'Approved', decidedById: user.id, decidedByName: user.fullName, decidedAt: new Date(), decisionNote: note?.trim() || null },
    });
    if (!r.halfDay) {
      for (const d of workingDays(from, to)) {
        await this.prisma.workforceAttendance.upsert({
          where: { employeeId_date: { employeeId: r.employeeId, date: dateOf(d) } },
          create: { employeeId: r.employeeId, campusId: r.campusId, date: dateOf(d), status: 'On Leave', source: 'leave', markedById: user.id, note: r.code },
          update: { status: 'On Leave', source: 'leave', checkIn: null, checkOut: null, markedById: user.id, note: r.code },
        });
      }
    }
    const today = todayKey();
    const flagged = r.halfDay
      ? { count: 0 }
      : await this.prisma.workforceRosterEntry.updateMany({
          where: { employeeId: r.employeeId, date: { gte: dateOf(from > today ? from : today), lte: dateOf(to) }, status: 'Scheduled' },
          data: { status: 'Cover needed', coverReason: `On leave (${r.code})`, coverFlaggedAt: new Date() },
        });
    await this.wf.notifications.completeTasksFor('leave_request', r.id);
    const emp = await this.prisma.employee.findUnique({ where: { id: r.employeeId }, select: { fullName: true } });
    await this.wf.notifyEmployees([r.employeeId], {
      category: 'Completed', topic: 'system', module: 'workforce', title: `${r.code} approved`,
      body: `${r.leaveType.name}: ${dateLabel(from)}${to !== from ? ` – ${dateLabel(to)}` : ''} (${r.days} d).${note?.trim() ? ` ${note.trim()}` : ''}`,
      route: '/staff-self', deliver: true,
    });
    if (flagged.count) {
      await this.wf.notifications.notifyPermission('hr.manage', {
        category: 'Attention', topic: 'system', module: 'workforce', campusId: r.campusId,
        title: `Cover needed: ${flagged.count} roster line${flagged.count === 1 ? '' : 's'}`,
        body: `${emp?.fullName ?? 'A colleague'} is on approved leave (${r.code}).`, route: '/shifts',
      });
    }
    await this.audit.record({
      user, action: 'approve', module: 'workforce', entityType: 'leave_request', entityId: r.id, campusId: r.campusId,
      description: `Approved ${r.code} for ${emp?.fullName ?? ''} (${r.leaveType.name}, ${r.days} d)${flagged.count ? `; ${flagged.count} roster line(s) flagged for cover` : ''}`, req,
    });
    return { flagged: flagged.count };
  }

  async reject(r: RequestWithType, note: string, user: AuthUser, req: Request) {
    if (!LEAVE_OPEN.includes(r.status)) throw badRequest(`${r.code} is already ${r.status.toLowerCase()}`);
    this.notOwn(r, user);
    const reason = note.trim();
    if (reason.length < 3) throw fieldError('note', 'Give the employee a reason');
    await this.prisma.workforceLeaveRequest.update({
      where: { id: r.id },
      data: { status: 'Rejected', decidedById: user.id, decidedByName: user.fullName, decidedAt: new Date(), decisionNote: reason },
    });
    await this.wf.notifications.completeTasksFor('leave_request', r.id);
    await this.wf.notifyEmployees([r.employeeId], {
      category: 'Attention', topic: 'system', module: 'workforce', title: `${r.code} was not approved`, body: reason, route: '/staff-self', deliver: true,
    });
    await this.audit.record({ user, action: 'reject', module: 'workforce', entityType: 'leave_request', entityId: r.id, campusId: r.campusId, description: `Rejected ${r.code}: ${reason}`, req });
  }

  async cancel(r: RequestWithType, user: AuthUser, req: Request) {
    if (!LEAVE_OPEN.includes(r.status)) throw badRequest(`${r.code} is ${r.status.toLowerCase()} and cannot be withdrawn`);
    await this.prisma.workforceLeaveRequest.update({ where: { id: r.id }, data: { status: 'Cancelled', cancelledAt: new Date() } });
    await this.wf.notifications.completeTasksFor('leave_request', r.id);
    await this.audit.record({ user, action: 'update', module: 'workforce', entityType: 'leave_request', entityId: r.id, campusId: r.campusId, description: `Withdrew ${r.code}`, req });
  }

  async setCover(r: RequestWithType, cover: string | null, user: AuthUser, req: Request) {
    if (['Rejected', 'Cancelled'].includes(r.status)) throw badRequest(`${r.code} is ${r.status.toLowerCase()}`);
    const value = cover?.trim() || null;
    await this.prisma.workforceLeaveRequest.update({ where: { id: r.id }, data: { coverArrangement: value } });
    await this.audit.record({
      user, action: 'update', module: 'workforce', entityType: 'leave_request', entityId: r.id, campusId: r.campusId,
      description: `Cover for ${r.code}: ${r.coverArrangement ?? 'not assigned'} → ${value ?? 'not required'}`, req,
    });
  }

  private notOwn(r: WorkforceLeaveRequest, user: AuthUser) {
    if (user.employeeId && r.employeeId === user.employeeId) throw forbidden('You cannot decide on your own leave request');
  }

  /** Days of approved leave per employee within a date range (Sundays excluded, half days as 0.5). */
  async approvedDaysIn(employeeIds: string[], from: string, to: string): Promise<Map<string, { days: number; dates: Set<string>; requests: number }>> {
    const out = new Map<string, { days: number; dates: Set<string>; requests: number }>();
    if (!employeeIds.length) return out;
    const rows = await this.prisma.workforceLeaveRequest.findMany({
      where: { employeeId: { in: employeeIds }, status: 'Approved', fromDate: { lte: dateOf(to) }, toDate: { gte: dateOf(from) } },
      include: { leaveType: true },
    });
    for (const r of rows) {
      const cur = out.get(r.employeeId) ?? { days: 0, dates: new Set<string>(), requests: 0 };
      cur.requests++;
      const a = keyOf(r.fromDate) > from ? keyOf(r.fromDate) : from;
      const b = keyOf(r.toDate) < to ? keyOf(r.toDate) : to;
      const ds = workingDays(a, b);
      if (r.halfDay) cur.days += ds.length ? 0.5 : 0;
      else {
        cur.days += ds.length;
        for (const d of ds) cur.dates.add(d);
      }
      if (r.halfDay && ds.length) cur.dates.add(`half:${ds[0]}`);
      out.set(r.employeeId, cur);
    }
    for (const v of out.values()) v.days = round(v.days, 1);
    return out;
  }
}
