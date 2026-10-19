import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { can, type AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, forbidden, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { addDays, daysBetween, day, iso, localDate, num, OpsContext, today, todayIso } from './ops.util';

const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
const RANK: Record<string, number> = { Urgent: 4, High: 3, Medium: 2, Low: 1 };
const STATUSES = ['Submitted', 'Under Review', 'Approved', 'In Progress', 'Completed', 'Rejected'];
const NEXT: Record<string, string[]> = {
  Submitted: ['Under Review', 'Approved', 'Rejected'],
  'Under Review': ['Approved', 'Rejected'],
  Approved: ['In Progress', 'Rejected'],
  'In Progress': ['Completed'],
  Completed: [],
  Rejected: [],
};
const CLOSED = ['Completed', 'Rejected'];
const REVIEW = 'maintenance_request';
const WORK = 'maintenance_work';

class MaintenanceQuery extends ListQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: string;
  @IsOptional() @IsIn(['true', 'false']) mine?: string;
}

class RaiseDto {
  @IsUUID('all', { message: 'Choose a campus' }) campusId: string;
  @IsString() @MinLength(5, { message: 'Describe the problem in a few words' }) @MaxLength(300) description: string;
  @IsOptional() @IsIn(PRIORITIES, { message: 'Choose a priority' }) priority?: string;
  @IsOptional() @IsUUID() assetId?: string | null;
  @IsOptional() @IsUUID() facilityId?: string | null;
}

