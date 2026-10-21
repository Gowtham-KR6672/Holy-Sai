import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { EarlyWarningSignal, EarlyWarningStudent, Prisma } from '@prisma/client';
import { CountersService } from '../../common/counters.service';
import { PrismaService } from '../../common/prisma.service';
import { AcademicsExtensions, type AttendanceCheckInput } from '../academics/academics.extensions';
import { SettingsService } from '../settings/settings.service';
import {
  addDays, asDate, coreRisk, DAY_MS, dayKey, loadTerms, maxRisk, mean, money, RISK_LEVELS, round1, schoolToday, shortDate, STAGES, termOf,
} from './intel.util';
import { IntelPeople } from './people.service';
import { isConcern, isConcernMood, isPositive, StudentExtrasService } from './student-extras.service';
import { ForEachWorkspace } from '../../tenancy/for-each-workspace.decorator';

export interface Thresholds {
  attendance: number;
  scoreDrop: number;
}

export interface Actor {
  id: string | null;
  name: string;
}

interface Candidate {
  studentId: string;
  campusId: string;
  sectionId: string | null;
  signalType: string;
  rule: string;
  signal: string;
  evidence: Record<string, unknown>;
}

export type StudentState = Omit<EarlyWarningStudent, 'feesOverdue'> & { feesOverdue: number };

/** Signals that still need something: waiting for review, or an intervention not yet closed. */
export const OPEN_SIGNAL: Prisma.EarlyWarningSignalWhereInput = { closedAt: null, OR: [{ decision: null }, { decision: 'accepted' }] };

const FRESH_MS = 60 * 60_000;
const COOL_DOWN_DAYS = 30;
const SYSTEM: Actor = { id: null, name: 'System' };

