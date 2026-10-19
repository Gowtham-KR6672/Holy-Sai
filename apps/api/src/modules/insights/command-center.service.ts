import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { FinanceLedgerService } from '../finance/ledger.service';
import { IncidentsService } from '../safety/incidents.service';
import { TransportConfig } from '../transport/transport-config.service';
import { GuardedReadsService } from './guarded-reads.service';
import {
  addDays, andCampus, andSections, campusParam, currentTerms, dateOf, istStart, keyOf, monthRange, monthShort, nowTime, num, pctOrNull, plural, r1,
  ShortCache, shortDate, sqlDate, sqlTs, todayKey, WEEKDAYS, weekday, type YearWindow,
} from './insights.util';

export interface DashboardQuery {
  scope?: string;
  campusId?: string;
}

/** Who and what a dashboard covers: the campus (or the group), and a teacher's sections when restricted. */
export interface DashCtx {
  user: AuthUser;
  campusId?: string;
  group: boolean;
  sectionIds: string[] | null;
  /** Active students in scope. */
  students: Prisma.StudentWhereInput;
}

export const CHANGE_ACTIONS = ['create', 'update', 'delete', 'approve', 'reject', 'publish', 'export'];
const PRESENT_STAFF = ['Present', 'Late', 'Half Day'];
const OPEN = ['Submitted', 'Under Review'];
const LEAD_CLOSED = ['Enrolled', 'Lost'];
const FUNNEL: [string, number][] = [['Enquiry', 0], ['Qualified', 2], ['Visit', 4], ['Application', 5], ['Assessment', 6], ['Offer', 7], ['Admission', 8]];

const MODULE_LABEL: Record<string, string> = {
  finance: 'Finance', academics: 'Academics', workforce: 'Staff', safety: 'Safety', admissions: 'Admissions', transport: 'Transport',
  tracking: 'Tracking', students: 'Students', payroll: 'Payroll', earlywarning: 'Early Warning', operations: 'Operations', parents: 'Parents',
  communication: 'Communication', group: 'Group', innovation: 'Innovation Lab', reports: 'Reports', users: 'Users & roles', settings: 'Settings',
  intelligence: 'Intelligence', assessments: 'Assessments', attendance: 'Attendance',
};
export const moduleLabel = (m: string) => MODULE_LABEL[m] ?? m.charAt(0).toUpperCase() + m.slice(1);
const ACTION_ICON: Record<string, string> = {
  create: 'plus', update: 'edit', delete: 'trash', approve: 'check', reject: 'x', publish: 'megaphone', export: 'download',
};
const TONE_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2, success: 3 };

interface AttentionItem { tone: string; icon: string; title: string; meta: string; route: string; count: number }

/**
 * GET /dashboard/command-center — the Principal / Management home, the dashboard picture (SchoolPulse)
 * and the live figures of the prototype screens. Every figure is an aggregate over the module tables,
 * scoped to the campus in the header (or the whole group).
 */
@Injectable()
export class CommandCenterService {
  private readonly cache = new ShortCache(20_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ledger: FinanceLedgerService,
    private readonly incidents: IncidentsService,
    private readonly transportConfig: TransportConfig,
    private readonly guarded: GuardedReadsService,
  ) {}

  /** Resolves the campus (or group) and the student scope for a dashboard request. */
  async context(user: AuthUser, q: DashboardQuery): Promise<DashCtx> {
    const group = q.scope === 'group';
    const campusId = this.scope.campus(user, group ? undefined : campusParam(q.campusId));
    const restricted = user.scope === 'class' && !user.permissions.has('students.read');
    const sectionIds = restricted ? await this.scope.teacherSectionIds(user) : null;
    let students: Prisma.StudentWhereInput = {
      status: 'active',
      ...(campusId ? { campusId } : {}),
      ...(sectionIds ? { sectionId: { in: sectionIds } } : {}),
    };
    if (user.scope === 'family' || user.scope === 'self') students = { AND: [{ status: 'active' }, await this.scope.studentWhere(user, campusId)] };
    return { user, campusId, group: !campusId, sectionIds, students };
  }

  async get(user: AuthUser, q: DashboardQuery) {
    const ctx = await this.context(user, q);
    const perms = [...user.permissions].sort().join(',');
    const key = [user.id, ctx.campusId ?? 'group', ctx.sectionIds ? 'class' : 'all', perms].join('|');
    return this.cache.get(key, () => this.build(ctx));
  }

