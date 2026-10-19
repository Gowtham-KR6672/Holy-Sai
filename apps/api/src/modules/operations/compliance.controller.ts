import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { OpsComplianceItem, Prisma } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { addMonths, DATE_RE, dateOf, day, daysBetween, isRealDate, monthStart, OpsContext, sortRows, today, todayIso } from './ops.util';

/** Open items due within this many days read "Due Soon". */
export const DUE_SOON_DAYS = 14;
const ENTITY = 'compliance_item';
const STATUS_RANK: Record<string, number> = { Overdue: 0, 'Due Soon': 1, 'In Progress': 2, Scheduled: 3, Completed: 4 };
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' });

class ComplianceQuery extends ListQuery {
  @IsOptional() @IsIn(['Overdue', 'Due Soon', 'In Progress', 'Scheduled', 'Completed']) status?: string;
  @IsOptional() @IsIn(['true', 'false']) includeCompleted?: string;
}

class CreateDto {
  @IsUUID('all', { message: 'Choose a campus' }) campusId: string;
  @IsString() @MinLength(2, { message: 'Requirement is required' }) @MaxLength(160) item: string;
  @IsString() @MinLength(2, { message: 'Authority is required' }) @MaxLength(120) authority: string;
  @Matches(DATE_RE, { message: 'Due date is required' }) dueOn: string;
  @IsUUID('all', { message: 'Owner is required' }) ownerId: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
}

class UpdateDto {
  @IsString() @MinLength(2, { message: 'Requirement is required' }) @MaxLength(160) item: string;
  @IsString() @MinLength(2, { message: 'Authority is required' }) @MaxLength(120) authority: string;
  @Matches(DATE_RE, { message: 'Due date is required' }) dueOn: string;
  @IsUUID('all', { message: 'Owner is required' }) ownerId: string;
  @IsOptional() @IsIn(['Scheduled', 'In Progress'], { message: 'Choose Scheduled or In Progress' }) status?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
}

class CompleteDto {
  @Matches(DATE_RE, { message: 'Completion date is required' }) completedOn: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
  @IsOptional() @Matches(DATE_RE, { message: 'Enter a valid date' }) nextDueOn?: string;
}

