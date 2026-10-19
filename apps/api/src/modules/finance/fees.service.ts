import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { like } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { MessagingService } from '../integrations/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  accountStatus, addDays, addToAgg, dateOnly, daysBetween, EMPLOYEE_CATEGORIES, emptyAgg, firstName, inr, isoDate, istDate, istMonth, istStart,
  monthLabel, monthOf, nextMonth, num, pct, PAYMENT_METHODS, prevMonth, r2, roundAgg, sortRows, today, todayIso, type AccountAgg,
} from './finance.util';
import { FinanceLedgerService, type StudentInfo } from './ledger.service';

export interface AccountRow {
  id: string;
  fullName: string;
  admissionNo: string;
  grade: string | null;
  section: string | null;
  campus: string;
  campusId: string;
  billed: number;
  paid: number;
  balance: number;
  overdue: number;
  nextDue: string | null;
  feeStatus: string;
}

const AGE_BUCKETS = ['0–30 days', '31–60 days', '61–90 days', '90+ days'];
const bucketOf = (days: number) => (days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3);

@Injectable()
export class FinanceFeesService {
  private readonly log = new Logger('Finance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ledger: FinanceLedgerService,
    private readonly notifications: NotificationsService,
    private readonly messaging: MessagingService,
  ) {}

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  async lookups() {
    const [heads, cats, employees, vendors] = await Promise.all([
      this.prisma.financeFeeHead.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.financeExpenseCategory.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.employee.findMany({
        where: { archivedAt: null, employmentStatus: { not: 'exited' } },
        select: { id: true, fullName: true, department: true, category: true, campusId: true, employeeType: true, code: true },
        orderBy: { fullName: 'asc' },
      }),
      this.vendors(),
    ]);
    const categories = [...new Set([...EMPLOYEE_CATEGORIES, ...employees.map((e) => e.category).filter(Boolean)])];
    return {
      feeHeads: heads.map((h) => ({ id: h.id, name: h.name })),
      expenseCategories: cats.map((c) => c.name),
      vendors,
      employees: employees.map((e) => ({ id: e.id, code: e.code, fullName: e.fullName, department: e.department, category: e.category, employeeType: e.employeeType, campusId: e.campusId })),
      employeeCategories: categories,
      paymentMethods: PAYMENT_METHODS,
    };
  }

