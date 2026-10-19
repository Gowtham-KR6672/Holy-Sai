import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, Max, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { dateOnly, inr, isoDate, istMonth, monthStart, num, prevMonth, r2 } from './finance.util';

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class AllowanceQuery extends ListQuery {
  @IsOptional() @IsString() @MaxLength(60) allowanceType?: string;
  @IsOptional() @IsIn(['Submitted', 'Approved', 'Rejected', 'Stopped']) status?: string;
  @IsOptional() @IsUUID() employeeId?: string;
}

class AllowanceDto {
  @IsString() @MinLength(3, { message: 'Name the allowance.' }) @MaxLength(60) allowanceType: string;
  @IsOptional() @IsIn(['Monthly', 'One-time']) frequency: string = 'Monthly';
  @Matches(/^\d{4}-\d{2}(-\d{2})?$/, { message: 'Choose the first month.' }) effectiveMonth: string;
  @IsOptional() @IsString() campusId?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsIn(['all', 'teaching', 'non_teaching']) employeeType?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true, message: 'Choose an employee.' }) employeeIds?: string[];
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter a percentage between 0 and 100.' }) @IsPositive({ message: 'Enter a percentage between 0 and 100.' })
  @Max(100, { message: 'Enter a percentage between 0 and 100.' })
  percentOfBasic?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter a monthly amount.' }) @IsPositive({ message: 'Enter a monthly amount.' })
  amount?: number;
}

class DecideDto {
  @IsString() @MinLength(1) @MaxLength(60) allowanceType: string;
  @IsIn(['Approved', 'Rejected', 'Stopped']) decision: 'Approved' | 'Rejected' | 'Stopped';
  @IsOptional() @IsString() campusId?: string;
}

const TYPE_LABEL: Record<string, string> = { all: 'All staff', teaching: 'Teaching staff', non_teaching: 'Non-teaching staff' };

