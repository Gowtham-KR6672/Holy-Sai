import { Injectable } from '@nestjs/common';
import type { Employee, Prisma, WorkforcePayrollRun, WorkforcePayslip } from '@prisma/client';
import { can, type AuthUser } from '../../common/auth-user';
import { badRequest, notFound } from '../../common/errors';
import { FinanceBridge } from './finance.bridge';
import { LeaveService } from './leave.service';
import { WorkforceService } from './workforce.service';
import {
  LEAVE_OPEN, OT_OPEN, RUN_STAGES, dateOf, groupBy, isoOrNull, keyOf, keyOrNull, monthEndKey, monthLabel, num, round, sumBy, todayKey, workingDays,
} from './workforce.util';

export interface MoneyLine {
  label: string;
  amount: number;
}

/** Salary structure parameters (system settings with these defaults). */
export interface PayRules {
  /** On: HRA and special allowance are a % of basic. Off: the fixed amounts, the same for every employee. */
  autoAllowances: boolean;
  hraPercent: number;
  conveyance: number;
  specialPercent: number;
  fixedHra: number;
  fixedSpecial: number;
  pfPercent: number;
  pfWageCeiling: number;
  standardDeduction: number;
}

type AllowanceSource = Pick<Employee, 'basicSalary' | 'customAllowances' | 'hraAmount' | 'conveyanceAmount' | 'specialAllowanceAmount'>;

/**
 * An employee's allowances for a full month: their own amounts when set on the employee, otherwise the school's
 * rules (a % of basic when auto calculation is on, or the school's fixed amounts).
 */
export function monthlyAllowances(e: AllowanceSource, rules: PayRules): { hra: number; conveyance: number; special: number; own: boolean } {
  if (e.customAllowances) return { hra: num(e.hraAmount), conveyance: num(e.conveyanceAmount), special: num(e.specialAllowanceAmount), own: true };
  const basic = num(e.basicSalary);
  return rules.autoAllowances
    ? { hra: (basic * rules.hraPercent) / 100, conveyance: rules.conveyance, special: (basic * rules.specialPercent) / 100, own: false }
    : { hra: rules.fixedHra, conveyance: rules.conveyance, special: rules.fixedSpecial, own: false };
}

/** Tamil Nadu professional tax, per half-year of gross income (₹). Charged monthly as one sixth. */
const PT_HALF_YEAR = [
  { upTo: 21000, tax: 0 },
  { upTo: 30000, tax: 180 },
  { upTo: 45000, tax: 425 },
  { upTo: 60000, tax: 930 },
  { upTo: 75000, tax: 1025 },
  { upTo: Infinity, tax: 1250 },
];

/** New tax regime slabs (annual taxable income). */
const TAX_SLABS = [
  { upTo: 400000, rate: 0 },
  { upTo: 800000, rate: 0.05 },
  { upTo: 1200000, rate: 0.1 },
  { upTo: 1600000, rate: 0.15 },
  { upTo: 2000000, rate: 0.2 },
  { upTo: 2400000, rate: 0.25 },
  { upTo: Infinity, rate: 0.3 },
];

export function annualTax(taxable: number): number {
  if (taxable <= 1200000) return 0; // section 87A rebate
  let tax = 0;
  let lower = 0;
  for (const s of TAX_SLABS) {
    if (taxable > lower) tax += (Math.min(taxable, s.upTo) - lower) * s.rate;
    lower = s.upTo;
  }
  return Math.round(tax * 1.04); // health and education cess
}

export function professionalTax(monthlyGross: number): number {
  const half = monthlyGross * 6;
  const slab = PT_HALF_YEAR.find((s) => half <= s.upTo) ?? PT_HALF_YEAR[PT_HALF_YEAR.length - 1];
  return Math.round(slab.tax / 6);
}

type RunWithCampus = WorkforcePayrollRun & { campusName?: string | null };

/** Payroll runs: inputs, calculation of payslips, and the views the payroll screens read. */
@Injectable()
export class PayrollService {
  constructor(
    private readonly wf: WorkforceService,
    private readonly finance: FinanceBridge,
    private readonly leave: LeaveService,
  ) {}

  private get prisma() {
    return this.wf.prisma;
  }

