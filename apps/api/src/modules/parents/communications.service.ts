import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { CommMessage, Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { like, pageOf, sortBy } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { MessagingService, type SendResult } from '../integrations/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { CommQuery, LogInteractionDto, SendMessageDto } from './dto';
import { ParentsService } from './parents.service';
import { daysAgo, gradeOf, hoursSince, iso, REPLY_SLA_HOURS, startOfToday } from './parents.util';

/** The parent-app route families land on for messages, circulars and PTM. */
export const FAMILY_ROUTE = '/parent-360?tab=more';

/** Engagement points for each kind of interaction. */
const POINTS = { inbound: 3, callConnected: 2, callInbound: 3, callMissed: -1 } as const;

const excerpt = (s: string, n = 280) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The family communication log: one history per family across WhatsApp, SMS, email, calls, notes and the
 * parent app, the unanswered queue (24-hour SLA), outbound messages through MessagingService, and broadcasts.
 */
@Injectable()
export class CommunicationsService {
  private readonly log = new Logger(CommunicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly messaging: MessagingService,
    private readonly notifications: NotificationsService,
    private readonly parents: ParentsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------
  async hydrate(rows: CommMessage[]) {
    const gIds = [...new Set(rows.map((r) => r.guardianId).filter((x): x is string => !!x))];
    const sIds = [...new Set(rows.map((r) => r.studentId).filter((x): x is string => !!x))];
    const [guardians, app, students] = await Promise.all([
      gIds.length ? this.prisma.guardian.findMany({ where: { id: { in: gIds } }, select: { id: true, fullName: true, phone: true } }) : [],
      gIds.length ? this.parents.appSet(gIds) : new Set<string>(),
      sIds.length
        ? this.prisma.student.findMany({ where: { id: { in: sIds } }, select: { id: true, fullName: true, section: { select: { name: true, class: { select: { name: true } } } } } })
        : [],
    ]);
    const g = new Map(guardians.map((x) => [x.id, x]));
    const s = new Map(students.map((x) => [x.id, x]));
    return rows.map((m) => {
      const parent = m.guardianId ? g.get(m.guardianId) : undefined;
      const student = m.studentId ? s.get(m.studentId) : undefined;
      return {
        id: m.id,
        channel: m.channel,
        direction: m.direction,
        subject: m.subject,
        body: m.body,
        status: m.status,
        needsReply: m.needsReply,
        ageHours: m.needsReply ? hoursSince(m.occurredAt) : null,
        occurredAt: m.occurredAt.toISOString(),
        parentId: m.guardianId,
        parentName: parent?.fullName ?? null,
        parentPhone: parent?.phone ?? null,
        parentHasApp: m.guardianId ? app.has(m.guardianId) : false,
        counterpart: parent?.fullName ?? m.counterpart,
        recipients: m.recipients,
        studentId: m.studentId,
        studentName: student?.fullName ?? null,
        grade: gradeOf(student?.section),
        sentBy: m.sentByName,
        repliedBy: m.repliedByName,
        repliedAt: iso(m.repliedAt),
        replyToId: m.replyToId,
        threadId: m.threadId,
      };
    });
  }

  async one(id: string) {
    const m = await this.prisma.commMessage.findUnique({ where: { id } });
    if (!m) throw notFound('Message');
    return (await this.hydrate([m]))[0];
  }

  /** What the user may see: the header campus (plus school-wide items) and, for teachers, their families. */
  private async scopeWhere(user: AuthUser, campusId?: string, forParent?: boolean): Promise<Prisma.CommMessageWhereInput> {
    const AND: Prisma.CommMessageWhereInput[] = [];
    if (!forParent) {
      const campus = this.scope.campus(user, campusId);
      if (campus) AND.push({ OR: [{ campusId: campus }, { campusId: null }] });
    }
    const limit = await this.parents.familyLimit(user);
    if (limit) AND.push({ OR: [{ guardianId: { in: limit } }, { sentById: user.id }] });
    return { AND };
  }

  // ---------------------------------------------------------------------------
  // Lists
  // ---------------------------------------------------------------------------
  async list(user: AuthUser, q: CommQuery) {
    const p = pageOf(q);
    const AND: Prisma.CommMessageWhereInput[] = [await this.scopeWhere(user, q.campusId, !!q.parentId)];
    if (q.parentId) AND.push({ guardianId: q.parentId });
    if (q.studentId) AND.push({ studentId: q.studentId });
    if (q.channel) AND.push({ channel: q.channel });
    if (q.direction) AND.push({ direction: q.direction });
    if (q.needsReply !== undefined) AND.push({ needsReply: q.needsReply });
    if (q.q?.trim()) {
      const t = q.q.trim();
      AND.push({ OR: [{ subject: like(t) }, { body: like(t) }, { counterpart: like(t) }] });
    }
    const where: Prisma.CommMessageWhereInput = { AND };
    const orderBy = sortBy<Prisma.CommMessageOrderByWithRelationInput[]>(q.sort, q.dir, {
      occurredAt: (d) => [{ occurredAt: d }],
      channel: (d) => [{ channel: d }, { occurredAt: 'desc' }],
      parent: (d) => [{ counterpart: d }, { occurredAt: 'desc' }],
      subject: (d) => [{ subject: d }, { occurredAt: 'desc' }],
      status: (d) => [{ needsReply: d === 'asc' ? 'desc' : 'asc' }, { status: d }, { occurredAt: 'desc' }],
    }, 'occurredAt');
    const [rows, total] = await Promise.all([
      this.prisma.commMessage.findMany({ where, orderBy, skip: p.skip, take: p.take }),
      this.prisma.commMessage.count({ where }),
    ]);
    return paged(await this.hydrate(rows), total, p);
  }

  async summary(user: AuthUser, campusId?: string) {
    const base = await this.scopeWhere(user, campusId);
    const and = (w: Prisma.CommMessageWhereInput): Prisma.CommMessageWhereInput => ({ AND: [base, w] });
    const sla = new Date(Date.now() - REPLY_SLA_HOURS * 3_600_000);
    const [unanswered, unansweredOver24h, oldest, today, last30Days, channels] = await Promise.all([
      this.prisma.commMessage.count({ where: and({ needsReply: true }) }),
      this.prisma.commMessage.count({ where: and({ needsReply: true, occurredAt: { lt: sla } }) }),
      this.prisma.commMessage.findFirst({ where: and({ needsReply: true }), orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
      this.prisma.commMessage.count({ where: and({ occurredAt: { gte: startOfToday() } }) }),
      this.prisma.commMessage.count({ where: and({ occurredAt: { gte: daysAgo(30) } }) }),
      this.prisma.commMessage.groupBy({ by: ['channel'], where: base, _count: { _all: true } }),
    ]);
    const byChannel: Record<string, number> = { WhatsApp: 0, Email: 0, SMS: 0, Call: 0, Note: 0, 'In-app': 0 };
    for (const c of channels) byChannel[c.channel] = c._count._all;
    return {
      unanswered,
      unansweredOver24h,
      oldestHours: oldest ? hoursSince(oldest.occurredAt) : null,
      today,
      last30Days,
      byChannel,
    };
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------
  private async assertChild(guardianId: string, studentId?: string) {
    if (!studentId) return;
    const link = await this.prisma.studentGuardian.findUnique({ where: { studentId_guardianId: { studentId, guardianId } } });
    if (!link) throw fieldError('studentId', 'This child is not linked to the parent');
  }

  /** Logs a phone call or an internal note. */
  async logInteraction(dto: LogInteractionDto, user: AuthUser, req: Request) {
    const guardian = dto.parentId ? await this.prisma.guardian.findUnique({ where: { id: dto.parentId } }) : null;
    if (dto.parentId && !guardian) throw fieldError('parentId', 'Choose a parent');
    if (guardian) await this.parents.assertGuardian(user, guardian.id);
    const isCall = dto.channel === 'Call';
    if (isCall && !guardian) throw fieldError('parentId', 'Choose the parent you spoke to');
    if (!isCall && !guardian && !dto.counterpart?.trim()) throw fieldError('counterpart', 'Choose a parent or name who the note is about');
    if (guardian) await this.assertChild(guardian.id, dto.studentId);
    const studentId = guardian ? dto.studentId ?? null : null;
    const direction = isCall ? dto.direction ?? 'outbound' : 'internal';
    const status = isCall ? dto.status ?? 'Connected' : 'Internal';
    const m = await this.prisma.commMessage.create({
      data: {
        guardianId: guardian?.id ?? null,
        studentId,
        campusId: await this.parents.campusOf(guardian?.id, studentId),
        channel: dto.channel,
        direction,
        counterpart: guardian?.fullName ?? dto.counterpart!.trim(),
        subject: dto.subject,
        body: dto.body?.trim() || null,
        status,
        needsReply: !!dto.needsReply,
        sentById: user.id,
        sentByName: user.fullName,
      },
    });
    if (isCall && guardian) {
      const connected = status === 'Connected';
      await this.parents.touch(guardian.id, {
        channel: connected ? 'Call' : null,
        delta: connected ? (direction === 'inbound' ? POINTS.callInbound : POINTS.callConnected) : POINTS.callMissed,
      });
    }
    await this.audit.record({
      user, action: 'create', module: 'parents', entityType: 'communication', entityId: m.id,
      description: isCall ? `Logged ${direction} call with ${m.counterpart} (${status}): ${m.subject}` : `Added a note about ${m.counterpart}: ${m.subject}`, req,
    });
    const queued = dto.needsReply ? ' — added to the unanswered queue' : '';
    return ok(await this.one(m.id), `${isCall ? 'Call logged' : 'Note saved'}${queued}`);
  }

  /** Sends a message to a family through MessagingService and records it with its delivery state. */
  async send(dto: SendMessageDto, user: AuthUser, req: Request) {
    const guardian = await this.prisma.guardian.findUnique({ where: { id: dto.parentId } });
    if (!guardian) throw fieldError('parentId', 'Choose a parent');
    await this.parents.assertGuardian(user, guardian.id);
    await this.assertChild(guardian.id, dto.studentId);
    const replyTo = dto.replyTo ? await this.prisma.commMessage.findUnique({ where: { id: dto.replyTo } }) : null;
    if (dto.replyTo && !replyTo) throw notFound('Message being replied to');
    if (replyTo?.threadId) throw badRequest('This message came from the parent app. Reply inside the conversation so the family sees it in the app.');
    if (dto.channel === 'Email' && !guardian.email) throw fieldError('channel', 'This family has no email address on record. Choose another channel.');
    if ((dto.channel === 'WhatsApp' || dto.channel === 'SMS') && !guardian.phone) throw fieldError('channel', 'This family has no phone number on record.');

    const id = randomUUID();
    const link = { entityType: 'communication', entityId: id };
    const parentUsers = await this.prisma.user.findMany({ where: { parentId: guardian.id, status: 'active' }, select: { id: true, pushToken: true } });
    const text = `${dto.subject}\n\n${dto.body}`;
    let status: string;
    let error: string | null = null;
    let delivered = false;

    if (dto.channel === 'In-app') {
      if (!parentUsers.length) {
        status = 'Not delivered';
        error = 'The family has no parent-app account';
      } else {
        await this.notifications.notifyUsers(parentUsers.map((u) => u.id), {
          category: 'Information', topic: 'messages', module: 'parents', title: dto.subject, body: dto.body, route: FAMILY_ROUTE,
        });
        for (const u of parentUsers) {
          if (u.pushToken) await this.messaging.send('push', { to: u.pushToken, subject: dto.subject, body: dto.body }, link);
        }
        status = 'Delivered in app';
        delivered = true;
      }
    } else {
      let r: SendResult;
      if (dto.channel === 'Email') r = await this.messaging.send('email', { to: guardian.email!, subject: dto.subject, body: dto.body }, link);
      else r = await this.messaging.send(dto.channel === 'SMS' ? 'sms' : 'whatsapp', { to: guardian.phone, body: text }, link);
      delivered = r.ok;
      status = r.ok ? 'Delivered' : 'Failed';
      error = r.ok ? null : r.error ?? 'Delivery failed';
      // Families with the app also see school messages in their app inbox.
      if (parentUsers.length) {
        await this.notifications.notifyUsers(parentUsers.map((u) => u.id), {
          category: 'Information', topic: 'messages', module: 'parents', title: dto.subject, body: dto.body, route: FAMILY_ROUTE,
        });
      }
    }

    const studentId = dto.studentId ?? replyTo?.studentId ?? null;
    const now = new Date();
    await this.prisma.commMessage.create({
      data: {
        id,
        guardianId: guardian.id,
        studentId,
        campusId: await this.parents.campusOf(guardian.id, studentId),
        channel: dto.channel,
        direction: 'outbound',
        counterpart: guardian.fullName,
        subject: dto.subject,
        body: dto.body,
        status,
        deliveryError: error,
        occurredAt: now,
        sentById: user.id,
        sentByName: user.fullName,
        replyToId: replyTo?.id ?? null,
      },
    });
    if (replyTo?.needsReply) {
      await this.prisma.commMessage.update({
        where: { id: replyTo.id },
        data: {
          needsReply: false,
          status: replyTo.direction === 'inbound' ? 'Replied' : replyTo.status,
          repliedById: user.id,
          repliedByName: user.fullName,
          repliedAt: now,
        },
      });
    }
    await this.parents.touch(guardian.id, delivered ? { channel: dto.channel } : {});
    await this.audit.record({
      user, action: 'create', module: 'parents', entityType: 'communication', entityId: id,
      description: `${dto.channel} message to ${guardian.fullName}: ${dto.subject} (${status})`, req,
    });
    const message = delivered
      ? dto.channel === 'In-app' ? 'Message sent to the parent app' : `Message sent by ${dto.channel}`
      : dto.channel === 'In-app'
        ? 'Message recorded — the family has no app account, so it was not delivered'
        : `Message recorded but not delivered: ${error}`;
    return ok({ ...(await this.one(id)), queued: delivered }, message);
  }

  /** Takes an item out of the unanswered queue (answered outside the system). */
  async markReplied(id: string, user: AuthUser, req: Request) {
    const m = await this.prisma.commMessage.findUnique({ where: { id } });
    if (!m) throw notFound('Message');
    if (m.guardianId) await this.parents.assertGuardian(user, m.guardianId);
    if (!m.needsReply) throw badRequest('This item is not waiting for a reply');
    await this.prisma.commMessage.update({
      where: { id },
      data: {
        needsReply: false,
        status: m.direction === 'inbound' ? 'Replied' : m.status,
        repliedById: user.id,
        repliedByName: user.fullName,
        repliedAt: new Date(),
      },
    });
    if (m.threadId) {
      const still = await this.prisma.commMessage.count({ where: { threadId: m.threadId, needsReply: true } });
      if (!still) await this.prisma.commThread.update({ where: { id: m.threadId }, data: { awaitingReply: false } });
    }
    await this.audit.record({
      user, action: 'update', module: 'parents', entityType: 'communication', entityId: id,
      description: `Marked “${m.subject}” from ${m.counterpart} as replied`, req,
    });
    return ok(await this.one(id), 'Marked as replied');
  }

  /**
   * Records a message from a family (parent app, inbound WhatsApp, …). It joins the unanswered queue and
   * counts towards the family's engagement. Used by the family portal and inbound integrations.
   */
  async recordInbound(input: {
    guardianId: string;
    studentId?: string | null;
    channel: 'WhatsApp' | 'SMS' | 'Email' | 'In-app' | 'Call';
    subject: string;
    body: string;
    threadId?: string | null;
    needsReply?: boolean;
  }) {
    const g = await this.prisma.guardian.findUnique({ where: { id: input.guardianId }, select: { fullName: true } });
    if (!g) throw notFound('Parent');
    const m = await this.prisma.commMessage.create({
      data: {
        guardianId: input.guardianId,
        studentId: input.studentId ?? null,
        campusId: await this.parents.campusOf(input.guardianId, input.studentId),
        channel: input.channel,
        direction: 'inbound',
        counterpart: g.fullName,
        subject: input.subject,
        body: input.body,
        status: 'Received',
        needsReply: input.needsReply ?? true,
        threadId: input.threadId ?? null,
      },
    });
    await this.parents.touch(input.guardianId, { channel: input.channel, delta: POINTS.inbound });
    return m;
  }

  /** A broadcast (circular, reminder, event or PTM notice) recorded in the communication history. */
  async recordBroadcast(input: {
    channels: string[];
    counterpart: string;
    subject: string;
    body?: string | null;
    recipients: number;
    campusId?: string | null;
    entityType: string;
    entityId: string;
    user: AuthUser;
  }) {
    const ch = input.channels;
    const channel = ch.includes('push') ? 'In-app' : ch.includes('whatsapp') ? 'WhatsApp' : ch.includes('sms') ? 'SMS' : ch.includes('email') ? 'Email' : 'In-app';
    await this.prisma.commMessage.create({
      data: {
        channel,
        direction: 'outbound',
        counterpart: input.counterpart,
        subject: input.subject,
        body: input.body ? excerpt(input.body) : null,
        status: 'Sent',
        recipients: input.recipients,
        campusId: input.campusId ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        sentById: input.user.id,
        sentByName: input.user.fullName,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Reply SLA
  // ---------------------------------------------------------------------------
  /** Escalates parent messages that have waited longer than the reply SLA to staff who can answer them. */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async escalateOverdue() {
    try {
      const cutoff = new Date(Date.now() - REPLY_SLA_HOURS * 3_600_000);
      const rows = await this.prisma.commMessage.findMany({
        where: { needsReply: true, escalatedAt: null, occurredAt: { lt: cutoff } },
        orderBy: { occurredAt: 'asc' },
        take: 200,
      });
      if (!rows.length) return;
      const byCampus = new Map<string, CommMessage[]>();
      for (const r of rows) byCampus.set(r.campusId ?? '', [...(byCampus.get(r.campusId ?? '') ?? []), r]);
      for (const [campusId, list] of byCampus) {
        const one = list.length === 1 ? list[0] : null;
        await this.notifications.notifyPermission('communication.send', {
          category: 'Attention',
          topic: 'system',
          module: 'parents',
          title: one ? `Parent message waiting over ${REPLY_SLA_HOURS} hours` : `${list.length} parent messages waiting over ${REPLY_SLA_HOURS} hours`,
          body: one ? `${one.counterpart}: ${one.subject}` : list.slice(0, 3).map((m) => m.counterpart).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : ''),
          route: one ? `/parent-communication?item=${one.id}` : '/parent-communication',
          campusId: campusId || null,
        });
      }
      await this.prisma.commMessage.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { escalatedAt: new Date() } });
    } catch (e) {
      this.log.warn(`Reply SLA check failed: ${(e as Error).message}`);
    }
  }
}
