import { Injectable } from '@nestjs/common';
import type { FinanceAllowance } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { monthKey, monthStart, num, r2 } from './finance.util';

export interface PayrollAllowance {
  id: string;
  allowanceType: string;
  /** Monthly amount for this pay month (percentages recomputed from the current basic salary). */
  amount: number;
  frequency: string;
  mode: string;
  percentOfBasic: number | null;
}

export interface PayrollReimbursement {
  id: string;
  code: string;
  claimType: string;
  description: string;
  amount: number;
  claimDate: string;
  payrollMonth: string | null;
}

/**
 * Payroll inputs owned by Finance, for the workforce payroll run:
 *  - approved allowances payable in a pay month (recurring monthly, or one-time in their first month);
 *  - approved reimbursements waiting to be paid with the next payroll, and marking them paid.
 * Months are 'YYYY-MM' (a Date or 'YYYY-MM-DD' also works).
 */
@Injectable()
export class FinancePayrollService {
  constructor(private readonly prisma: PrismaService) {}

  private allowanceWhere(month: string | Date) {
    const m = monthStart(monthKey(month));
    return {
      effectiveMonth: { lte: m },
      OR: [
        { status: 'Approved', OR: [{ endMonth: null }, { endMonth: { gte: m } }] },
        { status: 'Stopped', endMonth: { gte: m } },
      ],
    };
  }

  private payable(a: FinanceAllowance, month: string | Date, basic: number | undefined): PayrollAllowance | null {
    const m = monthStart(monthKey(month));
    if (a.frequency === 'One-time' && a.effectiveMonth.getTime() !== m.getTime()) return null;
    const pctOfBasic = a.percentOfBasic == null ? null : num(a.percentOfBasic);
    const amount = a.mode === 'percent' && pctOfBasic != null && basic != null ? r2((basic * pctOfBasic) / 100) : num(a.amount);
    return { id: a.id, allowanceType: a.allowanceType, amount, frequency: a.frequency, mode: a.mode, percentOfBasic: pctOfBasic };
  }

  /** Approved allowances an employee is paid in a pay month. */
  async allowancesFor(employeeId: string, month: string | Date): Promise<PayrollAllowance[]> {
    return (await this.allowancesForEmployees([employeeId], month)).get(employeeId) ?? [];
  }

  /** Approved allowances per employee for a pay month. */
  async allowancesForEmployees(employeeIds: string[], month: string | Date): Promise<Map<string, PayrollAllowance[]>> {
    const out = new Map<string, PayrollAllowance[]>();
    if (!employeeIds.length) return out;
    const [rows, emps] = await Promise.all([
      this.prisma.financeAllowance.findMany({ where: { employeeId: { in: employeeIds }, ...this.allowanceWhere(month) }, orderBy: { allowanceType: 'asc' } }),
      this.prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, basicSalary: true } }),
    ]);
    const basic = new Map(emps.map((e) => [e.id, num(e.basicSalary)]));
    for (const a of rows) {
      const p = this.payable(a, month, basic.get(a.employeeId));
      if (!p) continue;
      const list = out.get(a.employeeId) ?? [];
      list.push(p);
      out.set(a.employeeId, list);
    }
    return out;
  }

  /** Approved, unpaid reimbursements to include in an employee's payroll for the month (and any earlier ones still unpaid). */
  async reimbursementsFor(employeeId: string, month: string | Date): Promise<PayrollReimbursement[]> {
    return (await this.reimbursementsForEmployees([employeeId], month)).get(employeeId) ?? [];
  }

  async reimbursementsForEmployees(employeeIds: string[], month: string | Date): Promise<Map<string, PayrollReimbursement[]>> {
    const out = new Map<string, PayrollReimbursement[]>();
    if (!employeeIds.length) return out;
    const key = monthKey(month);
    const rows = await this.prisma.financeReimbursement.findMany({
      where: { employeeId: { in: employeeIds }, status: 'Approved', OR: [{ payrollMonth: null }, { payrollMonth: { lte: key } }] },
      orderBy: { claimDate: 'asc' },
    });
    for (const r of rows) {
      const list = out.get(r.employeeId) ?? [];
      list.push({
        id: r.id, code: r.code, claimType: r.claimType, description: r.description, amount: num(r.amount),
        claimDate: r.claimDate.toISOString().slice(0, 10), payrollMonth: r.payrollMonth,
      });
      out.set(r.employeeId, list);
    }
    return out;
  }

  /** Marks reimbursements as paid through payroll (call when the payroll run is paid). Returns how many changed. */
  async markReimbursementsPaid(ids: string[], payrollRef: string, paidAt = new Date()): Promise<number> {
    if (!ids.length) return 0;
    const r = await this.prisma.financeReimbursement.updateMany({
      where: { id: { in: ids }, status: 'Approved' },
      data: { status: 'Paid', paidAt, paidVia: 'payroll', payrollRef },
    });
    return r.count;
  }

  /** Totals for a payroll run's inputs panel: approved/proposed allowances and approved reimbursements for the month. */
  async payrollInputs(month: string | Date, campusId?: string) {
    const key = monthKey(month);
    const c = campusId ? { campusId } : {};
    const [allowances, pending, claims] = await Promise.all([
      this.prisma.financeAllowance.findMany({ where: { ...c, ...this.allowanceWhere(key) } }),
      this.prisma.financeAllowance.findMany({ where: { ...c, status: 'Submitted' }, select: { amount: true } }),
      this.prisma.financeReimbursement.findMany({ where: { ...c, status: 'Approved', OR: [{ payrollMonth: null }, { payrollMonth: { lte: key } }] }, select: { amount: true } }),
    ]);
    const emps = await this.prisma.employee.findMany({ where: { id: { in: [...new Set(allowances.map((a) => a.employeeId))] } }, select: { id: true, basicSalary: true } });
    const basic = new Map(emps.map((e) => [e.id, num(e.basicSalary)]));
    const payable = allowances.map((a) => this.payable(a, key, basic.get(a.employeeId))).filter((x): x is PayrollAllowance => !!x);
    return {
      allowances: { approved: r2(payable.reduce((s, a) => s + a.amount, 0)), count: payable.length, pending: r2(pending.reduce((s, a) => s + num(a.amount), 0)), pendingCount: pending.length },
      reimbursements: { approved: r2(claims.reduce((s, r) => s + num(r.amount), 0)), count: claims.length },
    };
  }
}