class StatusDto {
  @IsIn(STATUSES, { message: 'Choose a status' }) status: string;
  @IsOptional() @IsUUID() assignedTo?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Enter a valid amount' }) @Min(0, { message: 'Enter a valid amount' }) cost?: number | null;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}

type Req0 = Prisma.OpsMaintenanceRequestGetPayload<{ include: { asset: { select: { code: true; name: true } }; facility: { select: { name: true } } } }>;

const taskPriority = (p: string): 'High' | 'Medium' | 'Low' => (p === 'Urgent' || p === 'High' ? 'High' : p === 'Low' ? 'Low' : 'Medium');
/** Midnight at the start of a campus-clock date, as a timestamp. */
const midnight = (isoDate: string) => new Date(`${isoDate}T00:00:00+05:30`);

/** Maintenance requests: raised by staff, reviewed and approved by Operations, worked and closed with a cost. */
@Controller('maintenance')
@RequirePermissions('operations.read', 'operations.manage')
export class MaintenanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ctx: OpsContext,
    private readonly audit: AuditService,
    private readonly counters: CountersService,
    private readonly notifications: NotificationsService,
  ) {}

  private async rows(list: Req0[]) {
    const t = today();
    const [campuses, people] = await Promise.all([this.ctx.campusNames(), this.ctx.employees(list.map((r) => r.assignedToId))]);
    return list.map((r) => {
      const raised = localDate(r.createdAt);
      const open = !CLOSED.includes(r.status);
      return {
        id: r.id,
        code: r.code,
        description: r.description,
        priority: r.priority,
        status: r.status,
        raisedOn: day(raised),
        completedAt: iso(r.completedAt),
        cost: num(r.cost),
        note: r.note,
        campusId: r.campusId,
        campusName: campuses.get(r.campusId) ?? '',
        raisedBy: r.raisedByName,
        raisedById: r.raisedById,
        assignedTo: r.assignedToId ? people.get(r.assignedToId)?.fullName ?? null : null,
        assignedToId: r.assignedToId,
        assetId: r.assetId,
        assetCode: r.asset?.code ?? null,
        assetName: r.asset?.name ?? null,
        facilityId: r.facilityId,
        facilityName: r.facility?.name ?? null,
        decidedBy: r.decidedByName,
        ageDays: open ? Math.max(0, daysBetween(raised, t)) : Math.max(0, daysBetween(raised, localDate(r.completedAt ?? r.decidedAt ?? r.updatedAt))),
      };
    });
  }

  @Get()
  async list(@Query() q: MaintenanceQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.scope.campus(user, q.campusId);
    const where: Prisma.OpsMaintenanceRequestWhereInput = {
      AND: [
        campusId ? { campusId } : {},
        q.status === 'open' ? { status: { notIn: CLOSED } } : q.status ? { status: q.status } : {},
        q.priority ? { priority: q.priority } : {},
        q.mine === 'true' ? { raisedById: user.id } : {},
        q.q?.trim()
          ? { OR: [{ code: like(q.q) }, { description: like(q.q) }, { asset: { OR: [{ code: like(q.q) }, { name: like(q.q) }] } }, { facility: { name: like(q.q) } }, { raisedByName: like(q.q) }] }
          : {},
      ],
    };
    const dir = q.dir ?? 'desc';
    const orders: Record<string, Prisma.OpsMaintenanceRequestOrderByWithRelationInput[]> = {
      date: [{ createdAt: dir }],
      code: [{ createdAt: dir }],
      item: [{ description: dir }, { createdAt: 'desc' }],
      raised: [{ raisedByName: { sort: dir, nulls: 'last' } }, { createdAt: 'desc' }],
      priority: [{ priorityRank: dir }, { createdAt: 'asc' }],
      status: [{ status: dir }, { createdAt: 'desc' }],
    };
    const [list, total] = await Promise.all([
      this.prisma.opsMaintenanceRequest.findMany({
        where,
        include: { asset: { select: { code: true, name: true } }, facility: { select: { name: true } } },
        orderBy: orders[q.sort ?? 'date'] ?? orders.date,
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.opsMaintenanceRequest.count({ where }),
    ]);
    return paged(await this.rows(list), total, p);
  }

  @Get('summary')
  async summary(@Query('campusId') requested: string | undefined, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, requested);
    const base: Prisma.OpsMaintenanceRequestWhereInput = campusId ? { campusId } : {};
    const todayStr = todayIso();
    const monthFrom = midnight(`${todayStr.slice(0, 7)}-01`);
    const since90 = midnight(day(addDays(today(), -90))!);
    const [open, highPriority, awaitingDecision, closedMonth, closed90] = await Promise.all([
      this.prisma.opsMaintenanceRequest.count({ where: { ...base, status: { notIn: CLOSED } } }),
      this.prisma.opsMaintenanceRequest.count({ where: { ...base, status: { notIn: CLOSED }, priority: { in: ['Urgent', 'High'] } } }),
      this.prisma.opsMaintenanceRequest.count({ where: { ...base, status: { in: ['Submitted', 'Under Review'] } } }),
      this.prisma.opsMaintenanceRequest.findMany({ where: { ...base, status: 'Completed', completedAt: { gte: monthFrom } }, select: { cost: true } }),
      this.prisma.opsMaintenanceRequest.findMany({ where: { ...base, status: 'Completed', completedAt: { gte: since90 } }, select: { createdAt: true, completedAt: true } }),
    ]);
    const durations = closed90.map((r) => (r.completedAt!.getTime() - r.createdAt.getTime()) / 86_400_000).sort((a, b) => a - b);
    let median: number | null = null;
    if (durations.length) {
      const mid = Math.floor(durations.length / 2);
      const m = durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
      median = Math.round(m * 10) / 10;
    }
    return {
      open,
      highPriority,
      awaitingDecision,
      closedThisMonth: closedMonth.length,
      medianDaysToClose: median,
      costThisMonth: Math.round(closedMonth.reduce((s, r) => s + (num(r.cost) ?? 0), 0) * 100) / 100,
    };
  }

  @Post()
  async raise(@Body() dto: RaiseDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!user.employeeId && !can(user, 'operations.manage')) throw forbidden('Only staff can raise maintenance requests');
    await this.ctx.assertCampus(user, dto.campusId);
    const description = dto.description.trim();
    if (description.length < 5) throw fieldError('description', 'Describe the problem in a few words');
    if (dto.assetId) {
      const a = await this.prisma.opsAsset.findUnique({ where: { id: dto.assetId } });
      if (!a || a.campusId !== dto.campusId || a.status === 'Retired') throw fieldError('assetId', 'Choose an active asset on this campus');
    }
    if (dto.facilityId) {
      const f = await this.prisma.opsFacility.findUnique({ where: { id: dto.facilityId } });
      if (!f || f.campusId !== dto.campusId) throw fieldError('facilityId', 'Choose a space on this campus');
    }
    const priority = dto.priority ?? 'Medium';
    const code = await this.counters.reference('MR', 'ops-maintenance', 3);
    const r = await this.prisma.opsMaintenanceRequest.create({
      data: {
        code, campusId: dto.campusId, description, priority, priorityRank: RANK[priority], status: 'Submitted',
        assetId: dto.assetId || null, facilityId: dto.facilityId || null, raisedById: user.id, raisedByName: user.fullName,
        history: [{ status: 'Submitted', at: new Date().toISOString(), by: user.fullName }],
      },
    });
    await this.audit.record({ user, action: 'create', module: 'operations', entityType: REVIEW, entityId: r.id, campusId: r.campusId, description: `Raised maintenance request ${code} (${priority}): ${description}`, req });
    const route = `/maintenance?q=${encodeURIComponent(code)}`;
    await this.notifications.createTaskForPermission(
      'operations.manage',
      { title: `Review maintenance request ${code}: ${description.slice(0, 80)}`, module: 'operations', status: 'Under Review', priority: taskPriority(priority), route, entityType: REVIEW, entityId: r.id },
      r.campusId,
    );
    const urgent = priority === 'Urgent' || priority === 'High';
    const managers = (await this.ctx.usersWithPermission('operations.manage', r.campusId)).filter((id) => id !== user.id);
    await this.notifications.notifyUsers(managers, {
      category: urgent ? 'Critical' : 'Attention', module: 'operations', title: `${priority} maintenance request ${code}`,
      body: `${description} — raised by ${user.fullName}`, route, campusId: r.campusId,
    });
    if (urgent) {
      const principals = (await this.ctx.usersWithRoles(['principal'], r.campusId)).filter((id) => id !== user.id && !managers.includes(id));
      await this.notifications.notifyUsers(principals, {
        category: 'Critical', module: 'operations', title: `${priority} maintenance request ${code}`, body: `${description} — raised by ${user.fullName}`,
        route, campusId: r.campusId, deliver: priority === 'Urgent',
      });
    }
    return ok({ id: r.id, code }, `Request ${code} raised`);
  }

  @Patch(':id/status')
  @RequirePermissions('operations.manage')
  async setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const r = await this.prisma.opsMaintenanceRequest.findUnique({ where: { id }, include: { asset: true } });
    if (!r) throw notFound('Maintenance request');
    const allowed = NEXT[r.status] ?? [];
    if (!allowed.includes(dto.status)) {
      throw badRequest(allowed.length ? `${r.code} is ${r.status}; it can move to ${allowed.join(', ')}` : `${r.code} is already ${r.status.toLowerCase()}`);
    }
    const note = dto.note?.trim() || null;
    if (dto.status === 'Rejected' && !note) throw fieldError('note', 'A reason is required');
    if (dto.status === 'Completed' && (dto.cost == null || !(dto.cost >= 0))) throw fieldError('cost', 'Cost is required');
    const assignee = dto.assignedTo === undefined ? r.assignedToId : dto.assignedTo || null;
    if (assignee && assignee !== r.assignedToId) await this.ctx.assertEmployee(assignee, 'assignedTo');

    const now = new Date();
    const history = [...((r.history as Prisma.JsonArray | null) ?? []), { status: dto.status, at: now.toISOString(), by: user.fullName, ...(note ? { note } : {}) }];
    const data: Prisma.OpsMaintenanceRequestUpdateInput = { status: dto.status, assignedToId: assignee, history, ...(note ? { note } : {}) };
    if (dto.status === 'Approved' || dto.status === 'Rejected') Object.assign(data, { decidedById: user.id, decidedByName: user.fullName, decidedAt: now });
    if (dto.status === 'In Progress') data.startedAt = now;
    if (dto.status === 'Completed') Object.assign(data, { completedAt: now, cost: dto.cost });

    const ops: Prisma.PrismaPromise<unknown>[] = [this.prisma.opsMaintenanceRequest.update({ where: { id }, data })];
    if (r.asset && r.asset.status !== 'Retired') {
      if (dto.status === 'In Progress') ops.push(this.prisma.opsAsset.update({ where: { id: r.asset.id }, data: { status: 'In maintenance' } }));
      if (dto.status === 'Completed') {
        ops.push(this.prisma.opsAsset.update({
          where: { id: r.asset.id },
          data: { status: r.asset.status === 'In maintenance' ? 'Active' : r.asset.status, lastServiceOn: today() },
        }));
        ops.push(this.prisma.opsAssetService.create({
          data: {
            assetId: r.asset.id, servicedOn: today(), nextServiceOn: r.asset.nextServiceOn, note: `${r.code}: ${r.description}${note ? ` — ${note}` : ''}`.slice(0, 500),
            cost: dto.cost ?? null, maintenanceId: r.id, recordedById: user.id, recordedByName: user.fullName,
          },
        }));
      }
    }
    await this.prisma.$transaction(ops);

    const route = `/maintenance?q=${encodeURIComponent(r.code)}`;
    if (dto.status === 'Approved' || dto.status === 'Rejected') await this.notifications.completeTasksFor(REVIEW, r.id);
    if (dto.status === 'Rejected' || dto.status === 'Completed') await this.notifications.completeTasksFor(WORK, r.id);
    // The person doing the work gets a task once the request is approved (or reassigned while in progress).
    if (assignee && (dto.status === 'Approved' || (dto.status === 'In Progress' && assignee !== r.assignedToId))) {
      if (assignee !== r.assignedToId) await this.notifications.completeTasksFor(WORK, r.id);
      for (const uid of await this.ctx.usersForEmployees([assignee])) {
        await this.notifications.createTask({ title: `Maintenance ${r.code}: ${r.description.slice(0, 80)}`, module: 'operations', assigneeId: uid, priority: taskPriority(r.priority), route, entityType: WORK, entityId: r.id });
      }
    }
    if (r.raisedById && r.raisedById !== user.id) {
      const msg: Record<string, { category: 'Information' | 'Attention' | 'Completed'; title: string }> = {
        'Under Review': { category: 'Information', title: `${r.code} is under review` },
        Approved: { category: 'Information', title: `${r.code} has been approved` },
        'In Progress': { category: 'Information', title: `Work has started on ${r.code}` },
        Completed: { category: 'Completed', title: `${r.code} is completed` },
        Rejected: { category: 'Attention', title: `${r.code} was not approved` },
      };
      const m = msg[dto.status];
      if (m) await this.notifications.notifyUsers([r.raisedById], { ...m, module: 'operations', body: dto.status === 'Rejected' ? `Reason: ${note}` : r.description, route, campusId: r.campusId });
    }
    const action = dto.status === 'Approved' ? 'approve' : dto.status === 'Rejected' ? 'reject' : 'update';
    await this.audit.record({
      user, action, module: 'operations', entityType: REVIEW, entityId: r.id, campusId: r.campusId,
      description: `${r.code}: ${r.status} → ${dto.status}${dto.status === 'Completed' ? ` (cost ₹${dto.cost})` : ''}${note ? ` — ${note}` : ''}`, req,
    });
    const message = dto.status === 'Rejected' ? `${r.code} rejected` : dto.status === 'Completed' ? `${r.code} completed` : `${r.code} moved to ${dto.status}`;
    return ok({ id, status: dto.status }, message);
  }
}