class EscalateDto {
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

/** Status as the calendar shows it: Overdue and Due Soon come from the due date. */
export function complianceStatus(i: Pick<OpsComplianceItem, 'status' | 'dueOn'>, t = today()): string {
  if (i.status === 'Completed') return 'Completed';
  const days = daysBetween(t, i.dueOn);
  if (days < 0) return 'Overdue';
  if (days <= DUE_SOON_DAYS) return 'Due Soon';
  return i.status;
}

const onTime = (i: Pick<OpsComplianceItem, 'status' | 'completedOn' | 'dueOn'>) => i.status === 'Completed' && !!i.completedOn && i.completedOn.getTime() <= i.dueOn.getTime();

/** Compliance calendar: requirements with an authority, owner and due date; escalation; completion with recurrence. */
@Controller('compliance')
@RequirePermissions('operations.read', 'operations.manage')
export class ComplianceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ctx: OpsContext,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get()
  async list(@Query() q: ComplianceQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const t = today();
    const campusId = this.scope.campus(user, q.campusId);
    const where: Prisma.OpsComplianceItemWhereInput = {
      ...(campusId ? { campusId } : {}),
      ...(q.status === 'Completed' ? { status: 'Completed' } : q.status || q.includeCompleted !== 'true' ? { status: { not: 'Completed' } } : {}),
    };
    let items = await this.prisma.opsComplianceItem.findMany({ where, orderBy: { dueOn: 'asc' } });
    const owners = await this.ctx.employees(items.map((i) => i.ownerId));
    if (q.status && q.status !== 'Completed') items = items.filter((i) => complianceStatus(i, t) === q.status);
    const term = q.q?.trim().toLowerCase();
    if (term) {
      items = items.filter((i) =>
        [i.item, i.authority, i.ownerId ? owners.get(i.ownerId)?.fullName : null, i.notes].some((v) => v?.toLowerCase().includes(term)),
      );
    }
    const getters: Record<string, (i: OpsComplianceItem) => string | number | null> = {
      due: (i) => i.dueOn.getTime(),
      item: (i) => i.item,
      owner: (i) => (i.ownerId ? owners.get(i.ownerId)?.fullName ?? null : null),
      status: (i) => STATUS_RANK[complianceStatus(i, t)] ?? 9,
      authority: (i) => i.authority,
    };
    const sorted = sortRows(items, getters[q.sort ?? 'due'] ?? getters.due, q.dir ?? 'asc');
    const campuses = await this.ctx.campusNames();
    return paged(
      sorted.slice(p.skip, p.skip + p.take).map((i) => {
        const owner = i.ownerId ? owners.get(i.ownerId) : undefined;
        return {
          id: i.id,
          item: i.item,
          authority: i.authority,
          dueOn: day(i.dueOn)!,
          days: daysBetween(t, i.dueOn),
          ownerId: i.ownerId,
          ownerName: owner?.fullName ?? 'Unassigned',
          ownerRole: owner?.designation ?? null,
          status: complianceStatus(i, t),
          storedStatus: i.status,
          completedOn: day(i.completedOn),
          notes: i.status === 'Completed' ? i.completionNotes ?? i.notes : i.notes,
          escalations: i.escalations,
          escalatedAt: i.escalatedAt?.toISOString() ?? null,
          campusId: i.campusId,
          campusName: campuses.get(i.campusId) ?? '',
        };
      }),
      sorted.length,
      p,
    );
  }