  async rules(): Promise<PayRules> {
    const s = this.wf.settings;
    return {
      autoAllowances: (await s.get<unknown>('payroll.auto_allowances', true)) !== false,
      hraPercent: Number(await s.get('payroll.hra_percent', 40)),
      conveyance: Number(await s.get('payroll.conveyance', 1600)),
      specialPercent: Number(await s.get('payroll.special_allowance_percent', 10)),
      fixedHra: Number(await s.get('payroll.fixed_hra', 0)),
      fixedSpecial: Number(await s.get('payroll.fixed_special_allowance', 0)),
      pfPercent: Number(await s.get('payroll.pf_percent', 12)),
      pfWageCeiling: Number(await s.get('payroll.pf_wage_ceiling', 15000)),
      standardDeduction: Number(await s.get('payroll.tds_standard_deduction', 75000)),
    };
  }

  async find(id: string, user: AuthUser) {
    const run = await this.prisma.workforcePayrollRun.findUnique({ where: { id } });
    if (!run) throw notFound('Payroll run');
    const campusId = this.wf.campus(user, null);
    if (campusId && run.campusId !== campusId && !can(user, 'dashboard.group')) throw notFound('Payroll run');
    return run;
  }

  runRef(run: WorkforcePayrollRun) {
    return `PAY-${keyOf(run.payMonth).slice(0, 7)}-${run.id.slice(0, 8)}`;
  }

  view(run: RunWithCampus) {
    const payMonth = keyOf(run.payMonth);
    return {
      id: run.id,
      campusId: run.campusId,
      campusName: run.campusName ?? null,
      payMonth,
      monthLabel: monthLabel(payMonth),
      status: run.status,
      employeeCount: run.employeeCount,
      gross: num(run.gross),
      deductions: num(run.deductions),
      net: num(run.net),
      overtime: num(run.overtime),
      allowances: num(run.allowances),
      reimbursements: num(run.reimbursements),
      createdAt: run.createdAt.toISOString(),
      calculatedBy: run.calculatedByName,
      calculatedAt: isoOrNull(run.calculatedAt),
      submittedAt: isoOrNull(run.submittedAt),
      approvedBy: run.approvedByName,
      approvedAt: isoOrNull(run.approvedAt),
      reviewNote: run.reviewNote,
      releasedAt: isoOrNull(run.releasedAt),
      releasedSlips: ['Released', 'Paid'].includes(run.status) ? run.employeeCount : 0,
      paidAt: isoOrNull(run.paidAt),
    };
  }

  async withCampus<T extends WorkforcePayrollRun>(runs: T[]): Promise<(T & { campusName: string | null })[]> {
    const names = await this.wf.campusNames(runs.map((r) => r.campusId));
    return runs.map((r) => ({ ...r, campusName: names.get(r.campusId)?.name ?? null }));
  }

  /** Employees paid by a run: on the campus, joined by the month end, not exited before the month started. */
  async eligible(run: WorkforcePayrollRun): Promise<Employee[]> {
    const start = run.payMonth;
    const end = dateOf(monthEndKey(keyOf(run.payMonth)));
    return this.prisma.employee.findMany({
      where: {
        campusId: run.campusId,
        OR: [{ joinDate: null }, { joinDate: { lte: end } }],
        AND: [{ OR: [{ archivedAt: null }, { archivedAt: { gte: start } }] }],
      },
      orderBy: { fullName: 'asc' },
    });
  }

  /** Inputs for the run's month: attendance, approved leave, approved overtime, allowances, reimbursements, and what is still pending. */
  async inputs(run: WorkforcePayrollRun, emps?: Employee[]) {
    const list = emps ?? (await this.eligible(run));
    const ids = list.map((e) => e.id);
    const from = keyOf(run.payMonth);
    const to = monthEndKey(from);
    const [marks, leaveDays, openLeave, ot, openOt, allowances, reimbursements, pending] = await Promise.all([
      this.prisma.workforceAttendance.findMany({ where: { employeeId: { in: ids }, date: { gte: dateOf(from), lte: dateOf(to) } }, select: { date: true, status: true } }),
      this.leave.approvedDaysIn(ids, from, to),
      this.prisma.workforceLeaveRequest.count({ where: { employeeId: { in: ids }, status: { in: LEAVE_OPEN }, fromDate: { lte: dateOf(to) }, toDate: { gte: dateOf(from) } } }),
      this.payableOvertime(run, ids),
      this.prisma.workforceOvertime.aggregate({ where: { employeeId: { in: ids }, status: { in: OT_OPEN }, workDate: { lte: dateOf(to) } }, _count: true, _sum: { cost: true } }),
      this.finance.allowancesFor(ids, from),
      this.finance.reimbursementsFor(ids, from, to),
      this.finance.pending(ids),
    ]);
    const lastMarked = marks.reduce<string | null>((m, r) => (!m || keyOf(r.date) > m ? keyOf(r.date) : m), null);
    const allowanceLines = [...allowances.values()].flat();
    const reimbursementLines = [...reimbursements.values()].flat();
    const pendingItems = [
      { what: 'Leave requests', count: openLeave, value: 0 },
      { what: 'Overtime claims', count: openOt._count, value: round(num(openOt._sum.cost)) },
      { what: 'Allowances', count: pending.allowances.count, value: pending.allowances.value },
      { what: 'Reimbursements', count: pending.reimbursements.count, value: pending.reimbursements.value },
    ].filter((p) => p.count > 0);
    return {
      pendingCount: sumBy(pendingItems, (p) => p.count),
      pendingItems,
      attendance: {
        marked: marks.length,
        lastMarked,
        absentDays: marks.filter((m) => m.status === 'Absent').length,
        halfDays: marks.filter((m) => m.status === 'Half Day').length,
      },
      leave: { approvedDays: round(sumBy([...leaveDays.values()], (l) => l.days), 1), requests: sumBy([...leaveDays.values()], (l) => l.requests) },
      overtime: { hours: round(sumBy(ot, (o) => num(o.hours)), 1), value: round(sumBy(ot, (o) => num(o.cost))), items: ot.length },
      allowances: { approved: round(sumBy(allowanceLines, (a) => a.amount)), items: allowanceLines.length },
      reimbursements: { approved: round(sumBy(reimbursementLines, (r) => r.amount)), items: reimbursementLines.length },
    };
  }