/** Early Warning: indicators per student, deterministic rules, signals and the review workflow's notifications. */
@Injectable()
export class EarlyWarningService implements OnModuleInit {
  private readonly log = new Logger(EarlyWarningService.name);
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly counters: CountersService,
    private readonly people: IntelPeople,
    private readonly extras: StudentExtrasService,
  ) {}

  onModuleInit() {
    // Teacher Dashboard "Students to watch" and the check after each attendance register.
    AcademicsExtensions.registerWatchlist((ids, limit) => this.watchlist(ids, limit));
    AcademicsExtensions.registerAttendanceCheck((input) => this.afterAttendance(input));
  }

  async thresholds(): Promise<Thresholds> {
    const [attendance, scoreDrop] = await Promise.all([
      this.settings.get<number>('early_warning.attendance_threshold', 82),
      this.settings.get<number>('early_warning.score_drop_threshold', 5),
    ]);
    return { attendance: Number(attendance) || 82, scoreDrop: Number(scoreDrop) || 5 };
  }

  async feeOverdueDays(): Promise<number> {
    return Number(await this.settings.get<number>('early_warning.fee_overdue_days', 60)) || 60;
  }

  async rules() {
    const t = await this.thresholds();
    const feeDays = await this.feeOverdueDays();
    return [
      { id: 'A', type: 'attendance', description: `Attendance this academic year below ${t.attendance}% (at least 10 marked days)` },
      { id: 'B', type: 'academic', description: `Latest-term average at least ${t.scoreDrop} points below the previous term (two or more results in each term)` },
      { id: 'C', type: 'participation', description: 'Homework handed in for fewer than half of the tasks due in the last 30 days (at least 4 due)' },
      { id: 'D', type: 'behaviour', description: 'Three or more behaviour concern notes in the last 60 days' },
      { id: 'F', type: 'wellbeing', description: 'Two or more wellbeing check-ins flagged in the last 30 days' },
      { id: 'E', type: 'fees', description: `Fees overdue for more than ${feeDays} days — a prompt to check whether the family needs support` },
      { id: 'P', type: 'attendance', description: 'Absent on three consecutive marked days (checked when a register is saved)' },
    ];
  }

  /** Start of the current term (YYYY-MM-DD). */
  async termStart(): Promise<string> {
    const terms = await loadTerms(this.prisma);
    return termOf(terms, schoolToday())?.start ?? addDays(schoolToday(), -120);
  }

  // ---------------------------------------------------------------------------
  // Indicators
  // ---------------------------------------------------------------------------

  /** Recomputes indicators and the risk band for these students and stores them. */
  async computeStates(studentIds: string[]): Promise<void> {
    const ids = [...new Set(studentIds)];
    if (!ids.length) return;
    const students = await this.prisma.student.findMany({ where: { id: { in: ids } }, select: { id: true, campusId: true, sectionId: true, risk: true } });
    if (!students.length) return;
    const sids = students.map((s) => s.id);
    const today = schoolToday();
    const th = await this.thresholds();
    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    const yearFrom = year ? year.startsOn : asDate(addDays(today, -365));
    const d30 = asDate(addDays(today, -30));
    const d60 = addDays(today, -60);

    // Attendance: this academic year, and the last 30 days.
    const [attYear, att30] = await Promise.all([
      this.prisma.studentAttendance.groupBy({ by: ['studentId', 'status'], where: { studentId: { in: sids }, date: { gte: yearFrom, lte: asDate(today) } }, _count: { _all: true } }),
      this.prisma.studentAttendance.groupBy({ by: ['studentId', 'status'], where: { studentId: { in: sids }, date: { gte: d30, lte: asDate(today) } }, _count: { _all: true } }),
    ]);

    // Results: latest term with marks against the previous term.
    const terms = await loadTerms(this.prisma);
    let current = termOf(terms, today);
    if (current) {
      const any = await this.prisma.assessmentMark.count({
        where: { isAbsent: false, marks: { not: null }, assessment: { heldOn: { gte: asDate(current.start), lte: asDate(today) } } },
      });
      const idx = terms.indexOf(current);
      if (!any && idx > 0) current = terms[idx - 1];
    }
    const previous = current && terms.indexOf(current) > 0 ? terms[terms.indexOf(current) - 1] : null;
    const marks = current
      ? await this.prisma.assessmentMark.findMany({
          where: {
            studentId: { in: sids }, isAbsent: false, marks: { not: null },
            assessment: { heldOn: { gte: asDate((previous ?? current).start), lte: asDate(current.end < today ? current.end : today) } },
          },
          select: { studentId: true, marks: true, assessment: { select: { maxMarks: true, heldOn: true } } },
        })
      : [];

    // Homework due in the last 30 days, in each student's class.
    const sectionIds = [...new Set(students.map((s) => s.sectionId))];
    const homework = await this.prisma.homework.findMany({
      where: { sectionId: { in: sectionIds }, status: { not: 'Draft' }, dueOn: { gte: d30, lt: asDate(today) } },
      select: { id: true, sectionId: true },
    });
    const submissions = homework.length
      ? await this.prisma.homeworkSubmission.groupBy({ by: ['studentId'], where: { homeworkId: { in: homework.map((h) => h.id) }, studentId: { in: sids } }, _count: { _all: true } })
      : [];

    // Fees overdue.
    const charges = await this.prisma.financeCharge.findMany({
      where: { studentId: { in: sids }, balance: { gt: 0 }, dueDate: { lt: asDate(today) } },
      select: { studentId: true, balance: true, dueDate: true },
    });

    // Student 360 records (when the students module has them).
    const [behaviour, wellbeing, activities] = await Promise.all([this.extras.behaviour(sids), this.extras.wellbeing(sids), this.extras.activities(sids)]);

    // Reviewer-set bands on open interventions are never lowered automatically.
    const overrides = await this.prisma.earlyWarningSignal.findMany({
      where: { studentId: { in: sids }, decision: 'accepted', closedAt: null, riskLevel: { not: null } },
      select: { studentId: true, riskLevel: true },
    });

    const group = <T extends { studentId: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) {
        const list = m.get(r.studentId);
        if (list) list.push(r);
        else m.set(r.studentId, [r]);
      }
      return (id: string) => m.get(id) ?? [];
    };
    const attYearOf = group(attYear);
    const att30Of = group(att30);
    const marksOf = group(marks);
    const behaviourOf = group(behaviour);
    const wellbeingOf = group(wellbeing);
    const activitiesOf = group(activities);
    const chargesOf = group(charges);
    const overridesOf = group(overrides);
    const handedIn = new Map(submissions.map((x) => [x.studentId, x._count._all]));
    const dueBySection = new Map<string, number>();
    for (const h of homework) dueBySection.set(h.sectionId, (dueBySection.get(h.sectionId) ?? 0) + 1);

    const states: StudentState[] = [];
    for (const s of students) {
      const mine = attYearOf(s.id);
      const marked = mine.reduce((n, r) => n + r._count._all, 0);
      const attended = mine.filter((r) => r.status === 'present' || r.status === 'late').reduce((n, r) => n + r._count._all, 0);
      const attendancePct = marked ? round1((100 * attended) / marked) : null;
      const r30 = att30Of(s.id);
      const absent30 = r30.find((r) => r.status === 'absent')?._count._all ?? 0;
      const late30 = r30.find((r) => r.status === 'late')?._count._all ?? 0;

      const pcts = marksOf(s.id).filter((m) => m.assessment.maxMarks > 0);
      const cur = current ? pcts.filter((m) => dayKey(m.assessment.heldOn) >= current!.start).map((m) => (100 * (m.marks ?? 0)) / m.assessment.maxMarks) : [];
      const prev = previous ? pcts.filter((m) => dayKey(m.assessment.heldOn) < current!.start).map((m) => (100 * (m.marks ?? 0)) / m.assessment.maxMarks) : [];
      const average = cur.length ? round1(mean(cur)!) : null;
      const previousAverage = prev.length ? round1(mean(prev)!) : null;
      const trend = cur.length >= 2 && prev.length >= 2 && average != null && previousAverage != null ? round1(average - previousAverage) : null;

      const due = dueBySection.get(s.sectionId) ?? 0;
      const handed = handedIn.get(s.id) ?? 0;
      const homeworkRate = due ? round1((100 * Math.min(due, handed)) / due) : null;

      const notes = behaviourOf(s.id).filter((b) => (b.date ?? '') >= d60);
      const concerns60 = notes.filter((b) => isConcern(b.type)).length;
      const positives60 = notes.filter((b) => isPositive(b.type)).length;
      const wellbeingFlags30 = wellbeingOf(s.id).filter((w) => (w.date ?? '') >= dayKey(d30) && isConcernMood(w.mood)).length;
      const activityCount = activitiesOf(s.id).filter((a) => a.status === 'Active').length;

      const owed = chargesOf(s.id);
      const feesOverdue = owed.reduce((n, c) => n + Number(c.balance), 0);
      const oldest = owed.reduce<Date | null>((d, c) => (!d || c.dueDate < d ? c.dueDate : d), null);
      const feesOverdueDays = oldest ? Math.max(0, Math.round((asDate(today).getTime() - oldest.getTime()) / DAY_MS)) : 0;

      const indicators: string[] = [];
      if (attendancePct != null && marked >= 10 && attendancePct < th.attendance) indicators.push('attendance');
      if (trend != null && trend <= -th.scoreDrop) indicators.push('academic');
      if ((homeworkRate != null && due >= 4 && homeworkRate < 50) || concerns60 >= 3 || wellbeingFlags30 >= 2) indicators.push('participation');

      let band: string = indicators.length >= 2 ? 'At Risk' : indicators.length === 1 ? 'Developing Risk' : 'On Track';
      if (band === 'On Track') {
        const near =
          (attendancePct != null && marked >= 10 && attendancePct < th.attendance + 5) ||
          (trend != null && trend <= -th.scoreDrop / 2) ||
          (homeworkRate != null && due >= 4 && homeworkRate < 65) ||
          (concerns60 >= 1 && concerns60 > positives60) ||
          wellbeingFlags30 === 1;
        if (near) band = 'Watch';
      }
      for (const o of overridesOf(s.id)) if (o.riskLevel) band = maxRisk(band, o.riskLevel);

      states.push({
        studentId: s.id, campusId: s.campusId, sectionId: s.sectionId, attendancePct, markedDays: marked, absent30, late30, average, previousAverage, trend,
        termLabel: current?.label ?? null, homeworkRate, homeworkDue: due, concerns60, positives60, wellbeingFlags30, activities: activityCount,
        feesOverdue: Math.round(feesOverdue * 100) / 100, feesOverdueDays, indicators, band, computedAt: new Date(),
      });
    }

    // Write only what changed; unchanged rows just get a fresh timestamp.
    const before = new Map((await this.prisma.earlyWarningStudent.findMany({ where: { studentId: { in: sids } } })).map((r) => [r.studentId, r]));
    const sig = (x: Omit<StudentState, 'computedAt'> | (EarlyWarningStudent & { feesOverdue: unknown })) =>
      JSON.stringify([x.campusId, x.sectionId, x.attendancePct, x.markedDays, x.absent30, x.late30, x.average, x.previousAverage, x.trend, x.termLabel, x.homeworkRate,
        x.homeworkDue, x.concerns60, x.positives60, x.wellbeingFlags30, x.activities, Number(x.feesOverdue), x.feesOverdueDays, x.indicators, x.band]);
    const changed = states.filter((st) => !before.has(st.studentId) || sig(before.get(st.studentId)!) !== sig(st));
    const same = states.filter((st) => !changed.includes(st)).map((st) => st.studentId);
    if (same.length) await this.prisma.earlyWarningStudent.updateMany({ where: { studentId: { in: same } }, data: { computedAt: new Date() } });
    for (let i = 0; i < changed.length; i += 200) {
      await this.prisma.$transaction(
        changed.slice(i, i + 200).map(({ studentId, ...data }) =>
          this.prisma.earlyWarningStudent.upsert({ where: { studentId }, create: { studentId, ...data }, update: data }),
        ),
      );
    }
    // Keep the core risk column (On Track | Developing Risk | At Risk) in step.
    const byRisk = new Map<string, string[]>();
    for (const st of states) {
      const was = students.find((s) => s.id === st.studentId)?.risk;
      const now = coreRisk(st.band);
      if (was !== now) byRisk.set(now, [...(byRisk.get(now) ?? []), st.studentId]);
    }
    for (const [risk, list] of byRisk) await this.prisma.student.updateMany({ where: { id: { in: list } }, data: { risk } });
  }

  /** Stored indicators for these students, recomputing any older than an hour. */
  async states(studentIds: string[]): Promise<Map<string, StudentState>> {
    const ids = [...new Set(studentIds)];
    if (!ids.length) return new Map();
    const load = async () =>
      new Map((await this.prisma.earlyWarningStudent.findMany({ where: { studentId: { in: ids } } })).map((s) => [s.studentId, { ...s, feesOverdue: Number(s.feesOverdue) }]));
    let rows = await load();
    const cutoff = Date.now() - FRESH_MS;
    const stale = ids.filter((id) => !rows.has(id) || rows.get(id)!.computedAt.getTime() < cutoff);
    if (stale.length) {
      const key = stale.length > 50 ? `${stale.length}:${stale[0]}:${stale[stale.length - 1]}` : stale.join(',');
      let job = this.inflight.get(key);
      if (!job) {
        job = this.computeStates(stale).finally(() => this.inflight.delete(key));
        this.inflight.set(key, job);
      }
      try {
        await job;
      } catch (err) {
        this.log.error(`Early Warning indicators failed: ${(err as Error).message}`);
      }
      rows = await load();
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Rules and signals
  // ---------------------------------------------------------------------------

  private async candidates(states: StudentState[]): Promise<Candidate[]> {
    const th = await this.thresholds();
    const feeDays = await this.feeOverdueDays();
    const out: Candidate[] = [];
    for (const s of states) {
      const base = { studentId: s.studentId, campusId: s.campusId, sectionId: s.sectionId };
      if (s.indicators.includes('attendance') && s.attendancePct != null) {
        const attended = Math.round((s.attendancePct * s.markedDays) / 100);
        out.push({ ...base, signalType: 'attendance', rule: 'A', signal: `Attendance ${s.attendancePct}% this academic year — below the ${th.attendance}% threshold (${attended} of ${s.markedDays} days)`, evidence: { attendancePct: s.attendancePct, markedDays: s.markedDays, threshold: th.attendance, absent30: s.absent30 } });
      }
      if (s.indicators.includes('academic') && s.trend != null) {
        out.push({ ...base, signalType: 'academic', rule: 'B', signal: `Latest-term average ${s.average} — ${Math.abs(s.trend)} points below the previous term (${s.previousAverage})`, evidence: { average: s.average, previousAverage: s.previousAverage, trend: s.trend, term: s.termLabel, threshold: th.scoreDrop } });
      }
      if (s.homeworkRate != null && s.homeworkDue >= 4 && s.homeworkRate < 50) {
        out.push({ ...base, signalType: 'participation', rule: 'C', signal: `Homework handed in for ${Math.round(s.homeworkRate)}% of ${s.homeworkDue} tasks due in the last 30 days`, evidence: { homeworkRate: s.homeworkRate, homeworkDue: s.homeworkDue } });
      }
      if (s.concerns60 >= 3) {
        out.push({ ...base, signalType: 'behaviour', rule: 'D', signal: `${s.concerns60} behaviour concern notes in the last 60 days (${s.positives60} positive)`, evidence: { concerns60: s.concerns60, positives60: s.positives60 } });
      }
      if (s.wellbeingFlags30 >= 2) {
        out.push({ ...base, signalType: 'wellbeing', rule: 'F', signal: `${s.wellbeingFlags30} wellbeing check-ins flagged in the last 30 days — a conversation with the counsellor may help`, evidence: { wellbeingFlags30: s.wellbeingFlags30 } });
      }
      if (s.feesOverdue > 0 && s.feesOverdueDays > feeDays) {
        out.push({ ...base, signalType: 'fees', rule: 'E', signal: `Fees of ${money(s.feesOverdue)} overdue for ${s.feesOverdueDays} days — check whether the family needs support`, evidence: { feesOverdue: s.feesOverdue, days: s.feesOverdueDays, threshold: feeDays } });
      }
    }
    return out;
  }

  /** Creates the signals that are not already open or recently reviewed; tells class teachers. */
  async raise(cands: Candidate[], actor: Actor): Promise<{ created: (EarlyWarningSignal & { studentName: string; admissionNo: string })[]; skipped: number }> {
    if (!cands.length) return { created: [], skipped: 0 };
    const since = new Date(Date.now() - COOL_DOWN_DAYS * DAY_MS);
    const ids = [...new Set(cands.map((c) => c.studentId))];
    const blocking = await this.prisma.earlyWarningSignal.findMany({
      where: { studentId: { in: ids }, OR: [OPEN_SIGNAL, { decision: 'dismissed', reviewedAt: { gte: since } }, { closedAt: { gte: since } }] },
      select: { studentId: true, signalType: true },
    });
    const blocked = new Set(blocking.map((b) => `${b.studentId}|${b.signalType}`));
    const students = new Map((await this.prisma.student.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, admissionNo: true } })).map((s) => [s.id, s]));
    const created: (EarlyWarningSignal & { studentName: string; admissionNo: string })[] = [];
    let skipped = 0;
    const today = schoolToday();
    for (const c of cands) {
      const key = `${c.studentId}|${c.signalType}`;
      if (blocked.has(key)) {
        skipped++;
        continue;
      }
      blocked.add(key);
      const code = await this.counters.reference('EW', 'early-warning-signals', 0, 101);
      const row = await this.prisma.earlyWarningSignal.create({
        data: {
          code, studentId: c.studentId, campusId: c.campusId, sectionId: c.sectionId, signalType: c.signalType, rule: c.rule, signal: c.signal,
          evidence: c.evidence as Prisma.InputJsonValue, raisedOn: asDate(today), raisedById: actor.id, raisedByName: actor.name,
          events: { create: { studentId: c.studentId, action: 'raise', description: `Raised by rule ${c.rule}: ${c.signal}`, byId: actor.id, byName: actor.name } },
        },
      });
      const st = students.get(c.studentId);
      created.push({ ...row, studentName: st?.fullName ?? '', admissionNo: st?.admissionNo ?? '' });
    }
    if (created.length) await this.tellReviewers(created);
    return { created, skipped };
  }

  /** Class teachers review new signals (a task each); without a class teacher account, school-level reviewers are told. */
  private async tellReviewers(signals: (EarlyWarningSignal & { studentName: string })[]) {
    const teachers = await this.people.classTeacherUsers(signals.map((s) => s.sectionId));
    const byUser = new Map<string, typeof signals>();
    const unowned = new Map<string, typeof signals>();
    for (const s of signals) {
      const u = s.sectionId ? teachers.get(s.sectionId) : undefined;
      if (u) byUser.set(u, [...(byUser.get(u) ?? []), s]);
      else unowned.set(s.campusId, [...(unowned.get(s.campusId) ?? []), s]);
    }
    const due = addDays(schoolToday(), 7);
    const send = async (userIds: string[], list: typeof signals, campusId: string | null) => {
      if (!userIds.length) return;
      await this.people.notify(userIds, {
        category: 'Attention', topic: 'system', module: 'earlywarning', icon: 'alert', campusId,
        title: list.length === 1 ? `Early Warning ${list[0].code}: ${list[0].studentName}` : `${list.length} Early Warning signals to review`,
        body: list.length === 1 ? `${list[0].signal}. Accept or dismiss it after review.` : list.slice(0, 6).map((s) => `${s.code} ${s.studentName}`).join(', '),
        route: '/early-warning',
      });
      for (const s of list) {
        await this.people.tasks(userIds, {
          title: `Review ${s.code}: ${s.studentName} (${s.signalType})`, module: 'earlywarning', status: 'Under Review', priority: s.signalType === 'attendance' ? 'High' : 'Medium',
          dueOn: due, route: '/early-warning', entityType: 'ew_signal', entityId: s.id,
        });
      }
    };
    for (const [userId, list] of byUser) await send([userId], list, list[0].campusId);
    for (const [campusId, list] of unowned) {
      const reviewers = await this.prisma.user.findMany({
        where: { status: 'active', role: { scope: 'school', permissions: { some: { permissionKey: 'earlywarning.manage' } } }, OR: [{ campusId }, { campusId: null }] },
        select: { id: true },
      });
      await send(reviewers.map((r) => r.id), list, campusId);
    }
  }

  /** Runs every rule over these students. */
  async check(studentIds: string[], actor: Actor) {
    await this.computeStates(studentIds);
    const states = await this.states(studentIds);
    const cands = await this.candidates([...states.values()]);
    const { created, skipped } = await this.raise(cands, actor);
    return { checked: states.size, matched: cands.length, skipped, created };
  }

  /** Daily check across every active student (06:30 school time). */
  @Cron('30 6 * * *', { timeZone: 'Asia/Kolkata', name: 'early-warning-daily' })
  @ForEachWorkspace('early-warning-daily')
  async daily() {
    try {
      const ids = (await this.prisma.student.findMany({ where: { status: 'active' }, select: { id: true } })).map((s) => s.id);
      const r = await this.check(ids, SYSTEM);
      this.log.log(`Daily Early Warning check: ${r.checked} students, ${r.created.length} new signals, ${r.skipped} skipped`);
      await this.overdueReminders();
    } catch (err) {
      this.log.error(`Daily Early Warning check failed: ${(err as Error).message}`);
    }
  }

  /** Owners of interventions past their review date get a reminder (once a day). */
  private async overdueReminders() {
    const overdue = await this.prisma.earlyWarningSignal.findMany({
      where: { decision: 'accepted', closedAt: null, nextReviewOn: { lt: asDate(schoolToday()) }, ownerId: { not: null } },
      select: { code: true, ownerId: true, campusId: true, nextReviewOn: true, studentId: true },
    });
    if (!overdue.length) return;
    const users = await this.people.usersOfEmployees(overdue.map((o) => o.ownerId));
    const byUser = new Map<string, typeof overdue>();
    for (const o of overdue) {
      const u = users.get(o.ownerId!);
      if (u) byUser.set(u, [...(byUser.get(u) ?? []), o]);
    }
    for (const [u, list] of byUser) {
      await this.people.notify([u], {
        category: 'Attention', topic: 'system', module: 'earlywarning', icon: 'clock', campusId: list[0].campusId,
        title: list.length === 1 ? `Intervention review overdue: ${list[0].code}` : `${list.length} intervention reviews overdue`,
        body: list.map((o) => `${o.code} (due ${shortDate(dayKey(o.nextReviewOn!))})`).join(', '), route: '/early-warning',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Academics hooks
  // ---------------------------------------------------------------------------

  /** After a register is saved: refresh the class's indicators and check the students marked absent or late. */
  async afterAttendance(input: AttendanceCheckInput): Promise<{ code: string; reason: string }[]> {
    const ids = (await this.prisma.student.findMany({ where: { sectionId: input.sectionId, status: 'active' }, select: { id: true } })).map((s) => s.id);
    if (!ids.length) return [];
    await this.computeStates(ids);
    const flagged = [...new Set([...input.absentStudentIds, ...input.lateStudentIds])];
    if (!flagged.length) return [];
    const states = await this.states(flagged);
    const cands = (await this.candidates([...states.values()])).filter((c) => c.signalType === 'attendance');

    // Pattern: absent on each of the last three marked days.
    for (const id of input.absentStudentIds) {
      if (cands.some((c) => c.studentId === id)) continue;
      const last = await this.prisma.studentAttendance.findMany({ where: { studentId: id, date: { lte: asDate(input.date) } }, orderBy: { date: 'desc' }, take: 3, select: { date: true, status: true } });
      if (last.length === 3 && last.every((r) => r.status === 'absent')) {
        const st = states.get(id);
        const from = shortDate(dayKey(last[2].date));
        const to = shortDate(dayKey(last[0].date));
        cands.push({
          studentId: id, campusId: input.campusId, sectionId: input.sectionId, signalType: 'attendance', rule: 'P',
          signal: `3 consecutive absences (${from} – ${to})${st?.attendancePct != null ? ` · attendance ${st.attendancePct}% this year` : ''}`,
          evidence: { consecutiveAbsences: 3, from: dayKey(last[2].date), to: dayKey(last[0].date) },
        });
      }
    }
    const { created } = await this.raise(cands, { id: null, name: 'System (attendance register)' });
    return created.map((s) => ({ code: s.code, reason: s.rule === 'P' ? s.signal.split(' · ')[0] : `attendance ${(s.evidence as { attendancePct?: number }).attendancePct ?? ''}% below threshold` }));
  }

  /** Open signals for the Teacher Dashboard watchlist. */
  async watchlist(studentIds: string[], limit: number) {
    const where: Prisma.EarlyWarningSignalWhereInput = { studentId: { in: studentIds }, ...OPEN_SIGNAL };
    const [rows, total] = await Promise.all([
      this.prisma.earlyWarningSignal.findMany({ where, orderBy: [{ stage: 'asc' }, { raisedOn: 'desc' }], take: limit }),
      this.prisma.earlyWarningSignal.count({ where }),
    ]);
    const students = await this.prisma.student.findMany({
      where: { id: { in: rows.map((r) => r.studentId) } },
      select: { id: true, fullName: true, admissionNo: true, section: { select: { name: true, class: { select: { name: true } } } } },
    });
    const by = new Map(students.map((s) => [s.id, s]));
    return {
      rows: rows.map((r) => {
        const s = by.get(r.studentId);
        return {
          id: r.id, code: r.code, signal: r.signal, signalType: r.signalType, stage: r.stage, studentId: r.studentId,
          name: s?.fullName ?? '', admissionNo: s?.admissionNo ?? '', sectionLabel: s ? `${s.section.class.name}${s.section.name}` : '',
        };
      }),
      total,
    };
  }

  // ---------------------------------------------------------------------------
  // Shapes
  // ---------------------------------------------------------------------------

  /** Signal rows as the Early Warning page lists them. */
  async signalRows(signals: EarlyWarningSignal[]) {
    const studentIds = [...new Set(signals.map((s) => s.studentId))];
    const [students, owners, states] = await Promise.all([
      this.prisma.student.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, fullName: true, admissionNo: true, risk: true, section: { select: { name: true, class: { select: { name: true } } } } },
      }),
      this.people.employeeNames(signals.map((s) => s.ownerId)),
      this.prisma.earlyWarningStudent.findMany({ where: { studentId: { in: studentIds } }, select: { studentId: true, band: true } }),
    ]);
    const st = new Map(students.map((s) => [s.id, s]));
    const band = new Map(states.map((s) => [s.studentId, s.band]));
    return signals.map((r) => {
      const s = st.get(r.studentId);
      return {
        id: r.id, code: r.code, signal: r.signal, signalType: r.signalType, stage: r.stage, stageLabel: STAGES[r.stage] ?? '',
        raisedOn: dayKey(r.raisedOn), decision: (r.decision as 'accepted' | 'dismissed' | null) ?? null, actionPlan: r.actionPlan,
        nextReviewOn: r.nextReviewOn ? dayKey(r.nextReviewOn) : null, reviewedAt: r.reviewedAt?.toISOString() ?? null, closedAt: r.closedAt?.toISOString() ?? null,
        ownerId: r.ownerId, owner: r.ownerId ? owners.get(r.ownerId) ?? null : null, reviewedBy: r.reviewedByName,
        studentId: r.studentId, studentName: s?.fullName ?? '', admissionNo: s?.admissionNo ?? '', grade: s?.section.class.name ?? null, section: s?.section.name ?? null,
        risk: band.get(r.studentId) ?? s?.risk ?? 'On Track', rule: r.rule, riskLevel: r.riskLevel, outcome: r.outcome, dismissReason: r.dismissReason,
      };
    });
  }

  /** Sets a student's band now (reviewer decision), keeping the core column in step. */
  async setBand(studentId: string, band: string) {
    if (!RISK_LEVELS.includes(band as (typeof RISK_LEVELS)[number])) return;
    await this.prisma.earlyWarningStudent.updateMany({ where: { studentId }, data: { band } });
    await this.prisma.student.update({ where: { id: studentId }, data: { risk: coreRisk(band) } });
  }
}
