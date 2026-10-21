import { Body, Controller, Get, HttpCode, Injectable, Logger, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma, SafetyVisitor } from '@prisma/client';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { ListQuery, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PHONE_RE } from './pickup.service';
import { iso, isDate, SafetyContext, sortRows } from './safety.util';
import { ForEachWorkspace } from '../../tenancy/for-each-workspace.decorator';

class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

class VisitorQuery extends ListQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a YYYY-MM-DD date' }) date?: string;
  @IsOptional() @IsIn(['Inside', 'Completed', 'Expected', 'Denied']) status?: string;
}

class CreateVisitorDto {
  @IsString() @MinLength(2, { message: 'Enter the visitor’s name' }) @MaxLength(120) fullName: string;
  @IsString() @MinLength(3, { message: 'Describe the purpose' }) @MaxLength(200) purpose: string;
  @IsUUID('all', { message: 'Choose who they are visiting' }) hostEmployeeId: string;
  @IsOptional() @IsString() @MaxLength(16) phone?: string;
  @IsOptional() @IsUUID() campusId?: string;
  @IsOptional() @IsDateString({}, { message: 'Choose a future time' }) expectedAt?: string;
}

const STATUS_ORDER: Record<string, number> = { Inside: 0, Expected: 1, Completed: 2, Denied: 3 };
const ACTIONS = ['check-in', 'check-out', 'deny'] as const;
type VisitorAction = (typeof ACTIONS)[number];

/** Visitor register: badges, host notifications and the daily reconciliation. */
@Injectable()
export class VisitorsService {
  private readonly log = new Logger(VisitorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
    private readonly notifications: NotificationsService,
  ) {}

  async rows(list: SafetyVisitor[]) {
    const [hosts, campuses, users] = await Promise.all([
      this.ctx.employees(list.map((v) => v.hostId)),
      this.ctx.campusNames(list.map((v) => v.campusId)),
      this.ctx.userNames(list.map((v) => v.createdById)),
    ]);
    return list.map((v) => {
      const host = v.hostId ? hosts.get(v.hostId) : undefined;
      return {
        id: v.id,
        badgeNo: v.badgeNo,
        fullName: v.fullName,
        phone: v.phone,
        purpose: v.purpose,
        status: v.status as 'Expected' | 'Inside' | 'Completed' | 'Denied',
        checkedInAt: v.checkedInAt.toISOString(),
        checkedOutAt: iso(v.checkedOutAt),
        hostId: v.hostId,
        hostName: host?.fullName ?? null,
        hostDesignation: host?.designation ?? null,
        campusName: campuses.get(v.campusId) ?? '',
        createdByName: v.createdById ? (users.get(v.createdById) ?? null) : null,
      };
    });
  }

  async notifyHost(v: SafetyVisitor, kind: 'arrived' | 'expected') {
    const users = await this.ctx.usersForEmployees([v.hostId]);
    if (!users.length) return;
    const clock = await this.ctx.clock();
    await this.notifications.notifyUsers(users, {
      category: kind === 'arrived' ? 'Attention' : 'Information',
      topic: 'safety',
      module: 'safety',
      title: kind === 'arrived' ? `Your visitor ${v.fullName} has arrived` : `Visit pre-approved: ${v.fullName}`,
      body: kind === 'arrived'
        ? `Checked in at ${clock.time(v.checkedInAt)} with badge ${v.badgeNo} · ${v.purpose}`
        : `Expected ${clock.date(v.checkedInAt)} at ${clock.time(v.checkedInAt)} · ${v.purpose}`,
      route: '/visitors',
      campusId: v.campusId,
      deliver: kind === 'arrived',
    });
  }

  /** 17:30 reconciliation: anyone still checked in is flagged to the front office. */
  @Cron('30 17 * * *', { timeZone: 'Asia/Kolkata' })
  @ForEachWorkspace('safety-visitors-reconcile')
  async reconcile() {
    try {
      const inside = await this.prisma.safetyVisitor.groupBy({ by: ['campusId'], where: { status: 'Inside' }, _count: { _all: true } });
      for (const c of inside) {
        const n = c._count._all;
        await this.notifications.notifyPermission('safety.manage', {
          category: 'Attention',
          topic: 'safety',
          module: 'safety',
          title: `${n} visitor${n === 1 ? ' has' : 's have'} not checked out`,
          body: 'Reconcile the visitor register: check out everyone who has left and collect their badges.',
          route: '/visitors?status=Inside',
          campusId: c.campusId,
        });
      }
    } catch (err) {
      this.log.warn(`Visitor reconciliation failed: ${(err as Error).message}`);
    }
  }
}