  private async build(ctx: DashCtx) {
    const can = (p: string) => ctx.user.permissions.has(p);
    const today = todayKey();
    const y = await this.ledger.year();
    const { current: term } = currentTerms(y, today);
    const c = ctx.campusId ? { campusId: ctx.campusId } : {};

    const [students, attendance, staff, admissions, finance, fees60, earlyWarning, parentEngagement, academic, approvals, tracking, history, signals] =
      await Promise.all([
        this.studentBands(ctx),
        this.attendance(ctx, today),
        this.staff(ctx.campusId, today),
        can('admissions.read') ? this.admissions(ctx.campusId, y, today) : Promise.resolve(undefined),
        can('finance.read') ? this.finance(ctx.campusId, y, today) : Promise.resolve(undefined),
        can('finance.read') ? this.feesOverdue(ctx.campusId, addDays(today, -60)) : Promise.resolve(null),
        can('earlywarning.read') ? this.guarded.earlyWarning(ctx.campusId, term.start, today) : Promise.resolve(undefined),
        this.parentEngagement(ctx),
        this.academicByGrade(ctx, y, today),
        this.approvals(ctx.campusId),
        can('tracking.read_all') ? this.tracking(ctx) : Promise.resolve(undefined),
        this.history(ctx, today),
        this.signals(ctx, today, c),
      ]);

    // ---- Today's attention, ranked by urgency -----------------------------
    const attention: AttentionItem[] = [];
    const push = (x: AttentionItem) => {
      if (x.count > 0) attention.push(x);
    };
    if (signals.safety) {
      push({ tone: 'critical', icon: 'shield', title: 'Critical or escalated incidents open', count: signals.safety.urgent,
        meta: `${plural(signals.safety.open, 'incident')} open · ${signals.safety.safeguarding} safeguarding`, route: '/safeguarding' });
    }
    push({ tone: 'critical', icon: 'users', title: 'Students absent 3+ days running', count: attendance.repeatAbsentees,
      meta: 'Call the families and review for Early Warning', route: '/attendance' });
    if (signals.unmarked) {
      push({ tone: 'warning', icon: 'checkSquare', title: 'Attendance registers not submitted', count: signals.unmarked.missing,
        meta: `${signals.unmarked.missing} of ${plural(signals.unmarked.sections, 'class', 'classes')} not marked today`, route: '/attendance' });
    }
    if (signals.buses) {
      push({ tone: 'warning', icon: 'bus', title: signals.buses.length === 1 ? 'Bus running late' : 'Buses running late', count: signals.buses.length,
        meta: signals.buses.map((b) => `${b.label}${b.delay ? ` +${b.delay} min` : ''}`).join(', '), route: '/bus-tracking' });
    }
    if (earlyWarning) {
      push({ tone: 'warning', icon: 'brain', title: 'Early Warning signals awaiting teacher review', count: earlyWarning.awaitingReview,
        meta: `${earlyWarning.open} open · ${earlyWarning.inIntervention} in intervention`, route: '/early-warning' });
      push({ tone: 'warning', icon: 'clock', title: 'Intervention reviews overdue', count: earlyWarning.overdueReviews,
        meta: 'Past their next review date', route: '/early-warning' });
    }
    if (fees60) {
      push({ tone: 'warning', icon: 'wallet', title: 'Fees unpaid over 60 days', count: fees60.accounts,
        meta: `₹${Math.round(fees60.amount).toLocaleString('en-IN')} across ${plural(fees60.accounts, 'account')}`, route: '/student-accounts' });
    }
    if (admissions) {
      push({ tone: 'warning', icon: 'phone', title: 'Admissions follow-ups overdue', count: admissions.overdueFollowUps,
        meta: `${admissions.unassigned} open ${admissions.unassigned === 1 ? 'enquiry has' : 'enquiries have'} no counsellor`, route: '/leads?overdue=true' });
    }
    if (signals.parents) {
      push({ tone: 'warning', icon: 'message', title: 'Parent queries past the 24-hour reply target', count: signals.parents.over24h,
        meta: `${plural(signals.parents.unanswered, 'query', 'queries')} awaiting a reply`, route: '/parent-communication' });
    }
    if (signals.cover != null) {
      push({ tone: 'warning', icon: 'briefcase', title: 'Duties needing cover today', count: signals.cover,
        meta: 'Rostered staff absent or on leave', route: '/shifts' });
    }
    if (signals.compliance != null) {
      push({ tone: 'warning', icon: 'flag', title: 'Compliance items overdue', count: signals.compliance, meta: 'Past their due date', route: '/compliance' });
    }
    push({ tone: 'info', icon: 'checkSquare', title: 'Approvals waiting', count: approvals.total,
      meta: [
        approvals.expenses && plural(approvals.expenses, 'expense'), approvals.leave && plural(approvals.leave, 'leave request'),
        approvals.overtime && `${approvals.overtime} overtime`, approvals.concessions && plural(approvals.concessions, 'concession'),
        approvals.reimbursements && plural(approvals.reimbursements, 'reimbursement'), approvals.certificates && plural(approvals.certificates, 'certificate'),
        approvals.payroll && plural(approvals.payroll, 'payroll run'),
      ].filter(Boolean).join(' · '), route: '/my-tasks' });
    attention.sort((a, b) => (TONE_RANK[a.tone] ?? 9) - (TONE_RANK[b.tone] ?? 9) || b.count - a.count);

    return {
      scope: ctx.group ? 'group' : 'campus',
      generatedAt: new Date().toISOString(),
      students,
      attendance: { ...attendance, today: { ...attendance.today, total: students.total } },
      staff,
      ...(admissions ? { admissions } : {}),
      ...(finance ? { finance } : {}),
      ...(earlyWarning
        ? { earlyWarning: { open: earlyWarning.open, awaitingReview: earlyWarning.awaitingReview, inIntervention: earlyWarning.inIntervention, closedThisTerm: earlyWarning.closedThisTerm } }
        : {}),
      parentEngagement,
      academic,
      approvals,
      ...(tracking ? { tracking } : {}),
      attention,
      activity: signals.activity,
      history,
    };
  }

  // ---------------------------------------------------------------------------
  // Students and attendance
  // ---------------------------------------------------------------------------

