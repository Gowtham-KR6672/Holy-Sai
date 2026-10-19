import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { OpsAsset, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { badRequest, fieldError, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { addDays, DATE_RE, dateOf, day, daysBetween, isRealDate, num, OpsContext, sortRows, today, todayIso } from './ops.util';

export const ASSET_CATEGORIES = ['IT', 'Lab', 'Vehicle', 'Facilities', 'Furniture', 'Sports', 'Library'];
const EDITABLE_STATUSES = ['Active', 'Maintenance due', 'In maintenance'];

/** Straight-line useful life in years per category (setting operations.asset_life_years overrides). */
const DEFAULT_LIFE: Record<string, number> = { IT: 4, Lab: 8, Vehicle: 8, Facilities: 10, Furniture: 10, Sports: 5, Library: 5 };

class AssetQuery extends ListQuery {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsIn(['7', '30', '90']) serviceDue?: string;
}

class AssetDto {
  @IsUUID('all', { message: 'Choose a campus' }) campusId: string;
  @IsString() @MinLength(2, { message: 'Name is too short' }) @MaxLength(160) name: string;
  @IsIn(ASSET_CATEGORIES, { message: 'Choose a category' }) category: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string | null;
  @IsOptional() @IsUUID() facilityId?: string | null;
  @IsOptional() @IsUUID() assignedTo?: string | null;
  @IsOptional() @Matches(DATE_RE, { message: 'Enter a valid date' }) purchasedOn?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Enter a valid amount' }) @Min(0, { message: 'Enter a valid amount' }) purchaseValue?: number | null;
  @IsOptional() @Matches(DATE_RE, { message: 'Enter a valid date' }) nextServiceOn?: string | null;
  @IsOptional() @IsIn(EDITABLE_STATUSES, { message: 'Choose a status' }) status?: string;
}

class ServiceDto {
  @Matches(DATE_RE, { message: 'Enter the service date' }) servicedOn: string;
  @Matches(DATE_RE, { message: 'Enter the next service date' }) nextServiceOn: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}

/** Status as the register shows it: an active asset past its service date reads "Maintenance due". */
export function assetDisplayStatus(a: Pick<OpsAsset, 'status' | 'nextServiceOn'>, todayDate = today()): string {
  if (a.status === 'Active' && a.nextServiceOn && a.nextServiceOn.getTime() <= todayDate.getTime()) return 'Maintenance due';
  return a.status;
}

/** Asset register: location, custodian, purchase value with straight-line depreciation, and the service schedule. */
@Controller('assets')
@RequirePermissions('operations.read', 'operations.manage')
export class AssetsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ctx: OpsContext,
    private readonly audit: AuditService,
    private readonly counters: CountersService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  private async lifeYears(): Promise<Record<string, number>> {
    const custom = await this.settings.get<Record<string, number> | null>('operations.asset_life_years', null);
    return { ...DEFAULT_LIFE, ...(custom && typeof custom === 'object' ? custom : {}) };
  }

  /** Book value today: cost less straight-line depreciation over the category's useful life. */
  private bookValue(a: Pick<OpsAsset, 'purchaseValue' | 'purchasedOn' | 'category'>, life: Record<string, number>, todayDate: Date): number {
    const cost = num(a.purchaseValue) ?? 0;
    if (!cost || !a.purchasedOn) return cost;
    const years = Math.max(0, daysBetween(a.purchasedOn, todayDate)) / 365.25;
    const L = life[a.category] ?? 5;
    return Math.max(0, Math.round(cost * (1 - years / L)));
  }

  private statusWhere(status: string | undefined, todayDate: Date): Prisma.OpsAssetWhereInput {
    switch (status) {
      case 'Retired':
        return { status: 'Retired' };
      case 'In maintenance':
        return { status: 'In maintenance' };
      case 'Maintenance due':
        return { OR: [{ status: 'Maintenance due' }, { status: 'Active', nextServiceOn: { lte: todayDate } }] };
      case 'Active':
        return { status: 'Active', OR: [{ nextServiceOn: null }, { nextServiceOn: { gt: todayDate } }] };
      default:
        return { status: { not: 'Retired' } };
    }
  }

  @Get()
  async list(@Query() q: AssetQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const t = today();
    const campusId = this.scope.campus(user, q.campusId);
    const where: Prisma.OpsAssetWhereInput = {
      AND: [
        campusId ? { campusId } : {},
        q.category ? { category: q.category } : {},
        this.statusWhere(q.status, t),
        q.serviceDue ? { nextServiceOn: { not: null, lte: addDays(t, Number(q.serviceDue)) } } : {},
        q.q ? { OR: [{ name: like(q.q) }, { code: like(q.q) }, { location: like(q.q) }, { facility: { name: like(q.q) } }] } : {},
      ],
    };
    const dir = q.dir ?? 'asc';
    const orders: Record<string, Prisma.OpsAssetOrderByWithRelationInput[]> = {
      name: [{ name: dir }, { code: 'asc' }],
      code: [{ code: dir }],
      location: [{ location: { sort: dir, nulls: 'last' } }, { name: 'asc' }],
      purchased: [{ purchasedOn: { sort: dir, nulls: 'last' } }, { name: 'asc' }],
      nextService: [{ nextServiceOn: { sort: dir, nulls: 'last' } }, { name: 'asc' }],
      status: [{ status: dir }, { name: 'asc' }],
    };
    let rows: (OpsAsset & { facility: { name: string } | null })[];
    const total = await this.prisma.opsAsset.count({ where });
    if (q.sort === 'assigned') {
      // Custodian names live on Employee: sort the matching ids by name, then load the page.
      const all = await this.prisma.opsAsset.findMany({ where, select: { id: true, assignedTo: true, name: true } });
      const people = await this.ctx.employees(all.map((a) => a.assignedTo));
      const ids = sortRows(all, (a) => (a.assignedTo ? people.get(a.assignedTo)?.fullName ?? null : null), dir)
        .slice(p.skip, p.skip + p.take)
        .map((a) => a.id);
      const found = await this.prisma.opsAsset.findMany({ where: { id: { in: ids } }, include: { facility: { select: { name: true } } } });
      rows = ids.map((id) => found.find((a) => a.id === id)!).filter(Boolean);
    } else {
      rows = await this.prisma.opsAsset.findMany({
        where,
        include: { facility: { select: { name: true } } },
        orderBy: orders[q.sort ?? 'name'] ?? orders.name,
        skip: p.skip,
        take: p.take,
      });
    }
    const [campuses, people, life] = await Promise.all([this.ctx.campusNames(), this.ctx.employees(rows.map((a) => a.assignedTo)), this.lifeYears()]);
    return paged(
      rows.map((a) => {
        const person = a.assignedTo ? people.get(a.assignedTo) : undefined;
        return {
          id: a.id,
          code: a.code,
          name: a.name,
          category: a.category,
          location: a.location,
          campusId: a.campusId,
          campusName: campuses.get(a.campusId) ?? '',
          facilityId: a.facilityId,
          facilityName: a.facility?.name ?? null,
          assignedTo: a.assignedTo,
          assignedName: person?.fullName ?? null,
          assignedRole: person?.designation ?? null,
          purchasedOn: day(a.purchasedOn),
          purchaseValue: num(a.purchaseValue),
          bookValue: this.bookValue(a, life, t),
          lastServiceOn: day(a.lastServiceOn),
          nextServiceOn: day(a.nextServiceOn),
          serviceInDays: a.nextServiceOn ? daysBetween(t, a.nextServiceOn) : null,
          status: assetDisplayStatus(a, t),
          storedStatus: a.status,
        };
      }),
      total,
      p,
    );
  }

  @Get('summary')
  async summary(@Query('campusId') requested: string | undefined, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, requested);
    const t = today();
    const base: Prisma.OpsAssetWhereInput = { status: { not: 'Retired' }, ...(campusId ? { campusId } : {}) };
    const [total, serviceDue30, serviceOverdue, inMaintenance, values, life] = await Promise.all([
      this.prisma.opsAsset.count({ where: base }),
      this.prisma.opsAsset.count({ where: { ...base, nextServiceOn: { not: null, lte: addDays(t, 30) } } }),
      this.prisma.opsAsset.count({ where: { ...base, nextServiceOn: { lt: t } } }),
      this.prisma.opsAsset.count({ where: { ...base, status: 'In maintenance' } }),
      this.prisma.opsAsset.findMany({ where: { ...base, purchaseValue: { not: null } }, select: { purchaseValue: true, purchasedOn: true, category: true } }),
      this.lifeYears(),
    ]);
    return {
      total,
      serviceDue30,
      serviceOverdue,
      inMaintenance,
      bookValue: values.reduce((s, a) => s + this.bookValue(a, life, t), 0),
      purchaseValue: Math.round(values.reduce((s, a) => s + (num(a.purchaseValue) ?? 0), 0)),
    };
  }

  /** Service history for one asset (newest first). */
  @Get(':id/services')
  async services(@Param('id', ParseUUIDPipe) id: string) {
    const rows = await this.prisma.opsAssetService.findMany({ where: { assetId: id }, orderBy: [{ servicedOn: 'desc' }, { createdAt: 'desc' }] });
    return rows.map((s) => ({
      id: s.id,
      servicedOn: day(s.servicedOn),
      nextServiceOn: day(s.nextServiceOn),
      note: s.note,
      cost: num(s.cost),
      recordedBy: s.recordedByName,
      maintenanceId: s.maintenanceId,
    }));
  }

  private async validate(dto: AssetDto, user: AuthUser) {
    await this.ctx.assertCampus(user, dto.campusId);
    if (dto.purchasedOn && !isRealDate(dto.purchasedOn)) throw fieldError('purchasedOn', 'Enter a valid date');
    if (dto.purchasedOn && dto.purchasedOn > todayIso()) throw fieldError('purchasedOn', 'Purchase date cannot be in the future');
    if (dto.nextServiceOn && !isRealDate(dto.nextServiceOn)) throw fieldError('nextServiceOn', 'Enter a valid date');
    if (dto.facilityId) {
      const f = await this.prisma.opsFacility.findUnique({ where: { id: dto.facilityId } });
      if (!f || f.campusId !== dto.campusId) throw fieldError('facilityId', 'Choose a space on the same campus');
    }
    if (dto.assignedTo) await this.ctx.assertEmployee(dto.assignedTo, 'assignedTo');
  }

  private data(dto: AssetDto) {
    return {
      campusId: dto.campusId,
      name: dto.name.trim(),
      category: dto.category,
      location: dto.location?.trim() || null,
      facilityId: dto.facilityId || null,
      assignedTo: dto.assignedTo || null,
      purchasedOn: dto.purchasedOn ? dateOf(dto.purchasedOn) : null,
      purchaseValue: dto.purchaseValue ?? null,
      nextServiceOn: dto.nextServiceOn ? dateOf(dto.nextServiceOn) : null,
      status: dto.status ?? 'Active',
    };
  }

  private async tellCustodian(a: { code: string; name: string; campusId: string }, employeeId: string | null) {
    if (!employeeId) return;
    const users = await this.ctx.usersForEmployees([employeeId]);
    await this.notifications.notifyUsers(users, {
      category: 'Information',
      module: 'operations',
      title: `${a.code} ${a.name} is now assigned to you`,
      body: 'You are the custodian on the asset register. Report faults through Maintenance.',
      route: `/assets?q=${encodeURIComponent(a.code)}`,
      campusId: a.campusId,
    });
  }

  @Post()
  @RequirePermissions('operations.manage')
  async create(@Body() dto: AssetDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.validate(dto, user);
    const code = await this.counters.reference('AST', 'ops-assets', 4);
    const a = await this.prisma.opsAsset.create({ data: { ...this.data(dto), code, createdById: user.id } });
    await this.audit.record({ user, action: 'create', module: 'operations', entityType: 'asset', entityId: a.id, campusId: a.campusId, description: `Added asset ${code} ${a.name}`, req });
    await this.tellCustodian(a, a.assignedTo);
    return ok({ id: a.id, code }, `Asset ${code} added`);
  }

  @Put(':id')
  @RequirePermissions('operations.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssetDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const existing = await this.prisma.opsAsset.findUnique({ where: { id } });
    if (!existing) throw notFound('Asset');
    if (existing.status === 'Retired') throw badRequest('Retired assets cannot be edited');
    await this.validate(dto, user);
    const a = await this.prisma.opsAsset.update({ where: { id }, data: this.data(dto) });
    const changes: string[] = [];
    if (existing.assignedTo !== a.assignedTo) changes.push('custodian');
    if (existing.status !== a.status) changes.push(`status ${existing.status} → ${a.status}`);
    if (day(existing.nextServiceOn) !== day(a.nextServiceOn)) changes.push(`next service ${day(a.nextServiceOn) ?? 'cleared'}`);
    await this.audit.record({
      user, action: 'update', module: 'operations', entityType: 'asset', entityId: id, campusId: a.campusId,
      description: `Updated asset ${a.code} ${a.name}${changes.length ? ` (${changes.join(', ')})` : ''}`, req,
    });
    if (existing.assignedTo !== a.assignedTo) await this.tellCustodian(a, a.assignedTo);
    return ok({ id }, 'Asset updated');
  }

  @Post(':id/service')
  @RequirePermissions('operations.manage')
  async logService(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const a = await this.prisma.opsAsset.findUnique({ where: { id } });
    if (!a) throw notFound('Asset');
    if (a.status === 'Retired') throw badRequest('This asset has been retired');
    if (!isRealDate(dto.servicedOn)) throw fieldError('servicedOn', 'Enter a valid date');
    if (dto.servicedOn > todayIso()) throw fieldError('servicedOn', 'Cannot be in the future');
    if (!isRealDate(dto.nextServiceOn)) throw fieldError('nextServiceOn', 'Enter a valid date');
    if (dto.nextServiceOn <= dto.servicedOn) throw fieldError('nextServiceOn', 'Must be after the service date');
    await this.prisma.$transaction([
      this.prisma.opsAssetService.create({
        data: {
          assetId: id, servicedOn: dateOf(dto.servicedOn), nextServiceOn: dateOf(dto.nextServiceOn), note: dto.note?.trim() || null,
          recordedById: user.id, recordedByName: user.fullName,
        },
      }),
      this.prisma.opsAsset.update({
        where: { id },
        data: {
          lastServiceOn: !a.lastServiceOn || day(a.lastServiceOn)! < dto.servicedOn ? dateOf(dto.servicedOn) : a.lastServiceOn,
          nextServiceOn: dateOf(dto.nextServiceOn),
          status: a.status === 'Maintenance due' || a.status === 'In maintenance' ? 'Active' : a.status,
        },
      }),
    ]);
    await this.audit.record({
      user, action: 'update', module: 'operations', entityType: 'asset', entityId: id, campusId: a.campusId,
      description: `Logged service for ${a.code} ${a.name} on ${dto.servicedOn}; next due ${dto.nextServiceOn}`, req,
    });
    return ok({ id }, 'Service recorded');
  }

  /** Retires an asset: it leaves the active register but its history is kept. */
  @Delete(':id')
  @RequirePermissions('operations.manage')
  async retire(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const a = await this.prisma.opsAsset.findUnique({ where: { id } });
    if (!a) throw notFound('Asset');
    if (a.status === 'Retired') throw badRequest('This asset is already retired');
    await this.prisma.opsAsset.update({ where: { id }, data: { status: 'Retired', retiredAt: new Date(), retiredById: user.id } });
    await this.audit.record({ user, action: 'delete', module: 'operations', entityType: 'asset', entityId: id, campusId: a.campusId, description: `Retired asset ${a.code} ${a.name}`, req });
    return ok({ id }, `${a.code} retired`);
  }
}
