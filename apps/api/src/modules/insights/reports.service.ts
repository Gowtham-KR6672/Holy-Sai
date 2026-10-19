import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { fieldError, forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { FinanceLedgerService } from '../finance/ledger.service';
import { SettingsService } from '../settings/settings.service';
import { moduleLabel } from './command-center.service';
import { GroupMetricsService } from './group-metrics.service';
import { GuardedReadsService } from './guarded-reads.service';
import {
  addDays, andCampus, andSections, campusParam, classLabel, daysBetween, dateOf, istKey, istStart, keyOf, keyOrNull, mean, nowTime, num, pctOrNull, r1, r2,
  ShortCache, sortRows, sqlDate, todayKey, weekday, type YearWindow,
} from './insights.util';
import { OverviewService } from './overview.service';
import { available, isSuperAdmin, REPORTS, visibleReports, type ReportDef } from './reports.catalog';

export const MAX_ROWS = 20_000;

export interface ReportColumn { key: string; label: string; numeric?: boolean }
export interface SummaryTile { label: string; value: number; unit?: 'INR' | '%'; tone?: 'amber' | 'teal' | 'critical' | 'info' | 'violet' }
export interface ReportChart { label: string; rows: { label: string; value: number }[] }
type Row = Record<string, unknown>;

export interface BuiltReport {
  columns: ReportColumn[];
  rows: Row[];
  truncated: boolean;
  summary: SummaryTile[];
  chart: ReportChart | null;
  /** The report contains restricted records (safeguarding, confidential): reads are audited as sensitive. */
  sensitive?: boolean;
  generatedAt?: string;
}

export interface ReportParams {
  campusId?: string;
  date?: string;
  from?: string;
  to?: string;
}

interface Ctx {
  user: AuthUser;
  campusId?: string;
  /** A teacher's sections when the user may only see their classes. */
  sectionIds: string[] | null;
  y: YearWindow;
  today: string;
  date: string;
  from: string;
  to: string;
  campusNames: Map<string, string>;
}

interface Pupil {
  id: string; fullName: string; admissionNo: string; risk: string; attendancePct: number | null; averageScore: number | null; scoreTrend: number | null;
  campusId: string; className: string | null; gradeLevel: number; label: string | null;
}

const col = (key: string, label: string, numeric = false): ReportColumn => ({ key, label, ...(numeric ? { numeric: true } : {}) });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GENDER: Record<string, string> = { F: 'Female', M: 'Male', O: 'Other' };
/** "2026-10-19 09:42" on the school clock. */
const stamp = (d: Date | null | undefined) => (d ? `${istKey(d)} ${nowTime(d)}` : null);
const yes = (b: boolean) => (b ? 'Yes' : '');
const PLAN_STATUSES: string[] = ['Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected'];

function tally<T>(rows: T[], key: (r: T) => string | null | undefined, value: (r: T) => number = () => 1) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + value(r));
  }
  return m;
}

