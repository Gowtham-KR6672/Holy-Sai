import { Injectable } from '@nestjs/common';
import type { Assessment, Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AcademicsAccess } from './academics.access';
import { addDays, asDate, dayKey, GRADE_BANDS, gradeFor, mean, round1, schoolToday, sectionLabel } from './academics.util';

export interface MarkInput {
  studentId: string;
  marks: number | null;
  isAbsent: boolean;
}

type WithCount = Assessment & { _count: { marks: number } };

/** Assessments, marks entry, moderation and grade calculation. */
@Injectable()
export class AssessmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AcademicsAccess,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Teachers: assessments for their sections (or whole-grade assessments of their grades); staff: the campus. */
  async scopeWhere(user: AuthUser, campusId?: string): Promise<Prisma.AssessmentWhereInput> {
    const s = await this.access.sectionIdsOrCampus(user, campusId);
    if (s.sectionIds) {
      const classIds = s.sectionIds.length
        ? [...new Set((await this.prisma.section.findMany({ where: { id: { in: s.sectionIds } }, select: { classId: true } })).map((x) => x.classId))]
        : [];
      return { OR: [{ sectionId: { in: s.sectionIds } }, { sectionId: null, classId: { in: classIds } }] };
    }
    return s.campusId ? { campusId: s.campusId } : {};
  }

  /** Students who sit an assessment: its section, or every section of the grade. */
  async roster(a: Pick<Assessment, 'classId' | 'sectionId'>) {
    return this.prisma.student.findMany({
      where: { status: 'active', ...(a.sectionId ? { sectionId: a.sectionId } : { section: { classId: a.classId } }) },
      orderBy: [{ section: { name: 'asc' } }, { rollNo: 'asc' }, { fullName: 'asc' }],
      select: { id: true, admissionNo: true, fullName: true, rollNo: true, sectionId: true },
    });
  }

  /** Roster sizes per assessment. */
  private async rosterCounts(list: Pick<Assessment, 'id' | 'classId' | 'sectionId'>[]): Promise<Map<string, number>> {
    const classIds = [...new Set(list.filter((a) => !a.sectionId).map((a) => a.classId))];
    const sections = classIds.length ? await this.prisma.section.findMany({ where: { classId: { in: classIds } }, select: { id: true, classId: true } }) : [];
    const counts = await this.access.studentCounts([...new Set([...list.map((a) => a.sectionId).filter((x): x is string => !!x), ...sections.map((s) => s.id)])]);
    return new Map(list.map((a) => [a.id, a.sectionId ? counts.get(a.sectionId) ?? 0 : sections.filter((s) => s.classId === a.classId).reduce((n, s) => n + (counts.get(s.id) ?? 0), 0)]));
  }

  private async labels(list: Pick<Assessment, 'classId' | 'sectionId' | 'subjectId'>[]) {
    const [classes, sections, subjects] = await Promise.all([
      this.prisma.schoolClass.findMany({ where: { id: { in: [...new Set(list.map((a) => a.classId))] } }, select: { id: true, name: true } }),
      this.access.sectionInfo(list.map((a) => a.sectionId ?? '')),
      this.access.subjectNames(list.map((a) => a.subjectId)),
    ]);
    const className = new Map(classes.map((c) => [c.id, c.name]));
    return {
      grade: (a: Pick<Assessment, 'classId' | 'sectionId'>) => (a.sectionId ? sections.get(a.sectionId)?.label : undefined) ?? className.get(a.classId) ?? '',
      subject: (a: Pick<Assessment, 'subjectId'>) => subjects.get(a.subjectId) ?? '',
    };
  }

  async rows(list: WithCount[]) {
    const [labels, of, avgs] = await Promise.all([
      this.labels(list),
      this.rosterCounts(list),
      list.length
        ? this.prisma.assessmentMark.groupBy({ by: ['assessmentId'], where: { assessmentId: { in: list.map((a) => a.id) }, isAbsent: false, marks: { not: null } }, _avg: { marks: true } })
        : Promise.resolve([]),
    ]);
    return list.map((a) => {
      const avg = avgs.find((x) => x.assessmentId === a.id)?._avg.marks;
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        assessmentType: a.assessmentType,
        status: a.status,
        heldOn: dayKey(a.heldOn),
        maxMarks: a.maxMarks,
        classId: a.classId,
        sectionId: a.sectionId,
        grade: labels.grade(a),
        subject: labels.subject(a),
        subjectId: a.subjectId,
        of: of.get(a.id) ?? 0,
        entered: a._count.marks,
        averagePct: avg != null && a.maxMarks > 0 ? round1((100 * avg) / a.maxMarks) : null,
      };
    });
  }

  async list(user: AuthUser, q: { q?: string; page?: number; pageSize?: number; sort?: string; dir?: 'asc' | 'desc'; campusId?: string; status?: string; subjectId?: string }) {
    const p = pageOf(q);
    const where: Prisma.AssessmentWhereInput = {
      AND: [
        await this.scopeWhere(user, q.campusId),
        q.status ? { status: q.status } : {},
        q.subjectId ? { subjectId: q.subjectId } : {},
        q.q ? { OR: [{ name: like(q.q) }, { code: like(q.q) }] } : {},
      ],
    };
    const dir = q.dir ?? 'desc';
    const include = { _count: { select: { marks: true } } } as const;
    const total = await this.prisma.assessment.count({ where });
    if (q.sort === 'grade') {
      const all = await this.rows(await this.prisma.assessment.findMany({ where, include, orderBy: { heldOn: 'desc' } }));
      all.sort((a, b) => a.grade.localeCompare(b.grade, undefined, { numeric: true }) * (dir === 'asc' ? 1 : -1));
      return { rows: all.slice(p.skip, p.skip + p.take), total, p };
    }
    const orderBy: Prisma.AssessmentOrderByWithRelationInput[] =
      q.sort === 'name' ? [{ name: dir }] : q.sort === 'max' ? [{ maxMarks: dir }] : q.sort === 'status' ? [{ status: dir }, { heldOn: 'desc' }] : [{ heldOn: dir }, { code: dir }];
    const list = await this.prisma.assessment.findMany({ where, include, orderBy, skip: p.skip, take: p.take });
    return { rows: await this.rows(list), total, p };
  }

  async summary(user: AuthUser, campusId?: string) {
    const where = await this.scopeWhere(user, campusId);
    const today = schoolToday();
    const [active, moderation, completedThisTerm] = await Promise.all([
      this.prisma.assessment.findMany({ where: { AND: [where, { status: { in: ['Scheduled', 'In Progress'] } }] }, include: { _count: { select: { marks: true } } }, orderBy: { heldOn: 'asc' } }),
      this.prisma.assessment.findMany({ where: { AND: [where, { status: 'Moderation' }] }, orderBy: { moderationAt: 'asc' } }),
      this.prisma.assessment.count({ where: { AND: [where, { status: 'Completed', completedAt: { gte: asDate(addDays(today, -90)) } }] } }),
    ]);
    const rows = await this.rows(active);
    const pending = rows.filter((r) => r.heldOn <= today && r.entered < r.of);
    const labels = await this.labels(moderation);
    const foot = (names: string[]) => (names.length ? `${names[0]}${names.length > 1 ? ` and ${names.length - 1} more` : ''}` : null);

    // Grade distribution of the latest completed assessment.
    const latestCompleted = await this.prisma.assessment.findFirst({ where: { AND: [where, { status: 'Completed' }, { marks: { some: {} } }] }, orderBy: [{ completedAt: 'desc' }, { heldOn: 'desc' }] });
    let distribution: { assessment: string; labels: string[]; values: number[] } | null = null;
    if (latestCompleted) {
      const marks = await this.prisma.assessmentMark.findMany({ where: { assessmentId: latestCompleted.id, isAbsent: false, marks: { not: null } }, select: { marks: true } });
      const values = GRADE_BANDS.map((g) => marks.filter((m) => gradeFor((100 * (m.marks ?? 0)) / latestCompleted.maxMarks) === g).length);
      distribution = { assessment: `${latestCompleted.code} · ${latestCompleted.name}`, labels: GRADE_BANDS, values };
    }

    // Marker consistency for the assessment in moderation (or the latest completed one).
    const target = moderation[moderation.length - 1] ?? latestCompleted;
    let markers: { assessment: string; status: string; cohortMean: number; rows: { marker: string; mean: number; scripts: number; deviation: number; flagged: boolean }[] } | null = null;
    if (target) {
      const marks = await this.prisma.assessmentMark.findMany({ where: { assessmentId: target.id, isAbsent: false, marks: { not: null } }, select: { marks: true, enteredById: true, enteredByName: true } });
      if (marks.length) {
        const pcts = marks.map((m) => ({ who: m.enteredByName ?? 'Unknown marker', p: (100 * (m.marks ?? 0)) / target.maxMarks }));
        const cohortMean = round1(mean(pcts.map((x) => x.p)) ?? 0);
        const byMarker = new Map<string, number[]>();
        for (const x of pcts) byMarker.set(x.who, [...(byMarker.get(x.who) ?? []), x.p]);
        markers = {
          assessment: `${target.code} · ${target.name}`,
          status: target.status,
          cohortMean,
          rows: [...byMarker].map(([marker, ps]) => {
            const m = round1(mean(ps) ?? 0);
            const deviation = round1(m - cohortMean);
            return { marker, mean: m, scripts: ps.length, deviation, flagged: Math.abs(deviation) > 4 };
          }).sort((a, b) => b.scripts - a.scripts),
        };
      }
    }
    return {
      active: active.length,
      scheduled: active.filter((a) => a.status === 'Scheduled').length,
      inProgress: active.filter((a) => a.status === 'In Progress').length,
      marksPending: pending.length,
      marksPendingFoot: pending.length ? `${pending[0].grade} ${pending[0].subject} — ${pending[0].entered}/${pending[0].of} entered${pending.length > 1 ? ` · ${pending.length - 1} more` : ''}` : null,
      awaitingModeration: moderation.length,
      moderationFoot: foot(moderation.map((a) => `${labels.grade(a)} ${labels.subject(a)}`)),
      completedThisTerm,
      distribution,
      markers,
    };
  }

  async load(user: AuthUser, id: string): Promise<Assessment> {
    const a = await this.prisma.assessment.findUnique({ where: { id } });
    if (!a) throw notFound('Assessment');
    const n = await this.prisma.assessment.count({ where: { AND: [{ id }, await this.scopeWhere(user)] } });
    if (!n) throw forbidden('This assessment is outside your classes');
    return a;
  }

  private lockReason(a: Assessment, user: AuthUser): string | null {
    const today = schoolToday();
    if (a.status === 'Completed') return 'Grades are final. Marks can no longer be changed.';
    if (a.status === 'Moderation') return this.access.isSchoolLevel(user) ? 'Marks are locked while the assessment is in moderation. Finalise grades once the second read is done.' : 'Marks are locked while the assessment is in moderation.';
    if (dayKey(a.heldOn) > today) return `Marks can be entered from ${dayKey(a.heldOn)}, the day the assessment is held.`;
    if (!user.permissions.has('assessments.manage')) return 'Marks are entered by the subject teacher.';
    return null;
  }

  async detail(user: AuthUser, id: string) {
    const a = await this.load(user, id);
    const [students, marks, labels, sections] = await Promise.all([
      this.roster(a),
      this.prisma.assessmentMark.findMany({ where: { assessmentId: id } }),
      this.labels([a]),
      this.prisma.section.findMany({ where: a.sectionId ? { id: a.sectionId } : { classId: a.classId }, include: { class: true } }),
    ]);
    const byStudent = new Map(marks.map((m) => [m.studentId, m]));
    const secLabel = new Map(sections.map((s) => [s.id, sectionLabel(s.class.name, s.name)]));
    const lockReason = this.lockReason(a, user);
    const entered = students.filter((s) => byStudent.has(s.id)).length;
    return {
      id: a.id,
      code: a.code,
      name: a.name,
      status: a.status,
      heldOn: dayKey(a.heldOn),
      maxMarks: a.maxMarks,
      grade: labels.grade(a),
      subject: labels.subject(a),
      locked: a.status === 'Moderation' || a.status === 'Completed',
      canEnter: !lockReason,
      lockReason,
      entered,
      of: students.length,
      students: students.map((s) => {
        const m = byStudent.get(s.id);
        return {
          id: s.id,
          admissionNo: s.admissionNo,
          fullName: s.fullName,
          section: secLabel.get(s.sectionId) ?? '',
          roll: s.rollNo,
          marks: m?.marks ?? null,
          isAbsent: m?.isAbsent ?? false,
          grade: m?.grade ?? null,
          enteredBy: m?.enteredByName ?? null,
        };
      }),
    };
  }

  async create(user: AuthUser, dto: { name: string; subjectId: string; classId: string; sectionId?: string | null; heldOn: string; maxMarks: number; assessmentType?: string }, req: Request) {
    const cls = await this.prisma.schoolClass.findUnique({ where: { id: dto.classId } });
    if (!cls) throw fieldError('classId', 'Choose a grade');
    if (!(await this.prisma.subject.findUnique({ where: { id: dto.subjectId } }))) throw fieldError('subjectId', 'Choose a subject');
    if (this.access.restricted(user)) {
      if (!dto.sectionId) throw fieldError('sectionId', 'Choose one of your sections');
    } else if (!(await this.access.canSeeSection(user, '', cls.campusId))) {
      throw fieldError('classId', 'This grade is outside your campus');
    }
    if (dto.sectionId) {
      const s = await this.prisma.section.findUnique({ where: { id: dto.sectionId } });
      if (!s || s.classId !== cls.id) throw fieldError('sectionId', 'Choose a section of this grade');
      if (!(await this.access.canSeeSection(user, s.id, s.campusId))) throw fieldError('sectionId', 'Choose one of your sections');
    }
    const code = await this.counters.reference('AS', 'assessments', 0, 3301);
    const a = await this.prisma.assessment.create({
      data: {
        code,
        name: dto.name.trim(),
        assessmentType: dto.assessmentType ?? 'test',
        status: 'Scheduled',
        heldOn: asDate(dto.heldOn),
        maxMarks: dto.maxMarks,
        campusId: cls.campusId,
        classId: cls.id,
        sectionId: dto.sectionId ?? null,
        subjectId: dto.subjectId,
        createdById: user.id,
        createdByName: user.fullName,
      },
    });
    await this.audit.record({ user, action: 'create', module: 'academics', entityType: 'assessment', entityId: a.id, campusId: a.campusId, description: `Created assessment ${code} "${a.name}" on ${dto.heldOn} (out of ${dto.maxMarks})`, req });
    return a;
  }

  /**
   * Saves marks and moves the assessment on: save (Scheduled → In Progress), send for moderation, or complete.
   * Also used by Paper Correction to push approved marks (action 'save').
   */
  async saveMarks(user: AuthUser, id: string, marks: MarkInput[], action: 'save' | 'moderation' | 'complete', req?: Request) {
    const a = await this.load(user, id);
    const roster = await this.roster(a);
    const inRoster = new Set(roster.map((s) => s.id));
    if (marks.length) {
      const reason = this.lockReason(a, user);
      if (reason) throw badRequest(reason);
      for (const m of marks) {
        if (!inRoster.has(m.studentId)) throw badRequest('One of the students is not on this roster. Reload and try again.');
        if (m.marks != null && (!Number.isFinite(m.marks) || m.marks < 0 || m.marks > a.maxMarks)) throw badRequest(`Marks must be between 0 and ${a.maxMarks}`);
        if (m.marks != null && m.isAbsent) throw badRequest('Absent students have no mark');
      }
      await this.prisma.$transaction(
        marks.map((m) => {
          const key = { assessmentId_studentId: { assessmentId: id, studentId: m.studentId } };
          if (m.marks == null && !m.isAbsent) return this.prisma.assessmentMark.deleteMany({ where: { assessmentId: id, studentId: m.studentId } });
          const data = {
            marks: m.isAbsent ? null : m.marks,
            isAbsent: m.isAbsent,
            grade: m.isAbsent || m.marks == null ? null : gradeFor((100 * m.marks) / a.maxMarks),
            enteredById: user.id,
            enteredByName: user.fullName,
            enteredAt: new Date(),
          };
          return this.prisma.assessmentMark.upsert({ where: key, create: { assessmentId: id, studentId: m.studentId, ...data }, update: data });
        }),
      );
    }
    const entered = await this.prisma.assessmentMark.count({ where: { assessmentId: id, studentId: { in: [...inRoster] } } });
    const of = roster.length;
    let status = a.status;
    let message = marks.length ? `Marks saved — ${entered} of ${of} entered` : 'No changes to save';
    const labels = await this.labels([a]);
    const what = `${a.code} ${labels.grade(a)} ${labels.subject(a)}`;

    if (action === 'save') {
      if (a.status === 'Scheduled' && entered > 0) status = 'In Progress';
    } else if (action === 'moderation') {
      if (a.status !== 'Scheduled' && a.status !== 'In Progress') throw badRequest(`This assessment is already ${a.status.toLowerCase()}`);
      if (entered < of) throw badRequest(`Enter a mark or mark absent for every student first (${entered} of ${of})`);
      status = 'Moderation';
      const leads = await this.access.schoolLeads(a.campusId, user.id);
      for (const assigneeId of leads) {
        await this.notifications.createTask({ title: `Moderate ${what}`, module: 'Academics', assigneeId, status: 'Under Review', priority: 'Medium', route: '/assessments?status=Moderation', entityType: 'assessment', entityId: a.id });
      }
      message = 'Sent for moderation — marks are locked';
    } else {
      if (a.status === 'Completed') throw badRequest('This assessment is already completed');
      if (a.status === 'Moderation' && !this.access.isSchoolLevel(user)) throw forbidden('Moderation is finalised by the academic office');
      if (entered < of) throw badRequest(`Enter a mark or mark absent for every student first (${entered} of ${of})`);
      status = 'Completed';
      message = a.status === 'Moderation' ? 'Moderation complete — grades are final' : 'Assessment completed — grades are final';
    }

    if (status !== a.status) {
      await this.prisma.assessment.update({
        where: { id },
        data: {
          status,
          ...(status === 'Moderation' ? { moderationAt: new Date() } : {}),
          ...(status === 'Completed' ? { completedAt: new Date(), completedById: user.id, completedByName: user.fullName } : {}),
        },
      });
      if (status === 'Completed') await this.notifications.completeTasksFor('assessment', id);
    }
    if (marks.length) await this.refreshScores(marks.map((m) => m.studentId));
    if (marks.length || status !== a.status) {
      await this.audit.record({
        user,
        action: status === 'Completed' && a.status === 'Moderation' ? 'approve' : 'update',
        module: 'academics', entityType: 'assessment', entityId: id, campusId: a.campusId, req,
        description: `${what}: ${marks.length ? `${marks.length} mark(s) saved` : 'no mark changes'}${status !== a.status ? `, ${a.status} → ${status}` : ''}`,
      });
    }
    return { status, entered, of, message };
  }

  /** Recomputes the cached average score and trend (latest result against the earlier average). */
  async refreshScores(studentIds: string[]) {
    const ids = [...new Set(studentIds)];
    if (!ids.length) return;
    const marks = await this.prisma.assessmentMark.findMany({
      where: { studentId: { in: ids }, isAbsent: false, marks: { not: null } },
      select: { studentId: true, marks: true, assessment: { select: { maxMarks: true, heldOn: true } } },
    });
    for (const id of ids) {
      const mine = marks
        .filter((m) => m.studentId === id && m.assessment.maxMarks > 0)
        .sort((a, b) => a.assessment.heldOn.getTime() - b.assessment.heldOn.getTime())
        .map((m) => (100 * (m.marks ?? 0)) / m.assessment.maxMarks);
      const avg = mean(mine);
      const earlier = mean(mine.slice(0, -1));
      await this.prisma.student.update({
        where: { id },
        data: { averageScore: avg == null ? null : round1(avg), scoreTrend: mine.length >= 2 && earlier != null ? round1(mine[mine.length - 1] - earlier) : null },
      });
    }
  }
}
