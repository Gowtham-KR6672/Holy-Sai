import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { can, type AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, conflict, fieldError, forbidden, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { AuditService } from '../audit/audit.service';
import { FinanceBridge } from './finance.bridge';
import { PayrollService } from './payroll.service';
import { WorkforceService } from './workforce.service';
import { addMonths, dateOf, keyOf, monthLabel, num, sortRows, todayKey } from './workforce.util';

class RunsQuery extends ListQuery {
  @IsOptional() @IsString() status?: string;
}

class NewRunDto {
  @IsUUID('all', { message: 'Choose a campus' }) campusId: string;
  @Matches(/^\d{4}-\d{2}$/, { message: 'Choose a month' }) payMonth: string;
}

class NoteDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class PayslipQuery extends ListQuery {
  @IsOptional() @IsUUID() runId?: string;
  @IsOptional() @IsIn(['teaching', 'non_teaching']) employeeType?: string;
  @IsOptional() @IsIn(['Released', 'Draft']) status?: string;
}

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

const percent = { message: 'Between 0 and 100' };
const amount = { message: 'Enter an amount (0 or more)' };

/** The school's allowance rules: a % of basic (auto calculate) or fixed amounts for every employee. */
class PayRulesDto {
  @IsBoolean() autoCalculate: boolean;
  @Type(() => Number) @IsNumber({}, percent) @Min(0, percent) @Max(100, percent) hraPercent: number;
  @Type(() => Number) @IsNumber({}, percent) @Min(0, percent) @Max(100, percent) specialPercent: number;
  @Type(() => Number) @IsNumber({}, amount) @Min(0, amount) @Max(10_000_000) conveyance: number;
  @Type(() => Number) @IsNumber({}, amount) @Min(0, amount) @Max(10_000_000) fixedHra: number;
  @Type(() => Number) @IsNumber({}, amount) @Min(0, amount) @Max(10_000_000) fixedSpecial: number;
}

const RULE_KEYS = {
  autoCalculate: 'payroll.auto_allowances',
  hraPercent: 'payroll.hra_percent',
  specialPercent: 'payroll.special_allowance_percent',
  conveyance: 'payroll.conveyance',
  fixedHra: 'payroll.fixed_hra',
  fixedSpecial: 'payroll.fixed_special_allowance',
} as const;

/** Monthly payroll runs: Draft → Inputs → Calculated → Under Review → Approved → Released → Paid (maker-checker). */
@Controller('payroll')
export class PayrollController {
  constructor(
    private readonly wf: WorkforceService,
    private readonly payroll: PayrollService,
    private readonly finance: FinanceBridge,
    private readonly audit: AuditService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  /** How allowances are worked out for employees without their own amounts. */
  @Get('rules')
  @RequirePermissions('payroll.read')
  async rules() {
    const r = await this.payroll.rules();
    const custom = await this.prisma.employee.count({ where: { customAllowances: true, archivedAt: null } });
    return {
      autoCalculate: r.autoAllowances, hraPercent: r.hraPercent, specialPercent: r.specialPercent, conveyance: r.conveyance,
      fixedHra: r.fixedHra, fixedSpecial: r.fixedSpecial, employeesWithOwnAmounts: custom,
    };
  }

  /** Changes the allowance rules (Workspace Admins). Runs calculated from now on use them. */
  @Put('rules')
  @RequirePermissions('settings.manage')
  async saveRules(@Body() dto: PayRulesDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    for (const [field, key] of Object.entries(RULE_KEYS)) await this.wf.settings.put(key, dto[field as keyof PayRulesDto], user.id);
    const rupees = (n: number) => `₹${n}`;
    const summary = dto.autoCalculate
      ? `auto calculate on — HRA ${dto.hraPercent}% and special allowance ${dto.specialPercent}% of basic, conveyance ${rupees(dto.conveyance)}`
      : `auto calculate off — HRA ${rupees(dto.fixedHra)}, conveyance ${rupees(dto.conveyance)}, special allowance ${rupees(dto.fixedSpecial)} a month`;
    await this.audit.record({ user, action: 'update', module: 'workforce', entityType: 'setting', entityId: 'payroll.allowances', description: `Allowance rules: ${summary}`, metadata: { ...dto }, req });
    return ok(await this.rules(), 'Allowance rules saved');
  }

  @Get('runs')
  @RequirePermissions('payroll.read')
  async runs(@Query() q: RunsQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q, 24);
    const campusId = this.wf.campus(user, q.campusId);
    const where: Prisma.WorkforcePayrollRunWhereInput = { ...(campusId ? { campusId } : {}), ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.workforcePayrollRun.findMany({ where, orderBy: [{ payMonth: 'desc' }, { createdAt: 'desc' }], skip: p.skip, take: p.take }),
      this.prisma.workforcePayrollRun.count({ where }),
    ]);
    const named = await this.payroll.withCampus(rows);
    return paged(named.map((r) => this.payroll.view(r)), total, p);
  }

  @Post('runs')
  @RequirePermissions('payroll.manage')
  async create(@Body() dto: NewRunDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const campus = await this.prisma.campus.findUnique({ where: { id: dto.campusId } });
    if (!campus) throw fieldError('campusId', 'Choose a campus');
    const allowed = this.wf.campus(user, null);
    if (allowed && allowed !== campus.id && !can(user, 'dashboard.group')) throw fieldError('campusId', 'This campus is outside your access');
    const payMonth = `${dto.payMonth}-01`;
    if (payMonth > addMonths(todayKey(), 1)) throw fieldError('payMonth', 'Runs can be opened up to one month ahead');
    const existing = await this.prisma.workforcePayrollRun.findUnique({ where: { campusId_payMonth: { campusId: campus.id, payMonth: dateOf(payMonth) } } });
    if (existing) throw conflict(`A ${monthLabel(payMonth)} run already exists for ${campus.shortName} (${existing.status})`, { runId: existing.id });
    const run = await this.prisma.workforcePayrollRun.create({ data: { campusId: campus.id, payMonth: dateOf(payMonth), status: 'Draft', createdById: user.id } });
    await this.audit.record({
      user, action: 'create', module: 'payroll', entityType: 'payroll_run', entityId: run.id, campusId: campus.id,
      description: `Opened the ${monthLabel(payMonth)} payroll run for ${campus.name}`, req,
    });
    return ok(await this.payroll.detail(run, user), 'Payroll run opened');
  }

  @Get('runs/:id')
  @RequirePermissions('payroll.read')
  async detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const run = await this.payroll.find(id, user);
    return this.payroll.detail(run, user);
  }

  /** Draft → Inputs: attendance, leave, overtime, allowances and reimbursements for the month are collected. */
  @Post('runs/:id/inputs')
  @HttpCode(200)
  @RequirePermissions('payroll.manage')
  async collect(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const run = await this.payroll.find(id, user);
    this.payroll.assertStatus(run, ['Draft', 'Inputs'], 'collected');
    const inputs = await this.payroll.inputs(run);
    await this.prisma.workforcePayrollRun.update({ where: { id }, data: { status: 'Inputs', inputsAt: new Date(), inputsById: user.id } });
    await this.audit.record({
      user, action: 'update', module: 'payroll', entityType: 'payroll_run', entityId: id, campusId: run.campusId,
      description: `Collected inputs for ${monthLabel(keyOf(run.payMonth))}: ${inputs.attendance.marked} attendance marks, ${inputs.leave.approvedDays} leave days, ${inputs.overtime.hours} h overtime, ${inputs.pendingCount} item(s) pending`,
      req,
    });
    return ok({ id, status: 'Inputs', pendingCount: inputs.pendingCount }, 'Inputs collected');
  }

  /** Inputs/Calculated → Calculated: payslips are generated from the latest approved inputs. */
  @Post('runs/:id/calculate')
  @HttpCode(200)
  @RequirePermissions('payroll.manage')
  async calculate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const run = await this.payroll.find(id, user);
    this.payroll.assertStatus(run, ['Inputs', 'Calculated'], 'calculated');
    const totals = await this.payroll.calculate(run, user);
    await this.audit.record({
      user, action: 'update', module: 'payroll', entityType: 'payroll_run', entityId: id, campusId: run.campusId,
      description: `${run.status === 'Calculated' ? 'Recalculated' : 'Calculated'} ${monthLabel(keyOf(run.payMonth))} payroll: ${totals.employeeCount} payslips, gross ₹${totals.gross}, net ₹${totals.net}`,
      req,
    });
    return ok({ id, status: 'Calculated', ...totals }, 'Payroll calculated — payslips generated');
  }

  /** Calculated → Under Review: approvers (other than the preparer) get a review task. */
  @Post('runs/:id/submit')
  @HttpCode(200)
  @RequirePermissions('payroll.manage')
  async submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const run = await this.payroll.find(id, user);
    this.payroll.assertStatus(run, ['Calculated'], 'submitted');
    if (!run.employeeCount) throw badRequest('There are no payslips in this run — calculate it first');
    await this.prisma.workforcePayrollRun.update({ where: { id }, data: { status: 'Under Review', submittedAt: new Date(), submittedById: user.id } });
    const campus = await this.prisma.campus.findUnique({ where: { id: run.campusId }, select: { shortName: true } });
    const label = monthLabel(keyOf(run.payMonth));
    await this.wf.approverTasks(
      'payroll.approve',
      {
        title: `Approve ${label} payroll — ${campus?.shortName ?? ''} (${run.employeeCount} employees, net ₹${num(run.net).toLocaleString('en-IN')})`,
        module: 'payroll', status: 'Under Review', priority: 'High', dueOn: todayKey(),
        route: `/payroll?run=${id}`, entityType: 'payroll_run', entityId: id,
      },
      run.campusId,
      [run.calculatedById, user.id],
    );
    await this.audit.record({ user, action: 'update', module: 'payroll', entityType: 'payroll_run', entityId: id, campusId: run.campusId, description: `Submitted ${label} payroll for approval`, req });
    return ok({ id, status: 'Under Review' }, 'Submitted for approval');
  }

  /** Under Review → Approved, by a payroll approver who did not prepare the run. */
  @Post('runs/:id/approve')
  @HttpCode(200)
  @RequirePermissions('payroll.approve')
  async approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const run = await this.payroll.find(id, user);
    this.payroll.assertStatus(run, ['Under Review'], 'approved');
    if (run.calculatedById === user.id || run.submittedById === user.id) throw forbidden('The person who prepared this run cannot approve it');
    await this.prisma.workforcePayrollRun.update({ where: { id }, data: { status: 'Approved', approvedAt: new Date(), approvedById: user.id, approvedByName: user.fullName } });
    await this.wf.notifications.completeTasksFor('payroll_run', id);
    const label = monthLabel(keyOf(run.payMonth));
    const preparers = [run.calculatedById, run.submittedById].filter((x): x is string => !!x);
    if (preparers.length) {
      await this.wf.notifications.notifyUsers(preparers, {
        category: 'Completed', topic: 'system', module: 'payroll', campusId: run.campusId,
        title: `${label} payroll approved`, body: `Approved by ${user.fullName}. Payslips can now be released.`, route: `/payroll?run=${id}`,
      });
    }
    await this.audit.record({
      user, action: 'approve', module: 'payroll', entityType: 'payroll_run', entityId: id, campusId: run.campusId,
      description: `Approved ${label} payroll (${run.employeeCount} employees, net ₹${num(run.net)})`, req,
    });
    return ok({ id, status: 'Approved' }, 'Payroll approved — processing started');
  }

  /** Under Review → Inputs, with a note for the preparer. */
  @Post('runs/:id/return')
  @HttpCode(200)
  @RequirePermissions('payroll.approve')
  async returnRun(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const run = await this.payroll.find(id, user);
    this.payroll.assertStatus(run, ['Under Review'], 'returned');
    const note = dto.note?.trim() ?? '';
    if (note.length < 3) throw fieldError('note', 'Explain what needs to change');
    await this.prisma.workforcePayrollRun.update({ where: { id }, data: { status: 'Inputs', reviewNote: note, returnedAt: new Date(), submittedAt: null, submittedById: null } });
    await this.wf.notifications.completeTasksFor('payroll_run', id);
    const label = monthLabel(keyOf(run.payMonth));
    const preparers = [run.calculatedById, run.submittedById].filter((x): x is string => !!x);
    if (preparers.length) {
      await this.wf.notifications.notifyUsers(preparers, {
        category: 'Attention', topic: 'system', module: 'payroll', campusId: run.campusId,
        title: `${label} payroll returned for changes`, body: note, route: `/payroll?run=${id}`,
      });
    }
    await this.audit.record({ user, action: 'reject', module: 'payroll', entityType: 'payroll_run', entityId: id, campusId: run.campusId, description: `Returned ${label} payroll: ${note}`, req });
    return ok({ id, status: 'Inputs' }, 'Returned to the preparer');
  }

  /** Approved → Released: payslips become visible in staff self-service and employees are notified. */
  @Post('runs/:id/release')
  @HttpCode(200)
  @RequirePermissions('payroll.approve', 'payroll.manage')
  async release(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const run = await this.payroll.find(id, user);
    this.payroll.assertStatus(run, ['Approved'], 'released');
    const now = new Date();
    const slips = await this.prisma.workforcePayslip.findMany({ where: { runId: id }, select: { employeeId: true } });
    await this.prisma.$transaction([
      this.prisma.workforcePayslip.updateMany({ where: { runId: id }, data: { status: 'Released', releasedAt: now } }),
      this.prisma.workforcePayrollRun.update({ where: { id }, data: { status: 'Released', releasedAt: now, releasedById: user.id } }),
    ]);
    const label = monthLabel(keyOf(run.payMonth));
    await this.wf.notifyEmployees(slips.map((s) => s.employeeId), {
      category: 'Information', topic: 'system', module: 'payroll', campusId: run.campusId,
      title: `Your ${label} payslip is ready`, body: 'Open staff self-service to view or download it.', route: '/staff-self', deliver: true,
    });
    await this.audit.record({ user, action: 'publish', module: 'payroll', entityType: 'payroll_run', entityId: id, campusId: run.campusId, description: `Released ${slips.length} ${label} payslips`, req });
    return ok({ id, status: 'Released', released: slips.length }, `${slips.length} payslip${slips.length === 1 ? '' : 's'} released to the staff app`);
  }

  /** Released → Paid: overtime and reimbursements in the run are settled and loan balances reduced. */
  @Post('runs/:id/pay')
  @HttpCode(200)
  @RequirePermissions('payroll.manage', 'payroll.approve')
  async pay(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const run = await this.payroll.find(id, user);
    this.payroll.assertStatus(run, ['Released'], 'marked as paid');
    const now = new Date();
    const today = todayKey();
    const slips = await this.prisma.workforcePayslip.findMany({ where: { runId: id }, select: { employeeId: true, meta: true } });
    const recoveries = slips.flatMap((s) => ((s.meta as { loans?: { id: string; amount: number }[] } | null)?.loans ?? []));
    await this.prisma.$transaction(async (tx) => {
      await tx.workforcePayslip.updateMany({ where: { runId: id }, data: { paymentDate: dateOf(today) } });
      await tx.workforceOvertime.updateMany({ where: { payrollRunId: id, status: 'Approved' }, data: { status: 'Paid', paidAt: now } });
      for (const r of recoveries) {
        const loan = await tx.workforceLoan.findUnique({ where: { id: r.id } });
        if (!loan) continue;
        const outstanding = Math.max(0, num(loan.outstanding) - r.amount);
        await tx.workforceLoan.update({ where: { id: r.id }, data: { outstanding, status: outstanding <= 0 ? 'Closed' : loan.status } });
      }
      await tx.workforcePayrollRun.update({ where: { id }, data: { status: 'Paid', paidAt: now, paidById: user.id } });
    });
    const settled = await this.finance.settleReimbursements(this.payroll.runRef(run), now);
    const label = monthLabel(keyOf(run.payMonth));
    await this.wf.notifyEmployees(slips.map((s) => s.employeeId), {
      category: 'Completed', topic: 'system', module: 'payroll', campusId: run.campusId,
      title: `${label} salary paid`, body: 'Your salary has been transferred to your bank account.', route: '/staff-self',
    });
    await this.audit.record({
      user, action: 'update', module: 'payroll', entityType: 'payroll_run', entityId: id, campusId: run.campusId,
      description: `Marked ${label} payroll as paid (net ₹${num(run.net)}; ${settled} reimbursement claim(s) settled; ${recoveries.length} loan recovery(ies))`, req,
    });
    return ok({ id, status: 'Paid' }, 'Payroll marked as paid');
  }
}