  @Get('summary')
  async summary(@Query('campusId') requested: string | undefined, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, requested);
    const t = today();
    const thisMonth = monthStart(t);
    const from = addMonths(thisMonth, -12);
    const base = campusId ? { campusId } : {};
    const [open, recent, completedThisMonth] = await Promise.all([
      this.prisma.opsComplianceItem.findMany({ where: { ...base, status: { not: 'Completed' } }, select: { item: true, status: true, dueOn: true } }),
      this.prisma.opsComplianceItem.findMany({ where: { ...base, dueOn: { gte: from, lt: addMonths(thisMonth, 1) } }, select: { status: true, dueOn: true, completedOn: true } }),
      this.prisma.opsComplianceItem.count({ where: { ...base, status: 'Completed', completedOn: { gte: thisMonth } } }),
    ]);
    const states = open.map((i) => ({ i, s: complianceStatus(i, t) }));
    const overdue = states.filter((x) => x.s === 'Overdue').map((x) => x.i).sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime());
    // Score: share of requirements due in the window that were completed on or before the due date.
    // Open items not yet past their due date are not counted either way.
    const score = (start: Date, end: Date) => {
      const due = recent.filter((i) => i.dueOn >= start && i.dueOn <= end && (i.status === 'Completed' || i.dueOn < t));
      return due.length ? Math.round((due.filter(onTime).length / due.length) * 100) : null;
    };
    const months = Array.from({ length: 12 }, (_, k) => {
      const start = addMonths(thisMonth, k - 11);
      const end = addMonths(start, 1);
      const due = recent.filter((i) => i.dueOn >= start && i.dueOn < end);
      return { label: MONTH.format(start), due: due.length, onTime: due.filter(onTime).length };
    });
    return {
      overdue: overdue.length,
      dueSoon: states.filter((x) => x.s === 'Due Soon').length,
      onSchedule: states.filter((x) => x.s === 'Scheduled' || x.s === 'In Progress').length,
      completedThisMonth,
      firstOverdue: overdue[0] ? { item: overdue[0].item, days: Math.abs(daysBetween(t, overdue[0].dueOn)) } : null,
      score: score(addMonths(thisMonth, -11), t),
      previousScore: score(from, new Date(thisMonth.getTime() - 1)),
      months,
    };
  }

  private async ownerTask(i: OpsComplianceItem) {
    if (!i.ownerId) return;
    const days = daysBetween(today(), i.dueOn);
    for (const assigneeId of await this.ctx.usersForEmployees([i.ownerId])) {
      await this.notifications.createTask({
        title: `Compliance: ${i.item} (${i.authority})`, module: 'operations', assigneeId, dueOn: i.dueOn,
        priority: days < 0 ? 'High' : days <= DUE_SOON_DAYS ? 'High' : days <= 60 ? 'Medium' : 'Low',
        route: `/compliance?q=${encodeURIComponent(i.item)}`, entityType: ENTITY, entityId: i.id,
      });
    }
  }

  @Post()
  @RequirePermissions('operations.manage')
  async create(@Body() dto: CreateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.ctx.assertCampus(user, dto.campusId);
    if (!isRealDate(dto.dueOn)) throw fieldError('dueOn', 'Enter a valid date');
    await this.ctx.assertEmployee(dto.ownerId, 'ownerId');
    const i = await this.prisma.opsComplianceItem.create({
      data: {
        campusId: dto.campusId, item: dto.item.trim(), authority: dto.authority.trim(), dueOn: dateOf(dto.dueOn), ownerId: dto.ownerId,
        notes: dto.notes?.trim() || null, status: 'Scheduled', createdById: user.id,
      },
    });
    await this.audit.record({ user, action: 'create', module: 'operations', entityType: ENTITY, entityId: i.id, campusId: i.campusId, description: `Added compliance requirement “${i.item}” (${i.authority}) due ${dto.dueOn}`, req });
    await this.ownerTask(i);
    return ok({ id: i.id }, 'Requirement added');
  }

  @Put(':id')
  @RequirePermissions('operations.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const existing = await this.prisma.opsComplianceItem.findUnique({ where: { id } });
    if (!existing) throw notFound('Requirement');
    if (existing.status === 'Completed') throw badRequest('Completed requirements cannot be edited');
    if (!isRealDate(dto.dueOn)) throw fieldError('dueOn', 'Enter a valid date');
    if (dto.ownerId !== existing.ownerId) await this.ctx.assertEmployee(dto.ownerId, 'ownerId');
    const i = await this.prisma.opsComplianceItem.update({
      where: { id },
      data: { item: dto.item.trim(), authority: dto.authority.trim(), dueOn: dateOf(dto.dueOn), ownerId: dto.ownerId, status: dto.status ?? existing.status, notes: dto.notes?.trim() || null },
    });
    if (dto.ownerId !== existing.ownerId) {
      await this.notifications.completeTasksFor(ENTITY, id);
      await this.ownerTask(i);
    } else if (day(existing.dueOn) !== dto.dueOn || existing.item !== i.item) {
      await this.prisma.task.updateMany({
        where: { entityType: ENTITY, entityId: id, status: { not: 'Completed' } },
        data: { dueOn: i.dueOn, title: `Compliance: ${i.item} (${i.authority})` },
      });
    }
    const changes = [
      day(existing.dueOn) !== dto.dueOn && `due ${day(existing.dueOn)} → ${dto.dueOn}`,
      existing.status !== i.status && `${existing.status} → ${i.status}`,
      existing.ownerId !== i.ownerId && 'owner changed',
    ].filter(Boolean);
    await this.audit.record({
      user, action: 'update', module: 'operations', entityType: ENTITY, entityId: id, campusId: i.campusId,
      description: `Updated compliance requirement “${i.item}”${changes.length ? ` (${changes.join(', ')})` : ''}`, req,
    });
    return ok({ id }, 'Requirement updated');
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermissions('operations.manage')
  async complete(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const i = await this.prisma.opsComplianceItem.findUnique({ where: { id } });
    if (!i) throw notFound('Requirement');
    if (i.status === 'Completed') throw badRequest('This requirement is already completed');
    if (!isRealDate(dto.completedOn)) throw fieldError('completedOn', 'Enter a valid date');
    if (dto.completedOn > todayIso()) throw fieldError('completedOn', 'Cannot be in the future');
    if (dto.nextDueOn && !isRealDate(dto.nextDueOn)) throw fieldError('nextDueOn', 'Enter a valid date');
    if (dto.nextDueOn && dto.nextDueOn <= dto.completedOn) throw fieldError('nextDueOn', 'Must be after completion');
    const notes = dto.notes?.trim() || null;
    const [, next] = await this.prisma.$transaction([
      this.prisma.opsComplianceItem.update({
        where: { id },
        data: { status: 'Completed', completedOn: dateOf(dto.completedOn), completedById: user.id, completionNotes: notes },
      }),
      ...(dto.nextDueOn
        ? [this.prisma.opsComplianceItem.create({
            data: {
              campusId: i.campusId, item: i.item, authority: i.authority, dueOn: dateOf(dto.nextDueOn), ownerId: i.ownerId, notes: i.notes,
              status: 'Scheduled', previousId: i.id, recurrenceDays: daysBetween(dateOf(dto.completedOn), dateOf(dto.nextDueOn)), createdById: user.id,
            },
          })]
        : []),
    ]);
    await this.notifications.completeTasksFor(ENTITY, id);
    if (next) await this.ownerTask(next);
    const late = dto.completedOn > day(i.dueOn)!;
    await this.audit.record({
      user, action: 'update', module: 'operations', entityType: ENTITY, entityId: id, campusId: i.campusId,
      description: `Completed “${i.item}” on ${dto.completedOn}${late ? ' (late)' : ''}${next ? `; next due ${dto.nextDueOn}` : ''}${notes ? ` — ${notes}` : ''}`, req,
    });
    return ok({ id, nextId: next?.id ?? null }, next ? `Marked completed — next due ${dto.nextDueOn}` : 'Marked completed');
  }

  @Post(':id/escalate')
  @HttpCode(200)
  @RequirePermissions('operations.manage')
  async escalate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EscalateDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const i = await this.prisma.opsComplianceItem.findUnique({ where: { id } });
    if (!i) throw notFound('Requirement');
    if (i.status === 'Completed') throw badRequest('This requirement is already completed');
    const days = daysBetween(today(), i.dueOn);
    const owner = await this.ctx.employee(i.ownerId);
    const recipients = [...(await this.ctx.usersWithRoles(['principal', 'school_admin'], i.campusId)), ...(await this.ctx.usersForEmployees([i.ownerId]))];
    const note = dto.note?.trim();
    const when = days < 0 ? `${Math.abs(days)} day${days === -1 ? '' : 's'} overdue` : `due ${day(i.dueOn)}`;
    await this.notifications.notifyUsers(recipients, {
      category: 'Critical', module: 'operations', topic: 'system',
      title: `Escalated: ${i.item} is ${when}`,
      body: `${i.authority} · owner ${owner?.fullName ?? 'unassigned'}. Escalated by ${user.fullName}.${note ? ` ${note}` : ''}`,
      route: `/compliance?q=${encodeURIComponent(i.item)}`, campusId: i.campusId, deliver: true,
    });
    await this.prisma.opsComplianceItem.update({ where: { id }, data: { escalatedAt: new Date(), escalations: { increment: 1 } } });
    await this.audit.record({
      user, action: 'update', module: 'operations', entityType: ENTITY, entityId: id, campusId: i.campusId,
      description: `Escalated “${i.item}” (${when}) to the Principal, School Admin and owner${note ? ` — ${note}` : ''}`, req,
    });
    return ok({ id, notified: new Set(recipients).size }, 'Escalated to the Principal and owner');
  }
}
