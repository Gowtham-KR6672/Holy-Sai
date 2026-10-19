import { Injectable } from '@nestjs/common';
import type { Prisma, StudentBehaviourNote, StudentObservation, StudentWellbeingCheckin } from '@prisma/client';
import type { Request } from 'express';
import { can, type AuthUser } from '../../common/auth-user';
import { paged } from '../../common/envelope';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { loadTerms, termOf } from '../academics/academics.util';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { BehaviourListQuery, CheckinListQuery } from './students.dto';
import {
  ALERT_MOODS, asDate, BEHAVIOUR_TYPES, change, CONCERN_TYPES, daysBetween, dayKey, isDateKey, istStart, MOODS, schoolToday, SENSITIVE, addDays,
} from './students.util';

export interface StudentBrief {
  id: string;
  fullName: string;
  firstName: string;
  admissionNo: string;
  grade: string;
  campusId: string;
  sectionId: string;
  classTeacherId: string | null;
  status: string;
}

interface Author { userId: string; employeeId: string | null; name: string; role: string }

type RecordWhere = { campusId?: string; studentId?: { in: string[] } };

/**
 * Behaviour notes, wellbeing check-ins and teacher observations — written from Student 360 and the Behaviour &
 * Wellbeing page (one table each). Reads are audited as sensitive.
 *
 * Exported for other modules (report cards, Early Warning, talent):
 *  - counts(studentIds, from?, to?) → per student { positive, notes, concerns, observations, checkins }
 *  - recentBehaviour(studentId, limit) / recentObservations(studentId, limit)
 */
