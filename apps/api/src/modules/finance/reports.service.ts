import { Injectable, Logger } from '@nestjs/common';
import { notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { FinanceBudgetsService } from './budgets.service';
import { AWARD_TYPES, daysBetween, inr, isoDate, monthOf, monthYearLabel, num, OPEN_APPROVAL, pct, r2, today } from './finance.util';
import { FinanceLedgerService, type FinanceYear } from './ledger.service';

export interface ReportColumn {
  key: string;
  label: string;
  money?: boolean;
}

export interface Report {
  key: string;
  title: string;
  sub: string;
  academicYear: string;
  campus: string | null;
  generatedAt: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
}

export const REPORTS: Record<string, { title: string; sub: string }> = {
  'fee-collection': { title: 'Fee collection summary', sub: 'Billed, collected and outstanding by head and campus' },
  ageing: { title: 'Ageing analysis', sub: 'Outstanding by days overdue, by grade and by campus' },
  'cash-flow': { title: 'Cash flow forecast', sub: 'Expected receipts by instalment due date' },
  concessions: { title: 'Concession and scholarship report', sub: 'Value awarded, by type and by approver' },
  'expense-budget': { title: 'Expense and budget report', sub: 'Department spend against budget, with commitments' },
  'payroll-cost': { title: 'Payroll cost report', sub: 'Gross, deductions, net and cost per category' },
  reconciliation: { title: 'Reconciliation log', sub: 'Matched, unmatched and exception history' },
  'campus-comparison': { title: 'Campus comparison', sub: 'Every financial measure, campus by campus' },
  'audit-pack': { title: 'Audit pack', sub: 'Everything an auditor asks for, in one export' },
};

/** The nine standard financial reports, generated from live data. */
@Injectable()
export class FinanceReportsService {
  private readonly log = new Logger('FinanceReports');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: FinanceLedgerService,
    private readonly budgets: FinanceBudgetsService,
  ) {}

  async generate(key: string, campusId: string | undefined): Promise<Report> {
    const def = REPORTS[key];
    if (!def) throw notFound('Report');
    const y = await this.ledger.year();
    const campus = campusId ? await this.prisma.campus.findUnique({ where: { id: campusId }, select: { shortName: true } }) : null;
    let body: { columns: ReportColumn[]; rows: Record<string, unknown>[] };
    switch (key) {
      case 'fee-collection': body = await this.feeCollection(y, campusId); break;
      case 'ageing': body = await this.ageing(y, campusId); break;
      case 'cash-flow': body = await this.cashFlow(y, campusId); break;
      case 'concessions': body = await this.concessions(y, campusId); break;
      case 'expense-budget': body = await this.expenseBudget(y, campusId); break;
      case 'payroll-cost': body = await this.payrollCost(y, campusId); break;
      case 'reconciliation': body = await this.reconciliation(); break;
      case 'campus-comparison': body = await this.campusComparison(y, campusId); break;
      default: body = await this.auditPack(y, campusId);
    }
    return { key, ...def, academicYear: y.label, campus: campus?.shortName ?? null, generatedAt: new Date().toISOString(), ...body };
  }

  private async campusNames() {
    const rows = await this.prisma.campus.findMany({ select: { id: true, shortName: true }, orderBy: { name: 'asc' } });
    return new Map(rows.map((c) => [c.id, c.shortName]));
  }

  private async charges(y: FinanceYear, campusId?: string) {
    return this.prisma.financeCharge.findMany({
      where: { AND: [campusId ? { campusId } : {}, this.ledger.accountWhere(y)] },
      select: { studentId: true, campusId: true, classId: true, feeHeadId: true, amount: true, concession: true, paid: true, balance: true, dueDate: true, feeHead: { select: { name: true, sortOrder: true } } },
    });
  }

  // 1 ------------------------------------------------------------------------
  private async feeCollection(y: FinanceYear, campusId?: string) {
    const [charges, names] = await Promise.all([this.charges(y, campusId), this.campusNames()]);
    const groups = new Map<string, { campus: string; head: string; order: number; billed: number; concession: number; collected: number; outstanding: number }>();
    for (const c of charges) {
      const k = `${c.campusId}:${c.feeHead.name}`;
      const g = groups.get(k) ?? { campus: names.get(c.campusId) ?? '', head: c.feeHead.name, order: c.feeHead.sortOrder, billed: 0, concession: 0, collected: 0, outstanding: 0 };
      g.billed += num(c.amount);
      g.concession += num(c.concession);
      g.collected += num(c.paid);
      g.outstanding += num(c.balance);
      groups.set(k, g);
    }
    const list = [...groups.values()].sort((a, b) => a.campus.localeCompare(b.campus) || a.order - b.order);
    const row = (g: { campus: string; head: string; billed: number; concession: number; collected: number; outstanding: number }) => ({
      campus: g.campus, head: g.head, billed: r2(g.billed), concession: r2(g.concession), net: r2(g.billed - g.concession), collected: r2(g.collected),
      outstanding: r2(g.outstanding), rate: `${pct(g.collected, g.billed - g.concession)}%`,
    });
    const rows = list.map(row);
    if (list.length > 1) {
      const t = list.reduce((a, g) => ({ ...a, billed: a.billed + g.billed, concession: a.concession + g.concession, collected: a.collected + g.collected, outstanding: a.outstanding + g.outstanding }),
        { campus: 'All', head: 'Total', billed: 0, concession: 0, collected: 0, outstanding: 0 });
      rows.push(row(t));
    }
    return {
      columns: [
        { key: 'campus', label: 'Campus' }, { key: 'head', label: 'Fee head' }, { key: 'billed', label: 'Billed', money: true },
        { key: 'concession', label: 'Concession', money: true }, { key: 'net', label: 'Net billed', money: true }, { key: 'collected', label: 'Collected', money: true },
        { key: 'outstanding', label: 'Outstanding', money: true }, { key: 'rate', label: 'Collection rate' },
      ],
      rows,
    };
  }

  // 2 ------------------------------------------------------------------------
  private async ageing(y: FinanceYear, campusId?: string) {
    const [charges, names] = await Promise.all([this.charges(y, campusId), this.campusNames()]);
    const classes = await this.prisma.schoolClass.findMany({ where: { id: { in: [...new Set(charges.map((c) => c.classId).filter((x): x is string => !!x))] } }, select: { id: true, name: true, gradeLevel: true } });
    const cls = new Map(classes.map((c) => [c.id, c]));
    const t = today();
    type G = { campus: string; grade: string; level: number; notDue: number; b1: number; b2: number; b3: number; b4: number; students: Set<string> };
    const groups = new Map<string, G>();
    for (const c of charges) {
      const bal = num(c.balance);
      if (bal <= 0.004) continue;
      const k = `${c.campusId}:${c.classId ?? '-'}`;
      const cl = c.classId ? cls.get(c.classId) : undefined;
      const g = groups.get(k) ?? { campus: names.get(c.campusId) ?? '', grade: cl?.name ?? 'Unassigned', level: cl?.gradeLevel ?? 99, notDue: 0, b1: 0, b2: 0, b3: 0, b4: 0, students: new Set<string>() };
      if (c.dueDate >= t) g.notDue += bal;
      else {
        const d = daysBetween(c.dueDate, t);
        if (d <= 30) g.b1 += bal;
        else if (d <= 60) g.b2 += bal;
        else if (d <= 90) g.b3 += bal;
        else g.b4 += bal;
        g.students.add(c.studentId);
      }
      groups.set(k, g);
    }
    const rows = [...groups.values()]
      .sort((a, b) => a.campus.localeCompare(b.campus) || a.level - b.level)
      .map((g) => ({
        campus: g.campus, grade: g.grade, notDue: r2(g.notDue), d0_30: r2(g.b1), d31_60: r2(g.b2), d61_90: r2(g.b3), d90: r2(g.b4),
        overdue: r2(g.b1 + g.b2 + g.b3 + g.b4), accounts: g.students.size,
      }));
    return {
      columns: [
        { key: 'campus', label: 'Campus' }, { key: 'grade', label: 'Grade' }, { key: 'notDue', label: 'Not yet due', money: true },
        { key: 'd0_30', label: '0–30 days', money: true }, { key: 'd31_60', label: '31–60 days', money: true }, { key: 'd61_90', label: '61–90 days', money: true },
        { key: 'd90', label: '90+ days', money: true }, { key: 'overdue', label: 'Total overdue', money: true }, { key: 'accounts', label: 'Accounts overdue' },
      ],
      rows,
    };
  }

  // 3 ------------------------------------------------------------------------
  private async cashFlow(y: FinanceYear, campusId?: string) {
    const charges = (await this.charges(y, campusId)).filter((c) => num(c.balance) > 0.004);
    const t = today();
    const buckets = new Map<string, { period: string; sort: string; instalments: number; students: Set<string>; expected: number }>();
    for (const c of charges) {
      const past = c.dueDate < t;
      const key = past ? '0000-00' : monthOf(c.dueDate);
      const b = buckets.get(key) ?? { period: past ? 'Overdue (past due)' : monthYearLabel(key), sort: key, instalments: 0, students: new Set<string>(), expected: 0 };
      b.instalments += 1;
      b.students.add(c.studentId);
      b.expected += num(c.balance);
      buckets.set(key, b);
    }
    let cumulative = 0;
    const rows = [...buckets.values()].sort((a, b) => a.sort.localeCompare(b.sort)).map((b) => {
      cumulative += b.expected;
      return { period: b.period, instalments: b.instalments, students: b.students.size, expected: r2(b.expected), cumulative: r2(cumulative) };
    });
    return {
      columns: [
        { key: 'period', label: 'Due' }, { key: 'instalments', label: 'Open instalments' }, { key: 'students', label: 'Students' },
        { key: 'expected', label: 'Expected receipts', money: true }, { key: 'cumulative', label: 'Cumulative', money: true },
      ],
      rows,
    };
  }

  // 4 ------------------------------------------------------------------------
  private async concessions(y: FinanceYear, campusId?: string) {
    const list = await this.prisma.financeConcession.findMany({
      where: { ...(campusId ? { campusId } : {}), ...(y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null, createdAt: { gte: y.start } }] } : { createdAt: { gte: y.start } }) },
      select: { type: true, status: true, decidedBy: true, amount: true, appliedAmount: true, studentId: true },
    });
    const groups = new Map<string, { type: string; kind: string; approver: string; status: string; awards: number; students: Set<string>; value: number; applied: number }>();
    for (const c of list) {
      if (c.status === 'Rejected') continue;
      const approver = c.status === 'Approved' ? c.decidedBy ?? '—' : 'Awaiting decision';
      const k = `${c.type}:${approver}`;
      const g = groups.get(k) ?? { type: c.type, kind: AWARD_TYPES.includes(c.type) ? 'Scholarship' : 'Concession', approver, status: c.status === 'Approved' ? 'Approved' : 'Pending', awards: 0, students: new Set<string>(), value: 0, applied: 0 };
      g.awards += 1;
      g.students.add(c.studentId);
      g.value += num(c.amount);
      g.applied += num(c.appliedAmount);
      groups.set(k, g);
    }
    const rejected = list.filter((c) => c.status === 'Rejected').length;
    const rows: Record<string, unknown>[] = [...groups.values()]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.type.localeCompare(b.type) || a.status.localeCompare(b.status))
      .map((g) => ({ kind: g.kind, type: g.type, approver: g.approver, status: g.status, awards: g.awards, students: g.students.size, value: r2(g.value), applied: r2(g.applied) }));
    if (rejected) rows.push({ kind: '—', type: 'Rejected requests', approver: '—', status: 'Rejected', awards: rejected, students: null, value: null, applied: null });
    return {
      columns: [
        { key: 'kind', label: 'Kind' }, { key: 'type', label: 'Type' }, { key: 'approver', label: 'Approved by' }, { key: 'status', label: 'Status' },
        { key: 'awards', label: 'Awards' }, { key: 'students', label: 'Students' }, { key: 'value', label: 'Value', money: true }, { key: 'applied', label: 'Applied to charges', money: true },
      ],
      rows,
    };
  }

  // 5 ------------------------------------------------------------------------
  private async expenseBudget(y: FinanceYear, campusId?: string) {
    const campuses = await this.prisma.campus.findMany({ where: campusId ? { id: campusId } : { isActive: true }, orderBy: { name: 'asc' } });
    const rows: Record<string, unknown>[] = [];
    for (const c of campuses) {
      const v = await this.budgets.view(c.id, y);
      for (const r of v.rows) {
        rows.push({
          campus: c.shortName, department: r.category, owner: r.owner, budget: r.allocated, actual: r.actual, committed: r.committed, projected: r.projected,
          variance: r.variance, utilisation: r.utilisation == null ? '—' : `${r.utilisation}%`,
        });
      }
    }
    return {
      columns: [
        { key: 'campus', label: 'Campus' }, { key: 'department', label: 'Department' }, { key: 'owner', label: 'Owner' }, { key: 'budget', label: 'Budget', money: true },
        { key: 'actual', label: 'Actual', money: true }, { key: 'committed', label: 'Committed', money: true }, { key: 'projected', label: 'Projected', money: true },
        { key: 'variance', label: 'Variance', money: true }, { key: 'utilisation', label: 'Utilisation' },
      ],
      rows,
    };
  }

  // 6 ------------------------------------------------------------------------
  /** Reads the workforce payslips table when it exists; otherwise the report is empty. */
  private async payrollCost(y: FinanceYear, campusId?: string) {
    const columns: ReportColumn[] = [
      { key: 'category', label: 'Category' }, { key: 'employees', label: 'Employees' }, { key: 'payslips', label: 'Payslips' },
      { key: 'gross', label: 'Gross', money: true }, { key: 'deductions', label: 'Deductions', money: true }, { key: 'net', label: 'Net', money: true },
      { key: 'costPerEmployee', label: 'Cost per employee', money: true },
    ];
    try {
      const t = await this.prisma.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('"WorkforcePayslip"')::text AS t`;
      if (!t[0]?.t) return { columns, rows: [] };
      const cols = new Set(
        (await this.prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'WorkforcePayslip'`).map((r) => r.c),
      );
      if (!['category', 'employeeId', 'gross', 'totalDeductions', 'net', 'payMonth', 'campusId'].every((c) => cols.has(c))) return { columns, rows: [] };
      const sql = `SELECT category, COUNT(DISTINCT "employeeId")::int AS employees, COUNT(*)::int AS payslips,
          COALESCE(SUM(gross), 0)::float8 AS gross, COALESCE(SUM("totalDeductions"), 0)::float8 AS deductions, COALESCE(SUM(net), 0)::float8 AS net
        FROM "WorkforcePayslip" WHERE "payMonth" >= $1 AND "payMonth" <= $2 ${campusId ? 'AND "campusId" = $3::uuid' : ''}
        GROUP BY category ORDER BY category`;
      const params: unknown[] = [y.start, y.end, ...(campusId ? [campusId] : [])];
      const rows = await this.prisma.$queryRawUnsafe<{ category: string; employees: number; payslips: number; gross: number; deductions: number; net: number }[]>(sql, ...params);
      const out: Record<string, unknown>[] = rows.map((r) => ({
        category: r.category, employees: r.employees, payslips: r.payslips, gross: r2(r.gross), deductions: r2(r.deductions), net: r2(r.net),
        costPerEmployee: r.employees ? r2(r.gross / r.employees) : 0,
      }));
      if (rows.length > 1) {
        const emp = rows.reduce((s, r) => s + r.employees, 0);
        const gross = rows.reduce((s, r) => s + r.gross, 0);
        out.push({
          category: 'Total', employees: emp, payslips: rows.reduce((s, r) => s + r.payslips, 0), gross: r2(gross),
          deductions: r2(rows.reduce((s, r) => s + r.deductions, 0)), net: r2(rows.reduce((s, r) => s + r.net, 0)), costPerEmployee: emp ? r2(gross / emp) : 0,
        });
      }
      return { columns, rows: out };
    } catch (err) {
      this.log.warn(`Payroll cost report unavailable: ${(err as Error).message}`);
      return { columns, rows: [] };
    }
  }

  // 7 ------------------------------------------------------------------------
  private async reconciliation() {
    const lines = await this.prisma.financeReconLine.findMany({ include: { payment: { select: { receiptNo: true, studentId: true } } }, orderBy: [{ statementDate: 'desc' }, { createdAt: 'desc' }], take: 5000 });
    const info = await this.ledger.studentInfo(lines.map((l) => l.payment?.studentId).filter((x): x is string => !!x));
    return {
      columns: [
        { key: 'date', label: 'Statement date' }, { key: 'channel', label: 'Channel' }, { key: 'reference', label: 'Reference' }, { key: 'amount', label: 'Amount', money: true },
        { key: 'status', label: 'Status' }, { key: 'receipt', label: 'Receipt' }, { key: 'student', label: 'Student' }, { key: 'note', label: 'Note' },
        { key: 'by', label: 'Matched / resolved by' },
      ],
      rows: lines.map((l) => ({
        date: isoDate(l.statementDate), channel: l.channel, reference: l.reference, amount: num(l.amount), status: l.status, receipt: l.payment?.receiptNo ?? null,
        student: l.payment ? info.get(l.payment.studentId)?.fullName ?? null : null, note: l.note, by: l.resolvedBy ?? l.matchedBy,
      })),
    };
  }

  // 8 ------------------------------------------------------------------------
  private async campusComparison(y: FinanceYear, campusId?: string) {
    const campuses = await this.prisma.campus.findMany({ where: campusId ? { id: campusId } : { isActive: true }, orderBy: { name: 'asc' } });
    const ids = campuses.map((c) => c.id);
    const t = today();
    const [charges, students, concessions, expenses, budgets, payments] = await Promise.all([
      this.charges(y, campusId),
      this.prisma.student.groupBy({ by: ['campusId'], where: { status: 'active', campusId: { in: ids } }, _count: { _all: true } }),
      this.prisma.financeConcession.groupBy({
        by: ['campusId'], where: { status: 'Approved', campusId: { in: ids }, ...(y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null }] } : {}) }, _sum: { amount: true },
      }),
      this.prisma.financeExpense.groupBy({ by: ['campusId'], where: { status: { in: ['Approved', 'Paid'] }, campusId: { in: ids }, expenseDate: { gte: y.start, lte: y.end } }, _sum: { amount: true } }),
      this.prisma.financeBudget.groupBy({ by: ['campusId'], where: { campusId: { in: ids }, ...(y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null }] } : {}) }, _sum: { allocated: true } }),
      this.prisma.financePayment.groupBy({ by: ['campusId'], where: { status: 'Success', campusId: { in: ids }, ...this.ledger.paymentYearWhere(y) }, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const rows = campuses.map((c) => {
      const list = charges.filter((x) => x.campusId === c.id);
      const billed = list.reduce((s, x) => s + num(x.amount) - num(x.concession), 0);
      const collected = list.reduce((s, x) => s + num(x.paid), 0);
      const overdue30 = list.filter((x) => num(x.balance) > 0 && daysBetween(x.dueDate, t) > 30).reduce((s, x) => s + num(x.balance), 0);
      const pay = payments.find((p) => p.campusId === c.id);
      return {
        campus: c.shortName,
        students: students.find((s) => s.campusId === c.id)?._count._all ?? 0,
        billed: r2(billed),
        collected: r2(collected),
        outstanding: r2(list.reduce((s, x) => s + num(x.balance), 0)),
        rate: `${pct(collected, billed)}%`,
        overdue30: r2(overdue30),
        transactions: pay?._count._all ?? 0,
        concessions: num(concessions.find((x) => x.campusId === c.id)?._sum.amount),
        expenses: num(expenses.find((x) => x.campusId === c.id)?._sum.amount),
        budget: num(budgets.find((x) => x.campusId === c.id)?._sum.allocated),
      };
    });
    return {
      columns: [
        { key: 'campus', label: 'Campus' }, { key: 'students', label: 'Students' }, { key: 'billed', label: 'Net billed', money: true },
        { key: 'collected', label: 'Collected', money: true }, { key: 'outstanding', label: 'Outstanding', money: true }, { key: 'rate', label: 'Collection rate' },
        { key: 'overdue30', label: 'Overdue 30+ days', money: true }, { key: 'transactions', label: 'Payments' }, { key: 'concessions', label: 'Concessions', money: true },
        { key: 'expenses', label: 'Expenses (approved)', money: true }, { key: 'budget', label: 'Budget', money: true },
      ],
      rows,
    };
  }

  // 9 ------------------------------------------------------------------------
  private async auditPack(y: FinanceYear, campusId?: string) {
    const c = campusId ? { campusId } : {};
    const t = today();
    const payYear = this.ledger.paymentYearWhere(y);
    const [charges, receipts, firstReceipt, lastReceipt, refunded, failed, unreconciled, undelivered, recon, concessions, expenses, claims, budget, auditCount, decisions] = await Promise.all([
      this.charges(y, campusId),
      this.prisma.financePayment.aggregate({ where: { ...c, status: { in: ['Success', 'Refunded'] }, receiptNo: { not: null }, ...payYear }, _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.financePayment.findFirst({ where: { ...c, receiptNo: { not: null }, ...payYear }, orderBy: { paidAt: 'asc' }, select: { receiptNo: true } }),
      this.prisma.financePayment.findFirst({ where: { ...c, receiptNo: { not: null }, ...payYear }, orderBy: { paidAt: 'desc' }, select: { receiptNo: true } }),
      this.prisma.financePayment.aggregate({ where: { ...c, refundedAmount: { gt: 0 }, ...payYear }, _count: { _all: true }, _sum: { refundedAmount: true } }),
      this.prisma.financePayment.count({ where: { ...c, status: 'Failed', ...payYear } }),
      this.prisma.financePayment.aggregate({ where: { ...c, status: 'Success', reconciled: false }, _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.financePayment.count({ where: { ...c, status: 'Success', receiptSentAt: null } }),
      this.prisma.financeReconLine.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.financeConcession.groupBy({
        by: ['status'], where: { ...c, ...(y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null }] } : {}) }, _count: { _all: true }, _sum: { amount: true },
      }),
      this.prisma.financeExpense.groupBy({ by: ['status'], where: { ...c, expenseDate: { gte: y.start, lte: y.end } }, _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.financeReimbursement.groupBy({ by: ['status'], where: { ...c, claimDate: { gte: y.start, lte: y.end } }, _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.financeBudget.aggregate({ where: { ...c, ...(y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null }] } : {}) }, _sum: { allocated: true }, _count: { _all: true } }),
      this.prisma.auditLog.count({ where: { module: 'finance', createdAt: { gte: y.start }, ...(campusId ? { campusId } : {}) } }),
      this.prisma.auditLog.count({ where: { module: 'finance', action: { in: ['approve', 'reject'] }, createdAt: { gte: y.start }, ...(campusId ? { campusId } : {}) } }),
    ]);
    const sum = (f: (x: (typeof charges)[number]) => number) => r2(charges.reduce((s, x) => s + f(x), 0));
    const g = <T extends { status: string; _count: { _all: number } }>(list: T[], status: string | string[]) =>
      list.filter((x) => (Array.isArray(status) ? status.includes(x.status) : x.status === status));
    const cnt = <T extends { status: string; _count: { _all: number } }>(list: T[], s: string | string[]) => g(list, s).reduce((a, x) => a + x._count._all, 0);
    const amt = <T extends { status: string; _count: { _all: number }; _sum: { amount: unknown } }>(list: T[], s: string | string[]) =>
      r2(g(list, s).reduce((a, x) => a + num(x._sum.amount as number | null), 0));
    const row = (section: string, measure: string, value: string | number, reference: string | null = null) => ({ section, measure, value: String(value), reference });
    const rows = [
      row('Fees', 'Gross billed', inr(sum((x) => num(x.amount))), `${charges.length} charge lines`),
      row('Fees', 'Concessions applied', inr(sum((x) => num(x.concession)))),
      row('Fees', 'Collected against charges', inr(sum((x) => num(x.paid)))),
      row('Fees', 'Outstanding', inr(sum((x) => num(x.balance)))),
      row('Fees', 'Overdue more than 30 days', inr(sum((x) => (num(x.balance) > 0 && daysBetween(x.dueDate, t) > 30 ? num(x.balance) : 0)))),
      row('Receipts', 'Receipts issued', receipts._count._all, firstReceipt && lastReceipt ? `${firstReceipt.receiptNo} to ${lastReceipt.receiptNo}` : null),
      row('Receipts', 'Value receipted', inr(num(receipts._sum.amount))),
      row('Receipts', 'Refunds', inr(num(refunded._sum.refundedAmount)), `${refunded._count._all} payment(s)`),
      row('Receipts', 'Failed payment attempts', failed),
      row('Receipts', 'Receipts not yet delivered to parents', undelivered),
      row('Reconciliation', 'Successful payments not yet reconciled', inr(num(unreconciled._sum.amount)), `${unreconciled._count._all} payment(s)`),
      row('Reconciliation', 'Statement lines matched', cnt(recon, 'Matched'), inr(amt(recon, 'Matched'))),
      row('Reconciliation', 'Open exceptions', cnt(recon, 'Exception'), inr(amt(recon, 'Exception'))),
      row('Reconciliation', 'Lines not yet run', cnt(recon, 'Unmatched')),
      row('Reconciliation', 'Resolved with a note', cnt(recon, 'Resolved')),
      row('Concessions', 'Approved', inr(amt(concessions, 'Approved')), `${cnt(concessions, 'Approved')} award(s)`),
      row('Concessions', 'Awaiting decision', inr(amt(concessions, OPEN_APPROVAL)), `${cnt(concessions, OPEN_APPROVAL)} request(s)`),
      row('Concessions', 'Rejected', cnt(concessions, 'Rejected')),
      row('Expenses', 'Approved and paid', inr(amt(expenses, ['Approved', 'Paid'])), `${cnt(expenses, ['Approved', 'Paid'])} expense(s)`),
      row('Expenses', 'Paid', inr(amt(expenses, 'Paid')), `${cnt(expenses, 'Paid')} expense(s)`),
      row('Expenses', 'Awaiting approval', inr(amt(expenses, OPEN_APPROVAL)), `${cnt(expenses, OPEN_APPROVAL)} expense(s)`),
      row('Expenses', 'Rejected', cnt(expenses, 'Rejected')),
      row('Reimbursements', 'Paid', inr(amt(claims, 'Paid')), `${cnt(claims, 'Paid')} claim(s)`),
      row('Reimbursements', 'Approved, to be paid with payroll', inr(amt(claims, 'Approved')), `${cnt(claims, 'Approved')} claim(s)`),
      row('Reimbursements', 'Awaiting decision', inr(amt(claims, OPEN_APPROVAL)), `${cnt(claims, OPEN_APPROVAL)} claim(s)`),
      row('Budgets', 'Annual budget', inr(num(budget._sum.allocated)), `${budget._count._all} budget line(s)`),
      row('Audit trail', 'Finance actions recorded this year', auditCount),
      row('Audit trail', 'Approvals and rejections recorded', decisions),
    ];
    return {
      columns: [{ key: 'section', label: 'Section' }, { key: 'measure', label: 'Measure' }, { key: 'value', label: 'Value' }, { key: 'reference', label: 'Reference' }],
      rows,
    };
  }
}
