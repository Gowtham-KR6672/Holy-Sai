import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { FinanceLedgerService } from '../finance/ledger.service';
import { SettingsService } from '../settings/settings.service';
import { CommandCenterService } from './command-center.service';
import { addDays, currentTerms, num, pctOrNull, r1, r2, ShortCache, sqlDate, todayKey } from './insights.util';

export interface CampusMetrics {
  id: string; code: string; name: string; shortName: string; place: string; curriculum: string | null; address: string | null; established: number | null;
  students: number; atRisk: number; staff: number; staffTarget: number | null; staffingPct: number | null;
  admissionsYtd: number; enquiriesYtd: number; attendancePct: number | null; attendanceRecent: number | null; attendancePrevious: number | null;
  billed: number; collected: number; outstanding: number; collectionPct: number | null;
  engagement: number | null; nps: number | null; npsPrevious: number | null; npsMeasuredOn: string | null;
  academicIndex: number | null; academicPrevious: number | null; participationPct: number | null;
}

export interface MetricRow { key: string; label: string; format: 'n' | 'pct'; hint: string; values: Record<string, number | null>; group: number | null }

/** Raw numerators and denominators per campus, so group totals are computed from rows, not averaged percentages. */
interface Raw {
  attYear: [number, number]; attRecent: [number, number]; attPrev: [number, number];
  marks: [number, number]; engagement: [number, number]; participation: [number, number];
}

/**
 * Live figures for every campus of the group, shared by the Campuses, Group Dashboard and Campus Comparison
 * pages and the Campus summary report. One grouped query per measure, never a loop over campuses.
 */