  /** Vendors from the CRM register (admissions module), when that table exists. */
  async vendors(): Promise<{ id: string; name: string }[]> {
    try {
      const t = await this.prisma.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('"CrmVendor"')::text AS t`;
      if (!t[0]?.t) return [];
      return await this.prisma.$queryRaw<{ id: string; name: string }[]>`SELECT id::text AS id, name FROM "CrmVendor" ORDER BY name LIMIT 1000`;
    } catch {
      return [];
    }
  }

  async vendorName(id: string): Promise<string | null> {
    try {
      const t = await this.prisma.$queryRaw<{ t: string | null }[]>`SELECT to_regclass('"CrmVendor"')::text AS t`;
      if (!t[0]?.t) return null;
      const r = await this.prisma.$queryRaw<{ name: string }[]>`SELECT name FROM "CrmVendor" WHERE id = ${id}::uuid`;
      return r[0]?.name ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Fee structures
  // -------------------------------------------------------------------------

  private async structureLines(campusId: string | undefined) {
    const y = await this.ledger.year();
    const lines = await this.prisma.financeFeeStructure.findMany({
      where: { ...(campusId ? { campusId } : {}), ...(y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null }] } : {}) },
      include: { feeHead: { select: { name: true, sortOrder: true } }, _count: { select: { charges: true } } },
    });
    const classes = await this.prisma.schoolClass.findMany({
      where: { id: { in: [...new Set(lines.map((l) => l.classId))] } },
      select: { id: true, name: true, gradeLevel: true, stage: true, campusId: true, campus: { select: { shortName: true, name: true } } },
    });
    const cls = new Map(classes.map((c) => [c.id, c]));
    return lines.map((l) => {
      const c = cls.get(l.classId);
      return {
        id: l.id,
        classId: l.classId,
        class: c?.name ?? 'Class',
        gradeLevel: c?.gradeLevel ?? 0,
        stage: c?.stage?.trim() || 'General',
        campusId: l.campusId,
        campus: c?.campus.shortName ?? '',
        feeHeadId: l.feeHeadId,
        head: l.feeHead.name,
        headOrder: l.feeHead.sortOrder,
        term: l.term,
        amount: num(l.amount),
        dueDate: isoDate(l.dueDate)!,
        applied: l._count.charges,
        status: l.status,
      };
    });
  }

  async structureList(user: AuthUser, q: { q?: string; feeHeadId?: string; status?: string; sort?: string; dir?: 'asc' | 'desc'; campusId?: string }) {
    const campusId = this.scope.campus(user, q.campusId);
    let rows = await this.structureLines(campusId);
    if (q.feeHeadId) rows = rows.filter((r) => r.feeHeadId === q.feeHeadId);
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    if (q.q?.trim()) {
      const t = q.q.trim().toLowerCase();
      rows = rows.filter((r) => [r.class, r.stage, r.head, r.campus, r.term].some((v) => v.toLowerCase().includes(t)));
    }
    const termOrder = (t: string) => ['Annual', 'Term 1', 'Term 2', 'Term 3'].indexOf(t);
    const dir = q.dir ?? 'asc';
    // Stable multi-key default: class, head, instalment.
    rows = sortRows(rows, (r) => termOrder(r.term));
    rows = sortRows(rows, (r) => r.headOrder);
    switch (q.sort) {
      case 'head': return sortRows(rows, (r) => r.headOrder, dir);
      case 'term': return sortRows(rows, (r) => termOrder(r.term), dir);
      case 'amount': return sortRows(rows, (r) => r.amount, dir);
      case 'dueDate': return sortRows(rows, (r) => r.dueDate, dir);
      case 'status': return sortRows(rows, (r) => r.status, dir);
      default: {
        rows = sortRows(rows, (r) => r.gradeLevel, dir);
        return sortRows(rows, (r) => r.campus, dir);
      }
    }
  }

  async structureSummary(user: AuthUser, requestedCampus?: string) {
    const campusId = this.scope.campus(user, requestedCampus);
    const lines = await this.structureLines(campusId);
    const groups = new Map<string, typeof lines>();
    for (const l of lines) {
      const k = `${l.campusId}:${l.stage}`;
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    const classIds = [...new Set(lines.map((l) => l.classId))];
    const counts = classIds.length
      ? await this.prisma.student.groupBy({ by: ['sectionId'], where: { status: 'active', section: { classId: { in: classIds } } }, _count: { _all: true } })
      : [];
    const sections = counts.length
      ? await this.prisma.section.findMany({ where: { id: { in: counts.map((c) => c.sectionId) } }, select: { id: true, classId: true } })
      : [];
    const perClass = new Map<string, number>();
    for (const c of counts) {
      const classId = sections.find((s) => s.id === c.sectionId)?.classId;
      if (classId) perClass.set(classId, (perClass.get(classId) ?? 0) + c._count._all);
    }
    const out = [...groups.values()].map((g) => {
      const live = g.filter((l) => l.status !== 'Archived');
      const use = live.length ? live : g;
      const perYear = (head: string) => {
        const byClass = new Map<string, number>();
        for (const l of use) if (l.head === head) byClass.set(l.classId, (byClass.get(l.classId) ?? 0) + l.amount);
        return byClass.size ? r2(Math.max(...byClass.values())) : 0;
      };
      const tuitionTerms = new Set(use.filter((l) => l.head === 'Tuition').map((l) => l.term));
      const terms = tuitionTerms.size || new Set(use.map((l) => l.term)).size;
      const status = g.some((l) => l.status === 'Active') ? 'Active' : g.some((l) => l.status === 'Draft') ? 'Draft' : 'Archived';
      const cls = [...new Set(g.map((l) => l.classId))];
      return {
        campusId: g[0].campusId,
        campus: g[0].campus,
        stage: g[0].stage,
        fromGrade: Math.min(...g.map((l) => l.gradeLevel)),
        toGrade: Math.max(...g.map((l) => l.gradeLevel)),
        tuition: perYear('Tuition'),
        transport: perYear('Transport'),
        activities: perYear('Activities'),
        terms,
        students: cls.reduce((s, id) => s + (perClass.get(id) ?? 0), 0),
        status,
      };
    });
    return out.sort((a, b) => a.campus.localeCompare(b.campus) || a.fromGrade - b.fromGrade);
  }

  async createStructure(user: AuthUser, dto: { classIds: string[]; feeHeadId: string; term: string; amount: number; dueDate: string; status: string; applyNow?: boolean }) {
    const head = await this.prisma.financeFeeHead.findUnique({ where: { id: dto.feeHeadId } });
    if (!head) throw fieldError('feeHeadId', 'Choose a fee head.');
    const classIds = [...new Set(dto.classIds)];
    const classes = await this.prisma.schoolClass.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true, campusId: true } });
    if (classes.length !== classIds.length) throw fieldError('classIds', 'One of the chosen classes no longer exists.');
    const allowed = this.scope.campus(user, undefined);
    if (allowed && classes.some((c) => c.campusId !== allowed)) throw forbidden('One of the chosen classes is on a campus outside your access');
    const y = await this.ledger.year();
    const existing = await this.prisma.financeFeeStructure.findMany({
      where: { classId: { in: classIds }, feeHeadId: head.id, term: dto.term, status: { not: 'Archived' }, ...(y.id ? { OR: [{ academicYearId: y.id }, { academicYearId: null }] } : {}) },
      select: { classId: true },
    });
    if (existing.length) {
      const names = classes.filter((c) => existing.some((e) => e.classId === c.id)).map((c) => c.name);
      throw fieldError('classIds', `${names.join(', ')} already ${names.length === 1 ? 'has' : 'have'} ${head.name} for ${dto.term}. Archive the existing line first.`);
    }
    const dueDate = dateOnly(dto.dueDate);
    const created = await this.prisma.$transaction(
      classes.map((c) =>
        this.prisma.financeFeeStructure.create({
          data: { campusId: c.campusId, classId: c.id, academicYearId: y.id, feeHeadId: head.id, term: dto.term, amount: r2(dto.amount), dueDate, status: dto.status, createdById: user.id },
        }),
      ),
    );
    let applied = 0;
    if (dto.status === 'Active' && dto.applyNow) for (const s of created) applied += await this.applyStructure(s.id, user);
    return { ids: created.map((c) => c.id), applied, head: head.name, classes: classes.map((c) => c.name) };
  }

  /** Raises a structure line on every enrolled student of its class who does not have it yet. Returns how many charges were raised. */
  async applyStructure(id: string, user: AuthUser | null): Promise<number> {
    const s = await this.prisma.financeFeeStructure.findUnique({ where: { id }, include: { feeHead: true } });
    if (!s) throw notFound('Fee structure line');
    if (s.status !== 'Active') throw badRequest(s.status === 'Draft' ? 'Activate this structure line before applying it.' : 'Archived structure lines cannot be applied.');
    const students = await this.prisma.student.findMany({
      where: {
        status: 'active',
        campusId: s.campusId,
        section: { classId: s.classId },
        ...(s.feeHead.name === 'Transport' ? { transport: { isNot: null } } : {}),
      },
      select: { id: true },
    });
    if (!students.length) return 0;
    const have = await this.prisma.financeCharge.findMany({ where: { structureId: s.id }, select: { studentId: true } });
    const skip = new Set(have.map((h) => h.studentId));
    const todo = students.filter((st) => !skip.has(st.id));
    if (!todo.length) return 0;
    const amount = num(s.amount);
    const r = await this.prisma.financeCharge.createMany({
      data: todo.map((st) => ({
        studentId: st.id, campusId: s.campusId, classId: s.classId, academicYearId: s.academicYearId, structureId: s.id, feeHeadId: s.feeHeadId,
        description: `${s.feeHead.name} — ${s.term}`, amount, balance: amount, dueDate: s.dueDate, createdById: user?.id ?? null,
      })),
      skipDuplicates: true,
    });
    await this.ledger.applyConcessionCredits(todo.map((t) => t.id));
    return r.count;
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  /** Aggregates every relevant charge per student. */
  private async aggregates(where: Prisma.FinanceChargeWhereInput) {
    const y = await this.ledger.year();
    const t = today();
    const charges = await this.prisma.financeCharge.findMany({
      where: { AND: [where, this.ledger.accountWhere(y)] },
      select: { studentId: true, campusId: true, feeHeadId: true, amount: true, concession: true, paid: true, balance: true, dueDate: true },
    });
    const aggs = new Map<string, AccountAgg>();
    for (const c of charges) {
      const a = aggs.get(c.studentId) ?? emptyAgg();
      addToAgg(a, { amount: num(c.amount), concession: num(c.concession), paid: num(c.paid), balance: num(c.balance), dueDate: c.dueDate }, t);
      aggs.set(c.studentId, a);
    }
    return { charges, aggs, t, y };
  }

  private accountRow(s: StudentInfo, agg: AccountAgg | undefined): AccountRow {
    const a = roundAgg(agg ?? emptyAgg());
    return {
      id: s.id, fullName: s.fullName, admissionNo: s.admissionNo, grade: s.grade, section: s.section, campus: s.campus, campusId: s.campusId,
      billed: r2(a.billed - a.concession), paid: a.paid, balance: a.balance, overdue: a.overdue, nextDue: isoDate(a.nextDue), feeStatus: accountStatus(a),
    };
  }

  async accountList(user: AuthUser, q: { q?: string; feeStatus?: string; classId?: string; sort?: string; dir?: 'asc' | 'desc'; campusId?: string }) {
    const studentWhere = await this.scope.studentWhere(user, q.campusId);
    const campusId = this.scope.campus(user, q.campusId);
    const { aggs } = await this.aggregates(campusId ? { campusId } : {});
    const withCharges = [...aggs.keys()];
    const term = q.q?.trim();
    const where: Prisma.StudentWhereInput = {
      AND: [
        studentWhere,
        q.classId ? { section: { classId: q.classId } } : {},
        term
          ? { OR: [{ fullName: like(term) }, { admissionNo: like(term) }], AND: [{ OR: [{ status: 'active' }, { id: { in: withCharges } }] }] }
          : { id: { in: withCharges } },
      ],
    };
    const ids = (await this.prisma.student.findMany({ where, select: { id: true } })).map((s) => s.id);
    const info = await this.ledger.studentInfo(ids);
    let rows = ids.filter((id) => info.has(id)).map((id) => this.accountRow(info.get(id)!, aggs.get(id)));
    if (q.feeStatus) rows = rows.filter((r) => r.feeStatus === q.feeStatus);
    const dir = q.dir ?? 'asc';
    rows = sortRows(rows, (r) => r.fullName);
    switch (q.sort) {
      case 'grade': rows = sortRows(rows, (r) => `${String(info.get(r.id)?.gradeLevel ?? 0).padStart(3, '0')}${r.section ?? ''}`, dir); break;
      case 'billed': rows = sortRows(rows, (r) => r.billed, dir); break;
      case 'paid': rows = sortRows(rows, (r) => r.paid, dir); break;
      case 'balance': rows = sortRows(rows, (r) => r.balance, dir); break;
      case 'overdue': rows = sortRows(rows, (r) => r.overdue, dir); break;
      case 'nextDue': rows = sortRows(rows, (r) => r.nextDue, dir); break;
      case 'feeStatus': rows = sortRows(rows, (r) => r.feeStatus, dir); break;
      default: rows = sortRows(rows, (r) => r.fullName, dir);
    }
    return rows;
  }

  async raiseCharge(user: AuthUser, studentId: string, dto: { feeHeadId: string; description: string; amount: number; dueDate: string }) {
    const info = (await this.ledger.studentInfo([studentId])).get(studentId);
    if (!info) throw notFound('Student');
    const head = await this.prisma.financeFeeHead.findUnique({ where: { id: dto.feeHeadId } });
    if (!head) throw fieldError('feeHeadId', 'Choose a fee head.');
    if (dto.dueDate < todayIso()) throw fieldError('dueDate', 'Choose a due date that is today or later.');
    const y = await this.ledger.year();
    const amount = r2(dto.amount);
    const charge = await this.prisma.financeCharge.create({
      data: {
        studentId, campusId: info.campusId, classId: info.classId, academicYearId: y.id, feeHeadId: head.id, description: dto.description.trim(),
        amount, balance: amount, dueDate: dateOnly(dto.dueDate), createdById: user.id,
      },
    });
    await this.ledger.applyConcessionCredits([studentId]);
    await this.notifications
      .notifyGuardians(studentId, {
        category: 'Information', topic: 'fees', module: 'finance', campusId: info.campusId,
        title: `New charge: ${charge.description}`,
        body: `${inr(amount)} has been added to ${firstName(info.fullName)}'s fee account, due ${dto.dueDate}.`,
        route: '/parent-360?tab=fees',
      })
      .catch((e) => this.log.warn(`Charge notification failed: ${(e as Error).message}`));
    return { charge, info, head: head.name };
  }

  // -------------------------------------------------------------------------
  // Fee collection dashboard
  // -------------------------------------------------------------------------

  async dashboard(user: AuthUser, requestedCampus?: string) {
    const campusId = this.scope.campus(user, requestedCampus);
    const { charges, aggs, t, y } = await this.aggregates(campusId ? { campusId } : {});
    const heads = await this.prisma.financeFeeHead.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    const headName = new Map(heads.map((h) => [h.id, h.name]));

    let billed = 0;
    let collected = 0;
    let outstanding = 0;
    let overdue30 = 0;
    let overdueAll = 0;
    let expected = 0;
    const ageing = [0, 0, 0, 0];
    const monthEnd = dateOnly(`${nextMonth(monthOf(t))}-01`);
    const byHead = new Map<string, { billed: number; collected: number }>();
    for (const c of charges) {
      const net = num(c.amount) - num(c.concession);
      const bal = num(c.balance);
      billed += net;
      collected += num(c.paid);
      outstanding += bal;
      if (bal > 0.004) {
        if (c.dueDate < t) {
          const days = daysBetween(c.dueDate, t);
          overdueAll += bal;
          if (days > 30) overdue30 += bal;
          ageing[bucketOf(days)] += bal;
        } else if (c.dueDate < monthEnd) {
          expected += bal;
        }
      }
      const h = headName.get(c.feeHeadId) ?? 'Other';
      const e = byHead.get(h) ?? { billed: 0, collected: 0 };
      e.billed += net;
      e.collected += num(c.paid);
      byHead.set(h, e);
    }
    const accounts = [...aggs.values()];
    const outstandingAccounts = accounts.filter((a) => a.balance > 0.004).length;
    const overdueAccounts = accounts.filter((a) => a.overdue30 > 0.004).length;

    // Payments: method mix, trend and 30-day delta.
    const now = new Date();
    const paymentWhere: Prisma.FinancePaymentWhereInput = { ...(campusId ? { campusId } : {}), status: 'Success' };
    const yearPayments = await this.prisma.financePayment.findMany({
      where: { ...paymentWhere, OR: [this.ledger.paymentYearWhere(y), { paidAt: { gte: addDays(now, -60) } }] },
      select: { amount: true, method: true, paidAt: true, academicYearId: true },
    });
    const inYear = yearPayments.filter((p) => (y.id ? p.academicYearId === y.id || (!p.academicYearId && p.paidAt >= y.start) : p.paidAt >= y.start));
    const methods = PAYMENT_METHODS.map((label) => ({ label, amount: r2(inYear.filter((p) => p.method === label).reduce((s, p) => s + num(p.amount), 0)) }));
    const methodTotal = methods.reduce((s, m) => s + m.amount, 0);
    const last30 = yearPayments.filter((p) => p.paidAt >= addDays(now, -30)).reduce((s, p) => s + num(p.amount), 0);
    const prev30 = yearPayments.filter((p) => p.paidAt < addDays(now, -30) && p.paidAt >= addDays(now, -60)).reduce((s, p) => s + num(p.amount), 0);

    // Months of the academic year so far (or the last six months before it starts).
    const months: string[] = [];
    const thisMonth = istMonth(now);
    const startKey = monthOf(y.start);
    const endKey = monthOf(y.end) < thisMonth ? monthOf(y.end) : thisMonth;
    if (startKey <= endKey) for (let k = startKey; k <= endKey && months.length < 12; k = nextMonth(k)) months.push(k);
    else for (let k = thisMonth, i = 0; i < 6; i++, k = prevMonth(k)) months.unshift(k);
    const trend = months.map((m) => ({
      month: m,
      label: monthLabel(m),
      billed: r2(charges.filter((c) => monthOf(c.dueDate) === m).reduce((s, c) => s + num(c.amount) - num(c.concession), 0)),
      collected: r2(inYear.filter((p) => istMonth(p.paidAt) === m).reduce((s, p) => s + num(p.amount), 0)),
    }));

    // Campus comparison (every campus the user may see).
    const visible = this.scope.campus(user, undefined);
    const campuses = await this.prisma.campus.findMany({ where: { isActive: true, ...(visible ? { id: visible } : {}) }, orderBy: { name: 'asc' } });
    const campusCharges = campusId && !visible
      ? (await this.aggregates({})).charges
      : charges;
    const byCampus = campuses.map((c) => {
      const list = campusCharges.filter((x) => x.campusId === c.id);
      return { campusId: c.id, label: c.shortName, collected: r2(list.reduce((s, x) => s + num(x.paid), 0)), outstanding: r2(list.reduce((s, x) => s + num(x.balance), 0)) };
    });

    // Accounts more than 30 days overdue, largest first.
    const attentionIds = [...aggs.entries()].filter(([, a]) => a.overdue30 > 0.004).sort((a, b) => b[1].balance - a[1].balance).slice(0, 10);
    const info = await this.ledger.studentInfo(attentionIds.map(([id]) => id));
    const attention = attentionIds
      .filter(([id]) => info.has(id))
      .map(([id, a]) => {
        const s = info.get(id)!;
        return { id, fullName: s.fullName, admissionNo: s.admissionNo, grade: s.grade, section: s.section, campus: s.campus, outstanding: r2(a.balance), overdue: r2(a.overdue), ageDays: a.ageDays, feeStatus: accountStatus(a) };
      });

    return {
      kpis: {
        billed: r2(billed),
        collected: r2(collected),
        collectionPct: pct(collected, billed),
        collected30d: r2(last30),
        collected30dDelta: prev30 ? Math.round(((last30 - prev30) / prev30) * 1000) / 10 : null,
        outstanding: r2(outstanding),
        outstandingAccounts,
        overdue: r2(overdue30),
        overdueAccounts,
        overdueAll: r2(overdueAll),
        expected: r2(expected),
      },
      methods: methods.map((m) => ({ ...m, pct: methodTotal ? Math.round((m.amount / methodTotal) * 100) : 0 })),
      trend,
      ageing: AGE_BUCKETS.map((label, i) => ({ label, value: r2(ageing[i]) })),
      byCampus,
      byHead: [...byHead.entries()]
        .filter(([, v]) => v.billed > 0.004 || v.collected > 0.004)
        .sort((a, b) => (heads.find((h) => h.name === a[0])?.sortOrder ?? 99) - (heads.find((h) => h.name === b[0])?.sortOrder ?? 99))
        .map(([head, v]) => ({ head, billed: r2(v.billed), collected: r2(v.collected) })),
      attention,
      academicYear: y.label,
      generatedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Reminders
  // -------------------------------------------------------------------------

  private async audienceSets(user: AuthUser, requestedCampus?: string) {
    const campusId = this.scope.campus(user, requestedCampus);
    const { charges, aggs, t } = await this.aggregates(campusId ? { campusId } : {});
    const in7 = addDays(t, 7);
    const due7 = new Set(charges.filter((c) => num(c.balance) > 0.004 && c.dueDate >= t && c.dueDate <= in7).map((c) => c.studentId));
    const outstanding = new Set([...aggs.entries()].filter(([, a]) => a.balance > 0.004).map(([id]) => id));
    const overdue30 = new Set([...aggs.entries()].filter(([, a]) => a.overdue30 > 0.004).map(([id]) => id));
    return { outstanding, overdue30, due7, aggs };
  }

  async audience(user: AuthUser, campusId?: string) {
    const s = await this.audienceSets(user, campusId);
    return { outstanding: s.outstanding.size, overdue30: s.overdue30.size, due7: s.due7.size };
  }

  async sendReminders(user: AuthUser, dto: { studentIds?: string[]; audience?: string; channel: string; message: string; campusId?: string }) {
    const sets = await this.audienceSets(user, dto.campusId);
    let ids: string[];
    if (dto.studentIds?.length) {
      for (const id of dto.studentIds) await this.scope.assertStudent(user, id);
      ids = [...new Set(dto.studentIds)].filter((id) => (sets.aggs.get(id)?.balance ?? 0) > 0.004);
      if (!ids.length) throw badRequest('Nothing is outstanding on this account, so no reminder was sent.');
    } else {
      const set = dto.audience === 'outstanding' ? sets.outstanding : dto.audience === 'due7' ? sets.due7 : sets.overdue30;
      ids = [...set];
      if (!ids.length) throw badRequest('No accounts match this audience.');
    }
    const info = await this.ledger.studentInfo(ids);
    const jobs = ids
      .filter((id) => info.has(id))
      .map((id) => {
        const s = info.get(id)!;
        const amount = r2(sets.aggs.get(id)?.balance ?? 0);
        const text = dto.message.replace(/\{student\}/g, firstName(s.fullName)).replace(/\{amount\}/g, inr(amount));
        return { s, amount, text };
      });
    await this.prisma.financeReminder.createMany({
      data: jobs.map((j) => ({ studentId: j.s.id, campusId: j.s.campusId, channel: dto.channel, amount: j.amount, message: j.text, sentById: user.id, sentBy: user.fullName })),
    });
    const run = async () => {
      for (const j of jobs) await this.remindOne(j.s, j.text, dto.channel).catch((e) => this.log.warn(`Reminder to ${j.s.admissionNo} failed: ${(e as Error).message}`));
    };
    if (jobs.length <= 5) await run();
    else void run();
    return { sent: jobs.length, students: jobs.map((j) => j.s.id) };
  }

  /** App notice to the parents' accounts, plus WhatsApp/SMS (directly to guardians without an app account). */
  private async remindOne(s: StudentInfo, text: string, channel: string) {
    const inApp = channel !== 'whatsapp';
    const external = channel === 'sms_app' ? 'sms' : 'whatsapp';
    if (inApp) {
      await this.notifications.notifyGuardians(s.id, {
        category: 'Attention', topic: 'fees', module: 'finance', campusId: s.campusId, title: 'Fee reminder', body: text,
        route: '/parent-360?tab=fees&pay=1', deliver: channel === 'whatsapp_app',
      });
    }
    const links = await this.prisma.studentGuardian.findMany({ where: { studentId: s.id }, include: { guardian: true } });
    const withAccount = new Set(
      (await this.prisma.user.findMany({ where: { parentId: { in: links.map((l) => l.guardianId) }, status: 'active' }, select: { parentId: true } })).map((u) => u.parentId),
    );
    for (const l of links) {
      const phone = l.guardian.phone?.trim();
      if (!phone) continue;
      // Parents with an app account already got WhatsApp through their notification preferences.
      if (channel === 'whatsapp_app' && withAccount.has(l.guardianId)) continue;
      await this.messaging.send(external, { to: phone, body: text }, { entityType: 'finance_reminder', entityId: s.id });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers shared with reports
  // -------------------------------------------------------------------------

  /** IST day start for "today". */
  todayStart() {
    return istStart(todayIso());
  }

  istDate(d: Date) {
    return istDate(d);
  }
}
