import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { can, type AuthUser } from '../../common/auth-user';
import { forbidden, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { loadTerms } from '../academics/academics.util';
import { AuditService } from '../audit/audit.service';
import { FinanceLedgerService } from '../finance/ledger.service';
import { ParentsService } from '../parents/parents.service';
import { TransportService } from '../transport/transport.service';
import { StudentRecordsService } from './records.service';
import { StudentsExtensions, type ProfileTimelineItem } from './students.extensions';
import {
  addDays, asDate, assertId, dayKey, dayKeyOrNull, FAMILY_BEHAVIOUR_TYPES, gradeFor, INNOVATION_STAGES, iso, mean, monthLabel, round1,
  schoolToday, SENSITIVE, STATUS_LABEL,
} from './students.util';

const TRACKING_READ = ['tracking.read_all', 'tracking.read_assigned'];

/**
 * The Student 360 profile — one shape for staff (Student 360), parents (Parent 360) and the student (My profile).
 * What is included depends on who is looking:
 *  - staff (school / class scope): everything in scope; wellbeing detail, counsellor and medical notes only with
 *    students.sensitive; fees with finance.read; location with tracking.read_*; interventions with earlywarning.read;
 *  - parents (family) and the student (self): their own record, released results only, positive notes and notes
 *    (not concerns), no staff observations, no confidential wellbeing records; fees for parents (fees.pay_own).
 * Every read is audited as sensitive.
 */
@Injectable()
export class StudentProfileService {
  private readonly log = new Logger('Students');

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly ledger: FinanceLedgerService,
    private readonly transport: TransportService,
    private readonly parents: ParentsService,
    private readonly records: StudentRecordsService,
  ) {}

  async profile(user: AuthUser, id: string, req?: Request) {
    assertId(id);
    const s = await this.prisma.student.findUnique({
      where: { id },
      include: {
        section: { include: { class: true, classTeacher: { select: { fullName: true } } } },
        campus: { select: { name: true, shortName: true } },
        guardians: { include: { guardian: true } },
      },
    });
    if (!s) throw notFound('Student');
    await this.scope.assertStudent(user, id);

    const family = user.scope === 'family' || user.scope === 'self';
    const staff = !family;
    if (staff && !can(user, 'students.read', 'students.read_assigned')) throw forbidden('This student is outside your access');
    const sensitive = staff && can(user, SENSITIVE);
    const active = s.status === 'active';
    const today = schoolToday();

    const year = await this.prisma.academicYear.findFirst({ where: { isCurrent: true } });
    const yearFrom = year ? dayKey(year.startsOn) : addDays(today, -365);
    const yearTo = year && dayKey(year.endsOn) < today ? dayKey(year.endsOn) : today;

    const [
      attendance, marks, timetable, behaviour, observations, checkins, lastCheckin, infirmaryVisits, counselling, achievements, documents,
      projects, bus, fees, trackingState, statusChanges, reportCards, account, profiles, extras,
    ] = await Promise.all([
      this.prisma.studentAttendance.findMany({
        where: { studentId: id, date: { gte: asDate(yearFrom), lte: asDate(yearTo) } },
        orderBy: { date: 'desc' },
        select: { date: true, status: true, arrivalTime: true },
      }),
      this.prisma.assessmentMark.findMany({
        where: { studentId: id, ...(family ? { assessment: { status: 'Completed' } } : {}) },
        include: { assessment: { select: { code: true, name: true, heldOn: true, maxMarks: true, subjectId: true, status: true } } },
      }),
      this.prisma.timetableEntry.findMany({ where: { sectionId: s.sectionId, subjectId: { not: null }, employeeId: { not: null } }, select: { subjectId: true, employeeId: true } }),
      this.prisma.studentBehaviourNote.findMany({
        where: { studentId: id, ...(family ? { recordType: { in: FAMILY_BEHAVIOUR_TYPES } } : {}) },
        orderBy: [{ recordedOn: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      }),
      staff ? this.prisma.studentObservation.findMany({ where: { studentId: id }, orderBy: [{ observedOn: 'desc' }, { createdAt: 'desc' }], take: 100 }) : Promise.resolve(null),
      sensitive ? this.prisma.studentWellbeingCheckin.findMany({ where: { studentId: id }, orderBy: [{ checkedOn: 'desc' }, { createdAt: 'desc' }], take: 50 }) : Promise.resolve(null),
      sensitive
        ? Promise.resolve(null)
        : this.prisma.studentWellbeingCheckin.findFirst({
          where: { studentId: id, isConfidential: false },
          orderBy: [{ checkedOn: 'desc' }, { createdAt: 'desc' }],
          select: { checkedOn: true, mood: true },
        }),
      sensitive ? this.prisma.safetyInfirmaryVisit.count({ where: { studentId: id } }) : Promise.resolve(0),
      sensitive
        ? this.prisma.safetyCounsellingSession.findMany({ where: { studentId: id, status: { not: 'Cancelled' } }, orderBy: { sessionOn: 'desc' }, select: { counsellorId: true } })
        : Promise.resolve([] as { counsellorId: string }[]),
      this.prisma.innovationAchievement.findMany({ where: { studentId: id }, orderBy: [{ achievedOn: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.opsDocument.findMany({ where: { studentId: id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.innovationProject.findMany({
        where: { OR: [{ studentId: id }, { members: { some: { studentId: id } } }] },
        include: { milestones: { select: { completedOn: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
      active ? this.transport.studentBus(id).catch((e: Error) => { this.log.warn(`Bus for ${id}: ${e.message}`); return null; }) : Promise.resolve(null),
      can(user, 'finance.read', 'fees.pay_own') ? this.ledger.accountSummaries([id]).catch(() => null) : Promise.resolve(null),
      staff && can(user, ...TRACKING_READ) ? this.prisma.trackingStudentState.findUnique({ where: { studentId: id } }) : Promise.resolve(null),
      this.prisma.studentStatusChange.findMany({ where: { studentId: id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.reportCardComment.findMany({
        where: { studentId: id, status: 'Approved', batch: { stage: 5 } },
        include: { batch: { select: { term: true, releasedAt: true, updatedAt: true } } },
      }),
      this.prisma.user.findFirst({ where: { studentId: id }, select: { email: true, phone: true } }),
      this.prisma.parentProfile.findMany({ where: { guardianId: { in: s.guardians.map((g) => g.guardianId) } } }),
      StudentsExtensions.profile(id, user),
    ]);

    // ---- names --------------------------------------------------------------------------------------------
    const subjectIds = [...new Set(marks.map((m) => m.assessment.subjectId))];
    const employeeIds = [...new Set([
      ...timetable.map((t) => t.employeeId!),
      ...projects.map((p) => p.mentorId).filter((x): x is string => !!x),
      ...(counselling[0] ? [counselling[0].counsellorId] : []),
    ])];
    const [subjects, employees, terms] = await Promise.all([
      subjectIds.length ? this.prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      employeeIds.length ? this.prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, fullName: true } }) : Promise.resolve([]),
      loadTerms(this.prisma),
    ]);
    const subjectName = new Map(subjects.map((x) => [x.id, x.name]));
    const employeeName = new Map(employees.map((e) => [e.id, e.fullName]));
    const teacherOf = new Map<string, string>();
    for (const t of timetable) if (!teacherOf.has(t.subjectId!)) teacherOf.set(t.subjectId!, employeeName.get(t.employeeId!) ?? '');

    // ---- guardians ----------------------------------------------------------------------------------------
    let codes = new Map(profiles.map((p) => [p.guardianId, p.parentCode]));
    if (s.guardians.some((g) => !codes.has(g.guardianId))) {
      await this.parents.ensureProfiles().catch(() => undefined);
      const again = await this.prisma.parentProfile.findMany({ where: { guardianId: { in: s.guardians.map((g) => g.guardianId) } } });
      codes = new Map(again.map((p) => [p.guardianId, p.parentCode]));
    }
    const guardians = [...s.guardians]
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.guardian.fullName.localeCompare(b.guardian.fullName))
      .map((g) => ({
        id: g.guardian.id,
        parentCode: codes.get(g.guardianId) ?? '',
        fullName: g.guardian.fullName,
        relationship: g.relationship,
        isPrimary: g.isPrimary,
        canPickup: true,
        phone: g.guardian.phone || null,
        email: g.guardian.email,
        occupation: g.guardian.occupation,
      }));

    // ---- attendance ---------------------------------------------------------------------------------------
    const byMonth = new Map<string, { total: number; attended: number }>();
    const totals = { marked: 0, present: 0, late: 0, absent: 0, leave: 0 };
    for (const a of attendance) {
      const ym = dayKey(a.date).slice(0, 7);
      const m = byMonth.get(ym) ?? { total: 0, attended: 0 };
      m.total++;
      if (a.status === 'present' || a.status === 'late') m.attended++;
      byMonth.set(ym, m);
      totals.marked++;
      if (a.status in totals) totals[a.status as 'present' | 'late' | 'absent' | 'leave']++;
    }
    const months = [...byMonth.keys()].sort();
    const spansYears = months.length > 0 && months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
    const todayMark = attendance.find((a) => dayKey(a.date) === today);

    // ---- academics ----------------------------------------------------------------------------------------
    const scored = marks
      .filter((m) => m.assessment.maxMarks > 0)
      .map((m) => {
        const pct = !m.isAbsent && m.marks != null ? (100 * m.marks) / m.assessment.maxMarks : null;
        return { m, pct, heldOn: dayKey(m.assessment.heldOn) };
      })
      .sort((a, b) => a.heldOn.localeCompare(b.heldOn));
    const perSubject = new Map<string, number[]>();
    for (const x of scored) {
      if (x.pct == null) continue;
      const list = perSubject.get(x.m.assessment.subjectId) ?? [];
      list.push(x.pct);
      perSubject.set(x.m.assessment.subjectId, list);
    }
    const subjectRows = [...perSubject.entries()].map(([sid, pcts]) => {
      const score = Math.round(mean(pcts)!);
      const earlier = mean(pcts.slice(0, -1));
      return {
        name: subjectName.get(sid) ?? 'Subject',
        score,
        grade: gradeFor(score),
        target: null as number | null,
        trend: pcts.length >= 2 && earlier != null ? Math.round(pcts[pcts.length - 1] - earlier) : null,
        teacher: teacherOf.get(sid) || null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const termTrend = terms
      .map((t) => {
        const inTerm = scored.filter((x) => x.pct != null && x.heldOn >= t.start && x.heldOn <= t.end).map((x) => x.pct!);
        return inTerm.length ? { label: t.label.replace(/^Term (\d+) /, 'T$1 '), value: round1(mean(inTerm)!) } : null;
      })
      .filter((x): x is { label: string; value: number } => !!x);
    const assessments = [...scored].reverse().slice(0, 20).map(({ m, pct, heldOn }) => ({
      code: m.assessment.code,
      name: m.assessment.name,
      subject: subjectName.get(m.assessment.subjectId) ?? 'Subject',
      heldOn,
      maxMarks: m.assessment.maxMarks,
      marks: m.isAbsent ? null : m.marks,
      grade: m.grade ?? (pct != null ? gradeFor(pct) : null),
      isAbsent: m.isAbsent,
      pct: pct == null ? null : Math.round(pct),
    }));

    // ---- achievements, projects, documents ----------------------------------------------------------------
    const achievementRows = achievements.map((a) => ({
      id: a.id, title: a.title, type: a.type, level: a.level, date: dayKey(a.achievedOn), verified: a.verified,
    }));
    const projectRows = projects.map((p) => ({
      id: p.id,
      code: p.code,
      title: p.title,
      stage: p.stage,
      status: p.status === 'Completed' ? 'Completed' : (INNOVATION_STAGES[p.stage] ?? p.status),
      mentor: p.mentorId ? (employeeName.get(p.mentorId) ?? null) : null,
      milestones: p.milestones.length,
      done: p.milestones.filter((m) => m.completedOn).length,
    }));
    const documentRows = documents.map((d) => ({
      id: d.id, name: d.name, category: d.category, status: d.status, requestedOn: dayKeyOrNull(d.requestedOn),
      verifiedAt: iso(d.verifiedAt), createdAt: d.createdAt.toISOString(), hasFile: !!d.storageKey,
    }));

    // ---- timeline -----------------------------------------------------------------------------------------
    const timeline: ProfileTimelineItem[] = [];
    if (s.admittedOn) {
      timeline.push({ date: dayKey(s.admittedOn), title: 'Admitted to the school', body: `${s.admissionNo}${s.leadId ? ' · through Admissions' : ''}`, category: 'admission', tone: 'teal' });
    }
    for (const x of [...scored].reverse().slice(0, 6)) {
      const subj = subjectName.get(x.m.assessment.subjectId) ?? 'Subject';
      timeline.push({
        date: x.heldOn,
        title: `${subj}: ${x.m.assessment.name}`,
        body: x.m.isAbsent ? 'Absent' : x.pct != null ? `${x.m.marks}/${x.m.assessment.maxMarks} · ${Math.round(x.pct)}% · ${x.m.grade ?? gradeFor(x.pct)}` : null,
        category: 'assessment',
        tone: x.pct == null ? 'muted' : x.pct >= 70 ? 'teal' : x.pct >= 50 ? 'info' : 'amber',
      });
    }
    for (const a of achievements) {
      timeline.push({ date: dayKey(a.achievedOn), title: a.title, body: `${a.type}${a.level ? ` · ${a.level}` : ''}${a.verified ? ' · verified' : ''}`, category: 'achievement', tone: 'teal' });
    }
    for (const p of projects) {
      const started = p.startedOn ? dayKey(p.startedOn) : dayKey(p.createdAt);
      timeline.push({ date: started, title: `Innovation project: ${p.title}`, body: `${p.code} · ${p.studentId === id ? 'lead' : 'team member'}`, category: 'project', tone: 'info' });
    }
    for (const r of reportCards) {
      const at = r.batch.releasedAt ?? r.batch.updatedAt;
      timeline.push({ date: dayKey(at), title: `${r.batch.term} report card released`, body: null, category: 'report', tone: 'info' });
    }
    for (const c of statusChanges) {
      const back = c.toStatus === 'active';
      timeline.push({
        date: dayKey(c.effectiveOn),
        title: back ? 'Re-joined the school' : `Left the school (${(STATUS_LABEL[c.toStatus] ?? c.toStatus).toLowerCase()})`,
        body: staff ? c.reason : null,
        category: 'status',
        tone: back ? 'teal' : 'critical',
      });
    }
    timeline.push(...extras.timeline);
    timeline.sort((a, b) => b.date.localeCompare(a.date));

    // ---- wellbeing ----------------------------------------------------------------------------------------
    // Full record (check-ins) for students.sensitive; otherwise only the last non-confidential mood. The page shows
    // one or the other, so lastCheckin is left out of the full record.
    const wellbeing = sensitive
      ? {
        checkins: (checkins ?? []).map((c) => ({ date: dayKey(c.checkedOn), mood: c.mood, notes: c.notes, by: c.recordedByName })),
        infirmaryVisits,
        counsellingSessions: counselling.length,
        medicalNotes: s.medicalNotes,
      }
      : {
        lastCheckin: lastCheckin ? { date: dayKey(lastCheckin.checkedOn), mood: lastCheckin.mood } : null,
        medicalNotes: null,
      };

    const fee = fees?.get(id);
    const showInterventions = staff && can(user, 'earlywarning.read', 'earlywarning.manage');

    await this.audit.record({
      user, req, action: 'view', module: 'students', entityType: 'student', entityId: id, campusId: s.campusId, sensitive: true,
      description: `Viewed the Student 360 profile of ${s.fullName} (${s.admissionNo})${sensitive ? ' including wellbeing and medical records' : ''}${trackingState ? ' and location' : ''}`,
    });

    return {
      student: {
        id: s.id,
        admissionNo: s.admissionNo,
        fullName: s.fullName,
        firstName: s.firstName,
        lastName: s.lastName,
        photoUrl: s.photoUrl,
        dateOfBirth: dayKey(s.dateOfBirth),
        gender: s.gender,
        bloodGroup: s.bloodGroup,
        campusId: s.campusId,
        campusName: s.campus.name,
        campusShort: s.campus.shortName,
        sectionId: s.sectionId,
        grade: s.section?.class?.name ?? null,
        gradeLevel: s.section?.class?.gradeLevel ?? null,
        stage: s.section?.class?.stage ?? null,
        section: s.section?.name ?? null,
        room: s.section?.room ?? null,
        rollNo: s.rollNo,
        academicYear: year?.label ?? null,
        house: s.house,
        address: s.address,
        city: s.city,
        pincode: s.pincode,
        email: account?.email ?? null,
        phone: account?.phone ?? null,
        admittedOn: dayKeyOrNull(s.admittedOn),
        status: s.status,
        discontinuedOn: dayKeyOrNull(s.discontinuedOn),
        discontinueReason: staff ? s.discontinueReason : null,
        risk: s.risk,
        classTeacher: s.section?.classTeacher?.fullName ?? null,
        counsellor: counselling[0] ? (employeeName.get(counselling[0].counsellorId) ?? null) : null,
        attendance: s.attendancePct == null ? null : round1(s.attendancePct),
        average: s.averageScore == null ? null : round1(s.averageScore),
        trend: round1(s.scoreTrend ?? 0),
        feeStatus: fee?.feeStatus ?? null,
        today: active ? (todayMark?.status ?? 'unmarked') : 'unmarked',
      },
      guardians,
      attendance: {
        months: months.map((ym) => ({ label: monthLabel(ym, spansYears), value: Math.round((100 * byMonth.get(ym)!.attended) / byMonth.get(ym)!.total) })),
        totals: totals.marked ? totals : null,
        recent: attendance.slice(0, 20).map((a) => ({ date: dayKey(a.date), status: a.status, arrivalTime: a.arrivalTime, remarks: null as string | null })),
      },
      academics: { subjects: subjectRows, termTrend, assessments },
      skills: extras.skills,
      interests: extras.interests,
      activities: extras.activities,
      achievements: achievementRows,
      behaviour: behaviour.map((b) => ({ id: b.id, date: dayKey(b.recordedOn), type: b.recordType, note: b.note, by: b.recordedByName })),
      ...(observations ? { observations: observations.map((o) => this.records.observationRow(o)) } : {}),
      ...(showInterventions ? { interventions: extras.interventions ?? [] } : {}),
      documents: documentRows,
      innovationProjects: projectRows,
      transport: bus
        ? {
          routeId: bus.routeId, routeCode: bus.routeCode, routeName: bus.routeName, area: bus.area, runStatus: bus.runStatus, delayMinutes: bus.delayMinutes,
          eta: bus.eta, busNo: bus.busNo, registrationNo: bus.registrationNo, driver: bus.driver, attendant: bus.attendant, stopName: bus.stopName,
          pickupTime: bus.pickupTime, dropTime: bus.dropTime,
        }
        : null,
      timeline: timeline.slice(0, 40),
      talent: extras.talent,
      wellbeing,
      ...(fee ? { fees: { billed: fee.billed, paid: fee.paid, outstanding: fee.balance, nextDue: fee.nextDue } } : {}),
      ...(staff && can(user, ...TRACKING_READ)
        ? {
          tracking: {
            enabled: s.trackingStatus !== 'disabled',
            status: s.trackingStatus,
            latitude: trackingState?.latitude ?? null,
            longitude: trackingState?.longitude ?? null,
            locationStatus: trackingState?.locationStatus ?? null,
            recordedAt: iso(trackingState?.recordedAt),
          },
        }
        : {}),
    };
  }
}
