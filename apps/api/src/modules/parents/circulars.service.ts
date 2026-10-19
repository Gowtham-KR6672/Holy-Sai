import { Injectable, Logger } from '@nestjs/common';
import type { CommCircular, Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { like, pageOf, sortBy } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AudienceService } from './audience.service';
import { CommunicationsService, FAMILY_ROUTE } from './communications.service';
import type { AckQuery, AudienceCountDto, CircularDto, CircularQuery } from './dto';
import { ParentsService } from './parents.service';
import { audienceOf, gradeOf, iso, parseAudience, todayKey, type Audience } from './parents.util';

const ACK_TASK = 'circular_ack';
const n = (v: number) => v.toLocaleString('en-IN');
const excerpt = (s: string, len = 300) => (s.length > len ? `${s.slice(0, len - 1)}…` : s);

/** Circulars: Draft → Under Review → Released (→ Withdrawn), with per-family acknowledgement. */
@Injectable()
export class CircularsService {
  private readonly log = new Logger(CircularsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly counters: CountersService,
    private readonly notifications: NotificationsService,
    private readonly audience: AudienceService,
    private readonly comms: CommunicationsService,
    private readonly parents: ParentsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------
  private async ackCounts(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.commCircularRecipient.groupBy({
      by: ['circularId'],
      where: { circularId: { in: ids }, acknowledgedAt: { not: null } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.circularId, r._count._all]));
  }

  private async rows(list: CommCircular[], liveTargets = false) {
    const campusIds = [...new Set(list.map((c) => c.campusId).filter((x): x is string => !!x))];
    const [acks, campuses] = await Promise.all([
      this.ackCounts(list.map((c) => c.id)),
      campusIds.length ? this.prisma.campus.findMany({ where: { id: { in: campusIds } }, select: { id: true, name: true } }) : [],
    ]);
    const campus = new Map(campuses.map((c) => [c.id, c.name]));
    const out = [];
    for (const c of list) {
      const audienceFilter = audienceOf(c.audience);
      let targetCount = c.targetCount;
      // Before release the reach is the audience as it stands now.
      if (liveTargets && (c.status === 'Draft' || c.status === 'Under Review')) targetCount = await this.audience.count(audienceFilter, c.campusId);
      out.push({
        id: c.id,
        reference: c.reference,
        title: c.title,
        body: c.body,
        audience: c.audienceLabel,
        audienceFilter,
        campusId: c.campusId,
        campus: c.campusId ? campus.get(c.campusId) ?? null : null,
        status: c.status,
        channels: c.channels,
        requiresAck: c.requiresAck,
        targetCount,
        ackCount: acks.get(c.id) ?? 0,
        createdBy: c.createdByName,
        createdAt: c.createdAt.toISOString(),
        submittedBy: c.submittedByName,
        submittedAt: iso(c.submittedAt),
        releasedBy: c.releasedByName,
        publishedAt: iso(c.releasedAt),
        withdrawnAt: iso(c.withdrawnAt),
        lastRemindedAt: iso(c.lastRemindedAt),
        reminderCount: c.reminderCount,
      });
    }
    return out;
  }

  private scopeWhere(user: AuthUser, campusId?: string): Prisma.CommCircularWhereInput {
    const campus = this.scope.campus(user, campusId);
    return campus ? { OR: [{ campusId: campus }, { campusId: null }] } : {};
  }

  private async load(id: string, user: AuthUser) {
    const c = await this.prisma.commCircular.findUnique({ where: { id } });
    if (!c) throw notFound('Circular');
    if (c.campusId && user.scope !== 'school' && user.campusId && user.campusId !== c.campusId) throw forbidden('This circular is for another campus');
    return c;
  }

  async get(id: string, user: AuthUser) {
    return (await this.rows([await this.load(id, user)], true))[0];
  }

  async list(user: AuthUser, q: CircularQuery) {
    const p = pageOf(q);
    const AND: Prisma.CommCircularWhereInput[] = [this.scopeWhere(user, q.campusId)];
    if (q.status) AND.push({ status: q.status });
    if (q.q?.trim()) {
      const t = q.q.trim();
      AND.push({ OR: [{ title: like(t) }, { body: like(t) }, { reference: like(t) }, { audienceLabel: like(t) }] });
    }
    const where: Prisma.CommCircularWhereInput = { AND };
    const total = await this.prisma.commCircular.count({ where });
    if (q.sort === 'ack') {
      // Acknowledgement rate is computed, so sort the (small) set in memory.
      const all = await this.prisma.commCircular.findMany({ where, select: { id: true, targetCount: true, status: true, requiresAck: true } });
      const acks = await this.ackCounts(all.map((c) => c.id));
      const rate = (c: (typeof all)[number]) => (c.status === 'Released' || c.status === 'Withdrawn') && c.requiresAck && c.targetCount ? (acks.get(c.id) ?? 0) / c.targetCount : -1;
      const dir = q.dir === 'desc' ? -1 : 1;
      const ids = all.sort((a, b) => (rate(a) - rate(b)) * dir).slice(p.skip, p.skip + p.take).map((c) => c.id);
      const page = await this.prisma.commCircular.findMany({ where: { id: { in: ids } } });
      const order = new Map(ids.map((id, i) => [id, i]));
      page.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      return paged(await this.rows(page, true), total, p);
    }
    const orderBy = sortBy<Prisma.CommCircularOrderByWithRelationInput[]>(q.sort, q.dir, {
      issued: (d) => [{ releasedAt: { sort: d, nulls: d === 'desc' ? 'first' : 'last' } }, { submittedAt: { sort: d, nulls: 'last' } }, { createdAt: d }],
      title: (d) => [{ title: d }],
      status: (d) => [{ status: d }, { createdAt: 'desc' }],
      audience: (d) => [{ audienceLabel: d }, { createdAt: 'desc' }],
    }, 'issued');
    const list = await this.prisma.commCircular.findMany({ where, orderBy, skip: p.skip, take: p.take });
    return paged(await this.rows(list, true), total, p);
  }

  async summary(user: AuthUser, campusId?: string) {
    const base = this.scopeWhere(user, campusId);
    const [drafts, underReview, released] = await Promise.all([
      this.prisma.commCircular.count({ where: { AND: [base, { status: 'Draft' }] } }),
      this.prisma.commCircular.count({ where: { AND: [base, { status: 'Under Review' }] } }),
      this.prisma.commCircular.findMany({ where: { AND: [base, { status: 'Released', requiresAck: true }] }, select: { id: true, targetCount: true } }),
    ]);
    const ids = released.map((c) => c.id);
    const targeted = released.reduce((s, c) => s + c.targetCount, 0);
    const [acknowledged, perFamily] = await Promise.all([
      ids.length ? this.prisma.commCircularRecipient.count({ where: { circularId: { in: ids }, acknowledgedAt: { not: null } } }) : 0,
      ids.length
        ? this.prisma.commCircularRecipient.groupBy({
            by: ['guardianId'],
            where: { circularId: { in: ids }, guardianId: { not: null } },
            _count: { acknowledgedAt: true },
          })
        : [],
    ]);
    return {
      drafts,
      underReview,
      circulars: released.length,
      targeted,
      acknowledged,
      outstanding: Math.max(0, targeted - acknowledged),
      rate: targeted ? Math.round((acknowledged / targeted) * 100) : null,
      neverAcknowledged: perFamily.filter((f) => f._count.acknowledgedAt === 0).length,
    };
  }

  async audienceCount(dto: AudienceCountDto) {
    const a = parseAudience(dto.audience);
    return { label: this.audience.label(a), count: await this.audience.count(a, dto.campusId ?? null) };
  }

  // ---------------------------------------------------------------------------
  // Authoring
  // ---------------------------------------------------------------------------
  private async fields(dto: CircularDto) {
    const audience = parseAudience(dto.audience, 'audience.grades');
    const campusId = dto.campusId ?? null;
    if (campusId && !(await this.prisma.campus.count({ where: { id: campusId } }))) throw fieldError('campusId', 'Choose a campus');
    const channels = dto.channels?.length ? [...new Set(dto.channels)].sort() : ['push'];
    return {
      title: dto.title,
      body: dto.body,
      audience: audience as unknown as Prisma.InputJsonValue,
      audienceLabel: this.audience.label(audience),
      campusId,
      channels,
      requiresAck: audience.kind === 'staff' ? false : dto.requiresAck ?? true,
      targetCount: await this.audience.count(audience, campusId),
    };
  }

  async create(dto: CircularDto, user: AuthUser, req: Request) {
    const data = await this.fields(dto);
    const year = todayKey().slice(0, 4);
    const reference = await this.counters.reference(`CIR-${year}`, `circulars-${year}`, 3);
    const c = await this.prisma.commCircular.create({ data: { ...data, reference, status: 'Draft', createdById: user.id, createdByName: user.fullName } });
    await this.audit.record({
      user, action: 'create', module: 'parents', entityType: 'circular', entityId: c.id,
      description: `Drafted circular ${c.reference} “${c.title}” for ${c.audienceLabel}`, req,
    });
    return ok((await this.rows([c]))[0], 'Circular saved as draft');
  }

  async update(id: string, dto: CircularDto, user: AuthUser, req: Request) {
    const existing = await this.load(id, user);
    if (existing.status !== 'Draft' && existing.status !== 'Under Review') throw badRequest(`A ${existing.status.toLowerCase()} circular cannot be edited`);
    const c = await this.prisma.commCircular.update({ where: { id }, data: await this.fields(dto) });
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'circular', entityId: id,
      description: `Edited circular ${c.reference} “${c.title}”${existing.status === 'Under Review' ? ' while under review' : ''}`, req,
    });
    return ok((await this.rows([c]))[0], 'Circular updated');
  }

  /** Users who can approve and release circulars (notifications.broadcast + communication.send). */
  private async approverIds(campusId: string | null) {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'active',
        role: {
          key: { notIn: ['parent', 'student'] },
          AND: [{ permissions: { some: { permissionKey: 'notifications.broadcast' } } }, { permissions: { some: { permissionKey: 'communication.send' } } }],
        },
        ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}),
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  async submit(id: string, user: AuthUser, req: Request) {
    const c = await this.load(id, user);
    if (c.status !== 'Draft') throw badRequest(c.status === 'Under Review' ? 'This circular is already waiting for approval' : `A ${c.status.toLowerCase()} circular cannot be sent for approval`);
    const now = new Date();
    await this.prisma.commCircular.update({ where: { id }, data: { status: 'Under Review', submittedAt: now, submittedById: user.id, submittedByName: user.fullName } });
    const route = `/circulars?circular=${id}`;
    const approvers = await this.approverIds(c.campusId);
    for (const assigneeId of approvers) {
      await this.notifications.createTask({
        title: `Approve circular: ${c.title}`, module: 'parents', assigneeId, status: 'Under Review', priority: 'Medium',
        route, entityType: 'circular', entityId: id, dueOn: todayKey(),
      });
    }
    await this.notifications.notifyUsers(approvers.filter((x) => x !== user.id), {
      category: 'Attention', topic: 'circulars', module: 'parents', title: `Circular awaiting approval: ${c.title}`,
      body: `Submitted by ${user.fullName} · ${c.audienceLabel}`, route, campusId: c.campusId,
    });
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'circular', entityId: id,
      description: `Sent circular ${c.reference} “${c.title}” for approval`, req,
    });
    return ok(await this.get(id, user), 'Circular sent for approval');
  }

  async returnToDraft(id: string, user: AuthUser, req: Request) {
    const c = await this.load(id, user);
    if (c.status !== 'Under Review') throw badRequest('Only a circular under review can be returned for changes');
    await this.prisma.commCircular.update({ where: { id }, data: { status: 'Draft', returnedAt: new Date(), returnedByName: user.fullName } });
    await this.notifications.completeTasksFor('circular', id);
    const authors = [c.createdById, c.submittedById].filter((x): x is string => !!x && x !== user.id);
    await this.notifications.notifyUsers(authors, {
      category: 'Attention', topic: 'circulars', module: 'parents', title: `Circular returned for changes: ${c.title}`,
      body: `Returned by ${user.fullName}`, route: `/circulars?circular=${id}`, campusId: c.campusId,
    });
    await this.audit.record({
      user, action: 'reject', module: 'parents', entityType: 'circular', entityId: id,
      description: `Returned circular ${c.reference} “${c.title}” to draft`, req,
    });
    return ok(await this.get(id, user), 'Circular returned to draft');
  }

  async release(id: string, user: AuthUser, req: Request) {
    const c = await this.load(id, user);
    if (c.status !== 'Under Review') throw badRequest(c.status === 'Draft' ? 'Send the circular for approval before releasing it' : `This circular is already ${c.status.toLowerCase()}`);
    const audience = audienceOf(c.audience);
    const staff = audience.kind === 'staff';
    const families = staff ? new Map<string, string[]>() : await this.audience.families(audience, c.campusId);
    const staffIds = staff ? await this.audience.staffUserIds(c.campusId) : [];
    const count = staff ? staffIds.length : families.size;
    if (!count) throw badRequest('Nobody is in this audience yet, so there is no one to send the circular to. Check the audience and campus.');
    const now = new Date();
    const recipients: Prisma.CommCircularRecipientCreateManyInput[] = staff
      ? staffIds.map((userId) => ({ circularId: id, userId, studentIds: [] }))
      : [...families].map(([guardianId, studentIds]) => ({ circularId: id, guardianId, studentIds }));
    await this.prisma.$transaction([
      this.prisma.commCircularRecipient.createMany({ data: recipients, skipDuplicates: true }),
      this.prisma.commCircular.update({
        where: { id },
        data: { status: 'Released', releasedAt: now, releasedById: user.id, releasedByName: user.fullName, targetCount: count },
      }),
    ]);
    await this.notifications.completeTasksFor('circular', id);

    if (staff) {
      await this.audience.reachStaff(staffIds, {
        category: 'Information', topic: 'circulars', title: c.title, body: excerpt(c.body), route: `/circulars?circular=${id}`, campusId: c.campusId,
      });
    } else {
      const guardianIds = [...families.keys()];
      await this.audience.reachFamilies(guardianIds, {
        category: c.requiresAck ? 'Attention' : 'Information',
        topic: 'circulars',
        title: c.title,
        body: `${excerpt(c.body)}${c.requiresAck ? '\nPlease acknowledge it in the parent app.' : ''}`,
        route: FAMILY_ROUTE,
        campusId: c.campusId,
        channels: c.channels,
      }, { entityType: 'circular', entityId: id });
      if (c.requiresAck) void this.ackTasks(c, guardianIds).catch((e) => this.log.warn(`Acknowledgement tasks failed: ${(e as Error).message}`));
      await this.comms.recordBroadcast({
        channels: c.channels, counterpart: c.audienceLabel, subject: `Circular: ${c.title}`, body: c.body, recipients: count,
        campusId: c.campusId, entityType: 'circular', entityId: id, user,
      });
    }
    const authors = [...new Set([c.createdById, c.submittedById])].filter((x): x is string => !!x && x !== user.id);
    await this.notifications.notifyUsers(authors, {
      category: 'Completed', topic: 'circulars', module: 'parents', title: `Circular released: ${c.title}`,
      body: `Released by ${user.fullName} to ${n(count)} ${staff ? 'staff' : 'families'}`, route: `/circulars?circular=${id}`, campusId: c.campusId,
    });
    await this.audit.record({
      user, action: 'publish', module: 'parents', entityType: 'circular', entityId: id,
      description: `Approved and released circular ${c.reference} “${c.title}” to ${c.audienceLabel} (${count} ${staff ? 'staff' : 'families'})`, req,
    });
    return ok(await this.get(id, user), `Circular released to ${n(count)} ${staff ? 'staff' : count === 1 ? 'family' : 'families'}`);
  }

  /** "Acknowledge circular" tasks for parent accounts, completed when the family acknowledges. */
  private async ackTasks(c: CommCircular, guardianIds: string[]) {
    const users = await this.prisma.user.findMany({ where: { parentId: { in: guardianIds }, status: 'active' }, select: { id: true, parentId: true } });
    if (!users.length) return;
    const row = await this.prisma.counter.upsert({ where: { key: 'tasks' }, create: { key: 'tasks', value: users.length }, update: { value: { increment: users.length } } });
    const first = row.value - users.length + 1;
    await this.prisma.task.createMany({
      data: users.map((u, i) => ({
        code: `T-${first + i}`,
        title: `Acknowledge circular: ${c.title}`,
        module: 'parents',
        assigneeId: u.id,
        priority: 'Medium',
        status: 'Pending',
        route: FAMILY_ROUTE,
        entityType: ACK_TASK,
        entityId: `${c.id}/${u.parentId}`,
      })),
      skipDuplicates: true,
    });
  }

  async withdraw(id: string, user: AuthUser, req: Request) {
    const c = await this.load(id, user);
    if (c.status !== 'Released') throw badRequest('Only a released circular can be withdrawn');
    await this.prisma.commCircular.update({ where: { id }, data: { status: 'Withdrawn', withdrawnAt: new Date(), withdrawnByName: user.fullName } });
    await this.prisma.task.updateMany({
      where: { entityType: ACK_TASK, entityId: { startsWith: `${id}/` }, status: { not: 'Completed' } },
      data: { status: 'Completed', completedAt: new Date() },
    });
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'circular', entityId: id,
      description: `Withdrew circular ${c.reference} “${c.title}”`, req,
    });
    return ok(await this.get(id, user), 'Circular withdrawn');
  }

  /** Chases families who have not acknowledged: app notification, plus WhatsApp when the circular used it. */
  async remind(id: string, user: AuthUser, req: Request) {
    const c = await this.load(id, user);
    if (c.status !== 'Released') throw badRequest('Reminders can only be sent for a released circular');
    if (!c.requiresAck) throw badRequest('This circular does not ask families to acknowledge');
    const pending = await this.prisma.commCircularRecipient.findMany({
      where: { circularId: id, guardianId: { not: null }, acknowledgedAt: null },
      select: { id: true, guardianId: true },
    });
    if (!pending.length) throw badRequest('Every family has already acknowledged this circular');
    const guardianIds = pending.map((p) => p.guardianId!);
    const now = new Date();
    const channels = ['push', ...(c.channels.includes('whatsapp') ? ['whatsapp'] : [])];
    const reach = await this.audience.reachFamilies(guardianIds, {
      category: 'Attention',
      topic: 'circulars',
      title: `Reminder: ${c.title}`,
      body: 'Please read this circular and acknowledge it in the parent app.',
      route: FAMILY_ROUTE,
      campusId: c.campusId,
      channels,
    }, { entityType: 'circular', entityId: id });
    await this.prisma.$transaction([
      this.prisma.commCircularRecipient.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { lastRemindedAt: now } }),
      this.prisma.commCircular.update({ where: { id }, data: { lastRemindedAt: now, reminderCount: { increment: 1 } } }),
      // Needing a chase counts against engagement (never below 0).
      this.prisma.guardian.updateMany({ where: { id: { in: guardianIds }, engagementScore: { gt: 0 } }, data: { engagementScore: { decrement: 1 } } }),
    ]);
    await this.comms.recordBroadcast({
      channels, counterpart: `${c.audienceLabel} · not yet acknowledged`, subject: `Reminder: ${c.title}`,
      body: 'Please read this circular and acknowledge it in the parent app.', recipients: pending.length,
      campusId: c.campusId, entityType: 'circular', entityId: id, user,
    });
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'circular', entityId: id,
      description: `Sent an acknowledgement reminder for ${c.reference} “${c.title}” to ${pending.length} families`, req,
    });
    const noApp = guardianIds.length - reach.app;
    return ok(
      await this.get(id, user),
      `Reminder sent to ${n(pending.length)} ${pending.length === 1 ? 'family' : 'families'}${noApp > 0 ? ` · ${n(noApp)} without the app to call` : ''}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Acknowledgements
  // ---------------------------------------------------------------------------
  async acknowledgements(id: string, q: AckQuery, user: AuthUser) {
    const c = await this.load(id, user);
    const p = pageOf(q, 10);
    const state = q.state ?? 'pending';
    const recs = await this.prisma.commCircularRecipient.findMany({
      where: { circularId: c.id, guardianId: { not: null }, acknowledgedAt: state === 'pending' ? null : { not: null } },
      select: { guardianId: true, studentIds: true, acknowledgedAt: true },
    });
    const guardians = await this.prisma.guardian.findMany({
      where: {
        id: { in: recs.map((r) => r.guardianId!) },
        ...(q.q?.trim() ? { OR: [{ fullName: like(q.q.trim()) }, { phone: like(q.q.trim()) }] } : {}),
      },
      select: { id: true, fullName: true, phone: true, engagementScore: true },
    });
    const byId = new Map(guardians.map((g) => [g.id, g]));
    const rows = recs.filter((r) => byId.has(r.guardianId!));
    rows.sort((a, b) =>
      state === 'acknowledged'
        ? b.acknowledgedAt!.getTime() - a.acknowledgedAt!.getTime()
        : byId.get(a.guardianId!)!.fullName.localeCompare(byId.get(b.guardianId!)!.fullName),
    );
    const page = rows.slice(p.skip, p.skip + p.take);
    const ids = page.map((r) => r.guardianId!);
    const [app, students] = await Promise.all([
      this.parents.appSet(ids),
      this.prisma.student.findMany({
        where: { id: { in: [...new Set(page.flatMap((r) => r.studentIds))] } },
        select: { id: true, fullName: true, section: { select: { name: true, class: { select: { name: true } } } } },
      }),
    ]);
    const s = new Map(students.map((x) => [x.id, x]));
    return paged(
      page.map((r) => {
        const g = byId.get(r.guardianId!)!;
        return {
          parentId: g.id,
          parentName: g.fullName,
          phone: g.phone,
          engagement: g.engagementScore,
          hasAppAccount: app.has(g.id),
          children: r.studentIds.map((sid) => s.get(sid)).filter((x) => !!x).map((x) => ({ id: x!.id, fullName: x!.fullName, grade: gradeOf(x!.section) })),
          acknowledgedAt: iso(r.acknowledgedAt),
        };
      }),
      rows.length,
      p,
    );
  }

  // ---------------------------------------------------------------------------
  // Family side (used by the family portal module for /family/circulars)
  // ---------------------------------------------------------------------------
  /** Released circulars sent to the signed-in parent's family. */
  async familyList(user: AuthUser) {
    if (!user.parentId) return [];
    const recs = await this.prisma.commCircularRecipient.findMany({
      where: { guardianId: user.parentId, circular: { status: 'Released' } },
      include: { circular: true },
      orderBy: { circular: { releasedAt: 'desc' } },
      take: 100,
    });
    return recs.map((r) => ({
      id: r.circular.id,
      title: r.circular.title,
      publishedAt: iso(r.circular.releasedAt)!,
      audience: r.circular.audienceLabel,
      requiresAck: r.circular.requiresAck,
      acknowledged: !!r.acknowledgedAt,
      body: r.circular.body,
    }));
  }

  /** A family acknowledges a circular; counts towards engagement and closes their acknowledgement task. */
  async acknowledge(user: AuthUser, circularId: string) {
    if (!user.parentId) throw forbidden('Only parent accounts can acknowledge circulars');
    const rec = await this.prisma.commCircularRecipient.findUnique({
      where: { circularId_guardianId: { circularId, guardianId: user.parentId } },
      include: { circular: true },
    });
    if (!rec || rec.circular.status !== 'Released') throw notFound('Circular');
    if (!rec.circular.requiresAck) throw badRequest('This circular does not need an acknowledgement');
    if (!rec.acknowledgedAt) {
      await this.prisma.commCircularRecipient.update({ where: { id: rec.id }, data: { acknowledgedAt: new Date(), acknowledgedById: user.id } });
      await this.parents.touch(user.parentId, { delta: 2 });
      await this.notifications.completeTasksFor(ACK_TASK, `${circularId}/${user.parentId}`);
    }
    return { id: circularId, acknowledged: true };
  }

  /** The audience shape stored on a circular (exposed for other modules). */
  audienceOf(c: CommCircular): Audience {
    return audienceOf(c.audience);
  }
}