  /** Approved overtime up to the month end not yet claimed by another run. */
  private payableOvertime(run: WorkforcePayrollRun, ids: string[]) {
    return this.prisma.workforceOvertime.findMany({
      where: {
        employeeId: { in: ids },
        status: 'Approved',
        workDate: { lte: dateOf(monthEndKey(keyOf(run.payMonth))) },
        OR: [{ payrollRunId: null }, { payrollRunId: run.id }],
      },
    });
  }

  async detail(run: WorkforcePayrollRun, user: AuthUser) {
    const [withName] = await this.withCampus([run]);
    const [inputs, slips] = await Promise.all([
      run.status === 'Draft'
        ? Promise.resolve(null)
        : ['Approved', 'Released', 'Paid'].includes(run.status) && run.inputsSnapshot
          ? Promise.resolve(run.inputsSnapshot as unknown as Awaited<ReturnType<PayrollService['inputs']>>)
          : this.inputs(run),
      this.prisma.workforcePayslip.findMany({ where: { runId: run.id }, select: { category: true, gross: true, net: true } }),
    ]);
    const manage = can(user, 'payroll.manage');
    const approve = can(user, 'payroll.approve');
    const maker = run.calculatedById === user.id || run.submittedById === user.id;
    const s = run.status;
    const byCategory = [...groupBy(slips, (p) => p.category).entries()]
      .map(([label, list]) => ({ label, count: list.length, gross: round(sumBy(list, (p) => num(p.gross))), net: round(sumBy(list, (p) => num(p.net))) }))
      .sort((a, b) => b.gross - a.gross);
    return {
      run: this.view(withName),
      stages: [...RUN_STAGES],
      stage: Math.max(0, RUN_STAGES.indexOf(s as (typeof RUN_STAGES)[number])),
      actions: {
        canPrepare: manage && ['Draft', 'Inputs'].includes(s),
        canSubmit: manage && s === 'Calculated',
        canApprove: approve && s === 'Under Review' && !maker,
        makerChecker: s === 'Under Review' && maker,
        canReturn: approve && s === 'Under Review' && !maker,
        canRelease: (approve || manage) && s === 'Approved',
        canPay: (manage || approve) && s === 'Released',
      },
      inputs,
      byCategory,
    };
  }

