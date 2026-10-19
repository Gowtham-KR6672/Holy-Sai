import { Injectable, Logger } from '@nestjs/common';
import { CountersService } from '../../common/counters.service';
import { PrismaService } from '../../common/prisma.service';
import { MessagingService } from '../integrations/messaging.service';

export type Category = 'Critical' | 'Attention' | 'Information' | 'Completed';

export interface NotifyInput {
  category: Category;
  /** attendance | tracking | fees | transport | homework | events | circulars | safety | system */
  topic?: string;
  module?: string;
  title: string;
  body?: string;
  icon?: string;
  route?: string;
  campusId?: string | null;
  /** Also send through WhatsApp/SMS/email/push according to each user's preferences. */
  deliver?: boolean;
}

export interface TaskInput {
  title: string;
  module: string;
  assigneeId: string;
  dueOn?: Date | string | null;
  priority?: 'High' | 'Medium' | 'Low';
  status?: 'Pending' | 'Under Review';
  route?: string;
  entityType?: string;
  entityId?: string;
}

export const TONE: Record<Category, 'critical' | 'warning' | 'info' | 'success'> = {
  Critical: 'critical',
  Attention: 'warning',
  Information: 'info',
  Completed: 'success',
};

const ICON: Record<string, string> = {
  attendance: 'checkSquare',
  tracking: 'mapPin',
  fees: 'wallet',
  transport: 'bus',
  homework: 'edit',
  events: 'calendar',
  circulars: 'megaphone',
  safety: 'shield',
  system: 'bell',
};

/** In-app notifications, outbound delivery by preference, and task assignment for every module. */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly counters: CountersService,
    private readonly messaging: MessagingService,
  ) {}

  async notifyUsers(userIds: string[], input: NotifyInput) {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return;
    const topic = input.topic ?? 'system';
    await this.prisma.notification.createMany({
      data: ids.map((userId) => ({
        userId,
        category: input.category,
        topic,
        module: input.module ?? null,
        title: input.title,
        body: input.body ?? null,
        icon: input.icon ?? ICON[topic] ?? 'bell',
        route: input.route ?? null,
        campusId: input.campusId ?? null,
      })),
    });
    if (input.deliver) void this.deliver(ids, topic, input).catch((e) => this.log.warn(`Delivery failed: ${(e as Error).message}`));
  }

  /** Every active user holding a permission (optionally on one campus, plus group-wide users). */
  async notifyPermission(permission: string, input: NotifyInput) {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'active',
        role: { permissions: { some: { permissionKey: permission } } },
        ...(input.campusId
          ? { OR: [{ campusId: input.campusId }, { campusId: null }, { role: { permissions: { some: { permissionKey: 'dashboard.group' } } } }] }
          : {}),
      },
      select: { id: true },
    });
    await this.notifyUsers(users.map((u) => u.id), input);
  }

  /** The guardians (parent accounts) of a student. */
  async notifyGuardians(studentId: string, input: NotifyInput) {
    const links = await this.prisma.studentGuardian.findMany({ where: { studentId }, select: { guardianId: true } });
    const users = await this.prisma.user.findMany({ where: { parentId: { in: links.map((l) => l.guardianId) }, status: 'active' }, select: { id: true } });
    await this.notifyUsers(users.map((u) => u.id), input);
  }

  async createTask(input: TaskInput) {
    const n = await this.counters.next('tasks', 1);
    return this.prisma.task.create({
      data: {
        code: `T-${n}`,
        title: input.title,
        module: input.module,
        assigneeId: input.assigneeId,
        dueOn: input.dueOn ? new Date(input.dueOn) : null,
        priority: input.priority ?? 'Medium',
        status: input.status ?? 'Pending',
        route: input.route ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      },
    });
  }

  /** Assigns a review task to every active user holding a permission. */
  async createTaskForPermission(permission: string, input: Omit<TaskInput, 'assigneeId'>, campusId?: string | null) {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'active',
        role: { permissions: { some: { permissionKey: permission } }, key: { notIn: ['parent', 'student'] } },
        ...(campusId ? { OR: [{ campusId }, { campusId: null }] } : {}),
      },
      select: { id: true },
    });
    for (const u of users) await this.createTask({ ...input, assigneeId: u.id });
  }

  /** Closes the open tasks linked to a record once the approval they asked for is given. */
  async completeTasksFor(entityType: string, entityId: string) {
    await this.prisma.task.updateMany({
      where: { entityType, entityId, status: { not: 'Completed' } },
      data: { status: 'Completed', completedAt: new Date() },
    });
  }

  private async deliver(userIds: string[], topic: string, input: NotifyInput) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, phone: true, pushToken: true, preferences: { where: { topic } } },
    });
    for (const u of users) {
      const pref = u.preferences[0] ?? { whatsapp: true, sms: false, email: true, push: true };
      const text = input.body ? `${input.title}\n${input.body}` : input.title;
      if (pref.push && u.pushToken) await this.messaging.send('push', { to: u.pushToken, subject: input.title, body: input.body ?? input.title });
      if (pref.whatsapp && u.phone) await this.messaging.send('whatsapp', { to: u.phone, body: text });
      else if (pref.sms && u.phone) await this.messaging.send('sms', { to: u.phone, body: text });
      if (pref.email && u.email && input.category === 'Critical') await this.messaging.send('email', { to: u.email, subject: input.title, body: text });
    }
  }
}