/** Payslips of a run: list, summary and the (audited) payslip view. */
@Controller('payslips')
export class PayslipsController {
  constructor(
    private readonly wf: WorkforceService,
    private readonly payroll: PayrollService,
    private readonly audit: AuditService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  @Get('summary')
  @RequirePermissions('payroll.read')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const campusId = this.wf.campus(user, q.campusId);
    const scope = campusId ? { campusId } : {};
    const yearStart = dateOf(`${todayKey().slice(0, 4)}-01-01`);
    const [releasedThisYear, releasedTotal, runs] = await Promise.all([
      this.prisma.workforcePayslip.count({ where: { ...scope, status: 'Released', payMonth: { gte: yearStart } } }),
      this.prisma.workforcePayslip.count({ where: { ...scope, status: 'Released' } }),
      this.prisma.workforcePayrollRun.findMany({ where: { ...scope, employeeCount: { gt: 0 } }, orderBy: [{ payMonth: 'desc' }, { createdAt: 'desc' }], take: 24 }),
    ]);
    const named = await this.payroll.withCampus(runs);
    return {
      kpis: { releasedThisYear, releasedTotal },
      runs: named.map((r) => ({
        id: r.id,
        payMonth: keyOf(r.payMonth),
        monthLabel: monthLabel(keyOf(r.payMonth)),
        status: r.status,
        campusName: r.campusName,
        employeeCount: r.employeeCount,
        net: num(r.net),
      })),
    };
  }