  /** Generates (or regenerates) every payslip of the run from the latest approved inputs. */
  async calculate(run: WorkforcePayrollRun, user: AuthUser) {
    const rules = await this.rules();
    const emps = await this.eligible(run);
    const ids = emps.map((e) => e.id);
    const from = keyOf(run.payMonth);
    const to = monthEndKey(from);
    const month = workingDays(from, to);
    const wd = month.length;
    const [marks, leaveTaken, ot, allowances, reimbursements, loans, inputs] = await Promise.all([
      this.prisma.workforceAttendance.findMany({ where: { employeeId: { in: ids }, date: { gte: dateOf(from), lte: dateOf(to) } } }),
      this.leave.approvedDaysIn(ids, from, to),
      this.payableOvertime(run, ids),
      this.finance.allowancesFor(ids, from),
      this.finance.reimbursementsFor(ids, from, to),
      this.prisma.workforceLoan.findMany({ where: { employeeId: { in: ids }, status: 'Active', startedOn: { lte: dateOf(to) } } }),
      this.inputs(run, emps),
    ]);
    const marksBy = groupBy(marks, (m) => m.employeeId);
    const otBy = groupBy(ot, (o) => o.employeeId);
    const loansBy = groupBy(loans, (l) => l.employeeId);

    const slips: Prisma.WorkforcePayslipCreateManyInput[] = [];
    const paidOvertime: string[] = [];
    const paidReimbursements: string[] = [];
    for (const e of emps) {
      const join = e.joinDate ? keyOf(e.joinDate) : null;
      const exit = e.archivedAt ? todayKey(e.archivedAt) : null;
      const eligibleDays = month.filter((d) => (!join || d >= join) && (!exit || d <= exit));
      const offRoll = wd - eligibleDays.length;
      const status = new Map((marksBy.get(e.id) ?? []).map((m) => [keyOf(m.date), m.status]));
      const leave = leaveTaken.get(e.id);
      let lop = 0;
      for (const d of eligibleDays) {
        if (leave?.dates.has(d)) continue;
        const st = status.get(d);
        if (st === 'Absent' || st === 'On Leave') lop += 1;
        else if (st === 'Half Day' && !leave?.dates.has(`half:${d}`)) lop += 0.5;
      }
      const leaveDays = leave?.days ?? 0;
      const paidDays = Math.max(0, eligibleDays.length - lop);
      const factor = wd ? paidDays / wd : 0;
      const basicFull = num(e.basicSalary);
      const basic = round(basicFull * factor, 0);
      // Allowances are reduced for unpaid days like the basic (a % of the reduced basic, or a fixed amount × factor).
      const full = monthlyAllowances(e, rules);
      const byPercent = !full.own && rules.autoAllowances;
      const hra = byPercent ? round(basic * (rules.hraPercent / 100), 0) : round(full.hra * factor, 0);
      const conveyance = round(full.conveyance * factor, 0);
      const special = byPercent ? round(basic * (rules.specialPercent / 100), 0) : round(full.special * factor, 0);
      const claims = otBy.get(e.id) ?? [];
      const otPay = round(sumBy(claims, (o) => num(o.cost)));
      const otHours = round(sumBy(claims, (o) => num(o.hours)), 1);
      const allow = allowances.get(e.id) ?? [];
      const allowTotal = round(sumBy(allow, (a) => a.amount));
      const reimb = reimbursements.get(e.id) ?? [];
      const reimbTotal = round(sumBy(reimb, (r) => r.amount));
      const earnings: MoneyLine[] = [
        { label: 'Basic', amount: basic },
        { label: 'House rent allowance', amount: hra },
        { label: 'Conveyance', amount: conveyance },
        { label: 'Special allowance', amount: special },
        ...allow.map((a) => ({ label: a.label, amount: a.amount })),
        { label: `Overtime (${otHours} h)`, amount: otPay },
        { label: 'Reimbursements', amount: reimbTotal },
      ].filter((l, i) => i === 0 || l.amount > 0);
      const gross = round(sumBy(earnings, (l) => l.amount));
      if (gross <= 0 && basicFull <= 0) continue;
      const taxableMonth = gross - reimbTotal;
      const pf = round(Math.min(basic, rules.pfWageCeiling) * (rules.pfPercent / 100), 0);
      const pt = taxableMonth > 0 ? professionalTax(taxableMonth) : 0;
      const fullMonthly = basicFull + full.hra + full.conveyance + full.special + allowTotal;
      // TDS under the new regime: projected annual salary less the standard deduction (PF is not deductible).
      const projected = Math.max(0, fullMonthly * 12 + otPay - rules.standardDeduction);
      const tds = paidDays > 0 ? Math.round(annualTax(projected) / 12) : 0;
      let available = Math.max(0, gross - pf - pt - tds);
      const recoveries: { id: string; amount: number }[] = [];
      for (const l of loansBy.get(e.id) ?? []) {
        const amt = round(Math.min(num(l.monthlyInstalment), num(l.outstanding), available));
        if (amt > 0) {
          recoveries.push({ id: l.id, amount: amt });
          available -= amt;
        }
      }
      const loanTotal = round(sumBy(recoveries, (r) => r.amount));
      const deductions: MoneyLine[] = [
        { label: 'Provident fund', amount: pf },
        { label: 'Professional tax', amount: pt },
        { label: 'Income tax (TDS)', amount: tds },
        { label: 'Loan recovery', amount: loanTotal },
      ].filter((l) => l.amount > 0);
      const totalDeductions = round(sumBy(deductions, (l) => l.amount));
      paidOvertime.push(...claims.map((c) => c.id));
      paidReimbursements.push(...reimb.map((r) => r.id));
      slips.push({
        runId: run.id,
        employeeId: e.id,
        campusId: e.campusId,
        payMonth: run.payMonth,
        employeeType: e.employeeType,
        category: e.category,
        designation: e.designation,
        department: e.department,
        bankAccountMasked: e.bankAccountMasked,
        workingDays: wd,
        daysWorked: Math.max(0, round(eligibleDays.length - lop - leaveDays, 1)),
        leaveDays,
        lopDays: round(lop + offRoll, 1),
        overtimeHours: otHours,
        basic,
        gross,
        totalDeductions,
        net: round(gross - totalDeductions),
        allowances: allowTotal,
        reimbursements: reimbTotal,
        overtimePay: otPay,
        earnings: earnings as unknown as Prisma.InputJsonValue,
        deductions: deductions as unknown as Prisma.InputJsonValue,
        meta: { loans: recoveries, overtime: claims.map((c) => c.id), reimbursements: reimb.map((r) => r.id) } as Prisma.InputJsonValue,
        status: 'Draft',
      });
    }

    const totals = {
      employeeCount: slips.length,
      gross: round(sumBy(slips, (s) => Number(s.gross))),
      deductions: round(sumBy(slips, (s) => Number(s.totalDeductions))),
      net: round(sumBy(slips, (s) => Number(s.net))),
      overtime: round(sumBy(slips, (s) => Number(s.overtimePay ?? 0))),
      allowances: round(sumBy(slips, (s) => Number(s.allowances ?? 0))),
      reimbursements: round(sumBy(slips, (s) => Number(s.reimbursements ?? 0))),
    };
    await this.prisma.$transaction([
      this.prisma.workforcePayslip.deleteMany({ where: { runId: run.id } }),
      this.prisma.workforceOvertime.updateMany({ where: { payrollRunId: run.id, status: 'Approved' }, data: { payrollRunId: null } }),
      this.prisma.workforceOvertime.updateMany({ where: { id: { in: paidOvertime } }, data: { payrollRunId: run.id } }),
      this.prisma.workforcePayslip.createMany({ data: slips }),
      this.prisma.workforcePayrollRun.update({
        where: { id: run.id },
        data: {
          ...totals,
          status: 'Calculated',
          calculatedAt: new Date(),
          calculatedById: user.id,
          calculatedByName: user.fullName,
          reviewNote: null,
          inputsSnapshot: inputs as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);
    await this.finance.queueReimbursements(paidReimbursements, from, this.runRef(run));
    return totals;
  }

  /** Payslip as the payslip view and the printable page read it. */
  async payslipView(slip: WorkforcePayslip & { run: WorkforcePayrollRun }) {
    const [emp, campus] = await Promise.all([
      this.prisma.employee.findUnique({ where: { id: slip.employeeId } }),
      this.prisma.campus.findUnique({ where: { id: slip.campusId } }),
    ]);
    const payMonth = keyOf(slip.payMonth);
    return {
      id: slip.id,
      runId: slip.runId,
      employeeId: slip.employeeId,
      employeeName: emp?.fullName ?? 'Former employee',
      employeeCode: emp?.code ?? '',
      designation: slip.designation,
      department: slip.department,
      employeeType: slip.employeeType,
      joinDate: keyOrNull(emp?.joinDate),
      campusName: campus?.name ?? null,
      campusAddress: campus ? campus.address ?? campus.place : null,
      payMonth,
      monthLabel: monthLabel(payMonth),
      monthEnd: monthEndKey(payMonth),
      earnings: (slip.earnings as unknown as MoneyLine[]) ?? [],
      deductions: (slip.deductions as unknown as MoneyLine[]) ?? [],
      gross: num(slip.gross),
      totalDeductions: num(slip.totalDeductions),
      net: num(slip.net),
      workingDays: slip.workingDays,
      daysWorked: slip.daysWorked,
      leaveDays: slip.leaveDays,
      lopDays: slip.lopDays,
      overtimeHours: slip.overtimeHours,
      paymentDate: keyOrNull(slip.paymentDate),
      bankAccount: slip.bankAccountMasked,
      status: slip.status,
      runStatus: slip.run.status,
    };
  }

  assertStatus(run: WorkforcePayrollRun, allowed: string[], action: string) {
    if (!allowed.includes(run.status)) throw badRequest(`This run is ${run.status} — it cannot be ${action} now`);
  }
}
