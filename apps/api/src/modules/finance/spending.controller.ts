import { Body, Controller, Get, HttpCode, Logger, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FinanceExpense, FinanceReimbursement, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService, type Category } from '../notifications/notifications.service';
import { FinanceBudgetsService } from './budgets.service';
import { FinanceFeesService } from './fees.service';
import {
  addDays, CLAIM_TYPES, dateOnly, inr, isoDate, istMonth, istStart, num, OPEN_APPROVAL, r2, sortRows, today, todayIso, uuidOr404,
} from './finance.util';
import { FinanceLedgerService } from './ledger.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXPENSE_STATUSES = ['Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected', 'Paid'];

class ExpenseQuery extends ListQuery {
  @IsOptional() @IsIn(EXPENSE_STATUSES) status?: string;
  @IsOptional() @IsString() category?: string;
}

class ExpenseDto {
  @IsUUID('all', { message: 'Choose a campus.' }) campusId: string;
  @IsString() @MinLength(1, { message: 'Choose a category.' }) @MaxLength(80) category: string;
  @IsString() @MinLength(3, { message: 'Describe the expense.' }) @MaxLength(200) description: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter an amount greater than zero.' }) @IsPositive({ message: 'Enter an amount greater than zero.' })
  amount: number;
  @Matches(DATE, { message: 'Choose a date that is not in the future.' }) expenseDate: string;
  @IsOptional() @IsUUID() vendorId?: string;
  @IsUUID('all', { message: 'Choose who raised this expense.' }) submittedBy: string;
  @IsOptional() @IsBoolean() submit?: boolean;
}

class ReasonDto {
  @IsString() @MinLength(3, { message: 'Please give a reason (at least 3 characters).' }) @MaxLength(500) reason: string;
}

class ClaimQuery extends ListQuery {
  @IsOptional() @IsIn(EXPENSE_STATUSES) status?: string;
  @IsOptional() @IsIn(CLAIM_TYPES) claimType?: string;
  @IsOptional() @IsUUID() employeeId?: string;
}

class ClaimDto {
  @IsUUID('all', { message: 'Choose the employee.' }) employeeId: string;
  @IsIn(CLAIM_TYPES, { message: 'Choose a claim type.' }) claimType: string;
  @IsString() @MinLength(3, { message: 'Describe what was paid for.' }) @MaxLength(200) description: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter an amount greater than zero.' }) @IsPositive({ message: 'Enter an amount greater than zero.' })
  amount: number;
  @Matches(DATE, { message: 'Choose a date that is not in the future.' }) claimDate: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class BudgetDto {
  @IsUUID('all', { message: 'Choose a campus in the header first.' }) campusId: string;
  @IsString() @MinLength(2, { message: 'Enter a department or category.' }) @MaxLength(80) category: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter the annual budget.' }) @Min(0, { message: 'Enter the annual budget.' }) allocated: number;
  @IsOptional() @IsString() @MaxLength(80) owner?: string;
}

class UpdateBudgetDto {
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter the annual budget.' }) @Min(0, { message: 'Enter the annual budget.' }) allocated?: number;
  @IsOptional() @IsString() @MaxLength(80) owner?: string;
}

/** Expenses, staff reimbursements and departmental budgets. */
@Controller('finance')
@RequirePermissions('finance.read')
export class FinanceSpendingController {
  private readonly log = new Logger('Finance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly counters: CountersService,
    private readonly ledger: FinanceLedgerService,
    private readonly fees: FinanceFeesService,
    private readonly budgetsService: FinanceBudgetsService,
  ) {}

  // =========================================================================
  // Expenses
  // =========================================================================