@Injectable()
export class GroupMetricsService {
  private readonly cache = new ShortCache(30_000, 20);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: FinanceLedgerService,
    private readonly cc: CommandCenterService,
    private readonly settings: SettingsService,
  ) {}

  /** Campus metrics plus the comparison rows (cached briefly; the pages poll and share the figures). */
  async all(): Promise<{ campuses: CampusMetrics[]; rows: MetricRow[]; raw: Map<string, Raw> }> {
    return this.cache.get('all', () => this.compute());
  }

  /** Drops the cached figures (after a campus edit or a completed transfer). */
  invalidate() {
    this.cache.clear();
  }

  private async compute() {
    const today = todayKey();
    const y = await this.ledger.year();
    const { current, previous } = currentTerms(y, today);
    const yStart = y.start.toISOString().slice(0, 10);
    const recentFrom = addDays(today, -29);
    const prevFrom = addDays(today, -59);
    const prevTo = addDays(today, -30);
    const attFrom = yStart < prevFrom ? yStart : prevFrom;
    const curEnd = today < current.end ? today : current.end;

    const campuses = await this.prisma.campus.findMany({ where: { isActive: true }, orderBy: [{ establishedYear: 'asc' }, { name: 'asc' }] });
    if (!campuses.length) return { campuses: [], rows: [], raw: new Map<string, Raw>() };

    const [students, atRisk, staff, staffingSetting, enrolled, enquiries, att, fees, engagement, academic, participation] = await Promise.all([
      this.prisma.student.groupBy({ by: ['campusId'], where: { status: 'active' }, _count: { _all: true } }),
      this.prisma.student.groupBy({ by: ['campusId'], where: { status: 'active', risk: { in: ['At Risk', 'Developing Risk'] } }, _count: { _all: true } }),
      this.prisma.employee.groupBy({ by: ['campusId'], where: { archivedAt: null, employmentStatus: { not: 'exited' } }, _count: { _all: true } }),
      this.settings.get<Record<string, number>>('staffing.target', {}),
      this.prisma.admissionLead.groupBy({ by: ['campusId'], where: { stage: 'Enrolled', enrolledAt: { gte: y.start } }, _count: { _all: true } }),
      this.prisma.admissionLead.groupBy({ by: ['campusId'], where: { createdAt: { gte: y.start } }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ id: string; ym: number; ya: number; rm: number; ra: number; pm: number; pa: number }[]>(Prisma.sql`
        SELECT a."campusId"::text AS id,
          COUNT(*) FILTER (WHERE a.date >= ${sqlDate(yStart)})::int AS ym,
          COUNT(*) FILTER (WHERE a.date >= ${sqlDate(yStart)} AND a.status IN ('present', 'late'))::int AS ya,
          COUNT(*) FILTER (WHERE a.date >= ${sqlDate(recentFrom)})::int AS rm,
          COUNT(*) FILTER (WHERE a.date >= ${sqlDate(recentFrom)} AND a.status IN ('present', 'late'))::int AS ra,
          COUNT(*) FILTER (WHERE a.date BETWEEN ${sqlDate(prevFrom)} AND ${sqlDate(prevTo)})::int AS pm,
          COUNT(*) FILTER (WHERE a.date BETWEEN ${sqlDate(prevFrom)} AND ${sqlDate(prevTo)} AND a.status IN ('present', 'late'))::int AS pa
        FROM "StudentAttendance" a
        WHERE a.date BETWEEN ${sqlDate(attFrom)} AND ${sqlDate(today)}
        GROUP BY a."campusId"`),
      this.prisma.$queryRaw<{ id: string; billed: number; collected: number; outstanding: number }[]>(Prisma.sql`
        SELECT c."campusId"::text AS id, SUM(c.amount - c.concession)::float8 AS billed, SUM(c.paid)::float8 AS collected, SUM(c.balance)::float8 AS outstanding
        FROM "FinanceCharge" c WHERE ${this.cc.chargeScope(y)} GROUP BY c."campusId"`),
      this.prisma.$queryRaw<{ id: string; total: number; n: number }[]>(Prisma.sql`
        SELECT x.cid AS id, SUM(x.score)::float8 AS total, COUNT(*)::int AS n FROM (
          SELECT DISTINCT s."campusId"::text AS cid, g.id, g."engagementScore" AS score
          FROM "Guardian" g
          JOIN "StudentGuardian" sg ON sg."guardianId" = g.id
          JOIN "Student" s ON s.id = sg."studentId" AND s.status = 'active'
        ) x GROUP BY x.cid`),
      this.prisma.$queryRaw<{ id: string; cs: number; cn: number; ps: number; pn: number }[]>(Prisma.sql`
        SELECT a."campusId"::text AS id,
          COALESCE(SUM(m.marks / a."maxMarks" * 100) FILTER (WHERE a."heldOn" BETWEEN ${sqlDate(current.start)} AND ${sqlDate(curEnd)}), 0)::float8 AS cs,
          COUNT(*) FILTER (WHERE a."heldOn" BETWEEN ${sqlDate(current.start)} AND ${sqlDate(curEnd)})::int AS cn,
          COALESCE(SUM(m.marks / a."maxMarks" * 100) FILTER (WHERE a."heldOn" BETWEEN ${sqlDate(previous.start)} AND ${sqlDate(previous.end)}), 0)::float8 AS ps,
          COUNT(*) FILTER (WHERE a."heldOn" BETWEEN ${sqlDate(previous.start)} AND ${sqlDate(previous.end)})::int AS pn
        FROM "AssessmentMark" m JOIN "Assessment" a ON a.id = m."assessmentId"
        WHERE m.marks IS NOT NULL AND m."isAbsent" = false AND a."maxMarks" > 0
          AND a."heldOn" BETWEEN ${sqlDate(previous.start)} AND ${sqlDate(curEnd)}
        GROUP BY a."campusId"`),
      this.prisma.$queryRaw<{ id: string; n: number; total: number }[]>(Prisma.sql`
        SELECT s."campusId"::text AS id, COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE
            EXISTS (SELECT 1 FROM "InnovationProjectMember" pm JOIN "InnovationProject" p ON p.id = pm."projectId"
                    WHERE pm."studentId" = s.id AND (p.status = 'Active' OR p."completedOn" >= ${sqlDate(yStart)}))
            OR EXISTS (SELECT 1 FROM "InnovationAchievement" ach WHERE ach."studentId" = s.id AND ach."achievedOn" >= ${sqlDate(yStart)})
          )::int AS n
        FROM "Student" s WHERE s.status = 'active' GROUP BY s."campusId"`),
    ]);

    const cnt = (rows: { campusId: string; _count: { _all: number } }[], id: string) => rows.find((r) => r.campusId === id)?._count._all ?? 0;
    const raw = new Map<string, Raw>();
    const metrics: CampusMetrics[] = campuses.map((c) => {
      const a = att.find((r) => r.id === c.id);
      const f = fees.find((r) => r.id === c.id);
      const e = engagement.find((r) => r.id === c.id);
      const m = academic.find((r) => r.id === c.id);
      const p = participation.find((r) => r.id === c.id);
      const staffN = cnt(staff, c.id);
      const target = c.staffingTarget > 0 ? c.staffingTarget : Number(staffingSetting?.[c.code]) || null;
      const billed = r2(num(f?.billed));
      const collected = r2(num(f?.collected));
      raw.set(c.id, {
        attYear: [a?.ya ?? 0, a?.ym ?? 0], attRecent: [a?.ra ?? 0, a?.rm ?? 0], attPrev: [a?.pa ?? 0, a?.pm ?? 0],
        marks: [num(m?.cs), m?.cn ?? 0], engagement: [num(e?.total), e?.n ?? 0], participation: [p?.n ?? 0, p?.total ?? 0],
      });
      return {
        id: c.id, code: c.code, name: c.name, shortName: c.shortName, place: c.place, curriculum: c.curriculum || null, address: c.address,
        established: c.establishedYear,
        students: cnt(students, c.id),
        atRisk: cnt(atRisk, c.id),
        staff: staffN,
        staffTarget: target,
        staffingPct: target ? pctOrNull(staffN, target) : null,
        admissionsYtd: cnt(enrolled, c.id),
        enquiriesYtd: cnt(enquiries, c.id),
        attendancePct: pctOrNull(a?.ya ?? 0, a?.ym ?? 0),
        attendanceRecent: pctOrNull(a?.ra ?? 0, a?.rm ?? 0),
        attendancePrevious: pctOrNull(a?.pa ?? 0, a?.pm ?? 0),
        billed,
        collected,
        outstanding: r2(num(f?.outstanding)),
        collectionPct: pctOrNull(collected, billed),
        engagement: e?.n ? Math.round(num(e.total) / e.n) : null,
        // No parent survey is recorded in the system yet, so NPS has no source.
        nps: null,
        npsPrevious: null,
        npsMeasuredOn: null,
        academicIndex: m?.cn ? r1(num(m.cs) / m.cn) : null,
        academicPrevious: m?.pn ? r1(num(m.ps) / m.pn) : null,
        participationPct: pctOrNull(p?.n ?? 0, p?.total ?? 0),
      };
    });
    return { campuses: metrics, rows: this.rows(metrics, raw), raw };
  }

  private rows(campuses: CampusMetrics[], raw: Map<string, Raw>): MetricRow[] {
    const sum = (f: (c: CampusMetrics) => number) => campuses.reduce((s, c) => s + f(c), 0);
    const ratio = (f: (r: Raw) => [number, number], scale = 100) => {
      let a = 0;
      let b = 0;
      for (const r of raw.values()) {
        const [x, y] = f(r);
        a += x;
        b += y;
      }
      return b > 0 ? r1((a / b) * scale) : null;
    };
    const values = (f: (c: CampusMetrics) => number | null) => Object.fromEntries(campuses.map((c) => [c.id, f(c)]));
    const staffTarget = sum((c) => c.staffTarget ?? 0);
    const billed = sum((c) => c.billed);
    return [
      { key: 'students', label: 'Students', format: 'n', hint: 'Active enrolment', values: values((c) => c.students), group: sum((c) => c.students) },
      { key: 'attendance', label: 'Attendance', format: 'pct', hint: 'Present or late, this academic year', values: values((c) => c.attendancePct), group: ratio((r) => r.attYear) },
      { key: 'collection', label: 'Fee collection', format: 'pct', hint: 'Collected against billed, this academic year', values: values((c) => c.collectionPct), group: billed > 0 ? r1((sum((c) => c.collected) / billed) * 100) : null },
      { key: 'academic', label: 'Academic index', format: 'pct', hint: 'Latest-term mean score', values: values((c) => c.academicIndex), group: ratio((r) => r.marks, 1) },
      { key: 'staffing', label: 'Staff filled', format: 'pct', hint: 'Staff on the books against approved positions', values: values((c) => c.staffingPct), group: staffTarget > 0 ? r1((sum((c) => c.staff) / staffTarget) * 100) : null },
      { key: 'admissions', label: 'Admissions this year', format: 'n', hint: 'Enquiries enrolled this academic year', values: values((c) => c.admissionsYtd), group: sum((c) => c.admissionsYtd) },
      { key: 'engagement', label: 'Parent engagement', format: 'n', hint: 'Average family engagement score (0–100)', values: values((c) => c.engagement), group: ratio((r) => r.engagement, 1) },
      { key: 'participation', label: 'Participation', format: 'pct', hint: 'Students in a project or with an achievement this year', values: values((c) => c.participationPct), group: ratio((r) => r.participation) },
    ];
  }

  /** Radar for the academic-index card: attainment, progress (50 = no change), attendance, participation, engagement. */
  radar(campuses: CampusMetrics[]) {
    const progress = (c: CampusMetrics) =>
      c.academicIndex != null && c.academicPrevious != null ? Math.max(0, Math.min(100, r1(50 + (c.academicIndex - c.academicPrevious)))) : null;
    return {
      axes: ['Attainment', 'Progress', 'Attendance', 'Participation', 'Engagement'],
      series: campuses.map((c) => ({
        campusId: c.id,
        name: c.shortName,
        values: [c.academicIndex, progress(c), c.attendancePct, c.participationPct, c.engagement],
      })),
    };
  }

  /** Group-wide headline figures for the Group Dashboard. */
  async kpis(campuses: CampusMetrics[], raw: Map<string, Raw>) {
    const sum = (f: (c: CampusMetrics) => number) => campuses.reduce((s, c) => s + f(c), 0);
    const tot = (f: (r: Raw) => [number, number]) => {
      let a = 0;
      let b = 0;
      for (const r of raw.values()) {
        a += f(r)[0];
        b += f(r)[1];
      }
      return pctOrNull(a, b);
    };
    const staffTarget = sum((c) => c.staffTarget ?? 0);
    const staff = sum((c) => c.staff);
    const billed = sum((c) => c.billed);
    const collected = sum((c) => c.collected);
    const recent = tot((r) => r.attRecent);
    const prev = tot((r) => r.attPrev);
    const target = Number(await this.settings.get<number>('admissions.group_target', 0)) || null;
    return {
      campuses: campuses.length,
      students: sum((c) => c.students),
      staff,
      staffTarget: staffTarget || null,
      staffingPct: staffTarget ? pctOrNull(staff, staffTarget) : null,
      admissionsYtd: sum((c) => c.admissionsYtd),
      admissionsTarget: target,
      attendancePct: recent,
      attendanceDelta: recent != null && prev != null ? r1(recent - prev) : null,
      feesCollected: r2(collected),
      feesOutstanding: r2(sum((c) => c.outstanding)),
      collectionPct: pctOrNull(collected, billed),
      nps: null,
      npsDelta: null,
      atRisk: sum((c) => c.atRisk),
    };
  }
}