function chart(label: string, data: Map<string, number> | [string, number][]): ReportChart | null {
  const rows = [...data]
    .map(([l, v]) => ({ label: l, value: r2(v) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  return rows.length ? { label, rows } : null;
}

function capRows(rows: Row[]) {
  return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * The Report Centre and Reports pages: the catalog, an on-screen preview (searched, sorted and paged) and the
 * CSV export, all produced by the same definition so the export always matches what was reviewed.
 */
@Injectable()
export class ReportsService {
  private readonly cache = new ShortCache(60_000, 40);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ledger: FinanceLedgerService,
    private readonly settings: SettingsService,
    private readonly guarded: GuardedReadsService,
    private readonly metrics: GroupMetricsService,
    private readonly overview: OverviewService,
  ) {}

  catalog(user: AuthUser) {
    return visibleReports(user).map((r) => ({
      key: r.key,
      group: r.group,
      title: r.title,
      description: r.description,
      available: available(user, r),
      requires: r.requires,
      alsoRequires: r.alsoRequires ?? [],
      restricted: !!r.restricted,
      filters: r.filters,
    }));
  }

  /** The definition, if this user may run it. */
  definition(user: AuthUser, key: string): ReportDef {
    const def = REPORTS.find((r) => r.key === key);
    if (!def || (def.restricted && !isSuperAdmin(user))) throw notFound('Report');
    if (!available(user, def)) throw forbidden(`This report needs ${def.requires.join(' or ')}${def.alsoRequires?.length ? ` and ${def.alsoRequires.join(', ')}` : ''}`);
    return def;
  }

  /** Resolves campus, dates and the user's class restriction for a run. */
  async context(user: AuthUser, def: ReportDef, p: ReportParams): Promise<Ctx> {
    const campusId = this.scope.campus(user, campusParam(p.campusId));
    const sectionIds = user.scope === 'class' && !user.permissions.has('students.read') ? await this.scope.teacherSectionIds(user) : null;
    const y = await this.ledger.year();
    const today = todayKey();
    for (const f of ['date', 'from', 'to'] as const) {
      if (p[f] && !DATE_RE.test(p[f]!)) throw fieldError(f, 'Choose a valid date');
    }
    const yearStart = keyOf(y.start);
    const defFrom = def.defaultRange === 'year' ? yearStart : addDays(today, -((def.defaultRange ?? 30) - 1));
    const from = p.from || defFrom;
    const to = p.to || (def.defaultTo === 'yearEnd' ? keyOf(y.end) : today);
    if (from > to) throw fieldError('from', 'The start date must be before the end date');
    const campuses = await this.prisma.campus.findMany({ select: { id: true, shortName: true } });
    return { user, campusId, sectionIds, y, today, date: p.date || today, from, to, campusNames: new Map(campuses.map((c) => [c.id, c.shortName])) };
  }

  /** Builds (or reuses for a minute) a report for these parameters. */
  async run(user: AuthUser, key: string, p: ReportParams): Promise<{ def: ReportDef; ctx: Ctx; built: BuiltReport }> {
    const def = this.definition(user, key);
    const ctx = await this.context(user, def, p);
    const cacheKey = [user.id, key, ctx.campusId ?? 'all', ctx.date, ctx.from, ctx.to].join('|');
    const built = await this.cache.get(cacheKey, async () => ({ ...(await this.build(def, ctx)), generatedAt: new Date().toISOString() }));
    return { def, ctx, built };
  }

  /** Search, sort and page a built report for the viewer. */
  preview(def: ReportDef, built: BuiltReport, q: { q?: string; sort?: string; dir?: 'asc' | 'desc'; page?: number; pageSize?: number }) {
    const term = q.q?.trim().toLowerCase();
    const indexed: Row[] = built.rows.map((r, i) => ({ ...r, __row: i + 1 }));
    let matched = term
      ? indexed.filter((r) => built.columns.some((c) => r[c.key] != null && String(r[c.key]).toLowerCase().includes(term)))
      : indexed;
    const sortCol = q.sort ? built.columns.find((c) => c.key === q.sort) : undefined;
    if (sortCol) {
      matched = sortRows([...matched], (r) => {
        const v = r[sortCol.key];
        if (v == null || v === '') return null;
        return sortCol.numeric ? Number(v) : String(v);
      }, q.dir ?? 'asc');
    }
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, q.pageSize ?? 25));
    return {
      key: def.key,
      group: def.group,
      title: def.title,
      description: def.description,
      generatedAt: built.generatedAt ?? new Date().toISOString(),
      columns: built.columns.map((c) => ({ key: c.key, label: c.label })),
      numeric: built.columns.filter((c) => c.numeric).map((c) => c.key),
      rows: matched.slice((page - 1) * pageSize, page * pageSize),
      matchedRows: matched.length,
      totalRows: built.rows.length,
      truncated: built.truncated,
      summary: built.summary,
      chart: built.chart,
      filters: def.filters,
    };
  }

  /** CSV text with a UTF-8 BOM so spreadsheets show ₹ and names correctly. */
  csv(built: BuiltReport): string {
    const esc = (v: unknown) => {
      let s = v == null ? '' : String(v);
      // Spreadsheet formula injection: text starting with = + - @ is kept as text.
      if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [built.columns.map((c) => esc(c.label)).join(',')];
    for (const r of built.rows) lines.push(built.columns.map((c) => esc(r[c.key])).join(','));
    return `\u{FEFF}${lines.join('\r\n')}`;
  }

  // ---------------------------------------------------------------------------
  // Builders
  // ---------------------------------------------------------------------------

  private build(def: ReportDef, ctx: Ctx): Promise<BuiltReport> {
    switch (def.key) {
      case 'student-register': return this.studentRegister(ctx);
      case 'attendance-daily': return this.attendanceDaily(ctx);
      case 'attendance-low': return this.attendanceLow(ctx);
      case 'students-at-risk': return this.studentsAtRisk(ctx);
      case 'assessment-results': return this.assessmentResults(ctx);
      case 'class-performance': return this.classPerformance(ctx);
      case 'homework-completion': return this.homeworkCompletion(ctx);
      case 'lesson-plan-status': return this.lessonPlans(ctx);
      case 'safety-log': return this.safetyLog(ctx);
      case 'visitor-log': return this.visitorLog(ctx);
      case 'transport-routes': return this.transportRoutes(ctx);
      case 'staff-attendance': return this.staffAttendance(ctx);
      case 'maintenance-open': return this.maintenance(ctx);
      case 'compliance-calendar': return this.compliance(ctx);
      case 'admissions-funnel': return this.admissionsFunnel(ctx);
      case 'fee-defaulters': return this.feeDefaulters(ctx);
      case 'staff-summary': return this.staffSummary(ctx);
      case 'leave-register': return this.leaveRegister(ctx);
      case 'pending-approvals': return this.pendingApprovals(ctx);
      case 'campus-summary': return this.campusSummary(ctx);
      case 'user-access': return this.userAccess(ctx);
      case 'sign-in-activity': return this.signIns(ctx);
      case 'role-matrix': return this.roleMatrix();
      case 'audit-trail': return this.auditTrail(ctx);
      default: throw notFound('Report');
    }
  }

  private studentScope(ctx: Ctx): Prisma.StudentWhereInput {
    return { status: 'active', ...(ctx.campusId ? { campusId: ctx.campusId } : {}), ...(ctx.sectionIds ? { sectionId: { in: ctx.sectionIds } } : {}) };
  }

  private campus(ctx: Ctx, id: string | null | undefined) {
    return id ? ctx.campusNames.get(id) ?? '' : '';
  }

  /** Class, campus and indicators for students (batched). */
  private async pupils(ids: string[]): Promise<Map<string, Pupil>> {
    const out = new Map<string, Pupil>();
    for (const part of chunks([...new Set(ids)], 5000)) {
      const rows = await this.prisma.student.findMany({
        where: { id: { in: part } },
        select: {
          id: true, fullName: true, admissionNo: true, risk: true, attendancePct: true, averageScore: true, scoreTrend: true, campusId: true,
          section: { select: { name: true, class: { select: { name: true, gradeLevel: true } } } },
        },
      });
      for (const s of rows) {
        out.set(s.id, {
          id: s.id, fullName: s.fullName, admissionNo: s.admissionNo, risk: s.risk, attendancePct: s.attendancePct, averageScore: s.averageScore,
          scoreTrend: s.scoreTrend, campusId: s.campusId, className: s.section?.class.name ?? null, gradeLevel: s.section?.class.gradeLevel ?? 0,
          label: classLabel(s.section?.class.name, s.section?.name),
        });
      }
    }
    return out;
  }

  /** Employee names (batched). */
  private async employees(ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const out = new Map<string, { fullName: string; department: string; designation: string }>();
    for (const part of chunks(list, 5000)) {
      const rows = await this.prisma.employee.findMany({ where: { id: { in: part } }, select: { id: true, fullName: true, department: true, designation: true } });
      for (const e of rows) out.set(e.id, e);
    }
    return out;
  }

  // ---- Students --------------------------------------------------------------

  private async studentRegister(ctx: Ctx): Promise<BuiltReport> {
    const list = await this.prisma.student.findMany({
      where: this.studentScope(ctx),
      take: MAX_ROWS + 1,
      orderBy: { fullName: 'asc' },
      select: {
        admissionNo: true, fullName: true, gender: true, dateOfBirth: true, admittedOn: true, house: true, campusId: true,
        section: { select: { name: true, class: { select: { name: true, gradeLevel: true } } } },
        guardians: { orderBy: { isPrimary: 'desc' }, take: 1, select: { relationship: true, guardian: { select: { fullName: true, phone: true } } } },
      },
    });
    list.sort((a, b) => (a.section?.class.gradeLevel ?? 0) - (b.section?.class.gradeLevel ?? 0)
      || (a.section?.name ?? '').localeCompare(b.section?.name ?? '') || a.fullName.localeCompare(b.fullName));
    const rows = list.map((s) => ({
      admissionNo: s.admissionNo,
      student: s.fullName,
      className: classLabel(s.section?.class.name, s.section?.name),
      campus: this.campus(ctx, s.campusId),
      gender: GENDER[s.gender] ?? s.gender,
      dateOfBirth: keyOf(s.dateOfBirth),
      admittedOn: keyOrNull(s.admittedOn),
      house: s.house,
      guardian: s.guardians[0] ? `${s.guardians[0].guardian.fullName} (${s.guardians[0].relationship})` : null,
      phone: s.guardians[0]?.guardian.phone ?? null,
    }));
    const { rows: out, truncated } = capRows(rows);
    return {
      columns: [
        col('admissionNo', 'Admission no.'), col('student', 'Student'), col('className', 'Class'), col('campus', 'Campus'), col('gender', 'Gender'),
        col('dateOfBirth', 'Date of birth'), col('admittedOn', 'Admitted on'), col('house', 'House'), col('guardian', 'Primary guardian'), col('phone', 'Guardian phone'),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Girls', value: list.filter((s) => s.gender === 'F').length, tone: 'violet' },
        { label: 'Boys', value: list.filter((s) => s.gender === 'M').length, tone: 'info' },
        { label: 'Classes', value: new Set(list.map((s) => classLabel(s.section?.class.name, s.section?.name))).size },
      ],
      chart: chart('Students by class', tally(list, (s) => s.section?.class.name)),
    };
  }

  private async attendanceDaily(ctx: Ctx): Promise<BuiltReport> {
    const d = dateOf(ctx.date);
    const counts = await this.prisma.student.groupBy({ by: ['sectionId'], where: this.studentScope(ctx), _count: { _all: true } });
    const ids = counts.map((c) => c.sectionId);
    const [sections, registers, marks] = ids.length
      ? await Promise.all([
        this.prisma.section.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, campusId: true, classTeacher: { select: { fullName: true } }, class: { select: { name: true, gradeLevel: true } } },
        }),
        this.prisma.studentAttendanceRegister.findMany({ where: { sectionId: { in: ids }, date: d }, select: { sectionId: true, markedByName: true, markedAt: true } }),
        this.prisma.studentAttendance.groupBy({ by: ['sectionId', 'status'], where: { sectionId: { in: ids }, date: d }, _count: { _all: true } }),
      ])
      : [[], [], []];
    const reg = new Map(registers.map((r) => [r.sectionId, r]));
    const n = (sid: string, st: string) => marks.find((m) => m.sectionId === sid && m.status === st)?._count._all ?? 0;
    const rows = sections
      .sort((a, b) => a.class.gradeLevel - b.class.gradeLevel || a.name.localeCompare(b.name) || this.campus(ctx, a.campusId).localeCompare(this.campus(ctx, b.campusId)))
      .map((s) => {
        const present = n(s.id, 'present');
        const late = n(s.id, 'late');
        const absent = n(s.id, 'absent');
        const leave = n(s.id, 'leave');
        const marked = present + late + absent + leave;
        const r = reg.get(s.id);
        return {
          className: classLabel(s.class.name, s.name), campus: this.campus(ctx, s.campusId), teacher: s.classTeacher?.fullName ?? null,
          students: counts.find((c) => c.sectionId === s.id)?._count._all ?? 0, marked, present, late, absent, leave,
          rate: pctOrNull(present + late, marked), markedBy: r?.markedByName ?? (marked ? null : 'Not marked'), markedAt: r ? nowTime(r.markedAt) : null,
        };
      });
    const tot = (k: 'present' | 'late' | 'absent' | 'leave' | 'marked') => rows.reduce((s, r) => s + r[k], 0);
    const notMarked = rows.filter((r) => r.marked === 0).length;
    return {
      columns: [
        col('className', 'Class'), col('campus', 'Campus'), col('teacher', 'Class teacher'), col('students', 'Students', true), col('marked', 'Marked', true),
        col('present', 'Present', true), col('late', 'Late', true), col('absent', 'Absent', true), col('leave', 'Leave', true), col('rate', 'Attendance %', true),
        col('markedBy', 'Saved by'), col('markedAt', 'Saved at'),
      ],
      rows,
      truncated: false,
      summary: [
        { label: 'Attendance', value: pctOrNull(tot('present') + tot('late'), tot('marked')) ?? 0, unit: '%', tone: 'teal' },
        { label: 'Absent', value: tot('absent'), tone: 'critical' },
        { label: 'Late', value: tot('late'), tone: 'amber' },
        { label: weekday(ctx.date) === 0 ? 'Classes (Sunday)' : 'Classes not marked', value: notMarked, tone: notMarked ? 'critical' : 'teal' },
      ],
      chart: chart('Absent by class', rows.map((r) => [r.className ?? '', r.absent] as [string, number])),
    };
  }

  private async attendanceLow(ctx: Ctx): Promise<BuiltReport> {
    const threshold = Number(await this.settings.get<number>('early_warning.attendance_threshold', 82)) || 82;
    const list = await this.prisma.$queryRaw<{ id: string; marked: number; attended: number; absent: number; late: number }[]>(Prisma.sql`
      SELECT a."studentId"::text AS id, COUNT(*)::int AS marked,
        COUNT(*) FILTER (WHERE a.status IN ('present', 'late'))::int AS attended,
        COUNT(*) FILTER (WHERE a.status = 'absent')::int AS absent,
        COUNT(*) FILTER (WHERE a.status = 'late')::int AS late
      FROM "StudentAttendance" a
      JOIN "Student" s ON s.id = a."studentId" AND s.status = 'active'
      WHERE a.date BETWEEN ${sqlDate(ctx.y.start)} AND ${sqlDate(ctx.today)}
        ${andCampus('s."campusId"', ctx.campusId)} ${andSections('s."sectionId"', ctx.sectionIds)}
      GROUP BY a."studentId"
      HAVING (COUNT(*) FILTER (WHERE a.status IN ('present', 'late')))::float8 * 100 < ${threshold} * COUNT(*)
      ORDER BY (COUNT(*) FILTER (WHERE a.status IN ('present', 'late')))::float8 / COUNT(*) ASC
      LIMIT ${MAX_ROWS + 1}`);
    const info = await this.pupils(list.map((r) => r.id));
    const rows = list.map((r) => {
      const s = info.get(r.id);
      return {
        admissionNo: s?.admissionNo ?? '', student: s?.fullName ?? 'Student', className: s?.label ?? null, campus: this.campus(ctx, s?.campusId),
        attendance: pctOrNull(r.attended, r.marked), marked: r.marked, absent: r.absent, late: r.late, risk: s?.risk ?? null,
      };
    });
    const { rows: out, truncated } = capRows(rows);
    const avg = mean(rows.map((r) => r.attendance ?? 0));
    return {
      columns: [
        col('admissionNo', 'Admission no.'), col('student', 'Student'), col('className', 'Class'), col('campus', 'Campus'), col('attendance', 'Attendance %', true),
        col('marked', 'Days marked', true), col('absent', 'Absent', true), col('late', 'Late', true), col('risk', 'Risk band'),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Below threshold', value: rows.length, tone: rows.length ? 'critical' : 'teal' },
        { label: 'Threshold', value: threshold, unit: '%' },
        { label: 'Their average attendance', value: avg != null ? r1(avg) : 0, unit: '%', tone: 'amber' },
      ],
      chart: chart('Students below threshold by class', tally(list, (r) => info.get(r.id)?.className)),
    };
  }

  private async studentsAtRisk(ctx: Ctx): Promise<BuiltReport> {
    const list = await this.prisma.student.findMany({
      where: { ...this.studentScope(ctx), risk: { in: ['At Risk', 'Developing Risk'] } },
      take: MAX_ROWS + 1,
      select: {
        id: true, admissionNo: true, fullName: true, risk: true, attendancePct: true, averageScore: true, scoreTrend: true, campusId: true,
        section: { select: { name: true, class: { select: { name: true, gradeLevel: true } } } },
      },
    });
    const signals = new Map<string, number>();
    if (list.length && (await this.guarded.has('EarlyWarningSignal'))) {
      try {
        const rows = await this.prisma.$queryRaw<{ id: string; n: number }[]>(Prisma.sql`
          SELECT s."studentId"::text AS id, COUNT(*)::int AS n FROM "EarlyWarningSignal" s
          JOIN "Student" st ON st.id = s."studentId" AND st.status = 'active'
          WHERE s."closedAt" IS NULL AND s.stage < 5 AND COALESCE(s.decision, '') <> 'dismissed'
            ${andCampus('st."campusId"', ctx.campusId)} ${andSections('st."sectionId"', ctx.sectionIds)}
          GROUP BY s."studentId"`);
        for (const r of rows) signals.set(r.id, r.n);
      } catch {
        // Early Warning not available yet: the column stays empty.
      }
    }
    const rank: Record<string, number> = { 'At Risk': 0, 'Developing Risk': 1 };
    list.sort((a, b) => (rank[a.risk] ?? 9) - (rank[b.risk] ?? 9) || (a.attendancePct ?? 101) - (b.attendancePct ?? 101));
    const rows = list.map((s) => ({
      admissionNo: s.admissionNo, student: s.fullName, className: classLabel(s.section?.class.name, s.section?.name), campus: this.campus(ctx, s.campusId),
      risk: s.risk, attendance: s.attendancePct != null ? r1(s.attendancePct) : null, average: s.averageScore != null ? r1(s.averageScore) : null,
      trend: s.scoreTrend != null ? r1(s.scoreTrend) : null, signals: signals.get(s.id) ?? 0,
    }));
    const { rows: out, truncated } = capRows(rows);
    return {
      columns: [
        col('admissionNo', 'Admission no.'), col('student', 'Student'), col('className', 'Class'), col('campus', 'Campus'), col('risk', 'Risk band'),
        col('attendance', 'Attendance %', true), col('average', 'Average score %', true), col('trend', 'Score trend', true), col('signals', 'Open signals', true),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'At Risk', value: list.filter((s) => s.risk === 'At Risk').length, tone: 'critical' },
        { label: 'Developing Risk', value: list.filter((s) => s.risk === 'Developing Risk').length, tone: 'amber' },
        { label: 'With open signals', value: rows.filter((r) => r.signals > 0).length, tone: 'info' },
      ],
      chart: chart('Students needing attention by class', tally(list, (s) => s.section?.class.name)),
    };
  }

  // ---- Academics -------------------------------------------------------------

  private async teacherClassIds(sectionIds: string[]) {
    if (!sectionIds.length) return [];
    return (await this.prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { classId: true } })).map((s) => s.classId);
  }

  private async assessmentResults(ctx: Ctx): Promise<BuiltReport> {
    const pass = Number(await this.settings.get<number>('academics.pass_mark', 40)) || 40;
    const restrict: Prisma.AssessmentWhereInput = ctx.sectionIds
      ? { OR: [{ sectionId: { in: ctx.sectionIds } }, { sectionId: null, classId: { in: await this.teacherClassIds(ctx.sectionIds) } }] }
      : {};
    const where: Prisma.AssessmentWhereInput = {
      AND: [{ heldOn: { gte: dateOf(ctx.from), lte: dateOf(ctx.to) } }, ctx.campusId ? { campusId: ctx.campusId } : {}, restrict],
    };
    const list = await this.prisma.assessment.findMany({
      where, orderBy: [{ heldOn: 'desc' }, { code: 'asc' }], take: MAX_ROWS + 1,
      select: { id: true, code: true, name: true, assessmentType: true, status: true, heldOn: true, maxMarks: true, campusId: true, classId: true, sectionId: true, subjectId: true },
    });
    const [stats, subjects, classes, sections] = await Promise.all([
      this.prisma.$queryRaw<{ id: string; marked: number; absent: number; avg: number | null; hi: number | null; lo: number | null; below: number }[]>(Prisma.sql`
        SELECT a.id::text AS id,
          COUNT(m.id) FILTER (WHERE m.marks IS NOT NULL AND m."isAbsent" = false)::int AS marked,
          COUNT(m.id) FILTER (WHERE m."isAbsent")::int AS absent,
          AVG(m.marks / NULLIF(a."maxMarks", 0) * 100) FILTER (WHERE m.marks IS NOT NULL AND m."isAbsent" = false)::float8 AS avg,
          MAX(m.marks / NULLIF(a."maxMarks", 0) * 100) FILTER (WHERE m.marks IS NOT NULL AND m."isAbsent" = false)::float8 AS hi,
          MIN(m.marks / NULLIF(a."maxMarks", 0) * 100) FILTER (WHERE m.marks IS NOT NULL AND m."isAbsent" = false)::float8 AS lo,
          COUNT(m.id) FILTER (WHERE m.marks IS NOT NULL AND m."isAbsent" = false AND m.marks / NULLIF(a."maxMarks", 0) * 100 < ${pass})::int AS below
        FROM "Assessment" a LEFT JOIN "AssessmentMark" m ON m."assessmentId" = a.id
        WHERE a."heldOn" BETWEEN ${sqlDate(ctx.from)} AND ${sqlDate(ctx.to)} ${andCampus('a."campusId"', ctx.campusId)}
        GROUP BY a.id`),
      this.prisma.subject.findMany({ select: { id: true, name: true } }),
      this.prisma.schoolClass.findMany({ where: { id: { in: [...new Set(list.map((a) => a.classId))] } }, select: { id: true, name: true } }),
      this.prisma.section.findMany({ where: { id: { in: [...new Set(list.map((a) => a.sectionId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
    ]);
    const st = new Map(stats.map((s) => [s.id, s]));
    const subj = new Map(subjects.map((s) => [s.id, s.name]));
    const cls = new Map(classes.map((c) => [c.id, c.name]));
    const sec = new Map(sections.map((s) => [s.id, s.name]));
    const rows = list.map((a) => {
      const s = st.get(a.id);
      return {
        code: a.code, assessment: a.name, className: a.sectionId ? classLabel(cls.get(a.classId), sec.get(a.sectionId)) : `${cls.get(a.classId) ?? ''} (all sections)`,
        campus: this.campus(ctx, a.campusId), subject: subj.get(a.subjectId) ?? '', heldOn: keyOf(a.heldOn), type: a.assessmentType, status: a.status,
        maxMarks: a.maxMarks, marked: s?.marked ?? 0, absent: s?.absent ?? 0,
        average: s?.avg != null ? r1(num(s.avg)) : null, highest: s?.hi != null ? r1(num(s.hi)) : null, lowest: s?.lo != null ? r1(num(s.lo)) : null,
        below: s?.below ?? 0,
      };
    });
    const { rows: out, truncated } = capRows(rows);
    const markedAll = rows.reduce((t, r) => t + r.marked, 0);
    const weighted = rows.reduce((t, r) => t + (r.average ?? 0) * r.marked, 0);
    const bySubject = new Map<string, { sum: number; n: number }>();
    for (const r of rows) {
      if (r.average == null || !r.marked) continue;
      const b = bySubject.get(r.subject) ?? { sum: 0, n: 0 };
      b.sum += r.average * r.marked;
      b.n += r.marked;
      bySubject.set(r.subject, b);
    }
    return {
      columns: [
        col('code', 'Code'), col('assessment', 'Assessment'), col('className', 'Class'), col('campus', 'Campus'), col('subject', 'Subject'), col('heldOn', 'Held on'),
        col('type', 'Type'), col('status', 'Status'), col('maxMarks', 'Max marks', true), col('marked', 'Marked', true), col('absent', 'Absent', true),
        col('average', 'Average %', true), col('highest', 'Highest %', true), col('lowest', 'Lowest %', true), col('below', 'Below pass mark', true),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Average score', value: markedAll ? r1(weighted / markedAll) : 0, unit: '%', tone: 'teal' },
        { label: `Results below ${pass}%`, value: rows.reduce((t, r) => t + r.below, 0), tone: 'critical' },
        { label: 'Not finalised', value: rows.filter((r) => r.status !== 'Completed').length, tone: 'amber' },
      ],
      chart: chart('Average score by subject (%)', [...bySubject].map(([k, v]) => [k, r1(v.sum / v.n)] as [string, number])),
    };
  }

  private async classPerformance(ctx: Ctx): Promise<BuiltReport> {
    const counts = await this.prisma.student.groupBy({ by: ['sectionId'], where: this.studentScope(ctx), _count: { _all: true } });
    const ids = counts.map((c) => c.sectionId);
    if (!ids.length) {
      return { columns: this.classPerfColumns(), rows: [], truncated: false, summary: [{ label: 'Average score', value: 0, unit: '%' }, { label: 'Attendance', value: 0, unit: '%' }], chart: null };
    }
    const [sections, marks, att, risk] = await Promise.all([
      this.prisma.section.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, campusId: true, classTeacher: { select: { fullName: true } }, class: { select: { name: true, gradeLevel: true } } },
      }),
      this.prisma.$queryRaw<{ id: string; sum: number; n: number }[]>(Prisma.sql`
        SELECT s."sectionId"::text AS id, SUM(m.marks / a."maxMarks" * 100)::float8 AS sum, COUNT(*)::int AS n
        FROM "AssessmentMark" m JOIN "Assessment" a ON a.id = m."assessmentId" JOIN "Student" s ON s.id = m."studentId"
        WHERE m.marks IS NOT NULL AND m."isAbsent" = false AND a."maxMarks" > 0 AND s.status = 'active'
          AND a."heldOn" BETWEEN ${sqlDate(ctx.y.start)} AND ${sqlDate(ctx.today)}
          ${andCampus('s."campusId"', ctx.campusId)} ${andSections('s."sectionId"', ctx.sectionIds)}
        GROUP BY s."sectionId"`),
      this.prisma.studentAttendance.groupBy({
        by: ['sectionId', 'status'], where: { sectionId: { in: ids }, date: { gte: ctx.y.start, lte: dateOf(ctx.today) } }, _count: { _all: true },
      }),
      this.prisma.student.groupBy({ by: ['sectionId'], where: { ...this.studentScope(ctx), risk: { in: ['At Risk', 'Developing Risk'] } }, _count: { _all: true } }),
    ]);
    const mk = new Map(marks.map((m) => [m.id, m]));
    const rows = sections
      .sort((a, b) => a.class.gradeLevel - b.class.gradeLevel || a.name.localeCompare(b.name))
      .map((s) => {
        const m = mk.get(s.id);
        const a = att.filter((x) => x.sectionId === s.id);
        const marked = a.reduce((t, x) => t + x._count._all, 0);
        const attended = a.filter((x) => x.status === 'present' || x.status === 'late').reduce((t, x) => t + x._count._all, 0);
        return {
          className: classLabel(s.class.name, s.name), campus: this.campus(ctx, s.campusId), teacher: s.classTeacher?.fullName ?? null,
          students: counts.find((c) => c.sectionId === s.id)?._count._all ?? 0,
          average: m?.n ? r1(num(m.sum) / m.n) : null,
          attendance: pctOrNull(attended, marked),
          atRisk: risk.find((r) => r.sectionId === s.id)?._count._all ?? 0,
        };
      });
    const sumMarks = marks.reduce((t, m) => t + num(m.sum), 0);
    const nMarks = marks.reduce((t, m) => t + m.n, 0);
    const tm = att.reduce((t, x) => t + x._count._all, 0);
    const ta = att.filter((x) => x.status === 'present' || x.status === 'late').reduce((t, x) => t + x._count._all, 0);
    return {
      columns: this.classPerfColumns(),
      rows,
      truncated: false,
      summary: [
        { label: 'Average score', value: nMarks ? r1(sumMarks / nMarks) : 0, unit: '%', tone: 'teal' },
        { label: 'Attendance', value: pctOrNull(ta, tm) ?? 0, unit: '%', tone: 'info' },
        { label: 'Needing attention', value: rows.reduce((t, r) => t + r.atRisk, 0), tone: 'critical' },
      ],
      chart: chart('Average score by class (%)', rows.filter((r) => r.average != null).map((r) => [r.className ?? '', r.average!] as [string, number])),
    };
  }

  private classPerfColumns() {
    return [
      col('className', 'Class'), col('campus', 'Campus'), col('teacher', 'Class teacher'), col('students', 'Students', true),
      col('average', 'Average score %', true), col('attendance', 'Attendance %', true), col('atRisk', 'Needing attention', true),
    ];
  }

  private async homeworkCompletion(ctx: Ctx): Promise<BuiltReport> {
    const list = await this.prisma.homework.findMany({
      where: {
        dueOn: { gte: dateOf(ctx.from), lte: dateOf(ctx.to) }, status: { not: 'Draft' },
        ...(ctx.campusId ? { campusId: ctx.campusId } : {}), ...(ctx.sectionIds ? { sectionId: { in: ctx.sectionIds } } : {}),
      },
      orderBy: { dueOn: 'desc' }, take: MAX_ROWS + 1,
      select: { id: true, title: true, status: true, assignedOn: true, dueOn: true, campusId: true, sectionId: true, subjectId: true, assignedByName: true },
    });
    const sectionIds = [...new Set(list.map((h) => h.sectionId))];
    const [subs, sections, counts, subjects] = await Promise.all([
      this.prisma.$queryRaw<{ id: string; submitted: number; late: number }[]>(Prisma.sql`
        SELECT s."homeworkId"::text AS id, COUNT(*)::int AS submitted, COUNT(*) FILTER (WHERE s.status = 'Late')::int AS late
        FROM "HomeworkSubmission" s JOIN "Homework" h ON h.id = s."homeworkId"
        WHERE h."dueOn" BETWEEN ${sqlDate(ctx.from)} AND ${sqlDate(ctx.to)} ${andCampus('h."campusId"', ctx.campusId)}
        GROUP BY s."homeworkId"`),
      sectionIds.length ? this.prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, name: true, class: { select: { name: true } } } }) : Promise.resolve([]),
      sectionIds.length ? this.prisma.student.groupBy({ by: ['sectionId'], where: { status: 'active', sectionId: { in: sectionIds } }, _count: { _all: true } }) : Promise.resolve([]),
      this.prisma.subject.findMany({ select: { id: true, name: true } }),
    ]);
    const sub = new Map(subs.map((s) => [s.id, s]));
    const sec = new Map(sections.map((s) => [s.id, s]));
    const cnt = new Map(counts.map((c) => [c.sectionId, c._count._all]));
    const subj = new Map(subjects.map((s) => [s.id, s.name]));
    const rows = list.map((h) => {
      const s = sec.get(h.sectionId);
      const students = cnt.get(h.sectionId) ?? 0;
      const done = sub.get(h.id)?.submitted ?? 0;
      const state = h.status === 'Closed' ? 'Closed' : keyOf(h.dueOn) < ctx.today ? 'Overdue' : 'Open';
      return {
        title: h.title, className: classLabel(s?.class.name, s?.name), campus: this.campus(ctx, h.campusId), subject: subj.get(h.subjectId) ?? '',
        setBy: h.assignedByName, assignedOn: keyOf(h.assignedOn), dueOn: keyOf(h.dueOn), status: state, students, submitted: done,
        late: sub.get(h.id)?.late ?? 0, completion: students ? Math.min(100, pctOrNull(done, students) ?? 0) : null,
      };
    });
    const { rows: out, truncated } = capRows(rows);
    const rates = rows.map((r) => r.completion).filter((v): v is number => v != null);
    const bySubject = new Map<string, number[]>();
    for (const r of rows) if (r.completion != null) bySubject.set(r.subject, [...(bySubject.get(r.subject) ?? []), r.completion]);
    return {
      columns: [
        col('title', 'Homework'), col('className', 'Class'), col('campus', 'Campus'), col('subject', 'Subject'), col('setBy', 'Set by'), col('assignedOn', 'Set on'),
        col('dueOn', 'Due'), col('status', 'Status'), col('students', 'Students', true), col('submitted', 'Handed in', true), col('late', 'Late', true),
        col('completion', 'Completion %', true),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Average completion', value: rates.length ? r1(mean(rates)!) : 0, unit: '%', tone: 'teal' },
        { label: 'Handed in late', value: rows.reduce((t, r) => t + r.late, 0), tone: 'amber' },
        { label: 'Still open past due', value: rows.filter((r) => r.status === 'Overdue').length, tone: 'critical' },
      ],
      chart: chart('Completion by subject (%)', [...bySubject].map(([k, v]) => [k, r1(mean(v)!)] as [string, number])),
    };
  }

  private async lessonPlans(ctx: Ctx): Promise<BuiltReport> {
    const own = ctx.sectionIds ? { authorId: ctx.user.employeeId ?? '00000000-0000-0000-0000-000000000000' } : {};
    const groups = await this.prisma.lessonPlan.groupBy({
      by: ['authorId', 'campusId', 'status'], where: { ...(ctx.campusId ? { campusId: ctx.campusId } : {}), ...own }, _count: { _all: true },
    });
    const emps = await this.employees(groups.map((g) => g.authorId));
    const byAuthor = new Map<string, { teacher: string; campus: string; Draft: number; Submitted: number; 'Under Review': number; Approved: number; Rejected: number }>();
    for (const g of groups) {
      const k = `${g.authorId}|${g.campusId}`;
      const r = byAuthor.get(k) ?? { teacher: emps.get(g.authorId)?.fullName ?? 'Unknown teacher', campus: this.campus(ctx, g.campusId), Draft: 0, Submitted: 0, 'Under Review': 0, Approved: 0, Rejected: 0 };
      const st = g.status as 'Draft' | 'Submitted' | 'Under Review' | 'Approved' | 'Rejected';
      if (PLAN_STATUSES.includes(st)) r[st] += g._count._all;
      byAuthor.set(k, r);
    }
    const rows = [...byAuthor.values()].map((r) => {
      const total = r.Draft + r.Submitted + r['Under Review'] + r.Approved + r.Rejected;
      const decided = r.Approved + r.Rejected;
      return {
        teacher: r.teacher, campus: r.campus, draft: r.Draft, submitted: r.Submitted, underReview: r['Under Review'], approved: r.Approved, rejected: r.Rejected,
        total, approvalRate: pctOrNull(r.Approved, decided),
      };
    }).sort((a, b) => a.teacher.localeCompare(b.teacher));
    const sum = (k: 'approved' | 'submitted' | 'underReview' | 'total') => rows.reduce((t, r) => t + r[k], 0);
    return {
      columns: [
        col('teacher', 'Teacher'), col('campus', 'Campus'), col('draft', 'Draft', true), col('submitted', 'Submitted', true), col('underReview', 'Under review', true),
        col('approved', 'Approved', true), col('rejected', 'Returned', true), col('total', 'Total', true), col('approvalRate', 'Approval rate %', true),
      ],
      rows,
      truncated: false,
      summary: [
        { label: 'Plans', value: sum('total') },
        { label: 'Approved', value: sum('approved'), tone: 'teal' },
        { label: 'Waiting for review', value: sum('submitted') + sum('underReview'), tone: 'amber' },
      ],
      chart: chart('Approved plans by teacher', rows.map((r) => [r.teacher, r.approved] as [string, number])),
    };
  }

  // ---- Operations ------------------------------------------------------------

  private async safetyLog(ctx: Ctx): Promise<BuiltReport> {
    const sensitive = ctx.user.permissions.has('students.sensitive');
    const list = await this.prisma.safetyIncident.findMany({
      where: {
        occurredOn: { gte: dateOf(ctx.from), lte: dateOf(ctx.to) },
        ...(ctx.campusId ? { campusId: ctx.campusId } : {}),
        ...(sensitive ? {} : { isConfidential: false }),
      },
      orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }], take: MAX_ROWS + 1,
    });
    const [students, owners] = await Promise.all([
      this.pupils(list.map((i) => i.studentId).filter((x): x is string => !!x)),
      this.employees(list.map((i) => i.ownerId)),
    ]);
    const rows = list.map((i) => ({
      code: i.code, occurredOn: keyOf(i.occurredOn), campus: this.campus(ctx, i.campusId), type: i.incidentType, severity: i.severity, status: i.status,
      summary: i.summary, student: i.studentId ? students.get(i.studentId)?.fullName ?? null : null, owner: i.ownerId ? owners.get(i.ownerId)?.fullName ?? null : null,
      closedOn: i.closedAt ? istKey(i.closedAt) : null, confidential: yes(i.isConfidential),
    }));
    const { rows: out, truncated } = capRows(rows);
    return {
      columns: [
        col('code', 'Reference'), col('occurredOn', 'Date'), col('campus', 'Campus'), col('type', 'Type'), col('severity', 'Severity'), col('status', 'Status'),
        col('summary', 'Summary'), col('student', 'Student'), col('owner', 'Owner'), col('closedOn', 'Closed on'), col('confidential', 'Confidential'),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Still open', value: list.filter((i) => i.status !== 'Closed').length, tone: 'amber' },
        { label: 'Critical', value: list.filter((i) => i.severity === 'Critical').length, tone: 'critical' },
        { label: 'Safeguarding', value: list.filter((i) => i.incidentType === 'Safeguarding').length, tone: 'violet' },
      ],
      chart: chart('Incidents by type', tally(list, (i) => i.incidentType)),
      sensitive: list.some((i) => i.isConfidential || i.incidentType === 'Safeguarding'),
    };
  }

  private async visitorLog(ctx: Ctx): Promise<BuiltReport> {
    const list = await this.prisma.safetyVisitor.findMany({
      where: { checkedInAt: { gte: istStart(ctx.from), lt: istStart(addDays(ctx.to, 1)) }, ...(ctx.campusId ? { campusId: ctx.campusId } : {}) },
      orderBy: { checkedInAt: 'desc' }, take: MAX_ROWS + 1,
    });
    const hosts = await this.employees(list.map((v) => v.hostId));
    const rows = list.map((v) => ({
      badgeNo: v.badgeNo, visitor: v.fullName, phone: v.phone, purpose: v.purpose, host: v.hostId ? hosts.get(v.hostId)?.fullName ?? null : null,
      campus: this.campus(ctx, v.campusId), checkedIn: stamp(v.checkedInAt), checkedOut: stamp(v.checkedOutAt), status: v.status,
      minutes: v.checkedOutAt ? Math.max(0, Math.round((v.checkedOutAt.getTime() - v.checkedInAt.getTime()) / 60_000)) : null,
    }));
    const { rows: out, truncated } = capRows(rows);
    const stays = rows.map((r) => r.minutes).filter((m): m is number => m != null);
    return {
      columns: [
        col('badgeNo', 'Badge'), col('visitor', 'Visitor'), col('phone', 'Phone'), col('purpose', 'Purpose'), col('host', 'Host'), col('campus', 'Campus'),
        col('checkedIn', 'Arrived'), col('checkedOut', 'Left'), col('status', 'Status'), col('minutes', 'Minutes on site', true),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Inside now', value: list.filter((v) => v.status === 'Inside').length, tone: 'amber' },
        { label: 'Denied entry', value: list.filter((v) => v.status === 'Denied').length, tone: 'critical' },
        { label: 'Average visit (minutes)', value: stays.length ? Math.round(mean(stays)!) : 0, tone: 'info' },
      ],
      chart: chart('Visitors by purpose', tally(list, (v) => v.purpose)),
    };
  }

  private async transportRoutes(ctx: Ctx): Promise<BuiltReport> {
    const routes = await this.prisma.transportRoute.findMany({
      where: { isActive: true, ...(ctx.campusId ? { campusId: ctx.campusId } : {}) },
      orderBy: { code: 'asc' },
      select: {
        id: true, code: true, name: true, campusId: true, vehicleLabel: true, vehicleNo: true, capacity: true, driverId: true, attendantId: true, status: true,
        _count: { select: { students: true, stops: true } },
      },
    });
    const ids = routes.map((r) => r.id);
    const [profiles, crew] = await Promise.all([
      ids.length ? this.prisma.transportRouteProfile.findMany({ where: { routeId: { in: ids } } }) : Promise.resolve([]),
      this.employees(routes.flatMap((r) => [r.driverId, r.attendantId])),
    ]);
    const vehicleIds = profiles.map((p) => p.vehicleId).filter((x): x is string => !!x);
    const vehicles = vehicleIds.length ? await this.prisma.transportVehicle.findMany({ where: { id: { in: vehicleIds } } }) : [];
    const prof = new Map(profiles.map((p) => [p.routeId, p]));
    const veh = new Map(vehicles.map((v) => [v.id, v]));
    const LABEL: Record<string, string> = { scheduled: 'Scheduled', en_route: 'En route', delayed: 'Delayed', at_campus: 'At campus', completed: 'Completed', maintenance: 'Maintenance' };
    const rows = routes
      .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
      .map((r) => {
        const p = prof.get(r.id);
        const v = p?.vehicleId ? veh.get(p.vehicleId) : undefined;
        const capacity = v?.capacity ?? r.capacity;
        const today = p?.runDate && keyOf(p.runDate) === ctx.today;
        const run = r.status === 'maintenance' ? 'Maintenance' : today ? LABEL[r.status] ?? 'Scheduled' : 'Scheduled';
        return {
          code: r.code, route: p?.area || r.name, campus: this.campus(ctx, r.campusId), bus: v?.busNo ?? r.vehicleLabel, registration: v?.registrationNo ?? r.vehicleNo,
          capacity, students: r._count.students, occupancy: capacity ? pctOrNull(r._count.students, capacity) : null, stops: r._count.stops,
          driver: r.driverId ? crew.get(r.driverId)?.fullName ?? null : null, attendant: r.attendantId ? crew.get(r.attendantId)?.fullName ?? null : null,
          today: run, delay: today && p && p.delayMinutes > 0 ? p.delayMinutes : null,
        };
      });
    const seats = rows.reduce((t, r) => t + r.capacity, 0);
    const riders = rows.reduce((t, r) => t + r.students, 0);
    return {
      columns: [
        col('code', 'Route'), col('route', 'Area'), col('campus', 'Campus'), col('bus', 'Bus'), col('registration', 'Registration'), col('capacity', 'Seats', true),
        col('students', 'Students', true), col('occupancy', 'Occupancy %', true), col('stops', 'Stops', true), col('driver', 'Driver'), col('attendant', 'Attendant'),
        col('today', 'Today'), col('delay', 'Delay (min)', true),
      ],
      rows,
      truncated: false,
      summary: [
        { label: 'Students on buses', value: riders, tone: 'teal' },
        { label: 'Seat occupancy', value: pctOrNull(riders, seats) ?? 0, unit: '%', tone: 'info' },
        { label: 'Running late now', value: rows.filter((r) => r.today === 'Delayed' || (r.delay ?? 0) > 0).length, tone: 'amber' },
      ],
      chart: chart('Students by route', rows.map((r) => [`${r.code} · ${r.route}`, r.students] as [string, number])),
    };
  }

  private async staffAttendance(ctx: Ctx): Promise<BuiltReport> {
    const d = dateOf(ctx.date);
    const c = ctx.campusId ? { campusId: ctx.campusId } : {};
    const [emps, marks, leave] = await Promise.all([
      this.prisma.employee.findMany({
        where: { archivedAt: null, employmentStatus: { not: 'exited' }, ...c }, orderBy: [{ department: 'asc' }, { fullName: 'asc' }],
        select: { id: true, code: true, fullName: true, department: true, designation: true, employeeType: true, campusId: true },
      }),
      this.prisma.workforceAttendance.findMany({ where: { date: d, ...c }, select: { employeeId: true, status: true, checkIn: true, checkOut: true, source: true } }),
      this.prisma.workforceLeaveRequest.findMany({ where: { status: 'Approved', halfDay: false, fromDate: { lte: d }, toDate: { gte: d }, ...c }, select: { employeeId: true } }),
    ]);
    const mark = new Map(marks.map((m) => [m.employeeId, m]));
    const onLeave = new Set(leave.map((l) => l.employeeId));
    const sunday = weekday(ctx.date) === 0;
    const rows = emps.map((e) => {
      const m = mark.get(e.id);
      return {
        code: e.code, name: e.fullName, department: e.department, designation: e.designation, type: e.employeeType === 'teaching' ? 'Teaching' : 'Non-teaching',
        campus: this.campus(ctx, e.campusId), status: m?.status ?? (onLeave.has(e.id) && !sunday ? 'On Leave' : 'Not marked'),
        checkIn: m?.checkIn ?? null, checkOut: m?.checkOut ?? null, source: m?.source ?? (onLeave.has(e.id) ? 'leave' : null),
      };
    });
    const n = (s: string[]) => rows.filter((r) => s.includes(r.status)).length;
    return {
      columns: [
        col('code', 'Code'), col('name', 'Name'), col('department', 'Department'), col('designation', 'Designation'), col('type', 'Type'), col('campus', 'Campus'),
        col('status', 'Status'), col('checkIn', 'Check-in'), col('checkOut', 'Check-out'), col('source', 'Source'),
      ],
      rows,
      truncated: false,
      summary: [
        { label: 'Present', value: n(['Present', 'Late', 'Half Day']), tone: 'teal' },
        { label: 'Absent', value: n(['Absent']), tone: 'critical' },
        { label: 'On leave', value: n(['On Leave']), tone: 'info' },
        { label: 'Late', value: n(['Late']), tone: 'amber' },
        { label: 'Not marked', value: n(['Not marked']) },
      ],
      chart: chart('Present by department', tally(rows.filter((r) => ['Present', 'Late', 'Half Day'].includes(r.status)), (r) => r.department)),
    };
  }

  private async maintenance(ctx: Ctx): Promise<BuiltReport> {
    const list = await this.prisma.opsMaintenanceRequest.findMany({
      where: { status: { notIn: ['Completed', 'Rejected'] }, ...(ctx.campusId ? { campusId: ctx.campusId } : {}) },
      orderBy: [{ priorityRank: 'asc' }, { createdAt: 'asc' }], take: MAX_ROWS + 1,
      select: {
        code: true, campusId: true, description: true, priority: true, status: true, raisedByName: true, createdAt: true, cost: true,
        asset: { select: { name: true } }, facility: { select: { name: true } },
      },
    });
    const rows = list.map((m) => ({
      code: m.code, campus: this.campus(ctx, m.campusId), description: m.description, priority: m.priority, status: m.status,
      location: m.asset?.name ?? m.facility?.name ?? null, raisedBy: m.raisedByName, raisedOn: istKey(m.createdAt),
      age: Math.max(0, daysBetween(istKey(m.createdAt), ctx.today)), cost: m.cost != null ? num(m.cost) : null,
    }));
    const { rows: out, truncated } = capRows(rows);
    return {
      columns: [
        col('code', 'Reference'), col('campus', 'Campus'), col('description', 'Request'), col('priority', 'Priority'), col('status', 'Status'), col('location', 'Asset / facility'),
        col('raisedBy', 'Raised by'), col('raisedOn', 'Raised on'), col('age', 'Days open', true), col('cost', 'Estimated cost (INR)', true),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'High priority', value: list.filter((m) => /high|urgent/i.test(m.priority)).length, tone: 'critical' },
        { label: 'Open over 7 days', value: rows.filter((r) => r.age > 7).length, tone: 'amber' },
        { label: 'Estimated cost', value: r2(rows.reduce((t, r) => t + (r.cost ?? 0), 0)), unit: 'INR' },
      ],
      chart: chart('Open requests by status', tally(list, (m) => m.status)),
    };
  }

  private async compliance(ctx: Ctx): Promise<BuiltReport> {
    const list = await this.prisma.opsComplianceItem.findMany({
      where: { ...(ctx.campusId ? { campusId: ctx.campusId } : {}), OR: [{ status: { not: 'Completed' } }, { completedOn: { gte: ctx.y.start } }] },
      orderBy: { dueOn: 'asc' }, take: MAX_ROWS + 1,
    });
    const owners = await this.employees(list.map((i) => i.ownerId));
    const statusOf = (i: (typeof list)[number]) => {
      if (i.status === 'Completed') return 'Completed';
      const days = daysBetween(ctx.today, keyOf(i.dueOn));
      return days < 0 ? 'Overdue' : days <= 14 ? 'Due Soon' : i.status;
    };
    const rows = list.map((i) => ({
      item: i.item, authority: i.authority, campus: this.campus(ctx, i.campusId), dueOn: keyOf(i.dueOn), status: statusOf(i),
      owner: i.ownerId ? owners.get(i.ownerId)?.fullName ?? null : null, completedOn: keyOrNull(i.completedOn), escalations: i.escalations,
    }));
    const { rows: out, truncated } = capRows(rows);
    return {
      columns: [
        col('item', 'Requirement'), col('authority', 'Authority'), col('campus', 'Campus'), col('dueOn', 'Due'), col('status', 'Status'), col('owner', 'Owner'),
        col('completedOn', 'Completed on'), col('escalations', 'Escalations', true),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Overdue', value: rows.filter((r) => r.status === 'Overdue').length, tone: 'critical' },
        { label: 'Due in 14 days', value: rows.filter((r) => r.status === 'Due Soon').length, tone: 'amber' },
        { label: 'Completed this year', value: rows.filter((r) => r.status === 'Completed').length, tone: 'teal' },
      ],
      chart: chart('Requirements by status', tally(rows, (r) => r.status)),
    };
  }

  // ---- Management ------------------------------------------------------------

  private async admissionsFunnel(ctx: Ctx): Promise<BuiltReport> {
    const base: Prisma.AdmissionLeadWhereInput = {
      createdAt: { gte: istStart(ctx.from), lt: istStart(addDays(ctx.to, 1)) }, ...(ctx.campusId ? { campusId: ctx.campusId } : {}),
    };
    const [byStage, enrolled, lost, spend] = await Promise.all([
      this.prisma.admissionLead.groupBy({ by: ['source', 'maxStageIndex'], where: base, _count: { _all: true } }),
      this.prisma.admissionLead.groupBy({ by: ['source'], where: { ...base, stage: 'Enrolled' }, _count: { _all: true } }),
      this.prisma.admissionLead.groupBy({ by: ['source'], where: { ...base, stage: 'Lost' }, _count: { _all: true } }),
      this.prisma.admissionMarketingSpend.groupBy({
        by: ['source'], where: { month: { gte: dateOf(`${ctx.from.slice(0, 7)}-01`), lte: dateOf(ctx.to) }, ...(ctx.campusId ? { campusId: ctx.campusId } : {}) },
        _sum: { amount: true },
      }),
    ]);
    const sources = [...new Set([...byStage.map((r) => r.source), ...spend.map((s) => s.source)])];
    const reached = (src: string, i: number) => byStage.filter((r) => r.source === src && r.maxStageIndex >= i).reduce((t, r) => t + r._count._all, 0);
    const rows = sources.map((src) => {
      const enquiries = reached(src, 0);
      const enr = enrolled.find((e) => e.source === src)?._count._all ?? 0;
      const cost = num(spend.find((s) => s.source === src)?._sum.amount);
      return {
        source: src, enquiries, contacted: reached(src, 1), qualified: reached(src, 2), visits: reached(src, 4), applications: reached(src, 5), offers: reached(src, 7),
        enrolled: enr, lost: lost.find((l) => l.source === src)?._count._all ?? 0, conversion: pctOrNull(enr, enquiries),
        spend: r2(cost), costPerAdmission: cost > 0 && enr ? Math.round(cost / enr) : null,
      };
    }).sort((a, b) => b.enquiries - a.enquiries);
    const total = (k: 'enquiries' | 'enrolled' | 'spend') => rows.reduce((t, r) => t + r[k], 0);
    return {
      columns: [
        col('source', 'Source'), col('enquiries', 'Enquiries', true), col('contacted', 'Contacted', true), col('qualified', 'Qualified', true), col('visits', 'Visited', true),
        col('applications', 'Applied', true), col('offers', 'Offered', true), col('enrolled', 'Enrolled', true), col('lost', 'Lost', true),
        col('conversion', 'Conversion %', true), col('spend', 'Marketing spend (INR)', true), col('costPerAdmission', 'Cost per admission (INR)', true),
      ],
      rows,
      truncated: false,
      summary: [
        { label: 'Enquiries', value: total('enquiries'), tone: 'info' },
        { label: 'Enrolled', value: total('enrolled'), tone: 'teal' },
        { label: 'Conversion', value: pctOrNull(total('enrolled'), total('enquiries')) ?? 0, unit: '%' },
        { label: 'Marketing spend', value: r2(total('spend')), unit: 'INR', tone: 'amber' },
      ],
      chart: chart('Enquiries by source', rows.map((r) => [r.source, r.enquiries] as [string, number])),
    };
  }

  private async feeDefaulters(ctx: Ctx): Promise<BuiltReport> {
    const list = await this.prisma.$queryRaw<{ id: string; overdue: number; outstanding: number; charges: number; oldest: Date }[]>(Prisma.sql`
      SELECT c."studentId"::text AS id,
        COALESCE(SUM(c.balance) FILTER (WHERE c."dueDate" < ${sqlDate(ctx.today)}), 0)::float8 AS overdue,
        SUM(c.balance)::float8 AS outstanding,
        COUNT(*) FILTER (WHERE c."dueDate" < ${sqlDate(ctx.today)})::int AS charges,
        MIN(c."dueDate") FILTER (WHERE c."dueDate" < ${sqlDate(ctx.today)}) AS oldest
      FROM "FinanceCharge" c
      JOIN "Student" s ON s.id = c."studentId"
      WHERE c.balance > 0 ${andCampus('c."campusId"', ctx.campusId)} ${andSections('s."sectionId"', ctx.sectionIds)}
      GROUP BY c."studentId"
      HAVING COALESCE(SUM(c.balance) FILTER (WHERE c."dueDate" < ${sqlDate(ctx.today)}), 0) > 0
      ORDER BY overdue DESC
      LIMIT ${MAX_ROWS + 1}`);
    const ids = list.map((r) => r.id);
    const info = await this.pupils(ids);
    const guardians = new Map<string, { name: string; phone: string }>();
    for (const part of chunks(ids, 5000)) {
      const links = await this.prisma.studentGuardian.findMany({
        where: { studentId: { in: part } }, orderBy: { isPrimary: 'desc' }, select: { studentId: true, guardian: { select: { fullName: true, phone: true } } },
      });
      for (const l of links) if (!guardians.has(l.studentId)) guardians.set(l.studentId, { name: l.guardian.fullName, phone: l.guardian.phone });
    }
    const rows = list.map((r) => {
      const s = info.get(r.id);
      const oldest = keyOf(r.oldest);
      return {
        admissionNo: s?.admissionNo ?? '', student: s?.fullName ?? 'Student', className: s?.label ?? null, campus: this.campus(ctx, s?.campusId),
        guardian: guardians.get(r.id)?.name ?? null, phone: guardians.get(r.id)?.phone ?? null,
        overdue: r2(num(r.overdue)), outstanding: r2(num(r.outstanding)), charges: r.charges, oldestDue: oldest, daysOverdue: Math.max(0, daysBetween(oldest, ctx.today)),
      };
    });
    const { rows: out, truncated } = capRows(rows);
    return {
      columns: [
        col('admissionNo', 'Admission no.'), col('student', 'Student'), col('className', 'Class'), col('campus', 'Campus'), col('guardian', 'Parent / guardian'),
        col('phone', 'Phone'), col('overdue', 'Overdue (INR)', true), col('outstanding', 'Total outstanding (INR)', true), col('charges', 'Overdue charges', true),
        col('oldestDue', 'Oldest due date'), col('daysOverdue', 'Days overdue', true),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Overdue', value: r2(rows.reduce((t, r) => t + r.overdue, 0)), unit: 'INR', tone: 'critical' },
        { label: 'Over 60 days', value: r2(rows.filter((r) => r.daysOverdue > 60).reduce((t, r) => t + r.overdue, 0)), unit: 'INR', tone: 'amber' },
        { label: 'Total outstanding', value: r2(rows.reduce((t, r) => t + r.outstanding, 0)), unit: 'INR' },
      ],
      chart: chart('Overdue by class (INR)', tally(list, (r) => info.get(r.id)?.className, (r) => num(r.overdue))),
    };
  }

  private async staffSummary(ctx: Ctx): Promise<BuiltReport> {
    const t = sqlDate(ctx.today);
    const list = await this.prisma.$queryRaw<{ campusId: string; department: string; total: number; teaching: number; present: number; leave: number; load: number | null; verified: number }[]>(Prisma.sql`
      SELECT e."campusId"::text AS "campusId", e.department,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE e."employeeType" = 'teaching')::int AS teaching,
        COUNT(*) FILTER (WHERE wa.status IN ('Present', 'Late', 'Half Day'))::int AS present,
        COUNT(*) FILTER (WHERE wa.status = 'On Leave' OR (wa.id IS NULL AND EXISTS (
          SELECT 1 FROM "WorkforceLeaveRequest" lr WHERE lr."employeeId" = e.id AND lr.status = 'Approved' AND lr."halfDay" = false
            AND lr."fromDate" <= ${t} AND lr."toDate" >= ${t})))::int AS leave,
        AVG(e."workloadPeriods")::float8 AS load,
        COUNT(*) FILTER (WHERE e."backgroundVerified")::int AS verified
      FROM "Employee" e
      LEFT JOIN "WorkforceAttendance" wa ON wa."employeeId" = e.id AND wa.date = ${t}
      WHERE e."archivedAt" IS NULL AND e."employmentStatus" <> 'exited' ${andCampus('e."campusId"', ctx.campusId)}
      GROUP BY e."campusId", e.department`);
    const rows = list
      .map((r) => ({
        campus: this.campus(ctx, r.campusId), department: r.department, total: r.total, teaching: r.teaching, nonTeaching: r.total - r.teaching,
        present: r.present, onLeave: r.leave, load: r.load != null ? r1(num(r.load)) : null, verified: pctOrNull(r.verified, r.total),
      }))
      .sort((a, b) => a.campus.localeCompare(b.campus) || a.department.localeCompare(b.department));
    const sum = (k: 'total' | 'teaching' | 'present' | 'nonTeaching') => rows.reduce((t2, r) => t2 + r[k], 0);
    const verified = list.reduce((t2, r) => t2 + r.verified, 0);
    return {
      columns: [
        col('campus', 'Campus'), col('department', 'Department'), col('total', 'Staff', true), col('teaching', 'Teaching', true), col('nonTeaching', 'Non-teaching', true),
        col('present', 'Present today', true), col('onLeave', 'On leave today', true), col('load', 'Average periods a week', true), col('verified', 'Background verified %', true),
      ],
      rows,
      truncated: false,
      summary: [
        { label: 'Teaching', value: sum('teaching'), tone: 'teal' },
        { label: 'Non-teaching', value: sum('nonTeaching'), tone: 'info' },
        { label: 'Present today', value: pctOrNull(sum('present'), sum('total')) ?? 0, unit: '%' },
        { label: 'Background verified', value: pctOrNull(verified, sum('total')) ?? 0, unit: '%', tone: 'violet' },
      ],
      chart: chart('Staff by department', tally(rows, (r) => r.department, (r) => r.total)),
    };
  }

  private async leaveRegister(ctx: Ctx): Promise<BuiltReport> {
    const list = await this.prisma.workforceLeaveRequest.findMany({
      where: { fromDate: { lte: dateOf(ctx.to) }, toDate: { gte: dateOf(ctx.from) }, ...(ctx.campusId ? { campusId: ctx.campusId } : {}) },
      orderBy: [{ fromDate: 'desc' }], take: MAX_ROWS + 1,
      select: {
        code: true, employeeId: true, campusId: true, fromDate: true, toDate: true, days: true, status: true, decidedByName: true, decidedAt: true, reason: true,
        leaveType: { select: { name: true } },
      },
    });
    const emps = await this.employees(list.map((l) => l.employeeId));
    const rows = list.map((l) => ({
      code: l.code, employee: emps.get(l.employeeId)?.fullName ?? 'Employee', department: emps.get(l.employeeId)?.department ?? null,
      campus: this.campus(ctx, l.campusId), type: l.leaveType.name, from: keyOf(l.fromDate), to: keyOf(l.toDate), days: l.days, status: l.status,
      decidedBy: l.decidedByName, decidedOn: l.decidedAt ? istKey(l.decidedAt) : null, reason: l.reason,
    }));
    const { rows: out, truncated } = capRows(rows);
    const approved = rows.filter((r) => r.status === 'Approved');
    return {
      columns: [
        col('code', 'Reference'), col('employee', 'Employee'), col('department', 'Department'), col('campus', 'Campus'), col('type', 'Leave type'), col('from', 'From'),
        col('to', 'To'), col('days', 'Days', true), col('status', 'Status'), col('decidedBy', 'Decided by'), col('decidedOn', 'Decided on'), col('reason', 'Reason'),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Days approved', value: r1(approved.reduce((t, r) => t + r.days, 0)), tone: 'teal' },
        { label: 'Waiting for a decision', value: rows.filter((r) => r.status === 'Submitted' || r.status === 'Under Review').length, tone: 'amber' },
        { label: 'Rejected', value: rows.filter((r) => r.status === 'Rejected').length, tone: 'critical' },
      ],
      chart: chart('Days approved by leave type', tally(approved, (r) => r.type, (r) => r.days)),
    };
  }

  private async pendingApprovals(ctx: Ctx): Promise<BuiltReport> {
    const q = await this.overview.approvalQueue(ctx.campusId, ctx.today);
    const rows = q.items.map((i) => ({
      kind: i.kind, request: i.title, requestor: i.requestor, amount: i.amount, days: i.days, raisedOn: istKey(new Date(i.raisedAt)),
      waiting: Math.max(0, daysBetween(istKey(new Date(i.raisedAt)), ctx.today)), deadline: i.deadline, priority: i.priority,
    }));
    return {
      columns: [
        col('kind', 'Kind'), col('request', 'Request'), col('requestor', 'Requested by'), col('amount', 'Amount (INR)', true), col('days', 'Days', true),
        col('raisedOn', 'Raised on'), col('waiting', 'Days waiting', true), col('deadline', 'Decide by'), col('priority', 'Priority'),
      ],
      rows,
      truncated: false,
      summary: [
        { label: 'Past the decision date', value: q.overdue, tone: 'critical' },
        { label: 'High priority', value: rows.filter((r) => r.priority === 'High').length, tone: 'amber' },
        { label: 'Value waiting', value: q.amount, unit: 'INR' },
      ],
      chart: chart('Waiting by kind', tally(rows, (r) => r.kind)),
    };
  }

  private async campusSummary(ctx: Ctx): Promise<BuiltReport> {
    const [{ campuses }, incidents] = await Promise.all([
      this.metrics.all(),
      this.prisma.safetyIncident.groupBy({ by: ['campusId'], where: { status: { not: 'Closed' } }, _count: { _all: true } }),
    ]);
    const rows = campuses
      .filter((c) => !ctx.campusId || c.id === ctx.campusId)
      .map((c) => ({
        campus: c.name, students: c.students, staff: c.staff, staffing: c.staffingPct, attendance: c.attendancePct, collection: c.collectionPct,
        billed: c.billed, outstanding: c.outstanding, admissions: c.admissionsYtd, enquiries: c.enquiriesYtd, atRisk: c.atRisk, academic: c.academicIndex,
        incidents: incidents.find((i) => i.campusId === c.id)?._count._all ?? 0,
      }));
    const sum = (k: 'students' | 'staff' | 'admissions') => rows.reduce((t, r) => t + r[k], 0);
    return {
      columns: [
        col('campus', 'Campus'), col('students', 'Students', true), col('staff', 'Staff', true), col('staffing', 'Staff filled %', true), col('attendance', 'Attendance %', true),
        col('collection', 'Fee collection %', true), col('billed', 'Billed (INR)', true), col('outstanding', 'Outstanding (INR)', true), col('admissions', 'Admissions this year', true),
        col('enquiries', 'Enquiries this year', true), col('atRisk', 'Needing attention', true), col('academic', 'Academic index %', true), col('incidents', 'Open incidents', true),
      ],
      rows,
      truncated: false,
      summary: [
        { label: 'Students', value: sum('students'), tone: 'teal' },
        { label: 'Staff', value: sum('staff'), tone: 'info' },
        { label: 'Admissions this year', value: sum('admissions'), tone: 'violet' },
      ],
      chart: chart('Students by campus', rows.map((r) => [r.campus, r.students] as [string, number])),
    };
  }

  // ---- System ----------------------------------------------------------------

  private async userAccess(ctx: Ctx): Promise<BuiltReport> {
    const now = new Date();
    const d30 = new Date(Date.now() - 30 * 86_400_000);
    const list = await this.prisma.user.findMany({
      where: ctx.campusId ? { OR: [{ campusId: ctx.campusId }, { campusId: null }] } : {},
      orderBy: { fullName: 'asc' }, take: MAX_ROWS + 1,
      select: {
        fullName: true, email: true, phone: true, status: true, campusId: true, lastLoginAt: true, lastLoginClient: true, failedLogins: true, lockedUntil: true,
        createdAt: true, mustChangePassword: true, role: { select: { name: true } },
      },
    });
    const rows = list.map((u) => ({
      name: u.fullName, email: u.email, phone: u.phone, role: u.role.name, campus: u.campusId ? this.campus(ctx, u.campusId) : 'All campuses', status: u.status,
      lastSignIn: stamp(u.lastLoginAt), client: u.lastLoginClient, failed: u.failedLogins, locked: yes(!!u.lockedUntil && u.lockedUntil > now),
      mustChange: yes(u.mustChangePassword), created: istKey(u.createdAt),
    }));
    const { rows: out, truncated } = capRows(rows);
    return {
      columns: [
        col('name', 'Name'), col('email', 'Email'), col('phone', 'Phone'), col('role', 'Role'), col('campus', 'Campus'), col('status', 'Status'),
        col('lastSignIn', 'Last sign-in'), col('client', 'Signed in from'), col('failed', 'Failed attempts', true), col('locked', 'Locked'),
        col('mustChange', 'Must change password'), col('created', 'Created'),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Active', value: list.filter((u) => u.status === 'active').length, tone: 'teal' },
        { label: 'Locked now', value: list.filter((u) => u.lockedUntil && u.lockedUntil > now).length, tone: 'critical' },
        { label: 'Dormant 30+ days', value: list.filter((u) => u.status === 'active' && (u.lastLoginAt ? u.lastLoginAt < d30 : u.createdAt < d30)).length, tone: 'amber' },
      ],
      chart: chart('Accounts by role', tally(list, (u) => u.role.name)),
      sensitive: true,
    };
  }

  private auditRange(ctx: Ctx): Prisma.AuditLogWhereInput {
    return {
      createdAt: { gte: istStart(ctx.from), lt: istStart(addDays(ctx.to, 1)) },
      ...(ctx.campusId ? { OR: [{ campusId: ctx.campusId }, { campusId: null }] } : {}),
    };
  }

  private async signIns(ctx: Ctx): Promise<BuiltReport> {
    const where: Prisma.AuditLogWhereInput = { ...this.auditRange(ctx), action: { in: ['login', 'login_failed', 'logout', 'device_auth_failed'] } };
    const [list, byAction, people] = await Promise.all([
      this.prisma.auditLog.findMany({
        where, orderBy: { createdAt: 'desc' }, take: MAX_ROWS + 1,
        select: { createdAt: true, userName: true, role: true, action: true, ip: true, device: true, userAgent: true, description: true },
      }),
      this.prisma.auditLog.groupBy({ by: ['action'], where, _count: { _all: true } }),
      this.prisma.auditLog.groupBy({ by: ['userName'], where: { ...where, action: 'login' }, _count: { _all: true } }),
    ]);
    const LABEL: Record<string, string> = { login: 'Signed in', login_failed: 'Failed sign-in', logout: 'Signed out', device_auth_failed: 'Device rejected' };
    const rows = list.map((e) => ({
      at: stamp(e.createdAt), user: e.userName, role: e.role ? e.role.replace(/_/g, ' ') : null, event: LABEL[e.action] ?? e.action, ip: e.ip, device: e.device,
      agent: e.userAgent, description: e.description,
    }));
    const { rows: out, truncated } = capRows(rows);
    const n = (a: string) => byAction.find((b) => b.action === a)?._count._all ?? 0;
    return {
      columns: [
        col('at', 'When'), col('user', 'Account'), col('role', 'Role'), col('event', 'Event'), col('ip', 'IP address'), col('device', 'Client'), col('agent', 'Browser / device'),
        col('description', 'Detail'),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Sign-ins', value: n('login'), tone: 'teal' },
        { label: 'Failed sign-ins', value: n('login_failed') + n('device_auth_failed'), tone: 'critical' },
        { label: 'People signed in', value: people.filter((p) => p.userName).length, tone: 'info' },
      ],
      chart: chart('Sign-ins by person', people.filter((p) => p.userName).map((p) => [p.userName!, p._count._all] as [string, number])),
      sensitive: true,
    };
  }

  private async roleMatrix(): Promise<BuiltReport> {
    const [roles, permissions] = await Promise.all([
      this.prisma.role.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { key: true, name: true, scope: true, permissions: { select: { permissionKey: true } }, _count: { select: { users: { where: { status: 'active' } } } } },
      }),
      this.prisma.permission.findMany({ orderBy: { sortOrder: 'asc' } }),
    ]);
    const held = new Map(roles.map((r) => [r.key, new Set(r.permissions.map((p) => p.permissionKey))]));
    const rows = permissions.map((p) => ({
      area: p.module, permission: p.key, description: p.description,
      ...Object.fromEntries(roles.map((r) => [`role_${r.key}`, held.get(r.key)!.has(p.key) ? 'Yes' : ''])),
      roles: roles.filter((r) => held.get(r.key)!.has(p.key)).length,
    }));
    return {
      columns: [
        col('area', 'Area'), col('permission', 'Permission'), col('description', 'Allows'),
        ...roles.map((r) => col(`role_${r.key}`, `${r.name} (${r._count.users})`)),
        col('roles', 'Roles holding it', true),
      ],
      rows,
      truncated: false,
      summary: [
        { label: 'Roles', value: roles.length, tone: 'info' },
        { label: 'Permissions', value: permissions.length },
        { label: 'Active accounts', value: roles.reduce((t, r) => t + r._count.users, 0), tone: 'teal' },
      ],
      chart: chart('Permissions per role', roles.map((r) => [r.name, held.get(r.key)!.size] as [string, number])),
    };
  }

  private async auditTrail(ctx: Ctx): Promise<BuiltReport> {
    const where = this.auditRange(ctx);
    const [list, byModule, sensitive, changes, people] = await Promise.all([
      this.prisma.auditLog.findMany({
        where, orderBy: { createdAt: 'desc' }, take: MAX_ROWS + 1,
        select: { createdAt: true, userName: true, role: true, action: true, module: true, entityType: true, entityId: true, description: true, ip: true, device: true, sensitive: true },
      }),
      this.prisma.auditLog.groupBy({ by: ['module'], where, _count: { _all: true } }),
      this.prisma.auditLog.count({ where: { ...where, sensitive: true } }),
      this.prisma.auditLog.count({ where: { ...where, action: { in: ['create', 'update', 'delete', 'approve', 'reject', 'publish', 'export'] } } }),
      this.prisma.auditLog.groupBy({ by: ['userId'], where: { ...where, userId: { not: null } } }),
    ]);
    const rows = list.map((e) => ({
      at: stamp(e.createdAt), user: e.userName ?? 'System', role: e.role ? e.role.replace(/_/g, ' ') : null, action: e.action, module: moduleLabel(e.module),
      entity: e.entityType ? `${e.entityType}${e.entityId ? ` ${e.entityId}` : ''}` : null, description: e.description, ip: e.ip, device: e.device, sensitive: yes(e.sensitive),
    }));
    const { rows: out, truncated } = capRows(rows);
    return {
      columns: [
        col('at', 'When'), col('user', 'Who'), col('role', 'Role'), col('action', 'Action'), col('module', 'Area'), col('entity', 'Record'), col('description', 'What happened'),
        col('ip', 'IP address'), col('device', 'Client'), col('sensitive', 'Sensitive'),
      ],
      rows: out,
      truncated,
      summary: [
        { label: 'Changes', value: changes, tone: 'info' },
        { label: 'Sensitive records', value: sensitive, tone: 'critical' },
        { label: 'People', value: people.length, tone: 'teal' },
      ],
      chart: chart('Entries by area', byModule.map((m) => [moduleLabel(m.module), m._count._all] as [string, number])),
      sensitive: true,
    };
  }

  /** Values the CSV export uses for its file name. */
  static fileName(key: string) {
    return `${key}-${todayKey()}.csv`;
  }
}