  private async studentBands(ctx: DashCtx) {
    const rows = await this.prisma.student.groupBy({ by: ['risk'], where: ctx.students, _count: { _all: true } });
    const n = (r: string) => rows.find((x) => x.risk === r)?._count._all ?? 0;
    const total = rows.reduce((s, r) => s + r._count._all, 0);
    const atRisk = n('At Risk');
    const developing = n('Developing Risk');
    return { total, atRisk, developing, onTrack: Math.max(0, total - atRisk - developing) };
  }

  private attWhere(ctx: DashCtx, extra: Prisma.StudentAttendanceWhereInput): Prisma.StudentAttendanceWhereInput {
    return { ...(ctx.campusId ? { campusId: ctx.campusId } : {}), ...(ctx.sectionIds ? { sectionId: { in: ctx.sectionIds } } : {}), ...extra };
  }

  private async attendance(ctx: DashCtx, today: string) {
    const from = addDays(today, -20);
    const staffWhere: Prisma.WorkforceAttendanceWhereInput = { date: { gte: dateOf(from), lte: dateOf(today) }, ...(ctx.campusId ? { campusId: ctx.campusId } : {}) };
    const [todayRows, trendRows, staffRows, gradeRows, lateRows, absentRows] = await Promise.all([
      this.prisma.studentAttendance.groupBy({ by: ['status'], where: this.attWhere(ctx, { date: dateOf(today) }), _count: { _all: true } }),
      this.prisma.studentAttendance.groupBy({ by: ['date', 'status'], where: this.attWhere(ctx, { date: { gte: dateOf(from), lte: dateOf(today) } }), _count: { _all: true } }),
      ctx.sectionIds ? Promise.resolve([]) : this.prisma.workforceAttendance.groupBy({ by: ['date', 'status'], where: staffWhere, _count: { _all: true } }),
      this.prisma.studentAttendance.groupBy({ by: ['sectionId', 'status'], where: this.attWhere(ctx, { date: { gte: dateOf(addDays(today, -6)), lte: dateOf(today) } }), _count: { _all: true } }),
      this.prisma.studentAttendance.groupBy({
        by: ['arrivalTime'], where: this.attWhere(ctx, { status: 'late', arrivalTime: { not: null }, date: { gte: dateOf(addDays(today, -29)), lte: dateOf(today) } }), _count: { _all: true },
      }),
      this.prisma.studentAttendance.groupBy({ by: ['date'], where: this.attWhere(ctx, { status: 'absent', date: { gte: dateOf(addDays(today, -59)), lte: dateOf(today) } }), _count: { _all: true } }),
    ]);

    const n = (st: string) => todayRows.find((r) => r.status === st)?._count._all ?? 0;
    const t = { present: n('present'), late: n('late'), absent: n('absent'), leave: n('leave') };
    const marked = todayRows.reduce((s, r) => s + r._count._all, 0);

    // Trend: the last ten days with marks.
    const byDay = new Map<string, { marked: number; attended: number }>();
    for (const r of trendRows) {
      const k = keyOf(r.date);
      const d = byDay.get(k) ?? { marked: 0, attended: 0 };
      d.marked += r._count._all;
      if (r.status === 'present' || r.status === 'late') d.attended += r._count._all;
      byDay.set(k, d);
    }
    const days = [...byDay.keys()].filter((k) => k <= today && byDay.get(k)!.marked > 0).sort().slice(-10);
    const trend = days.map((k) => ({ label: shortDate(k), date: k, day: k, value: pctOrNull(byDay.get(k)!.attended, byDay.get(k)!.marked) ?? 0 }));
    const staffByDay = new Map<string, { marked: number; present: number }>();
    for (const r of staffRows) {
      const k = keyOf(r.date);
      const d = staffByDay.get(k) ?? { marked: 0, present: 0 };
      d.marked += r._count._all;
      if (PRESENT_STAFF.includes(r.status)) d.present += r._count._all;
      staffByDay.set(k, d);
    }
    const staffTrend = days.map((k) => {
      const d = staffByDay.get(k);
      return d && d.marked ? pctOrNull(d.present, d.marked) : null;
    });

    // By class over seven days.
    const sectionIds = [...new Set(gradeRows.map((r) => r.sectionId))];
    const sections = sectionIds.length
      ? await this.prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, class: { select: { name: true, gradeLevel: true } } } })
      : [];
    const secClass = new Map(sections.map((s) => [s.id, s.class]));
    const byClass = new Map<string, { grade: string; level: number; marked: number; attended: number }>();
    for (const r of gradeRows) {
      const k = secClass.get(r.sectionId);
      if (!k) continue;
      const g = byClass.get(k.name) ?? { grade: k.name, level: k.gradeLevel, marked: 0, attended: 0 };
      g.marked += r._count._all;
      if (r.status === 'present' || r.status === 'late') g.attended += r._count._all;
      byClass.set(k.name, g);
    }
    const byGrade = [...byClass.values()]
      .sort((a, b) => a.level - b.level || a.grade.localeCompare(b.grade, 'en', { numeric: true }))
      .map((g) => ({ grade: g.grade, level: g.level, present: pctOrNull(g.attended, g.marked) ?? 0 }));

    // Late arrivals in ten-minute bands over thirty days.
    const bins = new Map<string, number>();
    for (const r of lateRows) {
      const m = /^(\d{1,2}):(\d{2})/.exec(r.arrivalTime ?? '');
      if (!m) continue;
      const mins = Number(m[1]) * 60 + Math.floor(Number(m[2]) / 10) * 10;
      const label = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      bins.set(label, (bins.get(label) ?? 0) + r._count._all);
    }
    const lateByTime = [...bins.keys()].sort().map((label) => ({ label, value: bins.get(label)! }));

    // Absences by weekday over sixty days.
    const wd = new Map<number, number>();
    for (const r of absentRows) {
      const d = weekday(keyOf(r.date));
      wd.set(d, (wd.get(d) ?? 0) + r._count._all);
    }
    const weekdayAbsences = [...wd.values()].some((v) => v > 0)
      ? [1, 2, 3, 4, 5, 6].map((dow) => ({ day: WEEKDAYS[dow], dow, absences: wd.get(dow) ?? 0 }))
      : [];

    // Absent on each of the last three marked days.
    const last3 = days.slice(-3);
    let repeatAbsentees = 0;
    if (last3.length === 3) {
      const r = await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
        SELECT COUNT(*)::int AS n FROM (
          SELECT a."studentId" FROM "StudentAttendance" a
          JOIN "Student" s ON s.id = a."studentId" AND s.status = 'active'
          WHERE a.status = 'absent' AND a.date IN (${Prisma.join(last3.map((k) => sqlDate(k)))})
            ${andCampus('a."campusId"', ctx.campusId)} ${andSections('a."sectionId"', ctx.sectionIds)}
          GROUP BY a."studentId" HAVING COUNT(DISTINCT a.date) = 3
        ) x`);
      repeatAbsentees = r[0]?.n ?? 0;
    }

    return {
      today: { ...t, marked, total: 0 },
      todayPct: marked ? pctOrNull(t.present + t.late, marked) : null,
      trend,
      staffTrend,
      byGrade,
      lateByTime,
      weekdayAbsences,
      repeatAbsentees,
    };
  }

  // ---------------------------------------------------------------------------
  // Staff
  // ---------------------------------------------------------------------------

  async staff(campusId: string | undefined, today: string) {
    const c = campusId ? { campusId } : {};
    const d = dateOf(today);
    const [emps, marks, leave] = await Promise.all([
      this.prisma.employee.findMany({ where: { archivedAt: null, employmentStatus: { not: 'exited' }, ...c }, select: { id: true, employeeType: true } }),
      this.prisma.workforceAttendance.findMany({ where: { date: d, ...c }, select: { employeeId: true, status: true } }),
      this.prisma.workforceLeaveRequest.findMany({ where: { status: 'Approved', halfDay: false, fromDate: { lte: d }, toDate: { gte: d }, ...c }, select: { employeeId: true } }),
    ]);
    const mark = new Map(marks.map((m) => [m.employeeId, m.status]));
    const onLeave = new Set(leave.map((l) => l.employeeId));
    const out = { total: emps.length, present: 0, absent: 0, onLeave: 0, late: 0, teaching: 0, nonTeaching: 0, teachingPresent: 0, nonTeachingPresent: 0 };
    const sunday = weekday(today) === 0;
    for (const e of emps) {
      const teaching = e.employeeType === 'teaching';
      if (teaching) out.teaching++;
      else out.nonTeaching++;
      const st = mark.get(e.id) ?? (onLeave.has(e.id) && !sunday ? 'On Leave' : null);
      if (st && PRESENT_STAFF.includes(st)) {
        out.present++;
        if (teaching) out.teachingPresent++;
        else out.nonTeachingPresent++;
      }
      if (st === 'Late') out.late++;
      if (st === 'Absent') out.absent++;
      if (st === 'On Leave') out.onLeave++;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Admissions, finance, parents, academics, approvals, tracking
  // ---------------------------------------------------------------------------

  private async admissions(campusId: string | undefined, y: YearWindow, today: string) {
    const base: Prisma.AdmissionLeadWhereInput = campusId ? { campusId } : {};
    const cohort: Prisma.AdmissionLeadWhereInput = { ...base, createdAt: { gte: y.start } };
    const open: Prisma.AdmissionLeadWhereInput = { ...base, stage: { notIn: LEAD_CLOSED } };
    const now = new Date();
    const [enquiries, enrolledCohort, admitted, thisMonth, unassigned, byStage, bySource, overdueFollowUps, spend] = await Promise.all([
      this.prisma.admissionLead.count({ where: cohort }),
      this.prisma.admissionLead.count({ where: { ...cohort, stage: 'Enrolled' } }),
      this.prisma.admissionLead.count({ where: { ...base, stage: 'Enrolled', enrolledAt: { gte: y.start } } }),
      this.prisma.admissionLead.count({ where: { ...base, createdAt: { gte: istStart(`${today.slice(0, 7)}-01`) } } }),
      this.prisma.admissionLead.count({ where: { ...open, counsellorId: null } }),
      this.prisma.admissionLead.groupBy({ by: ['maxStageIndex'], where: cohort, _count: { _all: true } }),
      this.prisma.admissionLead.groupBy({ by: ['source'], where: cohort, _count: { _all: true } }),
      this.prisma.admissionFollowUp.count({ where: { status: 'Scheduled', scheduledAt: { lt: now }, lead: open } }),
      this.prisma.admissionMarketingSpend.aggregate({ where: { month: { gte: y.start, lte: y.end }, ...(campusId ? { campusId } : {}) }, _sum: { amount: true } }),
    ]);
    const reached = (i: number) => byStage.filter((r) => r.maxStageIndex >= i).reduce((s, r) => s + r._count._all, 0);
    const totalSpend = num(spend._sum.amount);
    return {
      enquiries,
      admitted,
      thisMonth,
      unassigned,
      conversion: pctOrNull(enrolledCohort, enquiries) ?? 0,
      costPerAdmission: totalSpend > 0 && admitted ? Math.round(totalSpend / admitted) : null,
      funnel: FUNNEL.map(([label, idx]) => ({ label, value: reached(idx) })),
      sources: bySource.map((s) => ({ label: s.source, value: s._count._all })).sort((a, b) => b.value - a.value),
      overdueFollowUps,
    };
  }

  /** Charges of the academic year plus older ones still outstanding (the ledger's account view). */
  chargeScope(y: YearWindow, alias = 'c') {
    const a = Prisma.raw(alias);
    const inYear = y.id
      ? Prisma.sql`(${a}."academicYearId" = ${y.id}::uuid OR (${a}."academicYearId" IS NULL AND ${a}."dueDate" BETWEEN ${sqlDate(y.start)} AND ${sqlDate(y.end)}))`
      : Prisma.sql`(${a}."dueDate" BETWEEN ${sqlDate(y.start)} AND ${sqlDate(y.end)})`;
    return Prisma.sql`(${inYear} OR ${a}.balance > 0)`;
  }

  /** Charges billed in the academic year only. */
  chargeYear(y: YearWindow, alias = 'c') {
    const a = Prisma.raw(alias);
    return y.id
      ? Prisma.sql`(${a}."academicYearId" = ${y.id}::uuid OR (${a}."academicYearId" IS NULL AND ${a}."dueDate" BETWEEN ${sqlDate(y.start)} AND ${sqlDate(y.end)}))`
      : Prisma.sql`(${a}."dueDate" BETWEEN ${sqlDate(y.start)} AND ${sqlDate(y.end)})`;
  }

  /** Payments of the academic year. */
  paymentYear(y: YearWindow, alias = 'p') {
    const a = Prisma.raw(alias);
    return y.id
      ? Prisma.sql`(${a}."academicYearId" = ${y.id}::uuid OR (${a}."academicYearId" IS NULL AND ${a}."paidAt" >= ${sqlTs(y.start)}))`
      : Prisma.sql`(${a}."paidAt" >= ${sqlTs(y.start)})`;
  }

  /**
   * Headline fee figures with the ledger's definitions (FinanceLedgerService.feeSnapshot: this year's charges plus
   * older ones still outstanding; billed net of concessions), computed as one aggregate instead of loading charges.
   */
  async feeSnapshot(campusId: string | undefined, y: YearWindow, today: string) {
    const [r, paidToday] = await Promise.all([
      this.prisma.$queryRaw<{ billed: number; collected: number; outstanding: number; overdue: number; accounts: number }[]>(Prisma.sql`
        SELECT COALESCE(SUM(c.amount - c.concession), 0)::float8 AS billed, COALESCE(SUM(c.paid), 0)::float8 AS collected,
               COALESCE(SUM(c.balance), 0)::float8 AS outstanding,
               COALESCE(SUM(c.balance) FILTER (WHERE c.balance > 0 AND c."dueDate" < ${sqlDate(today)}), 0)::float8 AS overdue,
               COUNT(DISTINCT c."studentId") FILTER (WHERE c.balance > 0 AND c."dueDate" < ${sqlDate(today)})::int AS accounts
        FROM "FinanceCharge" c WHERE ${this.chargeScope(y)} ${andCampus('c."campusId"', campusId)}`),
      this.prisma.financePayment.aggregate({
        where: { ...(campusId ? { campusId } : {}), status: 'Success', paidAt: { gte: istStart(today) } },
        _sum: { amount: true },
      }),
    ]);
    const x = r[0];
    const billed = num(x?.billed);
    const collected = num(x?.collected);
    return {
      billed: Math.round(billed * 100) / 100,
      collected: Math.round(collected * 100) / 100,
      outstanding: Math.round(num(x?.outstanding) * 100) / 100,
      overdue: Math.round(num(x?.overdue) * 100) / 100,
      overdueAccounts: x?.accounts ?? 0,
      collectedToday: num(paidToday._sum.amount),
      collectionPct: billed ? Math.round((collected / billed) * 1000) / 10 : 0,
    };
  }

  private async finance(campusId: string | undefined, y: YearWindow, today: string) {
    const [snap, paid, billed] = await Promise.all([
      this.feeSnapshot(campusId, y, today),
      this.prisma.$queryRaw<{ m: string; v: number }[]>(Prisma.sql`
        SELECT to_char((p."paidAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS m, SUM(p.amount - p."refundedAmount")::float8 AS v
        FROM "FinancePayment" p WHERE p.status = 'Success' AND ${this.paymentYear(y)} ${andCampus('p."campusId"', campusId)}
        GROUP BY 1`),
      this.prisma.$queryRaw<{ m: string; v: number }[]>(Prisma.sql`
        SELECT to_char(c."dueDate", 'YYYY-MM') AS m, SUM(c.amount - c.concession)::float8 AS v
        FROM "FinanceCharge" c WHERE ${this.chargeYear(y)} ${andCampus('c."campusId"', campusId)}
        GROUP BY 1`),
    ]);
    const paidBy = new Map(paid.map((r) => [r.m, num(r.v)]));
    const billedBy = new Map(billed.map((r) => [r.m, num(r.v)]));
    let cumPaid = 0;
    let cumBilled = 0;
    const monthly: { label: string; pct: number }[] = [];
    for (const m of monthRange(keyOf(y.start), today)) {
      cumPaid += paidBy.get(m) ?? 0;
      cumBilled += billedBy.get(m) ?? 0;
      if (cumBilled > 0) monthly.push({ label: monthShort(m), pct: Math.min(100, r1((cumPaid / cumBilled) * 100)) });
    }
    return { ...snap, monthly };
  }

  /** Balances more than `cutoff` past their due date. */
  async feesOverdue(campusId: string | undefined, cutoff: string) {
    const r = await this.prisma.$queryRaw<{ amount: number; accounts: number }[]>(Prisma.sql`
      SELECT COALESCE(SUM(c.balance), 0)::float8 AS amount, COUNT(DISTINCT c."studentId")::int AS accounts
      FROM "FinanceCharge" c WHERE c.balance > 0 AND c."dueDate" < ${sqlDate(cutoff)} ${andCampus('c."campusId"', campusId)}`);
    return { amount: num(r[0]?.amount), accounts: r[0]?.accounts ?? 0 };
  }

  private async parentEngagement(ctx: DashCtx) {
    const msg: Prisma.CommMessageWhereInput = { needsReply: true, ...(ctx.campusId ? { campusId: ctx.campusId } : {}) };
    const [avg, unanswered, oldest] = await Promise.all([
      this.prisma.guardian.aggregate({ where: { students: { some: { student: ctx.students } } }, _avg: { engagementScore: true }, _count: { _all: true } }),
      this.prisma.commMessage.count({ where: msg }),
      this.prisma.commMessage.findFirst({ where: msg, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
    ]);
    return {
      score: avg._count._all ? Math.round(avg._avg.engagementScore ?? 0) : null,
      unanswered,
      oldestUnanswered: oldest?.occurredAt.toISOString() ?? null,
    };
  }

  /** Average mark (% of maximum) by grade for the latest term with results. */
  private async academicByGrade(ctx: DashCtx, y: YearWindow, today: string) {
    const { current, previous } = currentTerms(y, today);
    const run = (from: string, to: string) => this.prisma.$queryRaw<{ grade: string; level: number; average: number }[]>(Prisma.sql`
      SELECT k.name AS grade, k."gradeLevel" AS level, AVG(m.marks / a."maxMarks" * 100)::float8 AS average
      FROM "AssessmentMark" m
      JOIN "Assessment" a ON a.id = m."assessmentId"
      JOIN "SchoolClass" k ON k.id = a."classId"
      JOIN "Student" s ON s.id = m."studentId"
      WHERE m.marks IS NOT NULL AND m."isAbsent" = false AND a."maxMarks" > 0
        AND a."heldOn" BETWEEN ${sqlDate(from)} AND ${sqlDate(to)}
        ${andCampus('a."campusId"', ctx.campusId)} ${andSections('s."sectionId"', ctx.sectionIds)}
      GROUP BY k.name, k."gradeLevel"
      ORDER BY k."gradeLevel", k.name`);
    let rows = await run(current.start, today < current.end ? today : current.end);
    if (!rows.length) rows = await run(previous.start, previous.end);
    return { byGrade: rows.map((r) => ({ grade: r.grade, level: r.level, average: r1(num(r.average)) })) };
  }

  async approvals(campusId: string | undefined) {
    const c = campusId ? { campusId } : {};
    const [fin, leave, overtime, certificates, payroll] = await Promise.all([
      this.ledger.pendingApprovals(campusId),
      this.prisma.workforceLeaveRequest.count({ where: { ...c, status: { in: OPEN } } }),
      this.prisma.workforceOvertime.count({ where: { ...c, status: { in: OPEN } } }),
      this.prisma.opsCertificate.count({ where: { ...c, status: { in: OPEN } } }),
      this.prisma.workforcePayrollRun.count({ where: { ...c, status: 'Under Review' } }),
    ]);
    const out = { expenses: fin.expenses, leave, overtime, concessions: fin.concessions, reimbursements: fin.reimbursements, certificates, payroll };
    return { total: Object.values(out).reduce((s, n) => s + n, 0), ...out };
  }

  private async tracking(ctx: DashCtx) {
    const staleMinutes = await this.transportConfig.staleAfterMinutes();
    const cutoff = new Date(Date.now() - staleMinutes * 60_000);
    const fresh = Prisma.sql`(t."recordedAt" IS NOT NULL AND t.latitude IS NOT NULL AND t.longitude IS NOT NULL AND t."recordedAt" >= ${sqlTs(cutoff)})`;
    const r = await this.prisma.$queryRaw<Record<string, number>[]>(Prisma.sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE s."trackingStatus" = 'active' AND ${fresh})::int AS active,
        COUNT(*) FILTER (WHERE s."trackingStatus" = 'active' AND NOT ${fresh})::int AS offline,
        COUNT(*) FILTER (WHERE s."trackingStatus" = 'paused')::int AS paused,
        COUNT(*) FILTER (WHERE s."trackingStatus" = 'disabled')::int AS disabled,
        COUNT(*) FILTER (WHERE s."trackingStatus" = 'active' AND ${fresh} AND t."locationStatus" = 'at_school')::int AS "atSchool",
        COUNT(*) FILTER (WHERE s."trackingStatus" = 'active' AND ${fresh} AND t."locationStatus" = 'in_transit')::int AS "inTransit",
        COUNT(*) FILTER (WHERE s."trackingStatus" = 'active' AND ${fresh} AND t."locationStatus" = 'at_home')::int AS "atHome"
      FROM "Student" s
      LEFT JOIN "TrackingStudentState" t ON t."studentId" = s.id
      WHERE s.status = 'active' ${andCampus('s."campusId"', ctx.campusId)} ${andSections('s."sectionId"', ctx.sectionIds)}`);
    const x = r[0] ?? {};
    return {
      total: x.total ?? 0, active: x.active ?? 0, offline: x.offline ?? 0, paused: x.paused ?? 0, disabled: x.disabled ?? 0,
      atSchool: x.atSchool ?? 0, inTransit: x.inTransit ?? 0, atHome: x.atHome ?? 0,
    };
  }

  /** Students and staff on the books at each of the last seven month-ends (the current month = today). */
  private async history(ctx: DashCtx, today: string) {
    const first = `${today.slice(0, 7)}-01`;
    const [students, staff] = await Promise.all([
      this.prisma.$queryRaw<{ m: string; n: number }[]>(Prisma.sql`
        WITH months AS (
          SELECT gs::date AS ms, (gs + interval '1 month' - interval '1 day')::date AS me
          FROM generate_series((${sqlDate(first)} - interval '6 months')::timestamp, (${sqlDate(first)})::timestamp, interval '1 month') gs
        )
        SELECT to_char(months.ms, 'YYYY-MM') AS m, COUNT(s.id)::int AS n
        FROM months
        LEFT JOIN "Student" s
          ON COALESCE(s."admittedOn", s."createdAt"::date) <= months.me
         AND (s.status = 'active' OR (s."discontinuedOn" IS NOT NULL AND s."discontinuedOn" > months.me))
         ${andCampus('s."campusId"', ctx.campusId)} ${andSections('s."sectionId"', ctx.sectionIds)}
        GROUP BY months.ms ORDER BY months.ms`),
      this.prisma.$queryRaw<{ m: string; n: number }[]>(Prisma.sql`
        WITH months AS (
          SELECT gs::date AS ms, (gs + interval '1 month' - interval '1 day')::date AS me
          FROM generate_series((${sqlDate(first)} - interval '6 months')::timestamp, (${sqlDate(first)})::timestamp, interval '1 month') gs
        )
        SELECT to_char(months.ms, 'YYYY-MM') AS m, COUNT(e.id)::int AS n
        FROM months
        LEFT JOIN "Employee" e
          ON COALESCE(e."joinDate", e."createdAt"::date) <= months.me
         AND (e."archivedAt" IS NULL OR e."archivedAt"::date > months.me)
         AND (e."employmentStatus" <> 'exited' OR e."updatedAt"::date > months.me)
         ${andCampus('e."campusId"', ctx.campusId)}
        GROUP BY months.ms ORDER BY months.ms`),
    ]);
    return {
      months: students.map((r) => monthShort(r.m)),
      students: students.map((r) => r.n),
      staff: staff.map((r) => r.n),
    };
  }

  // ---------------------------------------------------------------------------
  // Attention signals and live activity
  // ---------------------------------------------------------------------------

  private async signals(ctx: DashCtx, today: string, c: { campusId?: string }) {
    const can = (p: string) => ctx.user.permissions.has(p);
    const schoolDay = weekday(today) !== 0;
    const [safety, unmarked, buses, parents, cover, compliance, activity] = await Promise.all([
      can('safety.read') || can('safety.manage')
        ? Promise.all([
          this.incidents.openCount(ctx.campusId),
          this.prisma.safetyIncident.count({ where: { ...c, status: { not: 'Closed' }, OR: [{ severity: 'Critical' }, { status: 'Escalated' }] } }),
        ]).then(([o, urgent]) => ({ open: o.open, safeguarding: o.safeguarding, urgent }))
        : Promise.resolve(null),
      can('attendance.read') && schoolDay && nowTime() >= '09:30' ? this.unmarkedRegisters(ctx, today) : Promise.resolve(null),
      can('transport.read') ? this.delayedBuses(ctx.campusId, today) : Promise.resolve(null),
      can('communication.read')
        ? Promise.all([
          this.prisma.commMessage.count({ where: { needsReply: true, ...c } }),
          this.prisma.commMessage.count({ where: { needsReply: true, occurredAt: { lt: new Date(Date.now() - 24 * 3_600_000) }, ...c } }),
        ]).then(([unanswered, over24h]) => ({ unanswered, over24h }))
        : Promise.resolve(null),
      can('hr.read') ? this.prisma.workforceRosterEntry.count({ where: { ...c, date: dateOf(today), status: 'Cover needed' } }) : Promise.resolve(null),
      can('operations.read') ? this.prisma.opsComplianceItem.count({ where: { ...c, status: { not: 'Completed' }, dueOn: { lt: dateOf(today) } } }) : Promise.resolve(null),
      this.activity(ctx, today),
    ]);
    return { safety, unmarked, buses, parents, cover, compliance, activity };
  }

  private async unmarkedRegisters(ctx: DashCtx, today: string) {
    const sections = await this.prisma.student.groupBy({ by: ['sectionId'], where: ctx.students });
    const ids = sections.map((s) => s.sectionId);
    if (!ids.length) return { sections: 0, missing: 0 };
    const marked = await this.prisma.studentAttendanceRegister.count({ where: { sectionId: { in: ids }, date: dateOf(today) } });
    return { sections: ids.length, missing: Math.max(0, ids.length - marked) };
  }

  /** Buses running late on today's run. */
  async delayedBuses(campusId: string | undefined, today: string) {
    const routes = await this.prisma.transportRoute.findMany({
      where: { isActive: true, status: { in: ['delayed', 'en_route'] }, ...(campusId ? { campusId } : {}) },
      select: { id: true, code: true, vehicleLabel: true, status: true },
    });
    if (!routes.length) return [];
    const profiles = await this.prisma.transportRouteProfile.findMany({
      where: { routeId: { in: routes.map((r) => r.id) }, runDate: dateOf(today) },
      select: { routeId: true, delayMinutes: true },
    });
    const prof = new Map(profiles.map((p) => [p.routeId, p]));
    return routes
      .filter((r) => prof.has(r.id) && (r.status === 'delayed' || prof.get(r.id)!.delayMinutes > 0))
      .map((r) => ({ label: r.vehicleLabel || r.code, delay: prof.get(r.id)!.delayMinutes }))
      .sort((a, b) => b.delay - a.delay);
  }

  /** Today's gate, transport and system events (newest first). */
  private async activity(ctx: DashCtx, today: string) {
    const can = (p: string) => ctx.user.permissions.has(p);
    const c = ctx.campusId ? { campusId: ctx.campusId } : {};
    const day = dateOf(today);
    const routeIds = ctx.campusId && can('transport.read')
      ? (await this.prisma.transportRoute.findMany({ where: { campusId: ctx.campusId }, select: { id: true } })).map((r) => r.id)
      : null;
    const [audit, gate, boarding] = await Promise.all([
      can('audit.read')
        ? this.prisma.auditLog.findMany({
          where: {
            createdAt: { gte: istStart(today) }, action: { in: CHANGE_ACTIONS }, userId: { not: null }, sensitive: false,
            ...(ctx.campusId ? { OR: [{ campusId: ctx.campusId }, { campusId: null }] } : {}),
          },
          orderBy: { createdAt: 'desc' }, take: 10,
          select: { createdAt: true, description: true, module: true, userName: true, action: true },
        })
        : Promise.resolve([]),
      can('safety.read') || can('safety.manage')
        ? this.prisma.safetyGateEvent.findMany({ where: { day, ...c }, orderBy: { occurredAt: 'desc' }, take: 6, select: { occurredAt: true, studentId: true, direction: true, gate: true, method: true } })
        : Promise.resolve([]),
      can('transport.read')
        ? this.prisma.transportBoardingEvent.findMany({
          where: { runDate: day, ...(routeIds ? { routeId: { in: routeIds } } : {}) },
          orderBy: { occurredAt: 'desc' }, take: 6,
          select: { occurredAt: true, studentId: true, routeId: true, eventType: true, recordedByName: true },
        })
        : Promise.resolve([]),
    ]);
    const studentIds = [...new Set([...gate.map((g) => g.studentId), ...boarding.map((b) => b.studentId)])];
    const [students, routes] = await Promise.all([
      studentIds.length ? this.prisma.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, fullName: true } }) : Promise.resolve([]),
      boarding.length ? this.prisma.transportRoute.findMany({ where: { id: { in: [...new Set(boarding.map((b) => b.routeId))] } }, select: { id: true, code: true, vehicleLabel: true } }) : Promise.resolve([]),
    ]);
    const name = new Map(students.map((s) => [s.id, s.fullName]));
    const bus = new Map(routes.map((r) => [r.id, r.vehicleLabel || r.code]));
    const items = [
      ...audit.map((a) => ({ at: a.createdAt.toISOString(), text: a.description, module: moduleLabel(a.module), by: a.userName ?? 'System', icon: ACTION_ICON[a.action] ?? 'activity' })),
      ...gate.map((g) => ({
        at: g.occurredAt.toISOString(),
        text: `${name.get(g.studentId) ?? 'A student'} ${g.direction === 'in' ? 'arrived at' : 'left through'} the ${g.gate}`,
        module: 'Smart Gate', by: g.method === 'Manual' ? 'Gate staff' : `${g.method} scan`, icon: 'door',
      })),
      ...boarding.map((b) => ({
        at: b.occurredAt.toISOString(),
        text: `${name.get(b.studentId) ?? 'A student'} ${b.eventType === 'boarded' ? 'boarded' : 'got off'} ${bus.get(b.routeId) ?? 'the bus'}`,
        module: 'Transport', by: b.recordedByName ?? 'Attendant', icon: 'bus',
      })),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
  }
}
