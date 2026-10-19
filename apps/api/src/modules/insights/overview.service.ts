import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { PrismaService } from '../../common/prisma.service';
import { FinanceLedgerService } from '../finance/ledger.service';
import { IncidentsService } from '../safety/incidents.service';
import { SettingsService } from '../settings/settings.service';
import { CHANGE_ACTIONS, CommandCenterService, type DashboardQuery, type DashCtx } from './command-center.service';
import { GuardedReadsService } from './guarded-reads.service';
import {
  addDays, andCampus, classLabel, daysAgo, daysBetween, dateOf, istStart, keyOf, mean, monthRange, monthShort, num, pctOrNull, prevMonth, r1, r2,
  ShortCache, sqlDate, sqlTs, todayKey, type YearWindow,
} from './insights.util';

const OPEN = ['Submitted', 'Under Review'];
/** Changes an owner should see by name: deletions, rejections, exports, account and settings changes, money approvals. */
const IMPORTANT: Prisma.AuditLogWhereInput = {
  OR: [
    { action: { in: ['delete', 'reject', 'export'] } },
    { module: { in: ['users', 'settings', 'integrations', 'ai', 'auth'] } },
    { sensitive: true },
    { action: 'approve', module: { in: ['finance', 'payroll', 'workforce', 'group'] } },
  ],
};
const CLIENT_LABEL: Record<string, string> = { web: 'the web app', mobile: 'the mobile app', device: 'a device', system: 'the system' };

export interface ApprovalItem {
  id: string; kind: string; title: string; requestor: string | null; amount: number | null; days: number | null;
  raisedAt: string; deadline: string; to: string; priority: 'High' | 'Medium' | 'Low';
}
export interface ApprovalGroup { label: string; count: number; to: string; icon: string; unit: 'money' | 'days'; total: number; oldest: string | null }

/**
 * GET /dashboard/overview — the Owner / Super Admin landing page: welcome strip, revenue (finance.read),
 * management activity and the school panel (audit.read): standards, goals, approvals, exceptions, governance.
 */
@Injectable()
export class OverviewService {
  private readonly cache = new ShortCache(30_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cc: CommandCenterService,
    private readonly ledger: FinanceLedgerService,
    private readonly incidents: IncidentsService,
    private readonly guarded: GuardedReadsService,
    private readonly settings: SettingsService,
  ) {}

  async get(user: AuthUser, q: DashboardQuery) {
    const ctx = await this.cc.context(user, q);
    const perms = ['finance.read', 'audit.read'].filter((p) => user.permissions.has(p)).join(',');
    return this.cache.get([user.id, ctx.campusId ?? 'group', perms].join('|'), () => this.build(ctx));
  }

  private async build(ctx: DashCtx) {
    const can = (p: string) => ctx.user.permissions.has(p);
    const today = todayKey();
    const y = await this.ledger.year();
    const me = await this.prisma.user.findUnique({ where: { id: ctx.user.id }, select: { prevLoginAt: true, prevLoginIp: true, prevLoginClient: true } });
    const firstVisit = !me?.prevLoginAt;
    const since = me?.prevLoginAt ?? daysAgo(7);

    // One read of the approval queue serves both the activity panel and the final-approvals table.
    const queue = can('audit.read') ? this.approvalQueue(ctx.campusId, today) : null;
    const [welcome, revenue, activity, school] = await Promise.all([
      this.welcome(ctx, since),
      can('finance.read') ? this.revenue(ctx.campusId, y, today) : Promise.resolve(null),
      queue ? this.activity(ctx, since, queue) : Promise.resolve(null),
      queue ? this.school(ctx, y, today, queue) : Promise.resolve(null),
    ]);
    return {
      previousVisit: {
        at: me?.prevLoginAt?.toISOString() ?? null,
        device: me?.prevLoginClient ? CLIENT_LABEL[me.prevLoginClient] ?? me.prevLoginClient : null,
        ip: me?.prevLoginIp ?? null,
        firstVisit,
      },
      welcome,
      revenue,
      activity,
      school,
    };
  }

  // ---------------------------------------------------------------------------
  // Audit trail: welcome strip and management activity
  // ---------------------------------------------------------------------------

  private auditWindow(ctx: DashCtx, since: Date): Prisma.AuditLogWhereInput[] {
    const out: Prisma.AuditLogWhereInput[] = [{ createdAt: { gte: since } }];
    if (ctx.campusId) out.push({ OR: [{ campusId: ctx.campusId }, { campusId: null }] });
    // Without the audit trail, only the areas the role may read are summarised.
    if (!ctx.user.permissions.has('audit.read')) out.push({ module: { in: ctx.user.permissions.has('finance.read') ? ['finance'] : [] } });
    return out;
  }

  /** Changes by other people since the user's last sign-in (or the last seven days). */
  private changesWhere(ctx: DashCtx, since: Date): Prisma.AuditLogWhereInput {
    return { AND: [...this.auditWindow(ctx, since), { action: { in: CHANGE_ACTIONS } }, { userId: { not: ctx.user.id } }] };
  }

  private importantWhere(ctx: DashCtx, since: Date): Prisma.AuditLogWhereInput {
    return {
      AND: [
        ...this.auditWindow(ctx, since),
        { OR: [{ AND: [{ action: { in: CHANGE_ACTIONS } }, { userId: { not: ctx.user.id } }, IMPORTANT] }, { action: { endsWith: '_failed' } }] },
      ],
    };
  }

