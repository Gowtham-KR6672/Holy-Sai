import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { forbidden } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { CPD_TARGET } from '../workforce/workforce.util';
import { EarlyWarningService } from './early-warning.service';
import { addDays, asDate, dayKey, loadTerms, mean, pct, pct1, recentSchoolDays, round1, schoolToday, shortDate, termOf, weekdayOf } from './intel.util';
import { StudentExtrasService } from './student-extras.service';

type LV = { label: string; value: number };

export const AREAS = [
  { id: 'students', label: 'Students', perms: ['students.read', 'students.read_assigned', 'reports.read'] },
  { id: 'attendance', label: 'Attendance', perms: ['attendance.read', 'students.read', 'students.read_assigned', 'reports.read'] },
  { id: 'academics', label: 'Academics', perms: ['academics.read', 'students.read', 'students.read_assigned', 'reports.read'] },
  { id: 'admissions', label: 'Admissions', perms: ['admissions.read', 'admissions.manage'] },
  { id: 'finance', label: 'Finance', perms: ['finance.read', 'finance.manage'] },
  { id: 'workforce', label: 'Workforce', perms: ['hr.read', 'hr.manage'] },
  { id: 'safety', label: 'Safety & transport', perms: ['safety.read', 'safety.manage', 'transport.read', 'transport.manage'] },
] as const;

