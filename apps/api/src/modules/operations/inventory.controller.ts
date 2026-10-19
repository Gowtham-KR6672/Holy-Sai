import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { OpsInventoryItem, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CountersService } from '../../common/counters.service';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok, paged } from '../../common/envelope';
import { conflict, fieldError, notFound } from '../../common/errors';
import { ListQuery, like, pageOf } from '../../common/paging';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { num, OpsContext, sortRows } from './ops.util';

const CATEGORIES = ['Stationery', 'Lab', 'Health', 'Transport', 'Office', 'Housekeeping', 'Uniform', 'Sports'];

class InventoryQuery extends ListQuery {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsIn(['low', 'at_minimum', 'ok']) level?: string;
}

class ItemDto {
  @IsUUID('all', { message: 'Choose a campus' }) campusId: string;
  @IsString() @MinLength(1, { message: 'Name is required' }) @MaxLength(120) name: string;
  @IsIn(CATEGORIES, { message: 'Choose a category' }) category: string;
  @IsString() @MinLength(1, { message: 'Unit is required' }) @MaxLength(20) unit: string;
  @IsOptional() @Type(() => Number) @IsInt({ message: 'Opening stock must be a whole number' }) @Min(0, { message: 'Opening stock must be a whole number' }) @Max(10_000_000) quantity?: number;
  @Type(() => Number) @IsInt({ message: 'Reorder level must be a whole number' }) @Min(0, { message: 'Reorder level must be a whole number' }) @Max(10_000_000) reorderLevel: number;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Enter a valid cost' }) @Min(0, { message: 'Enter a valid cost' }) unitCost?: number;
}

class MovementDto {
  @IsIn(['in', 'out', 'adjust'], { message: 'Choose stock in, stock out or adjust' }) movementType: 'in' | 'out' | 'adjust';
  @Type(() => Number) @IsInt({ message: 'Whole numbers only' }) @Min(0, { message: 'Whole numbers only' }) @Max(10_000_000) quantity: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string | null;
}

class PurchaseDto {
  @Type(() => Number) @IsInt({ message: 'Enter at least 1' }) @Min(1, { message: 'Enter at least 1' }) @Max(10_000_000) quantity: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}

export function stockStatus(i: Pick<OpsInventoryItem, 'quantity' | 'reorderLevel'>): string {
  return i.quantity < i.reorderLevel ? 'Reorder' : i.quantity === i.reorderLevel ? 'At minimum' : 'In stock';
}
const STATUS_RANK: Record<string, number> = { Reorder: 0, 'At minimum': 1, 'In stock': 2 };

