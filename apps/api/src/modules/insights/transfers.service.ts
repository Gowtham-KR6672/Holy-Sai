import { Injectable, Logger } from '@nestjs/common';
import type { GroupTransfer, Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { paged } from '../../common/envelope';
import { badRequest, conflict, fieldError, notFound } from '../../common/errors';
import { like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { FinanceLedgerService } from '../finance/ledger.service';
import { NotificationsService, type NotifyInput } from '../notifications/notifications.service';
import { GroupMetricsService } from './group-metrics.service';
import { GuardedReadsService } from './guarded-reads.service';
import { campusParam, currentTerms, dateOf, inr, isoOrNull, keyOf, sortRows, todayKey, uuidOr404 } from './insights.util';

export const TRANSFER_STATUSES = ['Submitted', 'Under Review', 'Approved', 'Completed', 'Rejected'];
export const TRANSFER_OPEN = ['Submitted', 'Under Review', 'Approved'];
const ENTITY = 'group_transfer';
const ROUTE = '/transfers';

type StudentRow = Prisma.StudentGetPayload<{
  select: { id: true; fullName: true; admissionNo: true; campusId: true; sectionId: true; status: true; campus: { select: { name: true } }; section: { select: { name: true; class: { select: { name: true; gradeLevel: true } } } } };
}>;

/**
 * Inter-campus transfers: a request is raised for a student, reviewed and approved (or rejected) by group
 * managers, and completed by moving the core Student record into a class at the destination campus.
 * Both campuses are notified at every step; every step is audited.
 */
@Injectable()
export class TransfersService {
  private readonly log = new Logger('Transfers');

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly ledger: FinanceLedgerService,
    private readonly metrics: GroupMetricsService,
    private readonly guarded: GuardedReadsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private campusWhere(campusId?: string): Prisma.GroupTransferWhereInput {
    return campusId ? { OR: [{ fromCampusId: campusId }, { toCampusId: campusId }] } : {};
  }

  private async students(ids: string[]): Promise<Map<string, StudentRow>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await this.prisma.student.findMany({
      where: { id: { in: unique } },
      select: {
        id: true, fullName: true, admissionNo: true, campusId: true, sectionId: true, status: true,
        campus: { select: { name: true } }, section: { select: { name: true, class: { select: { name: true, gradeLevel: true } } } },
      },
    });
    return new Map(rows.map((s) => [s.id, s]));
  }

  /** Rows as the Transfers page reads them. */
  private async rows(list: GroupTransfer[]) {
    const [students, campuses, sections] = await Promise.all([
      this.students(list.map((t) => t.studentId)),
      this.prisma.campus.findMany({ select: { id: true, name: true } }),
      this.prisma.section.findMany({
        where: { id: { in: [...new Set(list.map((t) => t.toSectionId).filter((x): x is string => !!x))] } },
        select: { id: true, name: true, class: { select: { name: true } } },
      }),
    ]);
    const campusName = new Map(campuses.map((c) => [c.id, c.name]));
    const sec = new Map(sections.map((s) => [s.id, s]));
    return list.map((t) => {
      const s = students.get(t.studentId);
      const to = t.toSectionId ? sec.get(t.toSectionId) : undefined;
      return {
        id: t.id,
        status: t.status,
        reason: t.reason,
        requestedOn: keyOf(t.requestedOn),
        decidedAt: isoOrNull(t.decidedAt),
        decisionNote: t.decisionNote,
        completedAt: isoOrNull(t.completedAt),
        fromCampusId: t.fromCampusId,
        fromCampus: campusName.get(t.fromCampusId) ?? '—',
        toCampusId: t.toCampusId,
        toCampus: campusName.get(t.toCampusId) ?? '—',
        studentId: t.studentId,
        studentName: s?.fullName ?? 'Student',
        admissionNo: s?.admissionNo ?? '',
        grade: s?.section?.class.name ?? null,
        gradeLevel: s?.section?.class.gradeLevel ?? null,
        section: s?.section?.name ?? null,
        currentCampus: s?.campus?.name ?? '—',
        requestedBy: t.requestedByName,
        decidedBy: t.decidedByName,
        completedBy: t.completedByName,
        toSection: to?.name ?? null,
        toGrade: to?.class.name ?? null,
      };
    });
  }

  async list(user: AuthUser, q: { q?: string; status?: string; sort?: string; dir?: 'asc' | 'desc'; campusId?: string; page?: number; pageSize?: number }) {
    const p = pageOf(q);
    const campus = this.scope.campus(user, campusParam(q.campusId));
    const term = q.q?.trim();
    const matching = term
      ? (await this.prisma.student.findMany({ where: { OR: [{ fullName: like(term) }, { admissionNo: like(term) }] }, select: { id: true }, take: 500 })).map((s) => s.id)
      : [];
    const where: Prisma.GroupTransferWhereInput = {
      AND: [
        this.campusWhere(campus),
        q.status === 'open' ? { status: { in: TRANSFER_OPEN } } : q.status ? { status: q.status } : {},
        term ? { OR: [{ reason: like(term) }, { studentId: { in: matching } }] } : {},
      ],
    };
    const list = await this.prisma.groupTransfer.findMany({ where, orderBy: [{ requestedOn: 'desc' }, { createdAt: 'desc' }], take: 5000 });
    const rows = await this.rows(list);
    const order: Record<string, number> = Object.fromEntries(TRANSFER_STATUSES.map((s, i) => [s, i]));
    const keys: Record<string, (r: (typeof rows)[number]) => string | number | null> = {
      requested: (r) => `${r.requestedOn}|${r.id}`,
      student: (r) => r.studentName,
      from: (r) => r.fromCampus,
      to: (r) => r.toCampus,
      status: (r) => order[r.status] ?? 9,
    };
    const key = q.sort && keys[q.sort] ? q.sort : 'requested';
    const dir = q.sort && keys[q.sort] ? q.dir ?? 'asc' : 'desc';
    const sorted = sortRows(rows, keys[key], dir);
    return paged(sorted.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  async summary(user: AuthUser, campusId?: string) {
    const campus = this.scope.campus(user, campusParam(campusId));
    const y = await this.ledger.year();
    const { current } = currentTerms(y, todayKey());
    const base = this.campusWhere(campus);
    const [byStatus, thisTerm] = await Promise.all([
      this.prisma.groupTransfer.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      this.prisma.groupTransfer.count({ where: { AND: [base, { requestedOn: { gte: dateOf(current.start) } }] } }),
    ]);
    const n = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
    return {
      submitted: n('Submitted'),
      underReview: n('Under Review'),
      approved: n('Approved'),
      completed: n('Completed'),
      rejected: n('Rejected'),
      thisTerm,
    };
  }

  /** Transfers still in progress, for the Group Dashboard. */
  async openForDashboard() {
    if (!(await this.guarded.has('GroupTransfer'))) return [];
    const list = await this.prisma.groupTransfer.findMany({ where: { status: { in: TRANSFER_OPEN } }, orderBy: { requestedOn: 'desc' }, take: 8 });
    const rows = await this.rows(list);
    return rows.map((r) => ({
      id: r.id, studentId: r.studentId, studentName: r.studentName, grade: r.grade ? `${r.grade}${r.section ?? ''}` : null,
      fromCampus: r.fromCampus, toCampus: r.toCampus, status: r.status,
    }));
  }

  private async load(user: AuthUser, id: string) {
    uuidOr404(id, 'Transfer');
    const t = await this.prisma.groupTransfer.findUnique({ where: { id } });
    if (!t) throw notFound('Transfer');
    // School staff pinned to one campus see transfers that touch it.
    if (!user.permissions.has('dashboard.group') && user.campusId && t.fromCampusId !== user.campusId && t.toCampusId !== user.campusId) {
      throw notFound('Transfer');
    }
    return t;
  }

  async detail(user: AuthUser, id: string) {
    const t = await this.load(user, id);
    const [row] = await this.rows([t]);
    const student = (await this.students([t.studentId])).get(t.studentId);
    const gradeLevel = student?.section?.class.gradeLevel ?? null;
    const [account, documents, incidents, transport, sections] = await Promise.all([
      this.ledger.accountSummaries([t.studentId]).then((m) => m.get(t.studentId)),
      this.prisma.opsDocument.count({ where: { studentId: t.studentId, status: { not: 'Verified' } } }),
      this.prisma.safetyIncident.count({ where: { studentId: t.studentId, status: { not: 'Closed' } } }),
      this.prisma.studentTransport.findUnique({ where: { studentId: t.studentId }, select: { route: { select: { code: true, campusId: true, vehicleLabel: true } } } }),
      this.destinationSections(t.toCampusId, gradeLevel),
    ]);
    const toCampus = row.toCampus;
    const sameGrade = gradeLevel == null ? [] : sections.filter((s) => s.gradeLevel === gradeLevel);
    const balance = account?.balance ?? 0;
    const overdue = account?.overdue ?? 0;
    const checks = [
      {
        key: 'fees', label: 'Fees cleared', passed: balance <= 0.004,
        detail: overdue > 0 ? `${inr(overdue)} overdue` : balance > 0 ? `${inr(balance)} outstanding` : 'Nothing outstanding',
      },
      { key: 'documents', label: 'Documents verified', passed: documents === 0, detail: documents ? `${documents} awaiting verification` : 'All verified' },
      { key: 'safety', label: 'No open incidents', passed: incidents === 0, detail: incidents ? `${incidents} open` : 'None open' },
      {
        key: 'seat', label: `Seat available at ${toCampus}`,
        passed: sameGrade.some((s) => s.enrolled < s.capacity),
        detail: !sameGrade.length ? `No ${student?.section?.class.name ?? 'matching'} class at ${toCampus}` : sameGrade.some((s) => s.enrolled < s.capacity) ? 'Seat free' : 'Every class is full',
      },
      {
        key: 'transport', label: 'Transport', passed: !transport || transport.route.campusId === t.toCampusId,
        detail: transport && transport.route.campusId !== t.toCampusId
          ? `On ${transport.route.vehicleLabel || transport.route.code} — removed from the bus list when the move completes`
          : transport ? 'Route continues' : 'Not on a bus route',
      },
    ];
    return { ...row, checks, sections };
  }

  /** Classes at the destination campus, closest to the student's grade first, with seats taken. */
  private async destinationSections(campusId: string, gradeLevel: number | null) {
    const sections = await this.prisma.section.findMany({
      where: { campusId },
      select: { id: true, name: true, room: true, capacity: true, classTeacher: { select: { fullName: true } }, class: { select: { name: true, gradeLevel: true } } },
    });
    const counts = sections.length
      ? await this.prisma.student.groupBy({ by: ['sectionId'], where: { status: 'active', sectionId: { in: sections.map((s) => s.id) } }, _count: { _all: true } })
      : [];
    const enrolled = new Map(counts.map((c) => [c.sectionId, c._count._all]));
    return sections
      .map((s) => ({
        id: s.id, name: s.name, grade: s.class.name, gradeLevel: s.class.gradeLevel, capacity: s.capacity, enrolled: enrolled.get(s.id) ?? 0,
        room: s.room, classTeacher: s.classTeacher?.fullName ?? null,
      }))
      .sort((a, b) =>
        (gradeLevel == null ? 0 : Math.abs(a.gradeLevel - gradeLevel) - Math.abs(b.gradeLevel - gradeLevel))
        || a.gradeLevel - b.gradeLevel || a.name.localeCompare(b.name, 'en', { numeric: true }));
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /** Group managers on either campus (and group-wide managers). */
  private async managers(campusIds: string[]) {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'active',
        role: { key: { notIn: ['parent', 'student'] }, permissions: { some: { permissionKey: 'group.manage' } } },
        OR: [{ campusId: { in: campusIds } }, { campusId: null }],
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** Tells the group managers of both campuses (and anyone in `extra`), except the person who acted. */
  private async tell(t: GroupTransfer, actor: AuthUser, input: Omit<NotifyInput, 'route' | 'module' | 'topic'>, extra: (string | null | undefined)[] = []) {
    try {
      const ids = await this.managers([t.fromCampusId, t.toCampusId]);
      const to = [...ids, ...extra.filter((x): x is string => !!x)].filter((id) => id !== actor.id);
      await this.notifications.notifyUsers(to, { ...input, topic: 'system', module: 'group', route: ROUTE });
    } catch (err) {
      this.log.warn(`Transfer notification failed: ${(err as Error).message}`);
    }
  }

  private async tasks(t: GroupTransfer, campusIds: string[], title: string, exclude: string | null) {
    const ids = (await this.managers(campusIds)).filter((id) => id !== exclude);
    for (const assigneeId of ids) {
      await this.notifications.createTask({
        title, module: 'group', assigneeId, status: 'Under Review', priority: 'Medium', route: ROUTE, entityType: ENTITY, entityId: t.id,
        dueOn: new Date(Date.now() + 7 * 86_400_000),
      });
    }
  }

  async create(user: AuthUser, dto: { studentId: string; toCampusId: string; reason: string }, req: Request) {
    const student = (await this.students([dto.studentId])).get(dto.studentId);
    if (!student) throw fieldError('studentId', 'Choose a student');
    try {
      await this.scope.assertStudent(user, student.id);
    } catch {
      throw fieldError('studentId', 'This student is outside your access');
    }
    if (student.status !== 'active') throw fieldError('studentId', 'Only students on roll can be transferred');
    const to = await this.prisma.campus.findUnique({ where: { id: dto.toCampusId } });
    if (!to || !to.isActive) throw fieldError('toCampusId', 'Choose a campus');
    if (to.id === student.campusId) throw fieldError('toCampusId', `${student.fullName} is already at ${to.name}`);
    const reason = dto.reason.trim();
    if (reason.length < 5) throw fieldError('reason', 'Give a short reason');
    const open = await this.prisma.groupTransfer.findFirst({ where: { studentId: student.id, status: { in: TRANSFER_OPEN } } });
    if (open) throw fieldError('studentId', `A transfer for ${student.fullName} is already open`);

    const t = await this.prisma.groupTransfer.create({
      data: {
        studentId: student.id, fromCampusId: student.campusId, fromSectionId: student.sectionId, toCampusId: to.id, reason,
        status: 'Submitted', requestedOn: dateOf(todayKey()), requestedById: user.id, requestedByName: user.fullName,
      },
    });
    await this.audit.record({
      user, action: 'create', module: 'group', entityType: ENTITY, entityId: t.id, campusId: student.campusId, req,
      description: `Requested transfer of ${student.fullName} (${student.admissionNo}) from ${student.campus.name} to ${to.name}`,
      metadata: { from: student.campus.name, to: to.name },
    });
    await this.tell(t, user, { category: 'Attention', title: `Transfer requested — ${student.fullName}`, body: `From ${student.campus.name} to ${to.name}. ${reason}` });
    await this.tasks(t, [t.fromCampusId, t.toCampusId], `Review transfer of ${student.fullName} to ${to.name}`, user.id).catch((e) =>
      this.log.warn(`Transfer tasks failed: ${(e as Error).message}`));
    return { id: t.id, status: t.status };
  }

  async decide(user: AuthUser, id: string, dto: { action: string; note?: string }, req: Request) {
    const t = await this.load(user, id);
    const note = dto.note?.trim() || null;
    const student = (await this.students([t.studentId])).get(t.studentId);
    const name = student?.fullName ?? 'the student';
    const campuses = await this.prisma.campus.findMany({ where: { id: { in: [t.fromCampusId, t.toCampusId] } }, select: { id: true, name: true } });
    const from = campuses.find((c) => c.id === t.fromCampusId)?.name ?? 'the current campus';
    const to = campuses.find((c) => c.id === t.toCampusId)?.name ?? 'the new campus';
    const now = new Date();

    if (dto.action === 'review') {
      if (t.status !== 'Submitted') throw badRequest(`This transfer is ${t.status.toLowerCase()}; only new requests can be put under review`);
      const r = await this.prisma.groupTransfer.updateMany({ where: { id, status: 'Submitted' }, data: { status: 'Under Review', reviewStartedAt: now, reviewedById: user.id } });
      if (!r.count) throw conflict('This transfer was changed by someone else. Refresh and try again.');
      await this.audit.record({ user, action: 'update', module: 'group', entityType: ENTITY, entityId: id, campusId: t.fromCampusId, req, description: `Started review of the transfer of ${name} to ${to}` });
      return { id, status: 'Under Review', message: 'Review started' as string };
    }

    if (dto.action === 'approve') {
      if (!['Submitted', 'Under Review'].includes(t.status)) throw badRequest(`This transfer is ${t.status.toLowerCase()} and cannot be approved`);
      const r = await this.prisma.groupTransfer.updateMany({
        where: { id, status: { in: ['Submitted', 'Under Review'] } },
        data: { status: 'Approved', decidedAt: now, decidedById: user.id, decidedByName: user.fullName, decisionNote: note },
      });
      if (!r.count) throw conflict('This transfer was changed by someone else. Refresh and try again.');
      await this.notifications.completeTasksFor(ENTITY, id);
      await this.audit.record({
        user, action: 'approve', module: 'group', entityType: ENTITY, entityId: id, campusId: t.fromCampusId, req,
        description: `Approved the transfer of ${name} from ${from} to ${to}${note ? ` — ${note}` : ''}`,
      });
      await this.tell(t, user, { category: 'Information', title: `Transfer approved — ${name}`, body: `From ${from} to ${to}. Complete it by choosing the class ${name} joins.` }, [t.requestedById]);
      await this.tasks(t, [t.toCampusId], `Complete transfer: place ${name} in a class at ${to}`, null).catch((e) =>
        this.log.warn(`Transfer tasks failed: ${(e as Error).message}`));
      return { id, status: 'Approved', message: 'Transfer approved' };
    }

    if (dto.action === 'reject') {
      if (!TRANSFER_OPEN.includes(t.status)) throw badRequest(`This transfer is already ${t.status.toLowerCase()}`);
      if (!note) throw fieldError('note', 'Give a reason for rejecting');
      const r = await this.prisma.groupTransfer.updateMany({
        where: { id, status: { in: TRANSFER_OPEN } },
        data: { status: 'Rejected', decidedAt: now, decidedById: user.id, decidedByName: user.fullName, decisionNote: note },
      });
      if (!r.count) throw conflict('This transfer was changed by someone else. Refresh and try again.');
      await this.notifications.completeTasksFor(ENTITY, id);
      await this.audit.record({
        user, action: 'reject', module: 'group', entityType: ENTITY, entityId: id, campusId: t.fromCampusId, req,
        description: `Rejected the transfer of ${name} to ${to} — ${note}`,
      });
      await this.tell(t, user, { category: 'Attention', title: `Transfer rejected — ${name}`, body: `${name} stays at ${from}. ${note}` }, [t.requestedById]);
      return { id, status: 'Rejected', message: 'Transfer rejected' };
    }

    throw fieldError('action', 'Choose approve, reject or review');
  }

  async complete(user: AuthUser, id: string, dto: { sectionId: string; note?: string }, req: Request) {
    const t = await this.load(user, id);
    if (t.status !== 'Approved') throw badRequest(t.status === 'Completed' ? 'This transfer is already completed' : 'Only approved transfers can be completed');
    uuidOr404(dto.sectionId, 'Class');
    const section = await this.prisma.section.findUnique({ where: { id: dto.sectionId }, select: { id: true, name: true, campusId: true, capacity: true, classTeacherId: true, class: { select: { name: true } } } });
    if (!section || section.campusId !== t.toCampusId) throw fieldError('sectionId', 'Choose a class at the destination campus');
    const enrolled = await this.prisma.student.count({ where: { sectionId: section.id, status: 'active' } });
    if (enrolled >= section.capacity) throw fieldError('sectionId', `${section.class.name}${section.name} is full (${enrolled}/${section.capacity}). Choose another class or raise its capacity in School Setup.`);
    const student = (await this.students([t.studentId])).get(t.studentId);
    if (!student) throw notFound('Student');
    if (student.status !== 'active') throw badRequest(`${student.fullName} is no longer on roll`);
    const campuses = await this.prisma.campus.findMany({ where: { id: { in: [t.fromCampusId, t.toCampusId] } }, select: { id: true, name: true } });
    const from = campuses.find((c) => c.id === student.campusId)?.name ?? student.campus.name;
    const to = campuses.find((c) => c.id === t.toCampusId)?.name ?? 'the new campus';
    const note = dto.note?.trim() || null;
    const now = new Date();
    const fromClass = student.section ? `${student.section.class.name}${student.section.name}` : null;
    const toClass = `${section.class.name}${section.name}`;

    let removedRoute: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.groupTransfer.updateMany({
        where: { id, status: 'Approved' },
        data: {
          status: 'Completed', completedAt: now, completedById: user.id, completedByName: user.fullName, toSectionId: section.id,
          ...(note ? { decisionNote: t.decisionNote ? `${t.decisionNote}\n${note}` : note } : {}),
        },
      });
      if (!r.count) throw conflict('This transfer was changed by someone else. Refresh and try again.');
      await tx.student.update({ where: { id: student.id }, data: { campusId: t.toCampusId, sectionId: section.id, rollNo: null } });
      // Bus routes belong to a campus: a seat on the old campus's bus does not move with the student.
      const ride = await tx.studentTransport.findUnique({ where: { studentId: student.id }, select: { route: { select: { code: true, campusId: true } } } });
      if (ride && ride.route.campusId !== t.toCampusId) {
        await tx.studentTransport.delete({ where: { studentId: student.id } });
        removedRoute = ride.route.code;
      }
      // The student's own portal account follows the student.
      await tx.user.updateMany({ where: { studentId: student.id }, data: { campusId: t.toCampusId } });
    });

    // Parent accounts follow when every child on roll is now at the new campus.
    try {
      const links = await this.prisma.studentGuardian.findMany({ where: { studentId: student.id }, select: { guardianId: true } });
      for (const l of links) {
        const kids = await this.prisma.studentGuardian.findMany({ where: { guardianId: l.guardianId, student: { status: 'active' } }, select: { student: { select: { campusId: true } } } });
        if (kids.length && kids.every((k) => k.student.campusId === t.toCampusId)) {
          await this.prisma.user.updateMany({ where: { parentId: l.guardianId }, data: { campusId: t.toCampusId } });
        }
      }
    } catch (err) {
      this.log.warn(`Parent account campus not updated: ${(err as Error).message}`);
    }

    this.metrics.invalidate();
    await this.notifications.completeTasksFor(ENTITY, id);
    await this.audit.record({
      user, action: 'update', module: 'group', entityType: ENTITY, entityId: id, campusId: t.toCampusId, req,
      description: `Completed the transfer of ${student.fullName} (${student.admissionNo}) from ${from}${fromClass ? ` ${fromClass}` : ''} to ${to} ${toClass}${removedRoute ? ` · removed from route ${removedRoute}` : ''}`,
      metadata: { from: `${from}${fromClass ? ` · ${fromClass}` : ''}`, to: `${to} · ${toClass}` },
    });
    await this.audit.record({
      user, action: 'update', module: 'students', entityType: 'student', entityId: student.id, campusId: t.toCampusId, req,
      description: `Moved ${student.fullName} to ${to} (${toClass}) by inter-campus transfer`,
      metadata: { from, to },
    });
    const teacher = section.classTeacherId
      ? await this.prisma.user.findFirst({ where: { employeeId: section.classTeacherId, status: 'active' }, select: { id: true } })
      : null;
    await this.tell(t, user, {
      category: 'Completed', title: `Transfer completed — ${student.fullName}`,
      body: `${student.fullName} has moved from ${from} to ${to} (${toClass}). The Student 360 record moved with them.`,
    }, [t.requestedById, teacher?.id]);
    await this.notifications
      .notifyGuardians(student.id, {
        category: 'Information', topic: 'system', module: 'group', campusId: t.toCampusId, route: '/parent-360',
        title: `${student.fullName} has moved to ${to}`,
        body: `${student.fullName} now belongs to ${toClass} at ${to}.${removedRoute ? ' Please arrange transport with the new campus office.' : ''}`,
      })
      .catch((e) => this.log.warn(`Guardian notification failed: ${(e as Error).message}`));
    return { id, status: 'Completed', studentId: student.id, campusId: t.toCampusId, sectionId: section.id };
  }
}