  private async expenseRows(list: FinanceExpense[]) {
    const campuses = await this.prisma.campus.findMany({ where: { id: { in: [...new Set(list.map((e) => e.campusId))] } }, select: { id: true, shortName: true } });
    const name = new Map(campuses.map((c) => [c.id, c.shortName]));
    return list.map((e) => ({
      id: e.id,
      code: e.code,
      campusId: e.campusId,
      campus: name.get(e.campusId) ?? '',
      category: e.category,
      description: e.description,
      vendorId: e.vendorId,
      vendor: e.vendorName,
      amount: num(e.amount),
      submittedById: e.submittedById,
      raisedBy: e.raisedBy,
      expenseDate: isoDate(e.expenseDate)!,
      status: e.status,
      rejectionReason: e.status === 'Rejected' ? e.rejectionReason : null,
      reviewedBy: e.reviewedBy,
      decidedBy: e.decidedBy,
      decidedAt: e.decidedAt?.toISOString() ?? null,
      paidAt: e.paidAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  @Get('expenses')
  async expenses(@Query() q: ExpenseQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.scope.campus(user, q.campusId);
    const term = q.q?.trim();
    const where: Prisma.FinanceExpenseWhereInput = {
      ...(campusId ? { campusId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(term ? { OR: [{ code: like(term) }, { description: like(term) }, { vendorName: like(term) }, { raisedBy: like(term) }, { category: like(term) }] } : {}),
    };
    const dir = q.dir ?? 'desc';
    const orderBy: Prisma.FinanceExpenseOrderByWithRelationInput[] =
      q.sort === 'code' ? [{ code: dir }]
        : q.sort === 'category' ? [{ category: dir }, { expenseDate: 'desc' }]
          : q.sort === 'amount' ? [{ amount: dir }]
            : q.sort === 'status' ? [{ status: dir }, { expenseDate: 'desc' }]
              : [{ expenseDate: dir }, { createdAt: dir }];
    const [rows, total] = await Promise.all([
      this.prisma.financeExpense.findMany({ where, orderBy, skip: p.skip, take: p.take }),
      this.prisma.financeExpense.count({ where }),
    ]);
    return paged(await this.expenseRows(rows), total, p);
  }

  @Get('expenses/summary')
  async expenseSummary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const c = campusId ? { campusId } : {};
    const y = await this.ledger.year();
    const now = new Date();
    const t = today();
    const weekStart = istStart(isoDate(addDays(t, -((t.getUTCDay() + 6) % 7)))!);
    const [groups, pending, approvedThisWeek, rejected30d, spend] = await Promise.all([
      this.prisma.financeExpense.groupBy({ by: ['status'], where: c, _count: { _all: true } }),
      this.prisma.financeExpense.aggregate({ where: { ...c, status: { in: OPEN_APPROVAL } }, _sum: { amount: true } }),
      this.prisma.financeExpense.count({ where: { ...c, status: { in: ['Approved', 'Paid'] }, decidedAt: { gte: weekStart } } }),
      this.prisma.financeExpense.count({ where: { ...c, status: 'Rejected', decidedAt: { gte: addDays(now, -30) } } }),
      this.prisma.financeExpense.groupBy({
        by: ['category'], where: { ...c, status: { in: ['Approved', 'Paid'] }, expenseDate: { gte: y.start, lte: y.end } }, _sum: { amount: true },
      }),
    ]);
    const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    return {
      flow: {
        draft: n('Draft'), submitted: n('Submitted'), underReview: n('Under Review'), approved: n('Approved'), paid: n('Paid'), rejected: n('Rejected'),
        approvedThisWeek, rejected30d, pendingValue: num(pending._sum.amount),
      },
      byCategory: spend.map((s) => ({ label: s.category, value: num(s._sum.amount) })).filter((s) => s.value > 0).sort((a, b) => b.value - a.value),
    };
  }

  @Post('expenses')
  @RequirePermissions('finance.manage')
  async createExpense(@Body() dto: ExpenseDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const allowed = this.scope.campus(user, undefined);
    if (allowed && dto.campusId !== allowed) throw fieldError('campusId', 'That campus is outside your access.');
    const campus = await this.prisma.campus.findUnique({ where: { id: dto.campusId } });
    if (!campus) throw fieldError('campusId', 'Choose a campus.');
    const cat = await this.prisma.financeExpenseCategory.findUnique({ where: { name: dto.category } });
    if (!cat || !cat.isActive) throw fieldError('category', 'Choose a category.');
    if (dto.expenseDate > todayIso()) throw fieldError('expenseDate', 'Choose a date that is not in the future.');
    const emp = await this.prisma.employee.findUnique({ where: { id: dto.submittedBy }, select: { id: true, fullName: true } });
    if (!emp) throw fieldError('submittedBy', 'Choose who raised this expense.');
    const vendorName = dto.vendorId ? await this.fees.vendorName(dto.vendorId) : null;
    const y = await this.ledger.year();
    const submit = dto.submit !== false;
    const code = await this.counters.reference('EXP', 'finance.expenses', 4, 1001);
    const e = await this.prisma.financeExpense.create({
      data: {
        code, campusId: dto.campusId, academicYearId: y.id, category: cat.name, description: dto.description.trim(), amount: r2(dto.amount),
        expenseDate: dateOnly(dto.expenseDate), vendorId: vendorName ? dto.vendorId : null, vendorName, submittedById: emp.id, raisedBy: emp.fullName,
        status: submit ? 'Submitted' : 'Draft', submittedAt: submit ? new Date() : null, createdById: user.id,
      },
    });
    if (submit) await this.expenseTask(e);
    await this.audit.record({
      user, action: 'create', module: 'finance', entityType: 'finance_expense', entityId: e.id, campusId: e.campusId, req,
      description: `${submit ? 'Submitted' : 'Drafted'} expense ${code}: ${e.description} (${inr(num(e.amount))}, ${e.category})`,
    });
    return ok({ id: e.id, code: e.code, status: e.status }, `${code} ${submit ? 'submitted for approval' : 'saved as draft'}`);
  }

  private async expenseTask(e: FinanceExpense) {
    await this.notifications.createTaskForPermission('finance.approve', {
      title: `Approve ${e.code} — ${e.description} (${inr(num(e.amount))})`,
      module: 'finance',
      status: 'Under Review',
      priority: num(e.amount) >= 100000 ? 'High' : 'Medium',
      route: `/expenses?q=${encodeURIComponent(e.code)}`,
      entityType: 'finance_expense',
      entityId: e.id,
    }, e.campusId);
  }

  private async loadExpense(id: string, user: AuthUser) {
    const e = await this.prisma.financeExpense.findUnique({ where: { id: uuidOr404(id, 'Expense') } });
    if (!e) throw notFound('Expense');
    const allowed = this.scope.campus(user, undefined);
    if (allowed && e.campusId !== allowed) throw forbidden('This expense is on a campus outside your access');
    return e;
  }

  private async tellRaiser(e: { createdById: string | null; submittedById: string | null }, actorId: string, title: string, body: string, route: string, category: Category) {
    const users = e.submittedById ? await this.prisma.user.findMany({ where: { employeeId: e.submittedById, status: 'active' }, select: { id: true } }) : [];
    const ids = [...users.map((u) => u.id), ...(e.createdById ? [e.createdById] : [])].filter((id) => id !== actorId);
    if (ids.length) await this.notifications.notifyUsers(ids, { category, topic: 'system', module: 'finance', title, body, route });
  }

  @Post('expenses/:id/submit')
  @HttpCode(200)
  @RequirePermissions('finance.manage')
  async submitExpense(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.loadExpense(id, user);
    if (e.status !== 'Draft') throw badRequest('Only draft expenses can be submitted');
    const updated = await this.prisma.financeExpense.update({ where: { id: e.id }, data: { status: 'Submitted', submittedAt: new Date() } });
    await this.expenseTask(updated);
    await this.audit.record({ user, action: 'update', module: 'finance', entityType: 'finance_expense', entityId: e.id, campusId: e.campusId, req, description: `Submitted expense ${e.code} for approval` });
    return ok({ id: e.id, status: 'Submitted' }, `${e.code} submitted for approval`);
  }

  @Post('expenses/:id/review')
  @HttpCode(200)
  @RequirePermissions('finance.approve')
  async reviewExpense(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.loadExpense(id, user);
    if (e.status !== 'Submitted') throw badRequest(e.status === 'Under Review' ? `${e.code} is already under review` : `${e.code} is not awaiting review`);
    await this.prisma.financeExpense.update({ where: { id: e.id }, data: { status: 'Under Review', reviewedBy: user.fullName, reviewedAt: new Date() } });
    await this.audit.record({ user, action: 'update', module: 'finance', entityType: 'finance_expense', entityId: e.id, campusId: e.campusId, req, description: `Took expense ${e.code} under review` });
    return ok({ id: e.id, status: 'Under Review' }, `${e.code} is under review`);
  }

  @Post('expenses/:id/approve')
  @HttpCode(200)
  @RequirePermissions('finance.approve')
  async approveExpense(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.loadExpense(id, user);
    if (!OPEN_APPROVAL.includes(e.status)) throw badRequest(`${e.code} has already been decided`);
    await this.prisma.financeExpense.update({ where: { id: e.id }, data: { status: 'Approved', decidedById: user.id, decidedBy: user.fullName, decidedAt: new Date(), rejectionReason: null } });
    await this.notifications.completeTasksFor('finance_expense', e.id);
    await this.tellRaiser(e, user.id, `${e.code} approved`, `${e.description} — ${inr(num(e.amount))} approved by ${user.fullName}.`, `/expenses?q=${e.code}`, 'Completed');
    await this.audit.record({ user, action: 'approve', module: 'finance', entityType: 'finance_expense', entityId: e.id, campusId: e.campusId, req, description: `Approved expense ${e.code} (${inr(num(e.amount))}, ${e.category})` });
    // Budget position after this approval.
    const y = await this.ledger.year();
    const budget = await this.prisma.financeBudget.findFirst({ where: { campusId: e.campusId, category: e.category, OR: [{ academicYearId: y.id }, { academicYearId: null }] } });
    let note = '';
    if (budget && num(budget.allocated) > 0) {
      const spent = await this.prisma.financeExpense.aggregate({
        where: { campusId: e.campusId, category: e.category, status: { in: ['Approved', 'Paid'] }, expenseDate: { gte: y.start, lte: y.end } },
        _sum: { amount: true },
      });
      const used = Math.round((num(spent._sum.amount) / num(budget.allocated)) * 100);
      if (used > 100) note = ` — ${e.category} budget is now ${used}% used`;
    }
    return ok({ id: e.id, status: 'Approved' }, `${e.code} approved${note}`);
  }

  @Post('expenses/:id/reject')
  @HttpCode(200)
  @RequirePermissions('finance.approve')
  async rejectExpense(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.loadExpense(id, user);
    if (!OPEN_APPROVAL.includes(e.status)) throw badRequest(`${e.code} has already been decided`);
    await this.prisma.financeExpense.update({ where: { id: e.id }, data: { status: 'Rejected', decidedById: user.id, decidedBy: user.fullName, decidedAt: new Date(), rejectionReason: dto.reason.trim() } });
    await this.notifications.completeTasksFor('finance_expense', e.id);
    await this.tellRaiser(e, user.id, `${e.code} returned`, `${user.fullName}: ${dto.reason.trim()}`, `/expenses?q=${e.code}`, 'Attention');
    await this.audit.record({ user, action: 'reject', module: 'finance', entityType: 'finance_expense', entityId: e.id, campusId: e.campusId, req, description: `Rejected expense ${e.code}: ${dto.reason.trim()}` });
    return ok({ id: e.id, status: 'Rejected' }, `${e.code} rejected and returned with your reason`);
  }

  @Post('expenses/:id/pay')
  @HttpCode(200)
  @RequirePermissions('finance.manage')
  async payExpense(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const e = await this.loadExpense(id, user);
    if (e.status !== 'Approved') throw badRequest('Only approved expenses can be marked paid');
    await this.prisma.financeExpense.update({ where: { id: e.id }, data: { status: 'Paid', paidAt: new Date(), paidBy: user.fullName } });
    await this.audit.record({ user, action: 'update', module: 'finance', entityType: 'finance_expense', entityId: e.id, campusId: e.campusId, req, description: `Marked expense ${e.code} paid (${inr(num(e.amount))}${e.vendorName ? ` to ${e.vendorName}` : ''})` });
    return ok({ id: e.id, status: 'Paid' }, `${e.code} marked paid`);
  }

  // =========================================================================
  // Reimbursements
  // =========================================================================

  private async claimRows(list: FinanceReimbursement[]) {
    const emps = await this.prisma.employee.findMany({
      where: { id: { in: [...new Set(list.map((r) => r.employeeId))] } },
      select: { id: true, fullName: true, department: true, code: true, category: true },
    });
    const by = new Map(emps.map((e) => [e.id, e]));
    return list.map((r) => {
      const e = by.get(r.employeeId);
      return {
        id: r.id,
        code: r.code,
        employeeId: r.employeeId,
        employee: e?.fullName ?? 'Employee',
        employeeCode: e?.code ?? null,
        department: e?.department ?? '',
        claimType: r.claimType,
        description: r.description,
        amount: num(r.amount),
        claimDate: isoDate(r.claimDate)!,
        status: r.status,
        rejectionReason: r.status === 'Rejected' ? r.rejectionReason : null,
        reviewedBy: r.reviewedBy,
        decidedBy: r.decidedBy,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        payrollMonth: r.payrollMonth,
        paidVia: r.paidVia,
        paidAt: r.paidAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  @Get('reimbursements')
  async claims(@Query() q: ClaimQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.scope.campus(user, q.campusId);
    const term = q.q?.trim();
    const emps = term ? await this.prisma.employee.findMany({ where: { OR: [{ fullName: like(term) }, { code: like(term) }] }, select: { id: true }, take: 500 }) : [];
    const where: Prisma.FinanceReimbursementWhereInput = {
      ...(campusId ? { campusId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.claimType ? { claimType: q.claimType } : {}),
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      ...(term ? { OR: [{ code: like(term) }, { description: like(term) }, { employeeId: { in: emps.map((e) => e.id) } }] } : {}),
    };
    let rows = await this.claimRows(await this.prisma.financeReimbursement.findMany({ where, orderBy: { createdAt: 'desc' } }));
    const dir = q.dir ?? 'desc';
    switch (q.sort) {
      case 'code': rows = sortRows(rows, (r) => r.code, dir); break;
      case 'employee': rows = sortRows(rows, (r) => r.employee, dir); break;
      case 'amount': rows = sortRows(rows, (r) => r.amount, dir); break;
      case 'status': rows = sortRows(rows, (r) => r.status, dir); break;
      default: rows = sortRows(rows, (r) => `${r.claimDate}${r.createdAt}`, dir);
    }
    return paged(rows.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  @Get('reimbursements/summary')
  async claimSummary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, q.campusId);
    const c = campusId ? { campusId } : {};
    const y = await this.ledger.year();
    const monthStartAt = istStart(`${istMonth(new Date())}-01`);
    const [pending, approved, paid, rejected] = await Promise.all([
      this.prisma.financeReimbursement.aggregate({ where: { ...c, status: { in: OPEN_APPROVAL } }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.financeReimbursement.aggregate({ where: { ...c, status: 'Approved' }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.financeReimbursement.aggregate({ where: { ...c, status: 'Paid', paidAt: { gte: monthStartAt } }, _sum: { amount: true } }),
      this.prisma.financeReimbursement.count({ where: { ...c, status: 'Rejected', createdAt: { gte: y.start } } }),
    ]);
    return {
      pending: pending._count._all,
      pendingValue: num(pending._sum.amount),
      approvedUnpaid: num(approved._sum.amount),
      approvedCount: approved._count._all,
      paidThisMonth: num(paid._sum.amount),
      rejected,
    };
  }

  @Post('reimbursements')
  @RequirePermissions('finance.manage')
  async createClaim(@Body() dto: ClaimDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const emp = await this.prisma.employee.findUnique({ where: { id: dto.employeeId }, select: { id: true, fullName: true, campusId: true } });
    if (!emp) throw fieldError('employeeId', 'Choose the employee.');
    const allowed = this.scope.campus(user, undefined);
    if (allowed && emp.campusId !== allowed) throw fieldError('employeeId', 'That employee is on a campus outside your access.');
    if (dto.claimDate > todayIso()) throw fieldError('claimDate', 'Choose a date that is not in the future.');
    const code = await this.counters.reference('RMB', 'finance.reimbursements', 3, 101);
    const r = await this.prisma.financeReimbursement.create({
      data: {
        code, employeeId: emp.id, campusId: emp.campusId, claimType: dto.claimType, description: dto.description.trim(), amount: r2(dto.amount),
        claimDate: dateOnly(dto.claimDate), status: 'Submitted', createdById: user.id, createdBy: user.fullName,
      },
    });
    await this.notifications.createTaskForPermission('finance.approve', {
      title: `Approve reimbursement ${code} — ${emp.fullName} (${inr(num(r.amount))})`,
      module: 'finance', status: 'Under Review', route: `/reimbursements?q=${encodeURIComponent(code)}`, entityType: 'finance_reimbursement', entityId: r.id,
    }, emp.campusId);
    await this.audit.record({
      user, action: 'create', module: 'finance', entityType: 'finance_reimbursement', entityId: r.id, campusId: emp.campusId, req,
      description: `Recorded reimbursement claim ${code} for ${emp.fullName}: ${r.description} (${inr(num(r.amount))})`,
    });
    return ok({ id: r.id, code }, `Claim ${code} recorded`);
  }

  private async loadClaim(id: string, user: AuthUser) {
    const r = await this.prisma.financeReimbursement.findUnique({ where: { id: uuidOr404(id, 'Claim') } });
    if (!r) throw notFound('Claim');
    const allowed = this.scope.campus(user, undefined);
    if (allowed && r.campusId !== allowed) throw forbidden('This claim is on a campus outside your access');
    return r;
  }

  private async tellClaimant(r: FinanceReimbursement, actorId: string, title: string, body: string, category: Category) {
    const users = await this.prisma.user.findMany({ where: { employeeId: r.employeeId, status: 'active' }, select: { id: true } });
    const ids = users.map((u) => u.id).filter((id) => id !== actorId);
    if (ids.length) await this.notifications.notifyUsers(ids, { category, topic: 'system', module: 'finance', title, body, route: '/staff-self' });
  }

  @Post('reimbursements/:id/review')
  @HttpCode(200)
  @RequirePermissions('finance.approve')
  async reviewClaim(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.loadClaim(id, user);
    if (r.status !== 'Submitted') throw badRequest(r.status === 'Under Review' ? `${r.code} is already under review` : `${r.code} is not awaiting review`);
    await this.prisma.financeReimbursement.update({ where: { id: r.id }, data: { status: 'Under Review', reviewedBy: user.fullName, reviewedAt: new Date() } });
    await this.audit.record({ user, action: 'update', module: 'finance', entityType: 'finance_reimbursement', entityId: r.id, campusId: r.campusId, req, description: `Took reimbursement ${r.code} under review` });
    return ok({ id: r.id, status: 'Under Review' }, `${r.code} is under review`);
  }

  @Post('reimbursements/:id/approve')
  @HttpCode(200)
  @RequirePermissions('finance.approve')
  async approveClaim(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.loadClaim(id, user);
    if (!OPEN_APPROVAL.includes(r.status)) throw badRequest(`${r.code} has already been decided`);
    const payrollMonth = istMonth(new Date());
    await this.prisma.financeReimbursement.update({
      where: { id: r.id },
      data: { status: 'Approved', decidedById: user.id, decidedBy: user.fullName, decidedAt: new Date(), rejectionReason: null, payrollMonth },
    });
    await this.notifications.completeTasksFor('finance_reimbursement', r.id);
    await this.tellClaimant(r, user.id, `Reimbursement ${r.code} approved`, `${inr(num(r.amount))} for ${r.description} will be paid with the next payroll run.`, 'Completed');
    await this.audit.record({ user, action: 'approve', module: 'finance', entityType: 'finance_reimbursement', entityId: r.id, campusId: r.campusId, req, description: `Approved reimbursement ${r.code} (${inr(num(r.amount))}) for payroll ${payrollMonth}` });
    return ok({ id: r.id, status: 'Approved', payrollMonth }, `${r.code} approved — it will be paid with the next payroll run`);
  }

  @Post('reimbursements/:id/reject')
  @HttpCode(200)
  @RequirePermissions('finance.approve')
  async rejectClaim(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.loadClaim(id, user);
    if (!OPEN_APPROVAL.includes(r.status)) throw badRequest(`${r.code} has already been decided`);
    await this.prisma.financeReimbursement.update({
      where: { id: r.id },
      data: { status: 'Rejected', decidedById: user.id, decidedBy: user.fullName, decidedAt: new Date(), rejectionReason: dto.reason.trim() },
    });
    await this.notifications.completeTasksFor('finance_reimbursement', r.id);
    await this.tellClaimant(r, user.id, `Reimbursement ${r.code} rejected`, `${user.fullName}: ${dto.reason.trim()}`, 'Attention');
    await this.audit.record({ user, action: 'reject', module: 'finance', entityType: 'finance_reimbursement', entityId: r.id, campusId: r.campusId, req, description: `Rejected reimbursement ${r.code}: ${dto.reason.trim()}` });
    return ok({ id: r.id, status: 'Rejected' }, `${r.code} rejected`);
  }

  @Post('reimbursements/:id/pay')
  @HttpCode(200)
  @RequirePermissions('finance.manage')
  async payClaim(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.loadClaim(id, user);
    if (r.status !== 'Approved') throw badRequest('Only approved claims can be marked paid');
    await this.prisma.financeReimbursement.update({ where: { id: r.id }, data: { status: 'Paid', paidAt: new Date(), paidVia: 'manual' } });
    await this.tellClaimant(r, user.id, `Reimbursement ${r.code} paid`, `${inr(num(r.amount))} for ${r.description} has been paid.`, 'Completed');
    await this.audit.record({ user, action: 'update', module: 'finance', entityType: 'finance_reimbursement', entityId: r.id, campusId: r.campusId, req, description: `Marked reimbursement ${r.code} paid (${inr(num(r.amount))})` });
    return ok({ id: r.id, status: 'Paid' }, `${r.code} marked paid`);
  }

  // =========================================================================
  // Budgets
  // =========================================================================

  @Get('budgets')
  async budgets(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    return this.budgetsService.view(this.scope.campus(user, q.campusId), await this.ledger.year());
  }

  @Post('budgets')
  @RequirePermissions('finance.manage')
  async createBudget(@Body() dto: BudgetDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const allowed = this.scope.campus(user, undefined);
    if (allowed && dto.campusId !== allowed) throw fieldError('campusId', 'That campus is outside your access.');
    const campus = await this.prisma.campus.findUnique({ where: { id: dto.campusId } });
    if (!campus) throw fieldError('campusId', 'Choose a campus in the header first.');
    const cat = await this.prisma.financeExpenseCategory.findUnique({ where: { name: dto.category.trim() } });
    if (!cat) throw fieldError('category', 'Choose a department or category from the list.');
    const y = await this.ledger.year();
    const dup = await this.prisma.financeBudget.findFirst({ where: { campusId: dto.campusId, category: cat.name, ...(y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null }] } : {}) } });
    if (dup) throw fieldError('category', `A ${cat.name} budget already exists for ${campus.shortName} this year. Edit it instead.`);
    const b = await this.prisma.financeBudget.create({
      data: { campusId: dto.campusId, academicYearId: y.id, category: cat.name, allocated: r2(dto.allocated), owner: dto.owner?.trim() || null, createdById: user.id },
    });
    await this.audit.record({ user, action: 'create', module: 'finance', entityType: 'finance_budget', entityId: b.id, campusId: b.campusId, req, description: `Set ${cat.name} budget for ${campus.shortName} at ${inr(dto.allocated)}` });
    return ok({ id: b.id }, `${cat.name} budget saved`);
  }

  @Patch('budgets/:id')
  @RequirePermissions('finance.manage')
  async updateBudget(@Param('id') id: string, @Body() dto: UpdateBudgetDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const b = await this.prisma.financeBudget.findUnique({ where: { id: uuidOr404(id, 'Budget') } });
    if (!b) throw notFound('Budget');
    const allowed = this.scope.campus(user, undefined);
    if (allowed && b.campusId !== allowed) throw forbidden('This budget is on a campus outside your access');
    const updated = await this.prisma.financeBudget.update({
      where: { id: b.id },
      data: { ...(dto.allocated != null ? { allocated: r2(dto.allocated) } : {}), owner: dto.owner?.trim() || null },
    });
    await this.audit.record({
      user, action: 'update', module: 'finance', entityType: 'finance_budget', entityId: b.id, campusId: b.campusId, req,
      description: `Updated ${b.category} budget: ${inr(num(b.allocated))} → ${inr(num(updated.allocated))}${updated.owner ? `, owner ${updated.owner}` : ''}`,
    });
    return ok({ id: b.id }, `${b.category} budget saved`);
  }
}
