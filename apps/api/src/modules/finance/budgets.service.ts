import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { daysBetween, num, OPEN_APPROVAL, r2, today } from './finance.util';
import type { FinanceYear } from './ledger.service';

export interface BudgetRow {
  id: string | null;
  campusId: string | null;
  category: string;
  allocated: number;
  actual: number;
  committed: number;
  projected: number;
  variance: number;
  utilisation: number | null;
  owner: string | null;
}

/**
 * Budget against actual by department. Actual = approved and paid expenses dated in the academic year;
 * committed = expenses awaiting approval; projection = actual ÷ share of the year elapsed.
 */
@Injectable()
export class FinanceBudgetsService {
  constructor(private readonly prisma: PrismaService) {}

  async view(campusId: string | undefined, y: FinanceYear) {
    const [budgets, expenses] = await Promise.all([
      this.prisma.financeBudget.findMany({ where: { ...(campusId ? { campusId } : {}), ...(y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null }] } : {}) } }),
      this.prisma.financeExpense.findMany({
        where: { ...(campusId ? { campusId } : {}), status: { in: ['Approved', 'Paid', 'Submitted', 'Under Review'] }, expenseDate: { gte: y.start, lte: y.end } },
        select: { category: true, amount: true, status: true, campusId: true },
      }),
    ]);
    const total = Math.max(1, daysBetween(y.start, y.end) + 1);
    const elapsed = Math.min(total, Math.max(1, daysBetween(y.start, today()) + 1));
    const share = elapsed / total;
    const cats = [...new Set([...budgets.map((b) => b.category), ...expenses.map((e) => e.category)])];
    const rows: BudgetRow[] = cats.map((category) => {
      const lines = budgets.filter((b) => b.category === category);
      const spend = expenses.filter((e) => e.category === category);
      const allocated = r2(lines.reduce((s, b) => s + num(b.allocated), 0));
      const actual = r2(spend.filter((e) => e.status === 'Approved' || e.status === 'Paid').reduce((s, e) => s + num(e.amount), 0));
      const committed = r2(spend.filter((e) => OPEN_APPROVAL.includes(e.status)).reduce((s, e) => s + num(e.amount), 0));
      const projected = r2(actual / share);
      const owners = [...new Set(lines.map((b) => b.owner).filter(Boolean))];
      return {
        id: lines.length === 1 ? lines[0].id : null,
        campusId: lines.length === 1 ? lines[0].campusId : campusId ?? null,
        category,
        allocated,
        actual,
        committed,
        projected,
        variance: r2(projected - allocated),
        utilisation: allocated > 0 ? Math.round((actual / allocated) * 100) : null,
        owner: owners.length ? owners.join(', ') : null,
      };
    });
    rows.sort((a, b) => b.allocated - a.allocated || b.actual - a.actual || a.category.localeCompare(b.category));
    const over = rows.filter((r) => r.allocated > 0 && r.variance > 0).sort((a, b) => b.variance - a.variance)[0];
    const sum = (k: 'allocated' | 'actual' | 'committed' | 'projected') => r2(rows.reduce((s, r) => s + r[k], 0));
    return {
      kpis: {
        allocated: sum('allocated'),
        spent: sum('actual'),
        committed: sum('committed'),
        projected: sum('projected'),
        projectedVariance: r2(sum('projected') - sum('allocated')),
        yearElapsedPct: Math.round(share * 100),
        overBudget: over ? { category: over.category, variance: over.variance } : null,
      },
      rows,
      academicYear: y.label,
    };
  }
}