  private async welcome(ctx: DashCtx, since: Date) {
    const where = this.changesWhere(ctx, since);
    const [changes, people, important] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.groupBy({ by: ['userId'], where }),
      this.prisma.auditLog.count({ where: this.importantWhere(ctx, since) }),
    ]);
    return { changes, people: people.length, important };
  }

  private async activity(ctx: DashCtx, since: Date, approvals: ReturnType<OverviewService['approvalQueue']>) {
    const where = this.changesWhere(ctx, since);
    const [byAction, byModulePerson, byPerson, important, queue] = await Promise.all([
      this.prisma.auditLog.groupBy({ by: ['module', 'action'], where, _count: { _all: true } }),
      this.prisma.auditLog.groupBy({ by: ['module', 'userName'], where, _count: { _all: true } }),
      this.prisma.auditLog.groupBy({ by: ['userId', 'userName', 'role'], where, _count: { _all: true }, _max: { createdAt: true } }),
      this.prisma.auditLog.findMany({
        where: this.importantWhere(ctx, since), orderBy: { createdAt: 'desc' }, take: 20,
        select: { id: true, createdAt: true, userName: true, role: true, action: true, module: true, description: true, entityType: true, entityId: true, device: true, ip: true, metadata: true },
      }),
      approvals,
    ]);

    const modules = new Map<string, { module: string; count: number; actions: { action: string; count: number }[]; topPerson: string | null; topCount: number }>();
    for (const r of byAction) {
      const m = modules.get(r.module) ?? { module: r.module, count: 0, actions: [], topPerson: null, topCount: 0 };
      m.count += r._count._all;
      m.actions.push({ action: r.action, count: r._count._all });
      modules.set(r.module, m);
    }
    for (const r of byModulePerson) {
      const m = modules.get(r.module);
      if (m && r.userName && r._count._all > m.topCount) {
        m.topPerson = r.userName;
        m.topCount = r._count._all;
      }
    }
    const byModule = [...modules.values()]
      .map((m) => ({ ...m, actions: m.actions.sort((a, b) => b.count - a.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const top = byPerson
      .filter((p) => p.userId)
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, 8);
    const personModules = top.length
      ? await this.prisma.auditLog.groupBy({ by: ['userId', 'module'], where: { AND: [where, { userId: { in: top.map((p) => p.userId!) } }] }, _count: { _all: true } })
      : [];
    const people = top.map((p) => ({
      name: p.userName ?? 'Unknown',
      role: p.role ?? '',
      count: p._count._all,
      lastAt: (p._max.createdAt ?? new Date()).toISOString(),
      modules: personModules
        .filter((m) => m.userId === p.userId)
        .map((m) => ({ module: m.module, count: m._count._all }))
        .sort((a, b) => b.count - a.count),
    }));

    return {
      byModule,
      byPerson: people,
      important: important.map((e) => ({
        id: String(e.id), at: e.createdAt.toISOString(), userName: e.userName ?? 'System', role: e.role ?? '', action: e.action, module: e.module,
        description: e.description, entityType: e.entityType, entityId: e.entityId, device: e.device, ip: e.ip,
        metadata: e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>) : null,
      })),
      approvals: queue.groups,
    };
  }

  // ---------------------------------------------------------------------------
  // Approvals waiting on a decision (expenses, concessions, reimbursements, allowances, leave, overtime, payroll)
  // ---------------------------------------------------------------------------

  async approvalQueue(campusId: string | undefined, today: string) {
    const c = campusId ? { campusId } : {};
    const take = 500;
    const [expenses, concessions, reimbursements, allowances, leave, overtime, payroll] = await Promise.all([
      this.prisma.financeExpense.findMany({
        where: { ...c, status: { in: OPEN } }, orderBy: { createdAt: 'asc' }, take,
        select: { id: true, code: true, description: true, amount: true, raisedBy: true, submittedAt: true, createdAt: true },
      }),
      this.prisma.financeConcession.findMany({
        where: { ...c, status: { in: OPEN } }, orderBy: { createdAt: 'asc' }, take,
        select: { id: true, type: true, amount: true, studentId: true, requestedBy: true, createdAt: true },
      }),
      this.prisma.financeReimbursement.findMany({
        where: { ...c, status: { in: OPEN } }, orderBy: { createdAt: 'asc' }, take,
        select: { id: true, code: true, claimType: true, amount: true, employeeId: true, createdAt: true },
      }),
      this.prisma.financeAllowance.findMany({
        where: { ...c, status: 'Submitted' }, orderBy: { createdAt: 'asc' }, take,
        select: { id: true, allowanceType: true, amount: true, employeeId: true, createdAt: true },
      }),
      this.prisma.workforceLeaveRequest.findMany({
        where: { ...c, status: { in: OPEN } }, orderBy: { createdAt: 'asc' }, take,
        select: { id: true, code: true, employeeId: true, days: true, fromDate: true, createdAt: true, leaveType: { select: { name: true } } },
      }),
      this.prisma.workforceOvertime.findMany({
        where: { ...c, status: { in: OPEN } }, orderBy: { createdAt: 'asc' }, take,
        select: { id: true, employeeId: true, hours: true, cost: true, workDate: true, createdAt: true },
      }),
      this.prisma.workforcePayrollRun.findMany({
        where: { ...c, status: 'Under Review' }, orderBy: { createdAt: 'asc' }, take,
        select: { id: true, campusId: true, payMonth: true, gross: true, employeeCount: true, submittedAt: true, submittedById: true, createdAt: true },
      }),
    ]);
    const employeeIds = [...new Set([...reimbursements, ...allowances, ...leave, ...overtime].map((r) => r.employeeId))];
    const [employees, students, campuses, submitters] = await Promise.all([
      employeeIds.length ? this.prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, fullName: true } }) : Promise.resolve([]),
      concessions.length ? this.prisma.student.findMany({ where: { id: { in: [...new Set(concessions.map((x) => x.studentId))] } }, select: { id: true, fullName: true } }) : Promise.resolve([]),
      payroll.length ? this.prisma.campus.findMany({ where: { id: { in: [...new Set(payroll.map((x) => x.campusId))] } }, select: { id: true, shortName: true } }) : Promise.resolve([]),
      payroll.some((p) => p.submittedById)
        ? this.prisma.user.findMany({ where: { id: { in: payroll.map((p) => p.submittedById).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } })
        : Promise.resolve([]),
    ]);
    const emp = new Map(employees.map((e) => [e.id, e.fullName]));
    const stu = new Map(students.map((s) => [s.id, s.fullName]));
    const camp = new Map(campuses.map((x) => [x.id, x.shortName]));
    const subm = new Map(submitters.map((u) => [u.id, u.fullName]));

    const items: ApprovalItem[] = [];
    const groups: ApprovalGroup[] = [];
    const add = (
      group: Omit<ApprovalGroup, 'count' | 'total' | 'oldest'>,
      rows: { id: string; title: string; requestor: string | null; amount: number | null; days: number | null; raised: Date; deadline: string }[],
    ) => {
      if (!rows.length) return;
      groups.push({
        ...group,
        count: rows.length,
        total: r2(rows.reduce((s, r) => s + (group.unit === 'days' ? r.days ?? 0 : r.amount ?? 0), 0)),
        oldest: rows.reduce<Date | null>((o, r) => (!o || r.raised < o ? r.raised : o), null)?.toISOString() ?? null,
      });
      for (const r of rows) {
        const late = r.deadline < today;
        const soon = daysBetween(today, r.deadline) <= 2;
        const amount = r.amount ?? 0;
        const priority: ApprovalItem['priority'] = late || amount >= 100_000 || group.label === 'Payroll runs' ? 'High'
          : amount >= 25_000 || (r.days ?? 0) >= 3 || soon ? 'Medium' : 'Low';
        items.push({
          id: r.id, kind: group.label.replace(/s$/, ''), title: r.title, requestor: r.requestor, amount: r.amount, days: r.days,
          raisedAt: r.raised.toISOString(), deadline: r.deadline, to: group.to, priority,
        });
      }
    };
    const due = (raised: Date, days: number) => addDays(keyOf(new Date(raised.getTime() + 5.5 * 3_600_000)), days);

    add({ label: 'Expense claims', to: '/expenses', icon: 'receipt', unit: 'money' }, expenses.map((x) => {
      const raised = x.submittedAt ?? x.createdAt;
      return { id: x.id, title: `${x.code} · ${x.description}`, requestor: x.raisedBy, amount: num(x.amount), days: null, raised, deadline: due(raised, 7) };
    }));
    add({ label: 'Fee concessions', to: '/concessions', icon: 'wallet', unit: 'money' }, concessions.map((x) => ({
      id: x.id, title: `${x.type} — ${stu.get(x.studentId) ?? 'Student'}`, requestor: x.requestedBy, amount: num(x.amount), days: null,
      raised: x.createdAt, deadline: due(x.createdAt, 7),
    })));
    add({ label: 'Reimbursements', to: '/reimbursements', icon: 'receipt', unit: 'money' }, reimbursements.map((x) => ({
      id: x.id, title: `${x.code} · ${x.claimType}`, requestor: emp.get(x.employeeId) ?? null, amount: num(x.amount), days: null,
      raised: x.createdAt, deadline: due(x.createdAt, 7),
    })));
    add({ label: 'Allowances', to: '/allowances', icon: 'wallet', unit: 'money' }, allowances.map((x) => ({
      id: x.id, title: `${x.allowanceType} — ${emp.get(x.employeeId) ?? 'Employee'}`, requestor: emp.get(x.employeeId) ?? null, amount: num(x.amount), days: null,
      raised: x.createdAt, deadline: due(x.createdAt, 7),
    })));
    add({ label: 'Leave requests', to: '/leave', icon: 'calendar', unit: 'days' }, leave.map((x) => {
      const sla = due(x.createdAt, 3);
      const start = keyOf(x.fromDate);
      return {
        id: x.id, title: `${x.code} · ${x.leaveType.name} from ${start}`, requestor: emp.get(x.employeeId) ?? null, amount: null, days: x.days,
        raised: x.createdAt, deadline: start < sla && start >= keyOf(x.createdAt) ? start : sla,
      };
    }));
    add({ label: 'Overtime claims', to: '/overtime', icon: 'clock', unit: 'money' }, overtime.map((x) => ({
      id: x.id, title: `${num(x.hours)} h overtime on ${keyOf(x.workDate)}`, requestor: emp.get(x.employeeId) ?? null, amount: num(x.cost), days: null,
      raised: x.createdAt, deadline: due(x.createdAt, 7),
    })));
    add({ label: 'Payroll runs', to: '/payroll', icon: 'briefcase', unit: 'money' }, payroll.map((x) => {
      const raised = x.submittedAt ?? x.createdAt;
      return {
        id: x.id, title: `Payroll ${monthShort(keyOf(x.payMonth).slice(0, 7))} ${keyOf(x.payMonth).slice(0, 4)} · ${camp.get(x.campusId) ?? ''} · ${x.employeeCount} staff`,
        requestor: x.submittedById ? subm.get(x.submittedById) ?? null : null, amount: num(x.gross), days: null, raised, deadline: due(raised, 3),
      };
    }));

    const rank = { High: 0, Medium: 1, Low: 2 };
    items.sort((a, b) => rank[a.priority] - rank[b.priority] || a.deadline.localeCompare(b.deadline) || (b.amount ?? 0) - (a.amount ?? 0));
    return {
      groups,
      total: items.length,
      overdue: items.filter((i) => i.deadline < today).length,
      amount: r2(items.reduce((s, i) => s + (i.amount ?? 0), 0)),
      items,
    };
  }

  // ---------------------------------------------------------------------------
  // Revenue
  // ---------------------------------------------------------------------------

  private async revenue(campusId: string | undefined, y: YearWindow, today: string) {
    const scope = this.cc.chargeScope(y);
    const camp = andCampus('c."campusId"', campusId);
    const d30 = sqlDate(addDays(today, -30));
    const d60 = sqlDate(addDays(today, -60));
    const t = sqlDate(today);
    const ym = today.slice(0, 7);
    const monthStart = istStart(`${ym}-01`);
    const lastStart = istStart(`${prevMonth(ym)}-01`);
    const back30 = daysAgo(30);
    const payFrom = lastStart < back30 ? lastStart : back30;
    const months = monthRange(keyOf(y.start), today);
    const outStatuses = ['Approved', 'Paid'];
    const payrollDone = ['Approved', 'Released', 'Paid'];
    const yc = campusId ? { campusId } : {};

    const [totals, heads, classes, owing, collection, paidByMonth, payrollByMonth, expenseByMonth, pendingExp, pendingCon, byCampus] = await Promise.all([
      this.prisma.$queryRaw<Record<string, number>[]>(Prisma.sql`
        SELECT
          COALESCE(SUM(c.amount), 0)::float8 AS gross,
          COALESCE(SUM(c.concession), 0)::float8 AS concession,
          COALESCE(SUM(c.paid), 0)::float8 AS paid,
          COALESCE(SUM(c.balance), 0)::float8 AS balance,
          COALESCE(SUM(c.balance) FILTER (WHERE c.balance > 0 AND c."dueDate" >= ${t}), 0)::float8 AS "notYetDue",
          COALESCE(SUM(c.balance) FILTER (WHERE c.balance > 0 AND c."dueDate" < ${t} AND c."dueDate" >= ${d30}), 0)::float8 AS "due0to30",
          COALESCE(SUM(c.balance) FILTER (WHERE c.balance > 0 AND c."dueDate" < ${d30} AND c."dueDate" >= ${d60}), 0)::float8 AS "due31to60",
          COALESCE(SUM(c.balance) FILTER (WHERE c.balance > 0 AND c."dueDate" < ${d60}), 0)::float8 AS "due60plus",
          COUNT(DISTINCT c."studentId") FILTER (WHERE c.balance > 0 AND c."dueDate" < ${t})::int AS "familiesOverdue"
        FROM "FinanceCharge" c WHERE ${scope} ${camp}`),
      this.prisma.$queryRaw<{ head: string; billed: number; collected: number; concessions: number; outstanding: number }[]>(Prisma.sql`
        SELECT h.name AS head, SUM(c.amount - c.concession)::float8 AS billed, SUM(c.paid)::float8 AS collected,
               SUM(c.concession)::float8 AS concessions, SUM(c.balance)::float8 AS outstanding
        FROM "FinanceCharge" c JOIN "FinanceFeeHead" h ON h.id = c."feeHeadId"
        WHERE ${scope} ${camp}
        GROUP BY h.name, h."sortOrder" ORDER BY h."sortOrder", h.name`),
      this.prisma.$queryRaw<{ grade: string; students: number; outstanding: number; overdue: number }[]>(Prisma.sql`
        SELECT k.name AS grade, COUNT(DISTINCT c."studentId")::int AS students, SUM(c.balance)::float8 AS outstanding,
               COALESCE(SUM(c.balance) FILTER (WHERE c."dueDate" < ${t}), 0)::float8 AS overdue
        FROM "FinanceCharge" c
        JOIN "Student" s ON s.id = c."studentId"
        LEFT JOIN "Section" sec ON sec.id = s."sectionId"
        JOIN "SchoolClass" k ON k.id = COALESCE(c."classId", sec."classId")
        WHERE c.balance > 0 ${camp}
        GROUP BY k.name, k."gradeLevel" ORDER BY k."gradeLevel", k.name`),
      this.prisma.$queryRaw<{ id: string; overdue: number; charges: number; oldest: Date }[]>(Prisma.sql`
        SELECT c."studentId" AS id, SUM(c.balance)::float8 AS overdue, COUNT(*)::int AS charges, MIN(c."dueDate") AS oldest
        FROM "FinanceCharge" c WHERE c.balance > 0 AND c."dueDate" < ${t} ${camp}
        GROUP BY c."studentId" ORDER BY overdue DESC LIMIT 8`),
      this.prisma.$queryRaw<Record<string, number>[]>(Prisma.sql`
        SELECT
          COALESCE(SUM(p.amount - p."refundedAmount") FILTER (WHERE p."paidAt" >= ${sqlTs(monthStart)}), 0)::float8 AS "thisMonth",
          COALESCE(SUM(p.amount - p."refundedAmount") FILTER (WHERE p."paidAt" >= ${sqlTs(lastStart)} AND p."paidAt" < ${sqlTs(monthStart)}), 0)::float8 AS "lastMonth",
          COALESCE(SUM(p.amount - p."refundedAmount") FILTER (WHERE p."paidAt" >= ${sqlTs(back30)}), 0)::float8 AS "last30",
          COUNT(*) FILTER (WHERE p."paidAt" >= ${sqlTs(back30)})::int AS "receipts30"
        FROM "FinancePayment" p WHERE p.status = 'Success' AND p."paidAt" >= ${sqlTs(payFrom)} ${andCampus('p."campusId"', campusId)}`),
      this.prisma.$queryRaw<{ m: string; v: number }[]>(Prisma.sql`
        SELECT to_char((p."paidAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS m, SUM(p.amount - p."refundedAmount")::float8 AS v
        FROM "FinancePayment" p WHERE p.status = 'Success' AND ${this.cc.paymentYear(y)} ${andCampus('p."campusId"', campusId)}
        GROUP BY 1`),
      this.prisma.$queryRaw<{ m: string; v: number; months: number }[]>(Prisma.sql`
        SELECT to_char(r."payMonth", 'YYYY-MM') AS m, SUM(r.gross)::float8 AS v, 1 AS months
        FROM "WorkforcePayrollRun" r
        WHERE r.status IN (${Prisma.join(payrollDone)}) AND r."payMonth" BETWEEN ${sqlDate(y.start)} AND ${sqlDate(y.end)} ${andCampus('r."campusId"', campusId)}
        GROUP BY 1`),
      this.prisma.$queryRaw<{ m: string; v: number }[]>(Prisma.sql`
        SELECT to_char(e."expenseDate", 'YYYY-MM') AS m, SUM(e.amount)::float8 AS v
        FROM "FinanceExpense" e
        WHERE e.status IN (${Prisma.join(outStatuses)}) AND e."expenseDate" BETWEEN ${sqlDate(y.start)} AND ${sqlDate(y.end)} ${andCampus('e."campusId"', campusId)}
        GROUP BY 1`),
      this.prisma.financeExpense.aggregate({ where: { ...yc, status: { in: OPEN } }, _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.financeConcession.aggregate({ where: { ...yc, status: { in: OPEN } }, _count: { _all: true }, _sum: { amount: true } }),
      campusId ? Promise.resolve(null) : this.revenueByCampus(y),
    ]);

    const x = totals[0] ?? {};
    const billed = r2(num(x.gross) - num(x.concession));
    const collected = r2(num(x.paid));
    const paidBy = new Map(paidByMonth.map((r) => [r.m, num(r.v)]));
    const payBy = new Map(payrollByMonth.map((r) => [r.m, num(r.v)]));
    const expBy = new Map(expenseByMonth.map((r) => [r.m, num(r.v)]));
    const expenses = r2([...expBy.values()].reduce((s, v) => s + v, 0));
    const payroll = r2([...payBy.values()].reduce((s, v) => s + v, 0));
    const col = collection[0] ?? {};
    const thisMonth = r2(num(col.thisMonth));
    const lastMonth = r2(num(col.lastMonth));

    const info = await this.ledger.studentInfo(owing.map((o) => o.id));
    return {
      billed,
      collected,
      collectedPct: pctOrNull(collected, billed),
      concessions: r2(num(x.concession)),
      outstanding: r2(num(x.balance)),
      aged: {
        notYetDue: r2(num(x.notYetDue)), due0to30: r2(num(x.due0to30)), due31to60: r2(num(x.due31to60)), due60plus: r2(num(x.due60plus)),
        familiesOverdue: num(x.familiesOverdue),
      },
      collection: {
        thisMonth,
        lastMonth,
        changePct: lastMonth > 0 ? r1(((thisMonth - lastMonth) / lastMonth) * 100) : null,
        last30: r2(num(col.last30)),
        receipts30: num(col.receipts30),
      },
      out: { expenses, payroll, payrollMonths: payBy.size, total: r2(expenses + payroll) },
      net: r2(collected - expenses - payroll),
      pending: {
        expenses: { count: pendingExp._count._all, amount: num(pendingExp._sum.amount) },
        concessions: { count: pendingCon._count._all, amount: num(pendingCon._sum.amount) },
      },
      trend: months.map((m) => ({ month: m, label: monthShort(m), collected: r2(paidBy.get(m) ?? 0), payroll: r2(payBy.get(m) ?? 0), expenses: r2(expBy.get(m) ?? 0) })),
      topOwing: owing.map((o) => {
        const s = info.get(o.id);
        const oldest = keyOf(o.oldest);
        return {
          studentId: o.id, name: s?.fullName ?? 'Student', admissionNo: s?.admissionNo ?? '', className: classLabel(s?.grade, s?.section),
          campus: s?.campus ?? '', overdue: r2(num(o.overdue)), charges: o.charges, oldestDue: oldest, daysOverdue: Math.max(0, daysBetween(oldest, today)),
        };
      }),
      byClass: classes.map((g) => ({ grade: g.grade, students: g.students, outstanding: r2(num(g.outstanding)), overdue: r2(num(g.overdue)) })),
      byHead: heads.map((h) => ({ head: h.head, billed: r2(num(h.billed)), collected: r2(num(h.collected)), concessions: r2(num(h.concessions)), outstanding: r2(num(h.outstanding)) })),
      byCampus: byCampus ?? [],
    };
  }

  private async revenueByCampus(y: YearWindow) {
    const scope = this.cc.chargeScope(y);
    const [campuses, fees, exp, pay] = await Promise.all([
      this.prisma.campus.findMany({ where: { isActive: true }, orderBy: [{ establishedYear: 'asc' }, { name: 'asc' }], select: { id: true, shortName: true } }),
      this.prisma.$queryRaw<{ id: string; billed: number; collected: number; outstanding: number }[]>(Prisma.sql`
        SELECT c."campusId"::text AS id, SUM(c.amount - c.concession)::float8 AS billed, SUM(c.paid)::float8 AS collected, SUM(c.balance)::float8 AS outstanding
        FROM "FinanceCharge" c WHERE ${scope} GROUP BY c."campusId"`),
      this.prisma.financeExpense.groupBy({ by: ['campusId'], where: { status: { in: ['Approved', 'Paid'] }, expenseDate: { gte: y.start, lte: y.end } }, _sum: { amount: true } }),
      this.prisma.workforcePayrollRun.groupBy({ by: ['campusId'], where: { status: { in: ['Approved', 'Released', 'Paid'] }, payMonth: { gte: y.start, lte: y.end } }, _sum: { gross: true } }),
    ]);
    if (campuses.length < 2) return [];
    return campuses.map((c) => {
      const f = fees.find((r) => r.id === c.id);
      const spent = num(exp.find((r) => r.campusId === c.id)?._sum.amount) + num(pay.find((r) => r.campusId === c.id)?._sum.gross);
      return { campus: c.shortName, billed: r2(num(f?.billed)), collected: r2(num(f?.collected)), outstanding: r2(num(f?.outstanding)), spent: r2(spent) };
    });
  }

  // ---------------------------------------------------------------------------
  // The school panel
  // ---------------------------------------------------------------------------

  private async school(ctx: DashCtx, y: YearWindow, today: string, approvals: ReturnType<OverviewService['approvalQueue']>) {
    const [standards, discipline, goals, queue, exceptions, governance] = await Promise.all([
      this.standards(ctx, y, today),
      this.discipline(ctx.campusId, today),
      this.goals(ctx, y, today),
      approvals,
      this.exceptions(ctx, y, today),
      this.governance(),
    ]);
    return {
      standards,
      discipline,
      goals,
      approvals: { total: queue.total, overdue: queue.overdue, amount: queue.amount, items: queue.items.slice(0, 12) },
      exceptions,
      governance,
    };
  }

  private async standards(ctx: DashCtx, y: YearWindow, today: string) {
    const pass = Number(await this.settings.get<number>('academics.pass_mark', 40)) || 40;
    const [marks, curriculum, att] = await Promise.all([
      this.prisma.$queryRaw<{ avg: number | null; assessments: number; assessed: number; below: number }[]>(Prisma.sql`
        WITH marks AS (
          SELECT m."studentId" AS sid, a.id AS aid, (m.marks / a."maxMarks" * 100) AS p
          FROM "AssessmentMark" m JOIN "Assessment" a ON a.id = m."assessmentId"
          WHERE m.marks IS NOT NULL AND m."isAbsent" = false AND a."maxMarks" > 0
            AND a."heldOn" BETWEEN ${sqlDate(y.start)} AND ${sqlDate(y.end)} ${andCampus('a."campusId"', ctx.campusId)}
        ), per AS (SELECT sid, AVG(p) AS p FROM marks GROUP BY sid)
        SELECT (SELECT AVG(p) FROM marks)::float8 AS avg,
               (SELECT COUNT(DISTINCT aid) FROM marks)::int AS assessments,
               (SELECT COUNT(*) FROM per)::int AS assessed,
               (SELECT COUNT(*) FROM per WHERE p < ${pass})::int AS below`),
      this.prisma.curriculumObjective.aggregate({ _avg: { coveragePct: true, masteryPct: true }, _count: { _all: true } }),
      this.prisma.studentAttendance.groupBy({
        by: ['status'], where: { date: { gte: dateOf(addDays(today, -29)), lte: dateOf(today) }, ...(ctx.campusId ? { campusId: ctx.campusId } : {}) }, _count: { _all: true },
      }),
    ]);
    const m = marks[0];
    const marked = att.reduce((s, r) => s + r._count._all, 0);
    const attended = att.filter((r) => r.status === 'present' || r.status === 'late').reduce((s, r) => s + r._count._all, 0);
    const hasObjectives = curriculum._count._all > 0;
    return {
      avgScore: m?.avg != null ? r1(num(m.avg)) : null,
      assessments: m?.assessments ?? 0,
      belowPass: m?.below ?? 0,
      assessed: m?.assessed ?? 0,
      syllabus: hasObjectives ? Math.round(num(curriculum._avg.coveragePct)) : null,
      mastery: hasObjectives ? Math.round(num(curriculum._avg.masteryPct)) : null,
      attendance: pctOrNull(attended, marked),
    };
  }

  private async discipline(campusId: string | undefined, today: string) {
    const c = campusId ? { campusId } : {};
    const [open, escalated, incidents30, behaviour] = await Promise.all([
      this.incidents.openCount(campusId),
      this.prisma.safetyIncident.count({ where: { ...c, status: 'Escalated' } }),
      this.prisma.safetyIncident.count({ where: { ...c, occurredOn: { gte: dateOf(addDays(today, -29)) } } }),
      this.guarded.behaviour(campusId, addDays(today, -29)),
    ]);
    return {
      openIncidents: open.open,
      critical: open.critical,
      escalated,
      incidents30,
      concerns30: behaviour.concerns,
      positive30: behaviour.positives,
    };
  }

  private taskWhere(ctx: DashCtx, y: YearWindow, extra: Prisma.TaskWhereInput = {}): Prisma.TaskWhereInput {
    return {
      AND: [
        { OR: [{ status: { not: 'Completed' } }, { createdAt: { gte: y.start } }] },
        ctx.campusId ? { assignee: { OR: [{ campusId: ctx.campusId }, { campusId: null }] } } : {},
        extra,
      ],
    };
  }

  private async goals(ctx: DashCtx, y: YearWindow, today: string) {
    const c = ctx.campusId ? { campusId: ctx.campusId } : {};
    const t = dateOf(today);
    const overdueTask: Prisma.TaskWhereInput = { status: { not: 'Completed' }, dueOn: { lt: t } };
    const [admitted, target, fees, att, curriculum, staffCount, campuses, staffingSetting, byModule, lateByModule, openByPerson, lateByPerson, milestones, compliance, batches] =
      await Promise.all([
        this.prisma.admissionLead.count({ where: { ...c, stage: 'Enrolled', enrolledAt: { gte: y.start } } }),
        this.settings.get<number>(ctx.campusId ? 'admissions.target' : 'admissions.group_target', 0),
        this.prisma.$queryRaw<{ billed: number; paid: number }[]>(Prisma.sql`
          SELECT COALESCE(SUM(c.amount - c.concession), 0)::float8 AS billed, COALESCE(SUM(c.paid), 0)::float8 AS paid
          FROM "FinanceCharge" c WHERE ${this.cc.chargeScope(y)} ${andCampus('c."campusId"', ctx.campusId)}`),
        this.prisma.studentAttendance.groupBy({ by: ['status'], where: { ...c, date: { gte: dateOf(addDays(today, -29)), lte: t } }, _count: { _all: true } }),
        this.prisma.curriculumObjective.aggregate({ _avg: { coveragePct: true }, _count: { _all: true } }),
        this.prisma.employee.count({ where: { ...c, archivedAt: null, employmentStatus: { not: 'exited' } } }),
        this.prisma.campus.findMany({ where: { isActive: true, ...(ctx.campusId ? { id: ctx.campusId } : {}) }, select: { code: true, staffingTarget: true } }),
        this.settings.get<Record<string, number>>('staffing.target', {}),
        this.prisma.task.groupBy({ by: ['module', 'status'], where: this.taskWhere(ctx, y), _count: { _all: true } }),
        this.prisma.task.groupBy({ by: ['module'], where: this.taskWhere(ctx, y, overdueTask), _count: { _all: true } }),
        this.prisma.task.groupBy({ by: ['assigneeId'], where: this.taskWhere(ctx, y, { status: { not: 'Completed' } }), _count: { _all: true } }),
        this.prisma.task.groupBy({ by: ['assigneeId'], where: this.taskWhere(ctx, y, overdueTask), _count: { _all: true }, _min: { dueOn: true } }),
        this.prisma.innovationMilestone.findMany({
          where: { completedOn: null, dueOn: { lt: t }, project: { status: 'Active', ...c } }, orderBy: { dueOn: 'asc' }, take: 6,
          select: { title: true, dueOn: true, projectId: true, project: { select: { code: true, title: true } } },
        }),
        this.prisma.opsComplianceItem.findMany({ where: { ...c, status: { not: 'Completed' }, dueOn: { lt: t } }, orderBy: { dueOn: 'asc' }, take: 6, select: { item: true, authority: true, dueOn: true } }),
        this.prisma.reportCardBatch.findMany({ where: { ...c, stage: { lt: 5 }, due: { lt: t } }, orderBy: { due: 'asc' }, take: 6, select: { term: true, due: true, sectionId: true, stage: true } }),
      ]);

    // Institutional targets.
    const marked = att.reduce((s, r) => s + r._count._all, 0);
    const attended = att.filter((r) => r.status === 'present' || r.status === 'late').reduce((s, r) => s + r._count._all, 0);
    const f = fees[0];
    const positions = campuses.reduce((s, x) => s + (x.staffingTarget > 0 ? x.staffingTarget : Number(staffingSetting?.[x.code]) || 0), 0);
    const cap = (v: number | null) => (v == null ? null : Math.min(100, Math.round(v)));
    const targets = [
      { label: `Admissions${Number(target) > 0 ? ` (target ${Number(target)})` : ''}`, pct: Number(target) > 0 ? cap((admitted / Number(target)) * 100) : null, to: '/admissions' },
      { label: 'Fee collection', pct: cap(pctOrNull(num(f?.paid), num(f?.billed))), to: '/fees' },
      { label: 'Student attendance (30 days)', pct: cap(pctOrNull(attended, marked)), to: '/attendance' },
      { label: 'Syllabus coverage', pct: curriculum._count._all ? cap(num(curriculum._avg.coveragePct)) : null, to: '/curriculum' },
      { label: 'Staff positions filled', pct: positions > 0 ? cap((staffCount / positions) * 100) : null, to: '/workforce' },
    ];
    const known = targets.map((x) => x.pct).filter((v): v is number => v != null);
    const overall = known.length ? Math.round(mean(known)!) : null;

    // Department progress (tasks by module).
    const deps = new Map<string, { module: string; total: number; done: number; overdue: number }>();
    for (const r of byModule) {
      const d = deps.get(r.module) ?? { module: r.module, total: 0, done: 0, overdue: 0 };
      d.total += r._count._all;
      if (r.status === 'Completed') d.done += r._count._all;
      deps.set(r.module, d);
    }
    for (const r of lateByModule) {
      const d = deps.get(r.module);
      if (d) d.overdue = r._count._all;
    }
    const departments = [...deps.values()].sort((a, b) => b.overdue - a.overdue || b.total - a.total).slice(0, 8);

    // Staff accountability: people with overdue tasks.
    const behind = lateByPerson.sort((a, b) => b._count._all - a._count._all).slice(0, 6);
    const users = behind.length
      ? await this.prisma.user.findMany({ where: { id: { in: behind.map((b) => b.assigneeId) } }, select: { id: true, fullName: true, title: true, role: { select: { name: true } } } })
      : [];
    const sectionIds = batches.map((b) => b.sectionId);
    const sections = sectionIds.length
      ? await this.prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, name: true, class: { select: { name: true } } } })
      : [];
    const staff = behind.map((b) => {
      const u = users.find((x) => x.id === b.assigneeId);
      return {
        name: u?.fullName ?? 'Unknown user',
        role: u?.title || u?.role.name || '',
        open: openByPerson.find((o) => o.assigneeId === b.assigneeId)?._count._all ?? b._count._all,
        overdue: b._count._all,
        oldestDue: b._min.dueOn ? keyOf(b._min.dueOn) : null,
      };
    });

    // Project blockers: overdue milestones, compliance items and report cards.
    const late = (d: Date | null) => (d ? Math.max(1, daysBetween(keyOf(d), today)) : 0);
    const blockers = [
      ...milestones.map((m) => ({ kind: 'Innovation project', title: `${m.project.code} · ${m.title}`, meta: m.project.title, daysLate: late(m.dueOn), to: `/projects/${m.projectId}` })),
      ...compliance.map((x) => ({ kind: 'Compliance', title: x.item, meta: x.authority, daysLate: late(x.dueOn), to: '/compliance' })),
      ...batches.map((b) => {
        const s = sections.find((x) => x.id === b.sectionId);
        return { kind: 'Report cards', title: `${b.term} report cards`, meta: s ? `${s.class.name}${s.name}` : 'Report cards', daysLate: late(b.due), to: '/report-cards' };
      }),
    ].sort((a, b) => b.daysLate - a.daysLate).slice(0, 6);

    return { overall, targets, departments, staff, blockers };
  }

  private async exceptions(ctx: DashCtx, y: YearWindow, today: string) {
    const c = ctx.campusId ? { campusId: ctx.campusId } : {};
    const t = dateOf(today);
    const weekAgo = addDays(today, -7);
    const [marksLate, plansWaiting, safetyOpen, tasksOverdue, tasksHigh, fees60, budgets, spend] = await Promise.all([
      this.prisma.assessment.count({ where: { ...c, status: { not: 'Completed' }, heldOn: { lt: dateOf(weekAgo) } } }),
      this.prisma.lessonPlan.count({ where: { ...c, status: { in: OPEN }, submittedAt: { lt: istStart(weekAgo) } } }),
      this.prisma.safetyIncident.count({ where: { ...c, status: { not: 'Closed' }, OR: [{ severity: 'Critical' }, { status: 'Escalated' }] } }),
      this.prisma.task.count({ where: this.taskWhere(ctx, y, { status: { not: 'Completed' }, dueOn: { lt: t } }) }),
      this.prisma.task.count({ where: this.taskWhere(ctx, y, { status: { not: 'Completed' }, dueOn: { lt: t }, priority: 'High' }) }),
      this.cc.feesOverdue(ctx.campusId, addDays(today, -60)),
      this.prisma.financeBudget.findMany({
        where: { ...c, ...(y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null }] } : {}) },
        select: { campusId: true, category: true, allocated: true },
      }),
      this.prisma.financeExpense.groupBy({
        by: ['campusId', 'category'], where: { ...c, status: { in: ['Approved', 'Paid'] }, expenseDate: { gte: y.start, lte: y.end } }, _sum: { amount: true },
      }),
    ]);
    const spent = new Map(spend.map((s) => [`${s.campusId}|${s.category}`, num(s._sum.amount)]));
    const allocated = new Map<string, number>();
    for (const b of budgets) allocated.set(`${b.campusId}|${b.category}`, (allocated.get(`${b.campusId}|${b.category}`) ?? 0) + num(b.allocated));
    const overBudget = [...allocated].filter(([k, v]) => (spent.get(k) ?? 0) > v).length;
    return {
      marksLate, plansWaiting, safetyOpen, tasksOverdue, tasksHigh,
      fees60: r2(fees60.amount), families60: fees60.accounts, overBudget,
    };
  }

  private async governance() {
    const now = new Date();
    const d30 = daysAgo(30);
    const d7 = daysAgo(7);
    const [campuses, years, sections, subjects, houses, staff, routes, students,
      active, suspended, invited, locked, dormant, rolesInUse, failed7, policies, policyChange, day, week, sensitive, roles] = await Promise.all([
      this.prisma.campus.count(),
      this.prisma.academicYear.count({ where: { isCurrent: true } }),
      this.prisma.section.count(),
      this.prisma.subject.count(),
      this.prisma.house.count(),
      this.prisma.employee.count({ where: { archivedAt: null } }),
      this.prisma.transportRoute.count({ where: { isActive: true } }),
      this.prisma.student.count({ where: { status: 'active' } }),
      this.prisma.user.count({ where: { status: 'active' } }),
      this.prisma.user.count({ where: { status: 'suspended' } }),
      this.prisma.user.count({ where: { status: 'invited' } }),
      this.prisma.user.count({ where: { lockedUntil: { gt: now } } }),
      this.prisma.user.count({ where: { status: 'active', OR: [{ lastLoginAt: { lt: d30 } }, { lastLoginAt: null, createdAt: { lt: d30 } }] } }),
      this.prisma.user.groupBy({ by: ['roleId'], where: { status: 'active' } }),
      this.prisma.auditLog.count({ where: { action: 'login_failed', createdAt: { gte: d7 } } }),
      this.guarded.has('GroupPolicy').then((ok) => (ok ? this.prisma.groupPolicy.groupBy({ by: ['status'], _count: { _all: true } }) : [])),
      this.guarded.has('GroupPolicy').then(async (ok): Promise<Date | null> => (ok ? (await this.prisma.groupPolicy.aggregate({ _max: { updatedAt: true } }))._max.updatedAt : null)),
      this.prisma.auditLog.count({ where: { action: { in: CHANGE_ACTIONS }, createdAt: { gte: daysAgo(1) } } }),
      this.prisma.auditLog.count({ where: { action: { in: CHANGE_ACTIONS }, createdAt: { gte: d7 } } }),
      this.prisma.auditLog.count({ where: { sensitive: true, createdAt: { gte: d7 } } }),
      this.prisma.role.findMany({
        where: { key: { notIn: ['parent', 'student'] } }, orderBy: { sortOrder: 'asc' },
        select: { name: true, _count: { select: { users: { where: { status: 'active' } } } } },
      }),
    ]);
    const checks = [
      { label: 'Campuses', ok: campuses > 0 },
      { label: 'Academic year', ok: years > 0 },
      { label: 'Classes and sections', ok: sections > 0 },
      { label: 'Subjects', ok: subjects > 0 },
      { label: 'Houses', ok: houses > 0 },
      { label: 'Staff records', ok: staff > 0 },
      { label: 'Transport routes', ok: routes > 0 },
      { label: 'Students', ok: students > 0 },
    ];
    const pol = (s: string) => policies.find((p) => p.status === s)?._count._all ?? 0;
    return {
      setup: { pct: Math.round((checks.filter((x) => x.ok).length / checks.length) * 100), checks },
      access: { active, suspended, invited, locked, dormant, roles: rolesInUse.length, failed7 },
      policies: { active: pol('Active'), review: pol('Under review'), draft: pol('Draft'), lastChange: policyChange?.toISOString() ?? null },
      trail: { day, week, sensitive },
      hierarchy: roles.filter((r) => r._count.users > 0).map((r) => ({ role: r.name, users: r._count.users })),
    };
  }
}
