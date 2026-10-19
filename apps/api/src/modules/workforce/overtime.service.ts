import { Injectable } from '@nestjs/common';
import type { Employee, WorkforceOvertime } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { AuditService } from '../audit/audit.service';
import { WorkforceService } from './workforce.service';
import { OT_OPEN, addDays, dateLabel, dateOf, keyOf, num, round, todayKey } from './workforce.util';

export interface OvertimeInput {
  workDate: string;
  hours: number;
  reason: string;
  ratePerHour?: number;
}

/** Overtime claims: Submitted / Under Review → Approved → Paid (by payroll), or Rejected. Cost = hours × rate. */
@Injectable()
export class OvertimeService {
  constructor(
    private readonly wf: WorkforceService,
    private readonly audit: AuditService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  async rows(claims: WorkforceOvertime[]) {
    const emps = await this.wf.employeesByIds(claims.map((c) => c.employeeId));
    return claims.map((o) => {
      const e = emps.get(o.employeeId);
      return {
        id: o.id,
        employeeId: o.employeeId,
        employeeName: e?.fullName ?? 'Former employee',
        employeeCode: e?.code ?? '',
        designation: e?.designation ?? '',
        department: e?.department ?? '',
        workDate: keyOf(o.workDate),
        hours: num(o.hours),
        reason: o.reason,
        rate: num(o.ratePerHour),
        cost: num(o.cost),
        status: o.status,
        decidedBy: o.decidedByName,
        decisionNote: o.decisionNote,
        createdAt: o.createdAt.toISOString(),
      };
    });
  }

  /** Records a claim. HR-recorded claims go straight to Under Review; self-service claims start Submitted. */
  async create(emp: Employee, input: OvertimeInput, user: AuthUser, via: 'self' | 'hr', req: Request) {
    if (emp.archivedAt || emp.employmentStatus === 'exited') throw fieldError('employeeId', 'This employee has left');
    const date = input.workDate.slice(0, 10);
    const today = todayKey();
    if (date > today) throw fieldError('workDate', 'Choose a date up to today');
    if (date < addDays(today, -60)) throw fieldError('workDate', via === 'self' ? 'Only the last 60 days can be claimed here' : 'Claims older than 60 days need a manual adjustment');
    const hours = Number(input.hours);
    if (!(hours > 0 && hours <= 16 && Number.isInteger(hours * 2))) throw fieldError('hours', 'Between 0.5 and 16, in half-hour steps');
    const reason = input.reason.trim();
    if (reason.length < 3) throw fieldError('reason', 'Say what the overtime covered');
    const dup = await this.prisma.workforceOvertime.findFirst({
      where: { employeeId: emp.id, workDate: dateOf(date), status: { in: [...OT_OPEN, 'Approved', 'Paid'] } },
      select: { hours: true, status: true },
    });
    if (dup) throw fieldError('workDate', `A claim for ${num(dup.hours)} h on this date already exists (${dup.status.toLowerCase()})`);
    const rate = input.ratePerHour != null && via === 'hr' ? round(Number(input.ratePerHour), 2) : await this.wf.defaultOvertimeRate(num(emp.basicSalary));
    const cost = round(hours * rate, 2);
    const status = via === 'hr' ? 'Under Review' : 'Submitted';
    const row = await this.prisma.workforceOvertime.create({
      data: { employeeId: emp.id, campusId: emp.campusId, workDate: dateOf(date), hours, reason, ratePerHour: rate, cost, status, source: via, submittedById: user.id },
    });
    const self = await this.wf.usersFor([emp.id]);
    await this.wf.approverTasks(
      'hr.approve',
      {
        title: `Approve overtime: ${emp.fullName}, ${hours} h on ${dateLabel(date)}`,
        module: 'workforce',
        status: 'Under Review',
        priority: 'Medium',
        route: '/overtime?status=open',
        entityType: 'overtime',
        entityId: row.id,
      },
      emp.campusId,
      [self.get(emp.id), via === 'self' ? user.id : null],
    );
    await this.audit.record({
      user, action: 'create', module: 'workforce', entityType: 'overtime', entityId: row.id, campusId: emp.campusId,
      description: `${via === 'self' ? 'Claimed' : `Recorded for ${emp.fullName}:`} ${hours} h overtime on ${date} (₹${cost})`, req,
    });
    return row;
  }

  async find(id: string, user: AuthUser) {
    const o = await this.prisma.workforceOvertime.findUnique({ where: { id } });
    if (!o) throw notFound('Overtime claim');
    const campusId = this.wf.campus(user, null);
    if (campusId && o.campusId !== campusId && !user.permissions.has('dashboard.group')) throw notFound('Overtime claim');
    return o;
  }

  async approve(o: WorkforceOvertime, user: AuthUser, req: Request) {
    if (!OT_OPEN.includes(o.status)) throw badRequest(`This claim is already ${o.status.toLowerCase()}`);
    if (user.employeeId && o.employeeId === user.employeeId) throw forbidden('You cannot approve your own overtime claim');
    await this.prisma.workforceOvertime.update({ where: { id: o.id }, data: { status: 'Approved', decidedById: user.id, decidedByName: user.fullName, decidedAt: new Date() } });
    await this.wf.notifications.completeTasksFor('overtime', o.id);
    const e = await this.prisma.employee.findUnique({ where: { id: o.employeeId }, select: { fullName: true } });
    await this.wf.notifyEmployees([o.employeeId], {
      category: 'Completed', topic: 'system', module: 'workforce', title: `Overtime approved: ${num(o.hours)} h on ${dateLabel(keyOf(o.workDate))}`,
      body: 'It will be paid in the next payroll run.', route: '/staff-self',
    });
    await this.audit.record({
      user, action: 'approve', module: 'workforce', entityType: 'overtime', entityId: o.id, campusId: o.campusId,
      description: `Approved ${num(o.hours)} h overtime for ${e?.fullName ?? ''} on ${keyOf(o.workDate)} (₹${num(o.cost)})`, req,
    });
    return e?.fullName ?? '';
  }

  async reject(o: WorkforceOvertime, note: string, user: AuthUser, req: Request) {
    if (!OT_OPEN.includes(o.status)) throw badRequest(`This claim is already ${o.status.toLowerCase()}`);
    if (user.employeeId && o.employeeId === user.employeeId) throw forbidden('You cannot decide on your own overtime claim');
    const reason = note.trim();
    if (reason.length < 3) throw fieldError('note', 'Give the employee a reason');
    await this.prisma.workforceOvertime.update({
      where: { id: o.id },
      data: { status: 'Rejected', decidedById: user.id, decidedByName: user.fullName, decidedAt: new Date(), decisionNote: reason },
    });
    await this.wf.notifications.completeTasksFor('overtime', o.id);
    await this.wf.notifyEmployees([o.employeeId], {
      category: 'Attention', topic: 'system', module: 'workforce', title: `Overtime claim not approved (${dateLabel(keyOf(o.workDate))})`, body: reason, route: '/staff-self',
    });
    await this.audit.record({
      user, action: 'reject', module: 'workforce', entityType: 'overtime', entityId: o.id, campusId: o.campusId,
      description: `Rejected ${num(o.hours)} h overtime on ${keyOf(o.workDate)}: ${reason}`, req,
    });
  }
}
