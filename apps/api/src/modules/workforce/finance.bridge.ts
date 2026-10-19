import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { dateOf, num, round } from './workforce.util';

export interface AllowanceLine {
  id: string;
  label: string;
  amount: number;
}

export interface ReimbursementLine {
  id: string;
  code: string;
  amount: number;
}

/**
 * Payroll inputs owned by the finance module: approved staff allowances (FinanceAllowance) and approved
 * reimbursement claims (FinanceReimbursement). Every read tolerates the tables not being migrated yet.
 */
@Injectable()
export class FinanceBridge {
  private readonly log = new Logger(FinanceBridge.name);

  constructor(private readonly prisma: PrismaService) {}

  private async safe<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.log.debug(`Finance input unavailable: ${(err as Error).message.split('\n')[0]}`);
      return fallback;
    }
  }

  /** Approved allowances payable for the month: monthly ones running in the month, one-time ones effective that month. */
  async allowancesFor(employeeIds: string[], monthKey: string): Promise<Map<string, AllowanceLine[]>> {
    const out = new Map<string, AllowanceLine[]>();
    if (!employeeIds.length) return out;
    const month = dateOf(monthKey);
    const rows = await this.safe([], () =>
      this.prisma.financeAllowance.findMany({
        where: {
          employeeId: { in: employeeIds },
          status: { in: ['Approved', 'Stopped'] },
          effectiveMonth: { lte: month },
          OR: [{ endMonth: null }, { endMonth: { gte: month } }],
        },
        select: { id: true, employeeId: true, allowanceType: true, amount: true, frequency: true, effectiveMonth: true, status: true, endMonth: true },
      }),
    );
    for (const r of rows) {
      if (r.status === 'Stopped' && !r.endMonth) continue;
      if (r.frequency === 'One-time' && r.effectiveMonth.getTime() !== month.getTime()) continue;
      const list = out.get(r.employeeId) ?? [];
      list.push({ id: r.id, label: r.allowanceType, amount: round(num(r.amount)) });
      out.set(r.employeeId, list);
    }
    return out;
  }

  /** Approved, unpaid reimbursement claims dated up to the month end and not queued for another month. */
  async reimbursementsFor(employeeIds: string[], monthKey: string, monthEndKey: string): Promise<Map<string, ReimbursementLine[]>> {
    const out = new Map<string, ReimbursementLine[]>();
    if (!employeeIds.length) return out;
    const ym = monthKey.slice(0, 7);
    const rows = await this.safe([], () =>
      this.prisma.financeReimbursement.findMany({
        where: {
          employeeId: { in: employeeIds },
          status: 'Approved',
          paidAt: null,
          claimDate: { lte: dateOf(monthEndKey) },
          OR: [{ payrollMonth: null }, { payrollMonth: ym }],
        },
        select: { id: true, code: true, employeeId: true, amount: true },
      }),
    );
    for (const r of rows) {
      const list = out.get(r.employeeId) ?? [];
      list.push({ id: r.id, code: r.code, amount: round(num(r.amount)) });
      out.set(r.employeeId, list);
    }
    return out;
  }

  /** Allowances and reimbursements still awaiting a decision for these employees. */
  async pending(employeeIds: string[]): Promise<{ allowances: { count: number; value: number }; reimbursements: { count: number; value: number } }> {
    const empty = { allowances: { count: 0, value: 0 }, reimbursements: { count: 0, value: 0 } };
    if (!employeeIds.length) return empty;
    const [a, r] = await Promise.all([
      this.safe(null, () => this.prisma.financeAllowance.aggregate({ where: { employeeId: { in: employeeIds }, status: 'Submitted' }, _count: true, _sum: { amount: true } })),
      this.safe(null, () =>
        this.prisma.financeReimbursement.aggregate({ where: { employeeId: { in: employeeIds }, status: { in: ['Submitted', 'Under Review'] } }, _count: true, _sum: { amount: true } }),
      ),
    ]);
    return {
      allowances: { count: a?._count ?? 0, value: round(num(a?._sum.amount)) },
      reimbursements: { count: r?._count ?? 0, value: round(num(r?._sum.amount)) },
    };
  }

  /** The employee's own recent reimbursement claims, for "My requests". */
  async myReimbursements(employeeId: string, take = 10) {
    return this.safe([], () =>
      this.prisma.financeReimbursement.findMany({
        where: { employeeId },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, code: true, claimType: true, amount: true, status: true, createdAt: true, decidedAt: true, paidAt: true },
      }),
    );
  }

  /** Queues the claims a run includes (payrollMonth), releasing any it no longer includes. */
  async queueReimbursements(ids: string[], monthKey: string, runRef: string) {
    const ym = monthKey.slice(0, 7);
    await this.safe(undefined, async () => {
      await this.prisma.financeReimbursement.updateMany({
        where: { payrollRef: runRef, paidAt: null, id: { notIn: ids } },
        data: { payrollMonth: null, payrollRef: null },
      });
      if (ids.length) await this.prisma.financeReimbursement.updateMany({ where: { id: { in: ids }, paidAt: null }, data: { payrollMonth: ym, payrollRef: runRef } });
    });
  }

  /** Releases claims queued by a run that is being recalculated or returned. */
  async unqueueReimbursements(runRef: string) {
    await this.safe(undefined, () =>
      this.prisma.financeReimbursement.updateMany({ where: { payrollRef: runRef, paidAt: null }, data: { payrollMonth: null, payrollRef: null } }),
    );
  }

  /** Marks the claims paid with the run as Paid. */
  async settleReimbursements(runRef: string, paidAt: Date): Promise<number> {
    return this.safe(0, async () => {
      const r = await this.prisma.financeReimbursement.updateMany({
        where: { payrollRef: runRef, status: 'Approved', paidAt: null },
        data: { status: 'Paid', paidVia: 'payroll', paidAt },
      });
      return r.count;
    });
  }
}
