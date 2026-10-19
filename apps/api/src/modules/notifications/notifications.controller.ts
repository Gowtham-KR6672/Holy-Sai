import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { TONE, type Category } from './notifications.service';

class NotificationQuery extends ListQuery {
  @IsOptional() @IsIn(['Critical', 'Attention', 'Information', 'Completed']) category?: string;
  @IsOptional() @IsString() unread?: string;
}

class TaskQuery extends ListQuery {
  /** open | Completed */
  @IsOptional() @IsString() status?: string;
}

const TOPICS = ['attendance', 'tracking', 'fees', 'transport', 'homework', 'events', 'circulars', 'safety', 'system'];

const dayStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

@Controller()
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('notifications')
  async list(@Query() q: NotificationQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const where: Prisma.NotificationWhereInput = {
      userId: user.id,
      ...(q.category ? { category: q.category } : {}),
      ...(q.unread === 'true' ? { readAt: null } : {}),
      ...(q.q ? { OR: [{ title: like(q.q) }, { body: like(q.q) }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.notification.count({ where }),
    ]);
    return paged(
      rows.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        category: n.category,
        tone: TONE[n.category as Category] ?? 'info',
        icon: n.icon ?? 'bell',
        topic: n.topic,
        module: n.module,
        route: n.route,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      total,
      p,
    );
  }

  @Get('notifications/counts')
  async counts(@CurrentUser() user: AuthUser) {
    const [groups, unread, unreadUrgent, openTasks] = await Promise.all([
      this.prisma.notification.groupBy({ by: ['category'], where: { userId: user.id }, _count: { _all: true } }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null, category: { in: ['Critical', 'Attention'] } } }),
      this.prisma.task.count({ where: { assigneeId: user.id, status: { not: 'Completed' } } }),
    ]);
    const n = (c: string) => groups.find((g) => g.category === c)?._count._all ?? 0;
    return {
      total: groups.reduce((s, g) => s + g._count._all, 0),
      unread,
      critical: n('Critical'),
      attention: n('Attention'),
      information: n('Information'),
      completed: n('Completed'),
      /** Badge on the bell and the Notifications menu item. */
      alerts: unreadUrgent,
      openTasks,
    };
  }

  @Patch('notifications/:id/read')
  async read(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const n = await this.prisma.notification.findFirst({ where: { id, userId: user.id } });
    if (!n) throw notFound('Notification');
    if (!n.readAt) await this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    return ok(null, 'Marked as read');
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  async readAll(@CurrentUser() user: AuthUser) {
    const r = await this.prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    return ok({ updated: r.count }, 'All notifications marked read');
  }

  @Get('notification-preferences')
  async preferences(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId: user.id } });
    return rows.map((r) => ({ topic: r.topic, inApp: r.inApp, whatsapp: r.whatsapp, sms: r.sms, email: r.email, push: r.push }));
  }

  @Put('notification-preferences')
  async savePreferences(@Body() body: { topic: string; inApp: boolean; whatsapp: boolean; sms: boolean; email: boolean; push: boolean }[], @CurrentUser() user: AuthUser) {
    if (!Array.isArray(body)) throw badRequest('Send a list of preferences');
    for (const p of body) {
      if (!TOPICS.includes(p.topic)) continue;
      const data = { inApp: !!p.inApp, whatsapp: !!p.whatsapp, sms: !!p.sms, email: !!p.email, push: !!p.push };
      await this.prisma.notificationPreference.upsert({
        where: { userId_topic: { userId: user.id, topic: p.topic } },
        create: { userId: user.id, topic: p.topic, ...data },
        update: data,
      });
    }
    return ok(null, 'Preferences saved');
  }

  @Get('tasks')
  async tasks(@Query() q: TaskQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const completed = q.status === 'Completed';
    const where: Prisma.TaskWhereInput = {
      assigneeId: user.id,
      status: completed ? 'Completed' : { not: 'Completed' },
      ...(q.q ? { OR: [{ title: like(q.q) }, { code: like(q.q) }, { module: like(q.q) }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        orderBy: completed ? [{ completedAt: 'desc' }] : [{ dueOn: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.task.count({ where }),
    ]);
    const today = dayStart();
    return paged(
      rows.map((t) => ({
        id: t.id,
        code: t.code,
        title: t.title,
        module: t.module,
        dueOn: t.dueOn?.toISOString().slice(0, 10) ?? null,
        priority: t.priority,
        status: t.status,
        overdue: !!t.dueOn && t.status !== 'Completed' && t.dueOn < today,
        route: t.route,
      })),
      total,
      p,
    );
  }

  @Patch('tasks/:id')
  async updateTask(@Param('id') id: string, @Body() body: { status: string }, @CurrentUser() user: AuthUser) {
    const t = await this.prisma.task.findFirst({ where: { id, assigneeId: user.id } });
    if (!t) throw notFound('Task');
    if (!['Completed', 'Pending'].includes(body?.status)) throw badRequest('Status must be Completed or Pending');
    await this.prisma.task.update({
      where: { id },
      data: { status: body.status, completedAt: body.status === 'Completed' ? new Date() : null },
    });
    return ok(null, body.status === 'Completed' ? 'Task marked complete' : 'Task reopened');
  }
}