@Controller('visitors')
export class VisitorsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: SafetyContext,
    private readonly visitors: VisitorsService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('safety.read', 'safety.manage')
  async list(@Query() q: VisitorQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const clock = await this.ctx.clock();
    const today = clock.today();
    const date = isDate(q.date) ? q.date : today;
    const { start, end } = clock.bounds(date);
    const campus = this.ctx.campus(user, q.campusId);
    const term = q.q?.trim();
    // Today's list also carries anyone still inside from a previous day, so they can be checked out.
    const onDay: Prisma.SafetyVisitorWhereInput = date === today
      ? { OR: [{ checkedInAt: { gte: start, lt: end } }, { status: 'Inside', checkedInAt: { lt: start } }] }
      : { checkedInAt: { gte: start, lt: end } };
    const and: Prisma.SafetyVisitorWhereInput[] = [onDay];
    if (term) {
      const hosts = await this.prisma.employee.findMany({ where: { fullName: { contains: term, mode: 'insensitive' } }, select: { id: true }, take: 200 });
      and.push({
        OR: [
          { fullName: { contains: term, mode: 'insensitive' } },
          { badgeNo: { contains: term, mode: 'insensitive' } },
          { purpose: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term } },
          { hostId: { in: hosts.map((h) => h.id) } },
        ],
      });
    }
    const where: Prisma.SafetyVisitorWhereInput = { ...(campus ? { campusId: campus } : {}), ...(q.status ? { status: q.status } : {}), AND: and };
    const list = await this.prisma.safetyVisitor.findMany({ where, orderBy: { checkedInAt: 'desc' }, take: 5000 });
    const rows = await this.visitors.rows(list);
    const sorted = sortRows(rows, q.sort, q.dir, {
      badge: (r) => r.badgeNo,
      name: (r) => r.fullName,
      host: (r) => r.hostName,
      in: (r) => r.checkedInAt,
      out: (r) => r.checkedOutAt,
      status: (r) => STATUS_ORDER[r.status] ?? 9,
    }, 'in', 'desc');
    return paged(sorted.slice(p.skip, p.skip + p.take), rows.length, p);
  }

  @Get('summary')
  @RequirePermissions('safety.read', 'safety.manage')
  async summary(@Query() q: CampusQuery, @CurrentUser() user: AuthUser) {
    const clock = await this.ctx.clock();
    const { start, end } = clock.bounds(clock.today());
    const campus = this.ctx.campus(user, q.campusId);
    const base: Prisma.SafetyVisitorWhereInput = campus ? { campusId: campus } : {};
    const [onSite, today, preApproved, notCheckedOut, checkedOutToday, deniedToday] = await Promise.all([
      this.prisma.safetyVisitor.count({ where: { ...base, status: 'Inside' } }),
      this.prisma.safetyVisitor.count({ where: { ...base, status: { in: ['Inside', 'Completed'] }, checkedInAt: { gte: start, lt: end } } }),
      this.prisma.safetyVisitor.count({ where: { ...base, status: 'Expected', checkedInAt: { gte: start } } }),
      this.prisma.safetyVisitor.count({ where: { ...base, status: 'Inside', checkedInAt: { lt: start } } }),
      this.prisma.safetyVisitor.count({ where: { ...base, status: 'Completed', checkedOutAt: { gte: start, lt: end } } }),
      this.prisma.safetyVisitor.count({ where: { ...base, status: 'Denied', deniedAt: { gte: start, lt: end } } }),
    ]);
    return { onSite, today, preApproved, notCheckedOut, checkedOutToday, deniedToday };
  }

  /** Check a visitor in now (prints a badge) or pre-approve a visit for later. */
  @Post()
  @RequirePermissions('safety.manage')
  async create(@Body() dto: CreateVisitorDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const phone = dto.phone?.trim() || null;
    if (phone && !PHONE_RE.test(phone)) throw fieldError('phone', 'Enter a valid phone number');
    const host = await this.prisma.employee.findUnique({ where: { id: dto.hostEmployeeId }, select: { id: true, campusId: true, fullName: true } });
    if (!host) throw fieldError('hostEmployeeId', 'Choose who they are visiting');
    let expected: Date | null = null;
    if (dto.expectedAt) {
      expected = new Date(dto.expectedAt);
      if (Number.isNaN(expected.getTime()) || expected.getTime() < Date.now() - 60_000) throw fieldError('expectedAt', 'Choose a future time');
    }
    const campusId = this.ctx.campus(user, dto.campusId) ?? host.campusId ?? (await this.ctx.campusFor(user));
    if (!campusId) throw badRequest('Choose a campus in the header first');
    const badgeNo = await this.counters.reference('V', 'safety-visitor-badges', 4);
    const now = new Date();
    const visitor = await this.prisma.safetyVisitor.create({
      data: {
        campusId,
        badgeNo,
        fullName: dto.fullName.trim(),
        phone,
        purpose: dto.purpose.trim(),
        status: expected ? 'Expected' : 'Inside',
        checkedInAt: expected ?? now,
        hostId: host.id,
        createdById: user.id,
        checkedInById: expected ? null : user.id,
      },
    });
    await this.visitors.notifyHost(visitor, expected ? 'expected' : 'arrived');
    await this.audit.record({
      user, action: 'create', module: 'safety', entityType: 'visitor', entityId: visitor.id, campusId, req,
      description: `${expected ? 'Pre-approved' : 'Checked in'} visitor ${visitor.fullName} (${badgeNo}) to meet ${host.fullName}: ${visitor.purpose}`,
    });
    const [row] = await this.visitors.rows([visitor]);
    return ok(row, expected ? `Visit pre-approved — badge ${badgeNo}` : `${visitor.fullName} checked in — badge ${badgeNo}`);
  }

  /** Arrived (pre-approved visitor), check out, or deny entry. */
  @Post(':id/:action')
  @HttpCode(200)
  @RequirePermissions('safety.manage')
  async act(@Param('id', ParseUUIDPipe) id: string, @Param('action') action: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!ACTIONS.includes(action as VisitorAction)) throw notFound('Action');
    const v = await this.prisma.safetyVisitor.findUnique({ where: { id } });
    if (!v) throw notFound('Visitor');
    const campus = this.ctx.campus(user);
    if (campus && v.campusId !== campus && user.scope !== 'school') throw notFound('Visitor');
    const now = new Date();
    let data: Prisma.SafetyVisitorUpdateInput;
    let message: string;
    let description: string;
    switch (action as VisitorAction) {
      case 'check-in':
        if (v.status !== 'Expected') throw badRequest(v.status === 'Inside' ? `${v.fullName} is already checked in` : `This visit is ${v.status.toLowerCase()}`);
        data = { status: 'Inside', checkedInAt: now, checkedInById: user.id };
        message = `${v.fullName} checked in — host notified`;
        description = `Checked in pre-approved visitor ${v.fullName} (${v.badgeNo})`;
        break;
      case 'check-out':
        if (v.status !== 'Inside') throw badRequest(`${v.fullName} is not checked in`);
        data = { status: 'Completed', checkedOutAt: now, checkedOutById: user.id };
        message = `${v.fullName} checked out — collect badge ${v.badgeNo}`;
        description = `Checked out visitor ${v.fullName} (${v.badgeNo})`;
        break;
      case 'deny':
        if (v.status !== 'Expected') throw badRequest('Only an expected visit can be denied');
        data = { status: 'Denied', deniedAt: now };
        message = `Entry denied to ${v.fullName}`;
        description = `Denied entry to ${v.fullName} (${v.badgeNo})`;
        break;
    }
    const updated = await this.prisma.safetyVisitor.update({ where: { id }, data });
    if (action === 'check-in') await this.visitors.notifyHost(updated, 'arrived');
    await this.audit.record({ user, action: action === 'deny' ? 'reject' : 'update', module: 'safety', entityType: 'visitor', entityId: id, campusId: v.campusId, description, req });
    const [row] = await this.visitors.rows([updated]);
    return ok(row, message);
  }
}