/** Recurring staff allowances: proposed, approved or rejected, stopped; approved ones feed payroll (FinancePayrollService). */
@Controller('finance/allowances')
@RequirePermissions('finance.read', 'hr.read')
export class FinanceAllowancesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('summary')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const thisMonth = monthStart(istMonth(new Date()));
    const rows = await this.prisma.financeAllowance.findMany({ where: campusId ? { campusId } : {}, orderBy: { createdAt: 'asc' } });
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.allowanceType.trim();
      const found = [...groups.keys()].find((k) => k.toLowerCase() === key.toLowerCase()) ?? key;
      groups.set(found, [...(groups.get(found) ?? []), r]);
    }
    const out = [...groups.entries()]
      .filter(([, list]) => list.some((r) => r.status !== 'Rejected'))
      .map(([allowanceType, list]) => {
        const approved = list.filter((r) => r.status === 'Approved');
        const pending = list.filter((r) => r.status === 'Submitted');
        const live = [...approved, ...pending];
        const amounts = (live.length ? live : list).map((r) => num(r.amount));
        const pcts = [...new Set((live.length ? live : list).map((r) => (r.mode === 'percent' && r.percentOfBasic != null ? num(r.percentOfBasic) : null)))];
        const monthly = (r: (typeof list)[number]) => r.frequency === 'Monthly' || r.effectiveMonth.getTime() === thisMonth.getTime();
        const applies = [...new Set(list.map((r) => r.appliesTo))];
        return {
          allowanceType,
          appliesTo: applies.length > 3 ? `${applies.slice(0, 3).join(', ')} +${applies.length - 3}` : applies.join(', '),
          frequency: list[list.length - 1].frequency,
          minAmount: amounts.length ? r2(Math.min(...amounts)) : 0,
          maxAmount: amounts.length ? r2(Math.max(...amounts)) : 0,
          pctOfBasic: pcts.length === 1 ? pcts[0] : null,
          employees: new Set(approved.map((r) => r.employeeId)).size,
          monthlyCost: r2(approved.filter(monthly).reduce((s, r) => s + num(r.amount), 0)),
          pendingCount: pending.length,
          pendingCost: r2(pending.reduce((s, r) => s + num(r.amount), 0)),
          status: approved.length ? 'Active' : pending.length ? 'Proposed' : list.some((r) => r.status === 'Stopped') ? 'Stopped' : 'Rejected',
        };
      });
    const rank = (s: string) => ['Active', 'Proposed', 'Stopped', 'Rejected'].indexOf(s);
    return out.sort((a, b) => rank(a.status) - rank(b.status) || b.monthlyCost - a.monthlyCost || a.allowanceType.localeCompare(b.allowanceType));
  }

  @Get()
  async list(@Query() q: AllowanceQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q, 10);
    const campusId = this.scope.campus(user, q.campusId);
    const where: Prisma.FinanceAllowanceWhereInput = {
      ...(campusId ? { campusId } : {}),
      ...(q.allowanceType ? { allowanceType: { equals: q.allowanceType.trim(), mode: 'insensitive' } } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
    };
    const rows = await this.prisma.financeAllowance.findMany({ where });
    const emps = await this.prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, fullName: true, code: true } });
    const by = new Map(emps.map((e) => [e.id, e]));
    const rank = (s: string) => ['Submitted', 'Approved', 'Stopped', 'Rejected'].indexOf(s);
    const out = rows
      .map((r) => ({
        id: r.id,
        allowanceType: r.allowanceType,
        employeeId: r.employeeId,
        employee: by.get(r.employeeId)?.fullName ?? 'Employee',
        employeeCode: by.get(r.employeeId)?.code ?? null,
        category: r.category,
        department: r.department,
        appliesTo: r.appliesTo,
        mode: r.mode,
        percentOfBasic: r.percentOfBasic == null ? null : num(r.percentOfBasic),
        amount: num(r.amount),
        frequency: r.frequency,
        effectiveMonth: isoDate(r.effectiveMonth)!,
        endMonth: isoDate(r.endMonth),
        status: r.status,
        proposedBy: r.proposedBy,
        decidedBy: r.decidedBy,
      }))
      .sort((a, b) => rank(a.status) - rank(b.status) || a.employee.localeCompare(b.employee));
    return paged(out.slice(p.skip, p.skip + p.take), out.length, p);
  }

  @Post()
  @RequirePermissions('finance.manage', 'hr.manage')
  async create(@Body() dto: AllowanceDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const name = dto.allowanceType.trim();
    const targets = [dto.category ? 1 : 0, dto.employeeType ? 1 : 0, dto.employeeIds?.length ? 1 : 0].reduce((a, b) => a + b, 0);
    if (targets === 0) throw fieldError('category', 'Choose an employee category.');
    if (targets > 1) throw badRequest('Choose one target: a category, a staff type or one employee');
    if (dto.percentOfBasic == null && dto.amount == null) throw fieldError('amount', 'Enter a monthly amount.');
    const campusId = this.scope.campus(user, dto.campusId);
    const where: Prisma.EmployeeWhereInput = {
      archivedAt: null,
      employmentStatus: { not: 'exited' },
      ...(campusId ? { campusId } : {}),
      ...(dto.category ? { category: dto.category } : {}),
      ...(dto.employeeType && dto.employeeType !== 'all' ? { employeeType: dto.employeeType } : {}),
      ...(dto.employeeIds?.length ? { id: { in: dto.employeeIds } } : {}),
    };
    const emps = await this.prisma.employee.findMany({ where, select: { id: true, fullName: true, category: true, department: true, employeeType: true, campusId: true, basicSalary: true } });
    if (!emps.length) {
      if (dto.employeeIds?.length) throw fieldError('employeeIds', 'Choose an active employee.');
      throw fieldError(dto.category ? 'category' : 'employeeType', 'No active employees match this selection.');
    }
    const existing = await this.prisma.financeAllowance.findMany({
      where: { employeeId: { in: emps.map((e) => e.id) }, allowanceType: { equals: name, mode: 'insensitive' }, status: { in: ['Submitted', 'Approved'] } },
      select: { employeeId: true },
    });
    const skip = new Set(existing.map((e) => e.employeeId));
    const todo = emps.filter((e) => !skip.has(e.id));
    if (!todo.length) throw fieldError('allowanceType', `${emps.length === 1 ? 'This employee already has' : 'These employees already have'} "${name}" proposed or approved.`);
    const appliesTo = dto.category ?? (dto.employeeType ? TYPE_LABEL[dto.employeeType] : emps.length === 1 ? emps[0].fullName : `${emps.length} employees`);
    const effectiveMonth = dateOnly(`${dto.effectiveMonth.slice(0, 7)}-01`);
    const mode = dto.percentOfBasic != null ? 'percent' : 'amount';
    await this.prisma.financeAllowance.createMany({
      data: todo.map((e) => ({
        allowanceType: name, employeeId: e.id, campusId: e.campusId, category: e.category, department: e.department, employeeType: e.employeeType, appliesTo,
        mode, percentOfBasic: dto.percentOfBasic ?? null, amount: mode === 'percent' ? r2((num(e.basicSalary) * dto.percentOfBasic!) / 100) : r2(dto.amount!),
        frequency: dto.frequency ?? 'Monthly', effectiveMonth, status: 'Submitted', proposedById: user.id, proposedBy: user.fullName,
      })),
    });
    const total = r2(todo.reduce((s, e) => s + (mode === 'percent' ? (num(e.basicSalary) * dto.percentOfBasic!) / 100 : dto.amount!), 0));
    await this.approverTasks(name, todo.length, total, campusId);
    await this.audit.record({
      user, action: 'create', module: 'finance', entityType: 'finance_allowance', entityId: name, campusId: campusId ?? null, req,
      description: `Proposed "${name}" (${mode === 'percent' ? `${dto.percentOfBasic}% of basic` : `${inr(dto.amount!)} a month`}) for ${todo.length} employee(s) — ${appliesTo}`,
    });
    const skipped = emps.length - todo.length;
    return ok({ created: todo.length, skipped, monthlyCost: total }, `"${name}" proposed for ${todo.length} employee${todo.length === 1 ? '' : 's'}${skipped ? ` (${skipped} already had it)` : ''} — awaiting approval`);
  }

  /** One review task per approver (finance.approve or hr.approve) for the proposal. */
  private async approverTasks(name: string, count: number, cost: number, campusId?: string) {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'active',
        role: { permissions: { some: { permissionKey: { in: ['finance.approve', 'hr.approve'] } } }, key: { notIn: ['parent', 'student'] } },
        ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}),
      },
      select: { id: true },
    });
    for (const u of users) {
      await this.notifications.createTask({
        title: `Approve allowance "${name}" for ${count} employee(s) (${inr(cost)} a month)`,
        module: 'finance', assigneeId: u.id, status: 'Under Review', route: '/allowances', entityType: 'finance_allowance', entityId: name.toLowerCase(),
      });
    }
  }

  @Post('decide')
  @HttpCode(200)
  @RequirePermissions('finance.approve', 'hr.approve')
  async decide(@Body() dto: DecideDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const campusId = this.scope.campus(user, dto.campusId);
    const name = dto.allowanceType.trim();
    const from = dto.decision === 'Stopped' ? 'Approved' : 'Submitted';
    const where: Prisma.FinanceAllowanceWhereInput = { allowanceType: { equals: name, mode: 'insensitive' }, status: from, ...(campusId ? { campusId } : {}) };
    const rows = await this.prisma.financeAllowance.findMany({ where, select: { id: true, amount: true, proposedById: true } });
    if (!rows.length) throw badRequest(dto.decision === 'Stopped' ? `No active "${name}" allowances to stop` : `No proposed "${name}" allowances are awaiting a decision`);
    const now = new Date();
    const data: Prisma.FinanceAllowanceUpdateManyMutationInput =
      dto.decision === 'Stopped'
        ? { status: 'Stopped', stoppedAt: now, endMonth: monthStart(prevMonth(istMonth(now))) }
        : { status: dto.decision, decidedById: user.id, decidedBy: user.fullName, decidedAt: now };
    const r = await this.prisma.financeAllowance.updateMany({ where: { id: { in: rows.map((x) => x.id) } }, data });
    if (dto.decision !== 'Stopped') {
      const stillOpen = await this.prisma.financeAllowance.count({ where: { allowanceType: { equals: name, mode: 'insensitive' }, status: 'Submitted' } });
      if (!stillOpen) await this.notifications.completeTasksFor('finance_allowance', name.toLowerCase());
      const proposers = [...new Set(rows.map((x) => x.proposedById).filter((id): id is string => !!id && id !== user.id))];
      if (proposers.length) {
        await this.notifications.notifyUsers(proposers, {
          category: dto.decision === 'Approved' ? 'Completed' : 'Information', topic: 'system', module: 'finance',
          title: `Allowance "${name}" ${dto.decision.toLowerCase()}`, body: `${r.count} proposed allowance(s) ${dto.decision.toLowerCase()} by ${user.fullName}.`, route: '/allowances',
        });
      }
    }
    const cost = r2(rows.reduce((s, x) => s + num(x.amount), 0));
    await this.audit.record({
      user, action: dto.decision === 'Approved' ? 'approve' : dto.decision === 'Rejected' ? 'reject' : 'update', module: 'finance',
      entityType: 'finance_allowance', entityId: name, campusId: campusId ?? null, req,
      description: `${dto.decision === 'Stopped' ? 'Stopped' : dto.decision} "${name}" for ${r.count} employee(s) (${inr(cost)} a month)`,
    });
    const msg = dto.decision === 'Approved'
      ? `${r.count} allowance(s) approved — included from the next payroll run`
      : dto.decision === 'Rejected' ? `${r.count} proposed allowance(s) rejected` : `"${name}" stopped for ${r.count} employee(s) from the next payroll run`;
    return ok({ updated: r.count }, msg);
  }
}