  @Get()
  @RequirePermissions('payroll.read')
  async list(@Query() q: PayslipQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.wf.campus(user, q.campusId);
    let runId = q.runId;
    if (!runId) {
      const latest = await this.prisma.workforcePayrollRun.findFirst({ where: { ...(campusId ? { campusId } : {}), employeeCount: { gt: 0 } }, orderBy: { payMonth: 'desc' } });
      if (!latest) return paged([], 0, p);
      runId = latest.id;
    }
    const run = await this.payroll.find(runId, user);
    const where: Prisma.WorkforcePayslipWhereInput = {
      runId: run.id,
      ...(q.employeeType ? { employeeType: q.employeeType } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    if (q.q) {
      const ids = (await this.prisma.employee.findMany({ where: { OR: [{ fullName: like(q.q) }, { code: like(q.q) }] }, select: { id: true } })).map((e) => e.id);
      where.employeeId = { in: ids };
    }
    const slips = await this.prisma.workforcePayslip.findMany({ where });
    const emps = await this.wf.employeesByIds(slips.map((s) => s.employeeId));
    const prevMonth = dateOf(addMonths(keyOf(run.payMonth), -1));
    const prev = await this.prisma.workforcePayslip.findMany({
      where: { payMonth: prevMonth, employeeId: { in: slips.map((s) => s.employeeId) } },
      select: { employeeId: true, status: true },
    });
    const prevBy = new Map(prev.map((s) => [s.employeeId, s.status]));
    let rows = slips.map((s) => {
      const e = emps.get(s.employeeId);
      return {
        id: s.id,
        runId: s.runId,
        employeeId: s.employeeId,
        employeeName: e?.fullName ?? 'Former employee',
        employeeCode: e?.code ?? '',
        designation: s.designation,
        department: s.department,
        employeeType: s.employeeType,
        status: s.status,
        previousStatus: prevBy.get(s.employeeId) ?? null,
        gross: num(s.gross),
        net: num(s.net),
      };
    });
    const keys: Record<string, (r: (typeof rows)[number]) => string | number | null> = {
      name: (r) => r.employeeName,
      category: (r) => r.employeeType,
      status: (r) => r.status,
      net: (r) => r.net,
      gross: (r) => r.gross,
      code: (r) => r.employeeCode,
    };
    rows = sortRows(rows, keys[q.sort ?? ''] ?? keys.name, q.dir ?? 'asc');
    return paged(rows.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  @Get(':id')
  @RequirePermissions('payroll.read')
  async one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const slip = await this.prisma.workforcePayslip.findUnique({ where: { id }, include: { run: true } });
    if (!slip) throw notFound('Payslip');
    const campusId = this.wf.campus(user, null);
    if (campusId && slip.campusId !== campusId && !can(user, 'dashboard.group')) throw notFound('Payslip');
    const view = await this.payroll.payslipView(slip);
    await this.audit.record({
      user, action: 'view', module: 'payroll', entityType: 'payslip', entityId: id, campusId: slip.campusId, sensitive: true,
      description: `Viewed the ${view.monthLabel} payslip of ${view.employeeName} (${view.employeeCode})`, req,
    });
    return view;
  }
}