/** Stock levels against reorder points, every change as a traceable movement, and purchase requests to Finance. */
@Controller('inventory')
@RequirePermissions('operations.read', 'operations.manage')
export class InventoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ctx: OpsContext,
    private readonly audit: AuditService,
    private readonly counters: CountersService,
    private readonly notifications: NotificationsService,
  ) {}

  private levelWhere(level: string | undefined): Prisma.OpsInventoryItemWhereInput {
    const ref = this.prisma.opsInventoryItem.fields.reorderLevel;
    if (level === 'low') return { quantity: { lt: ref } };
    if (level === 'at_minimum') return { quantity: { equals: ref } };
    if (level === 'ok') return { quantity: { gt: ref } };
    return {};
  }

  @Get()
  async list(@Query() q: InventoryQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.scope.campus(user, q.campusId);
    const where: Prisma.OpsInventoryItemWhereInput = {
      AND: [
        campusId ? { campusId } : {},
        q.category ? { category: q.category } : {},
        this.levelWhere(q.level),
        q.q?.trim() ? { OR: [{ name: like(q.q) }, { sku: like(q.q) }] } : {},
      ],
    };
    // Stock lists are small; sort in memory so level and status (derived values) sort correctly.
    const all = await this.prisma.opsInventoryItem.findMany({ where, orderBy: { name: 'asc' } });
    const dir = q.dir ?? 'asc';
    const key = q.sort ?? 'name';
    const getters: Record<string, (i: OpsInventoryItem) => string | number> = {
      name: (i) => i.name,
      sku: (i) => i.sku,
      quantity: (i) => i.quantity,
      reorder: (i) => i.reorderLevel,
      level: (i) => i.quantity / Math.max(1, i.reorderLevel),
      status: (i) => STATUS_RANK[stockStatus(i)],
      category: (i) => i.category,
    };
    const sorted = sortRows(all, getters[key] ?? getters.name, dir);
    const page = sorted.slice(p.skip, p.skip + p.take);
    const campuses = await this.ctx.campusNames();
    return paged(
      page.map((i) => {
        const unitCost = num(i.unitCost) ?? 0;
        return {
          id: i.id,
          sku: i.sku,
          name: i.name,
          category: i.category,
          unit: i.unit,
          quantity: i.quantity,
          reorderLevel: i.reorderLevel,
          unitCost,
          stockValue: Math.round(i.quantity * unitCost * 100) / 100,
          status: stockStatus(i),
          campusId: i.campusId,
          campusName: campuses.get(i.campusId) ?? '',
          lastMovementAt: i.lastMovementAt?.toISOString() ?? null,
        };
      }),
      all.length,
      p,
    );
  }

  @Get('summary')
  async summary(@Query('campusId') requested: string | undefined, @CurrentUser() user: AuthUser) {
    const campusId = this.scope.campus(user, requested);
    const base = campusId ? { campusId } : {};
    const [items, movements30d] = await Promise.all([
      this.prisma.opsInventoryItem.findMany({ where: base, select: { name: true, quantity: true, reorderLevel: true, unitCost: true } }),
      this.prisma.opsStockMovement.count({ where: { ...base, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } }),
    ]);
    const low = sortRows(items.filter((i) => i.quantity < i.reorderLevel), (i) => i.quantity / Math.max(1, i.reorderLevel));
    const lowItems = low.slice(0, 5).map((i) => i.name);
    if (low.length > 5) lowItems.push(`and ${low.length - 5} more`);
    return {
      items: items.length,
      belowReorder: low.length,
      atMinimum: items.filter((i) => i.quantity === i.reorderLevel).length,
      stockValue: Math.round(items.reduce((s, i) => s + i.quantity * (num(i.unitCost) ?? 0), 0)),
      lowItems,
      movements30d,
    };
  }

  @Get('movements')
  async movements(@Query() q: ListQuery, @CurrentUser() user: AuthUser) {
    const p = pageOf(q);
    const campusId = this.scope.campus(user, q.campusId);
    const where: Prisma.OpsStockMovementWhereInput = {
      ...(campusId ? { campusId } : {}),
      ...(q.q?.trim() ? { OR: [{ note: like(q.q) }, { item: { name: like(q.q) } }, { item: { sku: like(q.q) } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.opsStockMovement.findMany({
        where,
        include: { item: { select: { name: true, sku: true, unit: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.opsStockMovement.count({ where }),
    ]);
    return paged(
      rows.map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        movementType: m.movementType,
        quantity: m.quantity,
        balanceAfter: m.balanceAfter,
        note: m.note,
        itemId: m.itemId,
        itemName: m.item.name,
        sku: m.item.sku,
        unit: m.item.unit,
        movedBy: m.movedByName,
      })),
      total,
      p,
    );
  }

  private async assertUniqueName(campusId: string, name: string, exceptId?: string) {
    const clash = await this.prisma.opsInventoryItem.findFirst({ where: { campusId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw fieldError('name', `${clash.sku} already tracks this item on the campus`);
  }

  @Post()
  @RequirePermissions('operations.manage')
  async create(@Body() dto: ItemDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.ctx.assertCampus(user, dto.campusId);
    const name = dto.name.trim();
    const unit = dto.unit.trim();
    if (!name) throw fieldError('name', 'Name is required');
    if (!unit) throw fieldError('unit', 'Unit is required');
    await this.assertUniqueName(dto.campusId, name);
    const quantity = dto.quantity ?? 0;
    const sku = await this.counters.reference('INV', 'ops-inventory', 4);
    const item = await this.prisma.opsInventoryItem.create({
      data: {
        sku, campusId: dto.campusId, name, category: dto.category, unit, quantity, reorderLevel: dto.reorderLevel, unitCost: dto.unitCost ?? 0,
        lastMovementAt: quantity > 0 ? new Date() : null,
        ...(quantity > 0
          ? { movements: { create: { campusId: dto.campusId, movementType: 'in', quantity, balanceAfter: quantity, note: 'Opening stock', movedById: user.id, movedByName: user.fullName } } }
          : {}),
      },
    });
    await this.audit.record({
      user, action: 'create', module: 'operations', entityType: 'inventory_item', entityId: item.id, campusId: item.campusId,
      description: `Added inventory item ${sku} ${name} (opening stock ${quantity} ${unit}, reorder at ${dto.reorderLevel})`, req,
    });
    return ok({ id: item.id, sku }, `${name} added`);
  }

  @Put(':id')
  @RequirePermissions('operations.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ItemDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const existing = await this.prisma.opsInventoryItem.findUnique({ where: { id } });
    if (!existing) throw notFound('Item');
    await this.ctx.assertCampus(user, dto.campusId);
    const name = dto.name.trim();
    const unit = dto.unit.trim();
    if (!name) throw fieldError('name', 'Name is required');
    if (!unit) throw fieldError('unit', 'Unit is required');
    await this.assertUniqueName(dto.campusId, name, id);
    // Quantity changes only through movements, so it is not taken from this form.
    await this.prisma.$transaction([
      this.prisma.opsInventoryItem.update({
        where: { id },
        data: { campusId: dto.campusId, name, category: dto.category, unit, reorderLevel: dto.reorderLevel, unitCost: dto.unitCost ?? num(existing.unitCost) ?? 0 },
      }),
      ...(dto.campusId !== existing.campusId ? [this.prisma.opsStockMovement.updateMany({ where: { itemId: id }, data: { campusId: dto.campusId } })] : []),
    ]);
    await this.audit.record({ user, action: 'update', module: 'operations', entityType: 'inventory_item', entityId: id, campusId: dto.campusId, description: `Updated inventory item ${existing.sku} ${name}`, req });
    return ok({ id }, `${name} updated`);
  }

  @Post(':id/movements')
  @RequirePermissions('operations.manage')
  async move(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MovementDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const note = dto.note?.trim() || null;
    if (dto.movementType !== 'adjust' && dto.quantity < 1) throw fieldError('quantity', 'Quantity must be at least 1');
    if (dto.movementType === 'adjust' && !note) throw fieldError('note', 'A reason is required');
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ops-stock:${id}`}))`;
      const item = await tx.opsInventoryItem.findUnique({ where: { id } });
      if (!item) throw notFound('Item');
      const before = item.quantity;
      if (dto.movementType === 'out' && dto.quantity > before) throw fieldError('quantity', `Only ${before} ${item.unit} in stock`);
      const after = dto.movementType === 'in' ? before + dto.quantity : dto.movementType === 'out' ? before - dto.quantity : dto.quantity;
      const delta = after - before;
      if (dto.movementType === 'adjust' && delta === 0) throw fieldError('quantity', `The count matches the ${before} ${item.unit} on record`);
      await tx.opsInventoryItem.update({ where: { id }, data: { quantity: after, lastMovementAt: new Date() } });
      await tx.opsStockMovement.create({
        data: { itemId: id, campusId: item.campusId, movementType: dto.movementType, quantity: delta, balanceAfter: after, note, movedById: user.id, movedByName: user.fullName },
      });
      return { item, before, after, delta };
    });
    const { item, before, after, delta } = result;
    const label = dto.movementType === 'in' ? 'Stock in' : dto.movementType === 'out' ? 'Stock out' : 'Count adjustment';
    await this.audit.record({
      user, action: 'update', module: 'operations', entityType: 'inventory_item', entityId: id, campusId: item.campusId,
      description: `${label} for ${item.sku} ${item.name}: ${delta > 0 ? '+' : ''}${delta} ${item.unit} (${before} → ${after})${note ? ` — ${note}` : ''}`, req,
    });
    if (after < item.reorderLevel && before >= item.reorderLevel) {
      const recipients = await this.ctx.usersWithRoles(['office', 'principal'], item.campusId);
      await this.notifications.notifyUsers(recipients, {
        category: after === 0 ? 'Critical' : 'Attention', module: 'operations',
        title: `${item.name} is below its reorder point`,
        body: `${after} ${item.unit} left (reorder at ${item.reorderLevel}). Raise a purchase request.`,
        route: '/inventory?level=low', campusId: item.campusId,
      });
    }
    return ok({ id, quantity: after }, 'Stock movement recorded');
  }

  /** Records a purchase request for Finance and assigns them a task; the expense itself is raised in Finance. */
  @Post(':id/purchase-request')
  @RequirePermissions('operations.manage')
  async purchase(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PurchaseDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const item = await this.prisma.opsInventoryItem.findUnique({ where: { id } });
    if (!item) throw notFound('Item');
    const recent = await this.prisma.opsPurchaseRequest.findFirst({
      where: { itemId: id, status: 'Requested', createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) throw conflict(`${recent.code} for ${recent.quantity} ${item.unit} of ${item.name} is already with Finance`);
    const unitCost = num(item.unitCost) ?? 0;
    const estimated = Math.round(dto.quantity * unitCost * 100) / 100;
    const note = dto.note?.trim() || null;
    const code = await this.counters.reference('PR', 'ops-purchase-requests', 4);
    const pr = await this.prisma.opsPurchaseRequest.create({
      data: {
        code, itemId: id, campusId: item.campusId, quantity: dto.quantity, unitCost, estimatedCost: estimated, note,
        requestedById: user.id, requestedByName: user.fullName,
      },
    });
    const amount = `₹${estimated.toLocaleString('en-IN')}`;
    const title = `Purchase request ${code}: ${dto.quantity} ${item.unit} of ${item.name} (est. ${amount})`;
    await this.notifications.createTaskForPermission(
      'finance.manage',
      { title, module: 'finance', status: 'Pending', priority: item.quantity < item.reorderLevel ? 'High' : 'Medium', route: '/expenses', entityType: 'purchase_request', entityId: pr.id },
      item.campusId,
    );
    await this.notifications.notifyPermission('finance.manage', {
      category: 'Attention', module: 'operations', title,
      body: `Requested by ${user.fullName} — ${item.quantity} ${item.unit} in stock, reorder at ${item.reorderLevel}.${note ? ` Note: ${note}` : ''}`,
      route: '/expenses', campusId: item.campusId,
    });
    await this.audit.record({
      user, action: 'create', module: 'operations', entityType: 'purchase_request', entityId: pr.id, campusId: item.campusId,
      description: `Raised ${title}${note ? ` — ${note}` : ''}`, req,
    });
    return ok({ id: pr.id, code, estimatedCost: estimated }, `Purchase request ${code} sent to Finance`);
  }
}