const IST = 330 * 60_000;
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
const FUNNEL = ['New Lead', 'Contacted', 'Qualified', 'Visit Scheduled', 'Visit Completed', 'Application', 'Assessment', 'Offer', 'Enrolled'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Months (school time) ending with the current one: { start, end, label } as instants. */
function lastMonths(n: number) {
  const now = new Date(Date.now() + IST);
  return Array.from({ length: n }, (_, i) => {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() - (n - 1 - i);
    const start = new Date(Date.UTC(y, m, 1) - IST);
    const end = new Date(Date.UTC(y, m + 1, 1) - IST);
    return { start, end, label: MONTH.format(new Date(Date.UTC(y, m, 15))), dStart: dayKey(new Date(Date.UTC(y, m, 1))), dEnd: dayKey(new Date(Date.UTC(y, m + 1, 0))) };
  });
}

/** Analytics: the figures the Command Center summarises, per area, from live records. */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ew: EarlyWarningService,
    private readonly extras: StudentExtrasService,
  ) {}

  areas(user: AuthUser) {
    return AREAS.filter((a) => a.perms.some((p) => user.permissions.has(p))).map((a) => ({ id: a.id, label: a.label }));
  }

  async scopeLabel(user: AuthUser, campusId?: string) {
    if (user.scope === 'class' && !user.permissions.has('students.read')) return 'Your classes';
    const c = this.scope.campus(user, campusId);
    if (!c) return 'All campuses';
    return (await this.prisma.campus.findUnique({ where: { id: c }, select: { name: true } }))?.name ?? 'Campus';
  }

  async build(area: string, user: AuthUser, campusId?: string): Promise<Record<string, unknown>> {
    const def = AREAS.find((a) => a.id === area);
    if (!def || !def.perms.some((p) => user.permissions.has(p))) throw forbidden('This analytics area is outside your access');
    const campus = this.scope.campus(user, campusId);
    switch (area) {
      case 'students':
        return this.students(user, campusId);
      case 'attendance':
        return this.attendance(user, campusId);
      case 'academics':
        return this.academics(user, campusId);
      case 'admissions':
        return this.admissions(campus);
      case 'finance':
        return this.finance(campus);
      case 'workforce':
        return this.workforce(campus);
      default:
        return this.safety(campus);
    }
  }

  private async scopedStudents(user: AuthUser, campusId?: string) {
    const where: Prisma.StudentWhereInput = { AND: [await this.scope.studentWhere(user, campusId), { status: 'active' }] };
    return this.prisma.student.findMany({ where, select: { id: true, sectionId: true, section: { select: { class: { select: { name: true, gradeLevel: true } } } } } });
  }

  // ---------------------------------------------------------------------------

  private async students(user: AuthUser, campusId?: string) {
    const students = await this.scopedStudents(user, campusId);
    const ids = students.map((s) => s.id);
    const grades = new Map<string, { level: number; n: number }>();
    for (const s of students) {
      const g = grades.get(s.section.class.name) ?? { level: s.section.class.gradeLevel, n: 0 };
      g.n++;
      grades.set(s.section.class.name, g);
    }
    const enrolment = [...grades.entries()].sort((a, b) => a[1].level - b[1].level).map(([label, g]) => ({ label, value: g.n }));
    const states = await this.ew.states(ids);
    const bands: LV[] = ['On Track', 'Watch', 'Developing Risk', 'At Risk'].map((b) => ({ label: b, value: ids.filter((id) => (states.get(id)?.band ?? 'On Track') === b).length }));

    const months = lastMonths(6);
    const signals = ids.length
      ? await this.prisma.earlyWarningSignal.findMany({ where: { studentId: { in: ids }, OR: [{ createdAt: { gte: months[0].start } }, { closedAt: { gte: months[0].start } }] }, select: { createdAt: true, closedAt: true } })
      : [];
    const signalRows = months.map((m) => ({
      label: m.label,
      raised: signals.filter((s) => s.createdAt >= m.start && s.createdAt < m.end).length,
      closed: signals.filter((s) => s.closedAt && s.closedAt >= m.start && s.closedAt < m.end).length,
    }));

    const bandsAtt = [
      { label: '92% and above', test: (a: number) => a >= 92 },
      { label: '85–92%', test: (a: number) => a >= 85 && a < 92 },
      { label: 'Below 85%', test: (a: number) => a < 85 },
    ];
    const attendanceVsAverage = bandsAtt.map((b) => {
      const inBand = [...states.values()].filter((s) => s.attendancePct != null && s.markedDays >= 5 && b.test(s.attendancePct));
      const avgs = inBand.map((s) => s.average).filter((x): x is number => x != null);
      return { label: b.label, value: avgs.length ? Math.round(mean(avgs)!) : null, students: inBand.length };
    });
    const acts = await this.extras.activities(ids);
    const achievers = ids.length
      ? await this.prisma.innovationAchievement.findMany({ where: { studentId: { in: ids }, achievedOn: { gte: asDate(addDays(schoolToday(), -365)) } }, select: { studentId: true }, distinct: ['studentId'] })
      : [];
    const participating = new Set([...acts.filter((a) => a.status === 'Active').map((a) => a.studentId), ...achievers.map((a) => a.studentId)]).size;
    return { enrolment, bands, signals: signalRows, attendanceVsAverage, participation: { participating, total: ids.length } };
  }

  private async attendance(user: AuthUser, campusId?: string) {
    const students = await this.scopedStudents(user, campusId);
    const ids = students.map((s) => s.id);
    const today = schoolToday();
    const grade = new Map(students.map((s) => [s.id, { name: s.section.class.name, level: s.section.class.gradeLevel }]));
    const empty = { today: { marked: 0, students: ids.length, present: 0, absent: 0, late: 0 }, trend: [], byGrade: [], weekday: [] };
    if (!ids.length) return empty;
    const from60 = addDays(today, -60);
    const rows = await this.prisma.studentAttendance.findMany({ where: { studentId: { in: ids }, date: { gte: asDate(from60), lte: asDate(today) } }, select: { studentId: true, date: true, status: true } });
    const att = (s: string) => s === 'present' || s === 'late';
    const t = rows.filter((r) => dayKey(r.date) === today);
    const days = recentSchoolDays(today, 20);
    const trend = days
      .map((d) => {
        const ds = rows.filter((r) => dayKey(r.date) === d);
        return ds.length ? { label: shortDate(d), value: pct1(ds.filter((r) => att(r.status)).length, ds.length) } : null;
      })
      .filter((x): x is LV => !!x);
    const from30 = addDays(today, -30);
    const byGradeMap = new Map<string, { level: number; n: number; ok: number }>();
    for (const r of rows) {
      if (dayKey(r.date) < from30) continue;
      const g = grade.get(r.studentId);
      if (!g) continue;
      const cur = byGradeMap.get(g.name) ?? { level: g.level, n: 0, ok: 0 };
      cur.n++;
      if (att(r.status)) cur.ok++;
      byGradeMap.set(g.name, cur);
    }
    const byGrade = [...byGradeMap.entries()].sort((a, b) => a[1].level - b[1].level).map(([label, g]) => ({ label, value: pct1(g.ok, g.n) }));
    const wd = new Map<number, number>();
    for (const r of rows) if (r.status === 'absent') wd.set(weekdayOf(dayKey(r.date)), (wd.get(weekdayOf(dayKey(r.date))) ?? 0) + 1);
    const weekday = rows.length ? [1, 2, 3, 4, 5, 6].map((d) => ({ label: WEEKDAYS[d], value: wd.get(d) ?? 0 })) : [];
    return {
      today: { marked: t.length, students: ids.length, present: t.filter((r) => att(r.status)).length, absent: t.filter((r) => r.status === 'absent').length, late: t.filter((r) => r.status === 'late').length },
      trend, byGrade, weekday,
    };
  }

  private async academics(user: AuthUser, campusId?: string) {
    const students = await this.scopedStudents(user, campusId);
    const ids = students.map((s) => s.id);
    const terms = await loadTerms(this.prisma);
    const today = schoolToday();
    const marks = ids.length
      ? await this.prisma.assessmentMark.findMany({
          where: { studentId: { in: ids }, isAbsent: false, marks: { not: null }, assessment: { heldOn: { gte: asDate(addDays(today, -730)), lte: asDate(today) } } },
          select: { marks: true, assessment: { select: { subjectId: true, maxMarks: true, heldOn: true } } },
        })
      : [];
    const tIndex = (k: string) => {
      let idx = -1;
      terms.forEach((t, i) => { if (t.start <= k) idx = i; });
      return idx;
    };
    const rows = marks.filter((m) => m.assessment.maxMarks > 0).map((m) => ({ subjectId: m.assessment.subjectId, pct: (100 * (m.marks ?? 0)) / m.assessment.maxMarks, term: tIndex(dayKey(m.assessment.heldOn)) }));
    const withMarks = [...new Set(rows.map((r) => r.term))].filter((i) => i >= 0).sort((a, b) => a - b);
    const current = withMarks.length ? withMarks[withMarks.length - 1] : -1;
    const subjects = new Map((await this.prisma.subject.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    const cur = rows.filter((r) => r.term === current);
    const bySubject = new Map<string, number[]>();
    for (const r of cur) bySubject.set(r.subjectId, [...(bySubject.get(r.subjectId) ?? []), r.pct]);
    const subjectRows = [...bySubject.entries()].map(([id, xs]) => ({ label: subjects.get(id) ?? 'Subject', value: Math.round(mean(xs)!) })).sort((a, b) => a.label.localeCompare(b.label));
    const termRows = withMarks.slice(-6).map((i) => ({ label: terms[i].label, value: Math.round(mean(rows.filter((r) => r.term === i).map((r) => r.pct))!) }));
    const objectives = await this.prisma.curriculumObjective.findMany({ select: { subjectId: true, coveragePct: true, masteryPct: true } });
    const objBy = new Map<string, { c: number[]; m: number[] }>();
    for (const o of objectives) {
      const g = objBy.get(o.subjectId) ?? { c: [], m: [] };
      g.c.push(o.coveragePct);
      g.m.push(o.masteryPct);
      objBy.set(o.subjectId, g);
    }
    const coverage = [...objBy.entries()].map(([id, g]) => ({ label: subjects.get(id) ?? 'Subject', coverage: Math.round(mean(g.c)!), mastery: Math.round(mean(g.m)!) })).sort((a, b) => a.label.localeCompare(b.label));
    const BANDS: [string, number][] = [['A*', 90], ['A', 80], ['B', 70], ['C', 60], ['D', 50], ['E', 0]];
    const distribution = BANDS.map(([label, min], i) => ({ label, value: cur.filter((r) => r.pct >= min && (i === 0 || r.pct < BANDS[i - 1][1])).length }));

    // Marks entered against marks expected for this academic year's assessments.
    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    const term = termOf(terms, today);
    const yearFrom = year ? year.startsOn : asDate(term?.start ?? addDays(today, -365));
    const sectionIds = [...new Set(students.map((s) => s.sectionId))];
    const sections = await this.prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, classId: true } });
    const classIds = [...new Set(sections.map((s) => s.classId))];
    const assessments = sectionIds.length
      ? await this.prisma.assessment.findMany({
          where: { heldOn: { gte: yearFrom, lte: asDate(today) }, OR: [{ sectionId: { in: sectionIds } }, { sectionId: null, classId: { in: classIds } }] },
          select: { id: true, sectionId: true, classId: true, _count: { select: { marks: true } } },
        })
      : [];
    const perSection = new Map<string, number>();
    for (const s of students) perSection.set(s.sectionId, (perSection.get(s.sectionId) ?? 0) + 1);
    const perClass = new Map<string, number>();
    for (const s of sections) perClass.set(s.classId, (perClass.get(s.classId) ?? 0) + (perSection.get(s.id) ?? 0));
    const expected = assessments.reduce((n, a) => n + (a.sectionId ? perSection.get(a.sectionId) ?? 0 : perClass.get(a.classId) ?? 0), 0);
    const entered = Math.min(expected, assessments.reduce((n, a) => n + a._count.marks, 0));
    return { subjects: subjectRows, terms: termRows, coverage, distribution, completion: { assessments: assessments.length, expected, entered, pct: pct(entered, expected) } };
  }

  private async admissions(campusId?: string) {
    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    const today = schoolToday();
    const since = year && dayKey(year.startsOn) <= today ? new Date(year.startsOn.getTime() - IST) : asDate(`${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`);
    const base: Prisma.AdmissionLeadWhereInput = campusId ? { campusId } : {};
    const leads = await this.prisma.admissionLead.findMany({ where: { ...base, createdAt: { gte: since } }, select: { source: true, stage: true, maxStageIndex: true } });
    const funnel = FUNNEL.map((label, i) => ({ label, value: leads.filter((l) => l.maxStageIndex >= i || l.stage === label).length }));
    const src = new Map<string, number>();
    for (const l of leads) src.set(l.source, (src.get(l.source) ?? 0) + 1);
    const sources = [...src.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    const enrolled = leads.filter((l) => l.stage === 'Enrolled').length;
    const months = lastMonths(6);
    const recent = await this.prisma.admissionLead.findMany({
      where: { ...base, OR: [{ createdAt: { gte: months[0].start } }, { enrolledAt: { gte: months[0].start } }] },
      select: { createdAt: true, enrolledAt: true },
    });
    const monthly = months.map((m) => ({
      label: m.label,
      enquiries: recent.filter((l) => l.createdAt >= m.start && l.createdAt < m.end).length,
      admissions: recent.filter((l) => l.enrolledAt && l.enrolledAt >= m.start && l.enrolledAt < m.end).length,
    }));
    return {
      funnel, sources, totals: { enquiries: leads.length, enrolled }, monthly,
      conversion: pct(enrolled, leads.length), lost: leads.filter((l) => l.stage === 'Lost').length,
    };
  }

  private async finance(campusId?: string) {
    const today = schoolToday();
    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    const yearFrom = year ? year.startsOn : asDate(`${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`);
    const base = campusId ? { campusId } : {};
    const months = lastMonths(6);
    const charges = await this.prisma.financeCharge.findMany({
      where: { ...base, OR: [{ dueDate: { gte: asDate(months[0].dStart) } }, { dueDate: { gte: yearFrom } }, { balance: { gt: 0 } }] },
      select: { amount: true, concession: true, paid: true, balance: true, dueDate: true },
    });
    const net = (c: (typeof charges)[number]) => Number(c.amount) - Number(c.concession);
    const trend = months
      .map((m) => {
        const cs = charges.filter((c) => dayKey(c.dueDate) >= m.dStart && dayKey(c.dueDate) <= m.dEnd);
        return { label: m.label, billed: Math.round(cs.reduce((n, c) => n + net(c), 0)), collected: Math.round(cs.reduce((n, c) => n + Number(c.paid), 0)) };
      })
      .filter((r, i, all) => r.billed || r.collected || all.slice(i).some((x) => x.billed || x.collected));
    const t = asDate(today).getTime();
    const age = [0, 0, 0, 0];
    for (const c of charges) {
      const bal = Number(c.balance);
      if (bal <= 0 || c.dueDate.getTime() >= t) continue;
      const days = Math.round((t - c.dueDate.getTime()) / 86_400_000);
      age[days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3] += bal;
    }
    const ageing = ['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'].map((label, i) => ({ label, value: Math.round(age[i]) }));
    const payments = await this.prisma.financePayment.groupBy({ by: ['method'], where: { ...base, status: 'Success', paidAt: { gte: new Date(yearFrom.getTime() - IST) } }, _sum: { amount: true } });
    const methods = payments.map((p) => ({ label: p.method, value: Math.round(Number(p._sum.amount ?? 0)) })).filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
    const ytd = charges.filter((c) => c.dueDate >= yearFrom && dayKey(c.dueDate) <= today);
    const billed = Math.round(ytd.reduce((n, c) => n + net(c), 0));
    const collected = Math.round(ytd.reduce((n, c) => n + Number(c.paid), 0));
    return { trend, ageing, methods, totals: { billed, collected }, collectionRate: billed ? round1((100 * collected) / billed) : 0 };
  }

  private async workforce(campusId?: string) {
    const base = { archivedAt: null, employmentStatus: { not: 'exited' }, ...(campusId ? { campusId } : {}) };
    const employees = await this.prisma.employee.findMany({ where: base, select: { id: true, category: true, department: true, employeeType: true } });
    const comp = new Map<string, number>();
    for (const e of employees) comp.set(e.category, (comp.get(e.category) ?? 0) + 1);
    const composition = [...comp.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    const today = schoolToday();
    const rows = employees.length
      ? await this.prisma.workforceAttendance.findMany({ where: { employeeId: { in: employees.map((e) => e.id) }, date: { gte: asDate(addDays(today, -30)), lte: asDate(today) } }, select: { employeeId: true, status: true } })
      : [];
    const dept = new Map(employees.map((e) => [e.id, e.department]));
    const by = new Map<string, { n: number; ok: number }>();
    for (const r of rows) {
      if (r.status === 'On Leave') continue;
      const d = dept.get(r.employeeId) ?? 'Other';
      const g = by.get(d) ?? { n: 0, ok: 0 };
      g.n++;
      if (r.status !== 'Absent') g.ok++;
      by.set(d, g);
    }
    const attendance = [...by.entries()].map(([label, g]) => ({ label, value: pct1(g.ok, g.n) })).sort((a, b) => a.label.localeCompare(b.label));
    const target: number = CPD_TARGET.teaching;
    const teaching = employees.filter((e) => e.employeeType === 'teaching').map((e) => e.id);
    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    const cpd = teaching.length
      ? await this.prisma.workforceCpdRecord.groupBy({
          by: ['employeeId'], where: { employeeId: { in: teaching }, status: 'Completed', ...(year ? { completedOn: { gte: year.startsOn } } : {}) }, _sum: { hours: true },
        })
      : [];
    const hours = teaching.map((id) => cpd.find((c) => c.employeeId === id)?._sum.hours ?? 0);
    return {
      composition, attendance,
      cpd: { staff: teaching.length, average: hours.length ? round1(mean(hours)!) : 0, target, metTarget: hours.filter((h) => h >= target).length },
    };
  }

  private async safety(campusId?: string) {
    const today = schoolToday();
    const base = campusId ? { campusId } : {};
    const gate = await this.prisma.safetyGateEvent.findMany({ where: { ...base, day: asDate(today), direction: 'in' }, select: { studentId: true, occurredAt: true }, orderBy: { occurredAt: 'asc' } });
    const firstIn = new Map<string, Date>();
    for (const g of gate) if (!firstIn.has(g.studentId)) firstIn.set(g.studentId, g.occurredAt);
    const times = [...firstIn.values()].map((d) => new Date(d.getTime() + IST).toISOString().slice(11, 16)).sort();
    const slots: string[] = [];
    for (let m = 7 * 60; m <= 9 * 60 + 30; m += 15) slots.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    const arrivals = slots.map((s) => ({ label: s, value: times.filter((t) => t <= s).length }));
    const incidents = await this.prisma.safetyIncident.groupBy({ by: ['incidentType'], where: { ...base, occurredOn: { gte: asDate(addDays(today, -90)) } }, _count: { _all: true } });
    const routes = await this.prisma.transportRoute.findMany({ where: { ...base, isActive: true }, select: { id: true, code: true, status: true }, orderBy: { code: 'asc' } });
    const profiles = new Map((await this.prisma.transportRouteProfile.findMany({ where: { routeId: { in: routes.map((r) => r.id) } } })).map((p) => [p.routeId, p]));
    const since = new Date(Date.now() - 30 * 86_400_000);
    const delivery = await this.prisma.outboundMessage.groupBy({ by: ['status'], where: { createdAt: { gte: since }, channel: { in: ['whatsapp', 'sms', 'email', 'push'] } }, _count: { _all: true } });
    const d = (s: string[]) => delivery.filter((x) => s.includes(x.status)).reduce((n, x) => n + x._count._all, 0);
    return {
      arrivals,
      incidents: incidents.map((i) => ({ label: i.incidentType, value: i._count._all })).sort((a, b) => b.value - a.value),
      routes: routes.map((r) => {
        const p = profiles.get(r.id);
        const live = p?.runDate && dayKey(p.runDate) === today;
        return { label: r.code, delay: live ? p!.delayMinutes : 0, status: live ? r.status : 'scheduled' };
      }),
      delivery: { total: delivery.reduce((n, x) => n + x._count._all, 0), delivered: d(['sent', 'delivered']), pending: d(['queued']), failed: d(['failed']) },
    };
  }
}
