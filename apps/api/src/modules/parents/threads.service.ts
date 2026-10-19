import { Injectable } from '@nestjs/common';
import type { CommThread, Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { ok, paged } from '../../common/envelope';
import { badRequest, forbidden, notFound } from '../../common/errors';
import { like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommunicationsService, FAMILY_ROUTE } from './communications.service';
import type { ThreadQuery } from './dto';
import { ParentsService } from './parents.service';
import { daysAgo, gradeOf } from './parents.util';

interface ThreadCore {
  id: string;
  guardianId: string;
  studentId: string | null;
  subject: string;
  status: string;
  awaitingReply: boolean;
  lastMessageAt: Date;
  lastParentMessageAt: Date | null;
  readAt: Date | null;
  messageCount: number;
}

const unreadFor = (lastFromOtherSide: Date | null, readAt: Date | null) => !!lastFromOtherSide && (!readAt || readAt < lastFromOtherSide);

/** Parent-app conversations between families and school staff. */
@Injectable()
export class ThreadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly parents: ParentsService,
    private readonly comms: CommunicationsService,
  ) {}

  private async where(user: AuthUser, campusId?: string): Promise<Prisma.CommThreadWhereInput> {
    if (user.scope === 'school') {
      const campus = this.scope.campus(user, campusId);
      return campus ? { OR: [{ campusId: campus }, { campusId: null }] } : {};
    }
    const limit = (await this.parents.familyLimit(user)) ?? [];
    return { OR: [{ participants: { some: { userId: user.id } } }, { guardianId: { in: limit } }] };
  }

  private async assertAccess(user: AuthUser, t: CommThread) {
    const n = await this.prisma.commThread.count({ where: { AND: [await this.where(user), { id: t.id }] } });
    if (!n) throw forbidden('This conversation is outside your access');
  }

  private async rows(list: ThreadCore[]) {
    const gIds = [...new Set(list.map((t) => t.guardianId))];
    const sIds = [...new Set(list.map((t) => t.studentId).filter((x): x is string => !!x))];
    const [guardians, students] = await Promise.all([
      this.prisma.guardian.findMany({ where: { id: { in: gIds } }, select: { id: true, fullName: true } }),
      sIds.length
        ? this.prisma.student.findMany({ where: { id: { in: sIds } }, select: { id: true, fullName: true, section: { select: { name: true, class: { select: { name: true } } } } } })
        : [],
    ]);
    const g = new Map(guardians.map((x) => [x.id, x.fullName]));
    const s = new Map(students.map((x) => [x.id, x]));
    return list.map((t) => {
      const st = t.studentId ? s.get(t.studentId) : undefined;
      return {
        id: t.id,
        parentId: t.guardianId,
        parentName: g.get(t.guardianId) ?? null,
        studentId: t.studentId,
        studentName: st?.fullName ?? null,
        grade: gradeOf(st?.section),
        subject: t.subject,
        status: t.status,
        awaitingReply: t.awaitingReply,
        unread: unreadFor(t.lastParentMessageAt, t.readAt),
        lastMessageAt: t.lastMessageAt.toISOString(),
        messageCount: t.messageCount,
      };
    });
  }

  async list(user: AuthUser, q: ThreadQuery) {
    const p = pageOf(q, 50);
    const AND: Prisma.CommThreadWhereInput[] = [await this.where(user, q.campusId)];
    if (q.status) AND.push({ status: q.status });
    if (q.q?.trim()) {
      const t = q.q.trim();
      const g = await this.prisma.guardian.findMany({ where: { fullName: like(t) }, select: { id: true }, take: 200 });
      AND.push({ OR: [{ subject: like(t) }, { guardianId: { in: g.map((x) => x.id) } }] });
    }
    const where: Prisma.CommThreadWhereInput = { AND };
    const [list, total] = await Promise.all([
      this.prisma.commThread.findMany({
        where,
        orderBy: [{ awaitingReply: 'desc' }, { lastMessageAt: 'desc' }],
        skip: p.skip,
        take: p.take,
        include: { reads: { where: { userId: user.id } }, _count: { select: { messages: true } } },
      }),
      this.prisma.commThread.count({ where }),
    ]);
    const rows = await this.rows(list.map((t) => ({ ...t, readAt: t.reads[0]?.readAt ?? null, messageCount: t._count.messages })));
    return paged(rows, total, p);
  }

  /** Conversations with a family message this user has not opened yet. */
  async unreadCount(user: AuthUser, campusId?: string) {
    const rows = await this.prisma.commThread.findMany({
      where: { AND: [await this.where(user, campusId), { lastParentMessageAt: { gte: daysAgo(180) } }] },
      select: { lastParentMessageAt: true, reads: { where: { userId: user.id }, select: { readAt: true } } },
    });
    return rows.filter((t) => unreadFor(t.lastParentMessageAt, t.reads[0]?.readAt ?? null)).length;
  }

  /** The conversation with its messages; opening it marks it read for this user. */
  async detail(id: string, user: AuthUser) {
    const t = await this.prisma.commThread.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } }, participants: { orderBy: { addedAt: 'asc' } } },
    });
    if (!t) throw notFound('Conversation');
    await this.assertAccess(user, t);
    const now = new Date();
    await this.prisma.commThreadRead.upsert({
      where: { threadId_userId: { threadId: id, userId: user.id } },
      create: { threadId: id, userId: user.id, readAt: now },
      update: { readAt: now },
    });
    const [row] = await this.rows([{ ...t, readAt: now, messageCount: t.messages.length }]);
    return {
      ...row,
      participants: t.participants.map((p) => ({ userId: p.userId, name: p.name, role: p.role })),
      messages: t.messages.map((m) => ({
        id: m.id,
        body: m.body,
        senderName: m.senderName,
        senderRole: m.senderRole,
        mine: m.senderUserId === user.id,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async reply(id: string, body: string, user: AuthUser, req: Request) {
    const t = await this.prisma.commThread.findUnique({ where: { id } });
    if (!t) throw notFound('Conversation');
    await this.assertAccess(user, t);
    const [guardian, parentUsers] = await Promise.all([
      this.prisma.guardian.findUnique({ where: { id: t.guardianId }, select: { fullName: true } }),
      this.prisma.user.findMany({ where: { parentId: t.guardianId, status: 'active' }, select: { id: true } }),
    ]);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.commThreadMessage.create({ data: { threadId: id, senderUserId: user.id, senderRole: user.roleKey, senderName: user.fullName, body, createdAt: now } }),
      this.prisma.commThread.update({
        where: { id },
        data: { status: 'Open', closedAt: null, closedById: null, awaitingReply: false, lastMessageAt: now, lastStaffMessageAt: now },
      }),
      this.prisma.commThreadParticipant.upsert({
        where: { threadId_userId: { threadId: id, userId: user.id } },
        create: { threadId: id, userId: user.id, role: user.roleKey, name: user.fullName },
        update: {},
      }),
      this.prisma.commThreadRead.upsert({
        where: { threadId_userId: { threadId: id, userId: user.id } },
        create: { threadId: id, userId: user.id, readAt: now },
        update: { readAt: now },
      }),
      this.prisma.commMessage.updateMany({
        where: { threadId: id, needsReply: true },
        data: { needsReply: false, status: 'Replied', repliedById: user.id, repliedByName: user.fullName, repliedAt: now },
      }),
      this.prisma.commMessage.create({
        data: {
          guardianId: t.guardianId,
          studentId: t.studentId,
          campusId: t.campusId,
          channel: 'In-app',
          direction: 'outbound',
          counterpart: guardian?.fullName ?? 'Family',
          subject: t.subject.startsWith('Re: ') ? t.subject : `Re: ${t.subject}`,
          body,
          status: parentUsers.length ? 'Delivered in app' : 'Not delivered',
          occurredAt: now,
          threadId: id,
          sentById: user.id,
          sentByName: user.fullName,
        },
      }),
    ]);
    await this.notifications.notifyUsers(parentUsers.map((u) => u.id), {
      category: 'Information',
      topic: 'messages',
      module: 'parents',
      title: `${user.fullName} replied: ${t.subject}`,
      body: body.length > 200 ? `${body.slice(0, 199)}…` : body,
      route: FAMILY_ROUTE,
      deliver: true,
    });
    await this.parents.touch(t.guardianId, parentUsers.length ? { channel: 'In-app' } : {});
    await this.audit.record({
      user, action: 'create', module: 'parents', entityType: 'thread', entityId: id,
      description: `Replied to ${guardian?.fullName ?? 'a family'} in “${t.subject}”`, req,
    });
    return ok({ id }, 'Reply sent');
  }

  async setStatus(id: string, action: 'close' | 'reopen', user: AuthUser, req: Request) {
    const t = await this.prisma.commThread.findUnique({ where: { id } });
    if (!t) throw notFound('Conversation');
    await this.assertAccess(user, t);
    const now = new Date();
    if (action === 'close') {
      if (t.status === 'Closed') throw badRequest('This conversation is already closed');
      await this.prisma.$transaction([
        this.prisma.commThread.update({ where: { id }, data: { status: 'Closed', closedAt: now, closedById: user.id, awaitingReply: false } }),
        // Closing answers anything still waiting in the queue for this conversation.
        this.prisma.commMessage.updateMany({
          where: { threadId: id, needsReply: true },
          data: { needsReply: false, status: 'Closed', repliedById: user.id, repliedByName: user.fullName, repliedAt: now },
        }),
      ]);
    } else {
      if (t.status === 'Open') throw badRequest('This conversation is already open');
      await this.prisma.commThread.update({ where: { id }, data: { status: 'Open', closedAt: null, closedById: null } });
    }
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'thread', entityId: id,
      description: `${action === 'close' ? 'Closed' : 'Reopened'} the conversation “${t.subject}”`, req,
    });
    return ok({ id, status: action === 'close' ? 'Closed' : 'Open' }, action === 'close' ? 'Conversation closed' : 'Conversation reopened');
  }

  // ---------------------------------------------------------------------------
  // Family side (used by the family portal module for /family/messages)
  // ---------------------------------------------------------------------------
  /** The signed-in parent's conversations: { id, subject, lastMessageAt, status, studentName, unread }. */
  async familyThreads(user: AuthUser) {
    if (!user.parentId) return [];
    const list = await this.prisma.commThread.findMany({
      where: { guardianId: user.parentId },
      orderBy: { lastMessageAt: 'desc' },
      include: { reads: { where: { userId: user.id } } },
      take: 100,
    });
    const sIds = [...new Set(list.map((t) => t.studentId).filter((x): x is string => !!x))];
    const students = sIds.length ? await this.prisma.student.findMany({ where: { id: { in: sIds } }, select: { id: true, fullName: true } }) : [];
    const s = new Map(students.map((x) => [x.id, x.fullName]));
    return list.map((t) => ({
      id: t.id,
      subject: t.subject,
      lastMessageAt: t.lastMessageAt.toISOString(),
      status: t.status,
      studentName: t.studentId ? s.get(t.studentId) ?? null : null,
      unread: unreadFor(t.lastStaffMessageAt, t.reads[0]?.readAt ?? null),
    }));
  }

  /**
   * A parent writes to the school from the app: starts a conversation with the child's class teacher (or adds to
   * an existing one), puts it in the staff's unanswered queue and notifies the teacher.
   */
  async postFromFamily(user: AuthUser, input: { studentId: string; subject: string; body: string; threadId?: string }) {
    if (!user.parentId) throw forbidden('Only parent accounts can send family messages');
    const guardianId = user.parentId;
    const link = await this.prisma.studentGuardian.findUnique({ where: { studentId_guardianId: { studentId: input.studentId, guardianId } } });
    if (!link) throw forbidden('This child is not linked to your account');
    const student = await this.prisma.student.findUnique({ where: { id: input.studentId }, include: { section: true } });
    if (!student) throw notFound('Student');
    const now = new Date();
    let thread: CommThread | null = null;
    if (input.threadId) {
      thread = await this.prisma.commThread.findFirst({ where: { id: input.threadId, guardianId } });
      if (!thread) throw notFound('Conversation');
    } else {
      const teacher = student.section.classTeacherId
        ? await this.prisma.user.findFirst({ where: { employeeId: student.section.classTeacherId, status: 'active' }, include: { role: true } })
        : null;
      thread = await this.prisma.commThread.create({
        data: {
          guardianId,
          studentId: student.id,
          campusId: student.campusId,
          subject: input.subject,
          participants: {
            create: [
              { userId: user.id, role: 'parent', name: user.fullName },
              ...(teacher ? [{ userId: teacher.id, role: teacher.role.key, name: teacher.fullName }] : []),
            ],
          },
        },
      });
    }
    await this.prisma.$transaction([
      this.prisma.commThreadMessage.create({ data: { threadId: thread.id, senderUserId: user.id, senderRole: 'parent', senderName: user.fullName, body: input.body, createdAt: now } }),
      this.prisma.commThread.update({
        where: { id: thread.id },
        data: { status: 'Open', closedAt: null, awaitingReply: true, lastMessageAt: now, lastParentMessageAt: now },
      }),
      this.prisma.commThreadRead.upsert({
        where: { threadId_userId: { threadId: thread.id, userId: user.id } },
        create: { threadId: thread.id, userId: user.id, readAt: now },
        update: { readAt: now },
      }),
    ]);
    await this.comms.recordInbound({
      guardianId, studentId: student.id, channel: 'In-app', subject: thread.subject, body: input.body, threadId: thread.id,
    });
    const staff = await this.prisma.commThreadParticipant.findMany({ where: { threadId: thread.id, role: { not: 'parent' } }, select: { userId: true } });
    const note = {
      category: 'Attention' as const,
      topic: 'messages',
      module: 'parents',
      title: `New message from ${user.fullName}`,
      body: `${student.fullName}: ${thread.subject}`,
      route: `/parent-communication?thread=${thread.id}`,
      campusId: student.campusId,
    };
    if (staff.length) await this.notifications.notifyUsers(staff.map((s) => s.userId), note);
    else await this.notifications.notifyPermission('communication.send', note);
    return { id: thread.id, subject: thread.subject, lastMessageAt: now.toISOString(), status: 'Open', studentName: student.fullName, unread: false };
  }
}