@Injectable()
export class StudentRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async briefs(ids: (string | null | undefined)[]): Promise<Map<string, StudentBrief>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    const rows = await this.prisma.student.findMany({
      where: { id: { in: list } },
      select: {
        id: true, fullName: true, firstName: true, admissionNo: true, campusId: true, sectionId: true, status: true,
        section: { select: { name: true, classTeacherId: true, class: { select: { name: true } } } },
      },
    });
    return new Map(rows.map((s) => [s.id, {
      id: s.id, fullName: s.fullName, firstName: s.firstName, admissionNo: s.admissionNo, campusId: s.campusId, sectionId: s.sectionId, status: s.status,
      grade: s.section ? `${s.section.class.name}${s.section.name}` : '',
      classTeacherId: s.section?.classTeacherId ?? null,
    }]));
  }

  /** A student the user may record against: in scope and on the roll. */
  async writableStudent(user: AuthUser, studentId: string, field = 'studentId'): Promise<StudentBrief> {
    const s = (await this.briefs([studentId])).get(studentId);
    if (!s) throw field === 'studentId' ? fieldError(field, 'Choose a student') : notFound('Student');
    await this.scope.assertStudent(user, studentId);
    if (s.status !== 'active') throw badRequest(`${s.fullName} is no longer on the roll (${s.status})`);
    return s;
  }

  private async author(user: AuthUser): Promise<Author> {
    const e = user.employeeId
      ? await this.prisma.employee.findUnique({ where: { id: user.employeeId }, select: { fullName: true, designation: true } })
      : null;
    return { userId: user.id, employeeId: user.employeeId, name: e?.fullName ?? user.fullName, role: e?.designation || user.roleName };
  }

  /** Per-student records the user may see ({ campusId } for school-wide users, else their students' ids). */
  async recordWhere(user: AuthUser, requested?: string | null): Promise<RecordWhere> {
    const where = await this.scope.studentWhere(user, requested);
    const keys = Object.keys(where);
    if (keys.length === 0) return {};
    if (keys.length === 1 && typeof where.campusId === 'string') return { campusId: where.campusId };
    const ids = await this.prisma.student.findMany({ where, select: { id: true } });
    return { studentId: { in: ids.map((s) => s.id) } };
  }

  /** Students in scope whose name or admission number matches a search. */
  private async matchingStudentIds(user: AuthUser, term: string, requested?: string | null): Promise<string[]> {
    const rows = await this.prisma.student.findMany({
      where: { AND: [await this.scope.studentWhere(user, requested), { OR: [{ fullName: like(term) }, { admissionNo: like(term) }] }] },
      select: { id: true },
      take: 1000,
    });
    return rows.map((r) => r.id);
  }

  private behaviourRow(n: StudentBehaviourNote, s: StudentBrief | undefined) {
    return {
      id: n.id, date: dayKey(n.recordedOn), type: n.recordType, note: n.note, by: n.recordedByName,
      studentId: n.studentId, studentName: s?.fullName ?? 'Unknown student', admissionNo: s?.admissionNo ?? '', grade: s?.grade ?? '',
    };
  }

  private checkinRow(c: StudentWellbeingCheckin, s: StudentBrief | undefined) {
    return {
      id: c.id, date: dayKey(c.checkedOn), mood: c.mood, notes: c.notes, confidential: c.isConfidential, by: c.recordedByName,
      studentId: c.studentId, studentName: s?.fullName ?? 'Unknown student', admissionNo: s?.admissionNo ?? '', grade: s?.grade ?? '',
    };
  }

  observationRow(o: StudentObservation) {
    return { id: o.id, date: dayKey(o.observedOn), text: o.text, by: o.authorName, role: o.authorRole };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async addBehaviour(
    user: AuthUser,
    input: { studentId: string; recordType: string; note: string; recordedOn?: string; source: 'student360' | 'wellbeing' },
    req?: Request,
  ) {
    const field = input.source === 'wellbeing' ? 'studentId' : 'student';
    const s = await this.writableStudent(user, input.studentId, field);
    if (!(BEHAVIOUR_TYPES as readonly string[]).includes(input.recordType)) throw fieldError('recordType', 'Choose the type');
    const note = input.note.trim();
    if (note.length < 3) throw fieldError('note', 'Write a short note (at least 3 characters)');
    const today = schoolToday();
    const on = input.recordedOn?.slice(0, 10) || today;
    if (!isDateKey(on)) throw fieldError('recordedOn', 'Use a valid date');
    if (on > today) throw fieldError('recordedOn', 'The date cannot be in the future');
    if (on < addDays(today, -366)) throw fieldError('recordedOn', 'The date is more than a year ago');
    const a = await this.author(user);
    const row = await this.prisma.studentBehaviourNote.create({
      data: {
        studentId: s.id, campusId: s.campusId, sectionId: s.sectionId, recordType: input.recordType, note, recordedOn: asDate(on),
        recordedById: a.userId, recordedByEmployeeId: a.employeeId, recordedByName: a.name, source: input.source,
      },
    });
    await this.audit.record({
      user, req, action: 'create', module: 'students', entityType: 'behaviour_note', entityId: row.id, campusId: s.campusId, sensitive: true,
      description: `${input.recordType} behaviour note for ${s.fullName} (${s.admissionNo})`,
    });
    if (CONCERN_TYPES.includes(input.recordType)) {
      // The class teacher hears about concerns; incidents also go to the counsellor / safeguarding lead.
      const teacher = s.classTeacherId
        ? await this.prisma.user.findFirst({ where: { employeeId: s.classTeacherId, status: 'active' }, select: { id: true } })
        : null;
      const notice = {
        category: 'Attention' as const, topic: 'system', module: 'students', icon: 'flag', campusId: s.campusId,
        title: `${input.recordType} recorded for ${s.fullName}`, body: `${s.grade} · by ${a.name}`, route: `/student-360/${s.id}?tab=behaviour`,
      };
      if (teacher && teacher.id !== user.id) await this.notifications.notifyUsers([teacher.id], notice);
      if (input.recordType === 'Incident') await this.notifications.notifyPermission(SENSITIVE, notice);
    }
    return this.behaviourRow(row, s);
  }

  async addCheckin(
    user: AuthUser,
    input: { studentId: string; mood: string; notes?: string; isConfidential?: boolean; checkedOn?: string },
    req?: Request,
  ) {
    const s = await this.writableStudent(user, input.studentId);
    if (!(MOODS as readonly string[]).includes(input.mood)) throw fieldError('mood', 'Choose the mood');
    const confidential = !!input.isConfidential;
    if (confidential && !can(user, SENSITIVE)) throw forbidden('Confidential check-ins can only be recorded by the counsellor or the Principal');
    const notes = input.notes?.trim() || null;
    if (confidential && !notes) throw fieldError('notes', 'Add a note for a confidential check-in');
    const today = schoolToday();
    const on = input.checkedOn?.slice(0, 10) || today;
    if (!isDateKey(on)) throw fieldError('checkedOn', 'Use a valid date');
    if (on > today) throw fieldError('checkedOn', 'The date cannot be in the future');
    if (on < addDays(today, -366)) throw fieldError('checkedOn', 'The date is more than a year ago');
    const a = await this.author(user);
    const row = await this.prisma.studentWellbeingCheckin.create({
      data: {
        studentId: s.id, campusId: s.campusId, sectionId: s.sectionId, mood: input.mood, notes, isConfidential: confidential, checkedOn: asDate(on),
        recordedById: a.userId, recordedByEmployeeId: a.employeeId, recordedByName: a.name,
      },
    });
    await this.audit.record({
      user, req, action: 'create', module: 'students', entityType: 'wellbeing_checkin', entityId: row.id, campusId: s.campusId, sensitive: true,
      description: `${confidential ? 'Confidential wellbeing' : 'Wellbeing'} check-in for ${s.fullName} (${s.admissionNo})`,
    });
    if (ALERT_MOODS.includes(input.mood) && on >= addDays(today, -2)) {
      await this.notifications.notifyPermission(SENSITIVE, {
        category: 'Attention', topic: 'system', module: 'students', icon: 'heart', campusId: s.campusId,
        title: `Wellbeing check-in: ${s.fullName} (${s.grade})`,
        body: confidential ? 'Confidential check-in — open the record for details' : `Recorded as ${input.mood.toLowerCase()} by ${a.name}`,
        route: `/student-360/${s.id}?tab=wellbeing`,
      });
    }
    return this.checkinRow(row, s);
  }

  async addObservation(user: AuthUser, studentId: string, text: string, req?: Request) {
    const s = await this.writableStudent(user, studentId, 'student');
    const body = text.trim();
    if (body.length < 3) throw fieldError('observation', 'Write a short observation (at least 3 characters)');
    const a = await this.author(user);
    const row = await this.prisma.studentObservation.create({
      data: {
        studentId: s.id, campusId: s.campusId, text: body, observedOn: asDate(schoolToday()),
        authorId: a.userId, authorEmployeeId: a.employeeId, authorName: a.name, authorRole: a.role,
      },
    });
    await this.audit.record({
      user, req, action: 'create', module: 'students', entityType: 'observation', entityId: row.id, campusId: s.campusId, sensitive: true,
      description: `Teacher observation for ${s.fullName} (${s.admissionNo})`,
    });
    return this.observationRow(row);
  }

  // -------------------------------------------------------------------------
  // Behaviour & Wellbeing page
  // -------------------------------------------------------------------------

  async listBehaviour(user: AuthUser, q: BehaviourListQuery, req?: Request) {
    const p = pageOf(q, 10);
    const rw = await this.recordWhere(user, q.campusId);
    const and: Prisma.StudentBehaviourNoteWhereInput[] = [rw];
    if (q.type) and.push({ recordType: q.type });
    if (q.studentId) and.push({ studentId: q.studentId });
    const term = q.q?.trim();
    if (term) {
      const ids = await this.matchingStudentIds(user, term, q.campusId);
      and.push({ OR: [{ note: like(term) }, { recordedByName: like(term) }, ...(ids.length ? [{ studentId: { in: ids } }] : [])] });
    }
    const where: Prisma.StudentBehaviourNoteWhereInput = { AND: and };
    const [list, total] = await Promise.all([
      this.prisma.studentBehaviourNote.findMany({ where, orderBy: [{ recordedOn: 'desc' }, { createdAt: 'desc' }], skip: p.skip, take: p.take }),
      this.prisma.studentBehaviourNote.count({ where }),
    ]);
    const briefs = await this.briefs(list.map((n) => n.studentId));
    await this.audit.record({
      user, req, action: 'view', module: 'students', entityType: 'behaviour_note', sensitive: true,
      description: `Viewed behaviour notes (${list.length} of ${total}${q.type ? `, ${q.type}` : ''}${term ? `, search "${term}"` : ''})`,
    });
    return paged(list.map((n) => this.behaviourRow(n, briefs.get(n.studentId))), total, p);
  }

  async listCheckins(user: AuthUser, q: CheckinListQuery, req?: Request) {
    const p = pageOf(q, 10);
    const rw = await this.recordWhere(user, q.campusId);
    const and: Prisma.StudentWellbeingCheckinWhereInput[] = [rw];
    // Confidential check-ins are visible only to the counsellor, the Principal and others with students.sensitive.
    if (!can(user, SENSITIVE)) and.push({ isConfidential: false });
    if (q.mood) and.push({ mood: q.mood });
    if (q.studentId) and.push({ studentId: q.studentId });
    const term = q.q?.trim();
    if (term) {
      const ids = await this.matchingStudentIds(user, term, q.campusId);
      and.push({ studentId: { in: ids } });
    }
    const where: Prisma.StudentWellbeingCheckinWhereInput = { AND: and };
    const [list, total] = await Promise.all([
      this.prisma.studentWellbeingCheckin.findMany({ where, orderBy: [{ checkedOn: 'desc' }, { createdAt: 'desc' }], skip: p.skip, take: p.take }),
      this.prisma.studentWellbeingCheckin.count({ where }),
    ]);
    const briefs = await this.briefs(list.map((c) => c.studentId));
    await this.audit.record({
      user, req, action: 'view', module: 'students', entityType: 'wellbeing_checkin', sensitive: true,
      description: `Viewed wellbeing check-ins (${list.length} of ${total}${q.mood ? `, ${q.mood}` : ''}${term ? `, search "${term}"` : ''})`,
    });
    return paged(list.map((c) => this.checkinRow(c, briefs.get(c.studentId))), total, p);
  }

  /** School-wide picture for the Behaviour & Wellbeing page (this term against the same point last term). */
  async overview(user: AuthUser, campusId: string | undefined, req?: Request) {
    const sensitive = can(user, SENSITIVE);
    const today = schoolToday();
    const terms = await loadTerms(this.prisma);
    const term = termOf(terms, today);
    const termStart = term?.start ?? `${today.slice(0, 4)}-01-01`;
    const idx = term ? terms.indexOf(term) : -1;
    const prev = idx > 0 ? terms[idx - 1] : null;
    const elapsed = Math.max(0, daysBetween(termStart, today));
    const prevEnd = prev ? (addDays(prev.start, elapsed) < prev.end ? addDays(prev.start, elapsed) : prev.end) : null;

    const rw = await this.recordWhere(user, campusId);
    const studentCampus = rw.studentId ? {} : rw.campusId ? { campusId: rw.campusId } : {};
    const studentFilter = rw.studentId ? { studentId: rw.studentId } : {};
    const window = { gte: asDate(termStart), lte: asDate(today) };
    const prevWindow = prev && prevEnd ? { gte: asDate(prev.start), lte: asDate(prevEnd) } : null;
    const nowTs = new Date();
    const termTs = { gte: istStart(termStart), lte: nowTs };

    const [notes, prevNotes, checkins, sessions, upcoming, safeguarding, infirmary] = await Promise.all([
      this.prisma.studentBehaviourNote.findMany({ where: { ...rw, recordedOn: window }, select: { recordType: true, sectionId: true, studentId: true } }),
      prevWindow
        ? this.prisma.studentBehaviourNote.groupBy({ by: ['recordType'], where: { ...rw, recordedOn: prevWindow }, _count: { _all: true } })
        : Promise.resolve([] as { recordType: string; _count: { _all: number } }[]),
      this.prisma.studentWellbeingCheckin.findMany({
        where: { ...rw, checkedOn: window, ...(sensitive ? {} : { isConfidential: false }) },
        orderBy: [{ checkedOn: 'desc' }, { createdAt: 'desc' }],
        select: { studentId: true, mood: true },
      }),
      this.prisma.safetyCounsellingSession.findMany({
        where: { ...studentCampus, ...studentFilter, sessionOn: termTs, status: { not: 'Cancelled' } },
        select: { studentId: true },
      }),
      this.prisma.safetyCounsellingSession.count({ where: { ...studentCampus, ...studentFilter, status: 'Scheduled', sessionOn: { gt: nowTs } } }),
      this.prisma.safetyIncident.findMany({
        where: { ...studentCampus, ...(rw.studentId ? { studentId: rw.studentId } : {}), incidentType: 'Safeguarding', occurredOn: window },
        select: { status: true },
      }),
      sensitive || can(user, 'safety.read', 'safety.manage')
        ? this.prisma.safetyInfirmaryVisit.findMany({
          where: { ...studentCampus, ...studentFilter, visitedAt: { gte: istStart(today), lt: istStart(addDays(today, 1)) } },
          orderBy: { visitedAt: 'desc' },
        })
        : Promise.resolve(null),
    ]);

    const count = (types: string[]) => notes.filter((n) => types.includes(n.recordType)).length;
    const prevCount = (types: string[]) => prevNotes.filter((g) => types.includes(g.recordType)).reduce((a, g) => a + g._count._all, 0);
    const positive = count(['Positive']);
    const concerns = count(CONCERN_TYPES);

    // By grade (the section the student was in when the note was written)
    const sectionIds = [...new Set(notes.map((n) => n.sectionId).filter((x): x is string => !!x))];
    const missing = notes.filter((n) => !n.sectionId).map((n) => n.studentId);
    const [sections, briefs] = await Promise.all([
      sectionIds.length
        ? this.prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, class: { select: { name: true, gradeLevel: true } } } })
        : Promise.resolve([]),
      this.briefs([...missing, ...(infirmary ?? []).map((v) => v.studentId)]),
    ]);
    const classOfSection = new Map(sections.map((s) => [s.id, s.class]));
    const byGrade = new Map<string, { label: string; level: number; positive: number; concern: number }>();
    for (const n of notes) {
      const cls = n.sectionId ? classOfSection.get(n.sectionId) : null;
      const label = cls?.name ?? briefs.get(n.studentId)?.grade.replace(/[A-Z]$/, '') ?? 'Other';
      const g = byGrade.get(label) ?? { label, level: cls?.gradeLevel ?? 99, positive: 0, concern: 0 };
      if (n.recordType === 'Positive') g.positive++;
      else if (CONCERN_TYPES.includes(n.recordType)) g.concern++;
      byGrade.set(label, g);
    }

    // Latest mood per student this term
    const latest = new Map<string, string>();
    for (const c of checkins) if (!latest.has(c.studentId)) latest.set(c.studentId, c.mood);
    const moods = MOODS.map((m) => ({ label: m, value: [...latest.values()].filter((x) => x === m).length })).filter((m) => m.value > 0);

    const closed = safeguarding.filter((i) => i.status === 'Closed').length;
    if (infirmary) {
      await this.audit.record({
        user, req, action: 'view', module: 'students', entityType: 'wellbeing_overview', sensitive: true, campusId: campusId ?? null,
        description: `Viewed the Behaviour & Wellbeing overview (${infirmary.length} infirmary visit${infirmary.length === 1 ? '' : 's'} today)`,
      });
    }
    return {
      termStart,
      positive: { value: positive, delta: prevWindow ? change(positive, prevCount(['Positive'])) : null },
      concerns: { value: concerns, delta: prevWindow ? change(concerns, prevCount(CONCERN_TYPES)) : null },
      counselling: { sessions: sessions.length, students: new Set(sessions.map((x) => x.studentId)).size, upcoming },
      safeguarding: { total: safeguarding.length, closed, open: safeguarding.length - closed },
      byGrade: [...byGrade.values()]
        .filter((g) => g.positive || g.concern)
        .sort((a, b) => a.level - b.level || a.label.localeCompare(b.label))
        .map(({ label, positive: p, concern }) => ({ label, positive: p, concern })),
      moods,
      moodScope: term ? 'this term' : 'this year',
      infirmary: infirmary
        ? infirmary.map((v) => {
          const s = briefs.get(v.studentId);
          return { id: v.id, visitedAt: v.visitedAt.toISOString(), reason: v.reason, status: v.outcome, studentId: v.studentId, student: s?.fullName ?? 'Unknown student', grade: s?.grade ?? '' };
        })
        : null,
      canViewSensitive: sensitive,
    };
  }

  // -------------------------------------------------------------------------
  // For other modules
  // -------------------------------------------------------------------------

  /** Record counts per student (optionally within dates, YYYY-MM-DD inclusive). */
  async counts(studentIds: string[], from?: string, to?: string) {
    const out = new Map<string, { positive: number; notes: number; concerns: number; observations: number; checkins: number }>();
    const ids = [...new Set(studentIds)].filter(Boolean);
    for (const id of ids) out.set(id, { positive: 0, notes: 0, concerns: 0, observations: 0, checkins: 0 });
    if (!ids.length) return out;
    const range = from || to ? { ...(from ? { gte: asDate(from) } : {}), ...(to ? { lte: asDate(to) } : {}) } : undefined;
    const [b, o, c] = await Promise.all([
      this.prisma.studentBehaviourNote.groupBy({ by: ['studentId', 'recordType'], where: { studentId: { in: ids }, ...(range ? { recordedOn: range } : {}) }, _count: { _all: true } }),
      this.prisma.studentObservation.groupBy({ by: ['studentId'], where: { studentId: { in: ids }, ...(range ? { observedOn: range } : {}) }, _count: { _all: true } }),
      this.prisma.studentWellbeingCheckin.groupBy({ by: ['studentId'], where: { studentId: { in: ids }, ...(range ? { checkedOn: range } : {}) }, _count: { _all: true } }),
    ]);
    for (const g of b) {
      const r = out.get(g.studentId)!;
      if (g.recordType === 'Positive') r.positive += g._count._all;
      else if (CONCERN_TYPES.includes(g.recordType)) r.concerns += g._count._all;
      else r.notes += g._count._all;
    }
    for (const g of o) out.get(g.studentId)!.observations = g._count._all;
    for (const g of c) out.get(g.studentId)!.checkins = g._count._all;
    return out;
  }

  async recentBehaviour(studentId: string, limit = 10) {
    const rows = await this.prisma.studentBehaviourNote.findMany({ where: { studentId }, orderBy: [{ recordedOn: 'desc' }, { createdAt: 'desc' }], take: limit });
    return rows.map((n) => ({ id: n.id, date: dayKey(n.recordedOn), type: n.recordType, note: n.note, by: n.recordedByName }));
  }

  async recentObservations(studentId: string, limit = 10) {
    const rows = await this.prisma.studentObservation.findMany({ where: { studentId }, orderBy: [{ observedOn: 'desc' }, { createdAt: 'desc' }], take: limit });
    return rows.map((o) => this.observationRow(o));
  }
}
